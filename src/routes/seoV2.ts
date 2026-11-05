import { Router, Request, Response } from 'express';
import { logger } from '../utils/logger';
import { noticeForSeo, legacyTargets, locationOf, buildPage, indexablePaths, topLinks, BASE_JOURNEY } from '../services/seoV2Service';

// /api/seo/v2 — lecture seule, publique, mise en cache (5 nov., mandat référencement). Aucune route existante modifiée.
const router = Router();
const cache = (res: Response, s = 600) => res.set('Cache-Control', `public, max-age=${s}, s-maxage=${s}, stale-while-revalidate=86400`);

router.get('/page', async (req: Request, res: Response) => {
  const q = req.query as Record<string, string | undefined>;
  try {
    const out = await buildPage({ base: String(q.base || ''), city: q.city, trade: q.trade, department: q.department, page: q.page });
    cache(res);
    if (out.status === 404) return res.status(404).json({ error: 'not_found' });
    if (out.status === 301) return res.json({ redirect: out.location });
    res.json(out);
  } catch (err) { logger.error('[SEO v2] page:', err); res.status(503).json({ error: 'unavailable' }); }
});

router.get('/sitemap', async (_req: Request, res: Response) => {
  try { cache(res, 1800); res.json({ pages: await indexablePaths() }); }
  catch (err) { logger.error('[SEO v2] sitemap:', err); res.status(503).json({ error: 'unavailable' }); }
});

router.get('/links', async (req: Request, res: Response) => {
  const base = String(req.query.base || '');
  try { cache(res); res.json(await topLinks(BASE_JOURNEY[base])); }
  catch (err) { logger.error('[SEO v2] liens:', err); res.status(503).json({ error: 'unavailable' }); }
});

router.get('/legacy', async (req: Request, res: Response) => {
  try { cache(res, 3600); res.json(await legacyTargets({ slug: req.query.slug ? String(req.query.slug) : undefined, limit: Number(req.query.limit) || 200, offset: Number(req.query.offset) || 0 })); }
  catch (err) { logger.error('[SEO v2] anciennes adresses:', err); res.status(503).json({ error: 'unavailable' }); }
});

router.get('/lieu/:ref', async (req: Request, res: Response) => {
  try { const out = await locationOf(String(req.params.ref)); if (!out) return res.status(404).json({ error: 'not_found' }); cache(res, 300); res.json(out); }
  catch (err) { logger.error('[SEO v2] lieu:', err); res.status(503).json({ error: 'unavailable' }); }
});

router.get('/annonce/:id', async (req: Request, res: Response) => {
  try { const out = await noticeForSeo(String(req.params.id)); if (!out) return res.status(404).json({ error: 'not_found' }); cache(res, 300); res.json(out); }
  catch (err) { logger.error('[SEO v2] annonce:', err); res.status(503).json({ error: 'unavailable' }); }
});

// Contrôle technique en lecture seule (aucune donnée personnelle) : état de la table des lieux et de la recherche v2.
router.get('/diag', async (_req: Request, res: Response) => {
  try {
    const { db } = require('../config/database');
    const cols = await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'opportunity_locations' ORDER BY ordinal_position`);
    const n = await db.query(`SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE extractor_version >= 3)::int AS v3, MAX(computed_at) AS last FROM opportunity_locations`).catch((e: any) => ({ rows: [{ error: e.code || 'err' }] }));
    const st = await db.query(`SELECT exec_status, COUNT(*)::int AS n FROM opportunity_locations GROUP BY 1 ORDER BY 2 DESC`).catch(() => ({ rows: [] }));
    const open = await db.query(`SELECT COUNT(*)::int AS n FROM opportunities WHERE deleted_at IS NULL AND status = 'active' AND (deadline IS NULL OR deadline >= NOW())`);
    let probe: any = null;
    try { await db.query(`SELECT o.id FROM opportunities o LEFT JOIN opportunity_locations l ON l.opportunity_id = o.id WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(l.exec_communes) ec WHERE ec->>'slug' = ANY($1::text[])) AND cardinality(l.exec_departments) >= 0 AND l.deadline_source IS NULL LIMIT 1`, [['bordeaux']]); probe = 'ok'; }
    catch (e: any) { probe = { code: e.code, message: String(e.message || '').slice(0, 160) }; }
    res.set('Cache-Control', 'no-store').json({ columns: cols.rows.map((r: any) => r.column_name), table: n.rows[0], byStatus: st.rows, openInBase: open.rows[0].n, v2SqlProbe: probe });
  } catch (err: any) { res.status(503).json({ error: 'unavailable', code: err?.code || null }); }
});

export default router;
