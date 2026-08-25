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

    const conditions: string[] = ["o.deleted_at IS NULL", "o.status NOT IN ('cancelled', 'expired', 'merged')"];
    const params: any[] = [];
    let idx = 1;

    if (journey) {
      conditions.push(`ot.code = $${idx++}`);
      params.push(journey);
    }
    if (q) {
      conditions.push(`o.search_vector @@ plainto_tsquery('french', $${idx++})`);
      params.push(q);
    }
    if (trade_id) {
      conditions.push(`o.trade_id = $${idx++}`);
      params.push(trade_id);
    }
    if (region) {
      conditions.push(`o.location_region ILIKE $${idx++}`);
      params.push(`%${region}%`);
    }
    if (city) {
      conditions.push(`o.location_city ILIKE $${idx++}`);
      params.push(`%${city}%`);
    }
    if (department) {
      conditions.push(`o.location_department = $${idx++}`);
      params.push(department);
    }
    if (min_value) {
      conditions.push(`o.estimated_value >= $${idx++}`);
      params.push(min_value);
    }
    if (max_value) {
      conditions.push(`o.estimated_value <= $${idx++}`);
      params.push(max_value);
    }

    const pageNum = Math.max(parseInt(page) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit) || 20, 1), 100);
    const offset = (pageNum - 1) * limitNum;

    const whereClause = conditions.join(' AND ');

    const listResult = await db.query(
      `SELECT o.id, o.title, o.description, o.deadline, o.publication_date,
              o.estimated_value, o.currency, o.location_city, o.location_region,
              o.location_department, o.estimated_start_date, o.estimated_end_date,
              o.ai_classification_status, o.ai_summary, o.ai_matched_trades, o.status,
              ot.code as journey, t.name as trade_name
       FROM opportunities o
       LEFT JOIN opportunity_types ot ON o.opportunity_type_id = ot.id
       LEFT JOIN trades t ON o.trade_id = t.id
       WHERE ${whereClause}
       ORDER BY o.deadline ASC NULLS LAST
       LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, limitNum, offset]
    );

    const countResult = await db.query(
      `SELECT COUNT(*) as total
       FROM opportunities o
       LEFT JOIN opportunity_types ot ON o.opportunity_type_id = ot.id
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

    res.json(result.rows[0]);
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
