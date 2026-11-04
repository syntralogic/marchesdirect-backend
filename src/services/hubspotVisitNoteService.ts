import axios, { AxiosRequestConfig } from 'axios';
import { db } from '../config/database';
import { logger } from '../utils/logger';
import { buildVisitNote, callbackMomentLabel, requestTypeOfLead, VisitRequest } from '../utils/requestFacts';

// ============================================================================
// HUBSPOT NOTE PER VISIT + TASK PER APPOINTMENT REQUEST (refonte v26, item 5)
//
// - ONE note per visit (session_id): rebuilt from every request of that visit and PATCHed, never duplicated.
//   It carries what the team must read in clear text: the callback moment, the question, the requested slot.
// - ONE task per appointment request ("Créneau souhaité"): Elena confirms by phone, the site never says "réservé".
// Both use standard HubSpot properties (hs_note_body, hs_task_*), so no custom property is needed.
// Not exercised against a real HubSpot account from the build sandbox.
// ============================================================================

async function hs<T = any>(cfg: AxiosRequestConfig): Promise<T> {
  const res = await axios.request({
    baseURL: (process.env.HUBSPOT_BASE_URL || 'https://api.hubapi.com').replace(/\/$/, ''),
    timeout: 10000,
    ...cfg,
    headers: { Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`, 'Content-Type': 'application/json', ...(cfg.headers || {}) },
  });
  return res.data as T;
}

const locks = new Map<string, Promise<unknown>>();
async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) || Promise.resolve();
  const run = prev.catch(() => undefined).then(fn);
  locks.set(key, run);
  try { return await run; } finally { if (locks.get(key) === run) locks.delete(key); }
}

// Custom properties are only written once Hedi confirmed they exist in HubSpot (an unknown property rejects the whole update).
export const v26PropertiesEnabled = (env: NodeJS.ProcessEnv = process.env) => env.HUBSPOT_V26_PROPERTIES === '1';

export type NoteLead = {
  id: string; session_id?: string | null; phone?: string | null; company_name?: string | null;
  lead_source?: string | null; appointment_mode?: string | null; appointment_slot_at?: Date | string | null;
  message?: string | null; callback_moment?: string | null; is_test?: boolean | null;
  utm_source?: string | null; utm_campaign?: string | null; first_name?: string | null; last_name?: string | null;
};

async function associate(object: 'notes' | 'tasks', id: string, to: Record<string, string | null>) {
  for (const [target, targetId] of Object.entries(to)) {
    if (!targetId) continue;
    await hs({ method: 'PUT', url: `/crm/v4/objects/${object}/${id}/associations/default/${target}/${targetId}` });
  }
}

export async function syncVisitNote(lead: NoteLead, ids: { contactId: string; companyId: string | null; dealId: string | null }): Promise<void> {
  const key = lead.session_id || `lead:${lead.id}`;
  return withLock(`note:${key}`, async () => {
    const rows = lead.session_id
      ? (await db.query(
          `SELECT l.*, o.title AS market_title FROM crm_leads l LEFT JOIN opportunities o ON o.id = l.opportunity_id
           WHERE l.session_id = $1 ORDER BY l.created_at ASC`, [lead.session_id])).rows
      : [lead];
    const lookup = lead.session_id
      ? (await db.query(`SELECT siret, company_data FROM siret_lookups WHERE session_id = $1 ORDER BY created_at DESC LIMIT 1`, [lead.session_id])).rows[0]
      : null;
    const requests: VisitRequest[] = rows.map((r: any) => ({
      type: requestTypeOfLead(r), at: r.created_at || null, marketTitle: r.market_title || null, lot: r.lot_label || null,
      callbackMoment: r.callback_moment || null, slotAt: r.appointment_slot_at || null, message: r.message || null, phone: r.phone || null,
    }));
    const first = rows[0] || lead;
    const body = buildVisitNote({
      visitDate: (first as any).created_at || new Date(), company: lookup?.company_data?.name || lead.company_name || null,
      siret: lookup?.siret || null, source: first.utm_source || null, campaign: first.utm_campaign || null,
      isTest: rows.some((r: any) => r.is_test), requests,
    }).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');

    const known = await db.query('SELECT hubspot_note_id FROM crm_visit_notes WHERE session_id = $1', [key]);
    const noteId: string | null = known.rows[0]?.hubspot_note_id || null;
    if (noteId) {
      await hs({ method: 'PATCH', url: `/crm/v3/objects/notes/${noteId}`, data: { properties: { hs_note_body: body } } });
      // The visit may have gained a deal or a company since the note was created: associations are idempotent.
      await associate('notes', noteId, { contacts: ids.contactId, companies: ids.companyId, deals: ids.dealId });
      await db.query('UPDATE crm_visit_notes SET updated_at = NOW() WHERE session_id = $1', [key]);
      return;
    }
    const created = await hs<{ id: string }>({
      method: 'POST', url: '/crm/v3/objects/notes',
      data: { properties: { hs_note_body: body, hs_timestamp: new Date().toISOString() } },
    });
    const id = String(created.id);
    await db.query(
      `INSERT INTO crm_visit_notes (session_id, hubspot_note_id) VALUES ($1, $2)
       ON CONFLICT (session_id) DO UPDATE SET hubspot_note_id = EXCLUDED.hubspot_note_id, updated_at = NOW()`, [key, id]);
    await associate('notes', id, { contacts: ids.contactId, companies: ids.companyId, deals: ids.dealId });
  });
}

export async function syncAppointmentTask(lead: NoteLead, ids: { contactId: string; dealId: string | null }): Promise<void> {
  const isAppointment = lead.appointment_mode === 'slot' || lead.lead_source === 'appointment_modal';
  if (!isAppointment || !lead.appointment_slot_at) return;
  return withLock(`task:${lead.id}`, async () => {
    const known = await db.query('SELECT 1 FROM crm_tasks WHERE lead_id = $1', [lead.id]);
    if (known.rows.length > 0) return;
    const slot = new Date(lead.appointment_slot_at as any).toLocaleString('fr-FR', { timeZone: 'Europe/Paris', dateStyle: 'full', timeStyle: 'short' });
    const who = [lead.first_name, lead.last_name].filter(Boolean).join(' ') || lead.company_name || 'le visiteur';
    const created = await hs<{ id: string }>({
      method: 'POST', url: '/crm/v3/objects/tasks',
      data: { properties: {
        hs_task_subject: `Confirmer par téléphone le rendez-vous demandé par ${who}`.slice(0, 250),
        hs_task_body: `Créneau souhaité : ${slot} (30 minutes, par téléphone).${lead.phone ? ` Téléphone : ${lead.phone}.` : ''} Le site n’a rien annoncé comme réservé : confirmer ou proposer un autre créneau.`,
        hs_timestamp: new Date().toISOString(), hs_task_status: 'NOT_STARTED', hs_task_priority: 'HIGH', hs_task_type: 'CALL',
      } },
    });
    const id = String(created.id);
    await db.query('INSERT INTO crm_tasks (lead_id, hubspot_task_id) VALUES ($1, $2) ON CONFLICT (lead_id) DO NOTHING', [lead.id, id]);
    await associate('tasks', id, { contacts: ids.contactId, deals: ids.dealId });
  });
}

// Never lets a note/task problem fail (and re-queue) the contact/deal sync that already succeeded.
// The visit NOTE is owned by visitNoteService (one short note per visit, built from the journey events, which now carry
// the callback moment, the question and the slot). syncVisitNote above is kept for reference but no longer called, so a
// visit can never get two notes. Only the appointment TASK is created here.
export async function syncVisitExtras(lead: NoteLead, ids: { contactId: string; companyId: string | null; dealId: string | null }): Promise<void> {
  try { await syncAppointmentTask(lead, ids); } catch (err) { logger.warn(`[HubSpot] appointment task not created for lead ${lead.id}: ${(err as Error).message}`); }
}

export { callbackMomentLabel };
