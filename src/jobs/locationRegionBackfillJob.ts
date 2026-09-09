/**
 * LOCATION-REGION BACKFILL JOB — automatic version of the admin HTTP route
 * ==========================================================================
 * Context: region map counts were showing 1-4 opportunities instead of
 * thousands because location_region is NULL on most rows (DECP - the
 * biggest volume source - never captured it; BOAMP only sometimes did).
 * admin.ts already has a POST /backfill-location-region route for this,
 * but it requires someone to actually call it (Postman/curl with an admin
 * token) - the client asked for this to just happen on its own, no manual
 * step required.
 *
 * Also fixes a real perf problem in that route: it updated one row at a
 * time in a for-loop (await per row). We already learned this the hard way
 * with DECP's insert loop - individual round trips on this DB run ~1-2s
 * each, so thousands of one-row-at-a-time UPDATEs would take a very long
 * time. This does one bulk UPDATE ... FROM (VALUES ...) per chunk instead.
 */

import { db } from '../config/database';
import { logger } from '../utils/logger';
import { extractDepartmentCode, normalizeDepartmentCode, regionForDepartmentCode } from '../utils/departmentRegion';
import { trackJob } from '../utils/jobTracker';

const CHUNK_SIZE = 500;

export async function runLocationRegionBackfillBatch(limit = 8000): Promise<{ recovered: number; unresolved: number }> {
  let rows: { id: string; raw_data: any; location_department: string | null }[];
  try {
    const result = await db.query(
      `SELECT id, raw_data, location_department FROM opportunities
       WHERE (location_region IS NULL OR location_region = '') AND raw_data IS NOT NULL
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit]
    );
    rows = result.rows;
  } catch (err) {
    logger.error('[Job] Location-region backfill query failed:', err);
    return { recovered: 0, unresolved: 0 };
  }

  if (rows.length === 0) {
    logger.info('[Job] Location-region backfill: nothing outstanding.');
    return { recovered: 0, unresolved: 0 };
  }

  let recovered = 0;
  let unresolved = 0;
  const resolved: { id: string; region: string; dept: string | null }[] = [];

  for (const row of rows) {
    const deptFromRaw = extractDepartmentCode(row.raw_data);
    const dept = normalizeDepartmentCode(row.location_department) || deptFromRaw;
    const region = regionForDepartmentCode(dept);
    if (region) {
      resolved.push({ id: row.id, region, dept });
    } else {
      unresolved++;
    }
  }

  for (let i = 0; i < resolved.length; i += CHUNK_SIZE) {
    const chunk = resolved.slice(i, i + CHUNK_SIZE);
    const values: any[] = [];
    const rowsSql: string[] = [];
    chunk.forEach((r, idx) => {
      const base = idx * 3;
      rowsSql.push(`($${base + 1}::uuid, $${base + 2}, $${base + 3})`);
      values.push(r.id, r.region, r.dept);
    });
    try {
      await db.query(
        `UPDATE opportunities AS o
         SET location_region = v.region, location_department = COALESCE(o.location_department, v.dept), updated_at = NOW()
         FROM (VALUES ${rowsSql.join(', ')}) AS v(id, region, dept)
         WHERE o.id = v.id`,
        values
      );
      recovered += chunk.length;
    } catch (err) {
      logger.error(`[Job] Location-region backfill chunk starting at ${i} failed:`, err);
    }
  }

  logger.info(`[Job] Location-region backfill run complete: ${recovered} recovered, ${unresolved} unresolved this run (remainder picks up next run).`);
  return { recovered, unresolved };
}

export const startLocationRegionBackfillJob = () => {
  const cron = require('node-cron');

  setTimeout(() => {
    trackJob('locationRegionBackfill:boot', () => runLocationRegionBackfillBatch())
      .catch(err => logger.error('[Job] Boot-time location-region backfill failed (non-fatal):', err));
  }, 20_000);

  // Every 3 minutes, 8,000 rows per run (bulk chunked UPDATE, not an
  // external API call, so there's no cost/rate-limit reason to go slow
  // here) - client feedback (screenshot, region counts still summing to
  // ~1,500 instead of ~40,000+): the previous cadence (2,000/30min) would
  // have taken roughly half a day to clear a 47k-row backlog. This
  // converges the whole backlog in well under an hour instead.
  cron.schedule('*/3 * * * *', () => {
    trackJob('locationRegionBackfill:cron', () => runLocationRegionBackfillBatch())
      .catch(err => logger.error('[Job] Scheduled location-region backfill failed (non-fatal):', err));
  });

  logger.info('✅ Location-region backfill job scheduled (batch of 8,000 on boot, then every 3 minutes until the backlog clears)');
};
