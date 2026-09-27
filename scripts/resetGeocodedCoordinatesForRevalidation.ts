/**
 * BACKFILL — re-validate location_latitude/longitude
 * ============================================================================
 * Context: 27 Sep client report, point 5 - "Bordeaux + 200 km" surfaced a
 * notice whose own fiche says "Ville de Saint Étienne", hundreds of km
 * outside that radius. This is the EXACT bug already described in
 * geocodingService.ts's own comment (26 Sep client audit, point 8) - and
 * that fix (rejecting api-adresse matches below a 0.4 confidence score,
 * commit ca25d1c) IS already live on main. So why did the client see it
 * again on the 27th?
 *
 * Because that fix only guards NEW geocoding calls. geocodingBackfillJob.ts
 * only geocodes rows WHERE location_latitude IS NULL - a (city, department)
 * pair that was already geocoded (however low-confidence) before ca25d1c
 * shipped has real, non-NULL coordinates sitting in the DB and is therefore
 * never revisited, never re-scored, and never corrected. The score-check
 * fix was real but it could only ever apply going forward; every
 * already-poisoned pair from before it shipped stayed poisoned. Saint-
 * Étienne (or whichever commune it actually resolved to) is very likely one
 * of exactly those pairs.
 *
 * There is no stored score to tell a good pre-fix match from a bad one
 * (score was never persisted, only checked in-memory and discarded) - so
 * there's no way to selectively target just the bad rows. The only honest
 * fix is to invalidate EVERY already-geocoded coordinate (the 0,0
 * "couldn't geocode" sentinel included, since that too deserves a real
 * retry under the now-fixed logic) and let geocodingBackfillJob's normal
 * cadence (60 unique city/department pairs every 2 minutes) re-geocode
 * everything from scratch, this time with the confidence check in place.
 * This is a one-time, one-way trip: after this runs, radius search has no
 * working coordinates until the backfill job catches back up (same "few
 * thousand API calls, not tens of thousands of rows" batching the job's
 * own header describes, since it geocodes per unique (city, department)
 * pair, not per opportunity).
 *
 * HONESTY NOTE: never run against a live database from this sandbox (no
 * DATABASE_URL here, and api-adresse.data.gouv.fr isn't reachable from it
 * either). Logic-reviewed only - run for real on Render/wherever
 * DATABASE_URL points to production. Expect city-radius search to be
 * degraded (falls back to a plain city-name text match - see
 * opportunities.ts's hasRadiusSearch branch) until the backfill job works
 * back through the backlog this creates; that's the accepted trade-off for
 * not trusting a match this codebase has already identified as sometimes
 * wrong.
 *
 * HOW TO RUN:
 *   npx ts-node scripts/resetGeocodedCoordinatesForRevalidation.ts             # dry count + confirm prompt
 *   npx ts-node scripts/resetGeocodedCoordinatesForRevalidation.ts --yes        # no prompt (e.g. cron/CI)
 */
import { db } from '../src/config/database';
import readline from 'readline';

const args = process.argv.slice(2);
const autoConfirm = args.includes('--yes');

const confirm = (question: string): Promise<boolean> => {
  if (autoConfirm) return Promise.resolve(true);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(`${question} (y/N) `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
};

async function main() {
  const countResult = await db.query(
    `SELECT COUNT(*)::int AS count FROM opportunities WHERE location_latitude IS NOT NULL`
  );
  const total = countResult.rows[0].count;
  console.log(`Found ${total} opportunities with a stored (possibly pre-confidence-check) geocoded coordinate.`);

  if (total === 0) {
    console.log('Nothing to do.');
    process.exit(0);
  }

  const proceed = await confirm(
    `Reset all ${total} of them to NULL so geocodingBackfillJob re-geocodes and re-scores every one under the fixed logic? City-radius search will be degraded until the backlog clears.`
  );
  if (!proceed) {
    console.log('Aborted.');
    process.exit(0);
  }

  const updateResult = await db.query(
    `UPDATE opportunities
     SET location_latitude = NULL, location_longitude = NULL, updated_at = NOW()
     WHERE location_latitude IS NOT NULL`
  );

  console.log('\n--- Reset summary ---');
  console.log(`Coordinates cleared for re-geocoding: ${updateResult.rowCount ?? 0}`);
  console.log('geocodingBackfillJob will pick these back up automatically (60 unique city/department pairs every 2 minutes).');

  process.exit(0);
}

main().catch(err => {
  console.error('Reset script crashed:', err);
  process.exit(1);
});
