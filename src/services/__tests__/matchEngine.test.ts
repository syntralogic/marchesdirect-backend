import { evaluateMatch, tradeSlugsForCompany, CompanyProfile, MarketInput } from '../matchEngine';
import { extractTradeSlugs } from '../tradeResolver';

// 25 Sep client audit: VERIFRANCE HABITAT (heating / air conditioning) got 37 %
// on a climatisation job, 19 % on a CVC maintenance job and 55 % - "Correspondance
// identifiée" - on a painting job, because the index scored how complete each
// notice was.

const company = (over: Partial<CompanyProfile> = {}): CompanyProfile => ({
  source: 'siret',
  name: 'VERIFRANCE HABITAT',
  tradeSlugs: tradeSlugsForCompany('4322B', 'Travaux d’installation d’équipements thermiques et de climatisation'),
  activityText: 'chauffage/climatisation',
  latitude: null, longitude: null, department: '62', city: 'Hénin-Beaumont', radiusKm: null,
  annualRevenue: null, recentReferenceCount: null, certificationText: '',
  ...over,
});

const market = (title: string, over: Partial<MarketInput> = {}): MarketInput => ({
  tradeSlugs: extractTradeSlugs(title),
  latitude: null, longitude: null, department: '62', estimatedValue: null,
  deadline: '2026-12-01', requiredQualifications: null,
  ...over,
});

describe('trade normalisation', () => {
  it('maps the wording of the audit to métiers, accent and case insensitive', () => {
    expect(extractTradeSlugs('Installation de climatisation — école Michelet')).toEqual(['cvc']);
    expect(extractTradeSlugs('Maintenance chauffage/ventilation/climatisation')).toEqual(['cvc']);
    expect(extractTradeSlugs('Peinture de parties communes')).toEqual(['peinture']);
    expect(extractTradeSlugs('CLIMATISATION')).toEqual(['cvc']);
  });
  it('does not confuse look-alike words with a trade', () => {
    expect(extractTradeSlugs('Plan climat air énergie territorial')).toEqual([]);
    expect(extractTradeSlugs('Prestations de messagerie électronique')).toEqual([]);
  });
  it('uses the APE code as an indication of the company activity', () => {
    expect(tradeSlugsForCompany('43.22B')).toEqual(['cvc']);
    expect(tradeSlugsForCompany('4334Z')).toEqual(['peinture', 'vitrerie']);
  });
});

describe('evaluateMatch', () => {
  it('a heating/AC company matches a climatisation job on the métier', () => {
    const r = evaluateMatch(company(), market('Installation de climatisation — école Michelet'));
    expect(r.metierStatus).toBe('match');
    expect(r.criteria.find((c) => c.key === 'metier')!.detail).toMatch(/correspond à votre activité/);
    expect(r.score).toBe(60); // métier 40 + same-department zone 20, the rest still to confirm
  });

  it('matches a CVC maintenance job too', () => {
    expect(evaluateMatch(company(), market('Maintenance chauffage/ventilation/climatisation — INRAE')).metierStatus).toBe('match');
  });

  it('a painting job is NOT a match for a heating/AC company, however complete the notice is', () => {
    const complete = market('Peinture de parties communes — La Rochelle', { estimatedValue: 80000, latitude: 46.16, longitude: -1.15, department: '17' });
    const r = evaluateMatch(company({ latitude: 50.42, longitude: 2.95 }), complete);
    expect(r.metierStatus).toBe('mismatch');
    expect(r.score).not.toBeNull();
    expect(r.score!).toBeLessThanOrEqual(25);
    expect(r.criteria.find((c) => c.key === 'metier')!.detail).toMatch(/ne correspond pas/);
  });

  it('the length or completeness of the notice never changes the result', () => {
    const bare = evaluateMatch(company(), market('Installation de climatisation'));
    const rich = evaluateMatch(company(), market('Installation de climatisation', { estimatedValue: 350000 }));
    expect(rich.score).toBe(bare.score);
  });

  it('keeps the score null when the zone cannot be compared', () => {
    const r = evaluateMatch(company({ department: null }), market('Installation de climatisation', { department: '62' }));
    expect(r.score).toBeNull();
    expect(r.criteria.find((c) => c.key === 'zone')!.status).toBe('confirm');
  });

  it('a métier mismatch gives a low score right away, without waiting for the zone', () => {
    const r = evaluateMatch(company({ department: null }), market('Peinture de parties communes'));
    expect(r.metierStatus).toBe('mismatch');
    expect(r.score).not.toBeNull();
    expect(r.score!).toBeLessThanOrEqual(25);
  });

  it('keeps the score null when the company activity cannot be attached to a métier', () => {
    const r = evaluateMatch(company({ tradeSlugs: [] }), market('Installation de climatisation'));
    expect(r.score).toBeNull();
    expect(r.metierStatus).toBe('confirm');
  });

  it('the four answers change the criteria they concern, not a flat bonus', () => {
    const base = evaluateMatch(company(), market('Installation de climatisation'));
    const answered = evaluateMatch(company(), market('Installation de climatisation'), { experience: 'oui', capacity: 'oui', location: 'oui', calendar: 'oui' });
    expect(base.score).toBe(60);
    expect(answered.score).toBe(100);
    for (const key of ['experience', 'moyens', 'zone', 'disponibilite']) {
      const c = answered.criteria.find((x) => x.key === key)!;
      expect(c.status).toBe('match');
      expect(c.answered).toBe(true);
    }
    // an answer only touches its own criterion
    const one = evaluateMatch(company(), market('Installation de climatisation'), { experience: 'oui' });
    expect(one.score).toBe(70);
    expect(one.criteria.find((c) => c.key === 'moyens')!.status).toBe('confirm');
  });

  it('changing an answer recalculates', () => {
    const yes = evaluateMatch(company(), market('Installation de climatisation'), { calendar: 'oui' });
    const no = evaluateMatch(company(), market('Installation de climatisation'), { calendar: 'non' });
    expect(yes.score).toBe(75);
    expect(no.score).toBe(60);
    expect(no.criteria.find((c) => c.key === 'disponibilite')!.status).toBe('mismatch');
  });

  it('lets the visitor override a distance the data judged too far, and says so', () => {
    const far = market('Installation de climatisation', { latitude: 43.3, longitude: 5.4, department: '13' });
    const c = company({ latitude: 50.42, longitude: 2.95, radiusKm: 100 });
    expect(evaluateMatch(c, far).criteria.find((x) => x.key === 'zone')!.status).toBe('mismatch');
    const yes = evaluateMatch(c, far, { location: 'oui' }).criteria.find((x) => x.key === 'zone')!;
    expect(yes.status).toBe('match');
    expect(yes.detail).toMatch(/confirmé/);
  });

  it('a general contractor is a partial match for a building trade, to be confirmed', () => {
    const r = evaluateMatch(company({ tradeSlugs: ['batiment-general'] }), market('Peinture de parties communes'));
    expect(r.criteria.find((c) => c.key === 'metier')!.status).toBe('confirm');
    expect(r.score).toBe(Math.round((0.6 * 40 + 20) / 100 * 100));
  });

  it('a deadline already passed is flagged, not treated as available', () => {
    const r = evaluateMatch(company(), market('Installation de climatisation', { deadline: '2026-01-01' }), {}, new Date('2026-09-25'));
    expect(r.criteria.find((c) => c.key === 'disponibilite')!.status).toBe('mismatch');
  });

  it('never invents qualifications', () => {
    const r = evaluateMatch(company(), market('Installation de climatisation'));
    const q = r.criteria.find((c) => c.key === 'qualifications')!;
    expect(q.weight).toBe(0);
    expect(q.status).toBe('confirm');
  });

  it('gives no percentage without a company', () => {
    expect(evaluateMatch(null, market('Installation de climatisation')).score).toBeNull();
  });
});
