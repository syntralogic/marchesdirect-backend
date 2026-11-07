/**
 * IMPORT — Contrats attribués (DECP consolidées, Licence Ouverte 2.0, publiées par Colmo à partir des données officielles)
 * ================================================================================================================
 * 7 nov. 2026, demande de Hedi : prix gagnants, saisonnalité des acheteurs, entreprises comparables ayant gagné.
 * Source : https://www.data.gouv.fr/datasets/608c055b35eb4e6ee20eb325 (decp.csv.gz, ~430 Mo, mis à jour chaque jour).
 * Lu EN FLUX (jamais chargé en mémoire), lignes gardées : données actuelles, travaux ou services, notifiées depuis
 * 2022, montant > 0. Le reste (fournitures, anciennes versions des avenants) est ignoré. Pas d'autre appel réseau :
 * la catégorie (PME/ETI/GE), le code NAF et les labels du titulaire sont déjà dans le fichier.
 * Les titulaires sont des entreprises (SIRET) : données publiques par nature (arrêté du 22 décembre 2022).
 */
const { Pool } = require('pg');
const zlib = require('zlib');
const { Readable } = require('stream');

const URL = 'https://www.data.gouv.fr/api/1/datasets/r/22847056-61df-452d-837d-8b8ceadbfc52';
const SINCE = '2022-01-01';
const MIN_HOURS_BETWEEN_RUNS = Number(process.env.DECP_MIN_HOURS || 7 * 24);
const connectionString = process.env.DATABASE_URL;
const pool = connectionString
  ? new Pool({ connectionString, ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false }, max: 2 })
  : new Pool({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 5432), database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD, max: 2,
      ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false });

// Lecteur CSV en flux : séparateur « , », champs entre guillemets, guillemets doublés, retours à la ligne dans les champs.
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
          else if (ch === '"') q = true; else if (ch === ',') { f.push(cur); cur = ''; } else cur += ch;
        }
        f.push(cur);
        if (!header) { header = f; continue; }
        const o = {}; for (let k = 0; k < header.length; k++) o[header[k]] = f[k] ?? '';
        yield o;
      }
    }
    buf = buf.slice(start);
    if (buf.length > 50 * 1024 * 1024) throw new Error('ligne CSV anormalement longue');
  }
}
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const date = v => (/^\d{4}-\d{2}-\d{2}/.test(v || '') ? v.slice(0, 10) : null);
const dept = r => {
  const t = r.lieuExecution_typeCode || '', c = (r.lieuExecution_code || '').trim();
  if (/d[ée]partement/i.test(t) && /^(\d{2,3}|2A|2B)$/i.test(c)) return c.toUpperCase().padStart(2, '0');
  if (/(postal|commune)/i.test(t) && /^\d{5}$/.test(c)) return c.startsWith('97') ? c.slice(0, 3) : c.startsWith('20') ? (Number(c) < 20200 ? '2A' : '2B') : c.slice(0, 2);
  return r.acheteur_departement_code && /^(\d{2,3}|2A|2B)$/i.test(r.acheteur_departement_code) ? r.acheteur_departement_code.toUpperCase().padStart(2, '0') : null;
};

async function main() {
  await pool.query(`CREATE TABLE IF NOT EXISTS public_awards (
      uid TEXT NOT NULL, titulaire_id TEXT NOT NULL, acheteur_id TEXT, acheteur_nom TEXT, acheteur_categorie TEXT, acheteur_departement TEXT,
      titulaire_nom TEXT, titulaire_categorie TEXT, titulaire_naf TEXT, titulaire_labels TEXT, titulaire_departement TEXT, titulaire_distance_km INT,
      objet TEXT, type TEXT, cpv TEXT, procedure TEXT, montant NUMERIC, montant_rationalise NUMERIC, montant_anomalie TEXT, duree_mois INT,
      offres_recues INT, date_notification DATE, lieu_departement TEXT, sous_traitance BOOLEAN, groupement TEXT, source TEXT,
      imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (uid, titulaire_id))`);
  await pool.query(`CREATE INDEX IF NOT EXISTS public_awards_cpv_dept ON public_awards (left(cpv, 4), lieu_departement, date_notification DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS public_awards_acheteur ON public_awards (acheteur_id, date_notification DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS public_awards_titulaire ON public_awards (titulaire_id)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS public_awards_imports (id SERIAL PRIMARY KEY, started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), finished_at TIMESTAMPTZ, rows_read INT, rows_kept INT, error TEXT)`);
  const last = (await pool.query(`SELECT finished_at FROM public_awards_imports WHERE finished_at IS NOT NULL AND error IS NULL ORDER BY finished_at DESC LIMIT 1`)).rows[0];
  if (last && Date.now() - new Date(last.finished_at).getTime() < MIN_HOURS_BETWEEN_RUNS * 3600000 && process.env.DECP_FORCE !== 'true') {
    console.log(`[attributions] import récent (${new Date(last.finished_at).toISOString()}) : rien à faire`); return;
  }
  const run = (await pool.query(`INSERT INTO public_awards_imports DEFAULT VALUES RETURNING id`)).rows[0].id;
  let read = 0, kept = 0, batch = [];
  const flush = async () => {
    if (!batch.length) return;
    const rows = [...new Map(batch.map(b => [`${b.uid}|${b.titulaire_id}`, b])).values()];
    await pool.query(`INSERT INTO public_awards AS p (uid, titulaire_id, acheteur_id, acheteur_nom, acheteur_categorie, acheteur_departement, titulaire_nom, titulaire_categorie,
        titulaire_naf, titulaire_labels, titulaire_departement, titulaire_distance_km, objet, type, cpv, procedure, montant, montant_rationalise, montant_anomalie, duree_mois,
        offres_recues, date_notification, lieu_departement, sous_traitance, groupement, source, imported_at)
      SELECT x.uid, x.titulaire_id, x.acheteur_id, x.acheteur_nom, x.acheteur_categorie, x.acheteur_departement, x.titulaire_nom, x.titulaire_categorie, x.titulaire_naf,
        x.titulaire_labels, x.titulaire_departement, x.titulaire_distance_km, x.objet, x.type, x.cpv, x.procedure, x.montant, x.montant_rationalise, x.montant_anomalie,
        x.duree_mois, x.offres_recues, x.date_notification::date, x.lieu_departement, x.sous_traitance, x.groupement, x.source, NOW()
      FROM jsonb_to_recordset($1::jsonb) AS x(uid text, titulaire_id text, acheteur_id text, acheteur_nom text, acheteur_categorie text, acheteur_departement text,
        titulaire_nom text, titulaire_categorie text, titulaire_naf text, titulaire_labels text, titulaire_departement text, titulaire_distance_km int, objet text, type text,
        cpv text, procedure text, montant numeric, montant_rationalise numeric, montant_anomalie text, duree_mois int, offres_recues int, date_notification text,
        lieu_departement text, sous_traitance boolean, groupement text, source text)
      ON CONFLICT (uid, titulaire_id) DO UPDATE SET montant = EXCLUDED.montant, montant_rationalise = EXCLUDED.montant_rationalise, montant_anomalie = EXCLUDED.montant_anomalie,
        duree_mois = EXCLUDED.duree_mois, titulaire_categorie = EXCLUDED.titulaire_categorie, titulaire_labels = EXCLUDED.titulaire_labels, imported_at = NOW()`, [JSON.stringify(rows)]);
    kept += rows.length; batch = [];
  };
  try {
    const res = await fetch(URL, { signal: AbortSignal.timeout(2 * 3600 * 1000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const stream = Readable.fromWeb(res.body).pipe(zlib.createGunzip());
    for await (const r of csvRows(stream)) {
      read++;
      if (r.donneesActuelles !== 'true' && r.donneesActuelles !== 'True') continue;
      if (r.type !== 'Travaux' && r.type !== 'Services') continue;
      const dn = date(r.dateNotification); if (!dn || dn < SINCE) continue;
      const montant = num(r.montant); if (!montant || montant <= 0) continue;
      if (!r.uid || !r.titulaire_id) continue;
      batch.push({ uid: r.uid.slice(0, 200), titulaire_id: r.titulaire_id.slice(0, 30), acheteur_id: r.acheteur_id || null, acheteur_nom: (r.acheteur_nom || '').slice(0, 300) || null,
        acheteur_categorie: r.acheteur_categorie || null, acheteur_departement: r.acheteur_departement_code || null, titulaire_nom: (r.titulaire_nom || '').slice(0, 300) || null,
        titulaire_categorie: r.titulaire_categorie || null, titulaire_naf: r.titulaire_activite_code || null, titulaire_labels: (r.titulaire_labels || '').slice(0, 200) || null,
        titulaire_departement: r.titulaire_departement_code || null, titulaire_distance_km: num(r.titulaire_distance), objet: (r.objet || '').slice(0, 1000) || null, type: r.type,
        cpv: (r.codeCPV || '').slice(0, 10) || null, procedure: r.procedure || null, montant, montant_rationalise: num(r.montant_rationalise) ?? montant,
        montant_anomalie: r.montant_anomalie || null, duree_mois: num(r.dureeMois), offres_recues: num(r.offresRecues), date_notification: dn, lieu_departement: dept(r),
        sous_traitance: r.sousTraitanceDeclaree === 'true' ? true : r.sousTraitanceDeclaree === 'false' ? false : null, groupement: r.typeGroupementOperateurs || null,
        source: (r.sourceDataset || '').slice(0, 60) || null });
      if (batch.length >= 1000) await flush();
      if (read % 500000 === 0) console.log(`[attributions] ${read} lignes lues, ${kept} gardées`);
    }
    await flush();
    await pool.query(`UPDATE public_awards_imports SET finished_at = NOW(), rows_read = $2, rows_kept = $3 WHERE id = $1`, [run, read, kept]);
    console.log(`[attributions] ${read} lignes lues, ${kept} attributions (travaux et services depuis ${SINCE}) importées`);
  } catch (e) {
    await pool.query(`UPDATE public_awards_imports SET finished_at = NOW(), rows_read = $2, rows_kept = $3, error = $4 WHERE id = $1`, [run, read, kept, String(e.message || e).slice(0, 500)]).catch(() => {});
    throw e;
  }
}
main().catch(e => { console.error('[attributions] import en échec :', e.message); process.exitCode = 1; }).finally(() => pool.end());
