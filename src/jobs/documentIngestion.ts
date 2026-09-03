import cron from 'node-cron';
import { logger } from '../utils/logger';
import { runPendingDocumentIngestion } from '../services/documentIngestionService';

// ============================================================================
// DCE DOCUMENT INGESTION JOB
// ============================================================================
// Runs separately from the BOAMP/PLACE/TED connectors (dataCollectionService)
// so that downloading attachments from slow or unreliable buyer platforms
// never blocks or slows down the core notice-collection loop. Processes a
// bounded batch every run; opportunities not yet picked up just wait for the
// next tick (dce_documents_status stays 'pending' until then).
// ============================================================================

const BATCH_SIZE = 15;

const runBatch = async () => {
  try {
    const processed = await runPendingDocumentIngestion(BATCH_SIZE);
    if (processed > 0) {
      logger.info(`[Job] DCE document ingestion: processed ${processed} opportunity(ies)`);
    }
  } catch (err) {
    logger.error('[Job] DCE document ingestion batch failed:', err);
  }
};

export const startDocumentIngestion = () => {
  // Every 15 minutes - frequent enough that new opportunities get their
  // documents fetched within roughly the same collection cycle, without
  // hammering buyer platforms.
  cron.schedule('*/15 * * * *', () => {
    runBatch();
  });

  // Same free-tier-host reasoning as dataCollection.ts/aiProcessing.ts: a
  // fixed-clock cron may never get a chance to fire if the process spins
  // down on idle, leaving dce_documents_status stuck at 'pending'
  // indefinitely. Run one batch immediately on boot so every deploy/restart
  // guarantees at least one real attempt.
  logger.info('[Job] Running an immediate DCE document ingestion pass on boot...');
  runBatch().catch((err) => logger.error('[Job] Boot-time document ingestion pass failed (non-fatal):', err));

  logger.info('✅ DCE document ingestion job scheduled (every 15 min)');
};

export const runDocumentIngestionOnce = runBatch;
