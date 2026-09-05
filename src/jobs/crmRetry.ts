import cron from 'node-cron';
import { logger } from '../utils/logger';
import { retryPendingCrmSyncs } from '../services/crmSyncService';
import { trackJob } from '../utils/jobTracker';

export const startCrmRetrySchedule = () => {
  // Every 30 minutes - frequent enough that a lead isn't stuck for long, without
  // hammering the CRM API if it's genuinely down for a while.
  cron.schedule('*/30 * * * *', async () => {
    await trackJob('crmRetry:cron', async () => {
      try {
        const count = await retryPendingCrmSyncs(50);
        if (count > 0) {
          logger.info(`[Job] CRM retry sweep: attempted ${count} pending/failed lead(s)`);
        }
      } catch (err) {
        logger.error('[Job] CRM retry sweep failed:', err);
      }
    });
  });

  // Free-tier-host reasoning again: this only ever touches pending/failed
  // rows, so re-running it - including right on boot - is always safe. Fire
  // one sweep immediately so a lead isn't stuck waiting on a cron tick that
  // might not happen for a while on a host that spins down between requests.
  logger.info('[Job] Running an immediate CRM retry sweep on boot...');
  trackJob('crmRetry:boot', () => retryPendingCrmSyncs(50))
    .then((count) => {
      if (count > 0) logger.info(`[Job] Boot-time CRM retry sweep: attempted ${count} pending/failed lead(s)`);
    })
    .catch((err) => logger.error('[Job] Boot-time CRM retry sweep failed (non-fatal):', err));

  logger.info('✅ CRM retry job scheduled (every 30 minutes)');
};
