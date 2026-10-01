import { tradeMatchStrength, criteriaFromFacts, sirenFromSiret, baseRequiredDocs } from '../matchScoreService';

// Ticket C04: "score de correspondance excessif sur des activités sans
// rapport (92%, 100%)". In the personalized branch the cause was a 5-char
// prefix comparison between the company's sector and the trade name.

describe('tradeMatchStrength', () => {
  it('no longer matches unrelated activities that share a 5-letter prefix', () => {
    // The reported shape of the bug: "Électricité".slice(0,5) === "élect",
    // which "Électroménager" contains.
    expect(tradeMatchStrength('Électroménager', 'Électricité')).toBe('none');
    expect(tradeMatchStrength('Menuiserie bois', 'Menuiserie métallique')).toBe('strong');
  });

  it('still matches a genuine sector/trade pair, accents and case folded', () => {
    expect(tradeMatchStrength('Peinture et revêtements', 'Peinture')).toBe('strong');
    expect(tradeMatchStrength('PLOMBERIE', 'Plomberie / chauffage')).toBe('strong');
    expect(tradeMatchStrength('Maconnerie generale', 'Maçonnerie')).toBe('strong');
  });

  it('falls back to the AI matched-trades list as a weaker signal', () => {
    expect(
      tradeMatchStrength('Carrelage', 'Second œuvre', [{ trade_id: 4, name: 'Carrelage', confidence: 0.9 }])
    ).toBe('partial');
  });

  it('does not match on generic procurement filler alone', () => {
    expect(tradeMatchStrength('Travaux divers', 'Travaux de voirie')).toBe('none');
    expect(tradeMatchStrength('Services generaux', 'Services de nettoyage')).toBe('none');
  });

  it('returns none when the company has no declared sector', () => {
    expect(tradeMatchStrength(null, 'Peinture')).toBe('none');
    expect(tradeMatchStrength('', 'Peinture')).toBe('none');
  });

  it('survives a malformed ai_matched_trades value', () => {
    const circular: any = {};
    circular.self = circular;
    expect(tradeMatchStrength('Peinture', 'Second œuvre', circular)).toBe('none');
  });
});

// 27 Sep client audit, point 7 (CLIM+): a company's own SIRET stored with
// spacing/punctuation never matched the digits-only SIREN key that
// /api/siret/lookup caches Pappers/INSEE data under, so the fiche's company
// card could show an activity that this match score could never see.
// 3rd client audit, point 8: "assurance décennale" on a book-acquisition
// dossier, standard bâtiment justificatifs on a biomedical-maintenance one -
// required documents must follow the market's actual nature, not assume travaux.
describe('baseRequiredDocs', () => {
  it('asks for RC décennale on a travaux market (and when nature is unknown)', () => {
    const labels = baseRequiredDocs('public_procurement', null, 'travaux').map((d) => d.label);
    expect(labels).toContain('Assurance décennale');
    expect(baseRequiredDocs('public_procurement', null, null).map((d) => d.label)).toContain('Assurance décennale');
  });

  it('does not ask for RC décennale on a fournitures market (acquisition de livres)', () => {
    const docs = baseRequiredDocs('public_procurement', null, 'fournitures');
    const labels = docs.map((d) => d.label);
    expect(labels).not.toContain('Assurance décennale');
    expect(labels.some((l) => l.includes('responsabilité civile professionnelle'))).toBe(true);
    expect(labels.some((l) => l.includes('livraison'))).toBe(true);
  });

  it('does not ask for RC décennale on a services market (biomedical maintenance)', () => {
    const docs = baseRequiredDocs('public_procurement', null, 'services');
    const labels = docs.map((d) => d.label);
    expect(labels).not.toContain('Assurance décennale');
    expect(labels.some((l) => l.includes('prestation comparable'))).toBe(true);
  });

  it('asks for a mission reference, not a chantier one, on an études market', () => {
    const labels = baseRequiredDocs('public_procurement', null, 'etudes').map((d) => d.label);
    expect(labels.some((l) => l.includes('mission comparable'))).toBe(true);
  });

  it('still names the trade-specific qualification when a trade is known, regardless of nature', () => {
    const labels = baseRequiredDocs('public_procurement', 'Peinture', 'fournitures').map((d) => d.label);
    expect(labels).toContain('Qualification Peinture ou équivalent');
  });
});

describe('sirenFromSiret', () => {
  it('strips spaces from a grouped SIRET', () => {
    expect(sirenFromSiret('123 456 789 00012')).toBe('123456789');
  });

  it('strips dots and hyphens too', () => {
    expect(sirenFromSiret('123.456.789.00012')).toBe('123456789');
    expect(sirenFromSiret('123-456-789-00012')).toBe('123456789');
  });

  it('accepts an already-clean SIRET or bare SIREN', () => {
    expect(sirenFromSiret('12345678900012')).toBe('123456789');
    expect(sirenFromSiret('123456789')).toBe('123456789');
  });

  it('returns null when there is not enough to form a SIREN', () => {
    expect(sirenFromSiret(null)).toBeNull();
    expect(sirenFromSiret('')).toBeNull();
    expect(sirenFromSiret('1234')).toBeNull();
  });
});

// 25 Sep client audit (INRAE): a generic 40/40/20 table was shown as the
// buyer's own weighting while the notice says 60 % prix / 40 % technique.
describe('criteriaFromFacts', () => {
  it('returns the buyer criteria exactly as extracted from the notice', () => {
    const facts = { selection_criteria: { available: true, value: [
      { label: 'Prix', weight_percent: 60, not_specified: false },
      { label: 'Valeur technique', weight_percent: 40, not_specified: false },
    ] } };
    expect(criteriaFromFacts(facts)).toEqual([
      { label: 'Prix', weight: 60 },
      { label: 'Valeur technique', weight: 40 },
    ]);
  });

  it('never invents a weighting when none was extracted', () => {
    expect(criteriaFromFacts(null)).toEqual([]);
    expect(criteriaFromFacts({})).toEqual([]);
    expect(criteriaFromFacts({ selection_criteria: { available: false, value: [] } })).toEqual([]);
    expect(criteriaFromFacts('not json')).toEqual([]);
  });

  it('keeps a named criterion whose weight is not stated as null', () => {
    const facts = { selection_criteria: { available: true, value: [{ label: 'Délais', weight_percent: null, not_specified: true }] } };
    expect(criteriaFromFacts(facts)).toEqual([{ label: 'Délais', weight: null }]);
  });

  it('accepts facts stored as a JSON string', () => {
    const facts = JSON.stringify({ selection_criteria: { available: true, value: [{ label: 'Prix', weight_percent: 100 }] } });
    expect(criteriaFromFacts(facts)).toEqual([{ label: 'Prix', weight: 100 }]);
  });
});

describe('marketTradeSlugs reads lots (30 Sep comparatif)', () => {
  const { marketTradeSlugs } = require('../matchScoreService');
  it('a global works title with an électricité lot names électricité', () => {
    const opp = { title: 'Travaux pour un micro-tomographe', description: 'Travaux\n\nLots : Lot 1 : Gros oeuvre ; Lot 5 : Electricité CFO-CFA' };
    expect(marketTradeSlugs(opp, null)).toContain('electricite');
  });
  it('a vehicle purchase still names no métier', () => {
    const opp = { title: 'Acquisition et livraison d’un camion neuf électrique - Jardins de Nonères', description: '' };
    expect(marketTradeSlugs(opp, null)).toEqual([]);
  });
});
