/**
 * Real-PostgreSQL checks for the SEO audit fixes (23 Oct): impossible dates are neutralised by the DB trigger,
 * the sitemap / fiche-meta endpoints work, and /lookup is no longer shadowed by /:slug.
 * Skipped unless TEST_DATABASE_URL points at a throw-away database:
 *   TEST_DATABASE_URL=postgresql://user:pw@localhost/mdtest npx jest seoAudit --forceExit
 */
import http from 'http';
import type { AddressInfo } from 'net';
const URL_ = process.env.TEST_DATABASE_URL;
const d = URL_ ? describe : describe.skip;
d('SEO audit fixes on real PostgreSQL', () => {
  let db: any; let server: http.Server; let base = '';
  const get = async (p: string) => { const r = await fetch(base + p); return { status: r.status, body: await r.json() as any }; };
  beforeAll(async () => {
    process.env.DATABASE_URL = URL_; process.env.DB_SSL = 'false';
    const database = require('../../config/database');
    db = database.db; await database.ensureSchema();
    const express = require('express');
    const app = express(); app.use('/api/seo-pages', require('../../routes/seoPagesPublic').default);
    server = http.createServer(app); await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 120000);
  afterAll(async () => { server?.close(); await db?.end?.(); });

  it('date trigger nulls impossible deadlines and fixes publication dates, on insert and update', async () => {
    const src = (await db.query(`SELECT id FROM data_sources LIMIT 1`)).rows[0]?.id
      ?? (await db.query(`INSERT INTO data_sources (code, name) VALUES ('t','t') RETURNING id`)).rows[0].id;
    const ty = (await db.query(`SELECT id FROM opportunity_types LIMIT 1`)).rows[0].id;
    const run = Date.now();
    const ins = async (ref0: string, pub: string, dl: string | null) => (await db.query(
      `INSERT INTO opportunities (source_id, source_reference, opportunity_type_id, title, publication_date, deadline, status)
       VALUES ($1,$2,$3,'t',$4,$5,'active') RETURNING id, publication_date, deadline`, [src, `${ref0}-${run}`, ty, pub, dl])).rows[0];
    const a = await ins('seo-a', '2026-10-01', '7017-03-01');
    expect(a.deadline).toBeNull();
    const b = await ins('seo-b', '3025-01-01', '2925-05-05');
    expect(b.deadline).toBeNull();
    expect(new Date(b.publication_date).getFullYear()).toBe(new Date().getFullYear());
    const c = await ins('seo-c', '2026-10-01', '2026-12-31');
    expect(new Date(c.deadline).getFullYear()).toBe(2026);       // valid dates untouched
    const u = (await db.query(`UPDATE opportunities SET deadline='3025-01-01' WHERE id=$1 RETURNING deadline`, [c.id])).rows[0];
    expect(u.deadline).toBeNull();                                  // update path is guarded too
    const sm = await get('/api/seo-pages/opportunities-sitemap');
    expect(sm.status).toBe(200);
    expect(sm.body.opportunities.map((o: any) => o.id)).toEqual(expect.arrayContaining([a.id, b.id]));
    const meta = await get(`/api/seo-pages/opportunity-meta/${a.id}`);
    expect(meta.status).toBe(200); expect(meta.body.title).toBe('t');
    expect((await get('/api/seo-pages/opportunity-meta/not-a-uuid')).status).toBe(404);
    expect((await get('/api/seo-pages/opportunity-meta/00000000-0000-0000-0000-000000000000')).status).toBe(404);
  });

  it('/lookup is reachable (400 for missing params, 404 for an unknown department) instead of being swallowed by /:slug', async () => {
    expect((await get('/api/seo-pages/lookup')).status).toBe(400);
    expect((await get('/api/seo-pages/lookup?journey=public_procurement&department=65')).status).toBe(404);
  });
});
