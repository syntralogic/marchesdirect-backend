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
    expect(q.listSql).toContain('o.trade_id = ANY(ARRAY(SELECT id FROM trades WHERE slug = ANY($1::text[])');
    expect(q.listSql).toContain('= $2');
    expect(q.listSql).toContain('LIMIT 40');
  });
  it('widening to France drops the department only, never the trade', () => {
    const q = buildCandidatesQuery({ tradeSlugs: ['plomberie'], department: null });
    expect(q.params[0]).toEqual(['plomberie']);
    expect(q.listSql).toContain('o.trade_id = ANY(ARRAY(SELECT id FROM trades WHERE slug = ANY($1::text[])');
    expect(q.listSql).not.toContain('location_department) ~');
  });
  it('7 nov. : un intitulé sans métier classé entre par mot-clé, et le département de l’entreprise passe en tête', () => {
    const q = buildCandidatesQuery({ tradeSlugs: ['cvc'], department: null, preferDepartment: '92' });
    expect(q.listSql).toContain("(o.trade_id IS NULL OR COALESCE(ot.code, '') <> 'public_procurement') AND immutable_unaccent(o.title) ~* $2");
    expect(String(q.params[1])).toContain('climatisation');
    expect(String(q.params[1])).toContain('pompes? a chaleur');
    expect(q.params[q.params.length - 1]).toBe('92');
    expect(q.listSql).toMatch(/ORDER BY \(CASE WHEN .*= \$\d+ THEN 0 ELSE 1 END\) ASC/);
  });
  it('7 nov. : sans département, jamais un entier nu dans ORDER BY (PostgreSQL le lit comme une position de colonne)', () => {
    for (const v2 of [true, false]) {
      const q = buildCandidatesQuery({ tradeSlugs: ['cvc'], department: null, v2 });
      expect(q.listSql).not.toMatch(/ORDER BY\s+0\b|,\s*0 ASC/);
    }
  });
  it('caps the limit', () => {
    expect(buildCandidatesQuery({ tradeSlugs: ['a'], department: null, limit: 9999 }).listSql).toContain(`LIMIT ${MAX_CANDIDATES}`);
    expect(buildCandidatesQuery({ tradeSlugs: ['a'], department: null, limit: 0 }).listSql).toContain('LIMIT 40');
  });

  it('7 nov. : le comptage ne reçoit pas le paramètre du département préféré (bind message supplies 4 parameters…)', () => {
    const q = buildCandidatesQuery({ tradeSlugs: ['cvc'], department: null, preferDepartment: '92', v2: true });
    expect(q.params.length).toBe(q.countParams.length + 1);
    expect(q.countSql).not.toContain(`$${q.params.length}`);
    const used = new Set((q.countSql.match(/\$\d+/g) || []).map(x => Number(x.slice(1))));
    expect(Math.max(...used)).toBe(q.countParams.length);
    const q2 = buildCandidatesQuery({ tradeSlugs: ['cvc'], department: '92', preferDepartment: '92', v2: true });
    expect(q2.countParams.length).toBe(q2.params.length);
  });
});
