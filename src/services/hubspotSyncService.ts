import { journeyLinkProperties } from './journeyLinkService';
import axios, { AxiosRequestConfig } from 'axios';
import { db } from '../config/database';
import { syncDealForLead, DealLead } from './hubspotDealService';

// ============================================================================
// HUBSPOT SYNC - companies and contacts (client brief 31 Oct, part B)
//
// Called by crmSyncService when CRM_SYSTEM=hubspot. The Supabase journal
// (visitor_events) stays the source of truth: the md_* HubSpot properties pushed here are only
// summaries recomputed from it on every sync, never counters incremented in HubSpot.
//
// Identity rules (brief section 5):
//  - a COMPANY is found by its SIRET (md_siret, 14-digit text) and reused;
//  - a CONTACT is found by its e-mail and reused - two people who select the same SIRET stay two contacts,
//    each with their own journey (a visitor is a session_id; the SIRET is only the company they chose);
//  - the contact is associated with the company, nothing is merged.
// Not done here: deals/tasks (part C), e-mails/SMS, marketing consent - no consent property is ever written.
// The token lives only in the server environment (HUBSPOT_ACCESS_TOKEN, a private-app token).
// Not exercised against a real HubSpot account from the build sandbox (no network path to api.hubapi.com):
// check crm_leads.crm_sync_status / crm_last_error on the first real lead.
// ============================================================================

const BASE_URL = () => (process.env.HUBSPOT_BASE_URL || 'https://api.hubapi.com').replace(/\/$/, '');

export const isHubspotConfigured = (): boolean => !!process.env.HUBSPOT_ACCESS_TOKEN;

// Journal codes that can be "the last step reached" (legacy view_opportunity counts as offer_view).
const STEP_CODES = [
  'search', 'offer_view', 'view_opportunity', 'company_selected', 'analysis_started', 'analysis_completed',
  'dossier_preview', 'dossier_requested', 'callback_requested', 'appointment_booked',
];

export type JourneySummary = {
  lastTrade: string | null;
  lastArea: string | null;
  lastStep: string | null;
  lastActivity: Date | null;
  offerViews: number;
  analyses: number;
};

export type SyncLead = DealLead & {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  company_name: string | null;
  session_id: string | null;
  crm_system?: string | null;
  crm_contact_id?: string | null;
};

const clean = (v: unknown, max = 255): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
};

// HubSpot rejects empty-string updates for some types and we never want to blank a value a person typed in
// HubSpot, so null/undefined summary values are simply left out of the payload.
const compact = (o: Record<string, unknown>): Record<string, unknown> => {
  const r: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== null && v !== undefined && v !== '') r[k] = v;
  return r;
};

export function buildContactProperties(lead: SyncLead, j: JourneySummary): Record<string, unknown> {
  return compact({
    ...journeyLinkProperties(lead.id),
    firstname: clean(lead.first_name),
    lastname: clean(lead.last_name),
    email: lead.email ? lead.email.trim().toLowerCase() : null,
    phone: clean(lead.phone, 40),
    md_search_trade: j.lastTrade,
    md_search_area: j.lastArea,
    md_last_journey_step: j.lastStep === 'view_opportunity' ? 'offer_view' : j.lastStep,
    md_last_site_activity: j.lastActivity ? j.lastActivity.toISOString() : null,
    md_offer_views_count: j.offerViews,
    md_analyses_count: j.analyses,
  });
}

export function buildCompanyProperties(
  siret: string, name: string | null,
  agg: { visitors: number; offerViews: number; analyses: number; lastActivity: Date | null },
  forCreate: boolean
): Record<string, unknown> {
  return compact({
    // The name is only written when the company is created, never overwritten on later syncs.
    name: forCreate ? clean(name, 255) || `SIRET ${siret}` : null,
    md_siret: siret,
    md_last_site_activity: agg.lastActivity ? agg.lastActivity.toISOString() : null,
    md_visitors_count: agg.visitors,
    md_offer_views_count: agg.offerViews,
    md_analyses_count: agg.analyses,
  });
}

// ---------------------------------------------------------------- journal queries

async function journeyForSessions(sessionIds: string[]): Promise<JourneySummary> {
  if (sessionIds.length === 0) {
    return { lastTrade: null, lastArea: null, lastStep: null, lastActivity: null, offerViews: 0, analyses: 0 };
  }
  const counts = await db.query(
    `SELECT
       COUNT(*) FILTER (WHERE event_type IN ('offer_view', 'view_opportunity'))::int AS offer_views,
       COUNT(DISTINCT COALESCE(analysis_id, session_id || ':' || COALESCE(opportunity_id, event_data->>'opportunityId', '')))
         FILTER (WHERE event_type = 'analysis_completed')::int AS analyses,
       MAX(COALESCE(occurred_at, created_at)) AS last_activity
     FROM visitor_events WHERE session_id = ANY($1)`,
    [sessionIds]
  );
  const step = await db.query(
    `SELECT event_type FROM visitor_events
     WHERE session_id = ANY($1) AND event_type = ANY($2)
     ORDER BY COALESCE(occurred_at, created_at) DESC, created_at DESC LIMIT 1`,
    [sessionIds, STEP_CODES]
  );
  const search = await db.query(
    `SELECT event_data FROM visitor_events
     WHERE session_id = ANY($1) AND event_type = 'search'
     ORDER BY COALESCE(occurred_at, created_at) DESC, created_at DESC LIMIT 1`,
    [sessionIds]
  );
  const c = counts.rows[0] || {};
  const sd = search.rows[0]?.event_data || {};
  return {
    lastTrade: clean(sd.q),
    lastArea: clean(sd.location),
    lastStep: step.rows[0]?.event_type || null,
    lastActivity: c.last_activity ? new Date(c.last_activity) : null,
    offerViews: c.offer_views || 0,
    analyses: c.analyses || 0,
  };
}

// ---------------------------------------------------------------- HubSpot HTTP

async function hs<T = any>(cfg: AxiosRequestConfig): Promise<T> {
  const res = await axios.request({
    baseURL: BASE_URL(),
    timeout: 10000,
    ...cfg,
    headers: { Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`, 'Content-Type': 'application/json', ...(cfg.headers || {}) },
  });
  return res.data as T;
}

// Two syncs for the same SIRET / e-mail running at the same moment in this process must not both create the
// object (search-then-create is not atomic). Serialised per key; the retry sweep covers other instances.
const locks = new Map<string, Promise<unknown>>();
async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) || Promise.resolve();
  const run = prev.catch(() => undefined).then(fn);
  locks.set(key, run);
  try { return await run; } finally { if (locks.get(key) === run) locks.delete(key); }
}

async function findOne(object: 'companies' | 'contacts', property: string, value: string): Promise<string | null> {
  const r = await hs<{ results?: { id: string }[] }>({
    method: 'POST', url: `/crm/v3/objects/${object}/search`,
    data: { filterGroups: [{ filters: [{ propertyName: property, operator: 'EQ', value }] }], properties: [property], limit: 1 },
  });
  return r.results?.[0]?.id ? String(r.results[0].id) : null;
}

export async function upsertCompany(siret: string, name: string | null, agg: Parameters<typeof buildCompanyProperties>[2]): Promise<string> {
  return withLock(`company:${siret}`, async () => {
    const existing = await findOne('companies', 'md_siret', siret);
    if (existing) {
      await hs({ method: 'PATCH', url: `/crm/v3/objects/companies/${existing}`, data: { properties: buildCompanyProperties(siret, name, agg, false) } });
      return existing;
    }
    const created = await hs<{ id: string }>({ method: 'POST', url: '/crm/v3/objects/companies', data: { properties: buildCompanyProperties(siret, name, agg, true) } });
    return String(created.id);
  });
}

export async function upsertContact(lead: SyncLead, j: JourneySummary): Promise<string> {
  // A callback request only collects a phone number (no e-mail field in that form): the contact is then identified
  // by that number, still never by the SIRET.
  const email = lead.email ? lead.email.trim().toLowerCase() : '';
  const phone = lead.phone ? String(lead.phone).trim() : '';
  return withLock(`contact:${email || phone}`, async () => {
    let id: string | null = lead.crm_system === 'hubspot' && lead.crm_contact_id ? String(lead.crm_contact_id) : null;
    if (!id && email) id = await findOne('contacts', 'email', email);
    if (!id && !email && phone) id = await findOne('contacts', 'phone', phone);
    const properties = buildContactProperties(lead, j);
    if (id) {
      await hs({ method: 'PATCH', url: `/crm/v3/objects/contacts/${id}`, data: { properties } });
      return id;
    }
    const created = await hs<{ id: string }>({ method: 'POST', url: '/crm/v3/objects/contacts', data: { properties } });
    return String(created.id);
  });
}

// Default (unlabelled) contact -> company association; PUT is idempotent.
export async function associateContactWithCompany(contactId: string, companyId: string): Promise<void> {
  await hs({ method: 'PUT', url: `/crm/v4/objects/contacts/${contactId}/associations/default/companies/${companyId}` });
}

// ---------------------------------------------------------------- entry point used by crmSyncService

export async function syncLeadToHubspot(lead: SyncLead): Promise<{ contactId: string; companyId: string | null }> {
  if (!isHubspotConfigured()) throw new Error('HUBSPOT_ACCESS_TOKEN not configured');
  if (!lead.email && !lead.phone) throw new Error('Lead has no e-mail and no phone: a HubSpot contact cannot be identified');

  // The contact's journey = every session that ever left this e-mail (or, without e-mail, this phone) on a lead.
  const sessions = lead.email
    ? await db.query(`SELECT DISTINCT session_id FROM crm_leads WHERE lower(email) = lower($1) AND session_id IS NOT NULL`, [lead.email])
    : await db.query(`SELECT DISTINCT session_id FROM crm_leads WHERE email IS NULL AND phone = $1 AND session_id IS NOT NULL`, [lead.phone]);
  const sessionIds: string[] = sessions.rows.map((r: any) => r.session_id);
  if (lead.session_id && !sessionIds.includes(lead.session_id)) sessionIds.push(lead.session_id);

  const contactJourney = await journeyForSessions(sessionIds);
  const contactId = await upsertContact(lead, contactJourney);

  // SIRET of the company this contact chose (the most recent lookup among their sessions).
  const lookup = sessionIds.length
    ? await db.query(
        `SELECT siret, company_data FROM siret_lookups WHERE session_id = ANY($1) ORDER BY created_at DESC LIMIT 1`,
        [sessionIds]
      )
    : { rows: [] as any[] };
  const siret: string | null = lookup.rows[0]?.siret && /^\d{14}$/.test(lookup.rows[0].siret) ? lookup.rows[0].siret : null;
  if (!siret) {
    await syncDealForLead(lead, contactId, null);
    return { contactId, companyId: null };
  }

  // Company summary = ALL visitors (sessions) that selected this SIRET, not only this contact.
  const all = await db.query(`SELECT session_id FROM siret_lookups WHERE siret = $1`, [siret]);
  const companySessions: string[] = all.rows.map((r: any) => r.session_id);
  const cj = await journeyForSessions(companySessions);
  const companyId = await upsertCompany(
    siret,
    clean(lookup.rows[0]?.company_data?.name) || clean(lead.company_name),
    { visitors: companySessions.length, offerViews: cj.offerViews, analyses: cj.analyses, lastActivity: cj.lastActivity }
  );
  await associateContactWithCompany(contactId, companyId);
  await syncDealForLead(lead, contactId, companyId);
  return { contactId, companyId };
}

// Short, secret-free description of a failure for crm_leads.crm_last_error (the error journal of the brief).
export function describeHubspotError(err: any): string {
  const status = err?.response?.status;
  const data = err?.response?.data;
  const msg = clean(data?.message, 300) || clean(err?.message, 300) || 'unknown error';
  const cat = clean(data?.category, 60);
  return [status ? `HTTP ${status}` : 'no response', cat, msg].filter(Boolean).join(' - ').replace(/Bearer\s+\S+/gi, 'Bearer ***');
}


// ---------------------------------------------------------------- Diagnostic

export const EXPECTED_HUBSPOT_PORTAL_ID = (process.env.HUBSPOT_PORTAL_ID || '149642063').trim();
const MD_PIPELINE_ID = '4280487115';

// Answers "why does nothing reach HubSpot?" without exposing the token: which env vars are set, whether the token
// belongs to the expected portal, whether the pipeline is reachable, and how many leads are stuck per sync status.
export async function hubspotDiagnostic() {
  const crmSystem = (process.env.CRM_SYSTEM || 'pipedrive').toLowerCase();
  const out: any = {
    crmSystem,
    crmSystemIsHubspot: crmSystem === 'hubspot',
    tokenPresent: isHubspotConfigured(),
    expectedPortalId: EXPECTED_HUBSPOT_PORTAL_ID,
    api: { reachable: false, portalId: null as string | null, portalMatches: false, error: null as string | null },
    pipeline: { found: false, error: null as string | null },
    leadsBySyncStatus: {} as Record<string, number>,
    lastErrors: [] as Array<{ id: string; error: string | null; at: Date | null }>,
    verdict: [] as string[],
  };
  if (!out.crmSystemIsHubspot) out.verdict.push(`CRM_SYSTEM is "${crmSystem}", not "hubspot": syncLeadToCrm never calls HubSpot.`);
  if (!out.tokenPresent) out.verdict.push('HUBSPOT_ACCESS_TOKEN is missing on this server: sync is skipped and leads stay pending.');
  if (out.tokenPresent) {
    try {
      const info: any = await hs({ method: 'GET', url: '/account-info/v3/details' });
      out.api.reachable = true;
      out.api.portalId = String(info.portalId);
      out.api.portalMatches = out.api.portalId === EXPECTED_HUBSPOT_PORTAL_ID;
      if (!out.api.portalMatches) out.verdict.push(`Token belongs to portal ${out.api.portalId}, expected ${EXPECTED_HUBSPOT_PORTAL_ID}.`);
    } catch (e: any) {
      out.api.error = `${e?.response?.status || ''} ${e?.response?.data?.message || e?.message || 'error'}`.trim();
      out.verdict.push(`HubSpot API call failed: ${out.api.error} (401 = bad token, 403 = missing scope).`);
    }
    try {
      await hs({ method: 'GET', url: `/crm/v3/pipelines/deals/${MD_PIPELINE_ID}` });
      out.pipeline.found = true;
    } catch (e: any) {
      out.pipeline.error = `${e?.response?.status || ''} ${e?.response?.data?.message || e?.message || 'error'}`.trim();
      out.verdict.push(`Pipeline ${MD_PIPELINE_ID} not readable: ${out.pipeline.error}`);
    }
  }
  try {
    const r = await db.query(`SELECT COALESCE(crm_sync_status,'null') AS s, COUNT(*)::int AS n FROM crm_leads GROUP BY 1`);
    for (const row of r.rows) out.leadsBySyncStatus[row.s] = row.n;
    const e = await db.query(`SELECT id, crm_last_error, crm_last_sync FROM crm_leads WHERE crm_last_error IS NOT NULL ORDER BY crm_last_sync DESC NULLS LAST LIMIT 5`);
    out.lastErrors = e.rows.map((x: any) => ({ id: x.id, error: x.crm_last_error, at: x.crm_last_sync }));
  } catch (e: any) {
    out.verdict.push(`Could not read crm_leads: ${e?.message}`);
  }
  if (!out.verdict.length) out.verdict.push('Configuration looks correct.');
  return out;
}
