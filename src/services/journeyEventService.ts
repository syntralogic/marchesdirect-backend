import { storeJourneyEvent } from './journeyStorageService';
import { db } from '../config/database';
import { logger } from '../utils/logger';
import { syncLeadToCrm } from './crmSyncService';
import { activeCrmSystem } from './crmSystem';
import { syncCompanyJourneyForSession } from './hubspotSyncService';

// Server evidence complements browser beacons. Never infer a search, consent,
// phone verification or a completed analysis from a later form submission.
export async function recordJourneyEvent(args: {
  sessionId: string; eventType: string; eventId: string;
  siret?: string | null; opportunityId?: string | null; analysisId?: string | null;
}): Promise<void> {
  try {
    await storeJourneyEvent({ ...args, trackingVersion: 1,
      eventData: { source: 'server', opportunityId: args.opportunityId || null } });
  } catch (err) {
    logger.error('Server journey event could not be recorded:', err);
  }
}

const pending = new Map<string, ReturnType<typeof setTimeout>>();
// Mark pending durably BEFORE coalescing the immediate refresh. A restart is
// covered by the existing CRM retry job; browsing never waits for HubSpot.
export async function refreshJourneyForSession(sessionId: string): Promise<void> {
  if (activeCrmSystem() !== 'hubspot' || !sessionId) return;
  try {
    await db.query(
      `UPDATE crm_leads SET crm_sync_status = 'pending' WHERE session_id = $1 RETURNING id`, [sessionId]
    );
    if (pending.has(sessionId)) return;
    const timer = setTimeout(async () => {
      pending.delete(sessionId);
      try {
        const current = await db.query('SELECT id FROM crm_leads WHERE session_id = $1', [sessionId]);
        for (const lead of current.rows) await syncLeadToCrm(lead.id);
        await syncCompanyJourneyForSession(sessionId);
      } catch (err) { logger.error('Journey refresh failed (pending leads will retry):', err); }
    }, 2000);
    timer.unref();
    pending.set(sessionId, timer);
  } catch (err) { logger.error('Could not queue journey refresh:', err); }
}
