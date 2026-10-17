// "Indicateur de consultation" of a fiche. Client brief (18 Oct): specific to each announcement, driven by its REAL
// tracking (never a random or shared figure), several wordings depending on the data available, "consultations"
// (not "entreprises") unless every counted visitor is an identified company, and hidden when no reliable data exists.
// The wording is picked deterministically from the announcement id, so it stays the same while the visitor reads
// and when they come back - no artificial flicker.

export interface ConsultationStats {
  sessions24h: number;     // distinct visitor sessions that opened the fiche in the last 24 h (the caller excluded)
  sessions7d: number;      // same over 7 days
  identified24h: number;   // of those, sessions whose company was identified (SIRET)
  identified7d: number;
  lastViewAgeSeconds: number | null; // age of the most recent view by someone else
}

export type ConsultationKind = 'week' | 'today' | 'last';
export type ConsultationLang = 'fr' | 'en';
// `value` = the tracked figure written in the label (null for the last-view wording): lets the UI scale the small dot.
export interface ConsultationIndicator { label: string; kind: ConsultationKind; unit: 'companies' | 'visits'; value: number | null; }

// Reliability thresholds: a counted figure needs at least two distinct visitors (one is a person, not an activity),
// and "dernière consultation" must be recent enough to mean something.
export const MIN_TODAY = 2;
export const MIN_WEEK = 3;
export const MAX_LAST_AGE_SECONDS = 48 * 3600;

const hashId = (id: string): number => {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
};

const fmtAgeFr = (s: number): string => {
  if (s < 3600) return 'moins d’une heure';
  const h = Math.floor(s / 3600);
  return `${h} heure${h > 1 ? 's' : ''}`;
};
const fmtAgeEn = (s: number): string => {
  if (s < 3600) return 'less than an hour';
  const h = Math.floor(s / 3600);
  return `${h} hour${h > 1 ? 's' : ''}`;
};

export function buildConsultationIndicator(stats: ConsultationStats, opportunityId: string, lang: ConsultationLang = 'fr'): ConsultationIndicator | null {
  const candidates: ConsultationIndicator[] = [];
  const fr = lang !== 'en';

  if (stats.sessions7d >= MIN_WEEK) {
    const companies = stats.identified7d === stats.sessions7d;
    const n = stats.sessions7d;
    candidates.push({
      kind: 'week',
      value: n,
      unit: companies ? 'companies' : 'visits',
      label: fr
        ? (companies ? `${n} entreprises ont consulté cette annonce ces 7 derniers jours.` : `${n} consultations de cette annonce ces 7 derniers jours.`)
        : (companies ? `${n} companies viewed this listing in the last 7 days.` : `${n} views of this listing in the last 7 days.`),
    });
  }
  if (stats.sessions24h >= MIN_TODAY) {
    const companies = stats.identified24h === stats.sessions24h;
    const n = stats.sessions24h;
    candidates.push({
      kind: 'today',
      value: n,
      unit: companies ? 'companies' : 'visits',
      label: fr
        ? (companies ? `${n} entreprises ont consulté cette annonce aujourd’hui.` : `${n} consultations de cette annonce aujourd’hui.`)
        : (companies ? `${n} companies viewed this listing today.` : `${n} views of this listing today.`),
    });
  }
  if (stats.lastViewAgeSeconds != null && stats.lastViewAgeSeconds >= 0 && stats.lastViewAgeSeconds <= MAX_LAST_AGE_SECONDS) {
    candidates.push({
      kind: 'last',
      value: null,
      unit: 'visits',
      label: fr
        ? `Dernière consultation il y a ${fmtAgeFr(stats.lastViewAgeSeconds)}.`
        : `Last viewed ${fmtAgeEn(stats.lastViewAgeSeconds)} ago.`,
    });
  }
  if (!candidates.length) return null;
  return candidates[hashId(opportunityId) % candidates.length];
}
