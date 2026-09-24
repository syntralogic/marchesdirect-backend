import { tradeMatchStrength, criteriaFromFacts } from '../matchScoreService';

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
