import cron from 'node-cron';
import { logger } from '../utils/logger';
import { retryPendingCrmSyncs } from '../services/crmSyncService';

export const startCrmRetrySchedule = () => {
  // Every 30 minutes - frequent enough that a lead isn't stuck for long, without
  // hammering the CRM API if it's genuinely down for a while.
  cron.schedule('*/30 * * * *', async () => {
    try {
      const count = await retryPendingCrmSyncs(50);
      if (count > 0) {
        logger.info(`[Job] CRM retry sweep: attempted ${count} pending/failed lead(s)`);
      }
    } catch (err) {
      logger.error('[Job] CRM retry sweep failed:', err);
    }
  });

  logger.info('✅ CRM retry job scheduled (every 30 minutes)');
};
