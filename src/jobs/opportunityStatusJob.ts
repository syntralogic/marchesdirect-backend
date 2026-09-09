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

  // Client's audit also flagged ~41,214 announcements with no deadline at
  // all, still shown as "active"/new. Most of that volume is legitimately
  // deadline-less by source (DECP is post-award -> already inserted as
  // 'awarded'; Batiweb is a news feed, not a formal notice) and the WHERE
  // status = 'active' above never touches those. But BOAMP/PLACE/TED rows
  // where the source's deadline field just failed to parse or wasn't
  // populated get stuck 'active' forever, since the first UPDATE can never
  // catch a NULL deadline - exactly the "already-awarded market still shown
  // as new" complaint. A real still-open public procurement notice with no
  // deadline captured after 4+ months is implausible (BOAMP/PLACE deadlines
  // typically run 3-8 weeks - see the collectBoampData comment above), so
  // age it out on publication_date instead as a conservative fallback.
  const staleResult = await db.query(
    `UPDATE opportunities
     SET status = 'expired', updated_at = NOW()
     WHERE status = 'active' AND deadline IS NULL AND publication_date < NOW() - INTERVAL '120 days'`
  );
  if (staleResult.rowCount && staleResult.rowCount > 0) {
    logger.info(`[Job] Marked ${staleResult.rowCount} opportunities as expired (no deadline captured, publication older than 120 days).`);
  }

  return (result.rowCount || 0) + (staleResult.rowCount || 0);
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
