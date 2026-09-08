import cron from 'node-cron';
import { db } from '../config/database';
import { logger } from '../utils/logger';
import { trackJob } from '../utils/jobTracker';

// ============================================================================
// OPPORTUNITY STATUS TRANSITIONS
// ============================================================================
// Client's 8 Sep audit: "Presque toutes apparaissent comme actives... alors
// qu'elles ne sont pas toutes dans la même situation" - some are still open,
// others closed, awarded, or cancelled, but everything showed as a fresh
// "new opportunity" regardless. DECP-sourced rows now get status='awarded'
// at ingest time (dataCollectionService.ts - DECP is inherently post-award
// data), and a cancelled/withdrawn notice would come through as such from
// its source connector. What none of that covers is the passage of time:
// an opportunity that was genuinely open when scraped becomes "Clôturé"
// the moment its deadline passes, and nothing about the connector run
// itself changes to tell us that - it has to be checked on a schedule.
export async function markExpiredOpportunities() {
  const result = await db.query(
    `UPDATE opportunities
     SET status = 'expired', updated_at = NOW()
     WHERE status = 'active' AND deadline IS NOT NULL AND deadline < NOW()`
  );
  if (result.rowCount && result.rowCount > 0) {
    logger.info(`[Job] Marked ${result.rowCount} opportunities as expired (deadline passed).`);
  }
  return result.rowCount || 0;
}

export const startOpportunityStatusJob = () => {
  setTimeout(() => {
    trackJob('opportunityStatus:boot', markExpiredOpportunities).catch(err => logger.error('[Job] Boot-time expiry check failed (non-fatal):', err));
  }, 15_000);

  // Hourly is plenty - a deadline passing an hour late doesn't matter to a
  // visitor, and this is a single indexed bulk UPDATE, not per-row work.
  cron.schedule('0 * * * *', () => {
    trackJob('opportunityStatus:cron', markExpiredOpportunities).catch(err => logger.error('[Job] Scheduled expiry check failed (non-fatal):', err));
  });

  logger.info('✅ Opportunity status job scheduled (boot + hourly): marks deadline-passed opportunities as expired');
};
