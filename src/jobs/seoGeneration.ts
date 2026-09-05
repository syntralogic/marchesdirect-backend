import cron from 'node-cron';
import { db } from '../config/database';
import { logger } from '../utils/logger';
import { trackJob } from '../utils/jobTracker';

// ============================================================================
// SEO PAGE GENERATION AT SCALE (Milestone 11)
// Structure inspired by France Marchés: one page per (trade x city/region/department),
// auto-generated from real, current opportunity data (not static templates).
// ============================================================================

const slugify = (text: string) =>
  text
    .toString()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

// Journey-specific copy for the city pages below - these are the exact
// search terms the client asked to rank for ("appel d'offres Bordeaux",
// "sous-traitance Paris"), which is a different axis (city x journey type)
// than the trade x region pages generatePagesForBrand() already produces.
const JOURNEY_COPY: Record<string, { term: string; noun: string }> = {
  public_procurement: { term: 'marchés publics', noun: 'marché public' },
  tender: { term: "appels d'offres", noun: "appel d'offres" },
  subcontracting: { term: 'sous-traitance', noun: 'mission de sous-traitance' },
};

const generateCityJourneyPagesForBrand = async (brandId: string) => {
  let created = 0;
  let updated = 0;

  // City x journey-type combinations with at least one active opportunity -
  // same "only generate what's real" rule as the trade x region pages below,
  // so we never publish a page promising results a search won't actually
  // return.
  const combos = await db.query(
    `SELECT o.location_city, ot.code as journey, ot.id as opportunity_type_id, COUNT(o.id) as opp_count
     FROM opportunities o
     JOIN opportunity_types ot ON o.opportunity_type_id = ot.id
     WHERE o.status = 'active' AND o.deleted_at IS NULL
       AND o.location_city IS NOT NULL AND o.location_city != ''
     GROUP BY o.location_city, ot.code, ot.id
     HAVING COUNT(o.id) > 0`
  );

  for (const combo of combos.rows) {
    const copy = JOURNEY_COPY[combo.journey];
    if (!copy) continue; // unknown/future journey code - skip rather than guess wording

    const slug = `${slugify(copy.noun)}-${slugify(combo.location_city)}`;
    const title = `${copy.noun.charAt(0).toUpperCase()}${copy.noun.slice(1)} à ${combo.location_city} — Marchés Direct`;
    const metaDescription = `${combo.opp_count} ${copy.term} actuellement ouverts à ${combo.location_city}. Consultez les annonces et candidatez directement.`;
    const content = `Marchés Direct référence actuellement ${combo.opp_count} ${copy.noun}${Number(combo.opp_count) > 1 ? 's' : ''} à ${combo.location_city}. Consultez le détail de chaque annonce, analysez votre compatibilité et préparez votre candidature directement depuis la plateforme.`;

    const existing = await db.query('SELECT id FROM seo_pages WHERE page_slug = $1', [slug]);

    if (existing.rows.length > 0) {
      await db.query(
        `UPDATE seo_pages SET page_title = $1, page_meta_description = $2, page_content = $3, updated_at = NOW()
         WHERE id = $4`,
        [title, metaDescription, content, existing.rows[0].id]
      );
      updated++;
    } else {
      await db.query(
        `INSERT INTO seo_pages
          (brand_id, page_type, page_slug, page_title, page_meta_description, page_content, filter_city, filter_opportunity_type_id, is_published)
         VALUES ($1, 'city_journey', $2, $3, $4, $5, $6, $7, true)`,
        [brandId, slug, title, metaDescription, content, combo.location_city, combo.opportunity_type_id]
      );
      created++;
    }
  }

  return { created, updated };
};

const generateCityTradePagesForBrand = async (brandId: string) => {
  let created = 0;
  let updated = 0;

  // City x Trade x Journey - the most specific combination the client asked
  // for by name ("marché public climatisation Bordeaux",
  // "appel d'offres nettoyage Gironde"). Only generated where a real
  // opportunity exists for that exact combo - never a thin/empty page.
  const combos = await db.query(
    `SELECT o.location_city, o.location_department, t.id as trade_id, t.name as trade_name,
            ot.code as journey, ot.id as opportunity_type_id, COUNT(o.id) as opp_count
     FROM opportunities o
     JOIN trades t ON o.trade_id = t.id
     JOIN opportunity_types ot ON o.opportunity_type_id = ot.id
     WHERE o.status = 'active' AND o.deleted_at IS NULL
       AND o.location_city IS NOT NULL AND o.location_city != ''
     GROUP BY o.location_city, o.location_department, t.id, t.name, ot.code, ot.id
     HAVING COUNT(o.id) > 0`
  );

  for (const combo of combos.rows) {
    const copy = JOURNEY_COPY[combo.journey];
    if (!copy) continue;

    const slug = `${slugify(copy.noun)}-${slugify(combo.location_city)}-${slugify(combo.trade_name)}`;
    const title = `${copy.noun.charAt(0).toUpperCase()}${copy.noun.slice(1)} ${combo.trade_name} à ${combo.location_city} — Marchés Direct`;
    const metaDescription = `${combo.opp_count} ${copy.term} en ${combo.trade_name} actuellement ouverts à ${combo.location_city}. Mis à jour automatiquement.`;
    const content = `Marchés Direct référence actuellement ${combo.opp_count} ${copy.noun}${Number(combo.opp_count) > 1 ? 's' : ''} en ${combo.trade_name} à ${combo.location_city}.`;

    const existing = await db.query('SELECT id FROM seo_pages WHERE page_slug = $1', [slug]);

    if (existing.rows.length > 0) {
      await db.query(
        `UPDATE seo_pages SET page_title = $1, page_meta_description = $2, page_content = $3,
           filter_department = $4, updated_at = NOW() WHERE id = $5`,
        [title, metaDescription, content, combo.location_department, existing.rows[0].id]
      );
      updated++;
    } else {
      await db.query(
        `INSERT INTO seo_pages
          (brand_id, page_type, page_slug, page_title, page_meta_description, page_content,
           filter_trade_id, filter_city, filter_department, filter_opportunity_type_id, is_published)
         VALUES ($1, 'city_trade_journey', $2, $3, $4, $5, $6, $7, $8, $9, true)`,
        [brandId, slug, title, metaDescription, content, combo.trade_id, combo.location_city, combo.location_department, combo.opportunity_type_id]
      );
      created++;
    }
  }

  return { created, updated };
};

const generateDepartmentPagesForBrand = async (brandId: string) => {
  let created = 0;
  let updated = 0;

  // Department x journey - one level up from the city pages, matching
  // "/marches-publics/gironde" in the client's requested URL list.
  const combos = await db.query(
    `SELECT o.location_department, ot.code as journey, ot.id as opportunity_type_id, COUNT(o.id) as opp_count
     FROM opportunities o
     JOIN opportunity_types ot ON o.opportunity_type_id = ot.id
     WHERE o.status = 'active' AND o.deleted_at IS NULL
       AND o.location_department IS NOT NULL AND o.location_department != ''
     GROUP BY o.location_department, ot.code, ot.id
     HAVING COUNT(o.id) > 0`
  );

  for (const combo of combos.rows) {
    const copy = JOURNEY_COPY[combo.journey];
    if (!copy) continue;

    const slug = `${slugify(copy.noun)}-departement-${slugify(combo.location_department)}`;
    const title = `${copy.noun.charAt(0).toUpperCase()}${copy.noun.slice(1)} dans le département ${combo.location_department} — Marchés Direct`;
    const metaDescription = `${combo.opp_count} ${copy.term} actuellement ouverts dans le département ${combo.location_department}.`;
    const content = `Marchés Direct référence actuellement ${combo.opp_count} ${copy.noun}${Number(combo.opp_count) > 1 ? 's' : ''} dans le département ${combo.location_department}.`;

    const existing = await db.query('SELECT id FROM seo_pages WHERE page_slug = $1', [slug]);

    if (existing.rows.length > 0) {
      await db.query(
        `UPDATE seo_pages SET page_title = $1, page_meta_description = $2, page_content = $3, updated_at = NOW()
         WHERE id = $4`,
        [title, metaDescription, content, existing.rows[0].id]
      );
      updated++;
    } else {
      await db.query(
        `INSERT INTO seo_pages
          (brand_id, page_type, page_slug, page_title, page_meta_description, page_content, filter_department, filter_opportunity_type_id, is_published)
         VALUES ($1, 'department_journey', $2, $3, $4, $5, $6, $7, true)`,
        [brandId, slug, title, metaDescription, content, combo.location_department, combo.opportunity_type_id]
      );
      created++;
    }
  }

  return { created, updated };
};

const generatePagesForBrand = async (brandId: string) => {
  let created = 0;
  let updated = 0;

  // Trade x Region combinations with at least one active opportunity
  const combos = await db.query(
    `SELECT t.id as trade_id, t.name as trade_name, o.location_region,
            COUNT(o.id) as opp_count
     FROM opportunities o
     JOIN trades t ON o.trade_id = t.id
     WHERE o.status = 'active' AND o.deleted_at IS NULL
       AND o.location_region IS NOT NULL
     GROUP BY t.id, t.name, o.location_region
     HAVING COUNT(o.id) > 0`
  );

  for (const combo of combos.rows) {
    const slug = `${slugify(combo.trade_name)}-${slugify(combo.location_region)}`;
    const title = `${combo.trade_name} - Appels d'offres et marchés publics en ${combo.location_region}`;
    const metaDescription = `${combo.opp_count} opportunités actuelles en ${combo.trade_name} dans la région ${combo.location_region}. Mis à jour automatiquement.`;
    const content = `Découvrez les opportunités de marché en ${combo.trade_name} dans la région ${combo.location_region}. Actuellement ${combo.opp_count} opportunité(s) active(s) sur la plateforme.`;

    const existing = await db.query('SELECT id FROM seo_pages WHERE page_slug = $1', [slug]);

    if (existing.rows.length > 0) {
      await db.query(
        `UPDATE seo_pages SET page_title = $1, page_meta_description = $2, page_content = $3, updated_at = NOW()
         WHERE id = $4`,
        [title, metaDescription, content, existing.rows[0].id]
      );
      updated++;
    } else {
      await db.query(
        `INSERT INTO seo_pages
          (brand_id, page_type, page_slug, page_title, page_meta_description, page_content, filter_trade_id, filter_region, is_published)
         VALUES ($1, 'trade_region', $2, $3, $4, $5, $6, $7, true)`,
        [brandId, slug, title, metaDescription, content, combo.trade_id, combo.location_region]
      );
      created++;
    }
  }

  return { created, updated };
};

const runSEOGeneration = async () => {
  try {
    const brands = await db.query('SELECT id FROM brands');
    let totalCreated = 0;
    let totalUpdated = 0;

    for (const brand of brands.rows) {
      const { created, updated } = await generatePagesForBrand(brand.id);
      totalCreated += created;
      totalUpdated += updated;
      const cityJourney = await generateCityJourneyPagesForBrand(brand.id);
      totalCreated += cityJourney.created;
      totalUpdated += cityJourney.updated;
      const cityTrade = await generateCityTradePagesForBrand(brand.id);
      totalCreated += cityTrade.created;
      totalUpdated += cityTrade.updated;
      const department = await generateDepartmentPagesForBrand(brand.id);
      totalCreated += department.created;
      totalUpdated += department.updated;
    }

    logger.info(`[Job] SEO generation complete: ${totalCreated} created, ${totalUpdated} updated`);
    return { created: totalCreated, updated: totalUpdated };
  } catch (err) {
    logger.error('[Job] SEO generation failed:', err);
    return { created: 0, updated: 0 };
  }
};

export const startSEOGeneration = () => {
  // Run once daily at 04:00 (after data collection has settled)
  cron.schedule('0 4 * * *', () => {
    trackJob('seoGeneration:cron', async () => {
      logger.info('[Job] Running daily SEO page generation...');
      await runSEOGeneration();
    });
  });

  // Free-tier-host reasoning: page generation is create-or-update against
  // real current opportunity counts (see comments above), so re-running -
  // including on boot - just refreshes the same pages rather than
  // duplicating anything. Fire one pass immediately so SEO pages don't sit
  // stale until a 4am cron tick that might never come on a host that spins
  // down between requests.
  logger.info('[Job] Running an immediate SEO page generation pass on boot...');
  trackJob('seoGeneration:boot', runSEOGeneration);

  logger.info('✅ SEO generation job scheduled (daily at 04:00)');
};

export const runSEOGenerationOnce = runSEOGeneration;
