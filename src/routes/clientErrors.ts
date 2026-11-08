import { Router, Request, Response, json } from 'express';
import { db } from '../config/database';
import { logger } from '../utils/logger';

// 8 nov. (Hedi : « sur Mon espace, tu cliques sur certains trucs, ça affiche Une erreur inattendue ») : chaque plantage
// de l'interface est envoyé ici par la page d'erreur (message, pile, page sans ses paramètres, navigateur). Aucune donnée
// personnelle : pas d'e-mail, pas de session, l'adresse de la page sans « ?… ». Lecture : GET /api/client-errors/recent.
const router = Router();
let ready: Promise<unknown> | null = null;
const schema = () => (ready ??= db.query(`CREATE TABLE IF NOT EXISTS client_errors (
  id BIGSERIAL PRIMARY KEY, at TIMESTAMPTZ NOT NULL DEFAULT NOW(), path VARCHAR(300), message VARCHAR(600),
  stack VARCHAR(4000), component_stack VARCHAR(3000), user_agent VARCHAR(300), build VARCHAR(80))`).catch(e => { ready = null; throw e; }));
const clip = (v: unknown, n: number) => (typeof v === 'string' ? v.slice(0, n) : null);
let lastMinute = { at: 0, n: 0 };

router.post('/', json({ limit: '16kb' }), async (req: Request, res: Response) => {
  const now = Date.now(); if (now - lastMinute.at > 60_000) lastMinute = { at: now, n: 0 };
  if (++lastMinute.n > 120) return res.status(202).json({ ok: true }); // tempête d'erreurs : on n'inonde pas la base
  try {
    await schema();
    const b = req.body || {};
    await db.query(`INSERT INTO client_errors (path, message, stack, component_stack, user_agent, build) VALUES ($1,$2,$3,$4,$5,$6)`,
      [clip(String(b.path || '').split('?')[0], 300), clip(b.message, 600), clip(b.stack, 4000), clip(b.componentStack, 3000), clip(req.headers['user-agent'], 300), clip(b.build, 80)]);
    await db.query(`DELETE FROM client_errors WHERE at < NOW() - INTERVAL '30 days'`).catch(() => {});
    res.status(201).json({ ok: true });
  } catch (err) { logger.warn('[client-errors] enregistrement impossible :', (err as any)?.message); res.status(202).json({ ok: false }); }
});

router.get('/recent', async (_req: Request, res: Response) => {
  try {
    await schema();
    const r = await db.query(`SELECT at, path, message, left(stack, 1500) AS stack, left(component_stack, 1200) AS component_stack, left(user_agent, 120) AS ua, build
      FROM client_errors ORDER BY at DESC LIMIT 30`);
    res.set('Cache-Control', 'no-store').json({ count: r.rows.length, errors: r.rows });
  } catch { res.status(503).json({ error: 'unavailable' }); }
});
export default router;
