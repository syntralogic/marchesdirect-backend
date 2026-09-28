import net from 'net';

// When the boot-time "SELECT NOW()" fails with a bare "Connection terminated due
// to connection timeout", the log says nothing about WHY: wrong/paused host,
// blocked network, or a reachable server whose pooler is saturated all look
// identical. These helpers add a password-free description of the target and a
// raw TCP probe so the next log line tells those cases apart.

export interface DbTarget {
  host: string;
  port: number;
  user?: string;
  database?: string;
}

/** Parse the DB target from env WITHOUT ever exposing the password. */
export const describeDbTarget = (env: NodeJS.ProcessEnv = process.env): DbTarget | null => {
  if (env.DATABASE_URL) {
    try {
      const u = new URL(env.DATABASE_URL);
      return {
        host: u.hostname,
        port: u.port ? parseInt(u.port, 10) : 5432,
        user: decodeURIComponent(u.username || '') || undefined,
        database: u.pathname.replace(/^\//, '') || undefined,
      };
    } catch {
      return null; // malformed DATABASE_URL - caller reports it separately
    }
  }
  if (env.DB_HOST) {
    return {
      host: env.DB_HOST,
      port: parseInt(env.DB_PORT || '5432', 10),
      user: env.DB_USER,
      database: env.DB_NAME,
    };
  }
  return null;
};

export interface ProbeResult {
  ok: boolean;
  ms: number;
  /** Node error code (ENOTFOUND, ECONNREFUSED, ETIMEDOUT...) or 'TIMEOUT' when nothing answered. */
  code?: string;
}

/** Open (and immediately close) a plain TCP connection to host:port. */
export const probeTcp = (host: string, port: number, timeoutMs = 5000): Promise<ProbeResult> =>
  new Promise((resolve) => {
    const start = Date.now();
    let done = false;
    const finish = (r: Omit<ProbeResult, 'ms'>) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve({ ...r, ms: Date.now() - start });
    };
    const socket = net.connect({ host, port });
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish({ ok: true }));
    socket.once('timeout', () => finish({ ok: false, code: 'TIMEOUT' }));
    socket.once('error', (e: NodeJS.ErrnoException) => finish({ ok: false, code: e.code || e.message }));
  });

/** One human-readable line for the logs. Never contains credentials. */
export const explainDbFailure = async (env: NodeJS.ProcessEnv = process.env): Promise<string> => {
  if (env.DATABASE_URL && !describeDbTarget(env)) {
    return 'DATABASE_URL is set but is not a valid URL (check for unescaped special characters such as @ : / # in the password).';
  }
  const t = describeDbTarget(env);
  if (!t) return 'No DATABASE_URL / DB_HOST configured.';
  const p = await probeTcp(t.host, t.port);
  const who = `${t.user ? t.user + '@' : ''}${t.host}:${t.port}/${t.database || ''}`;
  if (p.ok) {
    return `target ${who} - TCP reachable in ${p.ms}ms, so the server is up but the login/session did not complete (pooler full, project paused/over quota, or bad credentials).`;
  }
  const hint =
    p.code === 'ENOTFOUND' ? 'host name does not resolve - wrong host in DATABASE_URL' :
    p.code === 'ECONNREFUSED' ? 'connection refused - wrong port or database is down/paused' :
    p.code === 'TIMEOUT' || p.code === 'ETIMEDOUT' ? 'nothing answered - project paused, host blocked, or IPv6-only host unreachable from this network' :
    p.code === 'ENETUNREACH' ? 'network unreachable - often an IPv6-only direct Supabase host; use the pooler host instead' :
    'see error code';
  return `target ${who} - TCP NOT reachable (${p.code} after ${p.ms}ms): ${hint}.`;
};
