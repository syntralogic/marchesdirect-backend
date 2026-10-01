/**
 * LEGACY DATA REPAIR (runs by itself - no shell needed, e.g. Render free tier)
 * ============================================================================
 * 1 Oct client report. Two one-off repairs that used to require a manual run
 * on the server:
 *
 *  1. buyer-name locations (was scripts/repairBuyerNameLocations.ts): rows whose
 *     location_city is a buyer ("Ville de Saint Etienne") got the department/
 *     region of a differently-named commune. Re-derived from the notice's own
 *     fields, or cleared so the corrected geocoder can place them again.
 *     Runs ONCE (guarded by app_once_migrations), otherwise re-geocoded rows
 *     would be cleared again on every pass.
 *
 *  2. BOAMP lots (was "re-ingest/reindex"): old BOAMP notices were imported
 *     before the lots in `donnees` were appended to the description, so a lot
 *     such as "Électricité CFO-CFA" was not searchable. Rebuilds the
 *     description from raw_data (same withLotsText as ingestion). search_vector
 *     is a GENERATED column, so it follows the description automatically.
 *     Walks the table by id in small batches (cursor persisted in the DB so a
 *     redeploy/sleep of the free instance resumes where it stopped).
 *
 * Both are idempotent and deliberately gentle: small batches, one at a time.
 */
import { db } from '../config/database';
import { logger } from '../utils/logger';
import { trackJob } from '../utils/jobTracker';
import { extractBoampLotsText, withLotsText } from '../utils/boampLots';
import {
  extractDepartmentCode,
  extractDepartmentCodeFromFreeText,
  normalizeDepartmentCode,
  regionForDepartmentCode,
} from '../utils/departmentRegion';

const BUYER_KEY = 'repair_buyer_name_locations_v1';
const LOTS_KEY = 'backfill_boamp_lots_v1';
const LOTS_BATCH = 300;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

const AT_RISK_SQL = `
  deleted_at IS NULL AND location_city IS NOT NULL AND (
    location_city ~* '^\\s*(ville|commune|mairie|municipalit[ée])\\s+(de|d''|du|des)'
    OR (buyer_name IS NOT NULL AND lower(trim(location_city)) = lower(trim(buyer_name)))
  )`;

async function ensureTables(): Promise<void> {
  await db.query(
    `CREATE TABLE IF NOT EXISTS app_once_migrations (key TEXT PRIMARY KEY, done_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`
  );
  await db.query(
    `CREATE TABLE IF NOT EXISTS legacy_repair_cursor (key TEXT PRIMARY KEY, last_id TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`
  );
}

async function isDone(key: string): Promise<boolean> {
  const r = await db.query('SELECT 1 FROM app_once_migrations WHERE key = $1', [key]);
  return r.rows.length > 0;
}

async function markDone(key: string): Promise<void> {
  await db.query('INSERT INTO app_once_migrations (key) VALUES ($1) ON CONFLICT DO NOTHING', [key]);
}

export async function repairBuyerNameLocations(): Promise<number> {
  if (await isDone(BUYER_KEY)) return 0;
  let touched = 0;
  let lastId = NIL_UUID;
  for (;;) {
    const { rows } = await db.query(
      `SELECT id, raw_data FROM opportunities WHERE ${AT_RISK_SQL} AND id > $1::uuid ORDER BY id LIMIT 500`,
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
      touched++;
    }
  }
  await markDone(BUYER_KEY);
  logger.info(`[Repair] Buyer-name locations: ${touched} notices re-derived/cleared (one-off, done).`);
  return touched;
}

export async function backfillBoampLotsBatch(): Promise<{ updated: number; done: boolean }> {
  if (await isDone(LOTS_KEY)) return { updated: 0, done: true };

  const cur = await db.query('SELECT last_id FROM legacy_repair_cursor WHERE key = $1', [LOTS_KEY]);
  const lastId: string = cur.rows[0]?.last_id ?? NIL_UUID;

  const { rows } = await db.query(
    `SELECT o.id, o.description, o.raw_data
       FROM opportunities o
       JOIN data_sources ds ON o.source_id = ds.id
      WHERE ds.code = 'boamp' AND o.deleted_at IS NULL AND o.id > $1::uuid
      ORDER BY o.id
      LIMIT ${LOTS_BATCH}`,
    [lastId]
  );

  if (rows.length === 0) {
    await markDone(LOTS_KEY);
    logger.info('[Repair] BOAMP lots backfill complete.');
    return { updated: 0, done: true };
  }

  let updated = 0;
  for (const r of rows) {
    const raw = r.raw_data && typeof r.raw_data === 'string' ? safeParse(r.raw_data) : r.raw_data;
    const fields = raw?.fields ?? raw;
    const lots = extractBoampLotsText(fields?.donnees);
    if (!lots) continue;
    const current: string = r.description || '';
    const next = withLotsText(current, lots);
    if (next === current) continue; // already holds the lots - nothing to do
    await db.query('UPDATE opportunities SET description = $2, updated_at = NOW() WHERE id = $1', [r.id, next]);
    updated++;
  }

  const newCursor = rows[rows.length - 1].id;
  await db.query(
    `INSERT INTO legacy_repair_cursor (key, last_id) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET last_id = EXCLUDED.last_id, updated_at = NOW()`,
    [LOTS_KEY, newCursor]
  );
  logger.info(`[Repair] BOAMP lots backfill: ${updated}/${rows.length} descriptions enriched in this batch.`);
  return { updated, done: false };
}

function safeParse(s: string): any {
  try { return JSON.parse(s); } catch { return null; }
}

export const startLegacyRepairJob = () => {
  const cron = require('node-cron');

  // One-off location repair shortly after boot, then lots backfill batches
  // every 2 minutes until the table has been walked once.
  setTimeout(() => {
    trackJob('legacyRepair:boot', async () => {
      await ensureTables();
      await repairBuyerNameLocations();
      await backfillBoampLotsBatch();
    }).catch(err => logger.error('[Repair] Boot-time legacy repair failed (non-fatal):', err));
  }, 45_000);

  cron.schedule('*/2 * * * *', () => {
    trackJob('legacyRepair:cron', async () => {
      await ensureTables();
      await repairBuyerNameLocations(); // no-op once done
      await backfillBoampLotsBatch();   // no-op once done
    }).catch(err => logger.error('[Repair] Scheduled legacy repair failed (non-fatal):', err));
  });

  logger.info('✅ Legacy repair job scheduled (buyer-name locations once, BOAMP lots in batches of 300 every 2 min until done)');
};
