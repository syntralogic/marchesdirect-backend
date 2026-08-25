import { Router, Request, Response } from 'express';
import { db } from '../config/database';
import { logger } from '../utils/logger';

const router = Router();

// Resolves the requesting brand the same way GET /api/brands/current does -
// match Host header against brands.domain, fall back to the first brand for
// local dev / the single-brand site today.
const resolveBrandId = async (req: Request): Promise<string | null> => {
  const host = (req.hostname || '').replace(/^www\./, '');
  let result = await db.query('SELECT id FROM brands WHERE domain = $1 LIMIT 1', [host]);
  if (result.rows.length === 0) {
    result = await db.query('SELECT id FROM brands ORDER BY created_at ASC LIMIT 1');
  }
  return result.rows[0]?.id ?? null;
};

// GET /api/seo-pages - published slugs only, for the frontend's sitemap.xml
// generator. Milestone 11 auto-generates one row per (trade x region) with
// active opportunities, but until this route existed nothing could list them
// for Google to discover in the first place.
router.get('/', async (req: Request, res: Response) => {
  try {
    const brandId = await resolveBrandId(req);
    const result = await db.query(
      `SELECT page_slug, updated_at FROM seo_pages
       WHERE brand_id = $1 AND is_published = true
       ORDER BY updated_at DESC`,
      [brandId]
    );
    res.json({ pages: result.rows });
  } catch (err: any) {
    logger.error('Public SEO pages list error:', err);
    res.status(500).json({ error: 'Failed to fetch SEO pages' });
  }
});

// GET /api/seo-pages/:slug - single published page's content, keyed by the
// slug the generation job produces (e.g. "maconnerie-ile-de-france"). Also
// bumps page_views so the admin stats you're already looking at reflect real
// traffic instead of staying at 0 forever.
router.get('/:slug', async (req: Request, res: Response) => {
  try {
    const brandId = await resolveBrandId(req);
    const result = await db.query(
      `SELECT page_slug, page_title, page_meta_description, page_keywords, page_content,
              filter_trade_id, filter_region, filter_city, filter_department
       FROM seo_pages
       WHERE brand_id = $1 AND page_slug = $2 AND is_published = true`,
      [brandId, req.params.slug]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Page not found' });
    }

    db.query('UPDATE seo_pages SET page_views = page_views + 1 WHERE page_slug = $1', [req.params.slug])
      .catch((err) => logger.error('SEO page view increment failed:', err));

    res.json(result.rows[0]);
  } catch (err: any) {
    logger.error('Public SEO page fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch SEO page' });
  }
});

export default router;
