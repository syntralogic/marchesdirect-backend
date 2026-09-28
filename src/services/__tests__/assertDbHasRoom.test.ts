jest.mock('../../config/database', () => ({ db: { query: jest.fn() } }));

const { db } = require('../../config/database');
const { assertDbHasRoom } = require('../dataCollectionService');

describe('assertDbHasRoom', () => {
  afterEach(() => { delete process.env.DB_SIZE_LIMIT_MB; (db.query as jest.Mock).mockReset(); });

  it('throws a clear error when the database is read-only', async () => {
    (db.query as jest.Mock).mockResolvedValue({ rows: [{ transaction_read_only: 'on' }] });
    await expect(assertDbHasRoom()).rejects.toThrow(/DATABASE_READ_ONLY/);
  });

  it('passes on a writable DB when no size limit is configured', async () => {
    (db.query as jest.Mock).mockResolvedValue({ rows: [{ transaction_read_only: 'off' }] });
    await expect(assertDbHasRoom()).resolves.toBeUndefined();
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it('pauses ingestion when size is at/over DB_SIZE_LIMIT_MB', async () => {
    process.env.DB_SIZE_LIMIT_MB = '450';
    (db.query as jest.Mock)
      .mockResolvedValueOnce({ rows: [{ transaction_read_only: 'off' }] })
      .mockResolvedValueOnce({ rows: [{ bytes: String(480 * 1048576) }] });
    await expect(assertDbHasRoom()).rejects.toThrow(/DATABASE_STORAGE_FULL/);
  });
});
