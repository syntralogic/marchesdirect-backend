import { Router, Response } from 'express';
import { db } from '../config/database';
import { logger } from '../utils/logger';
import { AuthRequest } from '../middleware/auth';

const router = Router();

// GET /api/favorites - list the logged-in company's saved opportunities, with
// enough opportunity fields to render straight into a listing card (mirrors
// the shape returned by GET /api/opportunities so the frontend can reuse the
// same adapter/card component for "Ma selection").
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const result = await db.query(
      `SELECT f.opportunity_id, f.created_at as saved_at,
              o.id, o.title, o.description, o.deadline, o.publication_date,
              o.estimated_value, o.currency, o.location_city, o.location_region,
              o.location_department, o.ai_classification_status, o.ai_summary,
              o.ai_matched_trades, o.status,
              ot.code as journey, t.name as trade_name
       FROM favorites f
       JOIN opportunities o ON o.id = f.opportunity_id AND o.deleted_at IS NULL
       LEFT JOIN opportunity_types ot ON o.opportunity_type_id = ot.id
       LEFT JOIN trades t ON o.trade_id = t.id
       WHERE f.company_id = $1
       ORDER BY f.created_at DESC`,
      [req.user!.companyId]
    );
    res.json({ results: result.rows });
  } catch (err: any) {
    logger.error('Favorites list error:', err);
    res.status(500).json({ error: 'Failed to fetch favorites' });
  }
});

// GET /api/favorites/ids - just the opportunity ids the logged-in company has
// saved, so listing/detail pages can light up the bookmark toggle without
// pulling the full favorites list on every page.
router.get('/ids', async (req: AuthRequest, res: Response) => {
  try {
    const result = await db.query('SELECT opportunity_id FROM favorites WHERE company_id = $1', [
      req.user!.companyId,
    ]);
    res.json({ ids: result.rows.map((r) => r.opportunity_id) });
  } catch (err: any) {
    logger.error('Favorites ids error:', err);
    res.status(500).json({ error: 'Failed to fetch favorite ids' });
  }
});

// PUT /api/favorites/:opportunityId - save (idempotent: saving twice is a no-op)
router.put('/:opportunityId', async (req: AuthRequest, res: Response) => {
  try {
    const opp = await db.query('SELECT id FROM opportunities WHERE id = $1 AND deleted_at IS NULL', [
      req.params.opportunityId,
    ]);
    if (opp.rows.length === 0) {
      return res.status(404).json({ error: 'Opportunity not found' });
    }

    await db.query(
      `INSERT INTO favorites (company_id, opportunity_id) VALUES ($1, $2)
       ON CONFLICT (company_id, opportunity_id) DO NOTHING`,
      [req.user!.companyId, req.params.opportunityId]
    );
    res.json({ saved: true });
  } catch (err: any) {
    logger.error('Favorite save error:', err);
    res.status(500).json({ error: 'Failed to save favorite' });
  }
});

// DELETE /api/favorites/:opportunityId - unsave (idempotent)
router.delete('/:opportunityId', async (req: AuthRequest, res: Response) => {
  try {
    await db.query('DELETE FROM favorites WHERE company_id = $1 AND opportunity_id = $2', [
      req.user!.companyId,
      req.params.opportunityId,
    ]);
    res.json({ saved: false });
  } catch (err: any) {
    logger.error('Favorite remove error:', err);
    res.status(500).json({ error: 'Failed to remove favorite' });
  }
});

export default router;
