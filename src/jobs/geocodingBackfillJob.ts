/**
 * GEOCODING BACKFILL JOB
 * ============================================================================
 * See services/geocodingService.ts for the full root-cause writeup (city
 * radius search was pure decoration because no opportunity has coordinates).
 * This is the job that actually populates location_latitude/longitude.
 *
 * Geocodes by UNIQUE (city, department) pair, not per-row: there are far
 * fewer distinct communes among our opportunities than opportunities
 * themselves, so one API call + one bulk UPDATE covers every row sharing
 * that city, the same "don't pay per-row for a per-location fact" shape as
 * locationRegionBackfillJob.ts (that one's free/local; this one calls a
 * real external API, hence the smaller batch + deliberate delay between
 * calls below - courtesy rate-limiting on a free public government
 * service, not a limit it imposes on us).
 */
import { db } from '../config/database';
import { logger } from '../utils/logger';
import { geocodeCity } from '../services/geocodingService';
import { trackJob } from '../utils/jobTracker';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Unique (city, department) pairs per run, not opportunity rows - each one
// bulk-applies to every opportunity sharing that pair, so this covers far
// more than CITIES_PER_RUN rows.
const CITIES_PER_RUN = 60;
const DELAY_BETWEEN_CALLS_MS = 150;

export async function runGeocodingBackfillBatch(): Promise<{ geocoded: number; failed: number; rowsUpdated: number }> {
  let pairs: { location_city: string; location_department: string | null }[];
  try {
    const result = await db.query(
      `SELECT DISTINCT location_city, location_department
       FROM opportunities
       WHERE location_latitude IS NULL
         AND location_city IS NOT NULL AND location_city != ''
         AND deleted_at IS NULL
       LIMIT $1`,
      [CITIES_PER_RUN]
    );
    pairs = result.rows;
  } catch (err) {
    logger.error('[Job] Geocoding backfill query failed:', err);
    return { geocoded: 0, failed: 0, rowsUpdated: 0 };
  }

  if (pairs.length === 0) {
    logger.info('[Job] Geocoding backfill: nothing outstanding.');
    return { geocoded: 0, failed: 0, rowsUpdated: 0 };
  }

  let geocoded = 0;
  let failed = 0;
  let rowsUpdated = 0;

  for (const pair of pairs) {
    const result = await geocodeCity(pair.location_city, pair.location_department);
    if (result) {
      geocoded++;
      try {
        // Matches on the exact (city, department) pair used to geocode -
        // department included (even though it's nullable/IS NOT DISTINCT
        // FROM-matched) so two same-named communes in different
        // departments never get cross-applied to each other's coordinates.
        const updateResult = await db.query(
          `UPDATE opportunities
           SET location_latitude = $1, location_longitude = $2, updated_at = NOW()
           WHERE location_city = $3
             AND location_department IS NOT DISTINCT FROM $4
             AND location_latitude IS NULL`,
          [result.lat, result.lng, pair.location_city, pair.location_department]
        );
        rowsUpdated += updateResult.rowCount || 0;
      } catch (err) {
        logger.error(`[Job] Geocoding backfill UPDATE failed for "${pair.location_city}":`, err);
      }
    } else {
      failed++;
      // Stamp a sentinel so a city that genuinely can't be geocoded (typo,
      // foreign buyer address, garbage source data) doesn't get re-queried
      // forever on every run - 0,0 is never a real French coordinate.
      try {
        await db.query(
          `UPDATE opportunities
           SET location_latitude = 0, location_longitude = 0, updated_at = NOW()
           WHERE location_city = $1
             AND location_department IS NOT DISTINCT FROM $2
             AND location_latitude IS NULL`,
          [pair.location_city, pair.location_department]
        );
      } catch (err) {
        logger.error(`[Job] Geocoding backfill sentinel UPDATE failed for "${pair.location_city}":`, err);
      }
    }
    await sleep(DELAY_BETWEEN_CALLS_MS);
  }

  logger.info(`[Job] Geocoding backfill run complete: ${geocoded} cities geocoded, ${failed} failed, ${rowsUpdated} opportunity rows updated (remainder picks up next run).`);
  return { geocoded, failed, rowsUpdated };
}

export const startGeocodingBackfillJob = () => {
  const cron = require('node-cron');

  setTimeout(() => {
    trackJob('geocodingBackfill:boot', () => runGeocodingBackfillBatch())
      .catch(err => logger.error('[Job] Boot-time geocoding backfill failed (non-fatal):', err));
  }, 25_000);

  // Every 2 minutes - see file header for why this is much slower than
  // locationRegionBackfillJob's 3-minute/8000-row cadence: that one is a
  // free local computation, this one calls a real external API per unique
  // city.
  cron.schedule('*/2 * * * *', () => {
    trackJob('geocodingBackfill:cron', () => runGeocodingBackfillBatch())
      .catch(err => logger.error('[Job] Scheduled geocoding backfill failed (non-fatal):', err));
  });

  logger.info('✅ Geocoding backfill job scheduled (batch of 60 unique cities on boot, then every 2 minutes until the backlog clears)');
};
