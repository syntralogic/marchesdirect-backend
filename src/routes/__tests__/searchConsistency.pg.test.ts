/**
 * Real-PostgreSQL check that counts and lists agree (client report 1 Oct 2026):
 *   - typing a métier name in the search box == selecting that métier
 *   - region / département badges (stats) == the lists they open
 *   - TED rows outside France never count anywhere
 *   - catalogue rows are flagged is_demo
 * Skipped unless TEST_DATABASE_URL points at a throw-away database:
 *   TEST_DATABASE_URL=postgresql://user:pw@localhost/mdtest npx jest searchConsistency --forceExit
 */
import http from 'http';
import type { AddressInfo } from 'net';

const URL_ = process.env.TEST_DATABASE_URL;
const d = URL_ ? describe : describe.skip;

d('search / count consistency (real PostgreSQL)', () => {
  let server: http.Server;
  let base = '';
  let db: any;
  let electriciteId = 0;

  const get = async (path: string) => (await fetch(base + path)).json() as Promise<any>;
  const ids = (r: any) => (r.results as any[]).map((x) => x.id).sort();

  beforeAll(async () => {
    process.env.DATABASE_URL = URL_;
    process.env.DB_SSL = 'false';
    const database = require('../../config/database');
    db = database.db;
    await database.ensureSchema();
    await db.query('TRUNCATE opportunities CASCADE');

    const src = async (code: string) => (await db.query('SELECT id FROM data_sources WHERE code = $1', [code])).rows[0].id;
    const boamp = await src('boamp');
    const ted = await src('ted');
    const editorial = await src('editorial_catalog');
    const trade = await db.query("SELECT id FROM trades WHERE slug = 'electricite'");
    electriciteId = trade.rows[0].id;

    const insert = (o: any) =>
      db.query(
        `INSERT INTO opportunities (source_id, source_reference, opportunity_type_id, title, description, publication_date,
           deadline, status, trade_id, location_city, location_department, location_region, location_country)
         VALUES ($1,$2,$3,$4,$5, NOW() - INTERVAL '3 days', $6, $7, $8, $9, $10, $11, $12)`,
        [o.source, o.ref, o.type, o.title, o.description ?? null, o.deadline ?? "NOW() + INTERVAL '20 days'", o.status ?? 'active',
         o.trade ?? null, o.city ?? null, o.dept ?? null, o.region ?? null, o.country ?? 'FR']
      );
    const future = new Date(Date.now() + 20 * 86400000).toISOString();
    const past = new Date(Date.now() - 5 * 86400000).toISOString();
    await insert({ source: boamp, ref: 'B1', type: 2, title: 'Travaux de rénovation du groupe scolaire',
      description: 'Allotissement :\nLots : Lot 1 Maçonnerie ; Lot 3 Électricité courants forts et faibles', deadline: future,
      city: 'Bordeaux', dept: '33', region: 'Nouvelle-Aquitaine' });
    await insert({ source: boamp, ref: 'B2', type: 2, title: 'Installation électrique du gymnase', trade: electriciteId, deadline: future,
      city: 'Mérignac', dept: '33', region: 'Nouvelle-Aquitaine' });
    await insert({ source: boamp, ref: 'B3', type: 2, title: 'Fourniture d’un camion électrique pour les services techniques', deadline: future,
      city: 'Lyon', dept: '69', region: 'Auvergne-Rhône-Alpes' });
    await insert({ source: boamp, ref: 'B4', type: 2, title: 'Maintenance de l’éclairage public et de l’électricité des bâtiments', deadline: past, status: 'expired',
      city: 'Bordeaux', dept: '33', region: 'Nouvelle-Aquitaine' });
    await insert({ source: ted, ref: 'T1', type: 2, title: 'Elektrische Installation Schule - electricité', deadline: future,
      city: 'Berlin', dept: null, region: null, country: 'DE' });
    await insert({ source: editorial, ref: 'E1', type: 1, title: 'Lyon : installation électrique pour une copropriété', trade: electriciteId, deadline: future,
      city: 'Lyon', dept: '69', region: 'Auvergne-Rhône-Alpes' });

    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/opportunities', require('../opportunities').default);
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/opportunities`;
  });

  afterAll(async () => {
    server?.close();
    await db?.end?.();
  });

  it('typing the métier name and picking it return the same set, lots included', async () => {
    const byText = await get('/?q=' + encodeURIComponent('électricité') + '&limit=50');
    const byTrade = await get(`/?trade_id=${electriciteId}&limit=50`);
    expect(ids(byText)).toEqual(ids(byTrade));
    const titles = (byText.results as any[]).map((x) => x.title);
    expect(titles).toContain('Travaux de rénovation du groupe scolaire');   // metier only in a lot
    expect(titles).toContain('Installation électrique du gymnase');          // classified trade, wording differs
    expect(titles).not.toContain('Fourniture d’un camion électrique pour les services techniques');
  });

  it('region badge equals the list it opens', async () => {
    const stats = await get('/stats/regions');
    const badge = stats.regions.find((r: any) => r.region === 'Nouvelle-Aquitaine').count;
    const list = await get('/?region=' + encodeURIComponent('Nouvelle-Aquitaine') + '&limit=50');
    expect(list.pagination.total).toBe(badge);
  });

  it('département badge equals the list it opens', async () => {
    const stats = await get('/stats/departments');
    const badge = stats.departments.find((r: any) => r.department === '33').count;
    const list = await get('/?department=33&limit=50');
    expect(list.pagination.total).toBe(badge);
  });

  it('non-French TED rows are in no count and no list', async () => {
    const all = await get('/?limit=50');
    expect((all.results as any[]).some((x) => x.title.startsWith('Elektrische'))).toBe(false);
    const counts = await get('/stats/counts');
    expect(counts.total).toBe(all.pagination.total);
  });

  it('catalogue rows are flagged is_demo, real ones are not', async () => {
    const all = await get('/?limit=50');
    const demo = (all.results as any[]).filter((x) => x.is_demo);
    expect(demo.map((x) => x.title)).toEqual(['Lyon : installation électrique pour une copropriété']);
  });

  it('open count never exceeds the catalogue count', async () => {
    const open = await get('/stats/counts?status=active');
    const all = await get('/stats/counts');
    expect(open.total).toBeLessThanOrEqual(all.total);
    expect(open.total).toBe(4);   // B1, B2, B3, E1 (B4 expired, T1 foreign)
  });
});
