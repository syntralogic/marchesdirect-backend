/**
 * NATURE-DE-LA-PRESTATION BACKFILL JOB
 * ==========================================================================
 * Perf bug found in user testing (30 Sep): selecting "Nature de la
 * prestation" (Travaux/Fournitures/etc.) on the public search took 15-17s
 * even with the OFFSET-0 inlining fix in naturePrestationLateral (see that
 * file's comment) - because ai_classification_status is 'not_analyzed' on
 * virtually the entire table (the AI classification pass hasn't caught up
 * with the historical import), every single row falls through to the
 * ~20-regex heuristic in naturePrestationSql, computed fresh on every
 * request that filters or sorts by nature. That cost is real and belongs
 * in a background job, not on the request path.
 *
 * This writes the SAME heuristic (inferNaturePrestation - the JS twin of
 * naturePrestationSql, see that file) into the nature_prestation column
 * itself wherever it's still NULL. Once a row has a value there,
 * naturePrestationSql's COALESCE short-circuits on the stored column and
 * never touches the regex branch for that row again. Never overwrites a
 * value classifyOpportunity() (the real AI pass) already set - same
 * COALESCE-favors-AI contract naturePrestationSql documents.
 *
 * Same cursor-over-null-rows shape as locationRegionBackfillJob: walks
 * newest -> oldest, wraps once it reaches the end so newly-ingested rows
 * get picked up on the next pass too. A row where the heuristic finds
 * nothing stays NULL (same "genuinely unreadable, don't guess" contract as
 * the live query path) - the cursor still advances past it so the job
 * doesn't spin on the same unresolvable rows forever.
 */

import { db } from '../config/database';
import { logger } from '../utils/logger';
import { inferNaturePrestation } from '../utils/naturePrestation';
import { trackJob } from '../utils/jobTracker';

const CHUNK_SIZE = 500;

let backfillCursor: { createdAt: string; id: string } | null = null;

export async function runNatureBackfillBatch(limit = 8000): Promise<{ resolved: number; unresolved: number }> {
  let rows: { id: string; title: string | null; description: string | null; created_at_txt: string }[];
  try {
    const result = await db.query(
      `SELECT id, title, description, created_at::text AS created_at_txt FROM opportunities
       WHERE nature_prestation IS NULL AND deleted_at IS NULL
         AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::uuid))
       ORDER BY created_at DESC, id DESC
       LIMIT $1`,
      [limit, backfillCursor?.createdAt ?? null, backfillCursor?.id ?? null]
    );
    rows = result.rows;
    if (rows.length < limit) {
      backfillCursor = null; // reached the end - wrap to the start next run
    } else {
      const last = rows[rows.length - 1];
      backfillCursor = { createdAt: last.created_at_txt, id: last.id };
    }
  } catch (err) {
    logger.error('[Job] Nature backfill query failed:', err);
    return { resolved: 0, unresolved: 0 };
  }

  if (rows.length === 0) {
    logger.info('[Job] Nature backfill: nothing outstanding.');
    return { resolved: 0, unresolved: 0 };
  }

  let resolved = 0;
  let unresolved = 0;
  const toWrite: { id: string; nature: string }[] = [];

  for (const row of rows) {
    const nature = inferNaturePrestation(row.title, row.description);
    if (nature) {
      toWrite.push({ id: row.id, nature });
      resolved++;
    } else {
      unresolved++;
    }
  }

  for (let i = 0; i < toWrite.length; i += CHUNK_SIZE) {
    const chunk = toWrite.slice(i, i + CHUNK_SIZE);
    const values: any[] = [];
    const rowsSql: string[] = [];
    chunk.forEach((r, idx) => {
      const base = idx * 2;
      rowsSql.push(`($${base + 1}::uuid, $${base + 2})`);
      values.push(r.id, r.nature);
    });
    try {
      await db.query(
        // Guard against a race with the AI classification job resolving the
        // same row between our SELECT and this UPDATE - never clobber a
        // value it just set.
        `UPDATE opportunities AS o
         SET nature_prestation = v.nature
         FROM (VALUES ${rowsSql.join(', ')}) AS v(id, nature)
         WHERE o.id = v.id AND o.nature_prestation IS NULL`,
        values
      );
    } catch (err) {
      logger.error(`[Job] Nature backfill chunk starting at ${i} failed:`, err);
    }
  }

  logger.info(`[Job] Nature backfill run complete: ${resolved} resolved, ${unresolved} left unreadable this run (remainder picks up next run).`);
  return { resolved, unresolved };
}

export const startNatureBackfillJob = () => {
  const cron = require('node-cron');

  setTimeout(() => {
    trackJob('natureBackfill:boot', () => runNatureBackfillBatch())
      .catch(err => logger.error('[Job] Boot-time nature backfill failed (non-fatal):', err));
  }, 25_000);

  // Same 3-minute/8,000-row cadence as locationRegionBackfillJob - a plain
  // regex match in JS per row plus one chunked bulk UPDATE, no external
  // API, no reason to go slower than that.
  cron.schedule('*/3 * * * *', () => {
    trackJob('natureBackfill:cron', () => runNatureBackfillBatch())
      .catch(err => logger.error('[Job] Scheduled nature backfill failed (non-fatal):', err));
  });

  logger.info('✅ Nature-de-la-prestation backfill job scheduled (batch of 8,000 on boot, then every 3 minutes until the backlog clears)');
};
