import cron from 'node-cron';
import { db } from '../config/database';
import { logger } from '../utils/logger';

// ============================================================================
// DOCUMENT EXPIRY CHECK (Milestone 9 support)
// Marks company documents as expired and raises in-app alerts:
// - 30 days before expiry (reminder)
// - on the day it actually expires
//
// Also handles company_certifications (Qualibat, RGE, etc. - spec section 6.2
// names these explicitly). This used to be document-only: certifications have
// their own `is_expired` column that nothing was ever updating, so an expired
// certification stayed `is_expired = false` forever - and
// aiService.matchOpportunitiesToCompany() filters on exactly that column to
// decide which trades a company is currently qualified for. In practice that
// meant a company's expired Qualibat/RGE cert would keep matching them to
// opportunities in that trade indefinitely, which is the kind of thing that's
// easy to not notice from a screen recording but shows up immediately on real
// data over time.
// ============================================================================

const checkExpiringDocuments = async () => {
  try {
    // Mark newly expired documents
    const expiredResult = await db.query(
      `UPDATE company_documents
       SET is_expired = true, updated_at = NOW()
       WHERE deleted_at IS NULL AND is_expired = false
         AND expiry_date IS NOT NULL AND expiry_date < CURRENT_DATE
       RETURNING id, company_id, document_type, document_name`
    );

    for (const doc of expiredResult.rows) {
      await db.query(
        `INSERT INTO company_alerts (company_id, alert_type, title, message)
         VALUES ($1, 'document_expiry', $2, $3)`,
        [
          doc.company_id,
          `Document expiré : ${doc.document_name || doc.document_type}`,
          `Le document "${doc.document_name || doc.document_type}" a expiré. Merci de le mettre à jour dans votre profil entreprise pour continuer à répondre aux appels d'offres.`,
        ]
      );
    }

    // Reminders 30 days before expiry (send once)
    const reminderResult = await db.query(
      `UPDATE company_documents
       SET expiry_reminder_sent = true
       WHERE deleted_at IS NULL AND is_expired = false AND expiry_reminder_sent = false
         AND expiry_date IS NOT NULL
         AND expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '30 days'
       RETURNING id, company_id, document_type, document_name, expiry_date`
    );

    for (const doc of reminderResult.rows) {
      await db.query(
        `INSERT INTO company_alerts (company_id, alert_type, title, message)
         VALUES ($1, 'document_expiry', $2, $3)`,
        [
          doc.company_id,
          `Document bientôt expiré : ${doc.document_name || doc.document_type}`,
          `Le document "${doc.document_name || doc.document_type}" expire le ${doc.expiry_date}. Pensez à le renouveler.`,
        ]
      );
    }

    // Same two passes, but for certifications (Qualibat/RGE/etc.) - separate
    // table, and critically feeds the trade-matching query, not just a display
    // list, so letting this go stale is a functional bug, not just a UX gap.
    const expiredCerts = await db.query(
      `UPDATE company_certifications
       SET is_expired = true, updated_at = NOW()
       WHERE is_expired = false
         AND expiry_date IS NOT NULL AND expiry_date < CURRENT_DATE
       RETURNING id, company_id, certification_name`
    );

    for (const cert of expiredCerts.rows) {
      await db.query(
        `INSERT INTO company_alerts (company_id, alert_type, title, message)
         VALUES ($1, 'certification_expiry', $2, $3)`,
        [
          cert.company_id,
          `Certification expirée : ${cert.certification_name}`,
          `La certification "${cert.certification_name}" a expiré et ne sera plus utilisée pour vous proposer des opportunités correspondantes tant qu'elle n'est pas renouvelée.`,
        ]
      );
    }

    const reminderCerts = await db.query(
      `UPDATE company_certifications
       SET expiry_reminder_sent = true
       WHERE is_expired = false AND COALESCE(expiry_reminder_sent, false) = false
         AND expiry_date IS NOT NULL
         AND expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '30 days'
       RETURNING id, company_id, certification_name, expiry_date`
    );

    for (const cert of reminderCerts.rows) {
      await db.query(
        `INSERT INTO company_alerts (company_id, alert_type, title, message)
         VALUES ($1, 'certification_expiry', $2, $3)`,
        [
          cert.company_id,
          `Certification bientôt expirée : ${cert.certification_name}`,
          `La certification "${cert.certification_name}" expire le ${cert.expiry_date}. Pensez à la renouveler pour continuer à être mis en avant sur ce métier.`,
        ]
      );
    }

    const totalTouched =
      expiredResult.rows.length + reminderResult.rows.length + expiredCerts.rows.length + reminderCerts.rows.length;
    if (totalTouched) {
      logger.info(
        `[Job] Expiry check: ${expiredResult.rows.length} docs expired, ${reminderResult.rows.length} doc reminders, ` +
          `${expiredCerts.rows.length} certifications expired, ${reminderCerts.rows.length} certification reminders`
      );
    }
  } catch (err) {
    logger.error('[Job] Document expiry check failed:', err);
  }
};

export const startExpiryCheck = () => {
  // Run once daily at 03:00
  cron.schedule('0 3 * * *', () => {
    logger.info('[Job] Running daily document expiry check...');
    checkExpiringDocuments();
  });

  // Free-tier-host reasoning: the expiry-marking update and reminder sweep
  // above only ever touch rows where is_expired/expiry_reminder_sent is
  // still false, so re-running - including on boot - can never re-alert on
  // the same document twice. Fire one pass immediately so expired documents
  // don't sit unflagged until a 3am cron tick that might never come on a
  // host that spins down between requests.
  logger.info('[Job] Running an immediate document expiry check on boot...');
  checkExpiringDocuments();

  logger.info('✅ Document expiry job scheduled (daily at 03:00)');
};

export const runExpiryCheckOnce = checkExpiringDocuments;
