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
