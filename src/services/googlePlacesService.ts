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
const FIELD_MASK = [
  'places.id', 'places.displayName', 'places.formattedAddress', 'places.location',
  'places.rating', 'places.userRatingCount', 'places.googleMapsUri', 'places.websiteUri',
  'places.nationalPhoneNumber', 'places.businessStatus',
].join(',');
export const MIN_CONFIDENCE = 0.8;

export class GoogleAuthOrQuotaError extends Error {
  constructor(message: string, public status?: number) { super(message); }
}

export interface GoogleStatus {
  state: 'disabled_no_key' | 'disabled_not_approved' | 'cap_zero' | 'ready';
  keyConfigured: boolean; approved: boolean; dailyCap: number; usedToday: number;
  message: string;
}

export async function googleStatus(): Promise<GoogleStatus> {
  const keyConfigured = !!process.env.GOOGLE_PLACES_API_KEY;
  const approved = process.env.GOOGLE_PLACES_ENABLED === 'true';
  const dailyCap = Math.max(0, parseInt(process.env.GOOGLE_PLACES_DAILY_CAP || '0', 10) || 0);
  let usedToday = 0;
  try {
    const r = await db.query(`SELECT calls FROM prospect_api_usage WHERE provider = 'google_places' AND day = CURRENT_DATE`);
    usedToday = r.rows[0]?.calls ?? 0;
  } catch { /* table may not exist yet */ }
  if (!keyConfigured) return { state: 'disabled_no_key', keyConfigured, approved, dailyCap, usedToday, message: 'GOOGLE_PLACES_API_KEY non configurée sur le backend: aucun appel Google n\u2019est effectué.' };
  if (!approved) return { state: 'disabled_not_approved', keyConfigured, approved, dailyCap, usedToday, message: 'Clé présente mais GOOGLE_PLACES_ENABLED n\u2019est pas « true »: appels bloqués tant que les coûts ne sont pas approuvés.' };
  if (dailyCap === 0) return { state: 'cap_zero', keyConfigured, approved, dailyCap, usedToday, message: 'GOOGLE_PLACES_DAILY_CAP = 0: définir un plafond quotidien approuvé pour activer les appels.' };
  return { state: 'ready', keyConfigured, approved, dailyCap, usedToday, message: `Prêt: ${usedToday}/${dailyCap} appels utilisés aujourd\u2019hui.` };
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
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) throw new GoogleAuthOrQuotaError('GOOGLE_PLACES_API_KEY missing');
  const body: any = {
    textQuery: [t.trading_name || t.company_name, t.city].filter(Boolean).join(' '),
    languageCode: 'fr', regionCode: 'FR', maxResultCount: 3,
  };
  if (t.latitude !== null && t.longitude !== null) {
    body.locationBias = { circle: { center: { latitude: t.latitude, longitude: t.longitude }, radius: 500 } };
  }
  try {
    const { data } = await axios.post(URL_, body, {
      timeout: 15000,
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': FIELD_MASK },
    });
    return Array.isArray(data?.places) ? data.places : [];
  } catch (err: any) {
    const status = err?.response?.status as number | undefined;
    const detail = err?.response?.data?.error?.message || err?.message;
    const fatal400 = status === 400 && /api key|billing|not enabled|not been used|invalid/i.test(String(detail));
    if (fatal400 || status === 401 || status === 403 || status === 429) {
      // Invalid/restricted key, API not enabled, billing off, or quota hit: stop the whole run.
      throw new GoogleAuthOrQuotaError(`Google Places refused the request (HTTP ${status}): ${detail}`, status);
    }
    logger.warn(`Google Places transient error (${status || err?.code}): ${detail}`);
    throw err;
  }
}
