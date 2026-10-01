/**
 * REPAIR - notices whose location came from a buyer name, not a place
 * ============================================================================
 * 30 Sep client audit (point 2): the Saint-Étienne (Loire, 42) cleaning notice
 * showed "Ville de Saint Etienne, 47, Nouvelle-Aquitaine" and surfaced in
 * Nouvelle-Aquitaine searches. Cause (fixed in geocodingService.ts): a
 * buyer-style location_city was geocoded as if it were a commune and the
 * department/region of a differently-named commune were written onto the row.
 *
 * Already-stored rows keep those values (geocodingBackfillJob only ever fills
 * empty department/region), so this one-off clears them for exactly the rows
 * at risk: location_city starts with "Ville de/Commune de/Mairie de..." or is
 * identical to buyer_name. For each, department/region are re-derived from the
 * notice's own structured fields (or its postal code) when the source has
 * them; otherwise they are cleared so the corrected geocoder can place them
 * again. Coordinates are cleared in both cases.
 *
 * Never run from the build sandbox (no DATABASE_URL). Run on the server:
 *   npx ts-node scripts/repairBuyerNameLocations.ts          # counts, asks to confirm
 *   npx ts-node scripts/repairBuyerNameLocations.ts --yes
 */
import readline from 'readline';
import { db } from '../src/config/database';
import { extractDepartmentCode, extractDepartmentCodeFromFreeText, normalizeDepartmentCode, regionForDepartmentCode } from '../src/utils/departmentRegion';

const autoConfirm = process.argv.includes('--yes');
const confirm = (q: string): Promise<boolean> => {
  if (autoConfirm) return Promise.resolve(true);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(`${q} (y/N) `, (a) => { rl.close(); resolve(a.trim().toLowerCase() === 'y'); }));
};

const AT_RISK_SQL = `
  deleted_at IS NULL AND location_city IS NOT NULL AND (
    location_city ~* '^\\s*(ville|commune|mairie|municipalit[ée])\\s+(de|d''|du|des)'
    OR (buyer_name IS NOT NULL AND lower(trim(location_city)) = lower(trim(buyer_name)))
  )`;

async function main() {
  const { rows: [{ count }] } = await db.query(`SELECT COUNT(*)::int AS count FROM opportunities WHERE ${AT_RISK_SQL}`);
  console.log(`${count} notices have a buyer-style location_city.`);
  if (count === 0 || !(await confirm('Re-derive / clear their department, region and coordinates?'))) process.exit(0);

  let fixed = 0;
  let cleared = 0;
  const BATCH = 1000;
  let lastId = '00000000-0000-0000-0000-000000000000';
  for (;;) {
    const { rows } = await db.query(
      `SELECT id, raw_data FROM opportunities WHERE ${AT_RISK_SQL} AND id > $1::uuid ORDER BY id LIMIT ${BATCH}`,
      [lastId]
    );
    if (rows.length === 0) break;
    for (const r of rows) {
      lastId = r.id;
      const dept = extractDepartmentCode(r.raw_data) || extractDepartmentCodeFromFreeText(r.raw_data);
      const code = normalizeDepartmentCode(dept);
      const region = regionForDepartmentCode(code);
      await db.query(
        `UPDATE opportunities SET location_department = $2, location_region = $3,
           location_latitude = NULL, location_longitude = NULL, location_geocode_verified = FALSE, updated_at = NOW()
         WHERE id = $1`,
        [r.id, code, region]
      );
      if (code) fixed++; else cleared++;
    }
  }
  console.log(`Done: ${fixed} re-derived from the source, ${cleared} cleared for re-geocoding.`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
