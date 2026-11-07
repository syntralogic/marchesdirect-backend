import { Router, Response } from 'express';
import { db } from '../config/database';
import { logger } from '../utils/logger';
import { AuthRequest } from '../middleware/auth';

// 7 nov. (diagnostic, point 4) : les recherches sauvegardées suivent le visiteur. Avant : stockage du navigateur
// seulement (perdu en changeant d'appareil), 12 au plus, la plus ancienne effacée sans prévenir. Désormais : une table
// serveur, rattachée à la session du téléphone et, dès la connexion, au compte ; nommables ; 50 par personne, avec
// un message clair quand la limite est atteinte. Une recherche peut demander une alerte e-mail (compte connecté) :
// l'alerte rejoue exactement la même recherche que le site (voir services/savedSearchAlertService.ts).
const router = Router();
export const SAVED_SEARCH_LIMIT = 50;
let ensured = false;
export async function ensureSavedSearchSchema() {
  if (ensured) return;
  await db.query(`CREATE TABLE IF NOT EXISTS saved_searches (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID, session_id VARCHAR(100), email_lower VARCHAR(255),
    label VARCHAR(160) NOT NULL, query TEXT NOT NULL, ranked BOOLEAN NOT NULL DEFAULT false,
    alert_enabled BOOLEAN NOT NULL DEFAULT false, last_alert_at TIMESTAMPTZ, alert_baseline_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), deleted_at TIMESTAMPTZ)`);
  await db.query(`CREATE INDEX IF NOT EXISTS saved_searches_user ON saved_searches(user_id) WHERE deleted_at IS NULL`);
  await db.query(`CREATE INDEX IF NOT EXISTS saved_searches_session ON saved_searches(session_id) WHERE deleted_at IS NULL`);
  await db.query(`CREATE TABLE IF NOT EXISTS saved_search_sent_items (
    saved_search_id UUID NOT NULL REFERENCES saved_searches(id) ON DELETE CASCADE, opportunity_id UUID NOT NULL,
    sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (saved_search_id, opportunity_id))`);
  ensured = true;
}

const sid = (req: AuthRequest) => String((req.query as any).sessionId || (req.body || {}).sessionId || '').slice(0, 100) || null;
const owner = (req: AuthRequest) => ({ userId: req.user?.id || null, sessionId: sid(req) });
const ownerWhere = (o: { userId: string | null; sessionId: string | null }, params: any[]) => {
  const parts: string[] = [];
  if (o.userId) { params.push(o.userId); parts.push(`user_id = $${params.length}`); }
  if (o.sessionId) { params.push(o.sessionId); parts.push(`session_id = $${params.length}`); }
  return parts.length ? `(${parts.join(' OR ')})` : 'FALSE';
};
const cleanQuery = (q: unknown) => { const p = new URLSearchParams(String(q || '').slice(0, 2000)); p.delete('source'); p.delete('page'); return p.toString(); };

router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    await ensureSavedSearchSchema();
    const o = owner(req); const params: any[] = [];
    // Connexion : ce qui a été sauvegardé depuis ce téléphone avant la connexion est rattaché au compte.
    if (o.userId && o.sessionId) await db.query(`UPDATE saved_searches SET user_id = $1, email_lower = $2, updated_at = NOW() WHERE user_id IS NULL AND session_id = $3 AND deleted_at IS NULL`, [o.userId, (req.user!.email || '').toLowerCase(), o.sessionId]);
    const r = await db.query(`SELECT id, label, query, ranked, alert_enabled, created_at, updated_at FROM saved_searches WHERE deleted_at IS NULL AND ${ownerWhere(o, params)} ORDER BY created_at DESC LIMIT ${SAVED_SEARCH_LIMIT}`, params);
    res.json({ items: r.rows, limit: SAVED_SEARCH_LIMIT, canAlert: !!req.user?.email });
  } catch (err) { logger.error('[recherches] liste :', err); res.status(503).json({ error: 'unavailable' }); }
});

router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    await ensureSavedSearchSchema();
    const o = owner(req);
    if (!o.userId && !o.sessionId) return res.status(400).json({ error: 'no_owner' });
    const query = cleanQuery(req.body?.query); const label = String(req.body?.label || '').trim().slice(0, 160) || 'Ma recherche';
    if (!query) return res.status(400).json({ error: 'empty_query', message: 'Rien à sauvegarder : lancez une recherche d’abord.' });
    const p1: any[] = [query];
    const existing = await db.query(`SELECT id FROM saved_searches WHERE deleted_at IS NULL AND query = $1 AND ${ownerWhere(o, p1)}`, p1);
    if (existing.rows.length) {
      await db.query(`UPDATE saved_searches SET updated_at = NOW() WHERE id = $1`, [existing.rows[0].id]);
      return res.json({ ok: true, id: existing.rows[0].id, duplicate: true });
    }
    const p2: any[] = [];
    const c = await db.query(`SELECT COUNT(*)::int AS n FROM saved_searches WHERE deleted_at IS NULL AND ${ownerWhere(o, p2)}`, p2);
    if ((c.rows[0]?.n || 0) >= SAVED_SEARCH_LIMIT) return res.status(409).json({ error: 'limit', message: `Vous avez déjà ${SAVED_SEARCH_LIMIT} recherches sauvegardées. Supprimez-en une pour en ajouter une nouvelle.` });
    const r = await db.query(`INSERT INTO saved_searches (user_id, session_id, email_lower, label, query, ranked) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [o.userId, o.sessionId, req.user?.email ? req.user.email.toLowerCase() : null, label, query, req.body?.ranked === true]);
    res.json({ ok: true, id: r.rows[0].id });
  } catch (err) { logger.error('[recherches] sauvegarde :', err); res.status(503).json({ error: 'unavailable' }); }
});

router.put('/:id', async (req: AuthRequest, res: Response) => {
  try {
    await ensureSavedSearchSchema();
    const o = owner(req); const params: any[] = [req.params.id];
    const sets: string[] = ['updated_at = NOW()'];
    if (typeof req.body?.label === 'string' && req.body.label.trim()) { params.push(req.body.label.trim().slice(0, 160)); sets.push(`label = $${params.length}`); }
    if (typeof req.body?.alertEnabled === 'boolean') {
      if (req.body.alertEnabled && !req.user?.email) return res.status(401).json({ error: 'login_required', message: 'Connectez-vous pour recevoir cette recherche par e-mail.' });
      params.push(req.body.alertEnabled); sets.push(`alert_enabled = $${params.length}`);
      // Point de départ de l'alerte : rien d'antérieur à l'activation n'est envoyé.
      if (req.body.alertEnabled) sets.push('alert_baseline_at = COALESCE(alert_baseline_at, NOW())');
    }
    const r = await db.query(`UPDATE saved_searches SET ${sets.join(', ')} WHERE id = $1 AND deleted_at IS NULL AND ${ownerWhere(o, params)} RETURNING id`, params);
    if (!r.rows.length) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true });
  } catch (err) { logger.error('[recherches] modification :', err); res.status(503).json({ error: 'unavailable' }); }
});

router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    await ensureSavedSearchSchema();
    const o = owner(req); const params: any[] = [req.params.id];
    const r = await db.query(`UPDATE saved_searches SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL AND ${ownerWhere(o, params)} RETURNING id`, params);
    if (!r.rows.length) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true });
  } catch (err) { logger.error('[recherches] suppression :', err); res.status(503).json({ error: 'unavailable' }); }
});

export default router;
