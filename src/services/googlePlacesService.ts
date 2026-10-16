import axios from 'axios';
import { db } from '../config/database';
import { logger } from '../utils/logger';

// Google Business Profile data through the official Places API (New), Text Search.
// https://places.googleapis.com/v1/places:searchText
//
// COST GUARD (client requirement: "no additional API costs without approval"):
// calls are made ONLY when BOTH are set on the backend:
//   GOOGLE_PLACES_API_KEY   - key stored server-side only, never sent to the browser
//   GOOGLE_PLACES_ENABLED=true  - explicit approval switch
// and each day is hard-capped by GOOGLE_PLACES_DAILY_CAP (default 0 = no call).
// Requesting rating / review count / website / phone fields bills a higher
// "Enterprise" Text Search SKU - check price and free allowance in the Cloud console
// and set a budget alert + API quota there too (second line of defence).
//
// WHAT THE OFFICIAL API CANNOT GIVE: the share / count of POSITIVE reviews. Places
// returns the average rating, the total review count and at most 5 sample reviews
// (never the star distribution). Those fields are therefore stored as
// "unavailable" (needs a licensed review-data provider), never estimated.
//
// TERMS NOTE: Google's Maps Platform terms restrict long-term storage of Places
// content other than place_id. Values are stored with google_fetched_at and are meant
// to be refreshed; confirm with the client that their licence allows this storage.

const URL_ = process.env.PLACES_BASE || 'https://places.googleapis.com/v1/places:searchText';
export const FIELD_MASK = [
  'places.id', 'places.displayName', 'places.formattedAddress', 'places.location',
  'places.rating', 'places.userRatingCount', 'places.googleMapsUri', 'places.websiteUri',
  'places.nationalPhoneNumber', 'places.businessStatus',
].join(',');
export const MIN_CONFIDENCE = 0.8;

// ---------------------------------------------------------------------------
// Part 7 - ONE guarded client for every Google Places call in the backend.
// Prospect enrichment AND the SIRET "company presence" lookup both go through
// googlePlacesSearch(), so the approval switch, the daily cap, the error handling
// and the key redaction cannot be bypassed by a second code path.
// ---------------------------------------------------------------------------
export type GoogleErrorCode =
  | 'API_KEY_INVALID' | 'API_NOT_ENABLED' | 'BILLING_DISABLED' | 'KEY_RESTRICTED' | 'PERMISSION_DENIED'
  | 'QUOTA_EXCEEDED' | 'BAD_REQUEST' | 'NOT_FOUND' | 'SERVER_ERROR' | 'NETWORK' | 'UNKNOWN'
  | 'NOT_READY' | 'CIRCUIT_OPEN';

export interface GoogleErrorInfo { code: GoogleErrorCode; status?: number; message: string; hint: string; fatal: boolean; retryable: boolean }

/** Never let a Google key reach a log line, a DB column or an API response. */
export function redactSecrets(input: unknown): string {
  let t = String(input ?? '');
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (key && key.length >= 8) t = t.split(key).join('[clé masquée]');
  return t.replace(/AIza[0-9A-Za-z_\-]{20,}/g, '[clé masquée]').replace(/key=[^&\s"']+/gi, 'key=[masquée]');
}

const HINTS: Record<GoogleErrorCode, string> = {
  API_KEY_INVALID: 'Clé API invalide ou expirée: vérifier GOOGLE_PLACES_API_KEY (Google Cloud › API et services › Identifiants).',
  API_NOT_ENABLED: 'L’API « Places API (New) » n’est pas activée sur le projet: l’activer dans Google Cloud › API et services › Bibliothèque (ne pas confondre avec l’ancienne « Places API »).',
  BILLING_DISABLED: 'La facturation n’est pas activée sur le projet Google Cloud: associer un compte de facturation (et définir une alerte de budget).',
  KEY_RESTRICTED: 'La clé est restreinte (API, adresse IP ou référent) et refuse cet appel: autoriser « Places API (New) » et l’adresse IP sortante du serveur; une clé serveur ne doit pas être restreinte par référent HTTP.',
  PERMISSION_DENIED: 'Accès refusé par Google: vérifier les droits du projet et les restrictions de la clé.',
  QUOTA_EXCEEDED: 'Quota Google dépassé (par minute ou par jour): attendre, ou ajuster le quota dans Google Cloud › Quotas.',
  BAD_REQUEST: 'Requête refusée par Google pour cette entreprise (données inhabituelles): enregistrement ignoré, à relancer plus tard.',
  NOT_FOUND: 'Ressource Google introuvable.',
  SERVER_ERROR: 'Erreur temporaire côté Google: nouvel essai automatique.',
  NETWORK: 'Erreur réseau temporaire vers Google: nouvel essai automatique.',
  UNKNOWN: 'Réponse inattendue de Google: consulter les journaux du serveur.',
  NOT_READY: 'Intégration Google non activée (clé, approbation ou plafond manquant).',
  CIRCUIT_OPEN: 'Appels Google suspendus temporairement après une erreur de configuration: corriger puis utiliser « Tester la connexion ».',
};
const FATAL_CODES = new Set<GoogleErrorCode>(['API_KEY_INVALID', 'API_NOT_ENABLED', 'BILLING_DISABLED', 'KEY_RESTRICTED', 'PERMISSION_DENIED', 'QUOTA_EXCEEDED']);

/** Turn an axios/Google error into a stable code + French remediation hint. Pure, no I/O. */
export function classifyGoogleError(err: any): GoogleErrorInfo {
  const status: number | undefined = err?.response?.status;
  const body = err?.response?.data?.error;
  const reasons: string[] = (Array.isArray(body?.details) ? body.details : []).map((d: any) => String(d?.reason || '')).filter(Boolean);
  const message = redactSecrets(body?.message || err?.message || 'erreur inconnue');
  const mk = (code: GoogleErrorCode, retryable = false, fatal = FATAL_CODES.has(code)): GoogleErrorInfo =>
    ({ code, status, message, hint: HINTS[code], fatal, retryable });
  const has = (...r: string[]) => r.some(x => reasons.includes(x));

  if (!err?.response) return mk('NETWORK', true);
  if (has('API_KEY_INVALID', 'API_KEY_EXPIRED') || status === 401 || /api key (not valid|expired)|invalid api key/i.test(message)) return mk('API_KEY_INVALID');
  if (has('SERVICE_DISABLED') || /has not been used in project|is disabled|not (been )?enabled/i.test(message)) return mk('API_NOT_ENABLED');
  if (has('BILLING_DISABLED') || /billing/i.test(message)) return mk('BILLING_DISABLED');
  if (has('API_KEY_SERVICE_BLOCKED', 'API_KEY_IP_ADDRESS_BLOCKED', 'API_KEY_HTTP_REFERRER_BLOCKED', 'API_KEY_ANDROID_APP_BLOCKED', 'API_KEY_IOS_APP_BLOCKED')
      || /requests? from (this )?(ip|referer|referrer)|are blocked|api_key_.*_blocked/i.test(message)) return mk('KEY_RESTRICTED');
  if (status === 403) return mk('PERMISSION_DENIED');
  if (status === 429 || body?.status === 'RESOURCE_EXHAUSTED') return mk('QUOTA_EXCEEDED');
  if (status === 404) return mk('NOT_FOUND');
  if (status !== undefined && status >= 500) return mk('SERVER_ERROR', true);
  if (status === 400) {
    // A malformed field mask would fail for EVERY row: stop the run instead of burning the daily cap.
    const systemic = /field ?mask|unknown name|invalid.*field/i.test(message);
    return mk('BAD_REQUEST', false, systemic);
  }
  return mk('UNKNOWN');
}

/** Fatal: invalid/restricted key, API not enabled, billing off, quota hit. The run must stop. */
export class GoogleAuthOrQuotaError extends Error {
  constructor(message: string, public status?: number, public code: GoogleErrorCode = 'UNKNOWN', public hint?: string) { super(message); }
}
/** Row-level failure (bad request, exhausted retries): this record is marked "error", the run continues. */
export class GoogleRequestError extends Error {
  constructor(message: string, public code: GoogleErrorCode, public status?: number) { super(message); }
}
/** The daily cap is reached: nothing was sent to Google. */
export class GoogleCapReachedError extends Error {
  constructor(public cap: number) { super(`plafond quotidien atteint (${cap})`); }
}

export interface GoogleLastError { code: string; message: string; hint: string | null; at: string }
export interface GoogleStatus {
  state: 'disabled_no_key' | 'disabled_not_approved' | 'cap_zero' | 'ready';
  keyConfigured: boolean; approved: boolean; dailyCap: number; usedToday: number;
  message: string;
  lastOkAt: string | null; lastError: GoogleLastError | null; circuitOpenUntil: string | null;
}

function configState() {
  const keyConfigured = !!process.env.GOOGLE_PLACES_API_KEY;
  const approved = process.env.GOOGLE_PLACES_ENABLED === 'true';
  const dailyCap = Math.max(0, parseInt(process.env.GOOGLE_PLACES_DAILY_CAP || '0', 10) || 0);
  return { keyConfigured, approved, dailyCap };
}
export type GoogleReadiness = { ready: true; dailyCap: number } | { ready: false; message: string };
/** Synchronous guard shared by every caller: key + explicit approval + non-zero daily cap. */
export function googleReadiness(): GoogleReadiness {
  const { keyConfigured, approved, dailyCap } = configState();
  if (!keyConfigured) return { ready: false, message: 'GOOGLE_PLACES_API_KEY non configurée sur le backend: aucun appel Google n’est effectué.' };
  if (!approved) return { ready: false, message: 'Clé présente mais GOOGLE_PLACES_ENABLED n’est pas « true »: appels bloqués tant que les coûts ne sont pas approuvés.' };
  if (dailyCap === 0) return { ready: false, message: 'GOOGLE_PLACES_DAILY_CAP = 0: définir un plafond quotidien approuvé pour activer les appels.' };
  return { ready: true, dailyCap };
}

export async function googleStatus(): Promise<GoogleStatus> {
  const { keyConfigured, approved, dailyCap } = configState();
  let usedToday = 0; let lastOkAt: string | null = null; let lastError: GoogleLastError | null = null;
  try {
    const r = await db.query(`SELECT calls FROM prospect_api_usage WHERE provider = 'google_places' AND day = CURRENT_DATE`);
    usedToday = r.rows[0]?.calls ?? 0;
    const h = await db.query(`SELECT last_ok_at, last_error_at, last_error_code, last_error_message, last_error_hint FROM prospect_api_health WHERE provider = 'google_places'`);
    const row = h.rows[0];
    if (row) {
      lastOkAt = row.last_ok_at ? new Date(row.last_ok_at).toISOString() : null;
      if (row.last_error_at) lastError = { code: row.last_error_code, message: row.last_error_message, hint: row.last_error_hint, at: new Date(row.last_error_at).toISOString() };
    }
  } catch { /* tables may not exist yet */ }
  const base = { keyConfigured, approved, dailyCap, usedToday, lastOkAt, lastError, circuitOpenUntil: circuit && circuit.until > Date.now() ? new Date(circuit.until).toISOString() : null };
  const ready = googleReadiness();
  if (!ready.ready) {
    const state = !keyConfigured ? 'disabled_no_key' : !approved ? 'disabled_not_approved' : 'cap_zero';
    return { ...base, state, message: ready.message };
  }
  return { ...base, state: 'ready', message: `Prêt: ${usedToday}/${dailyCap} appels utilisés aujourd’hui.` };
}

/** Atomically reserve one call under today's cap. False = cap reached. */
export async function reserveGoogleCall(cap: number): Promise<boolean> {
  const r = await db.query(
    `INSERT INTO prospect_api_usage (provider, day, calls) VALUES ('google_places', CURRENT_DATE, 1)
     ON CONFLICT (provider, day) DO UPDATE SET calls = prospect_api_usage.calls + 1
       WHERE prospect_api_usage.calls < $1
     RETURNING calls`, [cap]);
  return r.rows.length > 0;
}

async function recordHealth(ok: boolean, info?: GoogleErrorInfo): Promise<void> {
  try {
    if (ok) {
      await db.query(`INSERT INTO prospect_api_health (provider, last_ok_at) VALUES ('google_places', NOW())
                      ON CONFLICT (provider) DO UPDATE SET last_ok_at = NOW()`);
    } else if (info) {
      await db.query(`INSERT INTO prospect_api_health (provider, last_error_at, last_error_code, last_error_message, last_error_hint)
                      VALUES ('google_places', NOW(), $1, $2, $3)
                      ON CONFLICT (provider) DO UPDATE SET last_error_at = NOW(), last_error_code = $1, last_error_message = $2, last_error_hint = $3`,
        [info.code, info.message.slice(0, 500), info.hint]);
    }
  } catch { /* health bookkeeping must never break a lookup */ }
}

// Circuit breaker: after a configuration/quota failure stop sending (and paying for) calls that
// are certain to fail. Cleared by a successful "Tester la connexion" or when the delay elapses.
let circuit: { until: number; info: GoogleErrorInfo } | null = null;
const CIRCUIT_MS: Partial<Record<GoogleErrorCode, number>> = { QUOTA_EXCEEDED: 60_000 };
const CIRCUIT_DEFAULT_MS = 10 * 60_000;
export function resetGoogleCircuit() { circuit = null; }

const retryDelay = (attempt: number) => {
  const base = Number(process.env.GOOGLE_PLACES_RETRY_DELAY_MS ?? 500);
  return new Promise<void>(r => setTimeout(r, Number.isFinite(base) ? base * attempt * attempt : 0));
};
const MAX_ATTEMPTS = 3;

export interface GoogleSearchOptions { body: Record<string, unknown>; fieldMask: string; timeoutMs?: number; bypassCircuit?: boolean }

/**
 * The only function that talks to Google. Order of checks: approval + cap config -> circuit breaker ->
 * per-attempt atomic cap reservation (a retry is a new billable attempt, so it is counted too) -> HTTP.
 */
export async function googlePlacesSearch(opts: GoogleSearchOptions): Promise<GooglePlace[]> {
  const ready = googleReadiness();
  if (!ready.ready) throw new GoogleAuthOrQuotaError(ready.message, undefined, 'NOT_READY', HINTS.NOT_READY);
  if (!opts.bypassCircuit && circuit && circuit.until > Date.now()) {
    throw new GoogleAuthOrQuotaError(`Appels Google suspendus (${circuit.info.code}): ${circuit.info.message}`, circuit.info.status, 'CIRCUIT_OPEN', HINTS.CIRCUIT_OPEN);
  }
  const key = process.env.GOOGLE_PLACES_API_KEY as string;
  let last: GoogleErrorInfo | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) await retryDelay(attempt - 1);
    if (!(await reserveGoogleCall(ready.dailyCap))) throw new GoogleCapReachedError(ready.dailyCap);
    try {
      const { data } = await axios.post(URL_, opts.body, {
        timeout: opts.timeoutMs ?? 15000,
        headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': opts.fieldMask },
      });
      circuit = null;
      await recordHealth(true);
      return Array.isArray(data?.places) ? data.places : [];
    } catch (err: any) {
      const info = classifyGoogleError(err);
      last = info;
      if (info.fatal) {
        circuit = { until: Date.now() + (CIRCUIT_MS[info.code] ?? CIRCUIT_DEFAULT_MS), info };
        await recordHealth(false, info);
        logger.error(`Google Places refused the request: ${info.code} (HTTP ${info.status}) ${info.message}`);
        throw new GoogleAuthOrQuotaError(`Google Places refused the request (HTTP ${info.status}): ${info.message}`, info.status, info.code, info.hint);
      }
      if (!info.retryable) break;
      logger.warn(`Google Places transient error (${info.status || info.code}), attempt ${attempt}/${MAX_ATTEMPTS}: ${info.message}`);
    }
  }
  const info = last as GoogleErrorInfo;
  await recordHealth(false, info);
  throw new GoogleRequestError(`Google Places (${info.code}${info.status ? ` HTTP ${info.status}` : ''}): ${info.message}`, info.code, info.status);
}

// ---- matching -------------------------------------------------------------
const STOP = new Set(['sarl', 'sas', 'sasu', 'eurl', 'sa', 'ets', 'etablissements', 'societe', 'de', 'du', 'des', 'la', 'le', 'les', 'et', 'l', 'd']);
export function normName(s: string): string[] {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').split(' ').filter(t => t && !STOP.has(t));
}
/** Token Dice coefficient on accent-folded, stop-worded names, 0..1. */
export function nameSimilarity(a: string, b: string): number {
  const A = new Set(normName(a)), B = new Set(normName(b));
  if (!A.size || !B.size) return 0;
  let inter = 0; A.forEach(t => { if (B.has(t)) inter++; });
  return (2 * inter) / (A.size + B.size);
}
export function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000, toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export interface GooglePlace {
  id: string; displayName?: { text?: string }; formattedAddress?: string;
  location?: { latitude: number; longitude: number }; rating?: number; userRatingCount?: number;
  googleMapsUri?: string; websiteUri?: string; nationalPhoneNumber?: string; businessStatus?: string;
}
export interface MatchTarget { company_name: string; trading_name: string | null; postal_code: string | null; latitude: number | null; longitude: number | null }

/** 0.6 name + 0.4 location (distance if both coordinates known, else postal code in the address). */
export function matchConfidence(t: MatchTarget, p: GooglePlace): number {
  const nm = Math.max(
    nameSimilarity(t.company_name, p.displayName?.text || ''),
    t.trading_name ? nameSimilarity(t.trading_name, p.displayName?.text || '') : 0,
  );
  let loc = 0;
  if (t.latitude !== null && t.longitude !== null && p.location) {
    const d = haversineM(t.latitude, t.longitude, p.location.latitude, p.location.longitude);
    loc = d <= 100 ? 1 : d >= 500 ? 0 : 1 - (d - 100) / 400;
  } else if (t.postal_code && p.formattedAddress?.includes(t.postal_code)) {
    loc = 0.8;
  }
  return Math.round((0.6 * nm + 0.4 * loc) * 1000) / 1000;
}

export function pickBest(t: MatchTarget, places: GooglePlace[]): { place: GooglePlace; confidence: number } | null {
  let best: { place: GooglePlace; confidence: number } | null = null;
  for (const p of places) {
    const c = matchConfidence(t, p);
    if (!best || c > best.confidence) best = { place: p, confidence: c };
  }
  return best;
}

export async function searchPlaces(t: MatchTarget & { city: string | null }): Promise<GooglePlace[]> {
  const body: any = {
    textQuery: [t.trading_name || t.company_name, t.city].filter(Boolean).join(' '),
    languageCode: 'fr', regionCode: 'FR', maxResultCount: 3,
  };
  if (t.latitude !== null && t.longitude !== null) {
    body.locationBias = { circle: { center: { latitude: t.latitude, longitude: t.longitude }, radius: 500 } };
  }
  return googlePlacesSearch({ body, fieldMask: FIELD_MASK });
}

export interface GoogleProbeResult {
  ok: boolean; code?: GoogleErrorCode; message: string; hint?: string;
  sample?: { name: string | null; hasMapsUri: boolean; hasRating: boolean; hasReviewCount: boolean };
}
/**
 * Admin "Tester la connexion": ONE real request with the production field mask, so it proves the key,
 * the enabled API, billing and the Enterprise-level fields all work. It is billed like any other call
 * and counts against the daily cap; it still requires key + approval + cap.
 */
export async function probeGoogle(): Promise<GoogleProbeResult> {
  resetGoogleCircuit();
  try {
    const places = await googlePlacesSearch({
      body: { textQuery: 'Tour Eiffel Paris', languageCode: 'fr', regionCode: 'FR', maxResultCount: 1 },
      fieldMask: FIELD_MASK, bypassCircuit: true,
    });
    const p = places[0];
    if (!p) return { ok: true, message: 'Connexion valide, mais la recherche de test n\u2019a renvoyé aucun lieu.', sample: { name: null, hasMapsUri: false, hasRating: false, hasReviewCount: false } };
    return {
      ok: true, message: 'Connexion valide: clé, API et facturation acceptent les champs demandés.',
      sample: { name: p.displayName?.text ?? null, hasMapsUri: !!p.googleMapsUri, hasRating: typeof p.rating === 'number', hasReviewCount: typeof p.userRatingCount === 'number' },
    };
  } catch (err: any) {
    if (err instanceof GoogleCapReachedError) return { ok: false, message: err.message, hint: 'Relever GOOGLE_PLACES_DAILY_CAP après approbation du coût.' };
    if (err instanceof GoogleAuthOrQuotaError) return { ok: false, code: err.code, message: err.message, hint: err.hint };
    if (err instanceof GoogleRequestError) return { ok: false, code: err.code, message: err.message, hint: HINTS[err.code] };
    return { ok: false, code: 'UNKNOWN', message: redactSecrets(err?.message) };
  }
}
