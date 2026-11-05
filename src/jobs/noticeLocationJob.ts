import { db } from '../config/database';
import { logger } from '../utils/logger';
import { extractNoticeLocation, extractNoticeDates, extractNoticeLinks, locationFromTitle, LOCATION_EXTRACTOR_VERSION, deptFromPostal } from '../services/noticeLocation';
import { buyerCommune } from '../services/seoV2Service';

// Remplit opportunity_locations (table ajoutée le 6 nov., aucune colonne existante modifiée) : lieu d'exécution,
// adresse de l'acheteur, départements de publication et dates lues dans l'avis. Lecture du texte uniquement :
// aucun appel externe, aucune IA. Par lots de 250, toutes les 2 minutes, annonces récentes d'abord.
export async function ensureLocationSchema(): Promise<void> {
  await db.query(`CREATE TABLE IF NOT EXISTS opportunity_locations (
    opportunity_id UUID PRIMARY KEY,
    extractor_version INT NOT NULL,
    exec_status TEXT NOT NULL,
    exec_source TEXT NOT NULL,
    exec_communes JSONB NOT NULL DEFAULT '[]'::jsonb,
    exec_departments TEXT[] NOT NULL DEFAULT '{}',
    exec_text TEXT,
    buyer_city TEXT,
    buyer_postal TEXT,
    buyer_department TEXT,
    publication_departments TEXT[] NOT NULL DEFAULT '{}',
    notice_deadline TIMESTAMPTZ,
    diffusion_end DATE,
    computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await db.query(`ALTER TABLE opportunity_locations ADD COLUMN IF NOT EXISTS deadline_source TEXT`);
  await db.query(`ALTER TABLE opportunity_locations ADD COLUMN IF NOT EXISTS notice_nature TEXT`);
  await db.query(`ALTER TABLE opportunity_locations ADD COLUMN IF NOT EXISTS supersedes TEXT[] NOT NULL DEFAULT '{}'`);
  await db.query(`CREATE INDEX IF NOT EXISTS opportunity_locations_supersedes_idx ON opportunity_locations USING GIN (supersedes)`);
}

export async function processLocationBatch(limit = 250): Promise<number> {
  const r = await db.query(`
    SELECT o.id, o.title, o.raw_data, o.buyer_name, o.location_city, o.location_department
      FROM opportunities o
      LEFT JOIN opportunity_locations l ON l.opportunity_id = o.id
     WHERE o.deleted_at IS NULL
       AND COALESCE(o.status, '') = 'active'
       AND (o.deadline IS NULL OR o.deadline >= NOW() - INTERVAL '200 days')
       AND (l.opportunity_id IS NULL OR l.extractor_version < $1 OR l.computed_at < COALESCE(o.updated_at, o.created_at))
     ORDER BY COALESCE(o.deadline, o.created_at) DESC
     LIMIT $2`, [LOCATION_EXTRACTOR_VERSION, limit]);
  for (const o of r.rows) {
    let loc; let dates; const links = (() => { try { return extractNoticeLinks(o.raw_data || {}); } catch { return { nature: null, supersedes: [] as string[] }; } })();
    try { loc = extractNoticeLocation(o.raw_data || {}); dates = extractNoticeDates(o.raw_data || {}); }
    catch (e: any) { logger.warn(`[Lieux] avis ${o.id} illisible : ${e?.message}`); loc = extractNoticeLocation({}); dates = { deadline: null, diffusionEnd: null, deadlineSource: null }; }
    if (loc.execution.status === 'inconnu') {
      const t = locationFromTitle(o.title);
      if (t) loc.execution = { status: t.communes.length ? 'texte' : 'departement', communes: t.communes, departments: t.departments, text: String(o.title).slice(0, 80), source: 'titre' };
    }
    // Sources sans adresse structurée (TED, plateformes) : commune de l'acheteur déduite de son nom (« Mairie de X »).
    if (!loc.buyer.city) {
      const c = buyerCommune({ buyer_name: o.buyer_name, location_city: o.location_city });
      if (c) loc.buyer.city = c;
    }
    if (!loc.buyer.department) loc.buyer.department = deptFromPostal(loc.buyer.postalCode);
    await db.query(`INSERT INTO opportunity_locations (opportunity_id, extractor_version, exec_status, exec_source, exec_communes, exec_departments, exec_text,
        buyer_city, buyer_postal, buyer_department, publication_departments, notice_deadline, diffusion_end, deadline_source, notice_nature, supersedes, computed_at)
      VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NOW())
      ON CONFLICT (opportunity_id) DO UPDATE SET extractor_version=EXCLUDED.extractor_version, exec_status=EXCLUDED.exec_status, exec_source=EXCLUDED.exec_source,
        exec_communes=EXCLUDED.exec_communes, exec_departments=EXCLUDED.exec_departments, exec_text=EXCLUDED.exec_text, buyer_city=EXCLUDED.buyer_city,
        buyer_postal=EXCLUDED.buyer_postal, buyer_department=EXCLUDED.buyer_department, publication_departments=EXCLUDED.publication_departments,
        notice_deadline=EXCLUDED.notice_deadline, diffusion_end=EXCLUDED.diffusion_end, deadline_source=EXCLUDED.deadline_source, notice_nature=EXCLUDED.notice_nature, supersedes=EXCLUDED.supersedes, computed_at=NOW()`,
      [o.id, LOCATION_EXTRACTOR_VERSION, loc.execution.status, loc.execution.source, JSON.stringify(loc.execution.communes), loc.execution.departments,
        loc.execution.text ? loc.execution.text.slice(0, 500) : null, loc.buyer.city, loc.buyer.postalCode, loc.buyer.department, loc.publicationDepartments,
        dates.deadline, dates.diffusionEnd, dates.deadlineSource, links.nature, links.supersedes]);
  }
  return r.rows.length;
}

let running = false;
export async function runLocationBackfill(maxBatches = 8): Promise<number> {
  if (running) return 0; running = true;
  let total = 0;
  try {
    await ensureLocationSchema();
    for (let k = 0; k < maxBatches; k++) { const n = await processLocationBatch(); total += n; if (n < 250) break; }
  } finally { running = false; }
  return total;
}

export function startNoticeLocationJob(): void {
  const cron = require('node-cron');
  const run = () => runLocationBackfill()
    .then(n => { if (n) logger.info(`[Lieux] ${n} avis localisé(s)`); })
    .catch(e => logger.warn('[Lieux] localisation des avis impossible:', e?.message));
  cron.schedule('*/2 * * * *', run);
  setTimeout(run, 45000).unref?.();
}
