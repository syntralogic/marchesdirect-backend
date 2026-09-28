import { cached, clearCache } from '../ttlCache';

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
