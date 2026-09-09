// Official INSEE département -> région mapping (current regions, post-2016
// merger). Static reference data, not derived from any opportunity - same
// category as a country-code table, not something that could be "invented"
// per-listing. Used to backfill location_region on records whose only real
// location signal is a department code (e.g. DECP), so the map/region
// filters actually have something to group on instead of defaulting to a
// tiny sliver of rows that happen to carry a region string already.
export const DEPARTMENT_TO_REGION: Record<string, string> = {
  '01': 'Auvergne-Rhône-Alpes', '03': 'Auvergne-Rhône-Alpes', '07': 'Auvergne-Rhône-Alpes',
  '15': 'Auvergne-Rhône-Alpes', '26': 'Auvergne-Rhône-Alpes', '38': 'Auvergne-Rhône-Alpes',
  '42': 'Auvergne-Rhône-Alpes', '43': 'Auvergne-Rhône-Alpes', '63': 'Auvergne-Rhône-Alpes',
  '69': 'Auvergne-Rhône-Alpes', '73': 'Auvergne-Rhône-Alpes', '74': 'Auvergne-Rhône-Alpes',
  '21': 'Bourgogne-Franche-Comté', '25': 'Bourgogne-Franche-Comté', '39': 'Bourgogne-Franche-Comté',
  '58': 'Bourgogne-Franche-Comté', '70': 'Bourgogne-Franche-Comté', '71': 'Bourgogne-Franche-Comté',
  '89': 'Bourgogne-Franche-Comté', '90': 'Bourgogne-Franche-Comté',
  '22': 'Bretagne', '29': 'Bretagne', '35': 'Bretagne', '56': 'Bretagne',
  '18': 'Centre-Val de Loire', '28': 'Centre-Val de Loire', '36': 'Centre-Val de Loire',
  '37': 'Centre-Val de Loire', '41': 'Centre-Val de Loire', '45': 'Centre-Val de Loire',
  '2A': 'Corse', '2B': 'Corse',
  '08': 'Grand Est', '10': 'Grand Est', '51': 'Grand Est', '52': 'Grand Est',
  '54': 'Grand Est', '55': 'Grand Est', '57': 'Grand Est', '67': 'Grand Est',
  '68': 'Grand Est', '88': 'Grand Est',
  '02': 'Hauts-de-France', '59': 'Hauts-de-France', '60': 'Hauts-de-France',
  '62': 'Hauts-de-France', '80': 'Hauts-de-France',
  '75': 'Île-de-France', '77': 'Île-de-France', '78': 'Île-de-France', '91': 'Île-de-France',
  '92': 'Île-de-France', '93': 'Île-de-France', '94': 'Île-de-France', '95': 'Île-de-France',
  '14': 'Normandie', '27': 'Normandie', '50': 'Normandie', '61': 'Normandie', '76': 'Normandie',
  '16': 'Nouvelle-Aquitaine', '17': 'Nouvelle-Aquitaine', '19': 'Nouvelle-Aquitaine',
  '23': 'Nouvelle-Aquitaine', '24': 'Nouvelle-Aquitaine', '33': 'Nouvelle-Aquitaine',
  '40': 'Nouvelle-Aquitaine', '47': 'Nouvelle-Aquitaine', '64': 'Nouvelle-Aquitaine',
  '79': 'Nouvelle-Aquitaine', '86': 'Nouvelle-Aquitaine', '87': 'Nouvelle-Aquitaine',
  '09': 'Occitanie', '11': 'Occitanie', '12': 'Occitanie', '30': 'Occitanie', '31': 'Occitanie',
  '32': 'Occitanie', '34': 'Occitanie', '46': 'Occitanie', '48': 'Occitanie', '65': 'Occitanie',
  '66': 'Occitanie', '81': 'Occitanie', '82': 'Occitanie',
  '44': 'Pays de la Loire', '49': 'Pays de la Loire', '53': 'Pays de la Loire',
  '72': 'Pays de la Loire', '85': 'Pays de la Loire',
  '04': "Provence-Alpes-Côte d'Azur", '05': "Provence-Alpes-Côte d'Azur",
  '06': "Provence-Alpes-Côte d'Azur", '13': "Provence-Alpes-Côte d'Azur",
  '83': "Provence-Alpes-Côte d'Azur", '84': "Provence-Alpes-Côte d'Azur",
  '971': 'Guadeloupe', '972': 'Martinique', '973': 'Guyane', '974': 'La Réunion', '976': 'Mayotte',
};

// Client's 9 Sep report: selecting all 13 current regions on the map only
// pulled back ~1,500 of the ~40k expected opportunities. Root cause (found
// by loading schema.sql + realistic BOAMP-shaped rows into a local Postgres
// and testing the actual filter query): normalizeBoampRecord trusts a raw
// `f.region` field whenever BOAMP's feed supplies one, with no validation -
// and BOAMP (in continuous operation since 1957) still surfaces the
// pre-2016 22-region names on plenty of notices, which don't match any of
// the 13 current region names the map/filter use, not even as an ILIKE
// substring. Those rows were never being excluded from the *count*, just
// silently unreachable by every region filter. Official 2016 territorial
// reform mapping (22 old régions -> 13 new): each key here is already
// lowercased/unaccented (see normalizeRegionName below, which does the
// same to whatever it's asked to look up) so the comparison doesn't depend
// on the source's own accenting being correct either - scripts/seed.js and
// generateSyntheticListings.js both turned out to store a few of these
// unaccented ("Auvergne-Rhone-Alpes"), which used to silently fail an
// accent-sensitive match the same way.
const OLD_TO_NEW_REGION: Record<string, string> = {
  'alsace': 'Grand Est', 'champagne-ardenne': 'Grand Est', 'lorraine': 'Grand Est',
  'aquitaine': 'Nouvelle-Aquitaine', 'limousin': 'Nouvelle-Aquitaine', 'poitou-charentes': 'Nouvelle-Aquitaine',
  'auvergne': 'Auvergne-Rhône-Alpes', 'rhone-alpes': 'Auvergne-Rhône-Alpes',
  'bourgogne': 'Bourgogne-Franche-Comté', 'franche-comte': 'Bourgogne-Franche-Comté',
  'basse-normandie': 'Normandie', 'haute-normandie': 'Normandie',
  'languedoc-roussillon': 'Occitanie', 'midi-pyrenees': 'Occitanie',
  'nord-pas-de-calais': 'Hauts-de-France', 'picardie': 'Hauts-de-France',
  'centre': 'Centre-Val de Loire', // renamed (not merged) in 2015
};

const stripAccents = (s: string): string =>
  s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

// Canonical current region names, keyed by their own lowercased/unaccented
// form - lets a source's own accenting/casing quirks (confirmed real,
// see seed.js above) resolve to the correct current name too, not just
// old-name -> new-name.
const CURRENT_REGIONS = [
  'Île-de-France', 'Centre-Val de Loire', 'Bourgogne-Franche-Comté', 'Normandie',
  'Hauts-de-France', 'Grand Est', 'Pays de la Loire', 'Bretagne', 'Nouvelle-Aquitaine',
  'Occitanie', 'Auvergne-Rhône-Alpes', "Provence-Alpes-Côte d'Azur", 'Corse',
];
const CURRENT_REGION_BY_KEY: Record<string, string> = {};
for (const name of CURRENT_REGIONS) {
  CURRENT_REGION_BY_KEY[stripAccents(name).toLowerCase()] = name;
}

/**
 * Resolves any region name a source might supply - current official name
 * (any accenting/casing), a pre-2016 name, stray whitespace - to one of the
 * 13 current canonical names. Returns null (never a guess) when the input
 * doesn't match anything known, so an unrecognized string doesn't silently
 * become a fake region either - same "null over invented data" rule as
 * regionForDepartmentCode below.
 */
export function normalizeRegionName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const key = stripAccents(String(raw).trim().toLowerCase());
  if (!key) return null;
  return CURRENT_REGION_BY_KEY[key] || OLD_TO_NEW_REGION[key] || null;
}

/**
 * Normalizes a department code found in varied source formats ("33",
 * "033", "2A", a 5-digit INSEE commune code like "33063" where the first
 * two digits are the department) into the 2-3 digit form used as keys
 * above, then resolves it to a region name. Returns null rather than a
 * guess when the code doesn't match any known pattern.
 */
export function regionForDepartmentCode(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const code = String(raw).trim().toUpperCase();

  if (DEPARTMENT_TO_REGION[code]) return DEPARTMENT_TO_REGION[code];

  // Overseas department padded to 3 digits ("971" etc.) sometimes arrives
  // as "1" from a numeric column that dropped the leading zeros.
  if (/^\d{1,3}$/.test(code)) {
    const padded3 = code.padStart(3, '0');
    if (DEPARTMENT_TO_REGION[padded3]) return DEPARTMENT_TO_REGION[padded3];
    const padded2 = code.padStart(2, '0');
    if (DEPARTMENT_TO_REGION[padded2]) return DEPARTMENT_TO_REGION[padded2];
  }

  // A 5-digit INSEE commune code (e.g. "33063" = Bordeaux) - department is
  // the first 2 digits (first 3 for overseas communes starting with 97).
  if (/^\d{5}$/.test(code)) {
    const dept3 = code.slice(0, 3);
    if (DEPARTMENT_TO_REGION[dept3]) return DEPARTMENT_TO_REGION[dept3];
    const dept2 = code.slice(0, 2);
    if (DEPARTMENT_TO_REGION[dept2]) return DEPARTMENT_TO_REGION[dept2];
  }

  return null;
}

/** Same idea, but returns the normalized department code itself (not the region). */
export function normalizeDepartmentCode(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const code = String(raw).trim().toUpperCase();

  if (DEPARTMENT_TO_REGION[code]) return code;
  if (/^\d{1,3}$/.test(code)) {
    const padded3 = code.padStart(3, '0');
    if (DEPARTMENT_TO_REGION[padded3]) return padded3;
    const padded2 = code.padStart(2, '0');
    if (DEPARTMENT_TO_REGION[padded2]) return padded2;
  }
  if (/^\d{5}$/.test(code)) {
    const dept3 = code.slice(0, 3);
    if (DEPARTMENT_TO_REGION[dept3]) return dept3;
    const dept2 = code.slice(0, 2);
    if (DEPARTMENT_TO_REGION[dept2]) return dept2;
  }
  return null;
}

// Pulls a department-code-shaped value out of a raw source record,
// regardless of which connector produced it. Shared by
// scripts/backfillLocationRegion.ts and the admin HTTP route (Render free
// tier often has no Shell tab, so the route is the only way to run this
// backfill for some deployments) - one implementation, not two copies that
// could drift.
export function extractDepartmentCode(raw: any): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const f = raw.fields || raw; // BOAMP nests under `fields`, DECP doesn't
  const candidates = [
    f.departement, f.codeDepartement, f.codeDepartementExecution,
    f['lieuExecution.code'], f['lieuExecution_code'], f['lieuExecutionCode'],
    f.lieuExecution?.code,
  ];
  for (const c of candidates) {
    const normalized = normalizeDepartmentCode(c);
    if (normalized) return normalized;
  }
  return null;
}
