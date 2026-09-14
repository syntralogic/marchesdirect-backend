/**
 * BACKFILL — clear the exact-duplicate backlog in one manual run
 * ============================================================================
 * Context: client's 8 Sep audit found ~2,670 exact-duplicate rows
 * ("strictement identiques"). mergeExactDuplicates() (deduplicationService.ts)
 * already handles this correctly, but it's only ever invoked from the
 * `deduplicateOpportunities()` cron (dataCollection.ts, every 2h) with a
 * `LIMIT 500` per call - safe for steady-state (small, incremental batches
 * on every run), but it means clearing a multi-thousand-row backlog that
 * accumulated before the fix takes several cron cycles (~6 runs / ~12h)
 * before the site stops showing already-merged duplicates as separate
 * "new" opportunities.
 *
 * This just calls the same function in a loop until it reports 0 merged in
 * a pass, so the whole backlog clears in one run instead of waiting on the
 * cron. Safe to re-run - once the backlog is clear this is a fast no-op.
 */
import { mergeExactDuplicates } from '../src/services/deduplicationService';
import { logger } from '../src/utils/logger';

async function run() {
  let total = 0;
  let pass = 0;

  while (true) {
    pass++;
    const merged = await mergeExactDuplicates();
    total += merged;
    logger.info(`[BackfillExactDuplicates] Pass ${pass}: merged ${merged} rows (total so far: ${total})`);
    if (merged === 0) break;
  }

  logger.info(`[BackfillExactDuplicates] Done. Merged ${total} exact-duplicate rows across ${pass} pass(es).`);
  process.exit(0);
}

run().catch(err => {
  logger.error('[BackfillExactDuplicates] Failed:', err);
  process.exit(1);
});
