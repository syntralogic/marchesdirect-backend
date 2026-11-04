import { buildCandidatesQuery, normaliseZone, MAX_CANDIDATES } from '../rankedListService';

describe('ranked list candidates', () => {
  it('normalises the zone', () => {
    expect(normaliseZone('92')).toBe('92');
    expect(normaliseZone('5')).toBe('05');
    expect(normaliseZone('2a')).toBe('2A');
    expect(normaliseZone('974')).toBe('974');
    expect(normaliseZone('France')).toBeNull();
    expect(normaliseZone('92; DROP TABLE x')).toBeNull();
    expect(normaliseZone(undefined)).toBeNull();
  });
  it('only selects open markets of the company trade, in its department', () => {
    const q = buildCandidatesQuery({ tradeSlugs: ['climatisation'], department: '92' });
    expect(q.params).toEqual([['climatisation'], '92']);
    expect(q.listSql).toContain("o.status = 'active'");
    expect(q.listSql).toContain('o.deadline >= NOW()');
    expect(q.listSql).toContain('t.slug = ANY($1::text[])');
    expect(q.listSql).toContain('= $2');
    expect(q.listSql).toContain('LIMIT 40');
  });
  it('widening to France drops the department only, never the trade', () => {
    const q = buildCandidatesQuery({ tradeSlugs: ['plomberie'], department: null });
    expect(q.params).toEqual([['plomberie']]);
    expect(q.listSql).toContain('t.slug = ANY($1::text[])');
    expect(q.listSql).not.toContain('location_department) ~');
  });
  it('caps the limit', () => {
    expect(buildCandidatesQuery({ tradeSlugs: ['a'], department: null, limit: 9999 }).listSql).toContain(`LIMIT ${MAX_CANDIDATES}`);
    expect(buildCandidatesQuery({ tradeSlugs: ['a'], department: null, limit: 0 }).listSql).toContain('LIMIT 40');
  });
});
