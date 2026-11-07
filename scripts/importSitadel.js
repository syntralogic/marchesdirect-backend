/**
 * IMPORT — « Chantiers à venir » : permis de construire et déclarations préalables autorisés (base Sitadel, SDES)
 * ============================================================================================================
 * 7 nov. 2026, demande de Hedi (même principe que Filon BTP). Source officielle, Licence Ouverte : « Liste des permis
 * de construire et autres autorisations d'urbanisme » (SDES, data.gouv.fr 689c42fa521ccf80ce954f83), lue par l'API
 * DiDo du SDES avec un filtre côté serveur (département + date d'autorisation + colonnes utiles) : jamais le fichier
 * national entier (378 Mo), lecture département par département, en flux, par paquets de 500 lignes.
 *
 * Données personnelles : le SDES retire déjà les noms et coordonnées des particuliers (personnes physiques). Nous
 * n'importons ni l'adresse du terrain, ni les parcelles, ni la localité du demandeur : seulement la commune, le code
 * postal du terrain, la nature du projet et ses surfaces. La dénomination et le SIREN ne sont gardés que pour les
 * sociétés (champ rempli par le SDES) et ne sont jamais affichés publiquement (réservés à la mise en relation).
 *
 * Fréquence : le SDES publie une fois par mois (fin du mois suivant). Le script ne refait l'import complet que si
 * le dernier remonte à plus de 3 jours ; il réimporte les 12 derniers mois à chaque fois (changements d'état).
 */
const { Pool } = require('pg');
const { Readable } = require('stream');

const BASE = 'https://data.statistiques.developpement-durable.gouv.fr/dido/api/v1/datafiles';
const FILES = [
  // 7 nov. : le fichier « locaux » n'a ni NB_LGT_TOT_CREES ni I_PISCINE (refus HTTP 400 de l'API) : colonnes par fichier.
  { kind: 'logements', rid: '8b35affb-55fc-4c1f-915b-7750f974446a', surf: 'SURF_HAB_CREEE', extra: ['NB_LGT_TOT_CREES', 'I_PISCINE'], minArea: 0 },
  // Locaux : les micro-ouvrages (postes électriques, abris, 0 à 19 m²) ne sont pas des chantiers pour un artisan.
  { kind: 'locaux', rid: 'f8f0700f-806c-40a7-83b1-f21cf507e7c4', surf: 'SURF_LOC_CREEE', extra: [], minArea: 20 },
];
const COLS = ['NUM_DAU', 'TYPE_DAU', 'ETAT_DAU', 'DATE_REELLE_AUTORISATION', 'DATE_REELLE_DOC', 'DEP_CODE', 'COMM', 'ADR_LOCALITE_TER',
  'ADR_CODPOST_TER', 'NATURE_PROJET_DECLAREE', 'DESTINATION_PRINCIPALE', 'SUPERFICIE_TERRAIN', 'DENOM_DEM', 'SIREN_DEM'];
const DEPTS = [...Array.from({ length: 95 }, (_, i) => String(i + 1).padStart(2, '0')).filter(d => d !== '20'), '2A', '2B', '971', '972', '973', '974', '976'];
const MONTHS_BACK = 12;
const MIN_HOURS_BETWEEN_RUNS = 72;

const connectionString = process.env.DATABASE_URL;
const pool = connectionString
  ? new Pool({ connectionString, ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false }, max: 2 })
  : new Pool({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 5432), database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD, max: 2,
      ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false });

// Certaines localités arrivent doublement mal encodées (« SAINT-MÃÂDARD ») : on répare tant que c'est possible.
function fixText(s) {
  let t = String(s || '').trim();
  for (let i = 0; i < 3 && /Ã|Â/.test(t); i++) {
    const r = Buffer.from(t, 'latin1').toString('utf8');
    if (r.includes('�') || r === t) break;
    t = r;
  }
  // Reste illisible (octets perdus en route) : dans ces localités en capitales, c'est presque toujours un « É ».
  t = t.replace(/A?Ã[\u0080-\u00BF]?(?:Â[\u0080-\u00BF]?)*/g, 'É').replace(/Â/g, '');
  return t.replace(/\s+/g, ' ');
}
const titleCase = s => fixText(s).toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase()).replace(/\b(De|Du|Des|La|Le|Les|Sur|Sous|En|Et|Aux)\b/g, w => w.toLowerCase()).replace(/^./, c => c.toUpperCase());

// Lecteur CSV minimal en flux (séparateur « ; », champs entre guillemets, guillemets doublés).
async function* csvRows(stream) {
  let buf = ''; let header = null;
  for await (const chunk of stream) {
    buf += chunk.toString('utf8');
    let start = 0, inQ = false;
    for (let i = 0; i < buf.length; i++) {
      const c = buf[i];
      if (c === '"') inQ = !inQ;
      else if (c === '\n' && !inQ) {
        const line = buf.slice(start, i).replace(/\r$/, ''); start = i + 1;
        if (!line) continue;
        const f = []; let cur = '', q = false;
        for (let j = 0; j < line.length; j++) {
          const ch = line[j];
          if (q) { if (ch === '"') { if (line[j + 1] === '"') { cur += '"'; j++; } else q = false; } else cur += ch; }
          else if (ch === '"') q = true; else if (ch === ';') { f.push(cur); cur = ''; } else cur += ch;
        }
        f.push(cur);
        if (!header) { header = f; continue; }
        yield Object.fromEntries(header.map((h, k) => [h, f[k] ?? '']));
      }
    }
    buf = buf.slice(start);
  }
}

const num = v => { const n = Number(String(v || '').replace(',', '.')); return Number.isFinite(n) ? n : null; };
const isoDate = v => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : null);

// Noms officiels des communes (code INSEE → nom accentué, API Découpage administratif). La localité saisie dans
// Sitadel est souvent sans accent ou mal encodée (« ATAMPES-SUR-MARNE », « CHATEAU THIERRY ») : elle ne sert qu'en secours.
async function communeNames() {
  try {
    const r = await fetch('https://geo.api.gouv.fr/communes?fields=code,nom&format=json&type=commune-actuelle,arrondissement-municipal', { signal: AbortSignal.timeout(60000) });
    if (!r.ok) return new Map();
    return new Map((await r.json()).map(c => [c.code, c.nom]));
  } catch { return new Map(); }
}

async function fetchRetry(url) {
  let last;
  for (let k = 0; k < 3; k++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(180000) });
      if (res.ok) return res;
      last = new Error(`HTTP ${res.status}`);
    } catch (e) { last = e; }
    await new Promise(r => setTimeout(r, 5000 * (k + 1)));
  }
  throw last;
}

async function main() {
  await pool.query(`CREATE TABLE IF NOT EXISTS construction_projects (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, type_dau TEXT, etat INT, authorized_at DATE, started_at DATE,
      department TEXT, commune_insee TEXT, commune TEXT, postal_code TEXT, nature TEXT, destination INT,
      floor_area NUMERIC, dwellings INT, land_area NUMERIC, pool BOOLEAN, applicant_name TEXT, applicant_siren TEXT,
      edition TEXT, imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await pool.query(`CREATE INDEX IF NOT EXISTS construction_projects_dep_date ON construction_projects (department, authorized_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS construction_projects_commune ON construction_projects (commune_insee, authorized_at DESC)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS construction_imports (id SERIAL PRIMARY KEY, started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at TIMESTAMPTZ, rows_upserted INT, error TEXT)`);
  // Reprise (7 nov.) : chaque couple fichier × département déjà importé depuis moins de 72 h est sauté, pour qu'un
  // redémarrage du serveur ne relance pas tout depuis le début. L'avancement est visible dans /api/chantiers/stats.
  await pool.query(`CREATE TABLE IF NOT EXISTS construction_import_parts (kind TEXT NOT NULL, department TEXT NOT NULL,
      done_at TIMESTAMPTZ, rows INT, error TEXT, PRIMARY KEY (kind, department))`);
  const last = (await pool.query(`SELECT finished_at FROM construction_imports WHERE finished_at IS NOT NULL AND error IS NULL ORDER BY finished_at DESC LIMIT 1`)).rows[0];
  if (last && Date.now() - new Date(last.finished_at).getTime() < MIN_HOURS_BETWEEN_RUNS * 3600000 && process.env.SITADEL_FORCE !== 'true') {
    console.log(`[chantiers] import récent (${new Date(last.finished_at).toISOString()}) : rien à faire`);
    return;
  }
  const run = (await pool.query(`INSERT INTO construction_imports DEFAULT VALUES RETURNING id`)).rows[0].id;
  const since = new Date(); since.setMonth(since.getMonth() - MONTHS_BACK);
  const sinceIso = since.toISOString().slice(0, 10);
  const maxDate = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10); // dates futures erronées écartées
  let total = 0; const errors = [];
  const NAMES = await communeNames();
  console.log(`[chantiers] ${NAMES.size} noms de communes officiels chargés`);
  const doneParts = new Set(process.env.SITADEL_FORCE === 'true' ? [] : (await pool.query(
    `SELECT kind || ':' || department AS k FROM construction_import_parts WHERE done_at > NOW() - INTERVAL '72 hours' AND error IS NULL`)).rows.map(r => r.k));
  for (const f of FILES) {
    const cols = [...COLS, ...f.extra, f.surf].join(',');
    for (const dep of DEPTS) {
      if (doneParts.has(`${f.kind}:${dep}`)) continue;
      const before = total;
      const url = `${BASE}/${f.rid}/csv?DEP_CODE=eq:${dep}&DATE_REELLE_AUTORISATION=gte:${sinceIso}&columns=${cols}`;
      try {
        const res = await fetchRetry(url);
        let batch = [];
        const flush = async () => {
          if (!batch.length) return;
          // Un même permis peut figurer sur plusieurs lignes (modificatifs) : on garde la dernière, sinon PostgreSQL refuse
          // le paquet entier (« ON CONFLICT DO UPDATE command cannot affect row a second time »).
          batch = [...new Map(batch.map(b => [b.id, b])).values()];
          await pool.query(`
            INSERT INTO construction_projects AS p (id, kind, type_dau, etat, authorized_at, started_at, department, commune_insee, commune, postal_code,
              nature, destination, floor_area, dwellings, land_area, pool, applicant_name, applicant_siren, imported_at)
            SELECT x.id, x.kind, x.type_dau, x.etat, x.authorized_at::date, x.started_at::date, x.department, x.commune_insee, x.commune, x.postal_code,
              x.nature, x.destination, x.floor_area, x.dwellings, x.land_area, x.pool, x.applicant_name, x.applicant_siren, NOW()
            FROM jsonb_to_recordset($1::jsonb) AS x(id text, kind text, type_dau text, etat int, authorized_at text, started_at text, department text,
              commune_insee text, commune text, postal_code text, nature text, destination int, floor_area numeric, dwellings int, land_area numeric,
              pool boolean, applicant_name text, applicant_siren text)
            ON CONFLICT (id) DO UPDATE SET etat = EXCLUDED.etat, started_at = EXCLUDED.started_at, commune = EXCLUDED.commune,
              floor_area = EXCLUDED.floor_area, dwellings = EXCLUDED.dwellings, applicant_name = EXCLUDED.applicant_name,
              applicant_siren = EXCLUDED.applicant_siren, imported_at = NOW()`, [JSON.stringify(batch)]);
          total += batch.length; batch = [];
        };
        for await (const r of csvRows(Readable.fromWeb(res.body))) {
          const auth = isoDate(r.DATE_REELLE_AUTORISATION);
          if (!r.NUM_DAU || !auth || auth > maxDate) continue;
          if (f.minArea && !((num(r[f.surf]) || 0) >= f.minArea)) continue;
          batch.push({ id: `${f.kind === 'logements' ? 'L' : 'N'}${r.NUM_DAU}`, kind: f.kind, type_dau: r.TYPE_DAU || null, etat: num(r.ETAT_DAU),
            authorized_at: auth, started_at: isoDate(r.DATE_REELLE_DOC), department: r.DEP_CODE || dep, commune_insee: r.COMM || null,
            commune: NAMES.get(r.COMM) || (r.ADR_LOCALITE_TER ? titleCase(r.ADR_LOCALITE_TER) : null), postal_code: /^\d{5}$/.test(r.ADR_CODPOST_TER || '') ? r.ADR_CODPOST_TER : null,
            nature: r.NATURE_PROJET_DECLAREE === '1' ? 'neuf' : r.NATURE_PROJET_DECLAREE === '2' ? 'existant' : null, destination: num(r.DESTINATION_PRINCIPALE),
            floor_area: num(r[f.surf]), dwellings: num(r.NB_LGT_TOT_CREES), land_area: num(r.SUPERFICIE_TERRAIN), pool: r.I_PISCINE === 'true',
            applicant_name: r.DENOM_DEM ? fixText(r.DENOM_DEM).slice(0, 200) : null, applicant_siren: /^\d{9}$/.test(r.SIREN_DEM || '') ? r.SIREN_DEM : null });
          if (batch.length >= 500) await flush();
        }
        await flush();
        await pool.query(`INSERT INTO construction_import_parts (kind, department, done_at, rows, error) VALUES ($1, $2, NOW(), $3, NULL)
          ON CONFLICT (kind, department) DO UPDATE SET done_at = NOW(), rows = EXCLUDED.rows, error = NULL`, [f.kind, dep, total - before]);
      } catch (e) {
        errors.push(`${f.kind} ${dep}: ${e.message}`);
        await pool.query(`INSERT INTO construction_import_parts (kind, department, done_at, rows, error) VALUES ($1, $2, NOW(), $3, $4)
          ON CONFLICT (kind, department) DO UPDATE SET done_at = NOW(), rows = EXCLUDED.rows, error = EXCLUDED.error`, [f.kind, dep, total - before, String(e.message || e).slice(0, 300)]).catch(() => {});
      }
      await new Promise(r => setTimeout(r, 300)); // politesse envers l'API publique
    }
  }
  // Autorisations sorties de la fenêtre de 12 mois : retirées (la table ne garde que des chantiers « à venir »).
  await pool.query(`DELETE FROM construction_projects WHERE authorized_at < $1::date`, [sinceIso]);
  await pool.query(`UPDATE construction_imports SET finished_at = NOW(), rows_upserted = $2, error = $3 WHERE id = $1`,
    [run, total, errors.length > 20 ? errors.slice(0, 20).join(' | ') : null]);
  console.log(`[chantiers] ${total} autorisations importées depuis le ${sinceIso}${errors.length ? ` · ${errors.length} erreurs : ${errors.slice(0, 5).join(' | ')}` : ''}`);
}

main().catch(e => { console.error('[chantiers] import en échec :', e.message); process.exitCode = 1; }).finally(() => pool.end());
