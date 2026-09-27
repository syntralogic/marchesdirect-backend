/**
 * BACKFILL — location_department (name -> code)
 * ============================================================================
 * Context: 27 Sep client report, point 6 ("le filtre géographique peut aussi
 * masquer une annonce locale") - a "climatisation" search under France
 * entière surfaced a Gironde préfecture maintenance notice; selecting the
 * Gironde department made it disappear. Root cause: some sources (PLACE's
 * undocumented API shape in particular, occasionally BOAMP too) give the
 * département as its official NAME ("Gironde") rather than its INSEE code
 * ("33"). normalizeDepartmentCode() only ever recognized codes, so the name
 * fell through every normalization attempt in insertOpportunity/
 * normalizeBoampRecord and got stored VERBATIM ("Gironde" sitting in
 * location_department, looking like real data) - visible with no location
 * filter, but never matching the department filter's code-based
 * ANY(...) lookup in opportunities.ts. See departmentRegion.ts's
 * DEPARTMENT_NAME_TO_CODE for the fix to the normalization itself; this
 * script is what corrects the rows that were already poisoned by the old
 * behavior before that fix existed.
 *
 * This is a pure RECOVERY script, not a re-import: it only re-runs the
 * (now name-aware) normalizeDepartmentCode()/regionForDepartmentCode() over
 * whatever is ALREADY sitting in location_department - no network call, no
 * re-fetch, nothing to be unreachable from this sandbox for. Only rows
 * where the stored value isn't already a valid code (i.e. exactly the ones
 * the old behavior mis-stored) are touched; a row that already holds "33"
 * is left alone.
 *
 * HONESTY NOTE: never run against a live database from this sandbox (no
 * DATABASE_URL here). Typechecked and logic-reviewed only - run for real on
 * Render/wherever DATABASE_URL points to production, then re-check that a
 * department-filtered search picks up rows it previously missed.
 *
 * HOW TO RUN:
 *   npx ts-node scripts/backfillDepartmentNames.ts             # dry count + confirm prompt
 *   npx ts-node scripts/backfillDepartmentNames.ts --yes        # no prompt (e.g. cron/CI)
 *   npx ts-node scripts/backfillDepartmentNames.ts --yes --limit 5000
 */
import { db } from '../src/config/database';
import { normalizeDepartmentCode, regionForDepartmentCode } from '../src/utils/departmentRegion';
import readline from 'readline';

const args = process.argv.slice(2);
const autoConfirm = args.includes('--yes');
const limitArg = args.find(a => a.startsWith('--limit'));
const limit = limitArg ? parseInt(limitArg.split('=')[1] || args[args.indexOf(limitArg) + 1], 10) : undefined;

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
  // Every row with a non-empty location_department is a candidate - we
  // can't tell from SQL alone which ones are already-valid codes vs.
  // mis-stored names without running the same normalization function the
  // app uses, so this pulls every candidate and filters in JS below.
  const countResult = await db.query(
    `SELECT COUNT(*)::int AS count FROM opportunities
     WHERE location_department IS NOT NULL AND location_department != ''`
  );
  const total = countResult.rows[0].count;
  console.log(`Found ${total} opportunities with a location_department set.`);

  if (total === 0) {
    console.log('Nothing to do.');
    process.exit(0);
  }

  const proceed = await confirm(
    `Re-check department normalization for ${limit ? Math.min(limit, total) : total} of them (only mis-normalized ones - stored as a name instead of a code - will actually be updated)?`
  );
  if (!proceed) {
    console.log('Aborted.');
    process.exit(0);
  }

  const rowsResult = await db.query(
    `SELECT id, location_department, location_region FROM opportunities
     WHERE location_department IS NOT NULL AND location_department != ''
     ORDER BY created_at DESC
     ${limit ? 'LIMIT $1' : ''}`,
    limit ? [limit] : []
  );

  let corrected = 0;
  let alreadyValid = 0;
  let stillUnresolved = 0;

  for (const row of rowsResult.rows) {
    const normalized = normalizeDepartmentCode(row.location_department);

    if (!normalized) {
      // Not a code and not a recognized name either - leave it exactly as
      // stored (same "null over invented data" rule as everywhere else in
      // departmentRegion.ts); nothing to correct it to.
      stillUnresolved++;
      continue;
    }

    if (normalized === row.location_department) {
      // Already a valid code, byte-for-byte - this is the common case
      // (BOAMP/DECP already normalize before this ever reaches the DB) and
      // isn't touched.
      alreadyValid++;
      continue;
    }

    // Genuinely mis-stored (a name, lowercase, un-padded, etc.) - correct
    // it, and backfill location_region from the now-resolved department
    // too if the row didn't already have one (same reasoning as
    // backfillLocationRegion.ts: a wrong/missing department was very
    // likely dragging a missing region down with it).
    const region = regionForDepartmentCode(normalized);
    await db.query(
      `UPDATE opportunities
       SET location_department = $1,
           location_region = COALESCE(location_region, $2),
           updated_at = NOW()
       WHERE id = $3`,
      [normalized, region, row.id]
    );
    corrected++;
  }

  console.log('\n--- Backfill summary ---');
  console.log(`Corrected (was a name or malformed code, now the real INSEE code): ${corrected}`);
  console.log(`Already a valid code (untouched): ${alreadyValid}`);
  console.log(`Still unresolved (neither a known code nor a known département name - left as stored): ${stillUnresolved}`);

  process.exit(0);
}

main().catch(err => {
  console.error('Backfill script crashed:', err);
  process.exit(1);
});
