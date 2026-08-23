import { Router, Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
import { db } from '../config/database';
import { logger } from '../utils/logger';
import { syncLeadToCrm } from '../services/crmSyncService';

const router = Router();

// Mounted at /api/crm/leads in server.ts, BEFORE the authenticated /api/crm
// router, so this specific path is reachable without a session - matches how
// a real pricing/contact page lead form works (submitted by a visitor who
// doesn't have an account yet).

// POST /api/crm/leads - capture a new lead (public)
router.post(
  '/',
  [
    body('brandId').notEmpty(),
    body('email').isEmail().normalizeEmail(),
  ],
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Validation failed', details: errors.array() });
    }

    try {
      const {
        brandId, firstName, lastName, email, phone, companyName,
        industryTrade, locationCity, locationRegion, leadSource,
      } = req.body;

      const result = await db.query(
        `INSERT INTO crm_leads
          (brand_id, first_name, last_name, email, phone, company_name, industry_trade,
           location_city, location_region, lead_source, crm_sync_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending')
         RETURNING id, created_at`,
        [
          brandId, firstName, lastName, email, phone, companyName,
          industryTrade, locationCity, locationRegion, leadSource || 'website_form',
        ]
      );

      // Intentionally return only id/created_at, not the full row - this is a
      // public endpoint, no need to echo back internal CRM sync fields.
      res.status(201).json({ success: true, id: result.rows[0].id });

      // Fire-and-forget: the visitor's form submission must not wait on (or
      // fail because of) an external CRM API call. Sync status/errors land on
      // the crm_leads row itself (crm_sync_status/crm_last_sync), visible via
      // GET /api/crm/leads for staff, and jobs/crmRetry.ts sweeps up anything
      // that didn't sync on the first attempt.
      syncLeadToCrm(result.rows[0].id).catch((err) => {
        logger.error('Unexpected error firing CRM sync:', err);
      });
    } catch (err: any) {
      logger.error('Public CRM lead capture error:', err);
      res.status(500).json({ error: 'Failed to submit — please try again' });
    }
  }
);

export default router;
