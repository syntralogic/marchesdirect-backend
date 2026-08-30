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

export default router;
