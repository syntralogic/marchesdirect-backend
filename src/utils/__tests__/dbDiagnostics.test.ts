import net from 'net';
import { describeDbTarget, probeTcp, explainDbFailure } from '../dbDiagnostics';

describe('describeDbTarget', () => {
  it('parses DATABASE_URL and never returns the password', () => {
    const t = describeDbTarget({ DATABASE_URL: 'postgresql://postgres.abc:S3cr3t%40pw@aws-0-eu.pooler.supabase.com:5432/postgres' } as any);
    expect(t).toEqual({ host: 'aws-0-eu.pooler.supabase.com', port: 5432, user: 'postgres.abc', database: 'postgres' });
    expect(JSON.stringify(t)).not.toContain('S3cr3t');
  });
  it('defaults the port and falls back to DB_HOST vars', () => {
    expect(describeDbTarget({ DATABASE_URL: 'postgres://u:p@h/db' } as any)?.port).toBe(5432);
    expect(describeDbTarget({ DB_HOST: 'x', DB_PORT: '6543', DB_USER: 'u', DB_NAME: 'n' } as any)).toEqual({ host: 'x', port: 6543, user: 'u', database: 'n' });
  });
  it('returns null when nothing (or garbage) is configured', () => {
    expect(describeDbTarget({} as any)).toBeNull();
    expect(describeDbTarget({ DATABASE_URL: 'not a url' } as any)).toBeNull();
  });
});

describe('probeTcp / explainDbFailure', () => {
  it('reports reachable for a listening port', async () => {
    const srv = net.createServer().listen(0, '127.0.0.1');
    await new Promise((r) => srv.once('listening', r));
    const port = (srv.address() as net.AddressInfo).port;
    expect((await probeTcp('127.0.0.1', port)).ok).toBe(true);
    const msg = await explainDbFailure({ DATABASE_URL: `postgres://u:pw@127.0.0.1:${port}/db` } as any);
    expect(msg).toContain('TCP reachable');
    expect(msg).not.toContain('pw@');
    srv.close();
  });
  it('reports ECONNREFUSED for a closed port', async () => {
    const srv = net.createServer().listen(0, '127.0.0.1');
    await new Promise((r) => srv.once('listening', r));
    const port = (srv.address() as net.AddressInfo).port;
    await new Promise((r) => srv.close(r as any));
    const r = await probeTcp('127.0.0.1', port);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('ECONNREFUSED');
  });
  it('flags a malformed DATABASE_URL explicitly', async () => {
    expect(await explainDbFailure({ DATABASE_URL: 'postgres://u:p@w@rd@host/db' } as any)).toBeTruthy();
  });
});
