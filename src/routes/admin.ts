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

export default router;
