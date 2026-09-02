import axios from 'axios';
import Parser from 'rss-parser';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pipeline } from 'stream/promises';
import { db } from '../config/database';
import { logger } from '../utils/logger';
import { deduplicateOpportunities } from './deduplicationService';
import { v4 as uuid } from 'uuid';

// v2.1 caps each request at 100 records - a real collection run needs to
// page through `offset` to get anywhere near the "several thousand, even
// tens of thousands" volume the client explicitly asked for (WhatsApp:
// testing the actual UX needs real content, not ~50 rows). Capped at
// MAX_RECORDS_PER_RUN rather than looping until total_count is exhausted so
// one run can't accidentally pull the entire multi-million-row BOAMP
// dataset and blow through rate limits / run for hours - subsequent runs
// (every 6h for BOAMP, 24h for DECP per data_sources.frequency_hours) keep
// working through the backlog day over day.
const PAGE_SIZE = 100;
const MAX_RECORDS_PER_RUN = 3000;

async function fetchAllPages(endpoint: string, baseParams: Record<string, unknown>, label: string): Promise<any[]> {
  const all: any[] = [];
  let offset = 0;
  while (all.length < MAX_RECORDS_PER_RUN) {
    const response = await axios.get(endpoint, {
      params: { ...baseParams, limit: PAGE_SIZE, offset },
      timeout: 30000,
    });
    const page = response.data.results || [];
    all.push(...page);
    const totalCount = response.data.total_count ?? all.length;
    logger.info(`[${label}] Fetched page at offset ${offset}: ${page.length} records (${all.length}/${totalCount} so far)`);
    if (page.length < PAGE_SIZE || all.length >= totalCount) break; // no more pages
    offset += PAGE_SIZE;
  }
  return all.slice(0, MAX_RECORDS_PER_RUN);
}

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
    // Verified working (Feb 2026 community source list): this dataset has
    // 1.68M+ notices with same-day data on the v2.1 Explore API. The old v1
    // endpoint (/api/records/1.0/search/) this used to hit is Opendatasoft's
    // legacy API - v2.1 is what's documented as "stable and production
    // ready" going forward, with a different query language (ODSQL: `where`/
    // `order_by` instead of `q`/`sort`) and response shape (fields flat on
    // each result object, not nested under `.fields`).
    // Docs: https://boamp-datadila.opendatasoft.com/api/explore/v2.1/console
    const endpoint = process.env.BOAMP_API_ENDPOINT
      || 'https://boamp-datadila.opendatasoft.com/api/explore/v2.1/catalog/datasets/boamp/records';
    // Optional - only needed if a higher-rate-limit / authenticated endpoint is used later.
    const apiKey = process.env.BOAMP_API_KEY;

    // Filters on the actual submission deadline (datelimitereponse), not
    // publication date. This was previously filtering on publication date
    // within a 180-day window - but BOAMP deadlines typically land 3-8
    // weeks *after* publication, so the "180 days back" backfill window
    // mostly pulled in notices whose deadline had already elapsed by the
    // time they were ingested, which then got immediately hidden again by
    // the "filter expired opportunities out of search" fix (see
    // opportunities.ts) - the two fixes were silently fighting each other,
    // which is exactly why the listing count stayed low despite both
    // changes. Filtering on deadline directly instead means everything
    // ingested is, by construction, still open right now - solves "too few
    // listings" and "no expired ones showing" at the same time, and there's
    // no reason to cap this to a rolling window at all: every open BOAMP
    // notice across all of France/every sector is fair game up to the
    // MAX_RECORDS_PER_RUN safety cap.
    const today = new Date().toISOString().slice(0, 10);

    const rawRecords = await fetchAllPages(endpoint, {
      where: `datelimitereponse >= date'${today}'`,
      order_by: 'datelimitereponse',
      ...(apiKey ? { apikey: apiKey } : {}),
    }, 'BOAMP');

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

// Normalize a raw BOAMP record into our internal shape. v2.1's records
// endpoint returns fields flat on the result object directly (v1 nested
// them under `record.fields`), and has no `recordid` wrapper - `idweb` is
// BOAMP's own stable notice identifier, used here as the primary key.
//
// buyer_name tries several field-name candidates (see firstDefined below,
// shared with the DECP normalizer) rather than only `nomacheteur` - BOAMP
// covers many notice/procedure types and not all of them populate that
// exact field. A real case this was missing: a notice whose buyer name
// only showed up in `ville_avis` (BOAMP's own city field, seemingly
// mis-populated with the institution's name for that notice) while
// `nomacheteur` was empty - the public-market fiche then had to fall back
// to a generic "Acheteur public" label despite the law requiring the real
// name be shown. Public-transparency correctness matters more here than
// on private sources, so this tries harder before giving up.
const normalizeBoampRecord = (record: any) => {
  const f = record.fields ? record.fields : record; // tolerate either shape
  const buyerName = firstDefined(f, ['nomacheteur', 'denominationacheteur', 'acheteur_nom', 'nom_acheteur']);
  return {
    source_reference: f.idweb || f.id || record.recordid,
    title: f.objet || f.titulaire || 'Sans titre',
    description: f.objet || f.resume || '',
    publication_date: f.dateparution || record.record_timestamp,
    deadline: f.datelimitereponse || null,
    estimated_value: f.montant ? parseFloat(f.montant) : null,
    // ville_avis is a real city field and stays the primary source for
    // location - buyerName is still an available last-resort fallback for
    // display purposes only (better than nothing), same as before.
    location_city: f.ville_avis || buyerName || null,
    location_region: f.region || null,
    location_department: f.departement || null,
    buyer_name: buyerName,
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
//
// REWRITTEN from an Opendatasoft records-API approach (deactivated in a
// prior commit) after confirming - by actually fetching the live dataset
// page at data.gouv.fr, not guessing - that:
//   1. decp-2022-marches-valides (the old target) is frozen/deprecated since
//      Nov 2023. Since Jan 2024, DECP moved to per-buyer files on
//      data.gouv.fr, consolidated daily into one file by Colin Maudry's
//      decp-processing project (github.com/ColinMaudry/decp-processing,
//      published as decp.info) - there is no small query-able records API
//      for the *current* data; JSON tabular access is only offered via a
//      PAID subscription (colibre.fr), which isn't something to sign up
//      for/pay for on the client's behalf without them deciding that.
//   2. The consolidated file itself IS free and public, just large: 234MB
//      Parquet / 2.4GB CSV, resource id 22847056-61df-452d-837d-8b8ceadbfc52
//      on dataset donnees-essentielles-de-la-commande-publique-consolidees-
//      format-tabulaire. Parquet is the practical one to actually download.
//   3. The dataset page documents its own real columns (this is NOT a
//      guess): uid, id, acheteur_id (buyer SIRET - uid is acheteur_id + id
//      concatenated), objet, montant, dureeMois, dateNotification,
//      datePublicationDonnees, codeCPV, nature, procedure, formePrix, url,
//      modification_id, donneesActuelles (bool - true only for a marché's
//      latest version, since one marché can have multiple rows across
//      amendments), and titulaire_* (winner company) columns. The
//      objet/montant/dateNotification/codeCPV/nature/procedure/formePrix/url
//      set is independently confirmed by a separate official Etalab
//      hackathon file schema for the same regulatory data
//      (marche.csv: codeCPV, dateNotification, datePublicationDonnees,
//      dureeMois, formePrix, id, montant, nature, objet, procedure, uid,
//      url) - two independent official sources agreeing is about as
//      confident as this can get without a live test query, which this
//      sandbox's network egress can't do (data.gouv.fr isn't reachable from
//      bash_tool here).
//
// hyparquet (pure JS, no native deps - safe for Render) reads the file.
// Given real uncertainty about exact production behavior (234MB download
// time/memory on the actual Render instance, whether column names have any
// casing/accent quirk the two schema sources didn't capture), this source
// is intentionally left `active: false` after this commit too - flip it on
// and watch its first connector_logs row closely before trusting it
// unattended, same caution as every other "found via search, not tested
// live" fix in this file.
async function downloadDecpParquet(url: string): Promise<string> {
  const tmpPath = path.join(os.tmpdir(), `decp-${Date.now()}.parquet`);
  const response = await axios.get(url, { responseType: 'stream', timeout: 300000 }); // 5min - 234MB over a slow link needs real headroom
  await pipeline(response.data, fs.createWriteStream(tmpPath));
  return tmpPath;
}

export const collectDecpData = async (sourceId: number) => {
  const startedAt = new Date();
  let tmpPath: string | null = null;

  try {
    logger.info('[DECP] Starting collection (downloading consolidated Parquet file - this can take a few minutes)');

    const fileUrl = process.env.DECP_PARQUET_URL
      || 'https://www.data.gouv.fr/api/1/datasets/r/11cea8e8-df3e-4ed1-932b-781e2635e432';

    tmpPath = await downloadDecpParquet(fileUrl);
    logger.info(`[DECP] Downloaded to ${tmpPath}, parsing...`);

    // @ts-expect-error - tsconfig's moduleResolution:"node" doesn't resolve
    // package.json `exports` subpaths for type-checking even though this
    // resolves fine at runtime (verified: node_modules/hyparquet/types/node.d.ts
    // exists). Not fixing via tsconfig since this DECP rewrite is paused
    // (client's ask - see data_sources.active=false note above) and a
    // moduleResolution change could affect unrelated imports project-wide.
    const { asyncBufferFromFile, parquetReadObjects } = await import('hyparquet/node');
    const file = await asyncBufferFromFile(tmpPath);
    const rows = await parquetReadObjects({
      file,
      columns: [
        'uid', 'id', 'acheteur_id', 'objet', 'montant', 'dureeMois',
        'dateNotification', 'datePublicationDonnees', 'codeCPV', 'nature',
        'procedure', 'formePrix', 'url', 'donneesActuelles',
      ],
    }) as any[];
    logger.info(`[DECP] Parsed ${rows.length} total rows from Parquet file`);

    // Same 180-day backfill window as BOAMP's original intent (client's
    // "several thousand, even tens of thousands" ask), but DECP is
    // post-award data with no submission deadline, so there's no BOAMP-style
    // "expired filter conflict" to worry about here - a wide recency window
    // is safe. donneesActuelles filters out superseded amendment rows so
    // the same marché isn't inserted multiple times for each modification.
    const since = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000);
    const recent = rows.filter(r => {
      if (r.donneesActuelles === false) return false;
      const pubDate = r.datePublicationDonnees ? new Date(r.datePublicationDonnees) : null;
      const notifDate = r.dateNotification ? new Date(r.dateNotification) : null;
      return (pubDate && pubDate >= since) || (notifDate && notifDate >= since);
    }).slice(0, MAX_RECORDS_PER_RUN);
    logger.info(`[DECP] ${recent.length} rows within the last 180 days after filtering`);

    const notices = recent.map(normalizeDecpRecord);

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
  } finally {
    // Always clean up the downloaded file, success or failure - a 234MB
    // temp file left behind on every run would fill up disk fast.
    if (tmpPath) {
      fs.unlink(tmpPath, () => {});
    }
  }
};

// Tries several plausible Opendatasoft flattenings of each DECP regulatory
// field name (see the HONESTY NOTE above) - a candidate list, not a
// confirmed schema. Returns 'not available'-style nulls rather than
// guessing when none match, same discipline as aiService's extraction.
// "CDL" is DECP's own literal sentinel for a missing/not-declared value
// (confirmed live - see collectDecpData's sourcing note above), not an
// Opendatasoft or project convention - filtered out here alongside the
// usual null/undefined/empty-string checks so it never leaks into
// opportunities as a fake city or buyer name.
const firstDefined = (f: Record<string, any>, keys: string[]) => {
  for (const k of keys) if (f[k] !== undefined && f[k] !== null && f[k] !== '' && f[k] !== 'CDL') return f[k];
  return null;
};

// v2.1 returns fields flat on the result object directly (v1 nested them
// under `record.fields`) - same shape change as normalizeBoampRecord above.
// Field names below are the real, confirmed Parquet column names (see the
// sourcing note on collectDecpData above) - not Opendatasoft-flattened
// guesses like the old version of this function used.
const normalizeDecpRecord = (record: any) => {
  return {
    source_reference: record.uid || record.id,
    title: record.objet || 'Marché public (DECP)',
    description: record.objet || '',
    publication_date: record.datePublicationDonnees || record.dateNotification || null,
    deadline: null, // DECP is post-award data - there is no submission deadline to capture, unlike BOAMP/PLACE
    estimated_value: record.montant != null ? parseFloat(record.montant) : null,
    // No location/buyer-name column is confirmed on this file (only
    // acheteur_id, the buyer's raw SIRET) - left null rather than guessing
    // wrong field names again. A future pass could resolve acheteur_id to a
    // real buyer name/city via the same Pappers lookup already built for
    // company SIRET recognition (siret.ts), since a buyer SIRET resolves
    // the same way a company one does.
    location_city: null,
    location_region: null,
    location_department: null,
    buyer_name: null,
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
