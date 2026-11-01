import { randomUUID } from 'crypto';
import { PoolClient } from 'pg';
import { db } from '../config/database';

export type StoredJourneyEvent = {
  sessionId: string; eventId: string; eventType: string;
  occurredAt?: string; siret?: string | null; trackingVersion?: number;
  opportunityId?: string | null; lotRef?: string | null; analysisId?: string | null;
  brandId?: string | null; eventLabel?: string | null; eventData?: unknown;
};

const validSiret = (s: unknown): s is string => typeof s === 'string' && /^\d{14}$/.test(s);
const lockSession = (client: PoolClient, sessionId: string) =>
  client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`md-journey:${sessionId}`]);

async function markCompanyPending(client: PoolClient, siret: string | null) {
  if (!siret) return;
  await client.query(`INSERT INTO crm_company_sync_queue(siret) VALUES($1)
    ON CONFLICT(siret) DO UPDATE SET version=crm_company_sync_queue.version+1,updated_at=NOW()`, [siret]);
}

// An immutable raw SIRET plus a separate attribution for the initial anonymous
// segment. A retry preserves the ORIGINAL id, timestamp and SIRET snapshot.
async function insertEvent(client: PoolClient, event: StoredJourneyEvent): Promise<boolean> {
  const occurredAt = event.occurredAt || new Date().toISOString();
  let siret = validSiret(event.siret) ? event.siret : null;
  if (!Object.prototype.hasOwnProperty.call(event, 'siret')) {
    // Compatibility for old clients/server callers: temporal evidence only.
    // NEVER substitute the current siret_lookups row for an older event.
    const at = await client.query(`SELECT siret FROM journey_company_selections
      WHERE session_id=$1 AND selected_at<=$2 ORDER BY selected_at DESC,id DESC LIMIT 1`, [event.sessionId, occurredAt]);
    siret = at.rows[0]?.siret || null;
  }
  let attributed = siret;
  if (!attributed && event.trackingVersion === 1) {
    const first = await client.query(`SELECT siret,selected_at FROM journey_company_selections
      WHERE session_id=$1 ORDER BY selected_at,id LIMIT 1`, [event.sessionId]);
    if (first.rows[0] && new Date(occurredAt) <= new Date(first.rows[0].selected_at)) attributed = first.rows[0].siret;
  }
  const inserted = await client.query(
    `INSERT INTO visitor_events(session_id,brand_id,event_type,event_label,event_data,event_id,occurred_at,siret,opportunity_id,lot_ref,analysis_id,attribution_siret,tracking_version)
     VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT(session_id,event_id) WHERE event_id IS NOT NULL DO NOTHING RETURNING id`,
    [event.sessionId,event.brandId || null,event.eventType,event.eventLabel || null,
      event.eventData ? JSON.stringify(event.eventData) : null,event.eventId,occurredAt,siret,
      event.opportunityId || null,event.lotRef || null,event.analysisId || null,attributed,event.trackingVersion || 0]);
  if (inserted.rows.length) {
    await markCompanyPending(client, attributed);
    await client.query(`UPDATE crm_leads SET crm_sync_status='pending' WHERE session_id=$1`, [event.sessionId]);
  }
  return inserted.rows.length > 0;
}

export async function storeJourneyEvent(event: StoredJourneyEvent): Promise<boolean> {
  return db.transaction(async client => { await lockSession(client,event.sessionId); return insertEvent(client,event); });
}

// Current UI state + immutable selection + event + pending CRM refresh commit
// together. An outage leaves the previous state intact and returns an error.
export async function selectJourneyCompany(sessionId: string, siret: string, company: unknown): Promise<void> {
  if (!validSiret(siret)) throw new Error('invalid_siret');
  await db.transaction(async client => {
    await lockSession(client,sessionId);
    const previous = await client.query('SELECT siret FROM siret_lookups WHERE session_id=$1', [sessionId]);
    const existing = await client.query('SELECT 1 FROM journey_company_selections WHERE session_id=$1 LIMIT 1', [sessionId]);
    const selected = await client.query(`INSERT INTO journey_company_selections(session_id,siret,company_data)
      VALUES($1,$2,$3::jsonb) RETURNING id,selected_at`, [sessionId,siret,JSON.stringify(company)]);
    const at = selected.rows[0].selected_at;
    await client.query(`INSERT INTO siret_lookups(session_id,siret,company_data) VALUES($1,$2,$3::jsonb)
      ON CONFLICT(session_id) DO UPDATE SET siret=EXCLUDED.siret,company_data=EXCLUDED.company_data,created_at=NOW(),
      email=CASE WHEN siret_lookups.siret=EXCLUDED.siret THEN siret_lookups.email ELSE NULL END,
      phone=CASE WHEN siret_lookups.siret=EXCLUDED.siret THEN siret_lookups.phone ELSE NULL END,
      lead_captured_at=CASE WHEN siret_lookups.siret=EXCLUDED.siret THEN siret_lookups.lead_captured_at ELSE NULL END`,
      [sessionId,siret,JSON.stringify(company)]);
    if (!existing.rows.length) {
      await client.query(`UPDATE visitor_events SET attribution_siret=$2 WHERE session_id=$1
        AND tracking_version=1 AND siret IS NULL AND attribution_siret IS NULL
        AND COALESCE(occurred_at,created_at)<=($3::timestamptz AT TIME ZONE 'UTC')`, [sessionId,siret,at]);
    }
    await insertEvent(client,{sessionId,siret,eventId:`company:${selected.rows[0].id || randomUUID()}`,
      eventType:'company_selected',occurredAt:new Date(at).toISOString(),trackingVersion:1,eventData:{source:'server'}});
    if (previous.rows[0]?.siret && previous.rows[0].siret !== siret) await markCompanyPending(client,previous.rows[0].siret);
  });
}
