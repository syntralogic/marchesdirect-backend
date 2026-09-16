import { Router, Request, Response } from 'express';
import { db } from '../config/database';
import { logger } from '../utils/logger';

const router = Router();

// GET /api/trades - list all trades (for filter dropdowns, and the
// "Secteurs" homepage/page cards - see below for why that matters).
//
// A04/Q04 (contre-audit 15 Sep): the homepage and /secteurs page were
// showing 16 hand-written marketing "sector families" (mockData.ts:
// "Travaux & construction", "Énergie & environnement"...) instead of the
// real métiers the classification/search/match-score already use
// everywhere else in this codebase. N02's own fix comment on the sector
// cards already flagged this mismatch explicitly ("these 16 marketing
// sectors don't map 1:1 onto the real 15-trade taxonomy") and worked around
// it with a free-text search rather than a real filter - which is the
// generic-tabs-instead-of-concrete-métiers gap the audit is pointing at.
// Adding the count here (rather than a second round trip) is what lets the
// frontend show a real "X opportunités" badge per trade instead of another
// hand-typed number.
router.get('/', async (req: Request, res: Response) => {
  try {
    const result = await db.query(
      `SELECT t.id, t.name, t.slug, t.description, c.code as cpv_code,
              COUNT(o.id) FILTER (WHERE o.deleted_at IS NULL AND o.status != 'merged')::int AS opportunity_count
       FROM trades t
       LEFT JOIN cpv_codes c ON t.cpv_code_id = c.id
       LEFT JOIN opportunities o ON o.trade_id = t.id
       GROUP BY t.id, t.name, t.slug, t.description, c.code
       ORDER BY t.name ASC`
    );
    res.json(result.rows);
  } catch (err: any) {
    logger.error('Trades list error:', err);
    res.status(500).json({ error: 'Failed to fetch trades' });
  }
});

// GET /api/trades/:slug - single trade by slug (for SEO pages, Milestone 11)
router.get('/:slug', async (req: Request, res: Response) => {
  try {
    const result = await db.query('SELECT * FROM trades WHERE slug = $1', [req.params.slug]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Trade not found' });
    }
    res.json(result.rows[0]);
  } catch (err: any) {
    logger.error('Trade detail error:', err);
    res.status(500).json({ error: 'Failed to fetch trade' });
  }
});

export default router;
