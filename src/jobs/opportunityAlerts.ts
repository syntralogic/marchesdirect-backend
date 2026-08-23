import cron from 'node-cron';
import { db } from '../config/database';
import { logger } from '../utils/logger';
import { matchOpportunitiesToCompany } from '../services/aiService';

// ============================================================================
// PROACTIVE ALERTS: new matching opportunities + bid deadline reminders
//
// company_alerts.alert_type was documented in schema.sql as supporting
// 'new_opportunity' and 'deadline_reminder' (alongside 'document_expiry',
// which the documentExpiry job does generate) - but nothing in the codebase
// ever actually created either of those two. The alert *infrastructure*
// (table, GET /api/alerts, mark-as-read) was fully built and wired to the
// dashboard, just never fed real alerts of these two types. This is exactly
// the "Receive relevant tenders" CTA the Technical Requirements (section 9)
// describe as a core lead-generation/retention loop, so leaving it
// unpopulated silently defeats a stated product requirement, not just a nice-
// to-have.
// ============================================================================

// New matching opportunities, once per company, since their last check.
// Dedup is against company_alerts itself (opportunity_id, company_id, type) so
// re-running this job never creates a second alert for the same match.
const alertNewMatches = async () => {
  const companies = await db.query(
    `SELECT id FROM companies WHERE status = 'active' AND deleted_at IS NULL`
  );

  let alertsCreated = 0;

  for (const company of companies.rows) {
    try {
      const matchedIds: string[] = await matchOpportunitiesToCompany(company.id);
      if (matchedIds.length === 0) continue;

      const alreadyAlerted = await db.query(
        `SELECT opportunity_id FROM company_alerts
         WHERE company_id = $1 AND alert_type = 'new_opportunity' AND opportunity_id = ANY($2::uuid[])`,
        [company.id, matchedIds]
      );
      const alreadyAlertedIds = new Set(alreadyAlerted.rows.map((r) => r.opportunity_id));
      const newIds = matchedIds.filter((id) => !alreadyAlertedIds.has(id));
      if (newIds.length === 0) continue;

      const opportunities = await db.query(
        `SELECT id, title, location_city FROM opportunities WHERE id = ANY($1::uuid[])`,
        [newIds]
      );

      for (const opp of opportunities.rows) {
        await db.query(
          `INSERT INTO company_alerts (company_id, alert_type, opportunity_id, title, message)
           VALUES ($1, 'new_opportunity', $2, $3, $4)`,
          [
            company.id,
            opp.id,
            `Nouvelle opportunite : ${opp.title}`,
            `Une nouvelle opportunite correspondant a votre profil est disponible${opp.location_city ? ` a ${opp.location_city}` : ''}.`,
          ]
        );
        alertsCreated++;
      }
    } catch (err) {
      logger.error(`[Job] New-match alert failed for company ${company.id}:`, err);
    }
  }

  if (alertsCreated) {
    logger.info(`[Job] New-opportunity alerts: ${alertsCreated} created`);
  }
  return alertsCreated;
};

// Deadline reminders for bids the company has started but not yet submitted,
// 3 days out from the tender's deadline. One-shot per bid (checked via
// existing alert rows keyed by bid_response_id), not repeated daily.
const alertUpcomingDeadlines = async () => {
  const result = await db.query(
    `SELECT br.id as bid_id, br.company_id, o.title, o.deadline
     FROM bid_responses br
     JOIN tenders t ON br.tender_id = t.id
     JOIN opportunities o ON t.opportunity_id = o.id
     WHERE br.status IN ('draft', 'in_progress')
       AND o.deadline IS NOT NULL
       AND o.deadline BETWEEN NOW() AND NOW() + INTERVAL '3 days'
       AND NOT EXISTS (
         SELECT 1 FROM company_alerts
         WHERE bid_response_id = br.id AND alert_type = 'deadline_reminder'
       )`
  );

  for (const row of result.rows) {
    await db.query(
      `INSERT INTO company_alerts (company_id, alert_type, bid_response_id, title, message)
       VALUES ($1, 'deadline_reminder', $2, $3, $4)`,
      [
        row.company_id,
        row.bid_id,
        `Echeance proche : ${row.title}`,
        `Votre reponse pour "${row.title}" doit etre soumise avant le ${new Date(row.deadline).toLocaleDateString('fr-FR')}. Le dossier n'est pas encore marque comme soumis.`,
      ]
    );
  }

  if (result.rows.length) {
    logger.info(`[Job] Deadline-reminder alerts: ${result.rows.length} created`);
  }
  return result.rows.length;
};

export const startOpportunityAlerts = () => {
  // New-match sweep runs after AI classification/matching has had a chance to
  // process fresh data - every 30 minutes, offset from aiProcessing's :00/:15/
  // :30/:45 cadence isn't critical here since this only reads results, it
  // doesn't compete for the same write lock.
  cron.schedule('*/30 * * * *', () => {
    alertNewMatches();
  });

  // Deadline reminders once daily is enough - a 3-day warning window doesn't
  // need finer granularity than that.
  cron.schedule('0 8 * * *', () => {
    alertUpcomingDeadlines();
  });

  logger.info('✅ Opportunity alert jobs scheduled (new matches every 30min, deadline reminders daily at 08:00)');
};

export const runAlertSweepsOnce = async () => {
  const newMatches = await alertNewMatches();
  const deadlines = await alertUpcomingDeadlines();
  return { newMatches, deadlines };
};
