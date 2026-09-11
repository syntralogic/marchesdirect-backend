/**
 * ANALYSIS SECTIONS BACKFILL JOB
 * =========================================================================
 * Client's 10 Sep spec: the opportunity page's AI analysis should be split
 * into 3 fixed accordions (Présentation du marché / Conditions et points à
 * vérifier / Entreprises concernées) - see aiService.ts's
 * generateOpportunityAnalysisSections for the generation itself and
 * schema.sql for the ai_analysis_sections column.
 *
 * That column starts NULL on every already-ingested opportunity (tens of
 * thousands of rows) and on every new one until this job reaches it, so
 * this runs the same "small batch on boot, then hourly" shape as
 * staleSummaryBackfillJob.ts - one paid Claude call per row, so
 * deliberately throttled unlike the free bulk-SQL backfills
 * (facts/location-region).
 *
 * Bumped 30/hour -> 50 every 5 min (11 Sep, going-live push): the
 * free-text-JSON generation approach (fixed in aiService.ts - see
 * callClaudeAPIWithTool) left a large backlog of rows stuck on
 * ai_analysis_sections_status='failed' from before that fix, which this
 * same WHERE clause already retries (generateAnalysisSectionsForOpportunities
 * selects not_generated/failed) - just too slowly at 30/hour to clear
 * before go-live. This is intentionally aggressive to work through that
 * one-time backlog fast; safe to dial back down to hourly once
 * GET /api/admin/data-sources (or the analysis-sections-batch endpoint)
 * shows the failed/not_generated count near zero.
 */

import { generateAnalysisSectionsForOpportunities } from '../services/aiService';
import { logger } from '../utils/logger';

export const startAnalysisSectionsBackfillJob = () => {
  const cron = require('node-cron');

  setTimeout(() => {
    generateAnalysisSectionsForOpportunities(50).catch(err =>
      logger.error('[Job] Boot-time analysis-sections backfill failed (non-fatal):', err)
    );
  }, 45_000);

  // Every 5 minutes while clearing the pre-fix backlog (see comment above).
  cron.schedule('*/5 * * * *', () => {
    generateAnalysisSectionsForOpportunities(50).catch(err =>
      logger.error('[Job] Scheduled analysis-sections backfill failed (non-fatal):', err)
    );
  });

  logger.info('✅ Analysis-sections backfill job scheduled (batch of 50 on boot, then every 5 min)');
};
