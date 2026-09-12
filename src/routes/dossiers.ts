import { Router, Response } from 'express';
import { db } from '../config/database';
import { logger } from '../utils/logger';
import { AuthRequest } from '../middleware/auth';

const router = Router();

// GET /api/dossiers/:opportunityId - fetch the current company's dossier
// request for this opportunity, if one exists yet (404 if not started -
// the frontend treats that as "not requested", not an error state).
router.get('/:opportunityId', async (req: AuthRequest, res: Response) => {
  try {
    const result = await db.query(
      'SELECT * FROM dossier_requests WHERE company_id = $1 AND opportunity_id = $2',
      [req.user!.companyId, req.params.opportunityId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No dossier request yet' });
    }
    res.json(result.rows[0]);
  } catch (err: any) {
    logger.error('Dossier fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch dossier' });
  }
});

// PUT /api/dossiers/:opportunityId - save a draft (response text, partners,
// checklist) without submitting the request. Upserts so the company can
// come back and keep editing before hitting "Générer mon dossier". This is
// NOT the chargé d'affaires review action - status stays untouched here.
router.put('/:opportunityId', async (req: AuthRequest, res: Response) => {
  try {
    const { response_text, partners, checklist } = req.body;
    const result = await db.query(
      `INSERT INTO dossier_requests (company_id, opportunity_id, response_text, partners, checklist, status)
       VALUES ($1, $2, $3, $4, $5, 'draft')
       ON CONFLICT (company_id, opportunity_id) DO UPDATE SET
         response_text = COALESCE($3, dossier_requests.response_text),
         partners = COALESCE($4, dossier_requests.partners),
         checklist = COALESCE($5, dossier_requests.checklist),
         updated_at = NOW()
       RETURNING *`,
      [req.user!.companyId, req.params.opportunityId, response_text ?? null,
       partners ? JSON.stringify(partners) : null, checklist ? JSON.stringify(checklist) : null]
    );
    res.json(result.rows[0]);
  } catch (err: any) {
    logger.error('Dossier draft save error:', err);
    res.status(500).json({ error: 'Failed to save dossier draft' });
  }
});

// POST /api/dossiers/:opportunityId/generate - "Générer mon dossier".
// Client's spec, verbatim: this "ne génère pas instantanément une
// candidature et ne réalise aucun dépôt" - it flips status to 'requested'
// (visible to admin via GET /api/admin/dossier-requests, reusing the
// existing admin space per the client's explicit instruction not to build a
// separate one) and a chargé d'affaires takes it from there. The frontend
// shows a confirmation, not a finished dossier.
router.post('/:opportunityId/generate', async (req: AuthRequest, res: Response) => {
  try {
    const { response_text, partners, checklist } = req.body;
    const result = await db.query(
      `INSERT INTO dossier_requests (company_id, opportunity_id, response_text, partners, checklist, status, requested_at)
       VALUES ($1, $2, $3, $4, $5, 'requested', NOW())
       ON CONFLICT (company_id, opportunity_id) DO UPDATE SET
         response_text = COALESCE($3, dossier_requests.response_text),
         partners = COALESCE($4, dossier_requests.partners),
         checklist = COALESCE($5, dossier_requests.checklist),
         status = CASE WHEN dossier_requests.status = 'draft' THEN 'requested' ELSE dossier_requests.status END,
         requested_at = CASE WHEN dossier_requests.status = 'draft' THEN NOW() ELSE dossier_requests.requested_at END,
         updated_at = NOW()
       RETURNING *`,
      [req.user!.companyId, req.params.opportunityId, response_text ?? null,
       partners ? JSON.stringify(partners) : null, checklist ? JSON.stringify(checklist) : null]
    );
    await db.query(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, new_values)
       VALUES ($1, 'create', 'dossier_request', $2, $3)`,
      [req.user!.id, result.rows[0].id, JSON.stringify({ opportunity_id: req.params.opportunityId })]
    );
    res.json(result.rows[0]);
  } catch (err: any) {
    logger.error('Dossier generate error:', err);
    res.status(500).json({ error: 'Failed to submit dossier request' });
  }
});

export default router;
