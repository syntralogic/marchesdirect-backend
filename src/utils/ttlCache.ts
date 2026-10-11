// Tiny in-memory TTL cache for expensive, read-mostly aggregate queries.
//
// Why: the public homepage fires /stats/counts, /stats/regions and
// /stats/departments (plus the brand lookup) on EVERY page load. Each is a
// full-table aggregate over ~100k opportunities, and the DB pool is only 8
// connections (Supabase session-pooler limit). Under load - or while a
// connector run is writing tens of thousands of rows - those queries pile up,
// exhaust the pool and everything starts failing with "timeout exceeded when
// trying to connect" (Render logs, 28 Sep).
//
//  - fresh hit   -> served from memory, zero DB work
//  - miss/expired-> ONE query runs; concurrent callers share its promise
//                   (single-flight), instead of each opening a connection
//  - query fails -> the last good value is served (stale) rather than a 500
const entries = new Map<string, { value: unknown; at: number }>();
const inflight = new Map<string, Promise<unknown>>();

export async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = entries.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;

  const running = inflight.get(key);
  if (running) return running as Promise<T>;

  const p = (async () => {
    try {
      const value = await load();
      entries.set(key, { value, at: Date.now() });
      return value;
    } catch (err) {
      if (hit) return hit.value as T; // stale beats a 500
      throw err;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

export const clearCache = (): void => { entries.clear(); inflight.clear(); };

// Bounded variant for high-cardinality keys (e.g. one entry per distinct search
// query). Same semantics as `cached` (fresh hit, single-flight, stale-on-error)
// but holds at most `maxEntries` values: expired entries are dropped first, then
// the oldest, so free-text searches can't grow memory without limit.
export function createBoundedCache(maxEntries: number) {
  const store = new Map<string, { value: unknown; at: number }>();
  const running = new Map<string, Promise<unknown>>();

  const prune = (ttlMs: number) => {
    if (store.size < maxEntries) return;
    const now = Date.now();
    for (const [k, v] of store) {
      if (now - v.at >= ttlMs) store.delete(k);
    }
    while (store.size >= maxEntries) {
      const oldest = store.keys().next().value;
      if (oldest === undefined) break;
      store.delete(oldest);
    }
  };

  return async function boundedCached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const hit = store.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;

    const inFlight = running.get(key);
    if (inFlight) return inFlight as Promise<T>;

    const p = (async () => {
      try {
        const value = await load();
        prune(ttlMs);
        store.set(key, { value, at: Date.now() });
        return value;
      } catch (err) {
        if (hit) return hit.value as T;
        throw err;
      } finally {
        running.delete(key);
      }
    })();
    running.set(key, p);
    return p;
  };
}
