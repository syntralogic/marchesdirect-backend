/**
 * FACTS BACKFILL JOB — automatic version of scripts/backfillOpportunityFacts.ts
 * ============================================================================
 * Context: on Render's free tier there is no shell access, so the manual
 * `npx ts-node scripts/backfillOpportunityFacts.ts --yes` from DEPLOY.md
 * can't actually be run by hand. This wraps the same query + reprocessing
 * logic so it can run on its own, the same way jobs/searchIndexRefresh.ts
 * already does: once automatically on server boot, and on a schedule after
 * that, so straggler/broken records (e.g. key_risks.value saved as a bare
 * string instead of an array - see aiService.ts's sanitization fix) get
 * fixed without anyone needing to SSH in.
 *
 * CAPPED PER RUN (BATCH_SIZE): a free-tier instance can spin down on idle
 * and cold-start often, so this deliberately does NOT try to process every
 * outstanding opportunity in one go - that could mean a large, unbounded
 * LLM bill triggered by a single boot. Instead it processes a small batch
 * each run and picks up the rest on the next scheduled run/boot - safe
 * because the underlying query is idempotent (already-fixed rows just stop
 * matching it).
 */

import { db } from '../config/database';
import { extractOpportunityFacts } from '../services/aiService';
import { logger } from '../utils/logger';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Same detection query as scripts/backfillOpportunityFacts.ts - kept in
// sync manually since the script also needs its own confirm-prompt/summary
// output, which doesn't belong in an unattended job.
const NEEDS_BACKFILL_QUERY = `
  SELECT id, title FROM opportunities
  WHERE deleted_at IS NULL
    AND (
      ai_extracted_facts IS NULL
      OR ai_extracted_facts->'team_size_estimate' IS NULL
      OR ai_extracted_facts->'key_risks' IS NULL
      OR jsonb_typeof(ai_extracted_facts->'key_risks'->'value'->0) = 'string'
      OR jsonb_typeof(ai_extracted_facts->'key_risks'->'value') NOT IN ('array')
    )
  ORDER BY created_at DESC
  LIMIT $1
`;

export async function runFactsBackfillBatch(batchSize = 25, delayMs = 500) {
  let rows: { id: string; title: string }[];
  try {
    const result = await db.query(NEEDS_BACKFILL_QUERY, [batchSize]);
    rows = result.rows;
  } catch (err: any) {
    logger.error('[Job] Facts backfill query failed:', err);
    return { processed: 0, succeeded: 0, failed: 0 };
  }

  if (rows.length === 0) {
    logger.info('[Job] Facts backfill: nothing outstanding.');
    return { processed: 0, succeeded: 0, failed: 0 };
  }

  logger.info(`[Job] Facts backfill: processing ${rows.length} opportunit${rows.length === 1 ? 'y' : 'ies'} this run.`);

  let succeeded = 0;
  let failed = 0;
  for (let i = 0; i < rows.length; i++) {
    const { id, title } = rows[i];
    try {
      await extractOpportunityFacts(id);
      succeeded++;
    } catch (err: any) {
      failed++;
      logger.warn(`[Job] Facts backfill failed for ${id} (${String(title).slice(0, 60)}): ${err?.message || err}`);
    }
    if (i < rows.length - 1) await sleep(delayMs);
  }

  logger.info(`[Job] Facts backfill run complete: ${succeeded} succeeded, ${failed} failed (any remainder picks up next run).`);
  return { processed: rows.length, succeeded, failed };
}

export const startFactsBackfillJob = () => {
  const cron = require('node-cron');

  // Once on boot, a few seconds after the process actually comes up, so it
  // doesn't compete with the search-index-refresh boot call above for the
  // DB connection pool at the exact same instant.
  setTimeout(() => {
    runFactsBackfillBatch().catch(err => logger.error('[Job] Boot-time facts backfill failed (non-fatal):', err));
  }, 10_000);

  // Then once a day - small, cheap batches rather than one big sweep, and
  // it naturally catches any new opportunity whose extraction comes back
  // malformed in the future too, not just today's known-bad rows.
  cron.schedule('0 3 * * *', () => {
    runFactsBackfillBatch().catch(err => logger.error('[Job] Scheduled facts backfill failed (non-fatal):', err));
  });

  logger.info('✅ Facts backfill job scheduled (batch of 25 on boot, then daily at 03:00)');
};
