import { cached, clearCache, createBoundedCache } from '../ttlCache';

beforeEach(() => clearCache());

test('serves from memory inside the TTL and shares one in-flight query', async () => {
  const load = jest.fn(async () => { await new Promise(r => setTimeout(r, 20)); return 42; });
  const [a, b, c] = await Promise.all([cached('k', 1000, load), cached('k', 1000, load), cached('k', 1000, load)]);
  expect([a, b, c]).toEqual([42, 42, 42]);
  await cached('k', 1000, load);
  expect(load).toHaveBeenCalledTimes(1);
});

test('reloads after the TTL expires', async () => {
  const load = jest.fn(async () => Date.now());
  await cached('t', 1, load);
  await new Promise(r => setTimeout(r, 5));
  await cached('t', 1, load);
  expect(load).toHaveBeenCalledTimes(2);
});

test('serves the last good value when the reload fails, throws when there is none', async () => {
  await expect(cached('e', 1, async () => { throw new Error('db down'); })).rejects.toThrow('db down');
  await cached('e2', 1, async () => 'good');
  await new Promise(r => setTimeout(r, 5));
  await expect(cached('e2', 1, async () => { throw new Error('db down'); })).resolves.toBe('good');
});

describe('createBoundedCache', () => {
  it('serves a fresh hit without reloading and shares one in-flight load', async () => {
    const c = createBoundedCache(10);
    const load = jest.fn(async () => 'v');
    const [a, b] = await Promise.all([c('k', 1000, load), c('k', 1000, load)]);
    expect([a, b]).toEqual(['v', 'v']);
    await c('k', 1000, load);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('never holds more than maxEntries values (oldest dropped first)', async () => {
    const c = createBoundedCache(3);
    const loads: Record<string, number> = {};
    const get = (k: string) => c(k, 60_000, async () => { loads[k] = (loads[k] || 0) + 1; return k; });
    for (const k of ['a', 'b', 'c', 'd']) await get(k);
    await get('d'); // still cached
    expect(loads.d).toBe(1);
    await get('a'); // evicted -> reloaded
    expect(loads.a).toBe(2);
  });

  it('serves the last good value when a refresh fails, and never caches an error', async () => {
    const c = createBoundedCache(5);
    await c('k', 0, async () => 'good');
    await expect(c('k', 0, async () => { throw new Error('db down'); })).resolves.toBe('good');
    await expect(c('fresh', 1000, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(c('fresh', 1000, async () => 'ok')).resolves.toBe('ok');
  });
});
