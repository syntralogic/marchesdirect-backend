import { Router, Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
import { db } from '../config/database';
import { logger } from '../utils/logger';
import { classifyOpportunity, generateOpportunitySummary, extractOpportunityFacts } from '../services/aiService';
import { computeMatchScore } from '../services/matchScoreService';
import { syncLeadToCrm } from '../services/crmSyncService';
import { optionalAuth, AuthRequest } from '../middleware/auth';

const router = Router();

// Shared by GET /:id (to decide what to redact) and GET /:id/access (to
// report the level directly) so the two can never disagree about who has
// access to what.
async function resolveAccessLevel(opportunityId: string, journey: string, email: string): Promise<'level1' | 'level2' | 'level3' | 'full'> {
  if (journey === 'public_procurement') return 'full';
  if (!email) return 'level1';
  const leadResult = await db.query(
    `SELECT access_level FROM crm_leads
     WHERE opportunity_id = $1 AND LOWER(email) = $2
     ORDER BY CASE access_level WHEN 'level3' THEN 2 WHEN 'level2' THEN 1 ELSE 0 END DESC
     LIMIT 1`,
    [opportunityId, email.trim().toLowerCase()]
  );
  return leadResult.rows[0]?.access_level === 'level3' ? 'level3'
    : leadResult.rows[0]?.access_level === 'level2' ? 'level2'
    : 'level1';
}

// Fields hidden from a level1 (teaser-only) visitor on a private tender or
// sous-traitance fiche - the whole point of the graduated-access flow is
// defeated if the "locked" content is sitting right there in the JSON
// response for anyone to read from the network tab regardless of what the
// UI chooses to render.
const LEVEL1_REDACTED_FIELDS = [
  'description', 'estimated_value', 'buyer_name', 'raw_data',
  'estimated_start_date', 'estimated_end_date', 'source_reference', 'cpv_display',
];

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
router.get('/:id', optionalAuth, async (req: AuthRequest, res: Response) => {
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
    const email = (req.user?.email || (req.query.email as string) || '');
    const level = await resolveAccessLevel(req.params.id, opportunity.journey, email);

    if (level === 'level1') {
      for (const field of LEVEL1_REDACTED_FIELDS) delete opportunity[field];
    } else {
      opportunity.source_url = extractSourceUrl(opportunity.raw_data);
    }
    opportunity.access_level = level;

    res.json(opportunity);
  } catch (err: any) {
    logger.error('Opportunity detail error:', err);
    res.status(500).json({ error: 'Failed to fetch opportunity' });
  }
});

// ============================================================================
// GRADUATED ACCESS (opportunity detail page "Conditions et accès")
//
// Public-procurement opportunities are always fully open. Private tenders and
// subcontracting opportunities start at level1 (teaser only); level2 unlocks
// the instant a visitor leaves their contact details (POST .../request-access
// below); level3 ("accès complet") is only ever granted by a staff member
// from the admin panel (PUT /api/admin/opportunity-leads/:id/grant-access) -
// there is intentionally no code path that sets it automatically.
// ============================================================================

// GET /api/opportunities/:id/access?email=... - current access level.
// Logged-in users are matched by their account email; anonymous visitors who
// already submitted the lead form pass the same email back as a query param
// so a returning visitor can see if a chargé d'affaires has since upgraded
// them to level3, without needing an account.
router.get('/:id/access', optionalAuth, async (req: AuthRequest, res: Response) => {
  try {
    const oppResult = await db.query(
      `SELECT o.id, ot.code as journey FROM opportunities o
       LEFT JOIN opportunity_types ot ON o.opportunity_type_id = ot.id
       WHERE o.id = $1 AND o.deleted_at IS NULL`,
      [req.params.id]
    );
    if (oppResult.rows.length === 0) {
      return res.status(404).json({ error: 'Opportunity not found' });
    }
    const email = (req.user?.email || (req.query.email as string) || '');
    const level = await resolveAccessLevel(req.params.id, oppResult.rows[0].journey, email);
    res.json({ level });
  } catch (err: any) {
    logger.error('Opportunity access check error:', err);
    res.status(500).json({ error: 'Failed to check access' });
  }
});

// POST /api/opportunities/:id/request-access - "Laisser mes coordonnées":
// immediately grants level2 (aperçu enrichi) and creates/updates the CRM
// lead so a chargé d'affaires can review it for a level3 (accès complet)
// upgrade. Public, matches how the rest of the site's lead forms work
// (see routes/crmPublic.ts) - a visitor filling this in doesn't have an
// account yet.
router.post(
  '/:id/request-access',
  [
    body('email').isEmail().normalizeEmail(),
    body('phone').optional({ checkFalsy: true }).isString().trim(),
    body('firstName').optional({ checkFalsy: true }).isString().trim(),
    body('lastName').optional({ checkFalsy: true }).isString().trim(),
    body('companyName').optional({ checkFalsy: true }).isString().trim(),
  ],
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Validation failed', details: errors.array() });
    }
    try {
      const oppResult = await db.query(
        `SELECT o.id, o.title, o.trade_id, o.location_city, o.location_region, ot.code as journey, b.id as brand_id
         FROM opportunities o
         LEFT JOIN opportunity_types ot ON o.opportunity_type_id = ot.id
         LEFT JOIN brands b ON ot.brand_id = b.id
         WHERE o.id = $1 AND o.deleted_at IS NULL`,
        [req.params.id]
      );
      if (oppResult.rows.length === 0) {
        return res.status(404).json({ error: 'Opportunity not found' });
      }
      const opp = oppResult.rows[0];
      if (opp.journey === 'public_procurement') {
        return res.json({ level: 'full' });
      }

      const { firstName, lastName, email, phone, companyName } = req.body;

      // A default brand is used when the opportunity's type isn't itself
      // brand-scoped (opportunity_types.brand_id can be NULL, meaning "all
      // brands") - crm_leads.brand_id is NOT NULL, same constraint the public
      // contact form already has to satisfy in routes/crmPublic.ts.
      let brandId = opp.brand_id;
      if (!brandId) {
        const brandResult = await db.query('SELECT id FROM brands ORDER BY created_at ASC LIMIT 1');
        brandId = brandResult.rows[0]?.id;
      }

      const existing = await db.query(
        `SELECT id, access_level FROM crm_leads WHERE opportunity_id = $1 AND LOWER(email) = LOWER($2) LIMIT 1`,
        [req.params.id, email]
      );

      let leadId: string;
      if (existing.rows.length > 0) {
        leadId = existing.rows[0].id;
        await db.query(
          `UPDATE crm_leads SET first_name = COALESCE($1, first_name), last_name = COALESCE($2, last_name),
             phone = COALESCE($3, phone), company_name = COALESCE($4, company_name), updated_at = NOW()
           WHERE id = $5`,
          [firstName, lastName, phone, companyName, leadId]
        );
      } else {
        const insertResult = await db.query(
          `INSERT INTO crm_leads
            (brand_id, first_name, last_name, email, phone, company_name, lead_source, message,
             opportunity_id, access_level, crm_sync_status)
           VALUES ($1, $2, $3, $4, $5, $6, 'opportunity_detail_page', $7, $8, 'level2', 'pending')
           RETURNING id`,
          [brandId, firstName, lastName, email, phone, companyName, `Demande d'accès enrichi : ${opp.title}`, req.params.id]
        );
        leadId = insertResult.rows[0].id;
        syncLeadToCrm(leadId).catch((err) => logger.error('Unexpected error firing CRM sync:', err));
      }

      const level = existing.rows[0]?.access_level === 'level3' ? 'level3' : 'level2';
      res.status(201).json({ level, leadId });
    } catch (err: any) {
      logger.error('Opportunity access request error:', err);
      res.status(500).json({ error: 'Failed to submit — please try again' });
    }
  }
);

// GET /api/opportunities/:id/match-score - "Analyse stratégique" tab data.
// Personalizes against the logged-in user's company profile when available,
// otherwise returns the generic (non-personalized) breakdown.
router.get('/:id/match-score', optionalAuth, async (req: AuthRequest, res: Response) => {
  try {
    // optionalAuth only decodes the JWT (userId/email) - it does not run the
    // DB lookups `authenticate` does, so req.company is never populated here.
    // Resolve the company from the token's email instead when present.
    let companyId: string | null = null;
    if (req.user?.email) {
      const userResult = await db.query('SELECT company_id FROM users WHERE email = $1 AND deleted_at IS NULL', [req.user.email]);
      companyId = userResult.rows[0]?.company_id || null;
    }
    const result = await computeMatchScore(req.params.id, companyId);
    res.json(result);
  } catch (err: any) {
    logger.error('Match score error:', err);
    if (err.message === 'Opportunity not found') {
      return res.status(404).json({ error: 'Opportunity not found' });
    }
    res.status(500).json({ error: 'Failed to compute match score' });
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
