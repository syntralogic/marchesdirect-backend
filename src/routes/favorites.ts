import { Router, Response } from 'express';
import { db } from '../config/database';
import { logger } from '../utils/logger';
import { AuthRequest } from '../middleware/auth';
import { resolveIdentityUnlocked } from './opportunities';

const router = Router();

// Client's brief (6 Sep, bookmark icon on listing cards): clicking Save
// must never require login/coordinates first - it saves immediately into a
// session tied to the browser/device, then gets attached to the visitor's
// real profile once they're identified (see POST /attach below). This
// route was previously mounted behind `authenticate` (see server.ts),
// which is why an anonymous click used to just show "Connectez-vous pour
// sauvegarder cette annonce" instead of saving - now optionalAuth, with an
// explicit auth check kept on the routes that still need a company_id.

// GET /api/favorites - list the logged-in company's saved opportunities, with
// enough opportunity fields to render straight into a listing card (mirrors
// the shape returned by GET /api/opportunities so the frontend can reuse the
// same adapter/card component for "Ma selection").
router.get('/', async (req: AuthRequest, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
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
    const results = await Promise.all(result.rows.map(async (row) => ({
      ...row,
      identity_unlocked: await resolveIdentityUnlocked(row.id, row.journey, '', req.user!.email),
    })));
    res.json({ results });
  } catch (err: any) {
    logger.error('Favorites list error:', err);
    res.status(500).json({ error: 'Failed to fetch favorites' });
  }
});

// GET /api/favorites/ids - just the opportunity ids the logged-in company has
// saved, so listing/detail pages can light up the bookmark toggle without
// pulling the full favorites list on every page.
router.get('/ids', async (req: AuthRequest, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
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
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
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
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
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

// ============================================================================
// SESSION-SCOPED SAVES (anonymous visitor, pre-identification)
// ============================================================================

// GET /api/favorites/session/ids?sessionId=... - anonymous equivalent of
// GET /ids, so the bookmark toggle lights up correctly for a visitor who
// isn't logged in yet.
router.get('/session/ids', async (req: AuthRequest, res: Response) => {
  const sessionId = String(req.query.sessionId || '');
  if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });
  try {
    const result = await db.query('SELECT opportunity_id FROM session_favorites WHERE session_id = $1', [sessionId]);
    res.json({ ids: result.rows.map((r) => r.opportunity_id) });
  } catch (err: any) {
    logger.error('Session favorites ids error:', err);
    res.status(500).json({ error: 'Failed to fetch favorite ids' });
  }
});

// PUT /api/favorites/session/:opportunityId - save into the visitor's
// session (body: { sessionId }). No auth, no coordinates - exactly the
// client's ask: the Save icon stays a Save icon, not a lead form.
router.put('/session/:opportunityId', async (req: AuthRequest, res: Response) => {
  const sessionId = String(req.body?.sessionId || '');
  if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });
  try {
    const opp = await db.query('SELECT id FROM opportunities WHERE id = $1 AND deleted_at IS NULL', [req.params.opportunityId]);
    if (opp.rows.length === 0) return res.status(404).json({ error: 'Opportunity not found' });

    await db.query(
      `INSERT INTO session_favorites (session_id, opportunity_id) VALUES ($1, $2)
       ON CONFLICT (session_id, opportunity_id) DO NOTHING`,
      [sessionId, req.params.opportunityId]
    );
    res.json({ saved: true });
  } catch (err: any) {
    logger.error('Session favorite save error:', err);
    res.status(500).json({ error: 'Failed to save favorite' });
  }
});

// DELETE /api/favorites/session/:opportunityId?sessionId=...
router.delete('/session/:opportunityId', async (req: AuthRequest, res: Response) => {
  const sessionId = String(req.query.sessionId || '');
  if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });
  try {
    await db.query('DELETE FROM session_favorites WHERE session_id = $1 AND opportunity_id = $2', [sessionId, req.params.opportunityId]);
    res.json({ saved: false });
  } catch (err: any) {
    logger.error('Session favorite remove error:', err);
    res.status(500).json({ error: 'Failed to remove favorite' });
  }
});

// POST /api/favorites/attach (authenticated) - client's exact ask: "une
// fois identifié, le développeur doit les rattacher définitivement à son
// profil." Called once, right after the visitor becomes a known company
// (fresh signup or a returning login via magic link) - migrates whatever
// this browser session had saved anonymously into the real favorites
// table, then clears the session rows so they're not attached twice.
router.post('/attach', async (req: AuthRequest, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  const sessionId = String(req.body?.sessionId || '');
  if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });
  try {
    const result = await db.query(
      `INSERT INTO favorites (company_id, opportunity_id)
       SELECT $1, sf.opportunity_id FROM session_favorites sf WHERE sf.session_id = $2
       ON CONFLICT (company_id, opportunity_id) DO NOTHING
       RETURNING opportunity_id`,
      [req.user!.companyId, sessionId]
    );
    await db.query('DELETE FROM session_favorites WHERE session_id = $1', [sessionId]);
    res.json({ attached: result.rowCount || 0 });
  } catch (err: any) {
    logger.error('Favorites attach error:', err);
    res.status(500).json({ error: 'Failed to attach saved opportunities' });
  }
});

export default router;
