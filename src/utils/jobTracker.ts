import { logger } from './logger';

// Confirmed live, 2026-09-05: server.ts's graceful shutdown waits for
// server.close() (in-flight HTTP requests) before closing the DB pool, but
// background cron jobs (SEO generation, BOAMP/DECP collection, CRM retry,
// etc.) run on their own timers, entirely outside the HTTP request
// lifecycle - server.close()'s callback has no idea they exist. On every
// Render deploy (SIGTERM), a job that happened to be mid-query at that
// moment kept running after db.end() had already closed the pool: "Cannot
// use a pool after calling end on the pool". Not a crash, but a real
// failure logged on every single redeploy for whichever job was unlucky
// enough to be running.
//
// Fix: every background job wraps its scheduled/boot-time run in
// trackJob(), which registers the in-flight promise here. Shutdown then
// awaits drainActiveJobs() (with its own timeout, on top of the existing
// hard-exit safety net) before closing the pool, so a job that's already
// running gets a chance to finish instead of getting cut off mid-query.
const activeJobs = new Set<Promise<any>>();

// 29 Sep incident (Render log): a fresh deploy's ~15 background jobs each
// fire their boot-time run within the first couple of minutes (staggered by
// JOB_START_GAP_MS, but that only spaces out when they START - a slow one,
// e.g. a multi-window BOAMP/DECP collection run, can still be mid-query when
// the next job's turn comes up). With only an 8-connection pool, a handful of
// jobs each holding a connection at once was enough that a real visitor's
// very first request - the CORS brand-domains lookup - couldn't get a
// connection within its own 10s timeout, 500ing real traffic seconds after
// the deploy went live. Every background job already goes through
// trackJob(), so gating admission here (rather than in each job file) caps
// how many can ever be doing DB work at the same moment, process-wide,
// leaving the rest of the pool free for web requests no matter how long any
// one job takes or how its cron tick happens to line up with another's.
// Jobs beyond the cap simply wait their turn, in order.
const MAX_CONCURRENT_JOBS = Number(process.env.JOB_CONCURRENCY ?? 3);
let runningJobs = 0;
const jobQueue: Array<() => void> = [];

const acquireJobSlot = (): Promise<void> => {
  if (runningJobs < MAX_CONCURRENT_JOBS) {
    runningJobs++;
    return Promise.resolve();
  }
  return new Promise<void>(resolve => jobQueue.push(resolve)).then(() => {
    runningJobs++;
  });
};

const releaseJobSlot = (): void => {
  runningJobs--;
  const next = jobQueue.shift();
  if (next) next();
};

export function trackJob<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const p = acquireJobSlot()
    .then(fn)
    .finally(releaseJobSlot)
    .catch(err => {
      // Jobs already log their own failures internally; this catch exists
      // only so a rejected job promise doesn't produce an unhandled
      // rejection once it's sitting in the activeJobs set below - re-throw
      // preserved for the caller's own .catch/.then chain.
      throw err;
    });
  activeJobs.add(p);
  const cleanup = () => activeJobs.delete(p);
  p.then(cleanup, cleanup);
  return p;
}

export async function drainActiveJobs(timeoutMs: number): Promise<void> {
  if (activeJobs.size === 0) return;
  logger.info(`[shutdown] Waiting for ${activeJobs.size} in-flight background job(s) to finish (up to ${timeoutMs}ms)...`);
  let timedOut = false;
  const timeout = new Promise<void>(resolve => {
    const t = setTimeout(() => { timedOut = true; resolve(); }, timeoutMs);
    t.unref();
  });
  await Promise.race([
    Promise.allSettled([...activeJobs]).then(() => {}),
    timeout,
  ]);
  if (timedOut) {
    logger.warn(`[shutdown] Timed out waiting for ${activeJobs.size} background job(s) - closing the DB pool anyway (the 10s hard-exit fallback would otherwise force this regardless).`);
  } else {
    logger.info('[shutdown] All in-flight background jobs finished.');
  }
}
