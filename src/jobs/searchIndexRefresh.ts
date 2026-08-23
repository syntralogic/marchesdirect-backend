import cron from 'node-cron';
import { db } from '../config/database';
import { logger } from '../utils/logger';

// ============================================================================
// SEARCH INDEX REFRESH (supports Milestone 5 search + Milestone 12 performance
// at scale)
//
// schema.sql defines `opportunity_search_index` as a materialized view for
// fast full-text search, but nothing in the codebase was ever refreshing it -
// it would have stayed frozen at whatever it looked like the moment the
// schema was first loaded. This job keeps it current.
//
// Uses REFRESH ... CONCURRENTLY (requires the unique index on `id` added in
// schema.sql) so refreshing doesn't block reads against the view while it
// rebuilds - important once the table is at the ~1M row scale referenced in
// the Technical Requirements' performance test.
// ============================================================================

export const refreshSearchIndex = async () => {
  const startedAt = Date.now();
  try {
    await db.query('REFRESH MATERIALIZED VIEW CONCURRENTLY opportunity_search_index');
    logger.info(`[Job] Search index refreshed in ${Date.now() - startedAt}ms`);
    return { success: true, durationMs: Date.now() - startedAt };
  } catch (err: any) {
    logger.error('[Job] Search index refresh failed:', err);
    return { success: false, error: err.message };
  }
};

export const startSearchIndexRefresh = () => {
  // Every 15 minutes - frequent enough that new/updated opportunities show up
  // in search reasonably quickly, without refreshing on every single write.
  cron.schedule('*/15 * * * *', () => {
    refreshSearchIndex();
  });

  logger.info('✅ Search index refresh scheduled (every 15 minutes)');
};
