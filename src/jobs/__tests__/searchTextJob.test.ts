import { db } from '../../config/database';
import { ensureSearchTextSchema, searchTextReady } from '../searchTextJob';
jest.mock('../../config/database', () => ({ db: { query: jest.fn(), getClient: jest.fn() } }));
jest.mock('../../utils/logger', () => ({ logger: { info: jest.fn(), error: jest.fn() } }));
jest.mock('../../utils/ttlCache', () => ({ cached: (_k: string, _ttl: number, fn: any) => fn() }));

beforeEach(() => jest.resetAllMocks());
it('does not acquire any schema locks on restart when the search migration is installed', async () => {
  (db.query as jest.Mock).mockResolvedValue({ rows: [{ col: true, trg: true, todo: true }] });
  await ensureSearchTextSchema();
  expect(db.getClient).not.toHaveBeenCalled();
  expect(db.query).toHaveBeenCalledTimes(1);
  expect((db.query as jest.Mock).mock.calls[0][0]).not.toMatch(/ALTER TABLE|DROP TRIGGER/);
});
it('checks for one unfinished row instead of counting the entire migration backlog', async () => {
  (db.query as jest.Mock).mockResolvedValue({ rows: [{ pending: true }] });
  expect(await searchTextReady()).toBe(false);
  expect((db.query as jest.Mock).mock.calls[0][0]).toContain('LIMIT 1');
  expect((db.query as jest.Mock).mock.calls[0][0]).not.toContain('COUNT');
});
it('requires both completed data and a valid index before switching search', async () => {
  (db.query as jest.Mock).mockResolvedValueOnce({ rows: [{ pending: false }] }).mockResolvedValueOnce({ rows: [{ indisvalid: false }] });
  expect(await searchTextReady()).toBe(false);
  (db.query as jest.Mock).mockResolvedValueOnce({ rows: [{ pending: false }] }).mockResolvedValueOnce({ rows: [{ indisvalid: true }] });
  expect(await searchTextReady()).toBe(true);
});
it('keeps the existing search usable if schema inspection fails', async () => {
  (db.query as jest.Mock).mockRejectedValue(new Error('column not installed'));
  expect(await searchTextReady()).toBe(false);
});
