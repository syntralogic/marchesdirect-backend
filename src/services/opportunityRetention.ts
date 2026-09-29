import { db } from '../config/database';
import { logger } from '../utils/logger';

// ============================================================================
// CLOSED-OPPORTUNITY RETENTION
// ============================================================================
// The database was carrying ~768k opportunities, nearly all of them closed
// (DECP "Attribué" awards + expired notices). That bloats the DB (Supabase
// free plan is 500 MB) and slows search. Rule:
//   - OPEN opportunities (status active/updated, deadline not passed or not
//     set) are NEVER touched and always sort first in listings.
//   - CLOSED ones (awarded / expired / cancelled) are capped at
//     CLOSED_OPPORTUNITIES_LIMIT (default 100,000). Newest are kept, the
//     oldest beyond the cap are deleted.
//   - Ingestion (DECP) stops adding closed rows once the cap is reached, so
//     the DB never balloons in the first place.
// Override with the CLOSED_OPPORTUNITIES_LIMIT env var.
// ============================================================================

export const CLOSED_STATUSES = ['awarded', 'expired', 'cancelled'];

export const getClosedLimit = (): number => {
  const n = Number(process.env.CLOSED_OPPORTUNITIES_LIMIT);
  return n > 0 ? Math.floor(n) : 100000;
};

const PRUNE_BATCH = 5000;
// Safety valve per run so one pass can't hold the pool for too long.
const MAX_BATCHES_PER_RUN = 60;

export async function countClosedOpportunities(): Promise<number> {
  const r = await db.query(
    `SELECT COUNT(*)::int AS n FROM opportunities
     WHERE status = ANY($1::text[]) AND deleted_at IS NULL`,
    [CLOSED_STATUSES]
  );
  return r.rows[0]?.n ?? 0;
}

// How many more closed rows may still be ingested before hitting the cap.
export async function closedRoomLeft(): Promise<number> {
  return Math.max(0, getClosedLimit() - (await countClosedOpportunities()));
}

// Deletes the oldest closed opportunities beyond the cap. Rows a user cares
// about (favorites, dossiers, alerts, tenders) are never deleted.
export async function pruneClosedOpportunities(): Promise<number> {
  const limit = getClosedLimit();
  let excess = (await countClosedOpportunities()) - limit;
  if (excess <= 0) return 0;

  logger.info(`[Retention] ${excess} closed opportunities over the ${limit} cap - pruning oldest first`);
  let deleted = 0;

  for (let i = 0; i < MAX_BATCHES_PER_RUN && excess > 0; i++) {
    const take = Math.min(PRUNE_BATCH, excess);
    const r = await db.query(
      `DELETE FROM opportunities
       WHERE id IN (
         SELECT o.id FROM opportunities o
         WHERE o.status = ANY($1::text[]) AND o.deleted_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM favorites f WHERE f.opportunity_id = o.id)
           AND NOT EXISTS (SELECT 1 FROM session_favorites sf WHERE sf.opportunity_id = o.id)
           AND NOT EXISTS (SELECT 1 FROM dossier_requests d WHERE d.opportunity_id = o.id)
           AND NOT EXISTS (SELECT 1 FROM company_alerts a WHERE a.opportunity_id = o.id)
           AND NOT EXISTS (SELECT 1 FROM tenders t WHERE t.opportunity_id = o.id)
         ORDER BY o.publication_date ASC, o.created_at ASC
         LIMIT $2
       )`,
      [CLOSED_STATUSES, take]
    );
    const n = r.rowCount || 0;
    if (n === 0) break; // nothing deletable left (all protected)
    deleted += n;
    excess -= n;
  }

  logger.info(`[Retention] Pruned ${deleted} closed opportunities (cap ${limit}).`);
  return deleted;
}
