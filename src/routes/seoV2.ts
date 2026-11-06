import { Router, Request, Response } from 'express';
import { logger } from '../utils/logger';
import { noticeForSeo, legacyTargets, locationOf, buildPage, indexablePaths, topLinks, BASE_JOURNEY, barometer, buyerPage, buyerPaths, buyersOfDepartment } from '../services/seoV2Service';

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

router.get('/barometre', async (_req: Request, res: Response) => {
  try { cache(res, 900); res.json(await barometer()); }
  catch (err) { logger.error('[SEO v2] baromètre:', err); res.status(503).json({ error: 'unavailable' }); }
});

// Pages acheteurs (7 nov.) : données d'une page, liste pour le plan du site, acheteurs d'un département.
router.get('/acheteur/:slug', async (req: Request, res: Response) => {
  try { const out = await buyerPage(String(req.params.slug)); if (!out) return res.status(404).json({ error: 'not_found' }); cache(res, 900); res.json(out); }
  catch (err) { logger.error('[SEO v2] acheteur:', err); res.status(503).json({ error: 'unavailable' }); }
});
router.get('/acheteurs', async (_req: Request, res: Response) => {
  try { cache(res, 1800); res.json({ pages: await buyerPaths() }); }
  catch (err) { logger.error('[SEO v2] acheteurs:', err); res.status(503).json({ error: 'unavailable' }); }
});
router.get('/acheteurs/departement/:d', async (req: Request, res: Response) => {
  try { cache(res, 1800); res.json({ buyers: await buyersOfDepartment(String(req.params.d).toUpperCase(), Math.min(100, Number(req.query.limit) || 30)) }); }
  catch (err) { logger.error('[SEO v2] acheteurs du département:', err); res.status(503).json({ error: 'unavailable' }); }
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

// Compteur public « marchés ouverts » (6 nov.) : une requête SQL légère, mise en cache 5 minutes (aucun appel
// externe, aucune IA). « Ouvert » = date limite connue et à venir, non annulée (date relue dans l'avis si disponible).
// Renvoie aussi la date du dernier import réussi, pour que le chiffre ne soit jamais présenté comme frais s'il ne l'est pas.
let counterCache: { at: number; body: any } | null = null;
router.get('/compteur', async (_req: Request, res: Response) => {
  try {
    if (!counterCache || Date.now() - counterCache.at > 5 * 60000) {
      const { db } = require('../config/database');
      const c = await db.query(`
        SELECT COUNT(*) FILTER (WHERE COALESCE(l.notice_deadline, o.deadline) >= NOW() AND COALESCE(l.notice_deadline, o.deadline) <= NOW() + INTERVAL '3 years')::int AS open,
               COUNT(*) FILTER (WHERE COALESCE(l.notice_deadline, o.deadline) IS NULL AND o.created_at >= NOW() - INTERVAL '60 days')::int AS verify,
               COUNT(*) FILTER (WHERE o.created_at >= NOW() - INTERVAL '24 hours')::int AS new24h
          FROM opportunities o
          LEFT JOIN opportunity_locations l ON l.opportunity_id = o.id
          LEFT JOIN data_sources ds ON ds.id = o.source_id
         WHERE o.deleted_at IS NULL AND o.status = 'active' AND NOT COALESCE(o.is_cancelled, false)
           AND COALESCE(ds.code, '') <> 'editorial_catalog' AND (ds.code IS DISTINCT FROM 'ted' OR o.location_country IN ('FR', 'FRA'))`);
      const src = await db.query(`SELECT code, name, active AS is_active, last_run, next_run, frequency_hours, total_imports FROM data_sources WHERE COALESCE(code, '') <> 'editorial_catalog' ORDER BY last_run DESC NULLS LAST`);
      const lastImportAt = src.rows.find((r: any) => r.is_active && r.last_run)?.last_run || null;
      counterCache = { at: Date.now(), body: { ...c.rows[0], lastImportAt, sources: src.rows.map((r: any) => ({ code: r.code, active: r.is_active, lastRun: r.last_run, nextRun: r.next_run, everyHours: r.frequency_hours, totalImports: r.total_imports })), computedAt: new Date().toISOString() } };
    }
    res.set('Cache-Control', 'public, max-age=60, s-maxage=300').json(counterCache.body);
  } catch (err: any) { res.status(503).json({ error: 'unavailable' }); }
});

// Santé de la chaîne (6 nov.) : résumé public (statuts et nombres), détail complet réservé aux administrateurs.
router.get('/sante', async (req: Request, res: Response) => {
  try {
    const { runHealthChecks } = require('../services/healthService');
    const r = await runHealthChecks();
    res.set('Cache-Control', 'no-store').json({ at: r.at, overall: r.overall, checks: r.checks.map((c: any) => ({ id: c.id, group: c.group, label: c.label, status: c.status, value: c.id.startsWith('cost.') ? undefined : c.value, detail: c.id.startsWith('import.') ? c.detail : undefined, rule: c.rule })) });
  } catch (err: any) { res.status(503).json({ error: 'unavailable' }); }
});

export default router;
