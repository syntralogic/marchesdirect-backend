// Part 8 - export verification on representative records: the CSV and the Excel file are produced
// from the same column definition, so every cell must say the same thing in both.
import { PassThrough } from 'stream';
import ExcelJS from 'exceljs';

jest.mock('../../config/database', () => ({ db: { query: jest.fn() } }));

import { EXPORT_COLUMNS, EXPORT_HEADERS, COLUMN_NOTES, writeCsv, writeXlsx, csvField, describeFilters } from '../prospectExport';

const now = '2026-10-01T00:00:00.000Z';
const full = {
  siret: '01234567890123', siren: '012345678', is_head_office: true, company_name: 'Société Éclair & Fils', trading_name: 'Éclair Élec',
  legal_form_code: '5710', legal_form_label: 'SAS', status: 'active', creation_date_txt: '2012-03-05', closure_date_txt: null,
  naf_code: '4321A', activity_label: 'Travaux d’installation électrique', profession: 'electricien', is_artisan: true,
  address_line: '12 rue de l’Église', postal_code: '01000', city: 'Bourg-en-Bresse', department: '01', region: 'Auvergne-Rhône-Alpes',
  latitude: '46.2051', longitude: '5.2255', phone: '04 72 00 11 22', email: 'contact@eclair-elec.fr', website: 'https://eclair-elec.fr',
  facebook_url: 'https://www.facebook.com/eclair.elec', instagram_url: null, linkedin_url: 'https://www.linkedin.com/company/eclair/',
  directors: [{ name: 'Hélène Dupont', role: 'Gérante' }, { name: 'Jean Martin', role: 'Président' }], employee_range: '10 à 19 salariés',
  revenue_eur: '1250000.00', revenue_year: 2024, net_result_eur: '-12000.50', certifications: ['RGE (Reconnu Garant de l’Environnement)', 'Qualiopi'],
  history: [{ date: '2012-03-05', event: 'Création de l’entreprise' }], google_maps_url: 'https://maps.google.com/?cid=123',
  google_rating: '4.6', google_review_count: 128, google_positive_review_count: null, google_positive_review_pct: null,
  google_match_confidence: '0.930', google_fetched_txt: '2026-09-30', google_place_id: 'ChIJabc', source_updated_txt: '2026-09-29',
  field_meta: {
    company_name: { status: 'confirmed', source: 'sirene', at: now }, phone: { status: 'confirmed', source: 'google_places', at: now },
    google_profile: { status: 'confirmed', source: 'google_places', at: now }, facebook_url: { status: 'confirmed', source: 'company_website', at: now },
    instagram_url: { status: 'confirmed_missing', source: 'company_website', at: now }, google_rating: { status: 'confirmed', source: 'google_places', at: now },
  },
};
const sparse = {
  siret: '98765432100019', siren: '987654321', is_head_office: false, company_name: '=Plomberie Test', status: 'closed', closure_date_txt: '2020-12-31',
  creation_date_txt: '2001-01-01', profession: 'plombier', directors: [], certifications: [], history: [],
  field_meta: { revenue: { status: 'confirmed_missing', source: 'sirene', at: now, note: 'chiffre d’affaires non publié' }, google_profile: { status: 'unavailable', note: 'clé Google absente' } },
};
const rows = [full, sparse];

const collect = async (fn: (s: PassThrough) => Promise<unknown>) => {
  const s = new PassThrough(); const chunks: Buffer[] = [];
  s.on('data', c => chunks.push(Buffer.from(c)));
  const done = new Promise<void>(r => s.on('end', () => r()));
  await fn(s); s.end(); await done;
  return Buffer.concat(chunks);
};

function parseCsv(text: string): string[][] {
  const out: string[][] = []; let row: string[] = []; let cur = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ';') { row.push(cur); cur = ''; }
    else if (ch === '\r') { /* skip */ }
    else if (ch === '\n') { row.push(cur); out.push(row); row = []; cur = ''; }
    else cur += ch;
  }
  return out;
}

describe('part 8 export - CSV and Excel from representative records', () => {
  let csv: string[][]; let rawCsv: string; let wb: ExcelJS.Workbook; let xlsxCount: number;

  beforeAll(async () => {
    const lines: string[] = [];
    await writeCsv(c => { lines.push(c); }, rows);
    rawCsv = lines.join('');
    csv = parseCsv(rawCsv.replace(/^\uFEFF/, ''));
    const buf = await collect(async s => { xlsxCount = await writeXlsx(s, rows, { status: 'active', region: 'Auvergne-Rhône-Alpes', profession: 'electricien' } as any); });
    wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf as any);
  });

  it('CSV starts with a UTF-8 BOM, uses the exact header row and has one line per record', () => {
    expect(rawCsv.charCodeAt(0)).toBe(0xFEFF);
    expect(csv[0]).toEqual(EXPORT_HEADERS);
    expect(csv).toHaveLength(1 + rows.length);
    for (const line of csv) expect(line).toHaveLength(EXPORT_COLUMNS.length);
  });

  it('keeps French characters intact in both formats', () => {
    const iName = EXPORT_HEADERS.indexOf('Dénomination');
    expect(csv[1][iName]).toBe('Société Éclair & Fils');
    expect(wb.getWorksheet('Entreprises')!.getRow(2).getCell(iName + 1).value).toBe('Société Éclair & Fils');
    expect(csv[1][EXPORT_HEADERS.indexOf('Adresse')]).toBe('12 rue de l’Église');
  });

  it('every cell says the same thing in the CSV and in the Excel file', () => {
    const ws = wb.getWorksheet('Entreprises')!;
    expect(ws.rowCount).toBe(1 + rows.length);
    expect(xlsxCount).toBe(rows.length);
    rows.forEach((_, ri) => EXPORT_COLUMNS.forEach((c, ci) => {
      const cv = csv[ri + 1][ci]; let xv: any = ws.getRow(ri + 2).getCell(ci + 1).value;
      if (xv && typeof xv === 'object' && 'hyperlink' in xv) xv = xv.text;
      if (xv instanceof Date) xv = xv.toISOString().slice(0, 10);
      if (xv === null || xv === undefined) { expect([c.header, cv]).toEqual([c.header, '']); return; }
      if (c.kind === 'number' || c.kind === 'money' || c.kind === 'integer') expect([c.header, Number(cv.replace(',', '.'))]).toEqual([c.header, Number(xv)]);
      else if (c.kind === 'id') expect([c.header, cv.replace(/^="|"$/g, '')]).toEqual([c.header, String(xv)]);
      else expect([c.header, cv]).toEqual([c.header, String(xv)]);
    }));
  });

  it('identifiers keep leading zeros (SIRET, code postal, département, téléphone)', () => {
    const ws = wb.getWorksheet('Entreprises')!;
    for (const [h, v] of [['SIRET', '01234567890123'], ['Code postal', '01000'], ['Département', '01'], ['Téléphone', '04 72 00 11 22']]) {
      const i = EXPORT_HEADERS.indexOf(h);
      expect(csv[1][i]).toBe(`="${v}"`);
      expect(ws.getRow(2).getCell(i + 1).value).toBe(v);
    }
  });

  it('requested prospecting fields are populated: Facebook, Google link, rating, review count, directors, certifications', () => {
    const get = (h: string) => csv[1][EXPORT_HEADERS.indexOf(h)];
    expect(get('Page Facebook')).toBe('https://www.facebook.com/eclair.elec');
    expect(get('Lien Google Business Profile / Maps')).toBe('https://maps.google.com/?cid=123');
    expect(get('Note Google (/5)')).toBe('4,6');
    expect(get('Nombre total d’avis Google')).toBe('128');
    expect(get('Dirigeants / représentants légaux')).toBe('Hélène Dupont (Gérante) ; Jean Martin (Président)');
    expect(get('Certifications')).toContain('Qualiopi');
    expect(get('Résultat net (€)')).toBe('-12000,5');
    const link: any = wb.getWorksheet('Entreprises')!.getRow(2).getCell(EXPORT_HEADERS.indexOf('Page Facebook') + 1).value;
    expect(link.hyperlink).toBe('https://www.facebook.com/eclair.elec');
  });

  it('empty values stay empty and are explained, never invented', () => {
    const miss = csv[2][EXPORT_HEADERS.indexOf('Champs non renseignés (statut)')];
    expect(miss).toContain('Chiffre d’affaires (€) : absent, confirmé (SIRENE (INSEE)) – chiffre d’affaires non publié');
    expect(miss).toContain('Lien Google Business Profile / Maps : indisponible – clé Google absente');
    expect(miss).toContain('Avis Google positifs (%) : indisponible');
    expect(csv[2][EXPORT_HEADERS.indexOf('Note Google (/5)')]).toBe('');
    expect(csv[2][EXPORT_HEADERS.indexOf('Statut')]).toBe('Cessé');
    expect(csv[1][EXPORT_HEADERS.indexOf('Avis Google positifs (%)')]).toBe('');
  });

  it('formula-looking text is neutralised in both formats', () => {
    const i = EXPORT_HEADERS.indexOf('Dénomination');
    expect(csv[2][i]).toBe("'=Plomberie Test");
    expect(wb.getWorksheet('Entreprises')!.getRow(3).getCell(i + 1).value).toBe("'=Plomberie Test");
  });

  it('Excel carries a Légende sheet with count, filters, every column and the provider limits', () => {
    const lg = wb.getWorksheet('Légende')!;
    const text = lg.getSheetValues().flat().filter(Boolean).map(String).join('\n');
    expect(text).toContain('Nombre de lignes');
    expect(text).toContain('métier : ');
    expect(text).toContain('région : Auvergne-Rhône-Alpes');
    for (const h of EXPORT_HEADERS) expect(text).toContain(h);
    expect(text).toContain('Avis Google positifs (nombre)');
    expect(text).toMatch(/fournisseur/i);
  });

  it('every export column is documented in the column dictionary', () => {
    for (const c of EXPORT_COLUMNS) { expect(COLUMN_NOTES[c.key]?.desc).toBeTruthy(); expect(COLUMN_NOTES[c.key]?.source).toBeTruthy(); }
  });

  it('describeFilters and csvField edge cases', () => {
    expect(describeFilters({ status: 'all', hasFacebook: true, minRating: 4 } as any)).toBe('statut : tous ; avec page Facebook ; note Google ≥ 4');
    expect(csvField('01000', 'id')).toBe('"=""01000"""');
    expect(csvField('bad;"value', 'id')).toBe('"bad;""value"');
  });
});
