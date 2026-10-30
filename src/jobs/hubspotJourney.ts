import cron from 'node-cron';
import { logger } from '../utils/logger';
import { trackJob } from '../utils/jobTracker';
import {
  isHubspotConfigured, ensureHubspotProperties, pendingSessions, syncIdentifiedSession, syncSessionJourney,
} from '../services/hubspotService';

// Keeps HubSpot's timeline in step with what identified visitors do on the site:
//  1. sessions that gave their SIRET + phone/e-mail but are not linked yet
//     (e.g. the real-time push failed or HubSpot was down) get linked;
//  2. already-linked sessions with new visitor_events get one "parcours" note.
// Batched (not one call per event) to stay far below HubSpot's rate limits, and a no-op
// until HUBSPOT_ACCESS_TOKEN is set. Safe to re-run: only events newer than the last push are sent.
export const runHubspotJourneySweep = async (): Promise<number> => {
  if (!isHubspotConfigured()) return 0;
  const { toIdentify, toUpdate } = await pendingSessions(25);
  let done = 0;
  for (const id of toIdentify) {
    try { if (await syncIdentifiedSession(id)) done++; } catch (err) { logger.error(`[HubSpot] identify sweep failed for session ${id}:`, err); }
  }
  for (const id of toUpdate) {
    try { await syncSessionJourney(id); done++; } catch (err) { logger.error(`[HubSpot] journey sweep failed for session ${id}:`, err); }
  }
  return done;
};

export const startHubspotJourneySchedule = () => {
  if (!isHubspotConfigured()) {
    logger.info('[Job] HubSpot journey sync disabled (HUBSPOT_ACCESS_TOKEN not set)');
    return;
  }
  // Offset from the other jobs ('*/30', '20,50').
  cron.schedule('7,17,27,37,47,57 * * * *', async () => {
    await trackJob('hubspotJourney:cron', async () => {
      try {
        const n = await runHubspotJourneySweep();
        if (n > 0) logger.info(`[Job] HubSpot journey sweep: ${n} session(s) pushed`);
      } catch (err) {
        logger.error('[Job] HubSpot journey sweep failed:', err);
      }
    });
  });
  // Create the custom properties once (no-op when they exist; failures are non-fatal).
  trackJob('hubspotJourney:boot', async () => {
    const r = await ensureHubspotProperties();
    logger.info(`[HubSpot] properties: ${r.created.length} created, ${r.existing.length} existing, ${r.failed.length} failed`);
    await runHubspotJourneySweep();
  }).catch((err) => logger.error('[Job] HubSpot boot sync failed (non-fatal):', err));
  logger.info('✅ HubSpot journey sync scheduled (every 10 minutes)');
};
