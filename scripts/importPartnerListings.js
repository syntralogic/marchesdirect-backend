/**
 * IMPORT — annonces partenaires (appels d'offres privés et sous-traitance)
 * ============================================================================
 * Hedi reçoit environ deux fois par semaine des listes d'annonces privées et de sous-traitance. Chaque liste est
 * convertie (hors du dépôt) en un « lot » JSON dans data/partenaires/ (.json ou .json.gz), puis importée ici au
 * démarrage du serveur (pas de terminal sur Render).
 *
 * Règles :
 *   - une annonce = une référence stable « MD-xxxxxxxxxx » : un nouveau fichier met à jour au lieu de dupliquer ;
 *   - chaque lot se remplace lui-même : une annonce absente de la nouvelle version de SON lot passe en « expired »
 *     (rien n'est supprimé, c'est réversible) ; les autres lots ne sont pas touchés ;
 *   - le donneur d'ordre n'est jamais écrit dans buyer_name ; les liens sources éventuels restent dans raw_data,
 *     masqué sur la fiche publique tant que l'identité n'est pas débloquée (routes/opportunities.ts) ;
 *   - le texte de l'annonce n'est jamais inventé. Le complément ajouté (« Pour préparer votre réponse ») est un
 *     conseil général selon le type d'annonce et le métier, présenté comme tel, jamais comme une information sur le
 *     chantier ;
 *   - une annonce sans date limite reste « à vérifier » (jamais comptée comme ouverte) ;
 *   - une ville sans département est géolocalisée une fois (api-adresse.data.gouv.fr, gratuite) et le résultat est
 *     gardé : les imports suivants ne la redemandent pas.
 * Rapide et idempotent : écritures par paquets de 300, seules les annonces nouvelles ou modifiées sont réécrites.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { Pool } = require('pg');

const DIR = path.resolve(__dirname, '..', 'data', 'partenaires');
const SOURCE_CODE = 'partner_feed';
const LOCATION_EXTRACTOR_VERSION = 5; // = src/services/noticeLocation.ts
const BATCH = 300;

const connectionString = process.env.DATABASE_URL;
const pool = connectionString
  ? new Pool({ connectionString, ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false }, max: 2 })
  : new Pool({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 5432), database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD, max: 2,
      ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false });

let regions = {};
try { regions = require('./_departmentToRegion.json'); } catch { /* région facultative */ }

const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const slug = s => norm(s).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const hash = o => crypto.createHash('sha1').update(JSON.stringify(o)).digest('hex').slice(0, 16);

// --- Complément de contenu : conseils généraux, vrais pour tout chantier du type, jamais présentés comme des faits
const TRADE_NOTES = [
  [/electri/, 'Électricité : l’habilitation électrique de vos intervenants est presque toujours demandée.'],
  [/couvert|toitur|charpent|etanch|bardage|facade|zinguer/, 'Travail en hauteur : prévoyez la formation de vos équipes et les protections (échafaudage, garde-corps, harnais).'],
  [/amiante|desamiant/, 'Amiante : la certification de l’entreprise est obligatoire (sous-section 3 pour le retrait, sous-section 4 pour les interventions sur des matériaux amiantés).'],
  [/climatis|frigori|pompe a chaleur|\bcvc\b|\bpac\b/, 'Climatisation et pompes à chaleur : l’attestation de capacité pour manipuler les fluides frigorigènes est obligatoire.'],
  [/\bgaz\b/, 'Gaz : intervenir sur une installation gaz suppose les compétences et, souvent, l’appellation « Professionnel du gaz ».'],
  [/isolation|renovation energ|photovolt|solaire|\brge\b/, 'Rénovation énergétique : si le client vise des aides publiques, la qualification RGE de l’entreprise est généralement exigée.'],
  [/nettoyage|proprete/, 'Nettoyage : préparez la liste de votre personnel et vos attestations sociales à jour.'],
];
function guidance(l) {
  const t = norm(`${l.trade || ''} ${l.title || ''}`);
  const notes = TRADE_NOTES.filter(([re]) => re.test(t)).map(([, n]) => `• ${n}`);
  const common = l.journey === 'tender'
    ? ['• Le règlement de la consultation fixe les pièces à fournir, les critères de choix et la date limite.',
       '• Pièces souvent demandées : Kbis de moins de 3 mois, attestations fiscale et sociale à jour, attestations d’assurance (responsabilité civile, décennale pour les travaux), références de chantiers comparables, mémoire technique et prix.']
    : ['• Demandez un contrat de sous-traitance écrit. En marché privé de travaux, l’entreprise principale doit garantir votre paiement par une caution ou une délégation de paiement (loi du 31 décembre 1975).',
       '• En sous-traitance de travaux du bâtiment, la TVA est en principe autoliquidée : vous facturez hors taxe, avec la mention prévue.',
       '• Pièces souvent demandées : Kbis, attestations d’assurance (responsabilité civile, décennale), attestation de vigilance Urssaf (à fournir tous les 6 mois dès 5 000 € de prestations).'];
  return [...common, ...notes].join('\n');
}
function description(l) {
  const p = [];
  if (l.kind === 'partenaires') p.push('Recherche de partenaires : il ne s’agit pas d’un chantier précis, mais d’un réseau que l’entreprise cherche à étoffer.');
  if (l.need) p.push(l.need);
  if (l.lots && l.lots.length) p.push(`Prestations et lots :\n${l.lots.map(x => `• ${x}`).join('\n')}`);
  if (l.scope) p.push(`Prestations et périmètre : ${l.scope}`);
  if (l.trade) p.push(`Métiers concernés : ${l.trade}`);
  if (l.location) p.push(`Lieu indiqué dans l’annonce : ${l.location}`);
  if (l.duration) p.push(`Durée et calendrier : ${l.duration}`);
  p.push(`Budget : ${l.budget || 'non communiqué dans l’annonce'}`);
  if (l.conditions) p.push(`Conditions et réponse : ${l.conditions}`);
  if (l.criteria) p.push(`Critères : ${l.criteria}`);
  if (l.status) p.push(`Statut : ${l.status}`);
  if (!l.deadline) p.push('Date limite et disponibilité à confirmer : l’annonce n’indique pas de date limite. Nous vérifions qu’elle est toujours d’actualité avant toute mise en relation.');
  p.push(`Pour préparer votre réponse (conseils généraux, à adapter à l’annonce) :\n${guidance(l)}`);
  return p.join('\n\n');
}

// --- Géolocalisation d'une ville sans département (api-adresse, mise en cache pour tout l'import)
const geoCache = new Map();
async function geocode(city) {
  const q = String(city || '').replace(/\s+cedex.*$/i, '').trim();
  if (q.length < 2 || /\d|departement|code|confidentiel/i.test(norm(q))) return null;
  if (geoCache.has(q)) return geoCache.get(q);
  let out = null;
  try {
    const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 8000);
    const r = await fetch(`https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(q)}&type=municipality&limit=1`, { signal: ctl.signal });
    clearTimeout(tm);
    if (r.ok) {
      const f = (await r.json()).features?.[0];
      const pr = f?.properties;
      if (pr && pr.score >= 0.6 && norm(pr.city || pr.name).replace(/[^a-z]/g, '').startsWith(norm(q).replace(/[^a-z]/g, '').slice(0, 5))) {
        const dept = String(pr.context || '').split(',')[0].trim();
        out = { city: pr.city || pr.name, postal: pr.postcode || null, department: /^(\d{2,3}|2A|2B)$/.test(dept) ? dept : null };
      }
    }
  } catch { /* réseau : la ville restera sans département */ }
  geoCache.set(q, out);
  await new Promise(res => setTimeout(res, 40)); // reste bien sous la limite de l'API
  return out;
}

function readLots() {
  if (!fs.existsSync(DIR)) return [];
  return fs.readdirSync(DIR).filter(f => /\.json(\.gz)?$/.test(f)).sort().map(f => {
    const buf = fs.readFileSync(path.join(DIR, f));
    const data = JSON.parse((f.endsWith('.gz') ? zlib.gunzipSync(buf) : buf).toString('utf8'));
    return { lot: data.lot || f.replace(/\.json(\.gz)?$/, ''), file: data.file || f, listings: (data.listings || []).filter(l => l.reference && l.title) };
  });
}

async function main() {
  const lots = readLots();
  if (!lots.length) { console.log('[partenaires] aucun lot dans data/partenaires : rien à importer'); return; }
  await pool.query(`INSERT INTO data_sources (code, name, feed_type, frequency_hours, active)
    VALUES ($1, 'Annonces partenaires (appels d''offres privés et sous-traitance)', 'manual', 84, false) ON CONFLICT (code) DO NOTHING`, [SOURCE_CODE]);
  const sourceId = (await pool.query('SELECT id FROM data_sources WHERE code = $1', [SOURCE_CODE])).rows[0]?.id;
  if (!sourceId) { console.log('[partenaires] source introuvable : import reporté'); return; }
  const types = Object.fromEntries((await pool.query('SELECT id, code FROM opportunity_types')).rows.map(r => [r.code, r.id]));
  const trades = (await pool.query('SELECT id, name FROM trades')).rows.map(t => ({ id: t.id, key: norm(t.name) })).filter(t => t.key.length >= 4)
    .sort((a, b) => b.key.length - a.key.length);
  const existing = new Map((await pool.query(`SELECT source_reference AS ref, raw_data->>'hash' AS hash, status, location_department AS dept,
      location_city AS city, raw_data->>'geo_postal' AS postal FROM opportunities WHERE source_id = $1`, [sourceId])).rows.map(r => [r.ref, r]));

  for (const { lot, file, listings } of lots) {
    let inserted = 0, updated = 0, unchanged = 0, geocoded = 0;
    const todo = [];
    for (const l of listings) {
      const h = hash(l);
      const ex = existing.get(l.reference);
      const retryGeo = ex && !ex.dept && l.city && !l.department; // ville pas encore géolocalisée (réseau) : on réessaie
      if (ex && ex.hash === h && ex.status === 'active' && !retryGeo) { unchanged++; continue; }
      let city = l.city || null, dept = l.department || null, postal = l.postal || null;
      if (!dept && city) {
        if (ex && ex.dept) { dept = ex.dept; city = ex.city || city; postal = ex.postal || postal; }
        else { const g = await geocode(city); if (g && g.department) { dept = g.department; city = g.city; postal = g.postal; geocoded++; } }
      }
      const typeId = types[l.journey];
      if (!typeId) continue;
      const t = norm(`${l.trade || ''}`); const trade = trades.find(x => t.includes(x.key)) || trades.find(x => norm(l.title).includes(x.key));
      todo.push({ ref: l.reference, type_id: typeId, trade_id: trade ? trade.id : null, title: l.title.slice(0, 900), description: description(l),
        publication: l.publication || null, deadline: l.deadline || null, value: l.amount || null, city: city ? String(city).slice(0, 200) : null, dept, region: dept ? regions[dept] || null : null,
        raw: { partner_feed: true, lot, file, hash: h, kind: l.kind, nature: l.nature || l.category || null, trade_text: l.trade || null,
               location_text: l.location || null, geo_postal: postal, partner_sources: l.sources || [] },
        loc: { status: city && !/ et /.test(city) ? 'commune' : dept ? 'departement' : 'inconnu',
               communes: city && !/ et /.test(city) ? [{ name: city, slug: slug(city), department: dept, postalCode: postal }] : [],
               depts: dept ? [dept] : [], text: l.location || null } });
    }
    for (let i = 0; i < todo.length; i += BATCH) {
      const chunk = todo.slice(i, i + BATCH);
      const r = await pool.query(`
        INSERT INTO opportunities AS o (source_id, source_reference, opportunity_type_id, trade_id, title, description, publication_date, deadline,
          estimated_value, currency, location_city, location_department, location_region, status, ai_classification_status, ai_summary_status,
          dce_documents_status, raw_data)
        SELECT $1, x.ref, x.type_id, x.trade_id, x.title, x.description, COALESCE(x.publication::date, CURRENT_DATE), x.deadline::timestamptz,
          x.value, 'EUR', x.city, x.dept, x.region, 'active', 'classified', 'not_generated', 'no_documents_found', x.raw
        FROM jsonb_to_recordset($2::jsonb) AS x(ref text, type_id int, trade_id int, title text, description text, publication text, deadline text,
          value numeric, city text, dept text, region text, raw jsonb)
        ON CONFLICT (source_id, source_reference) DO UPDATE SET
          opportunity_type_id = EXCLUDED.opportunity_type_id, trade_id = EXCLUDED.trade_id, title = EXCLUDED.title, description = EXCLUDED.description,
          deadline = EXCLUDED.deadline, estimated_value = EXCLUDED.estimated_value, location_city = EXCLUDED.location_city,
          location_department = EXCLUDED.location_department, location_region = EXCLUDED.location_region, status = 'active',
          raw_data = EXCLUDED.raw_data, deleted_at = NULL, updated_at = NOW()
        RETURNING id, source_reference AS ref, (xmax = 0) AS inserted`, [sourceId, JSON.stringify(chunk)]);
      const ids = new Map(r.rows.map(x => [x.ref, x.id]));
      for (const x of r.rows) { if (x.inserted === true || x.inserted === 't') inserted++; else updated++; }
      const locs = chunk.filter(c => ids.has(c.ref)).map(c => ({ id: ids.get(c.ref), status: c.loc.status, communes: c.loc.communes, depts: c.loc.depts,
        text: c.loc.text, deadline: c.deadline }));
      await pool.query(`
        INSERT INTO opportunity_locations (opportunity_id, extractor_version, exec_status, exec_source, exec_communes, exec_departments, exec_text,
          publication_departments, notice_deadline, deadline_source, supersedes, computed_at)
        SELECT x.id, $1, x.status, 'partenaire', x.communes, ARRAY(SELECT jsonb_array_elements_text(x.depts)), x.text,
          ARRAY(SELECT jsonb_array_elements_text(x.depts)), x.deadline::timestamptz, CASE WHEN x.deadline IS NULL THEN NULL ELSE 'annonce partenaire' END,
          '{}', NOW() + INTERVAL '1 second'
        FROM jsonb_to_recordset($2::jsonb) AS x(id uuid, status text, communes jsonb, depts jsonb, text text, deadline text)
        ON CONFLICT (opportunity_id) DO UPDATE SET extractor_version = EXCLUDED.extractor_version, exec_status = EXCLUDED.exec_status,
          exec_source = EXCLUDED.exec_source, exec_communes = EXCLUDED.exec_communes, exec_departments = EXCLUDED.exec_departments,
          exec_text = EXCLUDED.exec_text, publication_departments = EXCLUDED.publication_departments, notice_deadline = EXCLUDED.notice_deadline,
          deadline_source = EXCLUDED.deadline_source, computed_at = EXCLUDED.computed_at`, [LOCATION_EXTRACTOR_VERSION, JSON.stringify(locs)]);
    }
    const refs = listings.map(l => l.reference);
    // Ancien format (premier fichier, sans lot) : les annonces sans lot appartiennent au lot du fichier annonces.json.
    const gone = await pool.query(`UPDATE opportunities SET status = 'expired', updated_at = NOW()
       WHERE source_id = $1 AND status = 'active' AND COALESCE(raw_data->>'lot', 'annonces') = $2 AND NOT (source_reference = ANY($3::text[])) RETURNING id`,
      [sourceId, lot, refs]);
    console.log(`[partenaires] lot ${lot} (${file}) : ${inserted} ajoutées, ${updated} mises à jour, ${unchanged} inchangées, ${gone.rowCount} retirées, ${geocoded} villes géolocalisées`);
  }
}

main().catch(e => { console.error('[partenaires] import en échec :', e.message); process.exitCode = 1; }).finally(() => pool.end());
