import { Router, Request, Response } from 'express';
import { db } from '../config/database';
import { logger } from '../utils/logger';
import { authenticate, requireRole } from '../middleware/auth';

// 7 nov. (revue externe : « simplifier le signalement ») : un artisan signale en un geste une annonce inexacte. Aucune
// coordonnée demandée, rien dans HubSpot (ce n'est pas une demande de contact) : l'équipe lit la liste et corrige.
const router = Router();
export const REPORT_KINDS: Record<string, string> = {
  closed: 'Déjà attribuée ou clôturée', deadline: 'Date limite fausse', place: 'Lieu faux', trade: 'Mauvais métier',
  duplicate: 'Doublon d’une autre annonce', other: 'Autre',
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let ready: Promise<void> | null = null;
const ensure = () => ready ||= db.query(`CREATE TABLE IF NOT EXISTS listing_reports (id SERIAL PRIMARY KEY, opportunity_id UUID NOT NULL,
    kind TEXT NOT NULL, comment TEXT, session_id TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), handled_at TIMESTAMPTZ,
    UNIQUE (opportunity_id, session_id, kind))`).then(() => undefined).catch(e => { ready = null; throw e; });

// POST /api/listing-reports { opportunityId, kind, comment?, sessionId? }
router.post('/', async (req: Request, res: Response) => {
  try {
    const { opportunityId, kind } = req.body || {};
    if (typeof opportunityId !== 'string' || !UUID.test(opportunityId) || !REPORT_KINDS[kind]) return res.status(400).json({ error: 'invalid' });
    const comment = typeof req.body.comment === 'string' ? req.body.comment.trim().slice(0, 500) || null : null;
    const sessionId = typeof req.body.sessionId === 'string' ? req.body.sessionId.slice(0, 100) : null;
    await ensure();
    await db.query(`INSERT INTO listing_reports (opportunity_id, kind, comment, session_id) SELECT $1, $2, $3, $4
      WHERE EXISTS (SELECT 1 FROM opportunities WHERE id = $1) ON CONFLICT (opportunity_id, session_id, kind) DO NOTHING`, [opportunityId, kind, comment, sessionId]);
    res.json({ ok: true });
  } catch (err) { logger.error('[signalements] enregistrement :', err); res.status(503).json({ error: 'unavailable' }); }
});

// GET /api/listing-reports : signalements non traités, regroupés par annonce (équipe uniquement).
router.get('/', authenticate, requireRole(['admin', 'super_admin']), async (_req: Request, res: Response) => {
  try {
    await ensure();
    const r = await db.query(`SELECT r.opportunity_id, o.title, o.source_reference, COUNT(*)::int AS reports,
        array_agg(DISTINCT r.kind) AS kinds, array_remove(array_agg(r.comment), NULL) AS comments, MAX(r.created_at) AS last_at
      FROM listing_reports r JOIN opportunities o ON o.id = r.opportunity_id WHERE r.handled_at IS NULL
      GROUP BY 1, 2, 3 ORDER BY COUNT(*) DESC, MAX(r.created_at) DESC LIMIT 200`);
    res.json({ kinds: REPORT_KINDS, items: r.rows });
  } catch (err) { logger.error('[signalements] liste :', err); res.status(503).json({ error: 'unavailable' }); }
});

export default router;
