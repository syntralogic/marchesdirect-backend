/**
 * Real-PostgreSQL check of the prospect database (Part 6): dedup, provenance merge, filters/counts,
 * Google cost guard + enrichment (HTTP mocked), website enrichment (mocked), CSV + XLSX export round trip.
 * Skipped unless TEST_DATABASE_URL is set:  TEST_DATABASE_URL=... npx jest prospectDb.pg --forceExit
 */
import { Writable } from 'stream';
const URL_ = process.env.TEST_DATABASE_URL;
const d = URL_ ? describe : describe.skip;

jest.mock('axios');
jest.mock('../websiteEnrichmentService', () => ({
  ...jest.requireActual('../websiteEnrichmentService'),
  fetchWebsiteFindings: jest.fn(),
}));

class Sink extends Writable {
  chunks: Buffer[] = []; headers: Record<string, string> = {}; headersSent = false;
  _write(c: any, _e: any, cb: any) { this.chunks.push(Buffer.from(c)); cb(); }
  setHeader(k: string, v: string) { this.headers[k] = v; }
  get body() { return Buffer.concat(this.chunks); }
}

d('prospect database (real PostgreSQL)', () => {
  let db: any; let svc: any; let exp: any; let g: any; let web: any; let axios: any; let sirene: any;
  const rec = (siret: string, over: any = {}) => ({
    ...sirene.mapSireneResult({
      siren: siret.slice(0, 9), nom_complet: 'ENTREPRISE ' + siret, nature_juridique: '5710', activite_principale: '43.21A',
      date_creation: '2010-01-05', etat_administratif: 'A',
      siege: { siret, adresse: '1 RUE X 69003 LYON', code_postal: '69003', libelle_commune: 'LYON', departement: '69', latitude: '45.76', longitude: '4.85', activite_principale: '43.21A' },
    })[0], ...over,
  });

  beforeAll(async () => {
    process.env.DATABASE_URL = URL_; process.env.DB_SSL = 'false';
    const database = require('../../config/database'); db = database.db; await database.ensureSchema();
    svc = require('../prospectService'); exp = require('../prospectExport'); g = require('../googlePlacesService');
    web = require('../websiteEnrichmentService'); axios = require('axios'); sirene = require('../sireneClient');
    await svc.ensureProspectSchema();
  });
  beforeEach(async () => { await db.query('TRUNCATE prospect_companies, prospect_api_usage RESTART IDENTITY'); });

  it('dedups on SIRET and counts added/updated; distinct establishments of one SIREN stay distinct', async () => {
    const a = rec('11111111100011'); const b = rec('11111111100029', { is_head_office: false });
    expect(await svc.upsertProspects([a, b])).toEqual({ added: 2, updated: 0 });
    expect(await svc.upsertProspects([a, { ...b, city: 'VILLEURBANNE' }])).toEqual({ added: 0, updated: 2 });
    const n = (await db.query('SELECT COUNT(*)::int n, COUNT(DISTINCT siren)::int s FROM prospect_companies')).rows[0];
    expect(n).toEqual({ n: 2, s: 1 });
  });

  it('a registry re-import never wipes enriched fields or their provenance', async () => {
    await svc.upsertProspects([rec('22222222200011')]);
    await db.query(`UPDATE prospect_companies SET phone='04 72 00 11 22', facebook_url='https://www.facebook.com/x', google_rating=4.6, google_review_count=120,
      field_meta = field_meta || '{"phone":{"status":"confirmed","source":"google_places"}}'::jsonb`);
    await svc.upsertProspects([rec('22222222200011', { company_name: 'RENOMMEE' })]);
    const r = (await db.query('SELECT * FROM prospect_companies')).rows[0];
    expect(r.company_name).toBe('RENOMMEE'); expect(r.phone).toBe('04 72 00 11 22'); expect(r.facebook_url).toContain('facebook.com/x');
    expect(Number(r.google_rating)).toBe(4.6); expect(r.field_meta.phone.source).toBe('google_places'); expect(r.field_meta.company_name.source).toBe('sirene');
  });

  it('filters by profession, region, department, city (accent/case-insensitive) with exact counts', async () => {
    const mk = (siret: string, o: any) => rec(siret, o);
    await svc.upsertProspects([
      mk('33333333300011', { profession: 'electricite', department: '69', region: 'Auvergne-Rhône-Alpes', city: 'LYON' }),
      mk('33333333400011', { profession: 'plomberie_chauffage', department: '69', region: 'Auvergne-Rhône-Alpes', city: 'VILLEURBANNE' }),
      mk('33333333500011', { profession: 'electricite', department: '75', region: 'Île-de-France', city: 'PARIS' }),
      mk('33333333600011', { profession: 'electricite', department: '2A', region: 'Corse', city: 'AJACCIO' }),
      mk('33333333700011', { profession: 'electricite', department: '69', region: 'Auvergne-Rhône-Alpes', city: 'LYON', status: 'closed' }),
    ]);
    const t = async (f: any) => (await svc.searchProspects(f, 1, 50)).pagination.total;
    expect(await t({})).toBe(4);                                   // closed excluded by default
    expect(await t({ status: 'all' })).toBe(5);
    expect(await t({ profession: 'electricite' })).toBe(3);
    expect(await t({ region: 'Île-de-France' })).toBe(1);
    expect(await t({ department: '69' })).toBe(2);
    expect(await t({ department: '2a' })).toBe(1);
    expect(await t({ city: 'lyon' })).toBe(1);
    expect(await t({ city: 'Île' })).toBe(0);
    expect(await t({ profession: 'electricite', department: '69' })).toBe(1);
    expect(await t({ q: 'ENTREPRISE 333333335' })).toBe(1);
    const page = await svc.searchProspects({ profession: 'electricite' }, 2, 2);
    expect(page.results).toHaveLength(1); expect(page.pagination).toMatchObject({ total: 3, totalPages: 2 });
  });

  describe('Google Business Profile enrichment', () => {
    const OLD = { ...process.env };
    afterEach(() => { process.env = { ...OLD }; jest.clearAllMocks(); g.resetGoogleCircuit(); });

    it('makes NO call without key + approval + cap (cost guard)', async () => {
      await svc.upsertProspects([rec('44444444400011')]);
      delete process.env.GOOGLE_PLACES_API_KEY;
      await expect(svc.runGoogleEnrichment({ limit: 5 })).rejects.toThrow(/GOOGLE_PLACES_API_KEY/);
      process.env.GOOGLE_PLACES_API_KEY = 'k';
      await expect(svc.runGoogleEnrichment({ limit: 5 })).rejects.toThrow(/GOOGLE_PLACES_ENABLED/);
      process.env.GOOGLE_PLACES_ENABLED = 'true';
      await expect(svc.runGoogleEnrichment({ limit: 5 })).rejects.toThrow(/DAILY_CAP/);
      expect(axios.post).not.toHaveBeenCalled();
    });

    it('stores link, rating, count; marks positive reviews unavailable (never invented); respects daily cap', async () => {
      process.env.GOOGLE_PLACES_API_KEY = 'k'; process.env.GOOGLE_PLACES_ENABLED = 'true'; process.env.GOOGLE_PLACES_DAILY_CAP = '2';
      await svc.upsertProspects([rec('55555555500011', { company_name: 'ELECTRICITE MARTIN' }), rec('55555555600011', { company_name: 'AUTRE ENTREPRISE' }), rec('55555555700011', { company_name: 'TROISIEME' })]);
      axios.post.mockImplementation(async (_u: string, body: any) => ({ data: { places: [{
        id: 'pid-' + body.textQuery, displayName: { text: body.textQuery.split(' LYON')[0] }, location: { latitude: 45.7601, longitude: 4.8501 },
        rating: 4.6, userRatingCount: 87, googleMapsUri: 'https://maps.google.com/?cid=1', websiteUri: 'https://martin.example', nationalPhoneNumber: '04 72 00 11 22' }] } }));
      await svc.runGoogleEnrichment({ limit: 10 });
      expect(axios.post).toHaveBeenCalledTimes(2);                 // cap = 2, third never called
      expect(axios.post.mock.calls[0][2].headers['X-Goog-Api-Key']).toBe('k');
      const rows = (await db.query('SELECT * FROM prospect_companies WHERE google_fetched_at IS NOT NULL ORDER BY id')).rows;
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ google_maps_url: 'https://maps.google.com/?cid=1', google_review_count: 87, website: 'https://martin.example', phone: '04 72 00 11 22' });
      expect(Number(rows[0].google_rating)).toBe(4.6);
      expect(rows[0].google_positive_review_count).toBeNull(); expect(rows[0].google_positive_review_pct).toBeNull();
      expect(rows[0].field_meta.google_positive_reviews.status).toBe('unavailable');
      expect(rows[0].field_meta.google_rating).toMatchObject({ status: 'confirmed', source: 'google_places' });
      expect((await db.query('SELECT calls FROM prospect_api_usage')).rows[0].calls).toBe(2);
    });

    it('low-confidence match is rejected and recorded as confirmed-missing, not stored', async () => {
      process.env.GOOGLE_PLACES_API_KEY = 'k'; process.env.GOOGLE_PLACES_ENABLED = 'true'; process.env.GOOGLE_PLACES_DAILY_CAP = '5';
      await svc.upsertProspects([rec('66666666600011', { company_name: 'ELECTRICITE MARTIN' })]);
      axios.post.mockResolvedValue({ data: { places: [{ id: 'x', displayName: { text: 'Boulangerie Dupont' }, location: { latitude: 45.7601, longitude: 4.8501 }, rating: 5, userRatingCount: 3, googleMapsUri: 'https://maps.google.com/?cid=9' }] } });
      await svc.runGoogleEnrichment({ limit: 5 });
      const r = (await db.query('SELECT * FROM prospect_companies')).rows[0];
      expect(r.google_maps_url).toBeNull(); expect(r.google_rating).toBeNull(); expect(r.google_fetched_at).not.toBeNull();
      expect(r.field_meta.google_profile.status).toBe('confirmed_missing');
    });

    it('auth/quota error stops the run and stores nothing fabricated', async () => {
      process.env.GOOGLE_PLACES_API_KEY = 'k'; process.env.GOOGLE_PLACES_ENABLED = 'true'; process.env.GOOGLE_PLACES_DAILY_CAP = '5';
      await svc.upsertProspects([rec('77777777700011'), rec('77777777800011')]);
      axios.post.mockRejectedValue({ response: { status: 403, data: { error: { message: 'Places API has not been used in project' } } } });
      await svc.runGoogleEnrichment({ limit: 5 });
      expect(axios.post).toHaveBeenCalledTimes(1);
      expect(svc.getEnrichState().message).toMatch(/arrêté.*403/);
      expect((await db.query('SELECT COUNT(*)::int n FROM prospect_companies WHERE google_fetched_at IS NOT NULL')).rows[0].n).toBe(0);
    });

    it('website enrichment saves Facebook/Instagram/LinkedIn found on the company site, records absence as confirmed-missing', async () => {
      await svc.upsertProspects([rec('88888888800011'), rec('88888888900011')]);
      await db.query(`UPDATE prospect_companies SET website = 'https://' || siret || '.example'`);
      web.fetchWebsiteFindings.mockImplementation(async (u: string) => u.includes('888888888000')
        ? { facebook: 'https://www.facebook.com/martin', instagram: null, linkedin: null, phone: null, email: 'contact@martin.example' }
        : { facebook: null, instagram: null, linkedin: null, phone: null, email: null });
      await svc.runWebsiteEnrichment({ limit: 10 });
      const rows = (await db.query('SELECT * FROM prospect_companies ORDER BY siret')).rows;
      expect(rows[0].facebook_url).toBe('https://www.facebook.com/martin'); expect(rows[0].email).toBe('contact@martin.example');
      expect(rows[0].field_meta.facebook_url).toMatchObject({ status: 'confirmed', source: 'company_website' });
      expect(rows[1].facebook_url).toBeNull(); expect(rows[1].field_meta.facebook_url.status).toBe('confirmed_missing');
    });
  });

  it('CSV and XLSX exports match the database (accents, empties, numbers, links, provenance)', async () => {
    await svc.upsertProspects([rec('99999999900011', { company_name: 'SOCIÉTÉ « ÉCLAIR » & Fils; "SARL"', directors: [{ name: 'Hélène MARTIN', role: 'Gérante', kind: 'personne' }], net_result_eur: -1234.5, revenue_eur: 950000 }),
      rec('99999999900029')]);
    await db.query(`UPDATE prospect_companies SET facebook_url='https://www.facebook.com/eclair', google_maps_url='https://maps.google.com/?cid=7', google_rating=4.5, google_review_count=210, phone='04 72 00 11 22',
      google_fetched_at='2026-10-16T10:00:00Z', field_meta = field_meta || '{"facebook_url":{"status":"confirmed","source":"company_website","at":"2026-10-16T10:00:00Z"},"google_profile":{"status":"confirmed","source":"google_places","at":"2026-10-16T10:00:00Z"}}'::jsonb
      WHERE siret = '99999999900011'`);

    const csv = new Sink(); const n1 = await exp.streamCsv(csv, {}, 'x');
    const text = csv.body.toString('utf8');
    expect(n1).toBe(2); expect(text.charCodeAt(0)).toBe(0xFEFF);
    const lines = text.slice(1).trim().split('\r\n');
    expect(lines).toHaveLength(3);
    expect(lines[0].split(';')).toHaveLength(exp.EXPORT_COLUMNS.length);
    expect(text).toContain('SOCIÉTÉ « ÉCLAIR » & Fils; ""SARL""');           // accents + quote doubling + ';' inside quotes
    expect(text).toContain('Hélène MARTIN (Gérante)');
    expect(text).toContain('-1234,5'); expect(text).toContain('4,5'); expect(text).toContain('https://www.facebook.com/eclair');
    expect(text).toContain('Avis Google positifs (%) : indisponible');       // honest status for the unobtainable field
    expect(text).toContain('Page Facebook : non vérifié');                   // second row never checked
    expect(csv.headers['Content-Type']).toContain('utf-8');

    const x = new Sink(); const n2 = await exp.streamXlsx(x, {}, 'x');
    expect(n2).toBe(2);
    const ExcelJS = require('exceljs'); const wb = new ExcelJS.Workbook(); await wb.xlsx.load(x.body);
    const ws = wb.getWorksheet('Entreprises');
    expect(ws.rowCount).toBe(3);
    const headers = ws.getRow(1).values.slice(1);
    expect(headers).toEqual(exp.EXPORT_HEADERS);
    const col = (h: string) => headers.indexOf(h) + 1;
    const r2 = ws.getRow(2);
    expect(r2.getCell(col('Dénomination')).value).toBe('SOCIÉTÉ « ÉCLAIR » & Fils; "SARL"');
    expect(r2.getCell(col('Résultat net (€)')).value).toBe(-1234.5);
    expect(r2.getCell(col('Note Google (/5)')).value).toBe(4.5);
    expect(r2.getCell(col('Nombre total d’avis Google')).value).toBe(210);
    expect(r2.getCell(col('Page Facebook')).value.hyperlink).toBe('https://www.facebook.com/eclair');
    expect(r2.getCell(col('Lien Google Business Profile / Maps')).value.text).toBe('https://maps.google.com/?cid=7');
    expect(r2.getCell(col('SIRET')).value).toBe('99999999900011');             // text, no scientific notation
    expect(r2.getCell(col('Date de création')).value.toISOString().slice(0, 10)).toBe('2010-01-05');
    expect(ws.getRow(3).getCell(col('Note Google (/5)')).value).toBeNull();     // empty stays empty
  });

  it('filtered export only contains the filtered rows', async () => {
    await svc.upsertProspects([rec('10101010100011', { department: '69' }), rec('10101010200011', { department: '75' })]);
    const s = new Sink(); expect(await exp.streamCsv(s, { department: '75' }, 'x')).toBe(1);
    expect(await exp.countRows({ department: '69' })).toBe(1);
  });
});
