/**
 * IMPORT — annonces partenaires (appels d'offres privés et sous-traitance)
 * ============================================================================
 * 7 nov. 2026, demande de Hedi : il reçoit environ deux fois par semaine un fichier d'annonces privées et de
 * sous-traitance. Chaque fichier est converti en data/partenaires/annonces.json (le convertisseur Word → JSON est
 * gardé hors du dépôt) puis importé ici, au démarrage du serveur (pas de terminal sur Render), comme les autres
 * scripts de démarrage.
 *
 * Règles :
 *   - une annonce = une référence stable « MD-xxxxxxxxxx » (calculée sur le lien de la fiche source) : un nouveau
 *     fichier met à jour les annonces existantes au lieu de créer des doublons ;
 *   - une annonce absente du dernier fichier passe en « expired » (rien n'est supprimé : réversible) ;
 *   - le donneur d'ordre n'est jamais écrit dans buyer_name. Les liens sources, qui peuvent le révéler, sont gardés
 *     dans raw_data (masqué sur la fiche publique tant que l'identité n'est pas débloquée, voir
 *     routes/opportunities.ts IDENTITY_REDACTED_FIELDS) pour qu'Elena puisse retrouver l'annonceur ;
 *   - le lieu et la date limite sont écrits dans opportunity_locations (lecture v2) à chaque import.
 * Idempotent : sans changement du fichier, aucune ligne n'est réécrite.
 */
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const FILE = path.resolve(__dirname, '..', 'data', 'partenaires', 'annonces.json');
const SOURCE_CODE = 'partner_feed';
const LOCATION_EXTRACTOR_VERSION = 5; // = src/services/noticeLocation.ts (le travail des lieux ne repasse pas dessus)

const connectionString = process.env.DATABASE_URL;
const pool = connectionString
  ? new Pool({ connectionString, ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false }, max: 2 })
  : new Pool({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 5432), database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD, max: 2,
      ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false });

let regions = {};
try { regions = require('./_departmentToRegion.json'); } catch { /* région facultative */ }

const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const slug = s => norm(s).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function description(l) {
  const parts = [];
  if (l.kind === 'partenaires') parts.push('Recherche de partenaires : il ne s’agit pas d’un chantier précis, mais d’un réseau que l’entreprise cherche à étoffer.');
  if (l.need) parts.push(l.need);
  if (l.scope) parts.push(`Prestations et périmètre : ${l.scope}`);
  if (l.duration) parts.push(`Durée et calendrier : ${l.duration}`);
  if (l.budget) parts.push(`Budget : ${l.budget}`);
  if (l.conditions) parts.push(`Conditions et réponse : ${l.conditions}`);
  if (l.criteria) parts.push(`Critères : ${l.criteria}`);
  if (l.status) parts.push(`Statut : ${l.status}`);
  return parts.join('\n\n');
}

async function main() {
  if (!fs.existsSync(FILE)) { console.log('[partenaires] aucun fichier data/partenaires/annonces.json : rien à importer'); return; }
  const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const listings = (data.listings || []).filter(l => l.reference && l.title);

  await pool.query(`INSERT INTO data_sources (code, name, feed_type, frequency_hours, active)
    VALUES ($1, 'Annonces partenaires (appels d''offres privés et sous-traitance)', 'manual', 84, false) ON CONFLICT (code) DO NOTHING`, [SOURCE_CODE]);
  const sourceId = (await pool.query('SELECT id FROM data_sources WHERE code = $1', [SOURCE_CODE])).rows[0]?.id;
  if (!sourceId) { console.log('[partenaires] source introuvable : import reporté'); return; }
  const types = Object.fromEntries((await pool.query('SELECT id, code FROM opportunity_types')).rows.map(r => [r.code, r.id]));
  const trades = (await pool.query('SELECT id, name FROM trades')).rows.map(t => ({ id: t.id, key: norm(t.name) })).filter(t => t.key.length >= 4)
    .sort((a, b) => b.key.length - a.key.length);

  let inserted = 0, updated = 0, unchanged = 0;
  for (const l of listings) {
    const typeId = types[l.journey];
    if (!typeId) { console.log(`[partenaires] type ${l.journey} inconnu, annonce ${l.reference} ignorée`); continue; }
    const t = norm(l.trade); const trade = trades.find(x => t.includes(x.key));
    const dept = l.department || null;
    const raw = { partner_feed: true, file: data.file, kind: l.kind, category: l.category, trade_text: l.trade, location_text: l.location,
      deadline_text: l.deadlineText, partner_sources: l.sources || [] };
    const r = await pool.query(`
      INSERT INTO opportunities AS o (source_id, source_reference, opportunity_type_id, trade_id, title, description, publication_date, deadline,
        currency, location_city, location_department, location_region, status, ai_classification_status, ai_summary_status, dce_documents_status, raw_data)
      VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::date, CURRENT_DATE), $8, 'EUR', $9, $10, $11, 'active', 'classified', 'not_generated', 'no_documents_found', $12::jsonb)
      ON CONFLICT (source_id, source_reference) DO UPDATE SET
        opportunity_type_id = EXCLUDED.opportunity_type_id, trade_id = EXCLUDED.trade_id, title = EXCLUDED.title, description = EXCLUDED.description,
        publication_date = EXCLUDED.publication_date, deadline = EXCLUDED.deadline, location_city = EXCLUDED.location_city,
        location_department = EXCLUDED.location_department, location_region = EXCLUDED.location_region, status = 'active', raw_data = EXCLUDED.raw_data,
        deleted_at = NULL, updated_at = NOW()
      WHERE o.title IS DISTINCT FROM EXCLUDED.title OR o.description IS DISTINCT FROM EXCLUDED.description OR o.deadline IS DISTINCT FROM EXCLUDED.deadline
         OR o.status IS DISTINCT FROM 'active' OR o.raw_data IS DISTINCT FROM EXCLUDED.raw_data OR o.trade_id IS DISTINCT FROM EXCLUDED.trade_id
         OR o.opportunity_type_id IS DISTINCT FROM EXCLUDED.opportunity_type_id OR o.deleted_at IS NOT NULL
      RETURNING id, (xmax = 0) AS inserted`,
      [sourceId, l.reference, typeId, trade ? trade.id : null, l.title, description(l), l.publication, l.deadline,
       l.city, dept, dept ? regions[dept] || null : null, JSON.stringify(raw)]);
    if (!r.rows.length) { unchanged++; continue; }
    if (r.rows[0].inserted) inserted++; else updated++;
    const communes = l.city && !/ et /.test(l.city) ? [{ name: l.city, slug: slug(l.city), department: dept, postalCode: null }] : [];
    await pool.query(`
      INSERT INTO opportunity_locations (opportunity_id, extractor_version, exec_status, exec_source, exec_communes, exec_departments, exec_text,
        buyer_city, buyer_postal, buyer_department, publication_departments, notice_deadline, diffusion_end, deadline_source, notice_nature, supersedes, computed_at)
      VALUES ($1, $2, $3, 'partenaire', $4::jsonb, $5, $6, NULL, NULL, NULL, $5, $7, NULL, $8, NULL, '{}', NOW() + INTERVAL '1 second')
      ON CONFLICT (opportunity_id) DO UPDATE SET extractor_version = EXCLUDED.extractor_version, exec_status = EXCLUDED.exec_status,
        exec_source = EXCLUDED.exec_source, exec_communes = EXCLUDED.exec_communes, exec_departments = EXCLUDED.exec_departments, exec_text = EXCLUDED.exec_text,
        publication_departments = EXCLUDED.publication_departments, notice_deadline = EXCLUDED.notice_deadline, deadline_source = EXCLUDED.deadline_source,
        computed_at = EXCLUDED.computed_at`,
      [r.rows[0].id, LOCATION_EXTRACTOR_VERSION, communes.length ? 'commune' : dept ? 'departement' : 'inconnu', JSON.stringify(communes), dept ? [dept] : [],
       l.location || null, l.deadline, l.deadline ? 'annonce partenaire' : null]);
  }
  // Annonces du flux absentes du dernier fichier : passées en « expired » (réversibles).
  const refs = listings.map(l => l.reference);
  const gone = await pool.query(`UPDATE opportunities SET status = 'expired', updated_at = NOW()
     WHERE source_id = $1 AND status = 'active' AND NOT (source_reference = ANY($2::text[])) RETURNING id`, [sourceId, refs]);
  console.log(`[partenaires] fichier ${data.file} : ${inserted} ajoutées, ${updated} mises à jour, ${unchanged} inchangées, ${gone.rowCount} retirées`);
}

main().catch(e => { console.error('[partenaires] import en échec :', e.message); process.exitCode = 1; }).finally(() => pool.end());
