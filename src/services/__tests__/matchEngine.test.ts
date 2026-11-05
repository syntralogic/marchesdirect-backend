import { isUsableCoordinate, isPlausibleFrenchLocation, evaluateMatch, tradeSlugsForCompany, CompanyProfile, MarketInput } from '../matchEngine';
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
  annualRevenue: null, revenueEstimated: false, recentReferenceCount: null, certificationText: '',
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
  it('a vehicle purchase is not an electrical or gardening job (30 Sep audit, camion électrique)', () => {
    expect(extractTradeSlugs("Acquisition et livraison d'un camion neuf électrique avec hayon - Jardins de Nonères")).toEqual([]);
    expect(extractTradeSlugs('Achat d’un véhicule utilitaire électrique')).toEqual([]);
    // real works on electric-vehicle charging still name the métier
    expect(extractTradeSlugs('Installation de bornes de recharge électrique pour véhicules')).toEqual(['electricite']);
    expect(extractTradeSlugs('Travaux de réfection de l’installation électrique')).toEqual(['electricite']);
  });
  it('uses the APE code as an indication of the company activity', () => {
    expect(tradeSlugsForCompany('43.22B')).toEqual(['cvc']);
    expect(tradeSlugsForCompany('4334Z')).toEqual(['peinture', 'vitrerie']);
  });
});

// v28 (5 nov.) - calcul continu, déterministe, sans IA. Poids : activité 30, zone 20, moyens 15, calendrier 15,
// références 10, qualifications 10. Valeur mesurée par les données ; « oui » ≥ 0,85 ; « non » 0,1 ; inconnu 0,5 ;
// non applicable hors du dénominateur ; métier différent / zone hors de portée réduisent le total.
const NOW = new Date('2026-10-17T10:00:00Z');
const ev = (c: CompanyProfile | null, m: MarketInput, a = {}) => evaluateMatch(c, m, a, NOW);
const crit = (r: ReturnType<typeof evaluateMatch>, key: string) => r.criteria.find((c) => c.key === key)!;

describe('evaluateMatch', () => {
  it('uses the guide weights', () => {
    const r = ev(company(), market('Installation de climatisation'));
    expect(Object.fromEntries(r.criteria.map((c) => [c.key, c.weight]))).toEqual({
      metier: 30, zone: 20, experience: 10, moyens: 15, disponibilite: 15, qualifications: 10,
    });
  });

  it('a heating/AC company matches a climatisation job on the activité', () => {
    const r = ev(company(), market('Installation de climatisation — école Michelet'));
    expect(r.metierStatus).toBe('match');
    expect(crit(r, 'metier').detail).toMatch(/votre métier principal/);
    // v28 : activité 30 + zone même département 0,85 × 20 + calendrier J-45 15 + inconnus à 0,5 (références, moyens, qualifications)
    expect(r.score).toBe(80);
    expect(r.documentedCount).toBe(2);
    expect(r.toConfirmCount).toBe(4);
  });

  it('matches a CVC maintenance job too', () => {
    expect(ev(company(), market('Maintenance chauffage/ventilation/climatisation — INRAE')).metierStatus).toBe('match');
  });

  it('a painting job is NOT a match for a heating/AC company, however complete the notice is', () => {
    const complete = market('Peinture de parties communes — La Rochelle', { estimatedValue: 80000, latitude: 46.16, longitude: -1.15, department: '17' });
    const r = ev(company({ latitude: 50.42, longitude: 2.95 }), complete);
    expect(r.metierStatus).toBe('mismatch');
    expect(r.score).toBeLessThanOrEqual(5); // métier différent + 700 km : quasi nul, jamais un bon score
    expect(crit(r, 'metier').detail).toMatch(/ne correspond pas/);
    expect(r.verdict.code).toBe('REVIEW_REQUIRED');
  });

  it('the length or completeness of the notice never changes the result', () => {
    const bare = ev(company(), market('Installation de climatisation'));
    const rich = ev(company(), market('Installation de climatisation', { estimatedValue: 350000 }));
    expect(rich.score).toBe(bare.score);
  });

  it('an unknown zone is not a refusal: it earns nothing but the index is still computed', () => {
    const r = ev(company({ department: null }), market('Installation de climatisation', { department: '62' }));
    expect(crit(r, 'zone').status).toBe('confirm');
    expect(r.score).toBe(73); // zone inconnue = valeur neutre, sans réduction
  });

  it('a missing revenue figure carries no penalty of its own', () => {
    const noRevenue = ev(company({ annualRevenue: null }), market('Installation de climatisation', { estimatedValue: 350000 }));
    const m = crit(noRevenue, 'moyens');
    expect(m.evidence).toBe('unknown');
    expect(m.status).toBe('confirm');
    expect(noRevenue.score).toBe(80);
  });

  it('a métier mismatch gives a verdict of caution and no invented ceiling', () => {
    const r = ev(company({ department: null }), market('Peinture de parties communes'));
    expect(r.metierStatus).toBe('mismatch');
    expect(r.score).toBeLessThan(15); // la réduction « métier différent » écrase le total
    expect(r.adjustment).toMatch(/Activité différente/);
    expect(r.verdict.label).toBe('À étudier de près : des points demandent une vérification');
  });

  it('keeps the activity unclear when the company activity cannot be attached to a métier', () => {
    const r = ev(company({ tradeSlugs: [] }), market('Installation de climatisation'));
    expect(r.metierStatus).toBe('confirm');
    expect(r.verdict.code).toBe('ACTIVITY_UNCLEAR');
    expect(r.verdict.label).toBe('Précisons votre activité pour examiner ce marché');
  });

  it('"Oui" is a declaration (0,85 at least), never a verification', () => {
    const base = ev(company(), market('Installation de climatisation'));
    const answered = ev(company(), market('Installation de climatisation'), { experience: 'oui', capacity: 'oui', location: 'oui', calendar: 'oui' });
    expect(base.score).toBe(80);
    expect(answered.score).toBe(88); // all "Oui" never gives 100 without proof
    for (const key of ['experience', 'moyens', 'disponibilite']) {
      const c = crit(answered, key);
      expect(c.evidence).toBe('declared_match');
      expect(c.factor).toBeGreaterThanOrEqual(0.85);
      expect(c.status).toBe('confirm');
      expect(c.answered).toBe(true);
    }
    const one = ev(company(), market('Installation de climatisation'), { experience: 'oui' });
    expect(one.score).toBe(83);
    expect(crit(one, 'moyens').status).toBe('confirm');
    // le gain annoncé dans « Ce qui ferait monter votre pourcentage » est exactement celui de la réponse
    expect(base.upgrades.find((u) => u.key === 'experience')?.points).toBe(one.score! - base.score!);
  });

  it('points per criterion add up to the percentage', () => {
    const r = ev(company({ latitude: 44.8378, longitude: -0.5792, department: '33' }), market('Installation de climatisation', { latitude: 44.9233, longitude: -0.3631, department: '33' }));
    const total = r.criteria.reduce((sum, c) => sum + (c.points || 0), 0);
    expect(Math.abs(total - r.score!)).toBeLessThan(1);
    expect(r.facts.km).toBe(20);
  });

  it('changing an answer recalculates', () => {
    const yes = ev(company(), market('Installation de climatisation'), { calendar: 'oui' });
    const no = ev(company(), market('Installation de climatisation'), { calendar: 'non' });
    expect(yes.score).toBe(80); // J-45 : déjà au maximum
    expect(no.score).toBe(66);
    expect(crit(no, 'disponibilite').status).toBe('mismatch');
  });

  it('several "Non" give a cautious verdict', () => {
    const r = ev(company(), market('Installation de climatisation'), { experience: 'non', capacity: 'non', calendar: 'non' });
    expect(r.verdict.code).toBe('REVIEW_REQUIRED');
    expect(r.verdict.tone).toBe('amber');
  });

  it('an answer never silently replaces contradicting proof: it becomes a conflict to examine', () => {
    const far = market('Installation de climatisation', { latitude: 43.3, longitude: 5.4, department: '13' });
    const c = company({ latitude: 50.42, longitude: 2.95, radiusKm: 100 });
    expect(crit(ev(c, far), 'zone').status).toBe('mismatch');
    const yes = crit(ev(c, far, { location: 'oui' }), 'zone');
    expect(yes.status).toBe('mismatch');
    expect(yes.conflict).toBe(true);
    expect(yes.detail).toMatch(/examiner/);
  });

  it('a « non » about means is never overridden by general company data (chiffre d\'affaires)', () => {
    const c = company({ annualRevenue: 500000, revenueEstimated: false });
    const m = market('Installation électrique', { estimatedValue: 42600 });
    expect(crit(ev(c, m), 'moyens').status).toBe('match');
    const no = crit(ev(c, m, { capacity: 'non' }), 'moyens');
    expect(no.status).toBe('mismatch');
    expect(no.factor).toBe(0.1);
    expect(no.conflict).toBeFalsy();
    expect(no.detail).not.toMatch(/correspond/i);
  });

  it('a general contractor is a partial (declared-level) match for a building trade', () => {
    const r = ev(company({ tradeSlugs: ['batiment-general'] }), market('Peinture de parties communes'));
    expect(crit(r, 'metier').status).toBe('confirm');
    expect(r.score).toBe(42); // métier partiel 0,55 : réduction modérée
  });

  it('a deadline already passed closes the market', () => {
    const r = ev(company(), market('Installation de climatisation', { deadline: '2026-01-01' }));
    expect(crit(r, 'disponibilite').status).toBe('mismatch');
    expect(r.verdict.code).toBe('MARKET_CLOSED');
    expect(r.verdict.label).toBe('Ce marché est clôturé');
  });

  it('a mandatory condition answered "Non" surfaces first, naming the condition', () => {
    const m = market('Installation de climatisation', { mandatoryCriteria: ['experience'] });
    const r = ev(company(), m, { experience: 'non' });
    expect(r.verdict.code).toBe('MANDATORY_UNMET');
    expect(r.verdict.label).toBe('Une condition doit être vérifiée avant de candidater');
    expect(r.verdict.priorityIssue).toBe('Références');
    expect(r.mandatoryUnmet).toEqual(['Références']);
  });

  it('an activity that matches, with no mismatch, gives the positive verdict (green only on proof)', () => {
    const r = ev(company(), market('Installation de climatisation'));
    expect(r.verdict.code).toBe('ACTIVITY_MATCH');
    expect(r.verdict.label).toBe('Votre activité correspond : étudiez ce marché');
    expect(r.verdict.tone).toBe('green');
  });

  it('qualifications: unknown when the data is missing, not applicable only when the notice says none is required', () => {
    const unknown = crit(ev(company(), market('Installation de climatisation')), 'qualifications');
    expect(unknown.weight).toBe(10);
    expect(unknown.evidence).toBe('unknown');
    const none = ev(company(), market('Installation de climatisation', { requiredQualifications: 'Aucune qualification exigée' }));
    expect(crit(none, 'qualifications').evidence).toBe('not_applicable');
    expect(none.score).toBe(83); // qualifications hors calcul : poids réparti sur 90
  });

  it('gives no percentage without a company', () => {
    const r = ev(null, market('Installation de climatisation'));
    expect(r.score).toBeNull();
    expect(r.verdict.code).toBe('ACTIVITY_UNCLEAR');
  });
});


describe('zone distance guard (30 Sep audit: Bordeaux-Bordeaux at 4 988 km)', () => {
  it('treats the (0,0) geocode sentinel and out-of-range pairs as unusable', () => {
    expect(isUsableCoordinate(0, 0)).toBe(false);
    expect(isUsableCoordinate('0', '0')).toBe(false);
    expect(isUsableCoordinate(null, 2)).toBe(false);
    expect(isUsableCoordinate(95, 2)).toBe(false);
    expect(isUsableCoordinate(44.84, -0.58)).toBe(true);
  });

  it('never prints a distance when the market geocode is the (0,0) sentinel', () => {
    const c = company({ latitude: 44.84, longitude: -0.58, department: '33', radiusKm: 100 });
    const m = market('Installation de climatisation', { latitude: 0, longitude: 0, department: '33' });
    const zone = evaluateMatch(c, m).criteria.find((x) => x.key === 'zone')!;
    expect(zone.detail).not.toMatch(/km/);
    expect(zone.status).toBe('match'); // same department fallback
  });

  it('stays "to confirm" without any usable location or department', () => {
    const c = company({ latitude: 44.84, longitude: -0.58, department: null });
    const m = market('Installation de climatisation', { latitude: 0, longitude: 0, department: null });
    const zone = evaluateMatch(c, m).criteria.find((x) => x.key === 'zone')!;
    expect(zone.status).toBe('confirm');
    expect(zone.detail).toMatch(/non évaluable/);
  });
});

describe('company activity -> métier (30 Sep audit: SPIE CITYNETWORKS, réseaux électriques)', () => {
  it('maps NAF 42.22Z (dotted, as Pappers/INSEE send it) to électricité', () => {
    expect(tradeSlugsForCompany('42.22Z')).toContain('electricite');
    expect(tradeSlugsForCompany('42.22Z', 'Construction de réseaux électriques et de télécommunications')).toContain('electricite');
  });
  it('an electrical-networks company matches an IRVE (électricité) market on the métier', () => {
    const c = company({ tradeSlugs: tradeSlugsForCompany('42.22Z') });
    const m = market('Installation de bornes IRVE - travaux électriques', { department: '21' });
    expect(evaluateMatch(c, m).criteria.find((x) => x.key === 'metier')!.status).toBe('match');
  });
  it('shows the qualification the notice requires instead of "aucune"', () => {
    const m = market('Installation de bornes de recharge électrique', { requiredQualifications: 'IRVE (Qualifelec ou équivalent)' });
    const q = evaluateMatch(company({ tradeSlugs: ['electricite'] }), m).criteria.find((x) => x.key === 'qualifications')!;
    expect(q.detail).toMatch(/IRVE/);
    expect(q.detail).not.toMatch(/Aucune qualification/);
  });
});

describe('distance plausibility (1 Oct client report)', () => {
  it('rejects a homonym geocoded abroad and accepts real French points', () => {
    expect(isPlausibleFrenchLocation(44.84, -0.58, '33')).toBe(true);      // Bordeaux, France
    expect(isPlausibleFrenchLocation(46.9, -71.1, '33')).toBe(false);      // a Bordeaux in Canada
    expect(isPlausibleFrenchLocation(0, 0, '33')).toBe(false);
    expect(isPlausibleFrenchLocation(14.6, -61.0, '972')).toBe(true);      // Martinique
    expect(isPlausibleFrenchLocation(14.6, -61.0, '33')).toBe(false);
  });
  it('shows no distance when one of the two locations is implausible', () => {
    const c = company({ latitude: 44.84, longitude: -0.58, department: '33', radiusKm: 50 });
    const m = market('Peinture de locaux', { latitude: 4.9, longitude: 8.3, department: '33' });
    const ev = evaluateMatch(c, m);
    const zone = ev.criteria.find((x: any) => x.key === 'zone');
    expect(zone?.detail).not.toMatch(/\d{4} km/);
  });

  it('a market with nothing established still gets a provisional percentage (guide s.5), never a blank ring', () => {
    // no métier link on the market, company with no zone/revenue/reference/qualification evidence
    const c = company({ department: null, tradeSlugs: [], annualRevenue: null });
    const r = ev(c, { ...market('Conception et animation du stand de l\'ODEADOM au SIA 2026'), tradeSlugs: [], department: null, deadline: null });
    expect(r.score).toBe(22); // tout inconnu : valeurs neutres, activité non identifiable réduite — jamais un anneau vide
    expect(r.documentedCount).toBe(0);
    expect(r.toConfirmCount).toBeGreaterThan(0);
    expect(r.verdict.label).toMatch(/Précisons votre activité/);
  });

  it('still no percentage without an identified company', () => {
    expect(ev(null, market('Installation de climatisation')).score).toBeNull();
  });
});
