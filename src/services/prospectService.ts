import { db } from '../config/database';
import { logger } from '../utils/logger';
import { PROSPECT_DDL } from './prospectSchema';
import { fetchSirenePage, ProspectRecord, FieldMetaEntry, SireneError } from './sireneClient';
import {
  googleStatus, reserveGoogleCall, searchPlaces, pickBest, MIN_CONFIDENCE, GoogleAuthOrQuotaError,
} from './googlePlacesService';
import { fetchWebsiteFindings, normalizeFrPhone } from './websiteEnrichmentService';
import { nafCodesForProfession, isKnownProfession, normalizeNaf } from '../utils/prospectNaf';
import { DEPARTMENT_TO_REGION, normalizeDepartmentCode } from '../utils/departmentRegion';

export async function ensureProspectSchema(): Promise<void> {
  for (const sql of PROSPECT_DDL) {
    try { await db.query(sql); } catch (err) { logger.error(`prospect schema step failed: ${sql.slice(0, 80).replace(/\s+/g, ' ')}`, err); }
  }
}

// ---------------------------------------------------------------------------
// Upsert (dedup by SIRET). Registry fields come from SIRENE and overwrite; fields
// enriched elsewhere (phone, email, website, social, Google*) are NEVER touched by
// a registry re-import, and field_meta is merged key by key so a SIRENE refresh
// cannot erase the provenance of Google/website data.
// ---------------------------------------------------------------------------
export async function upsertProspects(records: ProspectRecord[]): Promise<{ added: number; updated: number }> {
  let added = 0, updated = 0;
  for (const r of records) {
    const res = await db.query(
      `INSERT INTO prospect_companies (
         siret, siren, is_head_office, company_name, trading_name, naf_code, activity_label, profession,
         legal_form_code, legal_form_label, is_artisan, status, creation_date, closure_date,
         employee_range, employee_range_code, revenue_eur, revenue_year, net_result_eur,
         address_line, postal_code, city, department, region, latitude, longitude,
         directors, certifications, history, field_meta, source_updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27::jsonb,$28::jsonb,$29::jsonb,$30::jsonb, NOW())
       ON CONFLICT (siret) DO UPDATE SET
         siren = EXCLUDED.siren, is_head_office = EXCLUDED.is_head_office,
         company_name = EXCLUDED.company_name, trading_name = EXCLUDED.trading_name,
         naf_code = EXCLUDED.naf_code, activity_label = EXCLUDED.activity_label, profession = EXCLUDED.profession,
         legal_form_code = EXCLUDED.legal_form_code, legal_form_label = EXCLUDED.legal_form_label,
         is_artisan = COALESCE(EXCLUDED.is_artisan, prospect_companies.is_artisan),
         status = EXCLUDED.status, creation_date = EXCLUDED.creation_date, closure_date = EXCLUDED.closure_date,
         employee_range = EXCLUDED.employee_range, employee_range_code = EXCLUDED.employee_range_code,
         revenue_eur = EXCLUDED.revenue_eur, revenue_year = EXCLUDED.revenue_year, net_result_eur = EXCLUDED.net_result_eur,
         address_line = EXCLUDED.address_line, postal_code = EXCLUDED.postal_code, city = EXCLUDED.city,
         department = EXCLUDED.department, region = EXCLUDED.region,
         latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude,
         directors = CASE WHEN jsonb_array_length(EXCLUDED.directors) > 0 THEN EXCLUDED.directors ELSE prospect_companies.directors END,
         certifications = EXCLUDED.certifications, history = EXCLUDED.history,
         field_meta = prospect_companies.field_meta || EXCLUDED.field_meta,
         source_updated_at = NOW(), updated_at = NOW()
       RETURNING (xmax = 0) AS inserted`,
      [
        r.siret, r.siren, r.is_head_office, r.company_name, r.trading_name, r.naf_code, r.activity_label, r.profession,
        r.legal_form_code, r.legal_form_label, r.is_artisan, r.status, r.creation_date, r.closure_date,
        r.employee_range, r.employee_range_code, r.revenue_eur, r.revenue_year, r.net_result_eur,
        r.address_line, r.postal_code, r.city, r.department, r.region, r.latitude, r.longitude,
        JSON.stringify(r.directors), JSON.stringify(r.certifications), JSON.stringify(r.history), JSON.stringify(r.field_meta),
      ]);
    if (res.rows[0]?.inserted) added++; else updated++;
  }
  return { added, updated };
}

// ---------------------------------------------------------------------------
// Search (profession / region / department / city / text) with exact counts
// ---------------------------------------------------------------------------
export interface ProspectFilters {
  q?: string; profession?: string; region?: string; department?: string; city?: string; postalCode?: string;
  status?: 'active' | 'closed' | 'all';
  hasGoogle?: boolean; hasFacebook?: boolean; hasPhone?: boolean; hasEmail?: boolean; hasWebsite?: boolean;
  minRating?: number;
}

export function buildWhere(f: ProspectFilters): { where: string; params: any[] } {
  const c: string[] = []; const p: any[] = [];
  const add = (sql: string, v: any) => { p.push(v); c.push(sql.split('$#').join(`$${p.length}`)); };
  const status = f.status || 'active';
  if (status !== 'all') add('status = $#', status);
  if (f.profession) add('profession = $#', f.profession);
  if (f.region) add('region = $#', f.region);
  if (f.department) add('department = $#', (normalizeDepartmentCode(f.department) || f.department).toUpperCase());
  if (f.postalCode) add('postal_code = $#', f.postalCode);
  if (f.city) add('unaccent(lower(city)) = unaccent(lower($#))', f.city.trim());
  if (f.q) add(`(company_name ILIKE $# OR trading_name ILIKE $# OR siret LIKE $# OR siren LIKE $#)`, `%${f.q.trim().replace(/[%_]/g, '')}%`);
  if (f.hasGoogle) c.push('google_maps_url IS NOT NULL');
  if (f.hasFacebook) c.push('facebook_url IS NOT NULL');
  if (f.hasPhone) c.push('phone IS NOT NULL');
  if (f.hasEmail) c.push('email IS NOT NULL');
  if (f.hasWebsite) c.push('website IS NOT NULL');
  if (f.minRating !== undefined && Number.isFinite(f.minRating)) add('google_rating >= $#', f.minRating);
  return { where: c.length ? `WHERE ${c.join(' AND ')}` : '', params: p };
}

export async function searchProspects(f: ProspectFilters, page = 1, limit = 50, sort = 'name') {
  const { where, params } = buildWhere(f);
  const orderBy = ({
    name: 'company_name ASC, siret ASC',
    rating: 'google_rating DESC NULLS LAST, google_review_count DESC NULLS LAST, siret ASC',
    reviews: 'google_review_count DESC NULLS LAST, siret ASC',
    recent: 'creation_date DESC NULLS LAST, siret ASC',
  } as Record<string, string>)[sort] || 'company_name ASC, siret ASC';
  const lim = Math.min(200, Math.max(1, limit)); const off = (Math.max(1, page) - 1) * lim;
  const [rows, count] = await Promise.all([
    db.query(`SELECT * FROM prospect_companies ${where} ORDER BY ${orderBy} LIMIT ${lim} OFFSET ${off}`, params),
    db.query(`SELECT COUNT(*)::int AS n FROM prospect_companies ${where}`, params),
  ]);
  const total = count.rows[0].n as number;
  return { results: rows.rows, pagination: { page: Math.max(1, page), limit: lim, total, totalPages: Math.max(1, Math.ceil(total / lim)) } };
}

/** Coverage statistics: how many rows have each requested field (value) vs confirmed missing vs not checked. */
export async function prospectStats() {
  const r = await db.query(`
    SELECT COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE status='active')::int AS active,
      COUNT(DISTINCT siren)::int AS companies,
      COUNT(phone)::int AS phone, COUNT(email)::int AS email, COUNT(website)::int AS website,
      COUNT(facebook_url)::int AS facebook, COUNT(instagram_url)::int AS instagram, COUNT(linkedin_url)::int AS linkedin,
      COUNT(google_maps_url)::int AS google_maps, COUNT(google_rating)::int AS google_rating,
      COUNT(google_review_count)::int AS google_review_count,
      COUNT(revenue_eur)::int AS revenue, COUNT(employee_range)::int AS employees,
      COUNT(*) FILTER (WHERE jsonb_array_length(directors) > 0)::int AS directors,
      COUNT(*) FILTER (WHERE jsonb_array_length(certifications) > 0)::int AS certifications,
      COUNT(*) FILTER (WHERE google_fetched_at IS NOT NULL)::int AS google_checked
    FROM prospect_companies`);
  const byProf = await db.query(`SELECT profession, COUNT(*)::int AS n FROM prospect_companies WHERE status='active' GROUP BY 1 ORDER BY n DESC`);
  const byRegion = await db.query(`SELECT COALESCE(region,'(inconnue)') AS region, COUNT(*)::int AS n FROM prospect_companies WHERE status='active' GROUP BY 1 ORDER BY n DESC`);
  return { ...r.rows[0], byProfession: byProf.rows, byRegion: byRegion.rows };
}

// ---------------------------------------------------------------------------
// Import job (SIRENE via recherche-entreprises): profession/NAF x département
// ---------------------------------------------------------------------------
export interface ImportParams {
  profession?: string; naf?: string; department?: string; region?: string; postalCode?: string; q?: string;
  maxPagesPerQuery?: number;
}
export interface JobState { running: boolean; runId: number | null; message: string; rowsRead: number; added: number; updated: number; startedAt: string | null }
const importState: JobState = { running: false, runId: null, message: 'idle', rowsRead: 0, added: 0, updated: 0, startedAt: null };
export const getImportState = () => ({ ...importState });

export function planImportQueries(p: ImportParams): Array<{ naf?: string; departement?: string; codePostal?: string }> {
  let nafs: Array<string | undefined>;
  if (p.naf) { const n = normalizeNaf(p.naf); if (!n) throw new Error(`NAF invalide: ${p.naf}`); nafs = [n]; }
  else if (p.profession) {
    if (!isKnownProfession(p.profession) || p.profession === 'autre') throw new Error(`Profession inconnue: ${p.profession}`);
    nafs = nafCodesForProfession(p.profession);
  } else nafs = [undefined];

  let depts: Array<string | undefined>;
  if (p.department) { const d = normalizeDepartmentCode(p.department); if (!d) throw new Error(`Département invalide: ${p.department}`); depts = [d]; }
  else if (p.region) {
    depts = Object.keys(DEPARTMENT_TO_REGION).filter(d => DEPARTMENT_TO_REGION[d] === p.region);
    if (!depts.length) throw new Error(`Région inconnue: ${p.region}`);
  } else depts = [undefined];

  if (!p.q && !p.naf && !p.profession && !p.department && !p.region && !p.postalCode) {
    throw new Error('Préciser au moins une profession/NAF, un département, une région ou un code postal.');
  }
  const out: Array<{ naf?: string; departement?: string; codePostal?: string }> = [];
  for (const naf of nafs) for (const departement of depts) out.push({ naf, departement, codePostal: p.postalCode });
  return out;
}

export async function runImport(p: ImportParams): Promise<void> {
  if (importState.running) throw new Error('Un import est déjà en cours');
  const plan = planImportQueries(p);
  const maxPages = Math.min(400, Math.max(1, p.maxPagesPerQuery || 40));
  Object.assign(importState, { running: true, message: 'démarrage', rowsRead: 0, added: 0, updated: 0, startedAt: new Date().toISOString() });
  const run = await db.query(`INSERT INTO prospect_import_runs (kind, params) VALUES ('sirene', $1::jsonb) RETURNING id`, [JSON.stringify(p)]);
  importState.runId = run.rows[0].id;
  let failed: string | null = null; let truncated = 0;
  try {
    for (let i = 0; i < plan.length; i++) {
      const qy = plan[i];
      for (let page = 1; page <= maxPages; page++) {
        importState.message = `requête ${i + 1}/${plan.length} (${qy.naf || 'tous NAF'} / ${qy.departement || 'France'}) page ${page}`;
        const res = await fetchSirenePage({ ...qy, q: p.q, page });
        const up = await upsertProspects(res.records);
        importState.rowsRead += res.rawCount; importState.added += up.added; importState.updated += up.updated;
        if (page >= res.totalPages || res.rawCount === 0) break;
        if (page === maxPages) truncated++;   // more pages exist than we were asked to read
      }
    }
  } catch (err: any) {
    failed = err instanceof SireneError ? err.message : `Erreur: ${err?.message}`;
    logger.error('Prospect import failed', err);
  } finally {
    const status = failed ? (importState.rowsRead > 0 ? 'partial' : 'failed') : (truncated ? 'partial' : 'success');
    const msg = failed || (truncated ? `${truncated} requête(s) tronquée(s) à ${maxPages} pages: découper par département/NAF ou augmenter maxPagesPerQuery` : 'terminé');
    importState.message = msg; importState.running = false;
    await db.query(`UPDATE prospect_import_runs SET status=$2, rows_read=$3, rows_added=$4, rows_updated=$5, message=$6, finished_at=NOW() WHERE id=$1`,
      [importState.runId, status, importState.rowsRead, importState.added, importState.updated, msg]).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Enrichment (Google Business Profile + company website). Both are cost/credential gated.
// ---------------------------------------------------------------------------
const enrichState: JobState & { kind: string } = { kind: 'none', running: false, runId: null, message: 'idle', rowsRead: 0, added: 0, updated: 0, startedAt: null };
export const getEnrichState = () => ({ ...enrichState });

const nowIso = () => new Date().toISOString();
async function mergeMeta(id: number, meta: Record<string, FieldMetaEntry>) {
  await db.query(`UPDATE prospect_companies SET field_meta = field_meta || $2::jsonb, updated_at = NOW() WHERE id = $1`, [id, JSON.stringify(meta)]);
}

export interface EnrichFilters extends ProspectFilters { limit?: number; refreshDays?: number }

export async function runGoogleEnrichment(f: EnrichFilters): Promise<void> {
  if (enrichState.running) throw new Error('Un enrichissement est déjà en cours');
  const st = await googleStatus();
  if (st.state !== 'ready') throw new Error(st.message);
  const limit = Math.min(5000, Math.max(1, f.limit || 50));
  const refresh = Math.max(1, f.refreshDays || 30);
  const { where, params } = buildWhere({ ...f, status: 'active' });
  params.push(refresh);
  const due = `(google_fetched_at IS NULL OR google_fetched_at < NOW() - ($${params.length} || ' days')::interval)`;
  const sql = `SELECT * FROM prospect_companies ${where ? where + ' AND ' : 'WHERE '}${due} ORDER BY google_fetched_at NULLS FIRST, id LIMIT ${limit}`;
  const rows = (await db.query(sql, params)).rows;

  Object.assign(enrichState, { kind: 'google', running: true, message: 'démarrage', rowsRead: 0, added: 0, updated: 0, startedAt: nowIso() });
  try {
    for (const row of rows) {
      if (!(await reserveGoogleCall(st.dailyCap))) { enrichState.message = `plafond quotidien atteint (${st.dailyCap})`; break; }
      enrichState.rowsRead++;
      try {
        const places = await searchPlaces({
          company_name: row.company_name, trading_name: row.trading_name, postal_code: row.postal_code,
          latitude: row.latitude, longitude: row.longitude, city: row.city,
        });
        const best = pickBest({ company_name: row.company_name, trading_name: row.trading_name, postal_code: row.postal_code, latitude: row.latitude, longitude: row.longitude }, places);
        const at = nowIso();
        const noPositive: FieldMetaEntry = { status: 'unavailable', source: 'google_places', at, note: 'l\u2019API Places ne fournit ni la répartition des étoiles ni le détail de tous les avis: nécessite un fournisseur de données d\u2019avis sous licence' };
        if (!best || best.confidence < MIN_CONFIDENCE) {
          await db.query(`UPDATE prospect_companies SET google_fetched_at = NOW(), google_match_confidence = $2, updated_at = NOW() WHERE id = $1`, [row.id, best?.confidence ?? 0]);
          await mergeMeta(row.id, {
            google_profile: { status: 'confirmed_missing', source: 'google_places', at, note: best ? `meilleure correspondance trop faible (${best.confidence})` : 'aucun résultat Google' },
            google_rating: { status: 'confirmed_missing', source: 'google_places', at }, google_review_count: { status: 'confirmed_missing', source: 'google_places', at },
            google_positive_reviews: noPositive,
          });
          continue;
        }
        const pl = best.place;
        const phone = normalizeFrPhone(pl.nationalPhoneNumber);
        const hasRating = typeof pl.rating === 'number';
        const hasCount = typeof pl.userRatingCount === 'number';
        await db.query(
          `UPDATE prospect_companies SET
             google_place_id = $2, google_maps_url = $3, google_rating = $4, google_review_count = $5,
             google_match_confidence = $6, google_fetched_at = NOW(),
             website = COALESCE(website, $7), phone = COALESCE(phone, $8), updated_at = NOW()
           WHERE id = $1`,
          [row.id, pl.id, pl.googleMapsUri || null, hasRating ? pl.rating : null, hasCount ? pl.userRatingCount : null, best.confidence, pl.websiteUri || null, phone]);
        const meta: Record<string, FieldMetaEntry> = {
          google_profile: { status: pl.googleMapsUri ? 'confirmed' : 'confirmed_missing', source: 'google_places', at },
          google_rating: hasRating ? { status: 'confirmed', source: 'google_places', at } : { status: 'confirmed_missing', source: 'google_places', at, note: 'aucune note publiée' },
          google_review_count: hasCount ? { status: 'confirmed', source: 'google_places', at } : { status: 'confirmed_missing', source: 'google_places', at },
          google_positive_reviews: noPositive,
        };
        if (pl.websiteUri && !row.website) meta.website = { status: 'confirmed', source: 'google_places', at };
        else if (!pl.websiteUri && !row.website) meta.website = { status: 'confirmed_missing', source: 'google_places', at };
        if (phone && !row.phone) meta.phone = { status: 'confirmed', source: 'google_places', at };
        else if (!phone && !row.phone) meta.phone = { status: 'confirmed_missing', source: 'google_places', at };
        await mergeMeta(row.id, meta);
        enrichState.updated++;
      } catch (err: any) {
        if (err instanceof GoogleAuthOrQuotaError) throw err;
        await mergeMeta(row.id, { google_profile: { status: 'error', source: 'google_places', at: nowIso(), note: String(err?.message || err).slice(0, 200) } });
      }
    }
    if (enrichState.message === 'démarrage') enrichState.message = 'terminé';
  } catch (err: any) {
    enrichState.message = `arrêté: ${err?.message}`;
    logger.error('Google enrichment stopped', err);
  } finally {
    enrichState.running = false;
  }
}

export async function runWebsiteEnrichment(f: EnrichFilters): Promise<void> {
  if (enrichState.running) throw new Error('Un enrichissement est déjà en cours');
  const limit = Math.min(5000, Math.max(1, f.limit || 100));
  const { where, params } = buildWhere({ ...f, status: 'active', hasWebsite: true });
  const sql = `SELECT * FROM prospect_companies ${where} AND (field_meta->'facebook_url') IS NULL ORDER BY id LIMIT ${limit}`;
  const rows = (await db.query(sql, params)).rows;
  Object.assign(enrichState, { kind: 'website', running: true, message: 'démarrage', rowsRead: 0, added: 0, updated: 0, startedAt: nowIso() });
  try {
    for (const row of rows) {
      enrichState.rowsRead++;
      const at = nowIso();
      try {
        const found = await fetchWebsiteFindings(row.website);
        await db.query(
          `UPDATE prospect_companies SET facebook_url = COALESCE(facebook_url, $2), instagram_url = COALESCE(instagram_url, $3),
             linkedin_url = COALESCE(linkedin_url, $4), phone = COALESCE(phone, $5), email = COALESCE(email, $6), updated_at = NOW() WHERE id = $1`,
          [row.id, found.facebook, found.instagram, found.linkedin, found.phone, found.email]);
        const m = (v: string | null, label: string): FieldMetaEntry => v
          ? { status: 'confirmed', source: 'company_website', at }
          : { status: 'confirmed_missing', source: 'company_website', at, note: `aucun lien ${label} publié sur la page d\u2019accueil` };
        const meta: Record<string, FieldMetaEntry> = {
          facebook_url: m(found.facebook, 'Facebook'), instagram_url: m(found.instagram, 'Instagram'), linkedin_url: m(found.linkedin, 'LinkedIn'),
        };
        if (!row.phone) meta.phone = m(found.phone, 'téléphone');
        if (!row.email) meta.email = m(found.email, 'e-mail');
        await mergeMeta(row.id, meta);
        enrichState.updated++;
      } catch (err: any) {
        await mergeMeta(row.id, { facebook_url: { status: 'error', source: 'company_website', at, note: String(err?.message || err).slice(0, 200) } });
      }
    }
    enrichState.message = 'terminé';
  } finally { enrichState.running = false; }
}
