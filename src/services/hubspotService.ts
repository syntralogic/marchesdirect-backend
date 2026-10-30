import axios, { AxiosRequestConfig } from 'axios';
import { db } from '../config/database';
import { logger } from '../utils/logger';

// ============================================================================
// HUBSPOT CRM INTEGRATION
//
// Client brief (29 Oct): follow the visitor journey (SIRET typed, phone given,
// searches, announcements viewed, contact requests) and attach it to the
// HubSpot contact AND its company, so sales can follow up with a clear
// history.
//
// How it is split:
//   * Server side (this file): identity + history. Contacts, companies, the
//     contact<->company association, one note per request and one "parcours"
//     note per batch of visitor_events, plus a few summary properties.
//   * Browser side (frontend src/lib/hubspot.ts): HubSpot's tracking script
//     (page views, UTM / campaign source) + identify(email). Consent-gated.
//
// Auth: a HubSpot Service Key / Private App token in HUBSPOT_ACCESS_TOKEN
// (backend env ONLY, never in the frontend). Scopes needed:
//   crm.objects.contacts.read/write, crm.objects.companies.read/write
//   crm.schemas.contacts.write, crm.schemas.companies.write (one-time creation
//   of the custom properties below; optional - without it the sync still works
//   with the standard properties only and logs a warning)
//   plus whatever HubSpot lists for "notes" if a 403 mentions a missing scope.
//
// Everything here is best-effort: callers never let a HubSpot failure break a
// visitor request (see crmSyncService.ts / jobs/hubspotJourney.ts).
// ============================================================================

const HS_BASE = process.env.HUBSPOT_API_BASE || 'https://api.hubapi.com';
const NOTE_TO_CONTACT = 202; // HubSpot-defined association type ids
const NOTE_TO_COMPANY = 190;
const MAX_NOTE_CHARS = 60000; // hs_note_body hard limit is 65536
const MAX_EVENTS_PER_NOTE = 60;

export const CUSTOM_PROPERTY_GROUP = 'marchesdirect';

// Custom properties this integration writes. Created once by ensureHubspotProperties().
export const CONTACT_CUSTOM_PROPERTIES: Array<{ name: string; label: string; type: 'string' | 'number'; fieldType: 'text' | 'number' }> = [
  { name: 'md_siret', label: 'MD - SIRET', type: 'string', fieldType: 'text' },
  { name: 'md_session_id', label: 'MD - Session visiteur', type: 'string', fieldType: 'text' },
  { name: 'md_lead_source', label: 'MD - Source du lead', type: 'string', fieldType: 'text' },
  { name: 'md_last_search', label: 'MD - Dernière recherche', type: 'string', fieldType: 'text' },
  { name: 'md_last_opportunity_viewed', label: 'MD - Dernière annonce consultée', type: 'string', fieldType: 'text' },
  { name: 'md_searches_count', label: 'MD - Nombre de recherches', type: 'number', fieldType: 'number' },
  { name: 'md_opportunities_viewed', label: 'MD - Annonces consultées', type: 'number', fieldType: 'number' },
  { name: 'md_last_request', label: 'MD - Dernière demande', type: 'string', fieldType: 'text' },
];
export const COMPANY_CUSTOM_PROPERTIES: typeof CONTACT_CUSTOM_PROPERTIES = [
  { name: 'siret', label: 'SIRET', type: 'string', fieldType: 'text' },
];
const CUSTOM_NAMES = new Set([...CONTACT_CUSTOM_PROPERTIES, ...COMPANY_CUSTOM_PROPERTIES].map((p) => p.name));

export const isHubspotConfigured = (): boolean => !!process.env.HUBSPOT_ACCESS_TOKEN;

// ---------------------------------------------------------------------------
// HTTP layer: bearer auth, timeout, and a small retry for 429 / 5xx / network.
// ---------------------------------------------------------------------------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class HubspotError extends Error {
  status?: number;
  data?: any;
  constructor(message: string, status?: number, data?: any) {
    super(message);
    this.name = 'HubspotError';
    this.status = status;
    this.data = data;
  }
}

async function hs<T = any>(config: AxiosRequestConfig, attempt = 1): Promise<T> {
  const token = process.env.HUBSPOT_ACCESS_TOKEN;
  if (!token) throw new HubspotError('HUBSPOT_ACCESS_TOKEN not configured');
  try {
    const res = await axios.request<T>({
      baseURL: HS_BASE,
      timeout: 10000,
      ...config,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(config.headers || {}) },
    });
    return res.data;
  } catch (err: any) {
    const status: number | undefined = err?.response?.status;
    const retryable = status === 429 || (status !== undefined && status >= 500) || (!status && !!err?.code);
    if (retryable && attempt < 3) {
      const retryAfter = Number(err?.response?.headers?.['retry-after']);
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 10) * 1000 : 500 * attempt * attempt);
      return hs<T>(config, attempt + 1);
    }
    // Never put the token / full request in the message: only what HubSpot said.
    const detail = err?.response?.data?.message || err?.message || 'HubSpot request failed';
    throw new HubspotError(`HubSpot ${config.method || 'GET'} ${config.url} -> ${status ?? 'network'}: ${detail}`, status, err?.response?.data);
  }
}

const isMissingProperty = (e: unknown): boolean =>
  e instanceof HubspotError && e.status === 400 && JSON.stringify(e.data || '').includes('PROPERTY_DOESNT_EXIST');

let warnedMissingProps = false;
const stripCustom = (props: Record<string, string | number>): Record<string, string | number> => {
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(props)) if (!CUSTOM_NAMES.has(k)) out[k] = v;
  return out;
};
const clean = (props: Record<string, string | number | null | undefined | false>): Record<string, string | number> => {
  // Only send what we actually know: never blank out a value already in HubSpot.
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false || v === '') continue;
    out[k] = typeof v === 'number' ? v : String(v);
  }
  return out;
};

// Run a create/update with the custom properties, and if they have not been
// created in this portal yet, retry once with the standard ones only.
async function withPropertyFallback<T>(run: (props: Record<string, string | number>) => Promise<T>, props: Record<string, string | number>): Promise<T> {
  try {
    return await run(props);
  } catch (err) {
    if (isMissingProperty(err) && Object.keys(stripCustom(props)).length !== Object.keys(props).length) {
      if (!warnedMissingProps) {
        warnedMissingProps = true;
        logger.warn('[HubSpot] custom properties are missing in this portal - syncing standard properties only. Run `npm run hubspot:setup` (needs crm.schemas.*.write) to create them.');
      }
      return run(stripCustom(props));
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------
async function searchOne(objectType: 'contacts' | 'companies', propertyName: string, value: string): Promise<string | null> {
  const data = await hs<{ results?: Array<{ id: string }> }>({
    method: 'POST',
    url: `/crm/v3/objects/${objectType}/search`,
    data: { filterGroups: [{ filters: [{ propertyName, operator: 'EQ', value }] }], properties: [propertyName], limit: 1 },
  });
  return data.results?.[0]?.id ?? null;
}

export interface ContactInput {
  email?: string | null;
  phone?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  companyName?: string | null;
  city?: string | null;
  siret?: string | null;
  sessionId?: string | null;
  leadSource?: string | null;
  extra?: Record<string, string | number | null | undefined>;
}

export function contactProperties(c: ContactInput): Record<string, string | number> {
  return clean({
    email: c.email ? c.email.toLowerCase() : null,
    phone: c.phone,
    firstname: c.firstName,
    lastname: c.lastName,
    company: c.companyName,
    city: c.city,
    md_siret: c.siret,
    md_session_id: c.sessionId,
    md_lead_source: c.leadSource,
    ...(c.extra || {}),
  });
}

export async function upsertContact(c: ContactInput): Promise<string> {
  if (!c.email && !c.phone) throw new HubspotError('Contact needs an email or a phone');
  const props = contactProperties(c);

  let id: string | null = null;
  if (c.email) id = await searchOne('contacts', 'email', c.email.toLowerCase());
  if (!id && c.phone) id = await searchOne('contacts', 'phone', c.phone);

  if (id) {
    const existingId = id;
    await withPropertyFallback((p) => hs({ method: 'PATCH', url: `/crm/v3/objects/contacts/${existingId}`, data: { properties: p } }), props);
    return id;
  }
  try {
    const created = await withPropertyFallback(
      (p) => hs<{ id: string }>({ method: 'POST', url: '/crm/v3/objects/contacts', data: { properties: p } }),
      props
    );
    return created.id;
  } catch (err) {
    // Lost a race with another request that just created it: reuse that contact.
    if (err instanceof HubspotError && err.status === 409) {
      const m = /Existing ID:\s*(\d+)/i.exec(String(err.data?.message || ''));
      if (m) {
        await withPropertyFallback((p) => hs({ method: 'PATCH', url: `/crm/v3/objects/contacts/${m[1]}`, data: { properties: p } }), props);
        return m[1];
      }
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Companies (SIRET is the identity when we have it, else the exact name)
// ---------------------------------------------------------------------------
export async function upsertCompany(input: { siret?: string | null; name?: string | null; city?: string | null }): Promise<string | null> {
  const siret = input.siret ? String(input.siret).replace(/\s+/g, '') : null;
  const name = input.name ? String(input.name).trim() : null;
  if (!siret && !name) return null;

  let id: string | null = null;
  if (siret) {
    try {
      id = await searchOne('companies', 'siret', siret);
    } catch (err) {
      // `siret` property not created yet: fall through to the name lookup.
      if (!(err instanceof HubspotError && err.status === 400)) throw err;
    }
  }
  if (!id && name) id = await searchOne('companies', 'name', name);

  const props = clean({ name, city: input.city, siret });
  if (id) {
    const existingId = id;
    await withPropertyFallback((p) => hs({ method: 'PATCH', url: `/crm/v3/objects/companies/${existingId}`, data: { properties: p } }), props);
    return id;
  }
  const created = await withPropertyFallback(
    (p) => hs<{ id: string }>({ method: 'POST', url: '/crm/v3/objects/companies', data: { properties: p } }),
    { ...props, ...(name ? {} : { name: `SIRET ${siret}` }) }
  );
  return created.id;
}

export async function associateContactWithCompany(contactId: string, companyId: string): Promise<void> {
  // Default (unlabelled) contact -> company association; idempotent in HubSpot.
  await hs({ method: 'PUT', url: `/crm/v4/objects/contacts/${contactId}/associations/default/companies/${companyId}` });
}

// ---------------------------------------------------------------------------
// Notes (timeline entries on the contact and on the company)
// ---------------------------------------------------------------------------
const esc = (s: unknown): string =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export async function createNote(input: { html: string; contactId: string; companyId?: string | null; at?: Date }): Promise<string> {
  const associations: any[] = [
    { to: { id: input.contactId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: NOTE_TO_CONTACT }] },
  ];
  if (input.companyId) {
    associations.push({ to: { id: input.companyId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: NOTE_TO_COMPANY }] });
  }
  const created = await hs<{ id: string }>({
    method: 'POST',
    url: '/crm/v3/objects/notes',
    data: {
      properties: { hs_note_body: input.html.slice(0, MAX_NOTE_CHARS), hs_timestamp: (input.at || new Date()).toISOString() },
      associations,
    },
  });
  return created.id;
}

// ---------------------------------------------------------------------------
// Journey: pure builders (unit-tested) ...
// ---------------------------------------------------------------------------
export interface JourneyEvent {
  event_type: string;
  event_label: string | null;
  event_data?: any;
  created_at: Date | string;
}

const PARIS = 'Europe/Paris';
const fmtWhen = (d: Date | string): string =>
  new Date(d).toLocaleString('fr-FR', { timeZone: PARIS, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

export function describeEvent(e: JourneyEvent): string {
  const label = (e.event_label || '').trim();
  switch (e.event_type) {
    case 'search': return label.replace(/^Recherche\s*:\s*/i, '') ? `Recherche : ${label.replace(/^Recherche\s*:\s*/i, '')}` : 'Recherche';
    case 'view_opportunity': return `Annonce consultée : ${label || 'sans titre'}`;
    case 'view_seo_page': return `Page consultée : ${label || 'page de présentation'}`;
    case 'company_identified': return 'Entreprise identifiée (SIRET saisi)';
    case 'concordance_shown': return 'Analyse de concordance affichée';
    case 'form_started': return label || 'Formulaire commencé';
    case 'request_submitted': return label || 'Demande enregistrée';
    default: return label || e.event_type;
  }
}

export function buildJourneyNoteHtml(events: JourneyEvent[], title = 'Parcours sur Marchés Direct'): string {
  const shown = events.slice(-MAX_EVENTS_PER_NOTE);
  const skipped = events.length - shown.length;
  const items = shown.map((e) => `<li>${esc(fmtWhen(e.created_at))} — ${esc(describeEvent(e))}</li>`).join('');
  return `<p><strong>${esc(title)}</strong> (${events.length} action${events.length > 1 ? 's' : ''})</p>` +
    (skipped > 0 ? `<p><em>${skipped} action(s) plus anciennes non listées.</em></p>` : '') +
    `<ul>${items}</ul>`;
}

export interface JourneySummary {
  searches: number;
  opportunitiesViewed: number;
  lastSearch: string | null;
  lastOpportunity: string | null;
}

export function summarizeJourney(events: JourneyEvent[]): JourneySummary {
  const opps = new Set<string>();
  let searches = 0, lastSearch: string | null = null, lastOpportunity: string | null = null;
  for (const e of events) {
    if (e.event_type === 'search') {
      searches++;
      lastSearch = (e.event_label || '').replace(/^Recherche\s*:\s*/i, '').trim() || lastSearch;
    } else if (e.event_type === 'view_opportunity') {
      const key = e.event_data?.opportunityId || e.event_label || String(opps.size);
      opps.add(String(key));
      lastOpportunity = (e.event_label || '').trim() || lastOpportunity;
    }
  }
  return { searches, opportunitiesViewed: opps.size, lastSearch, lastOpportunity };
}

// ---------------------------------------------------------------------------
// ... and the DB-backed sync.
// hubspot_sessions maps a browser session to its HubSpot contact/company once
// the visitor is identified, and remembers how far the journey was pushed.
// ---------------------------------------------------------------------------
async function loadEvents(sessionId: string, after?: Date | string | null): Promise<JourneyEvent[]> {
  const r = await db.query(
    `SELECT event_type, event_label, event_data, created_at FROM visitor_events
     WHERE session_id = $1 AND ($2::timestamptz IS NULL OR created_at > $2::timestamptz)
     ORDER BY created_at ASC LIMIT 500`,
    [sessionId, after || null]
  );
  return r.rows;
}

/**
 * Link a browser session to a HubSpot contact (+company) and push the journey
 * recorded so far. Idempotent: only events newer than the last push are sent.
 */
export async function linkSessionAndPushJourney(sessionId: string, contactId: string, companyId: string | null, email?: string | null): Promise<number> {
  const prev = await db.query('SELECT last_event_at FROM hubspot_sessions WHERE session_id = $1', [sessionId]);
  const after: Date | null = prev.rows[0]?.last_event_at ?? null;
  const events = await loadEvents(sessionId, after);

  if (events.length > 0) {
    await createNote({ html: buildJourneyNoteHtml(events), contactId, companyId, at: new Date(events[events.length - 1].created_at) });
    const all = after ? await loadEvents(sessionId) : events;
    const s = summarizeJourney(all);
    await withPropertyFallback(
      (p) => hs({ method: 'PATCH', url: `/crm/v3/objects/contacts/${contactId}`, data: { properties: p } }),
      clean({
        md_searches_count: s.searches,
        md_opportunities_viewed: s.opportunitiesViewed,
        md_last_search: s.lastSearch,
        md_last_opportunity_viewed: s.lastOpportunity,
      })
    );
  }

  const lastAt = events.length > 0 ? events[events.length - 1].created_at : after;
  await db.query(
    `INSERT INTO hubspot_sessions (session_id, contact_id, company_id, email, last_event_at, synced_at)
     VALUES ($1, $2, $3, $4, COALESCE($5::timestamptz, NOW()), NOW())
     ON CONFLICT (session_id) DO UPDATE SET
       contact_id = EXCLUDED.contact_id,
       company_id = COALESCE(EXCLUDED.company_id, hubspot_sessions.company_id),
       email = COALESCE(EXCLUDED.email, hubspot_sessions.email),
       last_event_at = COALESCE($5::timestamptz, hubspot_sessions.last_event_at, NOW()),
       synced_at = NOW()`,
    [sessionId, contactId, companyId, email || null, lastAt || null]
  );
  return events.length;
}

/** Visitor identified through the SIRET + phone/e-mail gate (siret_lookups). */
export async function syncIdentifiedSession(sessionId: string): Promise<{ contactId: string; companyId: string | null } | null> {
  if (!isHubspotConfigured()) return null;
  const r = await db.query(
    `SELECT siret, company_data, phone, email, lead_captured_at FROM siret_lookups WHERE session_id = $1`,
    [sessionId]
  );
  const row = r.rows[0];
  if (!row || !row.lead_captured_at || (!row.email && !row.phone)) return null;

  const companyName: string | null = row.company_data?.name || null;
  const city: string | null = row.company_data?.city || row.company_data?.commune || null;
  const companyId = await upsertCompany({ siret: row.siret, name: companyName, city });
  const contactId = await upsertContact({
    email: row.email, phone: row.phone, companyName, city, siret: row.siret, sessionId, leadSource: 'siret_gate',
  });
  if (companyId) await associateContactWithCompany(contactId, companyId);

  // One identification note, only the first time this session is linked.
  const already = await db.query('SELECT 1 FROM hubspot_sessions WHERE session_id = $1', [sessionId]);
  if (already.rows.length === 0) {
    await createNote({
      contactId, companyId,
      html: `<p><strong>Coordonnées saisies sur Marchés Direct</strong></p><ul>` +
        `<li>Entreprise : ${esc(companyName || 'inconnue')}${row.siret ? ` (SIRET ${esc(row.siret)})` : ''}</li>` +
        (row.phone ? `<li>Téléphone : ${esc(row.phone)}</li>` : '') +
        (row.email ? `<li>E-mail : ${esc(row.email)}</li>` : '') + `</ul>`,
    });
  }
  await linkSessionAndPushJourney(sessionId, contactId, companyId, row.email);
  return { contactId, companyId };
}

/** Push events that arrived after the last push, for an already-linked session. */
export async function syncSessionJourney(sessionId: string): Promise<number> {
  if (!isHubspotConfigured()) return 0;
  const m = await db.query('SELECT contact_id, company_id, email FROM hubspot_sessions WHERE session_id = $1', [sessionId]);
  if (m.rows.length === 0) return 0;
  const { contact_id, company_id, email } = m.rows[0];
  return linkSessionAndPushJourney(sessionId, contact_id, company_id, email);
}

/** Sessions that need work: identified but not linked yet, and linked with new events. */
export async function pendingSessions(limit = 25): Promise<{ toIdentify: string[]; toUpdate: string[] }> {
  const a = await db.query(
    `SELECT s.session_id FROM siret_lookups s
       LEFT JOIN hubspot_sessions h ON h.session_id = s.session_id
      WHERE s.lead_captured_at IS NOT NULL AND h.session_id IS NULL
        AND s.lead_captured_at > NOW() - INTERVAL '7 days'
      ORDER BY s.lead_captured_at ASC LIMIT $1`,
    [limit]
  );
  const b = await db.query(
    `SELECT h.session_id FROM hubspot_sessions h
      WHERE EXISTS (SELECT 1 FROM visitor_events e WHERE e.session_id = h.session_id AND e.created_at > h.last_event_at)
      ORDER BY h.synced_at ASC LIMIT $1`,
    [limit]
  );
  return { toIdentify: a.rows.map((x: any) => x.session_id), toUpdate: b.rows.map((x: any) => x.session_id) };
}

// ---------------------------------------------------------------------------
// One-time setup + health check
// ---------------------------------------------------------------------------
export async function ensureHubspotProperties(): Promise<{ created: string[]; existing: string[]; failed: string[] }> {
  const res = { created: [] as string[], existing: [] as string[], failed: [] as string[] };
  const targets: Array<['contacts' | 'companies', typeof CONTACT_CUSTOM_PROPERTIES]> = [
    ['contacts', CONTACT_CUSTOM_PROPERTIES],
    ['companies', COMPANY_CUSTOM_PROPERTIES],
  ];
  for (const [objectType, props] of targets) {
    try {
      await hs({
        method: 'POST', url: `/crm/v3/properties/${objectType}/groups`,
        data: { name: CUSTOM_PROPERTY_GROUP, label: 'Marchés Direct', displayOrder: -1 },
      });
    } catch (err) {
      if (!(err instanceof HubspotError && err.status === 409)) logger.warn('[HubSpot] could not create property group (continuing):', err);
    }
    for (const p of props) {
      try {
        await hs({
          method: 'POST', url: `/crm/v3/properties/${objectType}`,
          data: { name: p.name, label: p.label, type: p.type, fieldType: p.fieldType, groupName: CUSTOM_PROPERTY_GROUP },
        });
        res.created.push(`${objectType}.${p.name}`);
      } catch (err) {
        if (err instanceof HubspotError && err.status === 409) res.existing.push(`${objectType}.${p.name}`);
        else { res.failed.push(`${objectType}.${p.name}`); logger.warn(`[HubSpot] could not create ${objectType}.${p.name}:`, err); }
      }
    }
  }
  return res;
}

export async function pingHubspot(): Promise<{ ok: boolean; status?: number; message?: string }> {
  if (!isHubspotConfigured()) return { ok: false, message: 'HUBSPOT_ACCESS_TOKEN is not set' };
  try {
    await hs({ method: 'GET', url: '/crm/v3/objects/contacts', params: { limit: 1 } });
    return { ok: true };
  } catch (err: any) {
    return { ok: false, status: err?.status, message: err?.message };
  }
}
