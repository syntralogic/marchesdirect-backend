/**
 * Real-PostgreSQL check of GET /api/opportunities/stats/open-today (Accueil counter):
 * it counts exactly the notices that are still open, nothing hardcoded.
 * Skipped unless TEST_DATABASE_URL points at a throw-away database:
 *   TEST_DATABASE_URL=postgresql://user:pw@localhost/mdtest npx jest openToday --forceExit
 */
import http from 'http';
import type { AddressInfo } from 'net';

const URL_ = process.env.TEST_DATABASE_URL;
const d = URL_ ? describe : describe.skip;

d('stats/open-today (real PostgreSQL)', () => {
  let server: http.Server;
  let base = '';
  let db: any;

  const get = async (path: string) => {
    const r = await fetch(base + path);
    return { status: r.status, body: (await r.json()) as any };
  };

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

    const future = new Date(Date.now() + 10 * 86400000).toISOString();
    const past = new Date(Date.now() - 2 * 86400000).toISOString();
    const insert = (ref: string, o: { source?: number; deadline?: string | null; status?: string; country?: string; deleted?: boolean }) =>
      db.query(
        `INSERT INTO opportunities (source_id, source_reference, opportunity_type_id, title, publication_date,
           deadline, status, location_country, deleted_at)
         VALUES ($1, $2, 2, $3, NOW() - INTERVAL '3 days', $4, $5, $6, $7)`,
        [o.source ?? boamp, ref, `Marché ${ref}`, o.deadline === undefined ? future : o.deadline, o.status ?? 'active',
         o.country ?? 'FR', o.deleted ? new Date().toISOString() : null]
      );

    await insert('OPEN-1', {});                                  // counted: active, deadline ahead
    await insert('OPEN-2', { deadline: null });                  // counted: active, no deadline
    await insert('PAST', { deadline: past });                    // active but deadline already passed
    await insert('EXPIRED', { status: 'expired', deadline: past });
    await insert('AWARDED', { status: 'awarded' });
    await insert('MERGED', { status: 'merged' });
    await insert('DELETED', { deleted: true });
    await insert('TED-DE', { source: ted, country: 'DE' });      // TED outside France never counts
    await insert('TED-FR', { source: ted, country: 'FR' });      // counted

    const express = require('express');
    const app = express();
    app.use('/api/opportunities', require('../opportunities').default);
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/opportunities`;
  });

  afterAll(async () => {
    server?.close();
    await db?.end?.();
  });

  it('counts only open, live, French, non-deleted notices', async () => {
    const { status, body } = await get('/stats/open-today');
    expect(status).toBe(200);
    expect(body.count).toBe(3);
    expect(body.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('is not served as "stats/:id" (route order)', async () => {
    const { status, body } = await get('/stats/open-today');
    expect(status).toBe(200);
    expect(typeof body.count).toBe('number');
  });
});
