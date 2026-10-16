/**
 * Part 7 - Google integration against a REAL PostgreSQL (Google HTTP mocked, no network, no cost).
 *   TEST_DATABASE_URL=postgres://... npx jest googlePart7.pg --forceExit
 */
import { Writable } from 'stream';
const URL_ = process.env.TEST_DATABASE_URL;
const d = URL_ ? describe : describe.skip;

jest.mock('axios');

class Sink extends Writable {
  chunks: Buffer[] = []; headers: Record<string, string> = {}; headersSent = false;
  _write(c: any, _e: any, cb: any) { this.chunks.push(Buffer.from(c)); cb(); }
  setHeader(k: string, v: string) { this.headers[k] = v; }
  get body() { return Buffer.concat(this.chunks); }
}
const gerr = (status: number, message: string, reason = '') => ({ response: { status, data: { error: { code: status, message, details: reason ? [{ reason }] : [] } } } });

d('Part 7 Google integration (real PostgreSQL)', () => {
  let db: any; let svc: any; let exp: any; let g: any; let axios: any; let sirene: any; let presence: any;
  const OLD = { ...process.env };
  const rec = (siret: string, over: any = {}) => ({
    ...sirene.mapSireneResult({
      siren: siret.slice(0, 9), nom_complet: 'ENTREPRISE ' + siret, nature_juridique: '5710', activite_principale: '43.21A',
      date_creation: '2010-01-05', etat_administratif: 'A',
      siege: { siret, adresse: '1 RUE X 69003 LYON', code_postal: '69003', libelle_commune: 'LYON', departement: '69', latitude: '45.76', longitude: '4.85', activite_principale: '43.21A' },
    })[0], ...over,
  });
  const place = (body: any, over: any = {}) => ({ id: 'pid-' + body.textQuery, displayName: { text: body.textQuery.split(' LYON')[0] }, location: { latitude: 45.7601, longitude: 4.8501 },
    rating: 4.6, userRatingCount: 87, googleMapsUri: 'https://maps.google.com/?cid=1', websiteUri: 'https://martin.example', nationalPhoneNumber: '04 72 00 11 22', ...over });
  const enable = (cap = '10') => { process.env.GOOGLE_PLACES_API_KEY = 'AIzaSyTESTKEY1234567890abcdefghijklmn'; process.env.GOOGLE_PLACES_ENABLED = 'true'; process.env.GOOGLE_PLACES_DAILY_CAP = cap; };

  beforeAll(async () => {
    process.env.DATABASE_URL = URL_; process.env.DB_SSL = 'false';
    const database = require('../../config/database'); db = database.db; await database.ensureSchema();
    svc = require('../prospectService'); exp = require('../prospectExport'); g = require('../googlePlacesService');
    axios = require('axios'); sirene = require('../sireneClient'); presence = require('../companyPresenceService');
    await svc.ensureProspectSchema();
  });
  beforeEach(async () => {
    await db.query('TRUNCATE prospect_companies, prospect_api_usage, prospect_api_health RESTART IDENTITY');
    process.env.GOOGLE_PLACES_RETRY_DELAY_MS = '0'; g.resetGoogleCircuit();
  });
  afterEach(() => { process.env = { ...OLD }; jest.resetAllMocks(); });
  const calls = async () => (await db.query(`SELECT COALESCE(SUM(calls),0)::int n FROM prospect_api_usage`)).rows[0].n;

  it('retries a transient 503 then succeeds; every attempt is counted against the cap', async () => {
    enable('10');
    await svc.upsertProspects([rec('11111111100011', { company_name: 'ELECTRICITE MARTIN' })]);
    axios.post.mockRejectedValueOnce(gerr(503, 'unavailable')).mockRejectedValueOnce({ code: 'ECONNRESET', message: 'socket hang up' })
      .mockImplementation(async (_u: string, body: any) => ({ data: { places: [place(body)] } }));
    await svc.runGoogleEnrichment({ limit: 5 });
    expect(axios.post).toHaveBeenCalledTimes(3);
    expect(await calls()).toBe(3);
    const r = (await db.query('SELECT * FROM prospect_companies')).rows[0];
    expect(r.google_maps_url).toBe('https://maps.google.com/?cid=1'); expect(r.google_review_count).toBe(87);
  });

  it('retries count toward the daily cap: a persistent outage can never exceed it', async () => {
    enable('2');
    await svc.upsertProspects([rec('22222222200011'), rec('22222222300011')]);
    axios.post.mockRejectedValue(gerr(503, 'unavailable'));
    await svc.runGoogleEnrichment({ limit: 5 });
    expect(axios.post).toHaveBeenCalledTimes(2);
    expect(await calls()).toBe(2);
    expect(svc.getEnrichState().message).toMatch(/plafond quotidien atteint \(2\)/);
  });

  it('stops after 5 consecutive failing records instead of burning the cap', async () => {
    enable('100');
    await svc.upsertProspects(Array.from({ length: 8 }, (_, i) => rec(`3333333330001${i}`)));
    axios.post.mockRejectedValue(gerr(400, 'Invalid text query'));      // row-level, non fatal, not retried
    await svc.runGoogleEnrichment({ limit: 20 });
    expect(axios.post).toHaveBeenCalledTimes(5);
    expect(svc.getEnrichState().message).toMatch(/5 erreurs Google consécutives/);
    const errs = (await db.query(`SELECT COUNT(*)::int n FROM prospect_companies WHERE field_meta->'google_profile'->>'status' = 'error'`)).rows[0].n;
    expect(errs).toBe(5);
  });

  it('a record that just failed is not re-queued (and re-billed) on the next run; an old failure is', async () => {
    enable('100');
    await svc.upsertProspects([rec('44444444400011'), rec('44444444500011')]);
    axios.post.mockRejectedValue(gerr(400, 'Invalid text query'));
    await svc.runGoogleEnrichment({ limit: 5 });
    const first = axios.post.mock.calls.length; expect(first).toBe(2);
    await svc.runGoogleEnrichment({ limit: 5 });
    expect(axios.post.mock.calls.length).toBe(first);                      // both recently failed -> skipped
    await db.query(`UPDATE prospect_companies SET field_meta = jsonb_set(field_meta, '{google_profile,at}', to_jsonb((NOW() - INTERVAL '2 days')::text)) WHERE siret = '44444444400011'`);
    await svc.runGoogleEnrichment({ limit: 5 });
    expect(axios.post.mock.calls.length).toBe(first + 1);                  // only the old failure is retried
  });

  it('fatal config error: run stops, circuit opens (no more paid calls), reason + fix are stored and reported', async () => {
    enable('100');
    await svc.upsertProspects([rec('55555555500011'), rec('55555555600011')]);
    axios.post.mockRejectedValue(gerr(403, 'Places API (New) has not been used in project 1 before or it is disabled.', 'SERVICE_DISABLED'));
    await svc.runGoogleEnrichment({ limit: 5 });
    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(svc.getEnrichState().message).toMatch(/arrêté.*403.*Places API \(New\)/);
    expect((await db.query('SELECT COUNT(*)::int n FROM prospect_companies WHERE google_fetched_at IS NOT NULL')).rows[0].n).toBe(0);   // nothing fabricated
    const st = await g.googleStatus();
    expect(st.lastError).toMatchObject({ code: 'API_NOT_ENABLED' }); expect(st.lastError.hint).toMatch(/Bibliothèque/);
    expect(st.circuitOpenUntil).not.toBeNull();
    // second run: breaker is open, Google is not called again
    await svc.runGoogleEnrichment({ limit: 5 });
    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(svc.getEnrichState().message).toMatch(/suspendus/);
  });

  it('the API key never appears in stored notes, statuses or error messages', async () => {
    enable('100');
    const key = process.env.GOOGLE_PLACES_API_KEY as string;
    await svc.upsertProspects([rec('66666666600011')]);
    axios.post.mockRejectedValue(gerr(400, `Invalid request for key ${key}`));
    await svc.runGoogleEnrichment({ limit: 5 });
    const dump = JSON.stringify((await db.query('SELECT * FROM prospect_companies')).rows) + JSON.stringify(await g.googleStatus()) + JSON.stringify(svc.getEnrichState());
    expect(dump).not.toContain(key);
    axios.post.mockRejectedValue(gerr(403, `denied ${key}`));
    await svc.upsertProspects([rec('66666666700011')]);
    await svc.runGoogleEnrichment({ limit: 5 });
    expect(JSON.stringify(await g.googleStatus()) + JSON.stringify(svc.getEnrichState())).not.toContain(key);
  });

  it('success is recorded as health; "Tester la connexion" probes once, reports the fields Google returned, and re-closes the breaker', async () => {
    enable('100');
    axios.post.mockRejectedValueOnce(gerr(403, 'API key not valid', 'API_KEY_INVALID'));
    await svc.upsertProspects([rec('77777777700011')]);
    await svc.runGoogleEnrichment({ limit: 1 });
    expect((await g.googleStatus()).circuitOpenUntil).not.toBeNull();
    axios.post.mockResolvedValue({ data: { places: [{ id: 'eiffel', displayName: { text: 'Tour Eiffel' }, rating: 4.7, userRatingCount: 400000, googleMapsUri: 'https://maps.google.com/?cid=5' }] } });
    const before = await calls();
    const p = await g.probeGoogle();
    expect(p).toMatchObject({ ok: true, sample: { name: 'Tour Eiffel', hasMapsUri: true, hasRating: true, hasReviewCount: true } });
    expect(await calls()).toBe(before + 1);                                // billed once, counted under the cap
    const st = await g.googleStatus();
    expect(st.circuitOpenUntil).toBeNull(); expect(st.lastOkAt).not.toBeNull();
  });

  it('probe refuses to call Google when not approved, and reports a bad key with its remedy', async () => {
    process.env.GOOGLE_PLACES_API_KEY = 'k'; delete process.env.GOOGLE_PLACES_ENABLED;
    expect(await g.probeGoogle()).toMatchObject({ ok: false, code: 'NOT_READY' });
    expect(axios.post).not.toHaveBeenCalled();
    enable('5'); axios.post.mockRejectedValue(gerr(400, 'API key not valid. Please pass a valid API key.', 'API_KEY_INVALID'));
    const p = await g.probeGoogle();
    expect(p).toMatchObject({ ok: false, code: 'API_KEY_INVALID' }); expect(p.hint).toMatch(/GOOGLE_PLACES_API_KEY/);
  });

  describe('SIRET company-presence lookup shares the same cost guard', () => {
    const input = { name: 'Electricite Martin', city: 'LYON', postal: '69003', address: '1 rue X', website: null };
    const hit = { displayName: { text: 'Electricite Martin' }, formattedAddress: '1 Rue X, 69003 Lyon', rating: 4.2, userRatingCount: 31 };
    beforeEach(() => { axios.get.mockRejectedValue(new Error('no network in tests')); });

    it('is a no-op (no call, no cost, not "checked") with only the key set', async () => {
      process.env.GOOGLE_PLACES_API_KEY = 'k'; delete process.env.GOOGLE_PLACES_ENABLED;
      expect(presence.isPresenceConfigured()).toBe(false);
      const r = await presence.lookupCompanyPresence(input);
      expect(axios.post).not.toHaveBeenCalled();
      expect(r).toMatchObject({ googleRating: null, googleReviewCount: null, googleChecked: false });
    });

    it('when approved: one counted call, rating stored as "4.2", marked checked', async () => {
      enable('5'); axios.post.mockResolvedValue({ data: { places: [hit] } });
      const r = await presence.lookupCompanyPresence(input);
      expect(r).toMatchObject({ googleRating: '4.2', googleReviewCount: 31, googleChecked: true });
      expect(await calls()).toBe(1);
    });

    it('no matching place is a definitive answer (checked, nothing invented)', async () => {
      enable('5'); axios.post.mockResolvedValue({ data: { places: [{ ...hit, formattedAddress: '5 Rue Y, 13001 Marseille' }] } });
      expect(await presence.lookupCompanyPresence(input)).toMatchObject({ googleRating: null, googleChecked: true });
    });

    it('cap reached or Google failure -> not checked (retried later), shares the prospect daily cap', async () => {
      enable('1'); axios.post.mockResolvedValue({ data: { places: [hit] } });
      await presence.lookupCompanyPresence(input);
      const r = await presence.lookupCompanyPresence(input);
      expect(axios.post).toHaveBeenCalledTimes(1);
      expect(r).toMatchObject({ googleRating: null, googleChecked: false });
      enable('9'); axios.post.mockRejectedValue(gerr(403, 'denied', 'API_KEY_SERVICE_BLOCKED'));
      expect(await presence.lookupCompanyPresence(input)).toMatchObject({ googleChecked: false });
    });
  });

  it('END TO END: Google data lands in the database, the admin list and BOTH exports (CSV + Excel)', async () => {
    enable('10');
    await svc.upsertProspects([rec('88888888800011', { company_name: 'ÉLECTRICITÉ MARTIN & Fils' }), rec('88888888900011', { company_name: 'SANS FICHE GOOGLE' })]);
    axios.post.mockImplementation(async (_u: string, body: any) => body.textQuery.startsWith('ÉLECTRICITÉ')
      ? { data: { places: [place(body, { displayName: { text: 'Électricité Martin & Fils' }, rating: 4.6, userRatingCount: 87 })] } }
      : { data: { places: [] } });
    await svc.runGoogleEnrichment({ limit: 10 });

    const row = (await db.query(`SELECT * FROM prospect_companies WHERE siret = '88888888800011'`)).rows[0];
    expect(row).toMatchObject({ google_maps_url: 'https://maps.google.com/?cid=1', google_review_count: 87, google_place_id: expect.stringContaining('pid-') });
    expect(Number(row.google_rating)).toBe(4.6);
    const list = await svc.searchProspects({ hasGoogle: true, minRating: 4 }, 1, 50, 'rating');
    expect(list.pagination.total).toBe(1);
    expect(list.results[0].siret).toBe('88888888800011');

    const csv = new Sink(); expect(await exp.streamCsv(csv, {}, 'x')).toBe(2);
    const lines = csv.body.toString('utf8').slice(1).trim().split('\r\n');
    const head = lines[0].split(';').map((h: string) => h.replace(/^"|"$/g, ''));
    const cell = (line: string, h: string) => line.split(';')[head.indexOf(h)];
    const withG = lines.find((l: string) => l.includes('88888888800011'))!; const without = lines.find((l: string) => l.includes('88888888900011'))!;
    expect(cell(withG, 'Lien Google Business Profile / Maps')).toBe('"https://maps.google.com/?cid=1"');
    expect(cell(withG, 'Note Google (/5)')).toBe('4,6'); expect(cell(withG, 'Nombre total d’avis Google')).toBe('87');
    expect(cell(withG, 'Google Place ID')).toContain('pid-');
    expect(cell(withG, 'Avis Google positifs (nombre)')).toBe('');                     // never invented
    expect(cell(withG, 'Champs non renseignés (statut)')).toContain('Avis Google positifs (nombre) : indisponible');
    expect(cell(without, 'Note Google (/5)')).toBe('');
    expect(cell(without, 'Champs non renseignés (statut)')).toContain('Lien Google Business Profile / Maps : absent, confirmé (Google Places)');

    const x = new Sink(); await exp.streamXlsx(x, {}, 'x');
    const ExcelJS = require('exceljs'); const wb = new ExcelJS.Workbook(); await wb.xlsx.load(x.body);
    const ws = wb.getWorksheet('Entreprises'); const headers = ws.getRow(1).values.slice(1); const col = (h: string) => headers.indexOf(h) + 1;
    const r = [2, 3].map(i => ws.getRow(i)).find(rw => rw.getCell(col('SIRET')).value === '88888888800011')!;
    expect(r.getCell(col('Lien Google Business Profile / Maps')).value.hyperlink).toBe('https://maps.google.com/?cid=1');
    expect(r.getCell(col('Note Google (/5)')).value).toBe(4.6); expect(r.getCell(col('Nombre total d’avis Google')).value).toBe(87);
    expect(r.getCell(col('Avis Google positifs (nombre)')).value).toBeNull();
  });
});
