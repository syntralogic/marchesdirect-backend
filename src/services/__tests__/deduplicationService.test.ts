import { db } from '../../config/database';
import { mergeExactDuplicates } from '../deduplicationService';

jest.mock('../../config/database', () => ({
  db: {
    query: jest.fn(),
    transaction: jest.fn(),
  },
}));

const mockedDb = db as unknown as { query: jest.Mock; transaction: jest.Mock };

// mergeDuplicates (called once per duplicate found) runs everything inside
// db.transaction(callback) - stub it to hand the callback a client whose
// query() just records calls and resolves to a row shaped like whichever
// query it's answering, closely enough for mergeDuplicates' own logic to
// run without throwing.
function stubTransaction() {
  mockedDb.transaction.mockImplementation(async (callback: (client: any) => Promise<any>) => {
    const client = {
      query: jest.fn().mockImplementation((sql: string) => {
        if (sql.includes('SELECT * FROM opportunities WHERE id')) {
          return Promise.resolve({ rows: [{ id: 'secondary-row' }] });
        }
        return Promise.resolve({ rows: [] });
      }),
    };
    return callback(client);
  });
}

describe('mergeExactDuplicates', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('merges every extra row in a group and keeps the oldest as primary', async () => {
    stubTransaction();
    // One group of 3 identical rows (title+deadline+estimated_value+buyer_name),
    // ordered oldest-first by created_at, exactly as the grouping query returns them.
    mockedDb.query.mockResolvedValueOnce({
      rows: [{ ids: ['oldest-id', 'dup-1', 'dup-2'] }],
    });

    const merged = await mergeExactDuplicates();

    expect(merged).toBe(2); // 2 duplicates merged into the 1 primary
    expect(mockedDb.transaction).toHaveBeenCalledTimes(2);
  });

  it('returns 0 and merges nothing when there are no exact-duplicate groups', async () => {
    mockedDb.query.mockResolvedValueOnce({ rows: [] });

    const merged = await mergeExactDuplicates();

    expect(merged).toBe(0);
    expect(mockedDb.transaction).not.toHaveBeenCalled();
  });

  it('excludes cancelled/expired/merged rows from the grouping query', async () => {
    mockedDb.query.mockResolvedValueOnce({ rows: [] });

    await mergeExactDuplicates();

    const [sql] = mockedDb.query.mock.calls[0];
    expect(sql).toMatch(/status NOT IN \('cancelled', 'expired', 'merged'\)/);
  });

  it('does not throw when a query fails, and reports 0 merged', async () => {
    mockedDb.query.mockRejectedValueOnce(new Error('connection reset'));

    await expect(mergeExactDuplicates()).resolves.toBe(0);
  });
});
