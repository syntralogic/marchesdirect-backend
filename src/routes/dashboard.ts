import { Router, Response } from 'express';
import { db } from '../config/database';
import { logger } from '../utils/logger';
import { AuthRequest } from '../middleware/auth';
import { matchOpportunitiesToCompany } from '../services/aiService';
import { resolveIdentityUnlocked } from './opportunities';

const router = Router();

// GET /api/dashboard - summary stats for the logged-in company
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const companyId = req.user!.companyId;

    const [matchesResult, alertsResult, bidsResult, documentsResult] = await Promise.all([
      db.query(
        `SELECT COUNT(*) as count FROM opportunities
         WHERE status = 'active' AND deadline > NOW() AND ai_classification_status = 'classified'`
      ),
      db.query(
        'SELECT COUNT(*) as count FROM company_alerts WHERE company_id = $1 AND is_read = false',
        [companyId]
      ),
      db.query(
        "SELECT status, COUNT(*) as count FROM bid_responses WHERE company_id = $1 GROUP BY status",
        [companyId]
      ),
      db.query(
        `SELECT COUNT(*) as count FROM company_documents
         WHERE company_id = $1 AND deleted_at IS NULL AND (expiry_date IS NULL OR expiry_date > CURRENT_DATE)`,
        [companyId]
      ),
    ]);

    res.json({
      activeOpportunities: parseInt(matchesResult.rows[0].count),
      unreadAlerts: parseInt(alertsResult.rows[0].count),
      bidsByStatus: bidsResult.rows,
      validDocuments: parseInt(documentsResult.rows[0].count),
    });
  } catch (err: any) {
    logger.error('Dashboard summary error:', err);
    res.status(500).json({ error: 'Failed to load dashboard' });
  }
});

// GET /api/dashboard/matches - AI-matched opportunities for this company (Milestone 6)
router.get('/matches', async (req: AuthRequest, res: Response) => {
  try {
    const matchedIds = await matchOpportunitiesToCompany(req.user!.companyId);

    if (matchedIds.length === 0) {
      return res.json({ matches: [] });
    }

    const result = await db.query(
      `SELECT o.id, o.title, o.deadline, o.estimated_value, o.location_city, o.location_region, o.ai_summary,
              ot.code as journey
       FROM opportunities o
       LEFT JOIN opportunity_types ot ON o.opportunity_type_id = ot.id
       WHERE o.id = ANY($1::uuid[])`,
      [matchedIds]
    );

    // Dashboard cards for a locked private-tender match (prototype V17,
    // section 3.6) show "Identité masquée + Prendre rendez-vous" instead of
    // the normal "Préparer mon dossier" CTA - reuse the same resolver the
    // fiche itself uses so the two can't disagree.
    const matches = await Promise.all(result.rows.map(async (row) => ({
      ...row,
      identity_unlocked: await resolveIdentityUnlocked(row.id, row.journey, '', req.user!.email),
    })));

    res.json({ matches });
  } catch (err: any) {
    logger.error('Dashboard matches error:', err);
    res.status(500).json({ error: 'Failed to load matches' });
  }
});

// GET /api/dashboard/today - "today's actions" widget: expiring docs + upcoming deadlines
router.get('/today', async (req: AuthRequest, res: Response) => {
  try {
    const companyId = req.user!.companyId;

    const [expiringDocs, upcomingBids] = await Promise.all([
      db.query(
        `SELECT id, document_type, document_name, expiry_date FROM company_documents
         WHERE company_id = $1 AND deleted_at IS NULL
           AND expiry_date IS NOT NULL AND expiry_date <= CURRENT_DATE + INTERVAL '30 days'
         ORDER BY expiry_date ASC`,
        [companyId]
      ),
      db.query(
        `SELECT br.id, br.status, br.submission_deadline, o.title
         FROM bid_responses br
         JOIN tenders t ON br.tender_id = t.id
         JOIN opportunities o ON t.opportunity_id = o.id
         WHERE br.company_id = $1 AND br.status IN ('draft', 'in_progress')
           AND br.submission_deadline <= NOW() + INTERVAL '7 days'
         ORDER BY br.submission_deadline ASC`,
        [companyId]
      ),
    ]);

    res.json({
      expiringDocuments: expiringDocs.rows,
      upcomingDeadlines: upcomingBids.rows,
    });
  } catch (err: any) {
    logger.error('Dashboard today error:', err);
    res.status(500).json({ error: 'Failed to load today actions' });
  }
});

export default router;
