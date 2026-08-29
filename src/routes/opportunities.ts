import { Router, Request, Response } from 'express';
import { db } from '../config/database';
import { logger } from '../utils/logger';
import { classifyOpportunity, generateOpportunitySummary, extractOpportunityFacts } from '../services/aiService';
import { optionalAuth } from '../middleware/auth';

const router = Router();

// GET /api/opportunities - search & filter listings (public, powers the 3 journeys)
router.get('/', optionalAuth, async (req: Request, res: Response) => {
  try {
    const {
      journey,       // 'tender' | 'public_procurement' | 'subcontracting'
      q,             // free text search
      trade_id,
      region,
      city,
      department,
      min_value,
      max_value,
      page = '1',
      limit = '20',
    } = req.query as Record<string, string>;

    // Reads from opportunity_search_index (refreshed every 15 min by
    // jobs/searchIndexRefresh.ts) instead of joining `opportunities` on every
    // request - the view pre-joins opportunity_types/trades and carries its
    // own GIN-indexed search_vector, which is what actually pays off at the
    // 1M-row scale Milestone 12's load test targets. Trade-off: listings can
    // be up to ~15 min stale here (new/updated rows won't appear until the
    // next refresh) - acceptable for a browse/search page, but do NOT reuse
    // this view for anything that needs the current row (e.g. the bid flow
    // reads `opportunities` directly for that reason, unchanged by this).
    // deleted_at/cancelled/expired/merged are already filtered by the view's
    // own WHERE clause (see schema.sql), so they don't need repeating here.
    const conditions: string[] = ['1=1'];
    const params: any[] = [];
    let idx = 1;

    if (journey) {
      conditions.push(`osi.opportunity_type = $${idx++}`);
      params.push(journey);
    }
    if (q) {
      conditions.push(`osi.search_vector @@ plainto_tsquery('french', $${idx++})`);
      params.push(q);
    }
    if (trade_id) {
      conditions.push(`osi.trade_id = $${idx++}`);
      params.push(trade_id);
    }
    if (region) {
      conditions.push(`osi.location_region ILIKE $${idx++}`);
      params.push(`%${region}%`);
    }
    if (city) {
      conditions.push(`osi.location_city ILIKE $${idx++}`);
      params.push(`%${city}%`);
    }
    if (department) {
      conditions.push(`osi.location_department = $${idx++}`);
      params.push(department);
    }
    if (min_value) {
      conditions.push(`osi.estimated_value >= $${idx++}`);
      params.push(min_value);
    }
    if (max_value) {
      conditions.push(`osi.estimated_value <= $${idx++}`);
      params.push(max_value);
    }

    const pageNum = Math.max(parseInt(page) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit) || 20, 1), 100);
    const offset = (pageNum - 1) * limitNum;

    const whereClause = conditions.join(' AND ');

    const listResult = await db.query(
      `SELECT osi.id, osi.title, osi.description, osi.deadline, osi.publication_date,
              osi.estimated_value, osi.currency, osi.location_city, osi.location_region,
              osi.location_department, osi.estimated_start_date, osi.estimated_end_date,
              osi.ai_classification_status, osi.ai_summary, osi.ai_matched_trades, osi.status,
              osi.opportunity_type as journey, osi.trade_name, osi.buyer_name
       FROM opportunity_search_index osi
       WHERE ${whereClause}
       ORDER BY osi.deadline ASC NULLS LAST
       LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, limitNum, offset]
    );

    const countResult = await db.query(
      `SELECT COUNT(*) as total
       FROM opportunity_search_index osi
       WHERE ${whereClause}`,
      params
    );

    res.json({
      results: listResult.rows,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: parseInt(countResult.rows[0].total),
        totalPages: Math.ceil(parseInt(countResult.rows[0].total) / limitNum),
      },
    });
  } catch (err: any) {
    logger.error('Opportunities search error:', err);
    res.status(500).json({ error: 'Failed to search opportunities' });
  }
});

// Best-effort link to the original notice on its source platform, extracted
// from raw_data. The open-data feeds we ingest (BOAMP etc.) publish notice
// metadata, not the DCE PDF itself - the actual consultation documents live
// on the buyer's own "profil acheteur" platform, referenced from the notice.
// So this links out to the official source rather than pretending to host a
// file we were never given. Tries a few plausible field names defensively
// since we can't fully verify the schema from field names alone; a source
// with no matching field simply gets no link (frontend hides the button).
const extractSourceUrl = (rawData: any): string | null => {
  if (!rawData) return null;
  const fields = rawData.fields || rawData;
  const candidates = [
    fields.url_avis, fields.url, fields.lien_avis, fields.link,
    rawData.link, rawData.source_url,
  ];
  const found = candidates.find((c) => typeof c === 'string' && c.startsWith('http'));
  return found || null;
};

// GET /api/opportunities/stats/regions - opportunity count per French region,
// for the interactive map on /zones. Groups on location_region as stored by
// the connectors (BOAMP etc. give a region name directly on most notices).
router.get('/stats/regions', async (req: Request, res: Response) => {
  try {
    const result = await db.query(
      `SELECT location_region AS region, COUNT(*)::int AS count
       FROM opportunities
       WHERE location_region IS NOT NULL AND location_region != ''
         AND status != 'archived'
       GROUP BY location_region
       ORDER BY count DESC`
    );
    res.json({ regions: result.rows });
  } catch (err: any) {
    logger.error('Region stats error:', err);
    res.status(500).json({ error: 'Failed to load region stats' });
  }
});

// GET /api/opportunities/stats/departments - same, grouped by French
// department (numeric code, e.g. "33" for Gironde).
router.get('/stats/departments', async (req: Request, res: Response) => {
  try {
    const result = await db.query(
      `SELECT location_department AS department, COUNT(*)::int AS count
       FROM opportunities
       WHERE location_department IS NOT NULL AND location_department != ''
         AND status != 'archived'
       GROUP BY location_department
       ORDER BY count DESC`
    );
    res.json({ departments: result.rows });
  } catch (err: any) {
    logger.error('Department stats error:', err);
    res.status(500).json({ error: 'Failed to load department stats' });
  }
});

// GET /api/opportunities/stats/near?lat=&lng=&radius_km= - count within a
// radius of a point, for the "Villes" (city) tab. Uses the Haversine formula
// directly in SQL since PostGIS isn't set up on this database.
router.get('/stats/near', async (req: Request, res: Response) => {
  try {
    const lat = parseFloat(req.query.lat as string);
    const lng = parseFloat(req.query.lng as string);
    const radiusKm = parseFloat((req.query.radius_km as string) || '50');
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ error: 'lat and lng are required numeric query params' });
    }
    const result = await db.query(
      `SELECT COUNT(*)::int AS count
       FROM opportunities
       WHERE location_latitude IS NOT NULL AND location_longitude IS NOT NULL
         AND status != 'archived'
         AND (
           6371 * acos(
             LEAST(1, GREATEST(-1,
               cos(radians($1)) * cos(radians(location_latitude)) *
               cos(radians(location_longitude) - radians($2)) +
               sin(radians($1)) * sin(radians(location_latitude))
             ))
           )
         ) <= $3`,
      [lat, lng, radiusKm]
    );
    res.json({ count: result.rows[0]?.count ?? 0, radius_km: radiusKm });
  } catch (err: any) {
    logger.error('Near stats error:', err);
    res.status(500).json({ error: 'Failed to load nearby stats' });
  }
});

// GET /api/opportunities/:id - detail page
router.get('/:id', optionalAuth, async (req: Request, res: Response) => {
  try {
    const result = await db.query(
      `SELECT o.*, ot.code as journey, ot.name as journey_name, t.name as trade_name,
              c.code as cpv_display
       FROM opportunities o
       LEFT JOIN opportunity_types ot ON o.opportunity_type_id = ot.id
       LEFT JOIN trades t ON o.trade_id = t.id
       LEFT JOIN cpv_codes c ON o.cpv_code_id = c.id
       WHERE o.id = $1 AND o.deleted_at IS NULL`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Opportunity not found' });
    }

    const opportunity = result.rows[0];
    opportunity.source_url = extractSourceUrl(opportunity.raw_data);

    res.json(opportunity);
  } catch (err: any) {
    logger.error('Opportunity detail error:', err);
    res.status(500).json({ error: 'Failed to fetch opportunity' });
  }
});

// POST /api/opportunities/:id/classify - trigger AI classification (Milestone 6)
router.post('/:id/classify', async (req: Request, res: Response) => {
  try {
    const success = await classifyOpportunity(req.params.id);
    if (!success) {
      return res.status(500).json({ error: 'Classification failed' });
    }
    res.json({ success: true });
  } catch (err: any) {
    logger.error('Manual classify error:', err);
    res.status(500).json({ error: 'Classification failed' });
  }
});

// POST /api/opportunities/:id/summarize - trigger AI summary (Milestone 7)
router.post('/:id/summarize', async (req: Request, res: Response) => {
  try {
    const summary = await generateOpportunitySummary(req.params.id);
    res.json({ summary });
  } catch (err: any) {
    logger.error('Manual summarize error:', err);
    res.status(500).json({ error: 'Summary generation failed' });
  }
});

// POST /api/opportunities/:id/extract-facts - structured fact extraction with explicit
// "not available" on missing fields (technical POC test acceptance criteria).
router.post('/:id/extract-facts', async (req: Request, res: Response) => {
  try {
    const facts = await extractOpportunityFacts(req.params.id);
    res.json({ facts });
  } catch (err: any) {
    logger.error('Fact extraction error:', err);
    res.status(500).json({ error: 'Fact extraction failed' });
  }
});

export default router;
