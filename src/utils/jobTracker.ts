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

export function trackJob<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const p = fn().catch(err => {
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
