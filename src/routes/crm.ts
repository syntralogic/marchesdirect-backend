import { Router, Request, Response } from 'express';
import { db } from '../config/database';
import { logger } from '../utils/logger';
import { requireRole } from '../middleware/auth';
import { csvCell } from '../utils/csvCell';

const router = Router();

// This router is mounted behind `authenticate` in server.ts (admin/staff use).
// Public lead capture (POST) lives in routes/crmPublic.ts instead, since
// anonymous marketing-page visitors submitting the contact/pricing form don't
// have an account yet.
//
// requireRole is applied here (not just `authenticate` in server.ts) because
// crm_leads rows contain other people's PII (name/email/phone) - without this
// any logged-in company user, not just staff, could list or edit every lead
// in the system via these two routes.
router.use(requireRole(['admin', 'super_admin']));

// GET /api/crm/leads - list captured leads (admin/staff). Excludes
// opportunity-tied leads (opportunity_id IS NOT NULL) - those have their own
// dedicated review flow at GET /api/admin/opportunity-leads (graduated
// access grant), shown on the admin "Demandes" page. This endpoint is for
// the generic contact/appointment/callback leads instead.
router.get('/leads', async (req: Request, res: Response) => {
  try {
    const { status, brand_id, lead_source, page = '1', limit = '50' } = req.query as Record<string, string>;

    const conditions: string[] = ['opportunity_id IS NULL'];
    const params: any[] = [];
    let idx = 1;

    if (status) {
      conditions.push(`status = $${idx++}`);
      params.push(status);
    }
    if (brand_id) {
      conditions.push(`brand_id = $${idx++}`);
      params.push(brand_id);
    }
    if (lead_source) {
      conditions.push(`lead_source = $${idx++}`);
      params.push(lead_source);
    }

    const pageNum = Math.max(parseInt(page) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit) || 50, 1), 200);
    const offset = (pageNum - 1) * limitNum;

    const result = await db.query(
      `SELECT * FROM crm_leads WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, limitNum, offset]
    );
    const countResult = await db.query(
      `SELECT COUNT(*)::int as total FROM crm_leads WHERE ${conditions.join(' AND ')}`,
      params
    );

    res.json({ results: result.rows, pagination: { total: countResult.rows[0].total, page: pageNum, limit: limitNum } });
  } catch (err: any) {
    logger.error('CRM leads list error:', err);
    res.status(500).json({ error: 'Failed to fetch leads' });
  }
});


// GET /api/crm/leads/export.csv - everything the sales team needs, in one file.
// 30 Sep CRM check: the client wants to extract the data; there was no export
// at all (and /leads hides opportunity-tied leads). This returns ALL leads
// (contact, rendez-vous, rappel, opportunity requests) with the opportunity
// title, filterable by status / source / date range. Opens directly in Excel
// (UTF-8 BOM, ; separator) and neutralises spreadsheet-formula injection.
router.get('/leads/export.csv', async (req: Request, res: Response) => {
  try {
    const { status, lead_source, from, to } = req.query as Record<string, string>;
    const conditions: string[] = ['1=1'];
    const params: any[] = [];
    let idx = 1;
    if (status) { conditions.push(`l.status = $${idx++}`); params.push(status); }
    if (lead_source) { conditions.push(`l.lead_source = $${idx++}`); params.push(lead_source); }
    if (from && !Number.isNaN(Date.parse(from))) { conditions.push(`l.created_at >= $${idx++}`); params.push(from); }
    if (to && !Number.isNaN(Date.parse(to))) { conditions.push(`l.created_at < ($${idx++}::date + 1)`); params.push(to); }

    const result = await db.query(
      `SELECT l.created_at, l.first_name, l.last_name, l.email, l.phone, l.company_name,
              l.industry_trade, l.location_city, l.location_region, l.lead_source, l.status,
              l.appointment_mode, l.appointment_slot_at, l.message,
              o.title AS opportunity_title, l.crm_sync_status, l.crm_contact_id
       FROM crm_leads l LEFT JOIN opportunities o ON o.id = l.opportunity_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY l.created_at DESC LIMIT 50000`,
      params
    );
    const cols: [string, string][] = [
      ['created_at', 'Date'], ['first_name', 'Prénom'], ['last_name', 'Nom'], ['email', 'Email'], ['phone', 'Téléphone'],
      ['company_name', 'Entreprise'], ['industry_trade', 'Métier'], ['location_city', 'Ville'], ['location_region', 'Région'],
      ['lead_source', 'Source'], ['status', 'Statut'], ['appointment_mode', 'Type de demande'],
      ['appointment_slot_at', 'Rendez-vous'], ['opportunity_title', 'Opportunité'], ['message', 'Message'],
      ['crm_sync_status', 'Synchro CRM'], ['crm_contact_id', 'ID CRM'],
    ];
    const lines = [cols.map(([, h]) => csvCell(h)).join(';')];
    for (const row of result.rows) lines.push(cols.map(([k]) => csvCell((row as any)[k])).join(';'));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="leads-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send('\uFEFF' + lines.join('\r\n'));
  } catch (err: any) {
    logger.error('CRM leads export error:', err);
    res.status(500).json({ error: 'Failed to export leads' });
  }
});

// PUT /api/crm/leads/:id/status
router.put('/leads/:id/status', async (req: Request, res: Response) => {
  try {
    const { status } = req.body;
    const result = await db.query(
      'UPDATE crm_leads SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
      [status, req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Lead not found' });
    }
    res.json(result.rows[0]);
  } catch (err: any) {
    logger.error('CRM lead status update error:', err);
    res.status(500).json({ error: 'Failed to update lead' });
  }
});

export default router;
