import { Router, Response } from 'express';
import Stripe from 'stripe';
import { db } from '../config/database';
import { logger } from '../utils/logger';
import { AuthRequest, requireRole } from '../middleware/auth';
import { verifyDeduplicationQuality, getDeduplicationReport, deduplicateOpportunities } from '../services/deduplicationService';
import { classifyUnanalyzedOpportunities, generateSummariesForOpportunities, generateOpportunitySummary, generateAnalysisSectionsForOpportunities } from '../services/aiService';
import { collectBoampData, collectPlaceData, collectTedData, collectDecpData, collectBatiwebData } from '../services/dataCollectionService';
import { runBackup, testRestore } from '../jobs/backupManagement';
import { regionForDepartmentCode, normalizeDepartmentCode, extractDepartmentCode } from '../utils/departmentRegion';

const router = Router();

const stripeKey = process.env.STRIPE_SECRET_KEY;
const stripe = stripeKey ? new Stripe(stripeKey, { apiVersion: '2023-10-16' }) : null;

// All admin routes require admin or super_admin role
router.use(requireRole(['admin', 'super_admin']));

// ============================================================================
// BRANDS (Milestone 10 - second brand duplication)
// ============================================================================
// Lets an admin actually stand up a second brand from the dashboard instead
// of needing a manual DB insert/migration edit - that gap was the real
// reason Milestone 10 had zero code: brands.domain/logo_url/color_primary/
// color_secondary already existed as columns and were already read by
// brandResolution.ts, but nothing ever let an admin *set* them for a new
// brand. Every existing table that needs to be brand-aware (companies,
// crm_leads, seo_pages) already carries brand_id - duplication is
// config-only, no schema/code fork per brand, matching the "no code
// duplication" acceptance criteria.

router.get('/brands', async (req: AuthRequest, res: Response) => {
  try {
    const result = await db.query('SELECT * FROM brands ORDER BY created_at ASC');
    res.json(result.rows);
  } catch (err: any) {
    logger.error('Brands list error:', err);
    res.status(500).json({ error: 'Failed to fetch brands' });
  }
});

router.post('/brands', async (req: AuthRequest, res: Response) => {
  try {
    const { code, name, domain, logoUrl, colorPrimary, colorSecondary, language, regionFocus } = req.body;

    if (!code || !name || !domain) {
      return res.status(400).json({ error: 'code, name and domain are required' });
    }

    const result = await db.query(
      `INSERT INTO brands (code, name, domain, logo_url, color_primary, color_secondary, language, region_focus)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [
        code,
        name,
        domain,
        logoUrl || null,
        colorPrimary || null,
        colorSecondary || null,
        language || 'fr',
        regionFocus || null,
      ]
    );

    logger.info(`[Admin] New brand created: ${result.rows[0].code} (${domain})`);
    res.status(201).json(result.rows[0]);
  } catch (err: any) {
    if (err.code === '23505') {
      // unique_violation - code or domain already taken
      return res.status(409).json({ error: 'A brand with that code or domain already exists' });
    }
    logger.error('Brand creation error:', err);
    res.status(500).json({ error: 'Failed to create brand' });
  }
});

router.put('/brands/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { name, domain, logoUrl, colorPrimary, colorSecondary, language, regionFocus } = req.body;

    const result = await db.query(
      `UPDATE brands SET
         name = COALESCE($1, name),
         domain = COALESCE($2, domain),
         logo_url = COALESCE($3, logo_url),
         color_primary = COALESCE($4, color_primary),
         color_secondary = COALESCE($5, color_secondary),
         language = COALESCE($6, language),
         region_focus = COALESCE($7, region_focus),
         updated_at = NOW()
       WHERE id = $8
       RETURNING *`,
      [name, domain, logoUrl, colorPrimary, colorSecondary, language, regionFocus, req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Brand not found' });
    }

    res.json(result.rows[0]);
  } catch (err: any) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'That domain is already used by another brand' });
    }
    logger.error('Brand update error:', err);
    res.status(500).json({ error: 'Failed to update brand' });
  }
});

// GET /api/admin/data-sources - connector status (proof for Milestone 2)
//
// Client's ask (10 Sep, WhatsApp): "which sources are you actually using,
// and how many listings come from each" - `sources` alone (active flag,
// last_run, total_imports-since-last-restart) couldn't answer that; it says
// nothing about what's actually sitting in `opportunities` right now, or
// how complete those rows are per source. Added `sourceStats`: a live
// COUNT(*) per source_id plus, for the fields the client specifically
// flagged as sometimes missing (official_url / buyer_name / deadline /
// a real description), how many rows per source actually have them. This
// is what turns "some listings are almost empty" into a concrete per-source
// answer instead of a guess - e.g. DECP rows structurally can't have a
// deadline or official_url (see normalizeDecpRecord/buildOfficialUrl - DECP
// is post-award administrative data with no confirmed per-notice public
// URL), which should show up here as 0% for those two columns on the decp
// row specifically, not as a bug to chase.
router.get('/data-sources', async (req: AuthRequest, res: Response) => {
  try {
    const sources = await db.query('SELECT * FROM data_sources ORDER BY code');
    const logs = await db.query(
      `SELECT * FROM connector_logs ORDER BY started_at DESC LIMIT 20`
    );
    // description completeness uses a length threshold (not just NOT NULL)
    // because several connectors (DECP's `objet`, Batiweb's RSS snippet)
    // populate description with a short string rather than leaving it
    // null - "present but thin" needs to count as incomplete here too, or
    // this would undercount exactly the rows the client is asking about.
    const stats = await db.query(`
      SELECT
        o.source_id,
        COUNT(*) AS opportunity_count,
        COUNT(*) FILTER (WHERE o.official_url IS NOT NULL AND o.official_url <> '') AS with_official_url,
        COUNT(*) FILTER (WHERE o.buyer_name IS NOT NULL AND o.buyer_name <> '') AS with_buyer_name,
        COUNT(*) FILTER (WHERE o.deadline IS NOT NULL) AS with_deadline,
        COUNT(*) FILTER (WHERE o.description IS NOT NULL AND length(o.description) >= 100) AS with_substantial_description,
        COUNT(*) FILTER (WHERE o.estimated_value IS NOT NULL) AS with_estimated_value
      FROM opportunities o
      WHERE o.deleted_at IS NULL
      GROUP BY o.source_id
    `);
    const statsBySourceId = new Map(stats.rows.map(r => [r.source_id, r]));
    const sourceStats = sources.rows.map(s => {
      const row = statsBySourceId.get(s.id);
      const total = row ? Number(row.opportunity_count) : 0;
      const pct = (n: number) => (total > 0 ? Math.round((n / total) * 1000) / 10 : 0);
      return {
        source_id: s.id,
        code: s.code,
        active: s.active,
        opportunity_count: total,
        with_official_url: row ? Number(row.with_official_url) : 0,
        with_official_url_pct: row ? pct(Number(row.with_official_url)) : 0,
        with_buyer_name: row ? Number(row.with_buyer_name) : 0,
        with_buyer_name_pct: row ? pct(Number(row.with_buyer_name)) : 0,
        with_deadline: row ? Number(row.with_deadline) : 0,
        with_deadline_pct: row ? pct(Number(row.with_deadline)) : 0,
        with_substantial_description: row ? Number(row.with_substantial_description) : 0,
        with_substantial_description_pct: row ? pct(Number(row.with_substantial_description)) : 0,
        with_estimated_value: row ? Number(row.with_estimated_value) : 0,
        with_estimated_value_pct: row ? pct(Number(row.with_estimated_value)) : 0,
      };
    });
    res.json({ sources: sources.rows, recentRuns: logs.rows, sourceStats });
  } catch (err: any) {
    logger.error('Admin data-sources error:', err);
    res.status(500).json({ error: 'Failed to fetch data sources' });
  }
});

// In-memory guard against a second manual trigger landing while a
// background run from the fire-and-forget branch below is still going -
// there's nothing stopping someone from tapping "Run now" twice while the
// first click is still processing in the background.
const backgroundRunsInFlight = new Set<string>();

// POST /api/admin/data-sources/:code/run - manually trigger one connector run on demand.
// This is what makes Milestone 2/3's proof ("3 automatic runs observed", "second import
// with zero duplicates") demonstrable on a short call instead of waiting on the 6-hour
// cron schedule - trigger it, then trigger it again, and read connector_logs /
// deduplication/report before and after.
//
// BUG (found from the admin screen's "spinning forever, nothing happens" report):
// this used to await the connector call before responding for every source alike.
// BOAMP/TED/PLACE/Batiweb are small feeds - seconds, fine. DECP downloads a 234MB
// file and decompresses/parses it in batches - realistically minutes on a
// free-tier Render instance. Render's own proxy kills any HTTP request that
// hasn't responded within ~100s regardless of what the handler is doing, so the
// button's spinner would sit there until the browser's connection got cut, while
// the actual collectDecpData() call kept running (or eventually crashed)
// server-side with nothing surfaced to whoever clicked it. Long-running sources
// now run in the background and the endpoint responds immediately; the existing
// admin screen (last run / next run / connector_logs) is how the result gets
// checked afterwards, same as waiting on the scheduled cron would be.
const LONG_RUNNING_SOURCES = new Set(['decp']);

router.post('/data-sources/:code/run', async (req: AuthRequest, res: Response) => {
  try {
    const sourceResult = await db.query('SELECT * FROM data_sources WHERE code = $1', [req.params.code]);

    if (sourceResult.rows.length === 0) {
      return res.status(404).json({ error: `Unknown data source code: ${req.params.code}` });
    }

    const source = sourceResult.rows[0];

    const runConnector = () => {
      switch (source.code) {
        case 'boamp': return collectBoampData(source.id);
        case 'decp': return collectDecpData(source.id);
        case 'place': return collectPlaceData(source.id);
        case 'ted': return collectTedData(source.id);
        case 'batiweb': return collectBatiwebData(source.id);
        default: return null;
      }
    };

    if (!['boamp', 'decp', 'place', 'ted', 'batiweb'].includes(source.code)) {
      return res.status(400).json({ error: `No connector implemented for source code: ${source.code}` });
    }

    if (LONG_RUNNING_SOURCES.has(source.code)) {
      if (backgroundRunsInFlight.has(source.code)) {
        return res.status(409).json({ error: `${source.code} is already running in the background - check connector_logs / last run once it finishes instead of triggering again.` });
      }
      backgroundRunsInFlight.add(source.code);
      // Deliberately not awaited - see the long comment above. Errors are
      // already recorded to connector_logs by the connector itself.
      Promise.resolve(runConnector())
        .catch(err => logger.error(`Background connector run failed (${source.code}):`, err))
        .finally(() => backgroundRunsInFlight.delete(source.code));

      return res.status(202).json({
        source: source.code,
        status: 'started',
        message: 'Running in the background - this source can take several minutes. Refresh this page shortly to see last run / connector_logs.',
      });
    }

    const result = await runConnector();
    res.json({ source: source.code, result });
  } catch (err: any) {
    logger.error(`Manual connector run error (${req.params.code}):`, err);
    res.status(502).json({
      error: 'Connector run failed - see connector_logs for the recorded failure',
      detail: String(err?.message || err),
    });
  }
});

// POST /api/admin/backfill-location-region - recovers location_region for
// existing opportunities from their stored raw_data, without needing Render
// Shell access (free-tier plans often don't have a Shell tab at all - this
// is the HTTP equivalent of scripts/backfillLocationRegion.ts, same logic,
// callable from a browser/Postman with just the admin auth token). Runs in
// the background (can be tens of thousands of rows) - poll
// GET /api/admin/backfill-location-region/status for progress.
let backfillLocationRegionStatus: { running: boolean; recovered: number; unresolved: number; total: number; startedAt: string | null; finishedAt: string | null; error: string | null } = {
  running: false, recovered: 0, unresolved: 0, total: 0, startedAt: null, finishedAt: null, error: null,
};

router.post('/backfill-location-region', async (req: AuthRequest, res: Response) => {
  if (backfillLocationRegionStatus.running) {
    return res.status(409).json({ error: 'Already running - check GET /api/admin/backfill-location-region/status' });
  }
  const limit = req.body?.limit ? parseInt(req.body.limit, 10) : 50000;

  const countResult = await db.query(
    `SELECT COUNT(*)::int AS count FROM opportunities WHERE (location_region IS NULL OR location_region = '') AND raw_data IS NOT NULL`
  );
  const total = countResult.rows[0].count;

  backfillLocationRegionStatus = { running: true, recovered: 0, unresolved: 0, total, startedAt: new Date().toISOString(), finishedAt: null, error: null };

  (async () => {
    try {
      const { runLocationRegionBackfillBatch } = require('../jobs/locationRegionBackfillJob');
      const result = await runLocationRegionBackfillBatch(limit);
      backfillLocationRegionStatus.recovered = result.recovered;
      backfillLocationRegionStatus.unresolved = result.unresolved;
      logger.info(`[backfill-location-region] Done: ${result.recovered} recovered, ${result.unresolved} still unresolved`);
    } catch (err: any) {
      logger.error('[backfill-location-region] Failed:', err);
      backfillLocationRegionStatus.error = String(err?.message || err);
    } finally {
      backfillLocationRegionStatus.running = false;
      backfillLocationRegionStatus.finishedAt = new Date().toISOString();
    }
  })();

  res.status(202).json({ status: 'started', total, message: 'Running in the background - poll GET /api/admin/backfill-location-region/status for progress.' });
});

router.get('/backfill-location-region/status', async (req: AuthRequest, res: Response) => {
  res.json(backfillLocationRegionStatus);
});

// POST /api/admin/regenerate-stale-summaries - client feedback (7 Sep
// screenshot): some ai_summary rows are hundreds of words long with their
// own section headers, from before the prompt was tightened to "2 à 4
// phrases, 120 mots max, un seul paragraphe" (see
// generateOpportunitySummary). generateSummariesForOpportunities only
// covers ai_summary_status='not_generated', so it never touches these
// already-generated-but-verbose rows - this route targets exactly those,
// oldest/most-viewed rows aren't the point here, length is: LENGTH(ai_summary)
// > 500 chars is a reasonable proxy for "written under the old, more
// permissive prompt" (the new prompt physically can't produce that many
// characters given its own ~220-token budget). Background + limit, same
// reasoning as the location-region route: this calls the paid Claude API
// once per row, so it's opt-in and controllable rather than an automatic
// mass-regenerate of every summary on the site.
let regenerateStaleSummariesStatus: { running: boolean; regenerated: number; failed: number; total: number; startedAt: string | null; finishedAt: string | null; error: string | null } = {
  running: false, regenerated: 0, failed: 0, total: 0, startedAt: null, finishedAt: null, error: null,
};

router.post('/regenerate-stale-summaries', async (req: AuthRequest, res: Response) => {
  if (regenerateStaleSummariesStatus.running) {
    return res.status(409).json({ error: 'Already running - check GET /api/admin/regenerate-stale-summaries/status' });
  }
  const limit = req.body?.limit ? parseInt(req.body.limit, 10) : 500;

  const countResult = await db.query(`SELECT COUNT(*)::int AS count FROM opportunities WHERE LENGTH(ai_summary) > 500`);
  const total = countResult.rows[0].count;

  regenerateStaleSummariesStatus = { running: true, regenerated: 0, failed: 0, total: Math.min(total, limit), startedAt: new Date().toISOString(), finishedAt: null, error: null };

  (async () => {
    try {
      const { runStaleSummaryBackfillBatch } = require('../jobs/staleSummaryBackfillJob');
      const result = await runStaleSummaryBackfillBatch(limit);
      regenerateStaleSummariesStatus.regenerated = result.regenerated;
      regenerateStaleSummariesStatus.failed = result.failed;
      logger.info(`[regenerate-stale-summaries] Done: ${result.regenerated} regenerated, ${result.failed} failed`);
    } catch (err: any) {
      logger.error('[regenerate-stale-summaries] Failed:', err);
      regenerateStaleSummariesStatus.error = String(err?.message || err);
    } finally {
      regenerateStaleSummariesStatus.running = false;
      regenerateStaleSummariesStatus.finishedAt = new Date().toISOString();
    }
  })();

  res.status(202).json({ status: 'started', total: regenerateStaleSummariesStatus.total, message: 'Running in the background (one paid API call per row) - poll GET /api/admin/regenerate-stale-summaries/status for progress.' });
});

router.get('/regenerate-stale-summaries/status', async (req: AuthRequest, res: Response) => {
  res.json(regenerateStaleSummariesStatus);
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

// POST /api/admin/ai/analysis-sections-batch - manual trigger for the
// 3-accordion analysis backfill (analysisSectionsBackfillJob already runs
// this automatically, same "no Shell on Render free tier" reasoning as
// summarize-batch above - lets the client force a bigger batch on demand).
router.post('/ai/analysis-sections-batch', async (req: AuthRequest, res: Response) => {
  try {
    const limit = parseInt(req.body.limit) || 50;
    const result = await generateAnalysisSectionsForOpportunities(limit);
    res.json(result);
  } catch (err: any) {
    logger.error('Admin analysis-sections batch error:', err);
    res.status(500).json({ error: 'Batch analysis-sections generation failed' });
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
         LEFT JOIN LATERAL (
           SELECT first_name, last_name FROM users
           WHERE users.company_id = c.id AND users.deleted_at IS NULL
           ORDER BY created_at ASC LIMIT 1
         ) u ON true
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

// GET /api/admin/subscriptions - subscription management screen (Technical
// Requirements section 11: "subscription management" is listed as its own
// required admin panel capability, distinct from account/user management -
// this was the one piece of that list with no endpoint at all).
router.get('/subscriptions', async (req: AuthRequest, res: Response) => {
  try {
    const { status, q, page = '1', limit = '20' } = req.query as Record<string, string>;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const offset = (pageNum - 1) * limitNum;

    const conditions: string[] = ['1=1'];
    const params: any[] = [];
    let idx = 1;
    if (status && status !== 'all') {
      conditions.push(`s.status = $${idx++}`);
      params.push(status);
    }
    if (q) {
      conditions.push(`c.name ILIKE $${idx++}`);
      params.push(`%${q}%`);
    }
    const where = conditions.join(' AND ');

    const [results, totalCount, statusCounts] = await Promise.all([
      db.query(
        `SELECT s.id, s.status, s.current_period_start, s.current_period_end,
                s.trial_end, s.cancel_at_period_end, s.canceled_at, s.created_at,
                c.id as company_id, c.name as company_name, c.email as company_email,
                p.name as plan_name, p.plan_code, p.price, p.currency, p.billing_period
         FROM subscriptions s
         JOIN companies c ON s.company_id = c.id
         JOIN subscription_plans p ON s.plan_id = p.id
         WHERE ${where}
         ORDER BY s.created_at DESC
         LIMIT $${idx++} OFFSET $${idx++}`,
        [...params, limitNum, offset]
      ),
      db.query(
        `SELECT COUNT(*)::int as total FROM subscriptions s JOIN companies c ON s.company_id = c.id WHERE ${where}`,
        params
      ),
      // Status breakdown for the whole table (unfiltered by the current
      // status/search filters), so the UI can show tab counts that don't
      // shift depending on which tab is currently selected.
      db.query(`SELECT status, COUNT(*)::int as count FROM subscriptions GROUP BY status`),
    ]);

    res.json({
      results: results.rows,
      pagination: { page: pageNum, limit: limitNum, total: totalCount.rows[0].total },
      statusCounts: Object.fromEntries(statusCounts.rows.map((r) => [r.status, r.count])),
    });
  } catch (err: any) {
    logger.error('Admin subscriptions list error:', err);
    res.status(500).json({ error: 'Failed to fetch subscriptions' });
  }
});

// PATCH /api/admin/subscriptions/:id/cancel - admin override to cancel a
// company's subscription. Unlike POST /api/subscriptions/cancel (company's
// own self-service cancel, always at period end), an admin can force an
// immediate cancellation (e.g. fraud, chargeback, support decision) via
// { immediate: true } in the body - default stays at-period-end to match
// the same "no surprise loss of access" behaviour as self-service cancel.
router.patch('/subscriptions/:id/cancel', async (req: AuthRequest, res: Response) => {
  try {
    const immediate = req.body?.immediate === true;

    const subResult = await db.query(
      `SELECT s.*, c.name as company_name FROM subscriptions s
       JOIN companies c ON s.company_id = c.id WHERE s.id = $1`,
      [req.params.id]
    );
    if (subResult.rows.length === 0) {
      return res.status(404).json({ error: 'Subscription not found' });
    }
    const sub = subResult.rows[0];

    if (stripe && sub.stripe_subscription_id) {
      if (immediate) {
        await stripe.subscriptions.cancel(sub.stripe_subscription_id);
      } else {
        await stripe.subscriptions.update(sub.stripe_subscription_id, { cancel_at_period_end: true });
      }
    } else if (!stripe) {
      // No Stripe key configured (e.g. local/dev) - fall through and update
      // our own record anyway so the admin action isn't silently a no-op;
      // there's simply nothing on Stripe's side to keep in sync yet.
      logger.warn(`Admin subscription cancel (${req.params.id}): STRIPE_SECRET_KEY not set, updating local record only`);
    }

    const updated = immediate
      ? await db.query(
          `UPDATE subscriptions SET status = 'canceled', canceled_at = NOW(), updated_at = NOW()
           WHERE id = $1 RETURNING *`,
          [req.params.id]
        )
      : await db.query(
          `UPDATE subscriptions SET cancel_at_period_end = true, updated_at = NOW()
           WHERE id = $1 RETURNING *`,
          [req.params.id]
        );

    if (immediate) {
      await db.query("UPDATE companies SET subscription_status = 'canceled' WHERE id = $1", [sub.company_id]);
    }

    await db.query(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, new_values)
       VALUES ($1, 'update', 'subscription', $2, $3)`,
      [req.user!.id, req.params.id, JSON.stringify({ action: immediate ? 'canceled_immediately' : 'cancel_at_period_end', company: sub.company_name })]
    );

    res.json(updated.rows[0]);
  } catch (err: any) {
    logger.error(`Admin subscription cancel error (${req.params.id}):`, err);
    res.status(500).json({ error: 'Failed to cancel subscription' });
  }
});

// ============================================================================
// OPPORTUNITY ACCESS REQUESTS ("Laisser mes coordonnées" leads, reviewed by
// a chargé d'affaires to grant level3 / "accès complet" on the opportunity
// detail page - see schema.sql's crm_leads access_level columns and
// routes/opportunities.ts's :id/access + :id/request-access for the other
// half of this flow).
// ============================================================================

// GET /api/admin/opportunity-leads - leads tied to an opportunity (i.e. not
// the generic contact/appointment/callback leads, which stay in the plain
// /api/crm/leads list), newest first.
router.get('/opportunity-leads', async (req: AuthRequest, res: Response) => {
  try {
    const { status, page = '1', limit = '50' } = req.query as Record<string, string>;
    const conditions: string[] = ['l.opportunity_id IS NOT NULL'];
    const params: any[] = [];
    let idx = 1;
    if (status) {
      conditions.push(`l.status = $${idx++}`);
      params.push(status);
    }
    const pageNum = Math.max(parseInt(page) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit) || 50, 1), 200);
    const offset = (pageNum - 1) * limitNum;

    const result = await db.query(
      `SELECT l.*, o.title as opportunity_title, ot.code as journey
       FROM crm_leads l
       LEFT JOIN opportunities o ON o.id = l.opportunity_id
       LEFT JOIN opportunity_types ot ON o.opportunity_type_id = ot.id
       WHERE ${conditions.join(' AND ')}
       ORDER BY l.created_at DESC LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, limitNum, offset]
    );
    res.json({ results: result.rows });
  } catch (err: any) {
    logger.error('Admin opportunity leads list error:', err);
    res.status(500).json({ error: 'Failed to fetch opportunity leads' });
  }
});

// PUT /api/admin/opportunity-leads/:id/grant-access - the only place level3
// ("accès complet") ever gets set. Deliberately requires a logged-in staff
// member (this whole router is behind requireRole admin/super_admin) - there
// is no automatic/self-serve path to level3 anywhere else in the codebase.
router.put('/opportunity-leads/:id/grant-access', async (req: AuthRequest, res: Response) => {
  try {
    const result = await db.query(
      `UPDATE crm_leads
       SET access_level = 'level3', access_granted_at = NOW(), access_granted_by = $1,
           status = 'converted', updated_at = NOW()
       WHERE id = $2 AND opportunity_id IS NOT NULL
       RETURNING *`,
      [req.user!.id, req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Lead not found' });
    }
    await db.query(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, new_values)
       VALUES ($1, 'update', 'crm_lead_access', $2, $3)`,
      [req.user!.id, req.params.id, JSON.stringify({ access_level: 'level3' })]
    );
    res.json(result.rows[0]);
  } catch (err: any) {
    logger.error('Admin grant access error:', err);
    res.status(500).json({ error: 'Failed to grant access' });
  }
});

// GET /api/admin/leads/:id/journey - visitor_events for this lead's session,
// so a chargé d'affaires calling the lead back can see what they searched
// for and looked at instead of re-asking from scratch (client requirement).
router.get('/leads/:id/journey', async (req: AuthRequest, res: Response) => {
  try {
    const leadResult = await db.query('SELECT session_id, email FROM crm_leads WHERE id = $1', [req.params.id]);
    if (leadResult.rows.length === 0) {
      return res.status(404).json({ error: 'Lead not found' });
    }
    const { session_id } = leadResult.rows[0];
    if (!session_id) {
      return res.json({ events: [] });
    }
    const eventsResult = await db.query(
      `SELECT event_type, event_label, event_data, created_at
       FROM visitor_events WHERE session_id = $1 ORDER BY created_at ASC`,
      [session_id]
    );
    res.json({ events: eventsResult.rows });
  } catch (err: any) {
    logger.error('Admin lead journey error:', err);
    res.status(500).json({ error: 'Failed to fetch visitor journey' });
  }
});

export default router;
