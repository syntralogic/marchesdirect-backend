import cron from 'node-cron';
import { logger } from '../utils/logger';
import { trackJob } from '../utils/jobTracker';
import { processDueFollowUps } from '../services/followUpService';
import { sendDueAlerts } from '../services/alertSubscriptionService';

// Reminders and trade/zone alerts. Both are inert until FOLLOW_UP_EMAILS_ENABLED / ALERT_EMAILS_ENABLED are 'true'.
export const startFollowUpsSchedule = () => {
  cron.schedule('5,35 * * * *', async () => {
    await trackJob('followUps:cron', async () => {
      try { const r = await processDueFollowUps(50); if (r.sent + r.stopped + r.disabled + r.failed) logger.info(`[Job] Follow-ups: ${JSON.stringify(r)}`); }
      catch (err) { logger.error('[Job] Follow-up sweep failed:', err); }
      try { const a = await sendDueAlerts(); if (a.sent + a.failed) logger.info(`[Job] Trade/zone alerts: ${JSON.stringify(a)}`); }
      catch (err) { logger.error('[Job] Alert sweep failed:', err); }
    });
  });
  logger.info('✅ Follow-up and alert jobs scheduled (every 30 min; sending off until validated)');
};
