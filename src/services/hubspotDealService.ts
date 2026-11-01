import {isTestCompany} from './companyProfileService';
import { isTestCrmCompany } from './hubspotTestPolicy';
import { journeyLinkProperties } from './journeyLinkService';
import axios, { AxiosRequestConfig } from 'axios';
import { db } from '../config/database';
import { logger } from '../utils/logger';
import { computeMatchScore } from './matchScoreService';
import { RULES_VERSION } from './matchEngine';
import { dossierStatesFor, DossierEmailStatus } from './dossierStateService';

// ============================================================================
// HUBSPOT DEALS (client brief 31 Oct, part C)
//
// One deal per REAL commercial request (dossier, callback, appointment) - never per visit or search.
// A request is a crm_leads row (one per opportunity + e-mail), so a callback that later becomes an appointment
// on the same market updates the SAME deal. md_request_id = crm_leads.id.
//
// Duplicates are prevented three ways, because md_request_id alone does not guarantee uniqueness:
//   1. crm_deals (lead_id UNIQUE) remembers the HubSpot deal id of each request;
//   2. before creating, HubSpot is searched by md_request_id (covers a lost local row);
//   3. an in-process lock per request (covers a double click / concurrent retry).
//
// Stages (pipeline "Marchés Direct - Accompagnement"): a new dossier/callback request enters "À rappeler"
// (which fires the HubSpot priority task); a CONFIRMED booking enters "RDV confirmé"; "RDV réalisé" is set only
// when staff record that the appointment really took place (md_appointment_outcome = attended).
// A stage is only ever moved FORWARD and never touched once the team has moved the deal further or to "Sans suite".
// Not exercised against a real HubSpot account from the build sandbox.
// ============================================================================

export const PIPELINE_ID = '4280487115';
export const STAGES = {
  callback: '6323584230',      // À rappeler
  contact: '6323584231',       // Contact établi
  confirmed: '6323584232',     // RDV confirmé
  held: '6323584233',          // RDV réalisé
  proposal: '6323584234',      // Proposition envoyée
  signed: '6323584235',        // Accompagnement signé
  lost: '6323584236',          // Sans suite
} as const;
const STAGE_RANK: Record<string, number> = {
  [STAGES.callback]: 0, [STAGES.contact]: 1, [STAGES.confirmed]: 2, [STAGES.held]: 3, [STAGES.proposal]: 4, [STAGES.signed]: 5,
};

// Portal-specific default, matching this project's portal and pipeline. An
// explicit environment value permits another commercial owner on deployment.
export const defaultCommercialOwner = () => (process.env.HUBSPOT_DEFAULT_OWNER_ID || '102050175').trim();

export type RequestType = 'dossier' | 'callback' | 'appointment';
export const APPOINTMENT_OUTCOMES = ['scheduled', 'attended', 'no_show', 'reschedule', 'cancelled'] as const;
export type AppointmentOutcome = typeof APPOINTMENT_OUTCOMES[number];

export type DealLead = {
  siret?: string | null;
  id: string;
  first_name?: string | null; last_name?: string | null; email?: string | null;
  company_name?: string | null;
  lead_source?: string | null;
  appointment_mode?: string | null;
  appointment_slot_at?: Date | string | null;
  opportunity_id?: string | null;
  lot_label?: string | null;
  session_id?: string | null;
  created_at?: Date | string | null;
};

// Only these origins are commercial requests; contact-form messages and chatbot leads never become deals.
export function requestTypeForLead(lead: DealLead): RequestType | null {
  if (lead.appointment_mode === 'slot' || lead.lead_source === 'appointment_modal') return 'appointment';
  if (lead.appointment_mode === 'callback' || lead.lead_source === 'callback_modal') return 'callback';
  if (lead.lead_source === 'analysis_gate') return 'dossier';
  return null;
}

const TYPE_RANK: Record<RequestType, number> = { dossier: 0, callback: 1, appointment: 2 };
// A request only grows (dossier -> callback -> appointment), never shrinks.
export const strongestType = (a: RequestType | null | undefined, b: RequestType): RequestType =>
  a && TYPE_RANK[a] > TYPE_RANK[b] ? a : b;

export function marketTypeOf(journeyCode: string | null | undefined): 'public' | 'private' | 'subcontracting' | null {
  if (journeyCode === 'public_procurement') return 'public';
  if (journeyCode === 'tender') return 'private';
  if (journeyCode === 'subcontracting') return 'subcontracting';
  return null;
}

const ANSWER_MAP: Record<string, string> = { oui: 'yes', non: 'no', a_confirmer: 'unanswered' };
const answer = (v: unknown): string => ANSWER_MAP[String(v)] || 'unanswered';

export function answerProperties(answers: Record<string, unknown> | null | undefined) {
  const a = answers || {};
  return {
    md_answer_moyens: answer(a.capacity),
    md_answer_references: answer(a.experience),
    md_answer_disponibilite: answer(a.calendar),
    md_answer_zone: answer(a.location),
  };
}

// Target stage for the CURRENT facts of the request, or null when the request alone justifies no stage change.
export function targetStage(type: RequestType, bookingConfirmed: boolean, outcome: AppointmentOutcome | null): string {
  if (type === 'appointment' && bookingConfirmed) return outcome === 'attended' ? STAGES.held : STAGES.confirmed;
  if(type==='dossier'){
    const stage=process.env.HUBSPOT_DOSSIER_STAGE_ID;
    if(!stage)throw new Error('hubspot_dossier_stage_not_ready');
    return stage;
  }
  return STAGES.callback;
}

// Forward-only: never regress, never override the team's own moves, never leave "Sans suite".
export function shouldWriteStage(current: string | null | undefined, target: string): boolean {
  if (!current) return true;
  const ranks={...STAGE_RANK,...(process.env.HUBSPOT_DOSSIER_STAGE_ID?{[process.env.HUBSPOT_DOSSIER_STAGE_ID]:-1}:{}),...(process.env.HUBSPOT_CALLED_STAGE_ID?{[process.env.HUBSPOT_CALLED_STAGE_ID]:1}:{})};
  if (!(current in ranks) || !(target in ranks)) return false;
  return ranks[target] > ranks[current];
}

const compact = (o: Record<string, unknown>): Record<string, unknown> => {
  const r: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== null && v !== undefined && v !== '') r[k] = v;
  return r;
};
const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

// ---------------------------------------------------------------- HubSpot HTTP (same conventions as hubspotSyncService)
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

// ---------------------------------------------------------------- data gathering
async function gatherDealFacts(lead: DealLead) {
  let market: any = null;
  if (lead.opportunity_id) {
    const o = await db.query(
      `SELECT o.title, o.source_reference, o.official_url, ot.code AS journey
       FROM opportunities o LEFT JOIN opportunity_types ot ON ot.id = o.opportunity_type_id WHERE o.id = $1`,
      [lead.opportunity_id]
    );
    market = o.rows[0] || null;
  }

  // The analysis the visitor really ran on this market (answers + the index computed from them).
  let answers: Record<string, unknown> | null = null;
  let score: number | null = null;
  let scoreDate:string|null=null;
  if (lead.opportunity_id && lead.session_id) {
    const s = await db.query(
      `SELECT answers, lot_id, compatibility_score,score_computed_at FROM analysis_snapshots WHERE session_id = $1 AND opportunity_id = $2 AND ($3::text IS NULL OR siret=$3) ORDER BY updated_at DESC LIMIT 1`,
      [lead.session_id, lead.opportunity_id,lead.siret||null]
    );
    if (s.rows[0]) {
      answers = s.rows[0].answers;
      if(typeof s.rows[0].compatibility_score==='number'&&s.rows[0].score_computed_at){
        score=s.rows[0].compatibility_score;scoreDate=new Date(s.rows[0].score_computed_at).toISOString();
      }
      // A CRM retry never recalculates or changes the original score timestamp.

    }
  }

  const b = await db.query(
    `SELECT status, outcome, slot_at FROM appointment_bookings WHERE lead_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [lead.id]
  );
  const booking = b.rows[0] || null;
  const states = await dossierStatesFor({ sessionId: lead.session_id, opportunityId: lead.opportunity_id, siret: lead.siret });
  return { market, answers, score, scoreDate, booking, ...states };
}

export function buildDealProperties(args: {
  lead: DealLead; type: RequestType; market: any; answers: Record<string, unknown> | null; score: number | null;
  booking: { status: string; outcome: string | null } | null; forCreate: boolean; contactLabel: string; now?: Date;
  scoreDate?:string|null;
  dossierStatus?: 'requested' | 'available' | 'error' | null;
  emailStatus?: DossierEmailStatus | null;
  errorAt?: string; errorCode?: string;
}): Record<string, unknown> {
  const { lead, type, market, answers, score, booking, forCreate } = args;
  const now = args.now || new Date();
  const confirmed = type === 'appointment' && booking?.status === 'booked';
  const outcome: AppointmentOutcome | null = booking?.outcome && (APPOINTMENT_OUTCOMES as readonly string[]).includes(booking.outcome)
    ? (booking.outcome as AppointmentOutcome) : confirmed ? 'scheduled' : null;
  const title = market?.title ? String(market.title).slice(0, 120) : null;
  return compact({
    ...journeyLinkProperties(lead.id),
    // pipeline/stage/name are written by the caller on creation only (see syncDealForLead)
    ...(forCreate ? { dealname: `${args.contactLabel} - ${title || 'Demande commerciale'}`.slice(0, 250) } : {}),
    ...(isTestCompany(lead.siret||'',lead.company_name)?{md_is_test:'true'}:{}),
    md_request_id: lead.id,
    md_request_type: type,
    md_request_date: iso(lead.created_at),
    md_market_type: marketTypeOf(market?.journey),
    md_market_reference: market?.source_reference ? String(market.source_reference).slice(0, 255) : null,
    md_lot_reference: lead.lot_label ? String(lead.lot_label).slice(0, 255) : null,
    md_market_url: market?.official_url || null,
    md_compatibility_score: score,
    md_score_version: score !== null ? RULES_VERSION : null,
    md_score_date: score !== null ? (args.scoreDate || now.toISOString()) : null,
    ...(answers ? answerProperties(answers) : {}),
    // PDF generation and e-mail acceptance are independent facts.
    ...(args.dossierStatus ? { md_dossier_status: args.dossierStatus } : forCreate && type === 'dossier' ? { md_dossier_status: 'requested' } : {}),
    ...(process.env.HUBSPOT_DELIVERY_STATUSES_ENABLED === 'true' && args.emailStatus ? { md_email_status: args.emailStatus } : {}),
    ...(process.env.HUBSPOT_DELIVERY_STATUSES_ENABLED === 'true' && args.errorAt ? {
      md_last_delivery_error_at: args.errorAt, md_delivery_error_code: args.errorCode,
    } : {}),
    md_appointment_outcome: outcome,
  });
}

// ---------------------------------------------------------------- entry point
export async function syncDealForLead(lead: DealLead, contactId: string, companyId: string | null): Promise<string | null> {
  const type = requestTypeForLead(lead);
  if (!type) return null;

  return withLock(`deal:${lead.id}`, async () => {
    if (await isTestCrmCompany(companyId, lead.siret || '', lead.company_name, hs)) return null;
    const facts = await gatherDealFacts(lead);
    const confirmed = type === 'appointment' && facts.booking?.status === 'booked';
    const outcome = (facts.booking?.outcome as AppointmentOutcome | null) || null;
    const contactLabel = [lead.company_name, [lead.first_name, lead.last_name].filter(Boolean).join(' ')].filter(Boolean)[0] as string || lead.email || 'Prospect';

    const known = await db.query('SELECT hubspot_deal_id FROM crm_deals WHERE lead_id = $1', [lead.id]);
    let dealId: string | null = known.rows[0]?.hubspot_deal_id || null;
    if (!dealId) {
      const found = await hs<{ results?: { id: string }[] }>({
        method: 'POST', url: '/crm/v3/objects/deals/search',
        data: { filterGroups: [{ filters: [{ propertyName: 'md_request_id', operator: 'EQ', value: lead.id }] }], limit: 1 },
      });
      dealId = found.results?.[0]?.id ? String(found.results[0].id) : null;
    }

    const common = { lead, market: facts.market, answers: facts.answers, score: facts.score, scoreDate:facts.scoreDate, booking: facts.booking, contactLabel, dossierStatus: facts.dossierStatus, emailStatus: facts.emailStatus, errorAt: facts.errorAt, errorCode: facts.errorCode };

    if (!dealId) {
      const created = await hs<{ id: string }>({
        method: 'POST', url: '/crm/v3/objects/deals',
        data: { properties: { ...buildDealProperties({ ...common, type, forCreate: true }), pipeline: PIPELINE_ID, dealstage: targetStage(type, confirmed, outcome), hubspot_owner_id: defaultCommercialOwner() } },
      });
      dealId = String(created.id);
    } else {
      const cur = await hs<{ properties?: Record<string, string | null> }>({
        method: 'GET', url: `/crm/v3/objects/deals/${dealId}`, params: { properties: 'dealstage,md_request_type,hubspot_owner_id' },
      });
      const merged = strongestType((cur.properties?.md_request_type as RequestType) || null, type);
      const stage = targetStage(merged, confirmed, outcome);
      const props: Record<string, unknown> = buildDealProperties({ ...common, type: merged, forCreate: false });
      if (shouldWriteStage(cur.properties?.dealstage, stage)) props.dealstage = stage;
      if (!cur.properties?.hubspot_owner_id) props.hubspot_owner_id = defaultCommercialOwner();
      await hs({ method: 'PATCH', url: `/crm/v3/objects/deals/${dealId}`, data: { properties: props } });
    }

    // Idempotent (PUT) associations: the deal belongs to THIS contact and THIS company, nobody else.
    await hs({ method: 'PUT', url: `/crm/v4/objects/deals/${dealId}/associations/default/contacts/${contactId}` });
    if (companyId) await hs({ method: 'PUT', url: `/crm/v4/objects/deals/${dealId}/associations/default/companies/${companyId}` });

    await db.query(
      `INSERT INTO crm_deals (lead_id, hubspot_deal_id, request_type) VALUES ($1, $2, $3)
       ON CONFLICT (lead_id) DO UPDATE SET hubspot_deal_id = EXCLUDED.hubspot_deal_id, request_type = EXCLUDED.request_type, updated_at = NOW()`,
      [lead.id, dealId, type]
    );
    return dealId;
  });
}
