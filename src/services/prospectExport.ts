import type { Response } from 'express';
import ExcelJS from 'exceljs';
import { db } from '../config/database';
import { buildWhere, ProspectFilters } from './prospectService';
import { PROFESSIONS } from '../utils/prospectNaf';
import { PROVIDERS } from './prospectProviders';

// One definition drives the table view, the CSV and the Excel file, so the three can
// never disagree and no requested field can be silently omitted from one of them.

type Kind = 'text' | 'id' | 'number' | 'integer' | 'date' | 'url' | 'money';
export interface ExportColumn { key: string; header: string; kind: Kind; width: number; get: (r: any) => unknown }

const yesNo = (v: boolean | null | undefined) => (v === true ? 'Oui' : v === false ? 'Non' : '');
const nz = (v: unknown) => (v === null || v === undefined || v === '' ? null : v);
const numOrNull = (v: unknown) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };

export const SOURCE_LABEL: Record<string, string> = { sirene: 'SIRENE (INSEE)', google_places: 'Google Places', company_website: 'Site de l\u2019entreprise' };

// column header -> field_meta key used for provenance / status
const META_KEY: Record<string, string> = {
  'Téléphone': 'phone', 'E-mail professionnel': 'email', 'Site web': 'website',
  'Page Facebook': 'facebook_url', 'Instagram': 'instagram_url', 'LinkedIn': 'linkedin_url',
  'Dirigeants / représentants légaux': 'directors', 'Effectif (tranche)': 'employee_range',
  'Chiffre d\u2019affaires (€)': 'revenue', 'Certifications': 'certifications', 'Historique': 'history',
  'Résultat net (€)': 'revenue', 'Année du CA': 'revenue',
  'Lien Google Business Profile / Maps': 'google_profile', 'Note Google (/5)': 'google_rating',
  'Nombre total d\u2019avis Google': 'google_review_count',
  'Avis Google positifs (nombre)': 'google_positive_reviews', 'Avis Google positifs (%)': 'google_positive_reviews',
};

export function describeStatus(meta: any): string {
  if (!meta) return 'non vérifié';
  const src = meta.source ? SOURCE_LABEL[meta.source] || meta.source : '';
  switch (meta.status) {
    case 'confirmed_missing': return `absent, confirmé${src ? ` (${src})` : ''}${meta.note ? ` – ${meta.note}` : ''}`;
    case 'unavailable': return `indisponible${meta.note ? ` – ${meta.note}` : ''}`;
    case 'error': return 'erreur de collecte (à relancer)';
    case 'confirmed': return 'confirmé';
    default: return 'non vérifié';
  }
}

const directorsText = (r: any) => (Array.isArray(r.directors) ? r.directors : []).map((d: any) => d.role ? `${d.name} (${d.role})` : d.name).join(' ; ');
const historyText = (r: any) => (Array.isArray(r.history) ? r.history : []).map((h: any) => `${h.date ? h.date + ' : ' : ''}${h.event}`).join(' ; ');

export const EXPORT_COLUMNS: ExportColumn[] = [
  { key: 'siret', header: 'SIRET', kind: 'id', width: 16, get: r => r.siret },
  { key: 'siren', header: 'SIREN', kind: 'id', width: 12, get: r => r.siren },
  { key: 'is_head_office', header: 'Siège social', kind: 'text', width: 10, get: r => yesNo(r.is_head_office) },
  { key: 'company_name', header: 'Dénomination', kind: 'text', width: 34, get: r => r.company_name },
  { key: 'trading_name', header: 'Nom commercial / sigle', kind: 'text', width: 24, get: r => nz(r.trading_name) },
  { key: 'legal_form_code', header: 'Forme juridique (code)', kind: 'text', width: 12, get: r => nz(r.legal_form_code) },
  { key: 'legal_form_label', header: 'Forme juridique', kind: 'text', width: 22, get: r => nz(r.legal_form_label) },
  { key: 'status', header: 'Statut', kind: 'text', width: 10, get: r => (r.status === 'closed' ? 'Cessé' : 'Actif') },
  { key: 'creation_date', header: 'Date de création', kind: 'date', width: 14, get: r => nz(r.creation_date_txt) },
  { key: 'closure_date', header: 'Date de cessation', kind: 'date', width: 14, get: r => nz(r.closure_date_txt) },
  { key: 'naf_code', header: 'Code NAF', kind: 'text', width: 9, get: r => nz(r.naf_code) },
  { key: 'activity_label', header: 'Activité (libellé NAF)', kind: 'text', width: 36, get: r => nz(r.activity_label) },
  { key: 'profession', header: 'Métier', kind: 'text', width: 28, get: r => PROFESSIONS[r.profession] || r.profession },
  { key: 'is_artisan', header: 'Artisan (registre)', kind: 'text', width: 12, get: r => yesNo(r.is_artisan) },
  { key: 'address_line', header: 'Adresse', kind: 'text', width: 38, get: r => nz(r.address_line) },
  { key: 'postal_code', header: 'Code postal', kind: 'id', width: 10, get: r => nz(r.postal_code) },
  { key: 'city', header: 'Ville', kind: 'text', width: 20, get: r => nz(r.city) },
  { key: 'department', header: 'Département', kind: 'id', width: 11, get: r => nz(r.department) },
  { key: 'region', header: 'Région', kind: 'text', width: 24, get: r => nz(r.region) },
  { key: 'latitude', header: 'Latitude', kind: 'number', width: 11, get: r => numOrNull(r.latitude) },
  { key: 'longitude', header: 'Longitude', kind: 'number', width: 11, get: r => numOrNull(r.longitude) },
  { key: 'phone', header: 'Téléphone', kind: 'id', width: 16, get: r => nz(r.phone) },
  { key: 'email', header: 'E-mail professionnel', kind: 'text', width: 28, get: r => nz(r.email) },
  { key: 'website', header: 'Site web', kind: 'url', width: 30, get: r => nz(r.website) },
  { key: 'facebook_url', header: 'Page Facebook', kind: 'url', width: 34, get: r => nz(r.facebook_url) },
  { key: 'instagram_url', header: 'Instagram', kind: 'url', width: 30, get: r => nz(r.instagram_url) },
  { key: 'linkedin_url', header: 'LinkedIn', kind: 'url', width: 30, get: r => nz(r.linkedin_url) },
  { key: 'directors', header: 'Dirigeants / représentants légaux', kind: 'text', width: 40, get: r => nz(directorsText(r)) },
  { key: 'employee_range', header: 'Effectif (tranche)', kind: 'text', width: 20, get: r => nz(r.employee_range) },
  { key: 'revenue_eur', header: 'Chiffre d\u2019affaires (€)', kind: 'money', width: 16, get: r => numOrNull(r.revenue_eur) },
  { key: 'revenue_year', header: 'Année du CA', kind: 'integer', width: 10, get: r => numOrNull(r.revenue_year) },
  { key: 'net_result_eur', header: 'Résultat net (€)', kind: 'money', width: 16, get: r => numOrNull(r.net_result_eur) },
  { key: 'certifications', header: 'Certifications', kind: 'text', width: 34, get: r => nz((Array.isArray(r.certifications) ? r.certifications : []).join(' ; ')) },
  { key: 'history', header: 'Historique', kind: 'text', width: 44, get: r => nz(historyText(r)) },
  { key: 'google_maps_url', header: 'Lien Google Business Profile / Maps', kind: 'url', width: 40, get: r => nz(r.google_maps_url) },
  { key: 'google_rating', header: 'Note Google (/5)', kind: 'number', width: 10, get: r => numOrNull(r.google_rating) },
  { key: 'google_review_count', header: 'Nombre total d\u2019avis Google', kind: 'integer', width: 12, get: r => numOrNull(r.google_review_count) },
  { key: 'google_positive_review_count', header: 'Avis Google positifs (nombre)', kind: 'integer', width: 14, get: r => numOrNull(r.google_positive_review_count) },
  { key: 'google_positive_review_pct', header: 'Avis Google positifs (%)', kind: 'number', width: 12, get: r => numOrNull(r.google_positive_review_pct) },
  { key: 'google_match_confidence', header: 'Confiance du rapprochement Google', kind: 'number', width: 14, get: r => numOrNull(r.google_match_confidence) },
  { key: 'google_fetched_at', header: 'Date du relevé Google', kind: 'date', width: 14, get: r => nz(r.google_fetched_txt) },
  { key: 'google_place_id', header: 'Google Place ID', kind: 'text', width: 30, get: r => nz(r.google_place_id) },
  {
    key: 'sources', header: 'Sources des champs', kind: 'text', width: 60, get: r => {
      const meta = r.field_meta || {};
      const parts: string[] = [];
      const basic = meta.company_name?.source ? SOURCE_LABEL[meta.company_name.source] : null;
      if (basic) parts.push(`Identité, adresse, NAF, dates, forme juridique : ${basic}`);
      for (const [header, mk] of Object.entries(META_KEY)) {
        const m = meta[mk];
        if (m?.status === 'confirmed' && m.source) parts.push(`${header} : ${SOURCE_LABEL[m.source] || m.source}${m.at ? ` (${String(m.at).slice(0, 10)})` : ''}`);
      }
      return nz([...new Set(parts)].join(' | '));
    },
  },
  {
    key: 'missing', header: 'Champs non renseignés (statut)', kind: 'text', width: 70, get: r => {
      const meta = r.field_meta || {};
      const parts: string[] = [];
      const seen = new Set<string>();
      for (const col of EXPORT_COLUMNS) {
        const mk = META_KEY[col.header];
        if (!mk || seen.has(col.header)) continue;
        seen.add(col.header);
        if (nz(col.get(r)) !== null) continue;
        let m = meta[mk];
        if (!m && mk === 'google_positive_reviews') m = { status: 'unavailable', note: 'l\u2019API Google ne fournit pas ce détail (fournisseur d\u2019avis sous licence requis)' };
        parts.push(`${col.header} : ${describeStatus(m)}`);
      }
      return nz(parts.join(' | '));
    },
  },
  { key: 'source_updated_at', header: 'Dernière mise à jour du registre', kind: 'date', width: 16, get: r => nz(r.source_updated_txt) },
];

export const EXPORT_HEADERS = EXPORT_COLUMNS.map(c => c.header);

// ---------------------------------------------------------------------------
// CSV: UTF-8 with BOM (accents open correctly in Excel), ";" separator and decimal comma
// (French Excel), CRLF; identifier columns are written as ="…" so Excel keeps leading zeros. Text cells are always quoted; real numbers are not, so a negative
// result is never mistaken for a formula; text starting with = + - @ is neutralised.
// ---------------------------------------------------------------------------
export function csvField(v: unknown, kind: Kind): string {
  if (v === null || v === undefined || v === '') return '';
  if (kind === 'number' || kind === 'money' || kind === 'integer') {
    const n = Number(v);
    return Number.isFinite(n) ? String(n).replace('.', ',') : '';
  }
  if (kind === 'id') {
    // Identifiers (SIRET, SIREN, code postal, département, téléphone) must keep their leading zeros
    // and never turn into 1,23457E+13 when the CSV is opened in Excel: emit ="value" (safe charset only).
    const t = String(v).trim();
    if (/^[0-9A-Za-z .]{1,30}$/.test(t)) return `"=""${t}"""`;   // RFC-4180 quoting of ="value"
  }
  let t = String(v).replace(/\r?\n/g, ' ');
  if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`;
  return `"${t.replace(/"/g, '""')}"`;
}
export const csvHeaderLine = () => EXPORT_COLUMNS.map(c => `"${c.header.replace(/"/g, '""')}"`).join(';');
export const csvLine = (r: any) => EXPORT_COLUMNS.map(c => csvField(c.get(r), c.kind)).join(';');

const SELECT = `SELECT *, creation_date::text AS creation_date_txt, closure_date::text AS closure_date_txt,
  to_char(google_fetched_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS google_fetched_txt,
  to_char(source_updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS source_updated_txt
  FROM prospect_companies`;

/** Keyset-paginated reader: constant memory whatever the export size. */
export async function* iterateRows(f: ProspectFilters, batch = 1000): AsyncGenerator<any> {
  const { where, params } = buildWhere(f);
  let lastId = 0;
  for (;;) {
    const p = [...params, lastId];
    const cond = where ? `${where} AND id > $${p.length}` : `WHERE id > $${p.length}`;
    const rows = (await db.query(`${SELECT} ${cond} ORDER BY id LIMIT ${batch}`, p)).rows;
    if (!rows.length) return;
    for (const r of rows) yield r;
    lastId = rows[rows.length - 1].id;
  }
}

export async function countRows(f: ProspectFilters): Promise<number> {
  const { where, params } = buildWhere(f);
  return (await db.query(`SELECT COUNT(*)::int AS n FROM prospect_companies ${where}`, params)).rows[0].n;
}

// ---------------------------------------------------------------------------
// Column dictionary (feeds the "Légende" sheet of the Excel file and the tests: every export
// column must be documented, so no field can appear without its meaning and source).
// ---------------------------------------------------------------------------
const SIRENE = 'SIRENE (INSEE, data.gouv.fr)';
export const COLUMN_NOTES: Record<string, { desc: string; source: string }> = {
  siret: { desc: 'Identifiant de l’établissement (14 chiffres). Clé unique : un SIRET n’apparaît qu’une fois.', source: SIRENE },
  siren: { desc: 'Identifiant de l’entreprise (9 chiffres), commun à tous ses établissements.', source: SIRENE },
  is_head_office: { desc: 'Oui si l’établissement est le siège social.', source: SIRENE },
  company_name: { desc: 'Dénomination légale.', source: SIRENE },
  trading_name: { desc: 'Nom commercial ou sigle, s’il est déclaré.', source: SIRENE },
  legal_form_code: { desc: 'Code INSEE de la catégorie juridique.', source: SIRENE },
  legal_form_label: { desc: 'Libellé de la forme juridique (SARL, SAS, EI…).', source: SIRENE },
  status: { desc: 'Actif ou Cessé (état administratif de l’établissement).', source: SIRENE },
  creation_date: { desc: 'Date de création (JJ/MM/AAAA dans Excel, AAAA-MM-JJ dans le CSV).', source: SIRENE },
  closure_date: { desc: 'Date de cessation, vide si l’établissement est actif.', source: SIRENE },
  naf_code: { desc: 'Code APE/NAF de l’activité principale.', source: SIRENE },
  activity_label: { desc: 'Libellé de l’activité principale (NAF).', source: SIRENE },
  profession: { desc: 'Métier de prospection déduit du code NAF (table interne), pas une donnée déclarée par l’entreprise.', source: 'Plateforme (règle NAF → métier)' },
  is_artisan: { desc: 'Oui si l’entreprise est inscrite au répertoire des métiers.', source: SIRENE },
  address_line: { desc: 'Numéro, voie et complément d’adresse.', source: SIRENE },
  postal_code: { desc: 'Code postal (zéros initiaux conservés).', source: SIRENE },
  city: { desc: 'Commune.', source: SIRENE },
  department: { desc: 'Code département.', source: SIRENE },
  region: { desc: 'Région, déduite du département.', source: 'Plateforme (table département → région)' },
  latitude: { desc: 'Latitude de l’adresse (WGS84).', source: SIRENE },
  longitude: { desc: 'Longitude de l’adresse (WGS84).', source: SIRENE },
  phone: { desc: 'Téléphone professionnel, uniquement s’il est publié par Google ou par l’entreprise sur son site.', source: 'Google Places / site de l’entreprise' },
  email: { desc: 'E-mail professionnel, uniquement s’il est publié sur le site de l’entreprise (jamais deviné).', source: 'Site de l’entreprise' },
  website: { desc: 'Site web de l’entreprise.', source: 'Google Places / SIRENE' },
  facebook_url: { desc: 'Page Facebook publiée par l’entreprise sur son site.', source: 'Site de l’entreprise' },
  instagram_url: { desc: 'Compte Instagram publié par l’entreprise sur son site.', source: 'Site de l’entreprise' },
  linkedin_url: { desc: 'Page LinkedIn publiée par l’entreprise sur son site.', source: 'Site de l’entreprise' },
  directors: { desc: 'Dirigeants / représentants légaux (nom et fonction), rattachés au siège.', source: SIRENE },
  employee_range: { desc: 'Tranche d’effectif salarié (pas un nombre exact).', source: SIRENE },
  revenue_eur: { desc: 'Chiffre d’affaires du dernier exercice publié, en euros.', source: SIRENE },
  revenue_year: { desc: 'Année de l’exercice du chiffre d’affaires.', source: SIRENE },
  net_result_eur: { desc: 'Résultat net du dernier exercice publié, en euros.', source: SIRENE },
  certifications: { desc: 'Certifications publiques connues : RGE, Qualiopi, bio, ESS, organisme de formation. Ne couvre pas les autres labels.', source: SIRENE },
  history: { desc: 'Événements du registre (création, ouverture, cessation, nombre d’établissements). BODACC/INPI non intégrés.', source: SIRENE },
  google_maps_url: { desc: 'Lien vers la fiche Google (Business Profile / Maps).', source: 'Google Places' },
  google_rating: { desc: 'Note moyenne Google sur 5.', source: 'Google Places' },
  google_review_count: { desc: 'Nombre total d’avis Google.', source: 'Google Places' },
  google_positive_review_count: { desc: 'Nombre d’avis positifs. Non fourni par Google Places : reste vide tant qu’aucun fournisseur d’avis sous licence n’est branché.', source: 'Non intégré (fournisseur sous licence requis)' },
  google_positive_review_pct: { desc: 'Part d’avis positifs en %. Même limite que la colonne précédente, jamais estimée.', source: 'Non intégré (fournisseur sous licence requis)' },
  google_match_confidence: { desc: 'Score de 0 à 1 du rapprochement entreprise ↔ fiche Google ; vérifier les scores faibles.', source: 'Plateforme' },
  google_fetched_at: { desc: 'Date du dernier relevé Google.', source: 'Google Places' },
  google_place_id: { desc: 'Identifiant de la fiche Google (sert aux rafraîchissements).', source: 'Google Places' },
  sources: { desc: 'Source de chaque champ renseigné.', source: 'Plateforme' },
  missing: { desc: 'Pour chaque champ vide : absent confirmé par la source, indisponible, erreur de collecte ou non vérifié.', source: 'Plateforme' },
  source_updated_at: { desc: 'Date de dernière mise à jour de la ligne depuis le registre.', source: SIRENE },
};

export function describeFilters(f: ProspectFilters): string {
  const parts: string[] = [];
  if (f.q) parts.push(`recherche « ${f.q} »`);
  if (f.profession) parts.push(`métier : ${PROFESSIONS[f.profession] || f.profession}`);
  if (f.region) parts.push(`région : ${f.region}`);
  if (f.department) parts.push(`département : ${f.department}`);
  if (f.city) parts.push(`ville : ${f.city}`);
  if (f.postalCode) parts.push(`code postal : ${f.postalCode}`);
  parts.push(`statut : ${f.status === 'closed' ? 'cessés' : f.status === 'all' ? 'tous' : 'actifs'}`);
  if (f.hasGoogle) parts.push('avec fiche Google');
  if (f.hasFacebook) parts.push('avec page Facebook');
  if (f.hasPhone) parts.push('avec téléphone');
  if (f.hasEmail) parts.push('avec e-mail');
  if (f.hasWebsite) parts.push('avec site web');
  if (f.minRating !== undefined) parts.push(`note Google ≥ ${f.minRating}`);
  return parts.join(' ; ');
}

type RowSource = AsyncIterable<any> | Iterable<any>;

/** Writes the CSV (BOM + header + rows) through `write`; returns the number of data rows. */
export async function writeCsv(write: (chunk: string) => void, rows: RowSource): Promise<number> {
  write('\uFEFF' + csvHeaderLine() + '\r\n');
  let n = 0;
  for await (const r of rows) { write(csvLine(r) + '\r\n'); n++; }
  return n;
}

export async function streamCsv(res: Response, f: ProspectFilters, filename: string): Promise<number> {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
  const n = await writeCsv(c => { res.write(c); }, iterateRows(f));
  res.end();
  return n;
}

export const XLSX_MAX_ROWS = 200_000;

/** Cell value for the Excel file: same source value as the CSV, but typed (dates, numbers, links). */
export function xlsxCellValue(c: ExportColumn, r: any): unknown {
  const v = c.get(r);
  if (v === null || v === undefined || v === '') return null;
  if (c.kind === 'url') return { text: String(v), hyperlink: String(v) };
  if (c.kind === 'date') { const d = new Date(`${String(v).slice(0, 10)}T00:00:00Z`); return Number.isNaN(d.getTime()) ? String(v) : d; }
  if (c.kind === 'number' || c.kind === 'money' || c.kind === 'integer') return Number(v);
  const s = String(v);
  return /^[=+\-@]/.test(s) ? `'${s}` : s;   // formula-injection guard
}

/** Writes the workbook (sheet "Entreprises" + sheet "Légende") to any writable stream. */
export async function writeXlsx(stream: NodeJS.WritableStream, rows: RowSource, f: ProspectFilters): Promise<number> {
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: stream as any, useStyles: true, useSharedStrings: false });
  const ws = wb.addWorksheet('Entreprises', { views: [{ state: 'frozen', ySplit: 1, xSplit: 4 }] });
  ws.columns = EXPORT_COLUMNS.map(c => ({ header: c.header, key: c.key, width: c.width }));
  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B2A4A' } };
  head.alignment = { vertical: 'middle', wrapText: true };
  head.commit();
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: EXPORT_COLUMNS.length } };

  let n = 0;
  for await (const r of rows) {
    const row = ws.addRow(EXPORT_COLUMNS.map(c => xlsxCellValue(c, r)) as any[]);
    EXPORT_COLUMNS.forEach((c, i) => {
      const cell = row.getCell(i + 1);
      if (c.kind === 'date') cell.numFmt = 'dd/mm/yyyy';
      else if (c.kind === 'money') cell.numFmt = '#,##0';
      else if (c.kind === 'url' && cell.value) cell.font = { color: { argb: 'FF0563C1' }, underline: true };
      else if (c.kind === 'id') cell.numFmt = '@';
    });
    row.commit();
    n++;
  }
  ws.commit();

  // Legend: what was exported, what each column means and where it comes from, known limits.
  const lg = wb.addWorksheet('Légende');
  lg.columns = [{ width: 36 }, { width: 90 }, { width: 38 }];
  const bold = (row: ExcelJS.Row) => { row.font = { bold: true }; row.commit(); };
  const put = (a: string, b = '', c = '', isBold = false) => { const row = lg.addRow([a, b, c]); row.alignment = { vertical: 'top', wrapText: true }; if (isBold) bold(row); else row.commit(); };
  put('Export Marchés Direct – base entreprises', '', '', true);
  put('Date de l’export', new Date().toISOString().slice(0, 10));
  put('Nombre de lignes', String(n));
  put('Filtres appliqués', describeFilters(f));
  put('Cellule vide', 'Donnée non disponible. La colonne « Champs non renseignés (statut) » indique pourquoi : absent confirmé par la source, indisponible, erreur de collecte ou non vérifié. Aucune valeur n’est estimée ni inventée.');
  put('');
  put('Colonne', 'Description', 'Source', true);
  for (const c of EXPORT_COLUMNS) { const note = COLUMN_NOTES[c.key]; put(c.header, note?.desc || '', note?.source || ''); }
  put('');
  put('Champs nécessitant un autre fournisseur', '', '', true);
  for (const p of PROVIDERS.filter(p => p.state !== 'integrated')) put(p.fields.join(', '), p.note, p.provider);
  lg.commit();
  await wb.commit();
  return n;
}

export async function streamXlsx(res: Response, f: ProspectFilters, filename: string): Promise<number> {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}.xlsx"`);
  return writeXlsx(res, iterateRows(f), f);
}
