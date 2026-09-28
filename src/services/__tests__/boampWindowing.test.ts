import axios from 'axios';

jest.mock('axios');
jest.mock('../../config/database', () => ({ db: { query: jest.fn() } }));
jest.mock('../deduplicationService', () => ({ deduplicateOpportunities: jest.fn().mockResolvedValue(0) }));

const mockedAxios = axios as jest.Mocked<typeof axios>;

// Fake BOAMP dataset: `perDay` open notices for each of `days` consecutive
// deadline days starting today. Mimics Opendatasoft: total_count is always the
// full match count, and offset + limit above 10,000 is rejected.
function fakeDataset(perDay: number, days: number) {
  const today = new Date().toISOString().slice(0, 10);
  const day = (i: number) => new Date(new Date(today + 'T00:00:00Z').getTime() + i * 86400000).toISOString().slice(0, 10);
  const all: any[] = [];
  for (let d = 0; d < days; d++) for (let k = 0; k < perDay; k++) all.push({ idweb: `N-${d}-${k}`, objet: 'x', datelimitereponse: day(d) });
  return (where: string, limit: number, offset: number) => {
    if (offset + limit > 10000) throw new Error('offset+limit > 10000');
    const ge = /datelimitereponse >= date'(\d{4}-\d{2}-\d{2})'/.exec(where)![1];
    const lt = /datelimitereponse < date'(\d{4}-\d{2}-\d{2})'/.exec(where)?.[1];
    const matches = all.filter(r => r.datelimitereponse >= ge && (!lt || r.datelimitereponse < lt));
    return { results: matches.slice(offset, offset + limit), total_count: matches.length };
  };
}

describe('collectBoampData - windowed loading above the 9,900 cap', () => {
  it('loads every open notice when the total exceeds one paged query', async () => {
    const query = fakeDataset(250, 100); // 25,000 open notices
    mockedAxios.get.mockImplementation(async (_url: string, cfg: any) => ({ data: query(cfg.params.where, cfg.params.limit, cfg.params.offset ?? 0) }));

    const db = require('../../config/database');
    const upserted = new Set<string>();
    (db.db.query as jest.Mock).mockImplementation(async (sql: string, values: any[]) => {
      if (sql.includes('opportunity_types')) return { rows: [{ id: 'pp' }] };
      if (sql.includes('INSERT INTO opportunities')) {
        const rows: any[] = [];
        for (let i = 0; i < values.length; i += 17) { upserted.add(values[i + 1]); rows.push({ was_insert: true }); }
        return { rows };
      }
      return { rows: [] };
    });

    const { collectBoampData } = require('../dataCollectionService');
    const result = await collectBoampData(1);
    expect(upserted.size).toBe(25000);
    expect(result.inserted).toBe(25000);
    expect(result.errors).toBe(0);
  }, 60000);
});
