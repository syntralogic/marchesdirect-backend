import { Router, Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import { logger } from '../utils/logger';
import {
  searchProspects, prospectStats, ProspectFilters, runImport, getImportState, runGoogleEnrichment,
  runWebsiteEnrichment, getEnrichState, EnrichFilters,
} from '../services/prospectService';
import { googleStatus } from '../services/googlePlacesService';
import { streamCsv, streamXlsx, countRows, XLSX_MAX_ROWS, EXPORT_COLUMNS, describeStatus } from '../services/prospectExport';
import { PROFESSIONS } from '../utils/prospectNaf';
import { DEPARTMENT_TO_REGION } from '../utils/departmentRegion';
import { db } from '../config/database';

// Mounted by routes/admin.ts under /api/admin/prospects (admin / super_admin only).
const router = Router();

const s = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const flag = (v: unknown) => v === '1' || v === 'true';

export function parseFilters(q: any): ProspectFilters {
  const status = s(q.status);
  const minRating = s(q.minRating) !== undefined ? Number(q.minRating) : undefined;
  return {
    q: s(q.q), profession: s(q.profession), region: s(q.region), department: s(q.department), city: s(q.city),
    postalCode: s(q.postalCode), status: status === 'closed' || status === 'all' ? status : 'active',
    hasGoogle: flag(q.hasGoogle), hasFacebook: flag(q.hasFacebook), hasPhone: flag(q.hasPhone),
    hasEmail: flag(q.hasEmail), hasWebsite: flag(q.hasWebsite),
    minRating: minRating !== undefined && Number.isFinite(minRating) ? minRating : undefined,
  };
}

router.get('/meta', async (_req: AuthRequest, res: Response) => {
  try {
    const regions = [...new Set(Object.values(DEPARTMENT_TO_REGION))].sort((a, b) => a.localeCompare(b, 'fr'));
    res.json({
      professions: Object.entries(PROFESSIONS).map(([key, label]) => ({ key, label })),
      regions, departments: Object.keys(DEPARTMENT_TO_REGION).sort().map(code => ({ code, region: DEPARTMENT_TO_REGION[code] })),
      columns: EXPORT_COLUMNS.map(c => ({ key: c.key, header: c.header })),
      google: await googleStatus(),
    });
  } catch (err) { logger.error('prospects meta error', err); res.status(500).json({ error: 'Failed to load metadata' }); }
});

router.get('/stats', async (_req: AuthRequest, res: Response) => {
  try { res.json(await prospectStats()); }
  catch (err) { logger.error('prospects stats error', err); res.status(500).json({ error: 'Failed to load statistics' }); }
});

router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit || '50'), 10) || 50));
    res.json(await searchProspects(parseFilters(req.query), page, limit, s(req.query.sort) || 'name'));
  } catch (err) { logger.error('prospects list error', err); res.status(500).json({ error: 'Failed to fetch companies' }); }
});

// Full record + per-field status (so the UI can show confirmed / missing / not checked).
router.get('/:id(\\d+)', async (req: AuthRequest, res: Response) => {
  try {
    const r = await db.query('SELECT * FROM prospect_companies WHERE id = $1', [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Not found' });
    const row = r.rows[0];
    const statuses: Record<string, string> = {};
    for (const [k, m] of Object.entries<any>(row.field_meta || {})) statuses[k] = describeStatus(m);
    res.json({ ...row, field_status: statuses });
  } catch (err) { logger.error('prospect detail error', err); res.status(500).json({ error: 'Failed to fetch company' }); }
});

const fileStem = () => `entreprises-${new Date().toISOString().slice(0, 10)}`;

router.get('/export.csv', async (req: AuthRequest, res: Response) => {
  try { await streamCsv(res, parseFilters(req.query), fileStem()); }
  catch (err) {
    logger.error('prospects csv export error', err);
    if (!res.headersSent) res.status(500).json({ error: 'Export failed' }); else res.end();
  }
});

router.get('/export.xlsx', async (req: AuthRequest, res: Response) => {
  try {
    const f = parseFilters(req.query);
    const n = await countRows(f);
    if (n > XLSX_MAX_ROWS) {
      return res.status(413).json({ error: `${n} lignes: Excel est limité ici à ${XLSX_MAX_ROWS}. Affinez les filtres (métier, région, département) ou utilisez l\u2019export CSV.` });
    }
    await streamXlsx(res, f, fileStem());
  } catch (err) {
    logger.error('prospects xlsx export error', err);
    if (!res.headersSent) res.status(500).json({ error: 'Export failed' }); else res.end();
  }
});

// ---- background jobs ------------------------------------------------------
router.post('/import', async (req: AuthRequest, res: Response) => {
  const b = req.body || {};
  if (getImportState().running) return res.status(409).json({ error: 'Un import est déjà en cours', state: getImportState() });
  try {
    // planImportQueries validates synchronously inside runImport before the first await
    const p = runImport({
      profession: s(b.profession), naf: s(b.naf), department: s(b.department), region: s(b.region),
      postalCode: s(b.postalCode), q: s(b.q), maxPagesPerQuery: Number(b.maxPagesPerQuery) || undefined,
    });
    p.catch(err => logger.error('prospect import crashed', err));
    // surface validation errors immediately, otherwise report "started"
    await Promise.race([p.then(() => null), new Promise(r => setTimeout(r, 50))]);
    res.status(202).json({ started: true, state: getImportState() });
  } catch (err: any) { res.status(400).json({ error: err?.message || 'Paramètres invalides' }); }
});
router.get('/import/status', (_req: AuthRequest, res: Response) => res.json(getImportState()));

const enrichFilters = (b: any): EnrichFilters => ({
  ...parseFilters(b || {}), limit: Number(b?.limit) || undefined, refreshDays: Number(b?.refreshDays) || undefined,
});

router.get('/google/status', async (_req: AuthRequest, res: Response) => res.json(await googleStatus()));

router.post('/enrich/google', async (req: AuthRequest, res: Response) => {
  const st = await googleStatus();
  if (st.state !== 'ready') return res.status(409).json({ error: st.message, google: st });
  if (getEnrichState().running) return res.status(409).json({ error: 'Un enrichissement est déjà en cours' });
  runGoogleEnrichment(enrichFilters(req.body)).catch(err => logger.error('google enrichment crashed', err));
  res.status(202).json({ started: true, state: getEnrichState() });
});

router.post('/enrich/website', async (req: AuthRequest, res: Response) => {
  if (getEnrichState().running) return res.status(409).json({ error: 'Un enrichissement est déjà en cours' });
  runWebsiteEnrichment(enrichFilters(req.body)).catch(err => logger.error('website enrichment crashed', err));
  res.status(202).json({ started: true, state: getEnrichState() });
});

router.get('/enrich/status', (_req: AuthRequest, res: Response) => res.json(getEnrichState()));

export default router;
