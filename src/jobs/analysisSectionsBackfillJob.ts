/**
 * ANALYSIS SECTIONS BACKFILL JOB
 * =========================================================================
 * Client's 10 Sep spec: the opportunity page's AI analysis should be split
 * into 3 fixed accordions (Présentation du marché / Conditions et points à
 * vérifier / Entreprises concernées) - see aiService.ts's
 * generateOpportunityAnalysisSections for the generation itself and
 * schema.sql for the ai_analysis_sections column.
 *
 * Cost fix (11 Sep, client flagged AI spend): this was bumped to 50 every
 * 5 min (~600/hour) to clear a one-time stuck-record backlog fast for
 * go-live. That throughput, combined with aiProcessing.ts's own bump to
 * 150/5min, is what actually drove spend up - not any single call's cost.
 * Dialed back down to 20 every 15 min (~80/hour): still faster than the
 * original hourly-10 steady-state pace, but nowhere near the emergency
 * rate. On-demand generation (routes/opportunities.ts, triggered the
 * moment a visitor opens a fiche) still covers any specific record
 * immediately regardless of this job's pace - this cron is only for
 * opportunities nobody has viewed yet.
 */

import { generateAnalysisSectionsForOpportunities } from '../services/aiService';
import { logger } from '../utils/logger';

export const startAnalysisSectionsBackfillJob = () => {
  const cron = require('node-cron');

  setTimeout(() => {
    generateAnalysisSectionsForOpportunities(20).catch(err =>
      logger.error('[Job] Boot-time analysis-sections backfill failed (non-fatal):', err)
    );
  }, 45_000);

  cron.schedule('*/15 * * * *', () => {
    generateAnalysisSectionsForOpportunities(20).catch(err =>
      logger.error('[Job] Scheduled analysis-sections backfill failed (non-fatal):', err)
    );
  });

  logger.info('✅ Analysis-sections backfill job scheduled (batch of 20 on boot, then every 15 min)');
};
