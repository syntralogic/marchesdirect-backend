import express from 'express';
import { AddressInfo } from 'net';
import { Server } from 'http';
import { installAbuseProtection, requireDiagnosticAccess, protectLocalFiles } from '../abuseProtection';
import { errorHandler } from '../errorHandler';
import { generateTokens } from '../auth';
import { signPrivateFilePath } from '../../utils/privateFileLinks';
import { db } from '../../config/database';

jest.mock('../../config/database', () => ({ db: { query: jest.fn() } }));
jest.mock('../../utils/logger', () => ({ logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn() } }));
jest.mock('../../services/storageService', () => ({ resolveAvatarUrl: (v: string) => v }));

describe('HTTP abuse protection', () => {
  let server: Server;
  let base: string;
  beforeEach(async () => {
    (db.query as jest.Mock).mockReset();
    const app = express();
    installAbuseProtection(app);
    app.post('/api/needs', (_q, s) => s.json({ saved: true }));
    app.get('/api/needs', (_q, s) => s.json({ ok: true }));
    app.get('/api/opportunities', requireDiagnosticAccess, (_q, s) => s.json({ ok: true }));
    app.use('/uploads', protectLocalFiles, (_q, s) => s.send('file'));
    app.use(errorHandler);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>(r => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); });
  it('limits repeated submissions without blocking reads or normal search crawlers', async () => {
    for (let n = 0; n < 20; n++) expect((await fetch(base + '/api/needs', { method: 'POST' })).status).toBe(200);
    const denied = await fetch(base + '/api/needs', { method: 'POST' });
    expect(denied.status).toBe(429);
    expect(denied.headers.get('retry-after')).toBeTruthy();
    expect((await fetch(base + '/api/needs')).status).toBe(200);
    expect((await fetch(base + '/api/opportunities', { headers: { 'User-Agent': 'Googlebot' } })).status).toBe(200);
  });
  it('rejects large public forms before reaching their handler', async () => {
    const r = await fetch(base + '/api/needs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'x'.repeat(65536) }) });
    expect(r.status).toBe(413);
  });
  it('requires administrator authentication before diagnostics', async () => {
    expect((await fetch(base + '/api/opportunities?explain=1')).status).toBe(401);
    expect(db.query).not.toHaveBeenCalled();
    const tokens = generateTokens('test-user', 'test@example.invalid');
    (db.query as jest.Mock).mockResolvedValue({ rows: [{ id: 'test-user', role: 'user' }] });
    expect((await fetch(base + '/api/opportunities?explain=2', { headers: { Authorization: `Bearer ${tokens.accessToken}` } })).status).toBe(403);
    (db.query as jest.Mock).mockResolvedValue({ rows: [{ id: 'test-user', role: 'admin' }] });
    expect((await fetch(base + '/api/opportunities?explain=2', { headers: { Authorization: `Bearer ${tokens.accessToken}` } })).status).toBe(200);
  });
  it('rejects oversized or ambiguous search parameters before any database query', async () => {
    expect((await fetch(base + '/api/opportunities?q=' + 'x'.repeat(257))).status).toBe(400);
    expect((await fetch(base + '/api/opportunities?q=a&q=b')).status).toBe(400);
    expect(db.query).not.toHaveBeenCalled();
  });
  it('keeps avatars public and requires a valid signed link for private documents', async () => {
    expect((await fetch(base + '/uploads/avatars/u/avatar.jpg')).status).toBe(200);
    expect((await fetch(base + '/uploads/companies/a/document.pdf')).status).toBe(403);
    const r = await fetch(base + signPrivateFilePath('/uploads/companies/a/document.pdf'));
    expect(r.status).toBe(200);
    expect(r.headers.get('content-disposition')).toBe('attachment');
    expect(r.headers.get('cache-control')).toBe('private, no-store');
  });
});
