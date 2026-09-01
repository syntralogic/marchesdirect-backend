import axios from 'axios';
import Parser from 'rss-parser';
import { db } from '../config/database';
import { logger } from '../utils/logger';
import { deduplicateOpportunities } from './deduplicationService';
import { v4 as uuid } from 'uuid';

const parser = new Parser();

// ============================================================================
// BOAMP CONNECTOR (French Public Procurement)
// ============================================================================

export const collectBoampData = async (sourceId: number) => {
  const logId = uuid();
  const startedAt = new Date();

  try {
    logger.info(`[BOAMP] Starting collection (log: ${logId})`);

    // Real BOAMP open-data portal (Opendatasoft/DILA) - public dataset, no API key required.
    // Docs: https://boamp-datadila.opendatasoft.com/explore/dataset/boamp/
    const endpoint = process.env.BOAMP_API_ENDPOINT || 'https://boamp-datadila.opendatasoft.com/api/records/1.0/search/';
    // Optional - only needed if a higher-rate-limit / authenticated endpoint is used later.
    const apiKey = process.env.BOAMP_API_KEY;

    // Fetch data from BOAMP (last 24 hours), sorted by most recent publication first.
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const response = await axios.get(endpoint, {
      params: {
        dataset: 'boamp',
        q: `dateparution>=${since}`,
        sort: '-dateparution',
        rows: 1000,
        ...(apiKey ? { apikey: apiKey } : {}),
      },
      timeout: 30000,
    });

    const rawRecords = response.data.records || [];
    const notices = rawRecords.map(normalizeBoampRecord);
    logger.info(`[BOAMP] Fetched ${notices.length} notices`);

    // Process each notice
    let inserted = 0;
    let updated = 0;
    let errors = 0;

    for (const notice of notices) {
      try {
        const existing = await db.query(
          'SELECT id FROM opportunities WHERE source_id = $1 AND source_reference = $2',
          [sourceId, notice.source_reference]
        );

        if (existing.rows.length > 0) {
          await updateOpportunity(existing.rows[0].id, notice);
          updated++;
        } else {
          await insertOpportunity(sourceId, notice);
          inserted++;
        }
      } catch (err) {
        logger.error(`[BOAMP] Error processing notice ${notice.source_reference}:`, err);
        errors++;
      }
    }

    // Deduplicate once per batch (cross-source, e.g. BOAMP vs PLACE) - not once per record,
    // which would rescan the whole opportunities table on every single insert.
    const duplicates = await deduplicateOpportunities();

    await db.query(
      `INSERT INTO connector_logs 
        (source_id, status, records_fetched, records_processed, records_failed, started_at, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [sourceId, 'success', notices.length, inserted + updated, errors, startedAt, new Date()]
    );

    await db.query(
      "UPDATE data_sources SET last_run = NOW(), next_run = NOW() + (frequency_hours || ' hours')::interval, total_imports = total_imports + $2 WHERE id = $1",
      [sourceId, inserted]
    );

    logger.info(`[BOAMP] Collection complete: ${inserted} inserted, ${updated} updated, ${duplicates} duplicates merged`);

    return { inserted, updated, duplicates, errors };
  } catch (err) {
    logger.error(`[BOAMP] Collection failed:`, err);

    await db.query(
      `INSERT INTO connector_logs 
        (source_id, status, error_message, started_at, completed_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [sourceId, 'failed', String(err), startedAt, new Date()]
    );

    // Re-throw - scheduleDataCollection() catches this per-source so a BOAMP failure
    // never blocks PLACE/TED from running.
    throw err;
  }
};

// Normalize a raw BOAMP record (Opendatasoft "fields" object) into our internal shape.
const normalizeBoampRecord = (record: any) => {
  const f = record.fields || {};
  return {
    source_reference: record.recordid || f.idweb || f.id,
    title: f.objet || f.titulaire || 'Sans titre',
    description: f.objet || f.resume || '',
    publication_date: f.dateparution || record.record_timestamp,
    deadline: f.datelimitereponse || null,
    estimated_value: f.montant ? parseFloat(f.montant) : null,
    location_city: f.ville_avis || f.nomacheteur || null,
    location_region: f.region || null,
    location_department: f.departement || null,
    buyer_name: f.nomacheteur || null,
    raw: record,
  };
};

// ============================================================================
// PLACE CONNECTOR (French Government Platform)
// ============================================================================

export const collectPlaceData = async (sourceId: number) => {
  const logId = uuid();
  const startedAt = new Date();

  try {
    logger.info(`[PLACE] Starting collection (log: ${logId})`);

    const endpoint = process.env.PLACE_API_ENDPOINT || 'https://api.place.gouv.fr/v1/notices';
    const apiKey = process.env.PLACE_API_KEY;

    if (!apiKey) {
      throw new Error('PLACE_API_KEY not configured');
    }

    // Fetch from PLACE API
    const response = await axios.get(`${endpoint}/search`, {
      params: {
        api_key: apiKey,
        status: 'open',
        published_after: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      },
      timeout: 30000,
    });

    const notices = response.data.notices || [];
    logger.info(`[PLACE] Fetched ${notices.length} notices`);

    let inserted = 0;
    let updated = 0;
    let errors = 0;

    for (const notice of notices) {
      try {
        const existing = await db.query(
          'SELECT id FROM opportunities WHERE source_id = $1 AND source_reference = $2',
          [sourceId, notice.id]
        );

        if (existing.rows.length > 0) {
          await updateOpportunity(existing.rows[0].id, notice);
          updated++;
        } else {
          await insertOpportunity(sourceId, notice);
          inserted++;
        }
      } catch (err) {
        logger.error(`[PLACE] Error processing notice ${notice.id}:`, err);
        errors++;
      }
    }

    // Deduplicate once per batch, same as the BOAMP connector - not once per record,
    // which would rescan the whole opportunities table on every single insert.
    const duplicates = await deduplicateOpportunities();

    await db.query(
      `INSERT INTO connector_logs 
        (source_id, status, records_fetched, records_processed, records_failed, started_at, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [sourceId, 'success', notices.length, inserted + updated, errors, startedAt, new Date()]
    );

    await db.query(
      "UPDATE data_sources SET last_run = NOW(), next_run = NOW() + (frequency_hours || ' hours')::interval, total_imports = total_imports + $2 WHERE id = $1",
      [sourceId, inserted]
    );

    logger.info(`[PLACE] Collection complete: ${inserted} inserted, ${updated} updated, ${duplicates} duplicates merged`);

    return { inserted, updated, duplicates, errors };
  } catch (err) {
    logger.error(`[PLACE] Collection failed:`, err);

    await db.query(
      `INSERT INTO connector_logs 
        (source_id, status, error_message, started_at, completed_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [sourceId, 'failed', String(err), startedAt, new Date()]
    );

    throw err;
  }
};

// ============================================================================
// DECP CONNECTOR (Données Essentielles de la Commande Publique - consolidées)
// ============================================================================
// Client-recommended primary source (WhatsApp, see spec doc): aggregates
// BOAMP + every profil acheteur + PLACE into one dataset, updated near-daily.
// decp.info itself is just a datasette CSV/XLSX browser with no API of its
// own - the real underlying data lives on data.economie.gouv.fr (mirrored on
// opendatamef.opendatasoft.com), an Opendatasoft portal like BOAMP, dataset
// "decp-v3-marches-valides". Same records/1.0/search shape as BOAMP below.
//
// HONESTY NOTE ON FIELD NAMES: this sandbox's network egress doesn't include
// data.economie.gouv.fr / opendatamef.opendatasoft.com (see allowed domains),
// so the exact flattened field names below could not be verified against a
// live query from here - only that the dataset itself exists and uses the
// Opendatasoft records API (confirmed via web search of the dataset's public
// pages). The field names used are the DECP regulatory schema's own names
// (objet, montant, dateNotification, acheteur.id, titulaires[].denomination-
// Sociale - see the official schema at github.com/etalab/schema-decp), which
// Opendatasoft typically flattens with dots/underscores. normalizeDecpRecord
// tries multiple plausible flattenings per field and never throws on a
// missing one, but running one real query via the API console
// (https://opendatamef.opendatasoft.com/api-console/) and diffing the actual
// field list against the candidates below is a required step before setting
// this source's `active` to true in production - don't skip it.
export const collectDecpData = async (sourceId: number) => {
  const startedAt = new Date();

  try {
    logger.info('[DECP] Starting collection');

    const endpoint = process.env.DECP_API_ENDPOINT || 'https://opendatamef.opendatasoft.com/api/records/1.0/search/';
    const dataset = process.env.DECP_DATASET || 'decp-v3-marches-valides';
    const apiKey = process.env.DECP_API_KEY; // optional, public dataset works without one

    // DECP is award data (données de marchés déjà notifiés), not live "en
    // cours" notices - a 24h publication window is too narrow (it can take
    // buyers weeks to declare), so this pulls a rolling 30-day window on
    // whichever date field the live schema turns out to use for that.
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const response = await axios.get(endpoint, {
      params: {
        dataset,
        q: `datepublicationdonnees>=${since} OR datenotification>=${since}`,
        sort: '-datepublicationdonnees',
        rows: 1000,
        ...(apiKey ? { apikey: apiKey } : {}),
      },
      timeout: 30000,
    });

    const rawRecords = response.data.records || [];
    const notices = rawRecords.map(normalizeDecpRecord);
    logger.info(`[DECP] Fetched ${notices.length} notices`);

    let inserted = 0;
    let updated = 0;
    let errors = 0;

    for (const notice of notices) {
      try {
        const existing = await db.query(
          'SELECT id FROM opportunities WHERE source_id = $1 AND source_reference = $2',
          [sourceId, notice.source_reference]
        );

        if (existing.rows.length > 0) {
          await updateOpportunity(existing.rows[0].id, notice);
          updated++;
        } else {
          await insertOpportunity(sourceId, notice);
          inserted++;
        }
      } catch (err) {
        logger.error(`[DECP] Error processing notice ${notice.source_reference}:`, err);
        errors++;
      }
    }

    // This is the exact case the client called out for training the
    // dedup engine on: the same marché appearing on both BOAMP and the
    // buyer's own profil acheteur (both feed into DECP, or one already sits
    // in `opportunities` from the BOAMP connector above and DECP re-surfaces
    // it) - same underlying signals (buyer + montant + date + objet), just
    // slightly different labels/formats. deduplicateOpportunities() now
    // scores on all four (see deduplicationService.ts).
    const duplicates = await deduplicateOpportunities();

    await db.query(
      `INSERT INTO connector_logs 
        (source_id, status, records_fetched, records_processed, records_failed, started_at, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [sourceId, 'success', notices.length, inserted + updated, errors, startedAt, new Date()]
    );

    await db.query(
      "UPDATE data_sources SET last_run = NOW(), next_run = NOW() + (frequency_hours || ' hours')::interval, total_imports = total_imports + $2 WHERE id = $1",
      [sourceId, inserted]
    );

    logger.info(`[DECP] Collection complete: ${inserted} inserted, ${updated} updated, ${duplicates} duplicates merged`);

    return { inserted, updated, duplicates, errors };
  } catch (err) {
    logger.error('[DECP] Collection failed:', err);

    await db.query(
      `INSERT INTO connector_logs 
        (source_id, status, error_message, started_at, completed_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [sourceId, 'failed', String(err), startedAt, new Date()]
    );

    throw err;
  }
};

// Tries several plausible Opendatasoft flattenings of each DECP regulatory
// field name (see the HONESTY NOTE above) - a candidate list, not a
// confirmed schema. Returns 'not available'-style nulls rather than
// guessing when none match, same discipline as aiService's extraction.
const firstDefined = (f: Record<string, any>, keys: string[]) => {
  for (const k of keys) if (f[k] !== undefined && f[k] !== null && f[k] !== '') return f[k];
  return null;
};

const normalizeDecpRecord = (record: any) => {
  const f = record.fields || {};
  const montantRaw = firstDefined(f, ['montant', 'montant_ht', 'montantht']);
  return {
    source_reference: record.recordid || firstDefined(f, ['id', 'uid']),
    title: firstDefined(f, ['objet']) || 'Marché public (DECP)',
    description: firstDefined(f, ['objet']) || '',
    publication_date: firstDefined(f, ['datepublicationdonnees', 'datenotification']) || record.record_timestamp,
    deadline: null, // DECP is post-award data - there is no submission deadline to capture, unlike BOAMP/PLACE
    estimated_value: montantRaw ? parseFloat(montantRaw) : null,
    location_city: firstDefined(f, ['lieuexecution_nom', 'acheteur_nom']),
    location_region: firstDefined(f, ['lieuexecution_code_region', 'region']),
    location_department: firstDefined(f, ['lieuexecution_departement', 'departement']),
    buyer_name: firstDefined(f, ['acheteur_nom', 'nomacheteur', 'denominationacheteur']),
    raw: record,
  };
};

// ============================================================================
// BATIWEB CONNECTOR (regional construction news/marchés - free access section)
// ============================================================================
// Client-identified as concretely scrapable right now without touching any
// paywalled competitor platform: Batiweb's actualités/marchés section is
// public, no login. This is an RSS-based first pass (lower legal/technical
// risk than HTML scraping, and Batiweb - like most news sites - publishes
// one) rather than a full HTML scraper.
//
// HONESTY NOTE: batiweb.com is not reachable from this sandbox's network
// egress allowlist, so the exact feed URL and item field names below are the
// standard Batiweb structure as documented publicly, not verified live from
// here. Confirm the feed URL resolves and actually contains marché/appel
// d'offres items (vs. general construction news) before flipping this
// source `active` in production - that's why it seeds inactive.
// LEGAL NOTE: re-check Batiweb's robots.txt and CGU before enabling on a
// schedule, even for a page that's freely accessible without login -
// "no login required" and "no restriction on automated access" are not the
// same thing, and this hasn't been reconciled against their current terms.
export const collectBatiwebData = async (sourceId: number) => {
  const startedAt = new Date();

  try {
    logger.info('[Batiweb] Starting collection');

    const feedUrl = process.env.BATIWEB_FEED_URL || 'https://www.batiweb.com/rss/actualites.xml';
    const feed = await parser.parseURL(feedUrl);
    logger.info(`[Batiweb] Fetched ${feed.items?.length || 0} items`);

    let inserted = 0;
    let updated = 0;
    let errors = 0;
    let skippedNonTender = 0;

    for (const item of feed.items || []) {
      try {
        const text = `${item.title || ''} ${item.contentSnippet || item.content || ''}`.toLowerCase();
        // Batiweb's general news feed mixes product launches, opinion pieces,
        // etc. with actual marché/appel d'offres announcements - only the
        // latter are opportunities. Keyword-filter rather than ingesting
        // everything as a fake "opportunity".
        const looksLikeTender = /marché|appel d.offres|consultation|avis de|attribu/i.test(text);
        if (!looksLikeTender) { skippedNonTender++; continue; }

        const ref = item.guid || item.link;
        const existing = await db.query(
          'SELECT id FROM opportunities WHERE source_id = $1 AND source_reference = $2',
          [sourceId, ref]
        );

        const opportunity = {
          source_reference: ref,
          title: item.title || '',
          description: item.contentSnippet || item.content || '',
          publication_date: item.isoDate ? new Date(item.isoDate) : new Date(),
          deadline: null,
          // A news article almost never states a structured buyer/amount -
          // that needs the AI extraction pass (extractOpportunityFacts) on
          // the article body afterwards, same as any other private-tender
          // source with unstructured source text.
          buyer_name: null,
          raw: item,
        };

        if (existing.rows.length > 0) {
          await updateOpportunity(existing.rows[0].id, opportunity);
          updated++;
        } else {
          await insertOpportunity(sourceId, opportunity);
          inserted++;
        }
      } catch (err) {
        logger.error('[Batiweb] Error processing item:', err);
        errors++;
      }
    }

    const duplicates = await deduplicateOpportunities();

    await db.query(
      `INSERT INTO connector_logs 
        (source_id, status, records_fetched, records_processed, records_failed, started_at, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [sourceId, 'success', feed.items?.length || 0, inserted + updated, errors, startedAt, new Date()]
    );

    await db.query(
      "UPDATE data_sources SET last_run = NOW(), next_run = NOW() + (frequency_hours || ' hours')::interval, total_imports = total_imports + $2 WHERE id = $1",
      [sourceId, inserted]
    );

    logger.info(`[Batiweb] Collection complete: ${inserted} inserted, ${updated} updated, ${skippedNonTender} non-tender items skipped, ${duplicates} duplicates merged`);

    return { inserted, updated, duplicates, errors, skippedNonTender };
  } catch (err) {
    logger.error('[Batiweb] Collection failed:', err);

    await db.query(
      `INSERT INTO connector_logs 
        (source_id, status, error_message, started_at, completed_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [sourceId, 'failed', String(err), startedAt, new Date()]
    );

    throw err;
  }
};

// ============================================================================
// TED CONNECTOR (EU Tenders)
// ============================================================================

export const collectTedData = async (sourceId: number) => {
  const startedAt = new Date();

  try {
    logger.info(`[TED] Starting collection`);

    const xmlFeed = 'https://ted.europa.eu/TedRss.do?search=&templateId=0';

    const feed = await parser.parseURL(xmlFeed);
    logger.info(`[TED] Fetched ${feed.items?.length || 0} tenders`);

    let inserted = 0;
    let updated = 0;
    let errors = 0;

    for (const item of feed.items || []) {
      try {
        const tedId = item.guid || item.link;

        const existing = await db.query(
          'SELECT id FROM opportunities WHERE source_id = $1 AND source_reference = $2',
          [sourceId, tedId]
        );

        const opportunity = {
          title: item.title || '',
          description: item.content || item.summary || '',
          deadline: item.isoDate ? new Date(item.isoDate) : null,
          source_reference: tedId,
          opportunity_type: 'public_procurement',
          location_region: 'EU',
        };

        if (existing.rows.length > 0) {
          await updateOpportunity(existing.rows[0].id, opportunity);
          updated++;
        } else {
          await insertOpportunity(sourceId, opportunity);
          inserted++;
        }
      } catch (err) {
        logger.error(`[TED] Error processing item:`, err);
        errors++;
      }
    }

    // Deduplicate once per batch, same as BOAMP/PLACE.
    const duplicates = await deduplicateOpportunities();

    await db.query(
      `INSERT INTO connector_logs 
        (source_id, status, records_fetched, records_processed, records_failed, started_at, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [sourceId, 'success', feed.items?.length || 0, inserted + updated, errors, startedAt, new Date()]
    );

    await db.query(
      "UPDATE data_sources SET last_run = NOW(), next_run = NOW() + (frequency_hours || ' hours')::interval, total_imports = total_imports + $2 WHERE id = $1",
      [sourceId, inserted]
    );

    logger.info(`[TED] Collection complete: ${inserted} inserted, ${updated} updated, ${duplicates} duplicates merged`);

    return { inserted, updated, duplicates, errors };
  } catch (err) {
    logger.error(`[TED] Collection failed:`, err);

    await db.query(
      `INSERT INTO connector_logs 
        (source_id, status, error_message, started_at, completed_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [sourceId, 'failed', String(err), startedAt, new Date()]
    );

    throw err;
  }
};

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

const insertOpportunity = async (sourceId: number, data: any) => {
  const result = await db.query(
    `INSERT INTO opportunities 
      (source_id, source_reference, title, description, publication_date, deadline, 
       estimated_value, location_city, location_region, location_department, buyer_name, opportunity_type_id, 
       raw_data, ai_classification_status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
       (SELECT id FROM opportunity_types WHERE code = 'public_procurement'),
       $12, 'not_analyzed')
     RETURNING id`,
    [
      sourceId,
      data.source_reference || data.boamp_ref || data.id,
      data.title,
      data.description,
      data.publication_date || new Date(),
      data.deadline,
      data.estimated_value,
      data.location_city,
      data.location_region || data.region,
      data.location_department || null,
      // PLACE/TED feeds don't reliably expose a distinct buyer field the
      // way BOAMP's `nomacheteur` does - null there rather than a guess.
      data.buyer_name || data.organism || null,
      JSON.stringify(data.raw || data), // raw_data - keep original source payload for audit
    ]
  );

  return result.rows[0];
};

const updateOpportunity = async (opportunityId: string, data: any) => {
  // Only touch fields that legitimately change between runs (deadline extensions, cancellations,
  // corrected values); title/publication_date/source_reference stay immutable once ingested.
  await db.query(
    `UPDATE opportunities 
     SET description = $1, deadline = $2, estimated_value = $3, raw_data = $4, updated_at = NOW()
     WHERE id = $5`,
    [
      data.description,
      data.deadline,
      data.estimated_value,
      JSON.stringify(data.raw || data),
      opportunityId,
    ]
  );
};

// ============================================================================
// SCHEDULE COLLECTION JOBS
// ============================================================================

export const scheduleDataCollection = async () => {
  logger.info('Scheduling data collection jobs...');

  // Only collect from sources that are actually due, per that source's own
  // frequency_hours (next_run is set after each successful run above). The
  // outer cron in jobs/dataCollection.ts fires every 2 hours as a "check if
  // anything is due" tick, not "collect everything every 2 hours" - without
  // this filter, a source configured for e.g. 12-hourly collection (TED) would
  // get hit every 2 hours anyway, wasting calls against that source's real
  // rate limits and ignoring the per-source frequency_hours config entirely.
  const sources = await db.query(
    `SELECT * FROM data_sources WHERE active = true AND (next_run IS NULL OR next_run <= NOW())`
  );

  if (sources.rows.length === 0) {
    logger.info('No sources due for collection right now.');
    return;
  }

  for (const source of sources.rows) {
    try {
      switch (source.code) {
        case 'boamp':
          await collectBoampData(source.id);
          break;
        case 'decp':
          await collectDecpData(source.id);
          break;
        case 'place':
          await collectPlaceData(source.id);
          break;
        case 'ted':
          await collectTedData(source.id);
          break;
        case 'batiweb':
          await collectBatiwebData(source.id);
          break;
        default:
          logger.warn(`Unknown source type: ${source.code}`);
      }
    } catch (err) {
      logger.error(`Failed to collect from ${source.code}:`, err);
    }
  }
};
