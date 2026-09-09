/**
 * scripts/backfillRegionNames.js
 *
 * Client's 9 Sep report: selecting all 13 current regions on the map map
 * only returned ~1,500 of the ~40k opportunities expected. Root cause (see
 * src/utils/departmentRegion.ts, normalizeRegionName): normalizeBoampRecord
 * used to trust BOAMP's raw `region` field as-is, and BOAMP still surfaces
 * pre-2016 région names ("Nord-Pas-de-Calais", "Midi-Pyrénées", ...) plus
 * occasional accent/casing mismatches - none of which match any of the 13
 * current region names the map filter searches by.
 *
 * That fix only changes region resolution for newly-ingested rows. This
 * script re-normalizes location_region on every already-ingested row so the
 * ~47k rows already in production benefit too, without re-fetching from any
 * source (uses the same normalizeRegionName logic against the existing
 * column value, falling back to location_department via
 * regionForDepartmentCode exactly like the live connectors do when a
 * region string doesn't resolve).
 *
 * Safe to re-run - every row is independently re-derived, nothing is
 * skipped or accumulated across runs.
 *
 * Usage:
 *   node scripts/backfillRegionNames.js          # apply
 *   node scripts/backfillRegionNames.js --dry-run # report counts only, no writes
 */

require("dotenv").config();
const { Pool } = require("pg");

const DRY_RUN = process.argv.includes("--dry-run");

const connectionString = process.env.DATABASE_URL;
const pool = connectionString
  ? new Pool({ connectionString, ssl: process.env.DB_SSL === "false" ? false : { rejectUnauthorized: false } })
  : new Pool({
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      host: process.env.DB_HOST,
      port: parseInt(process.env.DB_PORT || "5432", 10),
      database: process.env.DB_NAME,
      ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : false,
    });

// Mirrors src/utils/departmentRegion.ts exactly (that file is TypeScript;
// this script runs directly under plain node like the other scripts/*.js
// files, so the mapping is duplicated rather than requiring a ts-node
// dependency just for a one-off backfill - keep the two in sync if the
// region reform mapping ever changes, which it won't: it's a closed,
// finished piece of French administrative history from 2016).
const OLD_TO_NEW_REGION = {
  'alsace': 'Grand Est', 'champagne-ardenne': 'Grand Est', 'lorraine': 'Grand Est',
  'aquitaine': 'Nouvelle-Aquitaine', 'limousin': 'Nouvelle-Aquitaine', 'poitou-charentes': 'Nouvelle-Aquitaine',
  'auvergne': 'Auvergne-Rhône-Alpes', 'rhone-alpes': 'Auvergne-Rhône-Alpes',
  'bourgogne': 'Bourgogne-Franche-Comté', 'franche-comte': 'Bourgogne-Franche-Comté',
  'basse-normandie': 'Normandie', 'haute-normandie': 'Normandie',
  'languedoc-roussillon': 'Occitanie', 'midi-pyrenees': 'Occitanie',
  'nord-pas-de-calais': 'Hauts-de-France', 'picardie': 'Hauts-de-France',
  'centre': 'Centre-Val de Loire',
};
const CURRENT_REGIONS = [
  'Île-de-France', 'Centre-Val de Loire', 'Bourgogne-Franche-Comté', 'Normandie',
  'Hauts-de-France', 'Grand Est', 'Pays de la Loire', 'Bretagne', 'Nouvelle-Aquitaine',
  'Occitanie', 'Auvergne-Rhône-Alpes', "Provence-Alpes-Côte d'Azur", 'Corse',
];
const stripAccents = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const CURRENT_REGION_BY_KEY = {};
for (const name of CURRENT_REGIONS) CURRENT_REGION_BY_KEY[stripAccents(name).toLowerCase()] = name;

const DEPARTMENT_TO_REGION_BY_KEY = require("./_departmentToRegion.json");

function normalizeRegionName(raw) {
  if (!raw) return null;
  const key = stripAccents(String(raw).trim().toLowerCase());
  if (!key) return null;
  return CURRENT_REGION_BY_KEY[key] || OLD_TO_NEW_REGION[key] || null;
}

function regionForDepartmentCode(raw) {
  if (!raw) return null;
  const code = String(raw).trim().toUpperCase();
  return DEPARTMENT_TO_REGION_BY_KEY[code] || null;
}

async function main() {
  console.log(`[backfillRegionNames] Starting${DRY_RUN ? " (dry run)" : ""}...`);

  const { rows } = await pool.query(
    `SELECT id, location_region, location_department FROM opportunities`
  );
  console.log(`[backfillRegionNames] ${rows.length} rows loaded`);

  let unchanged = 0, resolved = 0, stillNull = 0;
  const updates = [];

  for (const row of rows) {
    const next = normalizeRegionName(row.location_region) || regionForDepartmentCode(row.location_department) || null;
    if (next === row.location_region) {
      unchanged++;
      continue;
    }
    if (next) resolved++; else stillNull++;
    updates.push({ id: row.id, next });
  }

  console.log(`[backfillRegionNames] ${unchanged} already correct, ${resolved} will be fixed to a current region, ${stillNull} will be cleared to NULL (unrecognized, was probably garbage already)`);

  if (DRY_RUN) {
    console.log("[backfillRegionNames] Dry run - no writes made. Sample of changes:");
    console.table(updates.slice(0, 20));
    await pool.end();
    return;
  }

  const CHUNK = 500;
  for (let i = 0; i < updates.length; i += CHUNK) {
    const chunk = updates.slice(i, i + CHUNK);
    await pool.query(
      `UPDATE opportunities AS o SET location_region = c.next
       FROM (SELECT * FROM UNNEST($1::uuid[], $2::text[]) AS t(id, next)) AS c
       WHERE o.id = c.id`,
      [chunk.map(u => u.id), chunk.map(u => u.next)]
    );
    console.log(`[backfillRegionNames] Updated ${Math.min(i + CHUNK, updates.length)}/${updates.length}`);
  }

  // The map/filter's per-region counts (GET /api/opportunities/stats/regions)
  // read straight off opportunities, not a cached view, so no separate
  // refresh step is needed there - but the search results themselves come
  // from opportunity_search_index (a MATERIALIZED view), which won't pick
  // this up until its own periodic refresh (jobs/searchIndexRefresh.ts).
  console.log("[backfillRegionNames] Refreshing opportunity_search_index so results reflect this immediately...");
  await pool.query(`REFRESH MATERIALIZED VIEW CONCURRENTLY opportunity_search_index`);

  console.log("[backfillRegionNames] Done.");
  await pool.end();
}

main().catch((err) => {
  console.error("[backfillRegionNames] Failed:", err);
  process.exit(1);
});
