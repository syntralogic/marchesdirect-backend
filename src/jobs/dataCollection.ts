import cron from 'node-cron';
import { db } from '../config/database';
import { logger } from '../utils/logger';
import { scheduleDataCollection } from '../services/dataCollectionService';
import { deduplicateOpportunities } from '../services/deduplicationService';

// ============================================================================
// AUTOMATED DATA COLLECTION (Milestone 2 & 3)
// Runs BOAMP + any other active source (e.g. PLACE) with NO manual trigger,
// every 2-6 hours (configurable per source via data_sources.frequency_hours).
// Each run also cross-checks for duplicates across sources.
//
// AI classification/summarization of newly collected opportunities (Milestone
// 6 & 7) is NOT triggered from here - that's jobs/aiProcessing.ts's job, on
// its own 15-minute cron. An earlier version of this file also scheduled its
// own hourly classification batch, which meant two independent crons were
// pulling from the same `ai_classification_status = 'not_analyzed'` queue on
// overlapping schedules - not incorrect, but wasteful (duplicate Claude API
// calls whenever both happened to fire close together) and confusing to
// reason about. Removed here so there's exactly one job responsible for AI
// processing.
// ============================================================================

export const startScheduledJobs = () => {
  // Run collection every 2 hours; each source internally respects its own
  // frequency_hours / next_run so this just checks "is anything due".
  cron.schedule('0 */2 * * *', async () => {
    logger.info('[Job] Running scheduled data collection (all active sources)...');
    try {
      await scheduleDataCollection();

      // Extra dedup sweep across all active sources after each collection run,
      // so a listing seen on two sources in the same run gets merged immediately.
      const merged = await deduplicateOpportunities();
      logger.info(`[Job] Post-collection dedup sweep merged ${merged} pairs`);
    } catch (err) {
      logger.error('[Job] Data collection run failed:', err);
    }
  });

  // The cron above only fires at fixed clock marks (00:00, 02:00, 04:00...),
  // never "2h after the process started" - on a free-tier host that spins
  // down after ~15min idle and only wakes on an incoming HTTP request (no
  // request = no process = no chance for a cron tick to ever fire), a
  // redeploy could go a very long time before collection runs even once,
  // which is exactly why "only ~50 listings" persisted even after the
  // BOAMP fix and DECP reactivation/deactivation churn - the fixed
  // connector was simply never getting a chance to run. Fire one run
  // immediately on boot (in the background, doesn't block server startup)
  // so every deploy/restart guarantees at least one real attempt,
  // regardless of the cron schedule or host sleep behavior.
  logger.info('[Job] Running an immediate data collection pass on boot (see comment above for why)...');
  scheduleDataCollection()
    .then(() => deduplicateOpportunities())
    .then((merged) => logger.info(`[Job] Boot-time data collection pass complete, ${merged} duplicate pairs merged`))
    .catch((err) => logger.error('[Job] Boot-time data collection pass failed (non-fatal, next cron tick or restart will retry):', err));

  logger.info('✅ Data collection job scheduled (every 2h). AI classification runs separately - see jobs/aiProcessing.ts.');
};

// Manual trigger, useful for demonstrating "3 automatic runs" proof (Milestone 2)
export const runOnce = async () => {
  logger.info('[Job] Manual data collection run triggered');
  await scheduleDataCollection();
  const merged = await deduplicateOpportunities();
  return { merged };
};

export const getConnectorProof = async () => {
  const result = await db.query(
    `SELECT ds.code, ds.active, ds.last_run, ds.next_run, ds.frequency_hours,
            cl.status, cl.records_fetched, cl.records_processed, cl.started_at, cl.completed_at
     FROM data_sources ds
     LEFT JOIN LATERAL (
       SELECT * FROM connector_logs WHERE source_id = ds.id ORDER BY started_at DESC LIMIT 3
     ) cl ON true
     ORDER BY ds.code, cl.started_at DESC`
  );
  return result.rows;
};
