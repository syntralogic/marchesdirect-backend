import { Router, Request, Response } from 'express';
import { db } from '../config/database';
import { logger } from '../utils/logger';
import { resolveBrandId } from '../utils/brandResolution';

const router = Router();

// GET /api/seo-pages - published slugs only, for the frontend's sitemap.xml
// generator. Milestone 11 auto-generates one row per (trade x region) with
// active opportunities, but until this route existed nothing could list them
// for Google to discover in the first place.
router.get('/', async (req: Request, res: Response) => {
  try {
    const brandId = await resolveBrandId(req);
    const result = await db.query(
      `SELECT sp.page_slug, sp.page_type, sp.updated_at, sp.filter_city, sp.filter_department,
              t.name as filter_trade_name, ot.code as filter_journey
       FROM seo_pages sp
       LEFT JOIN trades t ON sp.filter_trade_id = t.id
       LEFT JOIN opportunity_types ot ON sp.filter_opportunity_type_id = ot.id
       WHERE sp.brand_id = $1 AND sp.is_published = true
       ORDER BY sp.updated_at DESC`,
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
      `SELECT sp.page_slug, sp.page_title, sp.page_meta_description, sp.page_keywords, sp.page_content,
              sp.filter_trade_id, sp.filter_region, sp.filter_city, sp.filter_department,
              ot.code as filter_journey
       FROM seo_pages sp
       LEFT JOIN opportunity_types ot ON sp.filter_opportunity_type_id = ot.id
       WHERE sp.brand_id = $1 AND sp.page_slug = $2 AND sp.is_published = true`,
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

// GET /api/seo-pages/lookup - resolves a page by its structural filters
// (journey + city, optionally + trade, or department-level) rather than a
// flat slug string. This is what lets the frontend expose clean nested URLs
// (/marches-publics/bordeaux, /marches-publics/bordeaux/electricite,
// /marches-publics/gironde) without the route needing to know the exact
// slug format the generation job happens to use internally.
//
// Also enriches the response with real, live-computed local context the
// static page_content doesn't carry: the actual local public buyers seen in
// that zone, other trades with open opportunities nearby, and neighbouring
// cities in the same department - all derived from real opportunity rows at
// request time, never invented, and never stale between generation runs.
router.get('/lookup', async (req: Request, res: Response) => {
  try {
    const brandId = await resolveBrandId(req);
    const { journey, city, trade, department } = req.query as Record<string, string | undefined>;

    if (!journey || (!city && !department)) {
      return res.status(400).json({ error: 'journey and (city or department) are required' });
    }

    const filters: string[] = ['sp.brand_id = $1', 'ot.code = $2', 'sp.is_published = true'];
    const params: any[] = [brandId, journey];
    let idx = 3;

    if (city) { filters.push(`sp.filter_city = $${idx++}`); params.push(city); }
    else filters.push('sp.filter_city IS NULL');
    if (trade) { filters.push(`t.name = $${idx++}`); params.push(trade); }
    else filters.push('sp.filter_trade_id IS NULL');
    if (!city && department) { filters.push(`sp.filter_department = $${idx++}`); params.push(department); }

    const pageResult = await db.query(
      `SELECT sp.id, sp.page_slug, sp.page_title, sp.page_meta_description, sp.page_content,
              sp.filter_city, sp.filter_department, sp.updated_at, t.name as filter_trade_name, ot.code as filter_journey
       FROM seo_pages sp
       LEFT JOIN trades t ON sp.filter_trade_id = t.id
       JOIN opportunity_types ot ON sp.filter_opportunity_type_id = ot.id
       WHERE ${filters.join(' AND ')}
       LIMIT 1`,
      params
    );

    if (pageResult.rows.length === 0) {
      return res.status(404).json({ error: 'Page not found' });
    }

    const page = pageResult.rows[0];
    db.query('UPDATE seo_pages SET page_views = page_views + 1 WHERE id = $1', [page.id]).catch(() => undefined);

    const zoneFilter = page.filter_city ? { col: 'o.location_city', val: page.filter_city } : { col: 'o.location_department', val: page.filter_department };

    const [buyers, relatedTrades, neighboringCities] = await Promise.all([
      // Real local public buyers - only for public procurement, and only
      // buyer_name (never a named contact) per the same identity rules used
      // on the opportunity detail page.
      journey === 'public_procurement'
        ? db.query(
            `SELECT DISTINCT o.buyer_name FROM opportunities o
             WHERE o.status = 'active' AND o.deleted_at IS NULL AND o.buyer_name IS NOT NULL
               AND ${zoneFilter.col} = $1
             LIMIT 6`,
            [zoneFilter.val]
          )
        : Promise.resolve({ rows: [] }),
      db.query(
        `SELECT t.name, COUNT(o.id) as opp_count FROM opportunities o
         JOIN trades t ON o.trade_id = t.id
         WHERE o.status = 'active' AND o.deleted_at IS NULL AND ${zoneFilter.col} = $1
         GROUP BY t.name ORDER BY opp_count DESC LIMIT 8`,
        [zoneFilter.val]
      ),
      page.filter_city && page.filter_department
        ? db.query(
            `SELECT DISTINCT o.location_city FROM opportunities o
             WHERE o.status = 'active' AND o.deleted_at IS NULL AND o.location_department = $1
               AND o.location_city != $2 AND o.location_city IS NOT NULL
             LIMIT 8`,
            [page.filter_department, page.filter_city]
          )
        : Promise.resolve({ rows: [] }),
    ]);

    res.json({
      ...page,
      local_buyers: buyers.rows.map((r: any) => r.buyer_name),
      related_trades: relatedTrades.rows,
      neighboring_cities: neighboringCities.rows.map((r: any) => r.location_city),
    });
  } catch (err: any) {
    logger.error('Public SEO page lookup error:', err);
    res.status(500).json({ error: 'Failed to fetch SEO page' });
  }
});

export default router;
