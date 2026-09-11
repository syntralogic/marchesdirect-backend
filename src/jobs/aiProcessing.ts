import cron from 'node-cron';
import { db } from '../config/database';
import { logger } from '../utils/logger';
import { classifyOpportunity, generateOpportunitySummary } from '../services/aiService';
import { trackJob } from '../utils/jobTracker';

// ============================================================================
// BATCH AI PROCESSING (MILESTONE 6-7)
// ============================================================================
// The connectors (dataCollectionService.ts) insert opportunities with
// ai_classification_status = 'not_analyzed'. Until now nothing ever moved
// them out of that state automatically - classifyOpportunity() only ran if
// something called POST /api/opportunities/:id/classify by hand, so on real
// data every listing would sit at "Not analyzed" forever, which is exactly
// what Milestone 6's acceptance criteria says must NOT happen.
//
// This job picks up unclassified/unsummarized opportunities in small batches
// and processes them. Small batches + a short pause between each call is
// deliberate: each opportunity is a real Claude API call, so this avoids
// bursting past rate limits when a connector run just inserted hundreds of
// records at once.

// Bumped again (client feedback: secteur/métier filters like "Peinture"
// showing far fewer results than the real total) - trade_id (what those
// filters match on) is only ever set by classifyOpportunity() below, and
// at the previous 50/15min pace, classifying a 47k-row backlog would take
// roughly 10 days - the vast majority of listings would sit with no
// trade_id, invisible to any métier filter, for well over a week. This is
// a real paid Claude API call per row (unlike the free bulk-UPDATE region
// backfill), so scaled up more conservatively than that one: 3x the batch
// size and 3x the frequency (~9x combined throughput) rather than blasting
// the whole backlog in one go - roughly a day to clear instead of ten,
// while staying comfortably inside normal rate limits at 2 calls/sec max
// (500ms delay, unchanged).
// Cost fix (11 Sep, client flagged AI spend running too high): this was
// bumped to 150/5min (~3,600 combined classify+summary calls/hour) to clear
// a 47k-row one-time backlog in about a day. That throughput is what was
// actually driving spend, not any single call's cost - each call itself is
// already on Haiku with a trimmed raw_data context (see
// extractRawDataContext in aiService.ts). Dialed back down to a sustainable
// steady-state pace: the backlog clears slower, but a live site only ever
// adds a handful of new opportunities per connector run (see
// dataCollectionService.ts), so this rate is what matters for cost going
// forward, not backlog-clearing speed. Re-bump temporarily (as before) only
// for another genuine one-time backlog, not as the permanent setting.
const BATCH_SIZE = 40;
const DELAY_BETWEEN_CALLS_MS = 500;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const processUnclassifiedOpportunities = async () => {
  try {
    const result = await db.query(
      `SELECT id FROM opportunities
       WHERE ai_classification_status IN ('not_analyzed', 'failed')
         AND deleted_at IS NULL
       ORDER BY created_at ASC
       LIMIT $1`,
      [BATCH_SIZE]
    );

    if (result.rows.length === 0) {
      logger.debug('[aiProcessing] No unclassified opportunities pending');
      return { classified: 0, failed: 0 };
    }

    logger.info(`[aiProcessing] Classifying ${result.rows.length} opportunities...`);

    let classified = 0;
    let failed = 0;

    for (const row of result.rows) {
      const ok = await classifyOpportunity(row.id);
      if (ok) classified++;
      else failed++;
      await sleep(DELAY_BETWEEN_CALLS_MS);
    }

    logger.info(`[aiProcessing] Batch done: ${classified} classified, ${failed} failed`);
    return { classified, failed };
  } catch (err) {
    logger.error('[aiProcessing] Classification batch error:', err);
    return { classified: 0, failed: 0 };
  }
};

export const processMissingSummaries = async () => {
  try {
    const result = await db.query(
      `SELECT id FROM opportunities
       WHERE ai_classification_status = 'classified'
         AND (ai_summary IS NULL OR ai_summary_status = 'not_generated')
         AND deleted_at IS NULL
       ORDER BY created_at ASC
       LIMIT $1`,
      [BATCH_SIZE]
    );

    if (result.rows.length === 0) {
      logger.debug('[aiProcessing] No summaries pending');
      return { generated: 0 };
    }

    logger.info(`[aiProcessing] Generating ${result.rows.length} summaries...`);

    let generated = 0;
    for (const row of result.rows) {
      try {
        await generateOpportunitySummary(row.id);
        generated++;
      } catch (err) {
        logger.error(`[aiProcessing] Summary failed for ${row.id}:`, err);
      }
      await sleep(DELAY_BETWEEN_CALLS_MS);
    }

    logger.info(`[aiProcessing] Summary batch done: ${generated} generated`);
    return { generated };
  } catch (err) {
    logger.error('[aiProcessing] Summary batch error:', err);
    return { generated: 0 };
  }
};

export const startAIProcessing = () => {
  // Cost fix (11 Sep): was */5 * * * * (every 5 min) to burn through the
  // backlog fast for go-live. Dialed back to every 15 min at the smaller
  // BATCH_SIZE above - see that comment for the reasoning.
  cron.schedule('*/15 * * * *', async () => {
    await trackJob('aiProcessing:cron', async () => {
      await processUnclassifiedOpportunities();
      await processMissingSummaries();
    });
  });

  // Same reasoning as dataCollection.ts's boot-time run: on a free-tier host
  // that spins down after idle and only wakes on an incoming HTTP request, a
  // fixed-clock cron (*/15 * * * *) may never get a chance to fire between
  // deploys/restarts - a listing collected by the boot-time data-collection
  // pass could sit at ai_classification_status='not_analyzed' (no ai_summary,
  // detail page shows only the raw title/description) indefinitely, since
  // nothing else ever triggers classification. Run one pass immediately on
  // boot, in the background, so every deploy/restart guarantees at least one
  // real attempt at clearing the backlog, same as the data collection job.
  logger.info('[Job] Running an immediate AI processing pass on boot (see comment above for why)...');
  trackJob('aiProcessing:boot', () =>
    processUnclassifiedOpportunities()
      .then(() => processMissingSummaries())
      .then(() => logger.info('[Job] Boot-time AI processing pass complete'))
  ).catch((err) => logger.error('[Job] Boot-time AI processing pass failed (non-fatal, next cron tick or restart will retry):', err));

  logger.info('✅ AI processing scheduler started (runs every 5 minutes)');
};
