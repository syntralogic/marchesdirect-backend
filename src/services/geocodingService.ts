/**
 * GEOCODING SERVICE
 * ============================================================================
 * Context: client audit (19 Sep) found city-radius search ("Angoulême à
 * 25 km puis à 200 km : exactement les mêmes huit marchés publics") was
 * pure decoration - the radius selector never actually filtered anything.
 * Root cause traced to opportunities.location_latitude/longitude: the
 * columns exist in the schema, /stats/near already has a correct
 * Haversine-based query using them, but nothing anywhere in the ingestion
 * pipeline (BOAMP/PLACE/TED/DECP/Batiweb - see dataCollectionService.ts)
 * ever actually sets them. Every row's coordinates are NULL, so distance
 * filtering has nothing to filter on and silently falls back to a plain
 * city-name text match regardless of the radius chosen.
 *
 * Fixing this needs an actual lat/lng per opportunity. We only reliably
 * have city + department from source data (not a full street address), so
 * this geocodes at the CITY level using France's official, free,
 * no-API-key geocoding service (api-adresse.data.gouv.fr - the Base
 * Adresse Nationale, run by the French government/Etalab). city-level
 * precision is the right grain here anyway: a public-procurement
 * "lieu d'exécution" is a commune, not a street address, and geocoding
 * every unique (city, department) pair ONCE and applying it to every
 * opportunity that shares it (see jobs/geocodingBackfillJob.ts) means a
 * handful of thousand API calls covers tens of thousands of rows, not
 * one call per row.
 *
 * api-adresse.data.gouv.fr specifics (confirmed via their docs - not
 * reachable from this sandbox's network to test live, so this is built
 * strictly to the documented contract, and the backfill job logs failures
 * clearly so anyone re-checking after deploy isn't guessing):
 *   GET /search/?q=<text>&type=municipality&citycode=<insee code>&limit=1
 *   -> GeoJSON FeatureCollection; features[0].geometry.coordinates is
 *      [lon, lat] (GeoJSON order - note this is REVERSED from the
 *      lat-then-lng order used everywhere else in this codebase, e.g.
 *      /stats/near's lat/lng query params - swapped once here, at the
 *      boundary, so nothing downstream has to know about it).
 *   No API key, no auth header. Public, free, government-run, high fair
 *   -use volume tolerance - still rate-limited client-side in the backfill
 *   job below out of courtesy, not because it demands it.
 */
import axios from 'axios';
import { logger } from '../utils/logger';

const GEOCODE_BASE_URL = 'https://api-adresse.data.gouv.fr/search/';

export interface GeocodeResult {
  lat: number;
  lng: number;
}

// department code -> INSEE citycode prefix isn't a real constraint the API
// takes directly; we instead pass the department as part of the query text
// (matches how a person would type it) since api-adresse free-text search
// already ranks municipality-type results well. citycode filtering would
// need the actual INSEE code, which we don't have from source data.
export const geocodeCity = async (
  city: string,
  departmentCode?: string | null
): Promise<GeocodeResult | null> => {
  const cityTrimmed = city?.trim();
  if (!cityTrimmed) return null;

  const q = departmentCode ? `${cityTrimmed} (${departmentCode})` : cityTrimmed;

  try {
    const response = await axios.get(GEOCODE_BASE_URL, {
      params: { q, type: 'municipality', limit: 1 },
      timeout: 5000,
    });
    const feature = response.data?.features?.[0];
    const coords = feature?.geometry?.coordinates;
    if (!Array.isArray(coords) || coords.length !== 2) return null;
    const [lng, lat] = coords; // GeoJSON order - see file-level note above.
    if (typeof lat !== 'number' || typeof lng !== 'number') return null;
    return { lat, lng };
  } catch (err: any) {
    // Not fatal for a single city - the backfill job just skips it this
    // run and picks it up again next time (see geocodingBackfillJob.ts).
    logger.warn(`[geocoding] Failed for "${q}": ${err.message || err}`);
    return null;
  }
};
