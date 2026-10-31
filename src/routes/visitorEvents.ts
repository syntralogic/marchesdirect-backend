import { Router, Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
import { db } from '../config/database';
import { logger } from '../utils/logger';
import { isUuid } from '../utils/uuid';
import { createBoundedCache } from '../utils/ttlCache';
import { buildConsultationIndicator, ConsultationLang, ConsultationStats } from '../utils/consultationIndicator';

const router = Router();

// Event codes agreed with the client for the HubSpot journey (kept next to the older ones, which stay valid).
export const HUBSPOT_EVENT_CODES = [
  'offer_view', 'company_selected', 'analysis_started', 'analysis_completed',
  'dossier_preview', 'dossier_requested', 'callback_requested', 'appointment_booked',
];
const cachedStats = createBoundedCache(2000);

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
    body('eventType').isString().trim().isIn(['search', 'view_opportunity', 'view_seo_page', 'company_identified', 'concordance_shown', 'form_started', 'request_submitted', ...HUBSPOT_EVENT_CODES]),
    body('eventId').optional({ checkFalsy: true }).isString().trim().isLength({ min: 8, max: 100 }),
    body('occurredAt').optional({ checkFalsy: true }).isISO8601(),
    body('siret').optional({ checkFalsy: true }).matches(/^\d{14}$/),
    body('opportunityId').optional({ checkFalsy: true }).isString().trim().isLength({ max: 100 }),
    body('lotRef').optional({ checkFalsy: true }).isString().trim().isLength({ max: 100 }),
    body('analysisId').optional({ checkFalsy: true }).isString().trim().isLength({ max: 100 }),
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
      const { sessionId, brandId, eventType, eventLabel, eventData, eventId, occurredAt, siret, opportunityId, lotRef, analysisId } = req.body;
      // ON CONFLICT DO NOTHING on (session_id, event_id): a double click or a network retry resending the same
      // eventId is stored once. Events sent without an eventId keep the previous behaviour.
      await db.query(
        `INSERT INTO visitor_events (session_id, brand_id, event_type, event_label, event_data, event_id, occurred_at, siret, opportunity_id, lot_ref, analysis_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (session_id, event_id) WHERE event_id IS NOT NULL DO NOTHING`,
        [sessionId, brandId || null, eventType, eventLabel || null, eventData ? JSON.stringify(eventData) : null,
         eventId || null, occurredAt || null, siret || null, opportunityId || null, lotRef || null, analysisId || null]
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
    const lang: ConsultationLang = req.query.lang === 'en' ? 'en' : 'fr';
    const own = typeof req.query.sessionId === 'string' && req.query.sessionId.length >= 8 && req.query.sessionId.length <= 100 ? req.query.sessionId : null;
    if (!isUuid(opportunityId)) return res.json({ count: 0, indicator: null });
    // Real tracking only (view_opportunity events of THIS announcement). The caller's own session is excluded so a
    // visitor never counts himself; sessions with a SIRET lookup are identified companies, the others plain visits.
    const stats = await cachedStats(`${opportunityId}|${own || ''}`, 60_000, async () => {
      const r = await db.query(
        `SELECT
           COUNT(DISTINCT e.session_id) FILTER (WHERE e.created_at >= NOW() - INTERVAL '24 hours')::int AS s24,
           COUNT(DISTINCT e.session_id)::int AS s7,
           COUNT(DISTINCT e.session_id) FILTER (WHERE e.created_at >= NOW() - INTERVAL '24 hours' AND l.session_id IS NOT NULL)::int AS i24,
           COUNT(DISTINCT e.session_id) FILTER (WHERE l.session_id IS NOT NULL)::int AS i7,
           EXTRACT(EPOCH FROM (NOW() - MAX(e.created_at)))::int AS last_age
         FROM visitor_events e
         LEFT JOIN siret_lookups l ON l.session_id = e.session_id
         WHERE e.event_type IN ('view_opportunity', 'offer_view')
           AND e.event_data->>'opportunityId' = $1
           AND e.created_at >= NOW() - INTERVAL '7 days'
           AND ($2::text IS NULL OR e.session_id <> $2)`,
        [opportunityId, own]
      );
      const row = r.rows[0] || {};
      return {
        sessions24h: row.s24 || 0, sessions7d: row.s7 || 0, identified24h: row.i24 || 0, identified7d: row.i7 || 0,
        lastViewAgeSeconds: row.last_age == null ? null : Number(row.last_age),
      } as ConsultationStats;
    });
    // `count` (24 h distinct sessions) is kept for older frontends; `indicator` is null when nothing reliable exists.
    res.json({ count: stats.sessions24h, indicator: buildConsultationIndicator(stats, opportunityId, lang) });
  } catch (err: any) {
    logger.error('Consultations count error:', err);
    res.status(500).json({ error: 'Failed to fetch consultations count' });
  }
});

export default router;
