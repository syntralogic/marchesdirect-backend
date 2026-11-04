/** Home page endpoints (client brief v26): GET /siret/search-params and GET /opportunities/stats/open-count.
 *  Needs TEST_DATABASE_URL (throw-away database); skipped otherwise. */
import http from 'http';
import type { AddressInfo } from 'net';

const d = process.env.TEST_DATABASE_URL ? describe : describe.skip;

d('home endpoints (real PostgreSQL)', () => {
  let db: any; let server: http.Server; let base = '';
  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL; process.env.DB_SSL = 'false';
    const database = require('../../config/database'); db = database.db; await database.ensureSchema();
    const express = require('express'); const app = express(); app.use(express.json());
    app.use('/api/siret', require('../siret').default);
    app.use('/api/opportunities', require('../opportunities').default);
    app.use('/api/visitor-events', require('../visitorEvents').default);
    server = http.createServer(app); await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 60000);
  afterAll(async () => { await new Promise((r) => server.close(r)); await db.end?.(); });

  it('search-params: métier and zone come from the recognised company, 404 when none', async () => {
    await db.query(`INSERT INTO siret_lookups (session_id, siret, company_data) VALUES ('sess-home-0001', '12345678901234', $1)
                    ON CONFLICT (session_id) DO NOTHING`, [JSON.stringify({ name: 'DUPONT ELEC', ape: '4321A', postal: '69003' })]);
    const ok = await (await fetch(`${base}/api/siret/search-params?sessionId=sess-home-0001`)).json() as any;
    expect(ok).toMatchObject({ siret: '12345678901234', profession: 'electricite', query: 'électricité', department: '69' });
    expect((await fetch(`${base}/api/siret/search-params?sessionId=sess-unknown-9999`)).status).toBe(404);
    expect((await fetch(`${base}/api/siret/search-params`)).status).toBe(400);
  });

  it('open-count: one real count, same value on the second call (24 h cache)', async () => {
    const a = await fetch(`${base}/api/opportunities/stats/open-count`);
    expect(a.status).toBe(200);
    const body = await a.json() as any;
    expect(Number.isInteger(body.count)).toBe(true);
    expect(body.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const n = (await db.query(`SELECT COUNT(*)::int n FROM opportunities o LEFT JOIN data_sources ds ON o.source_id = ds.id
      WHERE o.deleted_at IS NULL AND COALESCE(o.status,'') != 'merged' AND (ds.code IS DISTINCT FROM 'ted' OR o.location_country IN ('FR','FRA')) AND o.status = 'active'`)).rows[0].n;
    expect(body.count).toBe(n);
    expect(((await (await fetch(`${base}/api/opportunities/stats/open-count`)).json()) as any).count).toBe(n);
  });

  it('company_selected may arrive BEFORE any offer_view (home page selection), both are journaled in that order', async () => {
    const post = (b: any) => fetch(`${base}/api/visitor-events`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
    const S = 'sess-home-order-1';
    const a = await post({ sessionId: S, eventType: 'company_selected', eventId: 'home-sel-000001', siret: '12345678901234', occurredAt: new Date(Date.now() - 2000).toISOString() });
    const b = await post({ sessionId: S, eventType: 'offer_view', eventId: 'home-view-00001', opportunityId: '123e4567-e89b-12d3-a456-426614174000', occurredAt: new Date().toISOString() });
    expect([a.status, b.status]).toEqual([204, 204]);
    const r = await db.query('SELECT event_type, siret FROM visitor_events WHERE session_id = $1 ORDER BY COALESCE(occurred_at, created_at)', [S]);
    expect(r.rows.map((x: any) => x.event_type)).toEqual(['company_selected', 'offer_view']);
    expect(r.rows[0].siret).toBe('12345678901234');
  });
});
