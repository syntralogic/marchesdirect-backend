import { Router, Request, Response } from 'express';
import { logger } from '../utils/logger';
import { buildPage, indexablePaths, topLinks, BASE_JOURNEY } from '../services/seoV2Service';

// /api/seo/v2 — lecture seule, publique, mise en cache (5 nov., mandat référencement). Aucune route existante modifiée.
const router = Router();
const cache = (res: Response, s = 600) => res.set('Cache-Control', `public, max-age=${s}, s-maxage=${s}, stale-while-revalidate=86400`);

router.get('/page', async (req: Request, res: Response) => {
  const q = req.query as Record<string, string | undefined>;
  try {
    const out = await buildPage({ base: String(q.base || ''), city: q.city, trade: q.trade, department: q.department });
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

export default router;
