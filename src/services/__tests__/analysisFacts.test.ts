import { buildFacts } from '../analysisFacts';
const base = { siret: '12345678901234', company: { name: 'ACME', ape: '4321A', employees: '3 à 5 salariés', address: '1 rue X', postal: '75001', city: 'Paris' }, companyLookedUpAt: '2026-10-01', sourceName: 'BOAMP',
  opp: { title: 'Lot électricité', publication_date: '2026-10-02', updated_at: '2026-10-03', estimated_value: 100000, currency: 'EUR', ai_extracted_facts: {}, location_city: 'Lyon' }, answers: {} as Record<string, string> };
const get = (f: any[], id: string) => f.find((x) => x.id === id)!;
describe('analysisFacts', () => {
  it('missing revenue is missing, never invented', () => { const r = get(buildFacts(base), 'company.revenue'); expect(r.status).toBe('missing'); expect(r.value).toBeNull(); });
  it('estimated revenue is inferred, real revenue verified', () => {
    expect(get(buildFacts({ ...base, company: { ...base.company, revenue: '500000', revenueEstimated: true } }), 'company.revenue').status).toBe('inferred');
    expect(get(buildFacts({ ...base, company: { ...base.company, revenue: '500000', revenueYear: 2025 } }), 'company.revenue').status).toBe('verified');
  });
  it('APE and employees carry precision warnings', () => { const f = buildFacts(base); expect(get(f, 'company.ape').precision).toMatch(/Indice/); expect(get(f, 'company.employees').precision).toMatch(/Tranche/); });
  it('answers are declared, a_confirmer is missing', () => { const f = buildFacts({ ...base, answers: { experience: 'oui', capacity: 'a_confirmer' } }); expect(get(f, 'answer.experience').status).toBe('declared'); expect(get(f, 'answer.capacity').status).toBe('missing'); });
  it('amount conflict is flagged, extracted qualifications are inferred', () => {
    const f = buildFacts({ ...base, opp: { ...base.opp, ai_extracted_facts: { estimated_value: { value: '150 000', available: true }, required_qualifications: { value: ['Qualibat 5112'], available: true } } } });
    expect(get(f, 'market.amount').status).toBe('conflicting'); expect(get(f, 'market.qualifications').status).toBe('inferred');
  });
});
