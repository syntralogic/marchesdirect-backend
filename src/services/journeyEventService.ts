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
    await db.query(
      `INSERT INTO visitor_events (session_id, event_type, event_id, occurred_at, siret, opportunity_id, analysis_id, event_data)
       VALUES ($1, $2, $3, NOW(), $4, $5, $6, $7::jsonb)
       ON CONFLICT (session_id, event_id) WHERE event_id IS NOT NULL DO NOTHING`,
      [args.sessionId, args.eventType, args.eventId, args.siret || null,
        args.opportunityId || null, args.analysisId || null,
        JSON.stringify({ source: 'server', opportunityId: args.opportunityId || null })]
    );
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
        if (!current.rows.length) await syncCompanyJourneyForSession(sessionId);
      } catch (err) { logger.error('Journey refresh failed (pending leads will retry):', err); }
    }, 2000);
    timer.unref();
    pending.set(sessionId, timer);
  } catch (err) { logger.error('Could not queue journey refresh:', err); }
}
