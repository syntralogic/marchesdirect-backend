/**
 * BACKFILL — location_region / location_department
 * ============================================================================
 * Context: client reported the region map (and region/department filters)
 * showing only a handful of opportunities per region while the site claims
 * 47,000+ total. Root cause: the DECP connector - the largest volume source
 * - never captured any location field at all (location_region/department/
 * city were hardcoded null on every DECP row), and the BOAMP connector only
 * used the source's own `region` field, leaving it null on records where
 * BOAMP populated `departement` but not `region`. See
 * src/utils/departmentRegion.ts for the department->region derivation this
 * script (and the connectors, going forward) now use.
 *
 * This is a RECOVERY script, not a re-import: DECP/BOAMP always kept the
 * full raw source record in opportunities.raw_data (see `raw: record` in
 * each normalizer), so the location code is usually still sitting there for
 * rows that predate this fix - we don't need to re-download or re-fetch
 * anything, just re-derive location_region/department from data already on
 * disk. Only opportunities missing location_region are touched; nothing
 * with a real region already set is overwritten.
 *
 * SCOPE NOTE: this recovers BOAMP rows instantly, since BOAMP's raw_data
 * already contained a department field even before this fix - only the
 * derivation step was missing. Pre-existing DECP rows are a different
 * story: the OLD connector code never even requested a location column
 * from the Parquet file, so their stored raw_data genuinely has nothing to
 * recover (this script will correctly report those as "still unresolved").
 * Those will self-heal automatically without running anything extra here -
 * bulkUpsertOpportunities is an upsert keyed on (source_id,
 * source_reference), so DECP's own next scheduled run re-fetches the file
 * with the now-widened column list and overwrites those same rows with
 * real location data. This script is what closes the gap for BOAMP rows
 * *today*, without waiting on DECP's next run (or several, given its
 * per-run record cap) to slowly self-heal on its own.
 *
 * HONESTY NOTE: never run against a live database from this sandbox (no
 * DATABASE_URL here). Typechecked and logic-reviewed only - run for real on
 * Render/wherever DATABASE_URL points to production, then re-check the map.
 *
 * HOW TO RUN:
 *   npx ts-node scripts/backfillLocationRegion.ts             # dry count + confirm prompt
 *   npx ts-node scripts/backfillLocationRegion.ts --yes        # no prompt (e.g. cron/CI)
 *   npx ts-node scripts/backfillLocationRegion.ts --yes --limit 5000
 */
import { db } from '../src/config/database';
import { regionForDepartmentCode, normalizeDepartmentCode } from '../src/utils/departmentRegion';
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

// Pulls a department-code-shaped value out of a raw source record,
// regardless of which connector produced it - tries every field name the
// live connectors are now known (or guessed) to use.
const extractDepartmentCode = (raw: any): string | null => {
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
};

async function main() {
  const countResult = await db.query(
    `SELECT COUNT(*)::int AS count FROM opportunities
     WHERE (location_region IS NULL OR location_region = '') AND raw_data IS NOT NULL`
  );
  const total = countResult.rows[0].count;
  console.log(`Found ${total} opportunities with no location_region set (raw_data present).`);

  if (total === 0) {
    console.log('Nothing to do.');
    process.exit(0);
  }

  const proceed = await confirm(`Attempt to recover location_region/department for ${limit ? Math.min(limit, total) : total} of them from their stored raw_data?`);
  if (!proceed) {
    console.log('Aborted.');
    process.exit(0);
  }

  const rowsResult = await db.query(
    `SELECT id, raw_data, location_department FROM opportunities
     WHERE (location_region IS NULL OR location_region = '') AND raw_data IS NOT NULL
     ORDER BY created_at DESC
     ${limit ? 'LIMIT $1' : ''}`,
    limit ? [limit] : []
  );

  let recovered = 0;
  let stillUnresolved = 0;

  for (const row of rowsResult.rows) {
    const deptFromRaw = extractDepartmentCode(row.raw_data);
    const dept = normalizeDepartmentCode(row.location_department) || deptFromRaw;
    const region = regionForDepartmentCode(dept);

    if (region) {
      await db.query(
        `UPDATE opportunities SET location_region = $1, location_department = COALESCE(location_department, $2), updated_at = NOW() WHERE id = $3`,
        [region, dept, row.id]
      );
      recovered++;
    } else {
      stillUnresolved++;
    }
  }

  console.log('\n--- Backfill summary ---');
  console.log(`Recovered a region for: ${recovered}`);
  console.log(`Still unresolved (no department-like code found in raw_data - likely a source that never carried location at all, e.g. an older DECP row from before the widened column list): ${stillUnresolved}`);

  process.exit(0);
}

main().catch(err => {
  console.error('Backfill script crashed:', err);
  process.exit(1);
});
