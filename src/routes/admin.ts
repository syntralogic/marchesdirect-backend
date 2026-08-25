import { Router, Response } from 'express';
import { db } from '../config/database';
import { logger } from '../utils/logger';
import { AuthRequest, requireRole } from '../middleware/auth';
import { verifyDeduplicationQuality, getDeduplicationReport, deduplicateOpportunities } from '../services/deduplicationService';
import { classifyUnanalyzedOpportunities, generateSummariesForOpportunities } from '../services/aiService';
import { collectBoampData, collectPlaceData, collectTedData } from '../services/dataCollectionService';
import { runBackup, testRestore } from '../jobs/backupManagement';

const router = Router();

// All admin routes require admin or super_admin role
router.use(requireRole(['admin', 'super_admin']));

// GET /api/admin/data-sources - connector status (proof for Milestone 2)
router.get('/data-sources', async (req: AuthRequest, res: Response) => {
  try {
    const sources = await db.query('SELECT * FROM data_sources ORDER BY code');
    const logs = await db.query(
      `SELECT * FROM connector_logs ORDER BY started_at DESC LIMIT 20`
    );
    res.json({ sources: sources.rows, recentRuns: logs.rows });
  } catch (err: any) {
    logger.error('Admin data-sources error:', err);
    res.status(500).json({ error: 'Failed to fetch data sources' });
  }
});

// POST /api/admin/data-sources/:code/run - manually trigger one connector run on demand.
// This is what makes Milestone 2/3's proof ("3 automatic runs observed", "second import
// with zero duplicates") demonstrable on a short call instead of waiting on the 6-hour
// cron schedule - trigger it, then trigger it again, and read connector_logs /
// deduplication/report before and after.
router.post('/data-sources/:code/run', async (req: AuthRequest, res: Response) => {
  try {
    const sourceResult = await db.query('SELECT * FROM data_sources WHERE code = $1', [req.params.code]);

    if (sourceResult.rows.length === 0) {
      return res.status(404).json({ error: `Unknown data source code: ${req.params.code}` });
    }

    const source = sourceResult.rows[0];

    let result;
    switch (source.code) {
      case 'boamp':
        result = await collectBoampData(source.id);
        break;
      case 'place':
        result = await collectPlaceData(source.id);
        break;
      case 'ted':
        result = await collectTedData(source.id);
        break;
      default:
        return res.status(400).json({ error: `No connector implemented for source code: ${source.code}` });
    }

    res.json({ source: source.code, result });
  } catch (err: any) {
    logger.error(`Manual connector run error (${req.params.code}):`, err);
    res.status(502).json({
      error: 'Connector run failed - see connector_logs for the recorded failure',
      detail: String(err?.message || err),
    });
  }
});

// POST /api/admin/deduplication/run - trigger the dedup sweep independently of
// a full data collection run (useful for ops/testing without re-fetching sources)
router.post('/deduplication/run', async (req: AuthRequest, res: Response) => {
  try {
    const merged = await deduplicateOpportunities();
    res.json({ merged });
  } catch (err: any) {
    logger.error('Admin dedup run error:', err);
    res.status(500).json({ error: 'Deduplication run failed' });
  }
});

// GET /api/admin/deduplication/report - proof for Milestone 3
router.get('/deduplication/report', async (req: AuthRequest, res: Response) => {
  try {
    const report = await getDeduplicationReport();
    const isValid = await verifyDeduplicationQuality();
    res.json({ ...report, verified_no_exact_duplicates: isValid });
  } catch (err: any) {
    logger.error('Admin dedup report error:', err);
    res.status(500).json({ error: 'Failed to generate deduplication report' });
  }
});

// POST /api/admin/ai/classify-batch - manually trigger classification batch (Milestone 6)
router.post('/ai/classify-batch', async (req: AuthRequest, res: Response) => {
  try {
    const limit = parseInt(req.body.limit) || 100;
    const result = await classifyUnanalyzedOpportunities(limit);
    res.json(result);
  } catch (err: any) {
    logger.error('Admin classify batch error:', err);
    res.status(500).json({ error: 'Batch classification failed' });
  }
});

// POST /api/admin/ai/summarize-batch - manually trigger summary batch (Milestone 7)
router.post('/ai/summarize-batch', async (req: AuthRequest, res: Response) => {
  try {
    const limit = parseInt(req.body.limit) || 50;
    const generated = await generateSummariesForOpportunities(limit);
    res.json({ generated });
  } catch (err: any) {
    logger.error('Admin summarize batch error:', err);
    res.status(500).json({ error: 'Batch summarization failed' });
  }
});

// GET /api/admin/security-incidents - cross-company access attempts, etc. (Milestone 8/12)
router.get('/security-incidents', async (req: AuthRequest, res: Response) => {
  try {
    const result = await db.query(
      'SELECT * FROM security_incidents ORDER BY created_at DESC LIMIT 100'
    );
    res.json(result.rows);
  } catch (err: any) {
    logger.error('Admin security incidents error:', err);
    res.status(500).json({ error: 'Failed to fetch security incidents' });
  }
});

// GET /api/admin/audit-logs
router.get('/audit-logs', async (req: AuthRequest, res: Response) => {
  try {
    const { entity_type, page = '1', limit = '50' } = req.query as Record<string, string>;
    const conditions: string[] = ['1=1'];
    const params: any[] = [];
    let idx = 1;

    if (entity_type) {
      conditions.push(`entity_type = $${idx++}`);
      params.push(entity_type);
    }

    const pageNum = Math.max(parseInt(page) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit) || 50, 1), 200);
    const offset = (pageNum - 1) * limitNum;

    const result = await db.query(
      `SELECT * FROM audit_logs WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, limitNum, offset]
    );

    res.json(result.rows);
  } catch (err: any) {
    logger.error('Admin audit logs error:', err);
    res.status(500).json({ error: 'Failed to fetch audit logs' });
  }
});

// GET /api/admin/backups - backup/restore status (Milestone 12)
router.get('/backups', async (req: AuthRequest, res: Response) => {
  try {
    const result = await db.query('SELECT * FROM backup_logs ORDER BY started_at DESC LIMIT 20');
    res.json(result.rows);
  } catch (err: any) {
    logger.error('Admin backups error:', err);
    res.status(500).json({ error: 'Failed to fetch backup logs' });
  }
});

// POST /api/admin/backups/run - manually trigger a full backup on demand, so the
// Milestone 12 restoration proof doesn't require waiting for the 02:00 cron.
// Runs pg_dump synchronously and returns once it's done (a full backup on a
// large database can take a while - call this from a background job/queue in
// production if it starts timing out the HTTP request).
router.post('/backups/run', async (req: AuthRequest, res: Response) => {
  try {
    const result = await runBackup('full');
    if (!result.success) {
      return res.status(500).json(result);
    }
    res.json(result);
  } catch (err: any) {
    logger.error('Admin backup trigger error:', err);
    res.status(500).json({ error: 'Failed to run backup' });
  }
});

// POST /api/admin/backups/restore-test - restores the latest successful backup into a
// throwaway database and verifies it, then drops it. This is the actual Milestone 12
// proof requirement ("live restoration demonstrated") - GET /backups only shows
// whether restoration_tested is true, this endpoint is what makes it become true.
router.post('/backups/restore-test', async (req: AuthRequest, res: Response) => {
  try {
    const result = await testRestore();
    if (!result.success) {
      return res.status(500).json(result);
    }
    res.json(result);
  } catch (err: any) {
    logger.error('Admin restore-test trigger error:', err);
    res.status(500).json({ error: 'Failed to run restore test' });
  }
});

// GET /api/admin/system-health
router.get('/system-health', async (req: AuthRequest, res: Response) => {
  try {
    const result = await db.query(
      'SELECT * FROM system_health ORDER BY checked_at DESC LIMIT 50'
    );
    res.json(result.rows);
  } catch (err: any) {
    logger.error('Admin system health error:', err);
    res.status(500).json({ error: 'Failed to fetch system health' });
  }
});

// GET /api/admin/seo-pages - SEO generation stats (Milestone 11)
router.get('/seo-pages', async (req: AuthRequest, res: Response) => {
  try {
    const { brand_id } = req.query as Record<string, string>;
    const conditions: string[] = ['1=1'];
    const params: any[] = [];
    let idx = 1;
    if (brand_id) {
      conditions.push(`brand_id = $${idx++}`);
      params.push(brand_id);
    }

    const [pages, totalCount] = await Promise.all([
      db.query(
        `SELECT id, page_type, page_slug, page_title, is_published, google_indexed, page_views
         FROM seo_pages WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT 100`,
        params
      ),
      db.query(`SELECT COUNT(*) as total FROM seo_pages WHERE ${conditions.join(' AND ')}`, params),
    ]);

    res.json({ pages: pages.rows, total: parseInt(totalCount.rows[0].total) });
  } catch (err: any) {
    logger.error('Admin SEO pages error:', err);
    res.status(500).json({ error: 'Failed to fetch SEO pages' });
  }
});

// GET /api/admin/stats - dashboard summary counts, real numbers only (no
// AdminDashboard.tsx on the frontend previously showed 100% hardcoded
// figures like "1,248" tenders and "€48k" revenue with no endpoint behind
// them at all - this is that endpoint).
router.get('/stats', async (req: AuthRequest, res: Response) => {
  try {
    const [opportunities, companies, matchRate, revenue, recentActivity] = await Promise.all([
      db.query(`SELECT COUNT(*)::int AS count FROM opportunities WHERE status = 'active'`),
      db.query(`SELECT COUNT(*)::int AS count FROM companies WHERE deleted_at IS NULL`),
      db.query(
        `SELECT
           COUNT(*) FILTER (WHERE ai_classification_status = 'classified')::float
             / NULLIF(COUNT(*) FILTER (WHERE ai_classification_status IN ('classified', 'failed')), 0)::float AS rate
         FROM opportunities`
      ),
      db.query(
        `SELECT COALESCE(SUM(sp.price), 0)::float AS mrr
         FROM subscriptions s JOIN subscription_plans sp ON s.plan_id = sp.id
         WHERE s.status = 'active'`
      ),
      db.query(
        `SELECT al.action, al.entity_type, al.created_at,
                u.first_name, u.last_name, c.name AS company_name
         FROM audit_logs al
         LEFT JOIN users u ON al.user_id = u.id
         LEFT JOIN companies c ON al.company_id = c.id
         ORDER BY al.created_at DESC LIMIT 10`
      ),
    ]);

    res.json({
      activeOpportunities: opportunities.rows[0].count,
      totalCompanies: companies.rows[0].count,
      // null when there's no classified/failed data yet (fresh install, or AI
      // processing hasn't run) - the frontend shows "-" rather than a
      // misleading 0%.
      matchRate: matchRate.rows[0].rate !== null ? Math.round(matchRate.rows[0].rate * 100) : null,
      monthlyRecurringRevenue: revenue.rows[0].mrr,
      recentActivity: recentActivity.rows.map((r) => ({
        user: [r.first_name, r.last_name].filter(Boolean).join(' ') || r.company_name || 'Système',
        action: r.action,
        target: r.entity_type,
        time: r.created_at,
      })),
    });
  } catch (err: any) {
    logger.error('Admin stats error:', err);
    res.status(500).json({ error: 'Failed to fetch admin stats' });
  }
});

// GET /api/admin/opportunities - admin-wide listing (no company scoping, unlike
// the public /api/opportunities route) for the admin tenders management screen.
router.get('/opportunities', async (req: AuthRequest, res: Response) => {
  try {
    const { q, status, page = '1', limit = '20' } = req.query as Record<string, string>;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const offset = (pageNum - 1) * limitNum;

    const conditions: string[] = ['1=1'];
    const params: any[] = [];
    let idx = 1;
    if (q) {
      conditions.push(`o.title ILIKE $${idx++}`);
      params.push(`%${q}%`);
    }
    if (status && status !== 'all') {
      conditions.push(`o.status = $${idx++}`);
      params.push(status);
    }
    const where = conditions.join(' AND ');

    const [results, totalCount] = await Promise.all([
      db.query(
        `SELECT o.id, o.title, o.estimated_value, o.currency, o.deadline, o.status,
                o.location_city, ot.name as opportunity_type
         FROM opportunities o
         LEFT JOIN opportunity_types ot ON o.opportunity_type_id = ot.id
         WHERE ${where}
         ORDER BY o.publication_date DESC NULLS LAST
         LIMIT $${idx++} OFFSET $${idx++}`,
        [...params, limitNum, offset]
      ),
      db.query(`SELECT COUNT(*)::int as total FROM opportunities o WHERE ${where}`, params),
    ]);

    res.json({
      results: results.rows,
      pagination: { page: pageNum, limit: limitNum, total: totalCount.rows[0].total },
    });
  } catch (err: any) {
    logger.error('Admin opportunities list error:', err);
    res.status(500).json({ error: 'Failed to fetch opportunities' });
  }
});

// PATCH /api/admin/opportunities/:id/status - the one real admin action that
// fits this data model: opportunities are collected automatically (BOAMP/
// PLACE/TED), not manually authored, so there's no "create/edit a tender"
// endpoint - what an admin can legitimately do is hide a bad/duplicate/
// expired listing (or reactivate one) without touching its source data.
router.patch('/opportunities/:id/status', async (req: AuthRequest, res: Response) => {
  try {
    const { status } = req.body;
    const allowed = ['active', 'inactive', 'expired', 'cancelled'];
    if (!allowed.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${allowed.join(', ')}` });
    }

    const result = await db.query(
      `UPDATE opportunities SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING id, status`,
      [status, req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Opportunity not found' });
    }

    await db.query(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, new_values)
       VALUES ($1, 'update', 'opportunity', $2, $3)`,
      [req.user!.id, req.params.id, JSON.stringify({ status })]
    );

    res.json(result.rows[0]);
  } catch (err: any) {
    logger.error('Admin opportunity status update error:', err);
    res.status(500).json({ error: 'Failed to update opportunity status' });
  }
});

// GET /api/admin/companies - admin user/account management screen.
router.get('/companies', async (req: AuthRequest, res: Response) => {
  try {
    const { q, status, page = '1', limit = '20' } = req.query as Record<string, string>;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const offset = (pageNum - 1) * limitNum;

    const conditions: string[] = ['c.deleted_at IS NULL'];
    const params: any[] = [];
    let idx = 1;
    if (q) {
      conditions.push(`(c.name ILIKE $${idx} OR c.email ILIKE $${idx})`);
      params.push(`%${q}%`);
      idx++;
    }
    if (status && status !== 'all') {
      conditions.push(`c.status = $${idx++}`);
      params.push(status);
    }
    const where = conditions.join(' AND ');

    const [results, totalCount] = await Promise.all([
      db.query(
        `SELECT c.id, c.name, c.email, c.status, c.subscription_status, c.subscription_tier,
                u.first_name, u.last_name
         FROM companies c
         LEFT JOIN users u ON u.company_id = c.id AND u.role = 'owner' AND u.deleted_at IS NULL
         WHERE ${where}
         ORDER BY c.created_at DESC
         LIMIT $${idx++} OFFSET $${idx++}`,
        [...params, limitNum, offset]
      ),
      db.query(`SELECT COUNT(*)::int as total FROM companies c WHERE ${where}`, params),
    ]);

    res.json({
      results: results.rows,
      pagination: { page: pageNum, limit: limitNum, total: totalCount.rows[0].total },
    });
  } catch (err: any) {
    logger.error('Admin companies list error:', err);
    res.status(500).json({ error: 'Failed to fetch companies' });
  }
});

// PATCH /api/admin/companies/:id/status - suspend/reactivate an account.
router.patch('/companies/:id/status', async (req: AuthRequest, res: Response) => {
  try {
    const { status } = req.body;
    const allowed = ['active', 'suspended', 'pending'];
    if (!allowed.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${allowed.join(', ')}` });
    }

    const result = await db.query(
      `UPDATE companies SET status = $1, updated_at = NOW() WHERE id = $2 AND deleted_at IS NULL RETURNING id, status`,
      [status, req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Company not found' });
    }

    await db.query(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, new_values)
       VALUES ($1, 'update', 'company', $2, $3)`,
      [req.user!.id, req.params.id, JSON.stringify({ status })]
    );

    res.json(result.rows[0]);
  } catch (err: any) {
    logger.error('Admin company status update error:', err);
    res.status(500).json({ error: 'Failed to update company status' });
  }
});

export default router;
