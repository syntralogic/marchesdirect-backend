/**
 * STALE SUMMARY BACKFILL JOB — automatic version of the admin HTTP route
 * =========================================================================
 * Client feedback (7 Sep screenshot): ai_summary was hundreds of words
 * long with its own section headers, from before the prompt was tightened
 * to "2 à 4 phrases, 120 mots max". The prompt fix only affects summaries
 * generated from here on - it does nothing for the already-generated,
 * verbose rows already sitting in the database, and admin.ts's
 * /regenerate-stale-summaries route requires someone to actually call it.
 * Client's ask: this should just happen without anyone needing to do
 * anything (no Render Shell on the free tier anyway).
 *
 * Kept deliberately small per run - this calls the paid Claude API once
 * per row, same cost-consciousness as jobs/factsBackfillJob.ts after the
 * client asked to throttle that one down.
 */

import { db } from '../config/database';
import { generateOpportunitySummary } from '../services/aiService';
import { logger } from '../utils/logger';

// Same >500-char heuristic as the admin route: the new prompt's own token
// budget makes it physically incapable of producing that many characters,
// so this can only match rows written under the old, more permissive one.
const STALE_SUMMARY_QUERY = `SELECT id FROM opportunities WHERE LENGTH(ai_summary) > 500 ORDER BY updated_at DESC LIMIT $1`;

export async function runStaleSummaryBackfillBatch(batchSize = 10): Promise<{ regenerated: number; failed: number }> {
  let rows: { id: string }[];
  try {
    const result = await db.query(STALE_SUMMARY_QUERY, [batchSize]);
    rows = result.rows;
  } catch (err) {
    logger.error('[Job] Stale summary backfill query failed:', err);
    return { regenerated: 0, failed: 0 };
  }

  if (rows.length === 0) {
    logger.info('[Job] Stale summary backfill: nothing outstanding.');
    return { regenerated: 0, failed: 0 };
  }

  let regenerated = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      await generateOpportunitySummary(row.id);
      regenerated++;
    } catch (err) {
      failed++;
      logger.warn(`[Job] Stale summary regeneration failed for ${row.id}: ${(err as any)?.message || err}`);
    }
  }
  logger.info(`[Job] Stale summary backfill run complete: ${regenerated} regenerated, ${failed} failed (remainder picks up next run).`);
  return { regenerated, failed };
}

export const startStaleSummaryBackfillJob = () => {
  const cron = require('node-cron');

  setTimeout(() => {
    runStaleSummaryBackfillBatch().catch(err => logger.error('[Job] Boot-time stale summary backfill failed (non-fatal):', err));
  }, 30_000);

  // Every hour, small batch - a paid Claude call per row, so deliberately
  // slower/cheaper than the free bulk-SQL backfills (facts/location-region).
  cron.schedule('0 * * * *', () => {
    runStaleSummaryBackfillBatch().catch(err => logger.error('[Job] Scheduled stale summary backfill failed (non-fatal):', err));
  });

  logger.info('✅ Stale summary backfill job scheduled (batch of 10 on boot, then hourly)');
};
