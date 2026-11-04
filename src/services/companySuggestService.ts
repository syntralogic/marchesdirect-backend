import { fetchSirenePage, ProspectRecord } from './sireneClient';
import { PROFESSIONS } from '../utils/prospectNaf';
import { createBoundedCache } from '../utils/ttlCache';

// Accueil "Par entreprise": as soon as the visitor has typed 3 characters of a company name
// (or a full SIREN / SIRET), we propose up to 3 real companies to pick from.
//
// Source: the free, key-less official API (recherche-entreprises.api.gouv.fr, same client as the
// prospect import). No paid Pappers call happens here: the paid, cached and IP-throttled lookup
// only runs once the visitor has CHOSEN a company (POST /api/siret/confirm, unchanged).

export interface CompanySuggestion {
  siret: string;
  siren: string;
  name: string;
  /** Official NAF/APE label when we know it, else null (never guessed). */
  activity: string | null;
  /** Short métier label deduced from the APE code, null when the code is unknown. */
  metier: string | null;
  city: string | null;
  postal: string | null;
  department: string | null;
}

export type SuggestQuery =
  | { kind: 'text'; q: string }
  | { kind: 'number'; q: string }
  | { kind: 'incomplete_number'; q: string }
  | { kind: 'too_short' };

export const SUGGEST_MIN_CHARS = 3;
export const SUGGEST_MAX_RESULTS = 3;
const SUGGEST_TTL_MS = 10 * 60 * 1000;

/**
 * Classify what the visitor typed.
 *  - digits (spaces allowed, as in "552 032 534 00018"): only a full SIREN (9) or SIRET (14) can be
 *    searched; a shorter run of digits is "incomplete_number" so the UI can say so instead of
 *    showing unrelated companies.
 *  - anything else: free text, from 3 characters.
 */
export function classifySuggestQuery(raw: unknown): SuggestQuery {
  if (typeof raw !== 'string') return { kind: 'too_short' };
  const text = raw.replace(/\s+/g, ' ').trim().slice(0, 100);
  if (text.length < SUGGEST_MIN_CHARS) return { kind: 'too_short' };
  if (/^[\d ]+$/.test(text)) {
    const digits = text.replace(/\s/g, '');
    if (digits.length === 9 || digits.length === 14) return { kind: 'number', q: digits };
    return { kind: 'incomplete_number', q: digits };
  }
  return { kind: 'text', q: text };
}

/** Collapse establishments to one suggestion per company (siret asked > siège > first seen). */
export function toSuggestions(records: ProspectRecord[], wantedSiret?: string): CompanySuggestion[] {
  const bySiren = new Map<string, ProspectRecord>();
  for (const r of records) {
    if (r.status !== 'active') continue;
    const current = bySiren.get(r.siren);
    const better = !current
      || (wantedSiret && r.siret === wantedSiret && current.siret !== wantedSiret)
      || (!wantedSiret && r.is_head_office && !current.is_head_office);
    if (better) bySiren.set(r.siren, r);
  }
  return [...bySiren.values()].slice(0, SUGGEST_MAX_RESULTS).map(r => ({
    siret: r.siret,
    siren: r.siren,
    name: r.company_name,
    activity: r.activity_label,
    metier: r.profession && r.profession !== 'autre' ? PROFESSIONS[r.profession] || null : null,
    city: r.city,
    postal: r.postal_code,
    department: r.department,
  }));
}

const cache = createBoundedCache(500);

export type SuggestResult =
  | { suggestions: CompanySuggestion[]; hint?: undefined }
  | { suggestions: []; hint: 'too_short' | 'incomplete_number' };

export async function suggestCompanies(raw: unknown): Promise<SuggestResult> {
  const query = classifySuggestQuery(raw);
  if (query.kind === 'too_short') return { suggestions: [], hint: 'too_short' };
  if (query.kind === 'incomplete_number') return { suggestions: [], hint: 'incomplete_number' };

  const key = `${query.kind}:${query.q.toLowerCase()}`;
  const suggestions = await cache(key, SUGGEST_TTL_MS, async () => {
    // More rows than we show: the API returns one row per company but non-diffusible / closed
    // ones are dropped afterwards, and we still want to fill 3 slots when possible.
    const page = await fetchSirenePage({ q: query.q, perPage: 8 });
    return toSuggestions(page.records, query.kind === 'number' && query.q.length === 14 ? query.q : undefined);
  });
  return { suggestions };
}
