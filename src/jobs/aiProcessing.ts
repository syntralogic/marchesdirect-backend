import cron from 'node-cron';
import { db } from '../config/database';
import { logger } from '../utils/logger';
import { classifyOpportunity, generateOpportunitySummary } from '../services/aiService';

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

// Bumped from 20: the BOAMP/DECP connectors (dataCollectionService.ts) now
// pull up to 3000 records per source per run instead of ~100, so this queue
// needs meaningfully higher throughput to keep up - at 20/15min that backlog
// alone would take days to clear, leaving most new listings showing raw
// unprocessed text (no ai_summary) the whole time. 50/15min is still well
// within a normal Claude API rate limit for sequential single-item calls.
const BATCH_SIZE = 50;
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
  // Runs every 15 minutes - frequent enough that new opportunities from a 6-hourly
  // connector run don't sit unclassified for long, without hammering the Claude API
  // continuously.
  cron.schedule('*/15 * * * *', async () => {
    await processUnclassifiedOpportunities();
    await processMissingSummaries();
  });

  logger.info('✅ AI processing scheduler started (runs every 15 minutes)');
};
