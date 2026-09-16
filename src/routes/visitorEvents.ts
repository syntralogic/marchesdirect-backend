import { Router, Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
import { db } from '../config/database';
import { logger } from '../utils/logger';

const router = Router();

// POST /api/visitor-events - fire-and-forget analytics ingestion (public,
// no auth). The frontend calls this on meaningful actions (a real search,
// opening an opportunity fiche, landing on an SEO page) tagged with a
// client-generated session_id persisted in localStorage. Once that same
// visitor submits any contact form, the lead row gets that session_id
// (see crmPublic.ts / opportunities.ts request-access), so staff can pull
// up GET /api/admin/leads/:id/journey and see what the person was actually
// looking at before calling them back - never blocks or degrades the
// browsing experience if it fails, so failures here are logged and
// swallowed rather than surfaced to the visitor.
router.post(
  '/',
  [
    body('sessionId').isString().trim().isLength({ min: 8, max: 100 }),
    body('eventType').isString().trim().isIn(['search', 'view_opportunity', 'view_seo_page']),
    body('eventLabel').optional({ checkFalsy: true }).isString().trim().isLength({ max: 500 }),
    body('brandId').optional({ checkFalsy: true }).isString(),
  ],
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      // Analytics beacon - a malformed payload isn't worth a noisy 400 in
      // the browser console for something the visitor never sees.
      return res.status(204).end();
    }
    try {
      const { sessionId, brandId, eventType, eventLabel, eventData } = req.body;
      await db.query(
        `INSERT INTO visitor_events (session_id, brand_id, event_type, event_label, event_data)
         VALUES ($1, $2, $3, $4, $5)`,
        [sessionId, brandId || null, eventType, eventLabel || null, eventData ? JSON.stringify(eventData) : null]
      );
      res.status(204).end();
    } catch (err: any) {
      logger.error('Visitor event capture error:', err);
      res.status(204).end();
    }
  }
);

// C06 (contre-audit 15 Sep): the fiche's "X entreprises ont consulté cette
// annonce aujourd'hui" was a seeded-random number labelled "Exemple
// illustratif - compteur à vérifier" - client's ask was real data or
// removing the claim entirely. Real per-fiche view events already exist
// (POST above, event_type='view_opportunity', event_data.opportunityId) -
// this counts real distinct visitor sessions instead of inventing one.
// 24h rolling window rather than calendar-day, to sidestep server/visitor
// timezone mismatches for a "today" claim.
router.get('/consultations/:opportunityId', async (req: Request, res: Response) => {
  try {
    const { opportunityId } = req.params;
    const result = await db.query(
      `SELECT COUNT(DISTINCT session_id)::int AS count
       FROM visitor_events
       WHERE event_type = 'view_opportunity'
         AND event_data->>'opportunityId' = $1
         AND created_at >= NOW() - INTERVAL '24 hours'`,
      [opportunityId]
    );
    res.json({ count: result.rows[0]?.count || 0 });
  } catch (err: any) {
    logger.error('Consultations count error:', err);
    res.status(500).json({ error: 'Failed to fetch consultations count' });
  }
});

export default router;
