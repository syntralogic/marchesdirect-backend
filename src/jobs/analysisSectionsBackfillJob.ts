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
 */

import { generateAnalysisSectionsForOpportunities } from '../services/aiService';
import { logger } from '../utils/logger';

export const startAnalysisSectionsBackfillJob = () => {
  const cron = require('node-cron');

  setTimeout(() => {
    generateAnalysisSectionsForOpportunities(30).catch(err =>
      logger.error('[Job] Boot-time analysis-sections backfill failed (non-fatal):', err)
    );
  }, 45_000);

  // Every hour, small batch - same cadence/reasoning as the summary backfill.
  // Bumped 10 -> 30 (10 Sep): with tens of thousands of pre-existing
  // opportunities and only on-demand generation otherwise reaching a given
  // fiche, 10/hour meant most of the backlog would still be showing the old
  // single-paragraph ai_summary fallback for weeks.
  cron.schedule('15 * * * *', () => {
    generateAnalysisSectionsForOpportunities(30).catch(err =>
      logger.error('[Job] Scheduled analysis-sections backfill failed (non-fatal):', err)
    );
  });

  logger.info('✅ Analysis-sections backfill job scheduled (batch of 30 on boot, then hourly)');
};
