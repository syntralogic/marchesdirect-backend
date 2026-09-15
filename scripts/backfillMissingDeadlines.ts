/**
 * BACKFILL — missing deadlines on already-ingested BOAMP rows
 * ============================================================================
 * Context: client's audit flagged ~41,214 rows with no deadline at all.
 * A meaningful chunk of that is *expected*, not a bug:
 *   - DECP rows: post-award data, there is no submission deadline to have
 *     (see normalizeDecpRecord's `deadline: null` - by design).
 *   - Batiweb rows: unstructured news-feed articles, no structured deadline
 *     field exists to parse (see its normalizer, same `deadline: null`).
 * Neither of those is fixable by re-fetching, and this script does not touch
 * them.
 *
 * What IS fixable: BOAMP rows. collectBoampData's ingestion query now filters
 * on `datelimitereponse >= today` (see that comment in dataCollectionService.ts),
 * so every *newly* ingested BOAMP row already has a real deadline going
 * forward - but rows ingested before that filter existed can still be
 * sitting in the DB with deadline = NULL from the old ingestion logic.
 *
 * This re-fetches exactly those rows from BOAMP by their stable idweb
 * reference (same endpoint/fields collectBoampData already uses successfully
 * in production - nothing new or unverified here) and backfills whatever
 * BOAMP actually returns for them.
 *
 * HONESTY NOTE: boamp-datadila.opendatasoft.com is not reachable from the
 * sandbox this was written in (not on the allowed-domains list), so this has
 * NOT been run/tested end-to-end. It reuses fetchAllPages/normalizeBoampRecord/
 * updateOpportunity verbatim from the already-proven collectBoampData path -
 * same endpoint, same field names (idweb, datelimitereponse) - rather than
 * guessing anything new, but run it against a small batch first and check
 * the logged counts before trusting it against the whole backlog.
 *
 * Expected outcome for a real deployment: not every row will get a deadline
 * back. Some BOAMP notices genuinely have none - award notices, cancellation
 * notices, corrigenda - published under the same dataset without a
 * datelimitereponse either, same as DECP/Batiweb above. This script reports
 * how many it could vs couldn't backfill so that's visible rather than
 * assumed.
 */
import { db } from '../src/config/database';
import { fetchAllPages, normalizeBoampRecord, updateOpportunity } from '../src/services/dataCollectionService';
import { logger } from '../src/utils/logger';

const BOAMP_ENDPOINT = process.env.BOAMP_API_ENDPOINT
  || 'https://boamp-datadila.opendatasoft.com/api/explore/v2.1/catalog/datasets/boamp/records';
const BOAMP_API_KEY = process.env.BOAMP_API_KEY;
const BATCH_SIZE = 100;

async function run() {
  const sourceResult = await db.query(`SELECT id FROM data_sources WHERE code = 'boamp' LIMIT 1`);
  if (sourceResult.rows.length === 0) {
    logger.error('[BackfillMissingDeadlines] No data_sources row with code=boamp found - aborting.');
    process.exit(1);
  }
  const boampSourceId = sourceResult.rows[0].id;

  const rowsResult = await db.query(
    `SELECT id, source_reference FROM opportunities
     WHERE source_id = $1 AND deadline IS NULL AND deleted_at IS NULL
       AND status NOT IN ('cancelled', 'merged')`,
    [boampSourceId]
  );
  const rows: { id: string; source_reference: string }[] = rowsResult.rows;
  logger.info(`[BackfillMissingDeadlines] ${rows.length} BOAMP rows with no deadline to check.`);

  let backfilled = 0;
  let stillMissing = 0;
  let notFoundUpstream = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const idwebList = batch.map(r => `"${r.source_reference}"`).join(',');

    let fresh: any[] = [];
    try {
      fresh = await fetchAllPages(BOAMP_ENDPOINT, {
        where: `idweb in (${idwebList})`,
        ...(BOAMP_API_KEY ? { apikey: BOAMP_API_KEY } : {}),
      }, 'BOAMP-backfill');
    } catch (err) {
      logger.error(`[BackfillMissingDeadlines] Batch starting at ${i} failed to fetch, skipping:`, err);
      continue;
    }

    const byRef = new Map(fresh.map(r => normalizeBoampRecord(r)).map(n => [n.source_reference, n]));

    for (const row of batch) {
      const notice = byRef.get(row.source_reference);
      if (!notice) { notFoundUpstream++; continue; }
      if (!notice.deadline) { stillMissing++; continue; }
      await updateOpportunity(row.id, notice);
      backfilled++;
    }

    logger.info(`[BackfillMissingDeadlines] Progress: ${Math.min(i + BATCH_SIZE, rows.length)}/${rows.length} checked, ${backfilled} backfilled so far.`);
  }

  logger.info(
    `[BackfillMissingDeadlines] Done. Backfilled ${backfilled}, still no deadline upstream (award/cancelled/corrigendum notices) ${stillMissing}, no longer found upstream ${notFoundUpstream}.`
  );
  process.exit(0);
}

run().catch(err => {
  logger.error('[BackfillMissingDeadlines] Failed:', err);
  process.exit(1);
});
