import { suggestPhrases } from '../tradeSuggestions';

// 26 Sep client spec ("ELE" -> électricité générale/industrielle/courants
// faibles/bornes de recharge; "ET" -> étanchéité...), accent/case-insensitive,
// updating from the first letters typed.

describe('suggestPhrases', () => {
  it('matches the client\'s own ELE example, in the order they demoed', () => {
    const labels = suggestPhrases('ELE').map((s) => s.label);
    expect(labels).toContain('Électricité générale');
    expect(labels).toContain('Électricité industrielle');
    expect(labels).toContain('Électricité — courants faibles');
    expect(labels).toContain('Électricité — bornes de recharge');
    expect(labels.indexOf('Électricité générale')).toBeLessThan(labels.indexOf('Électricité industrielle'));
  });

  it('matches the client\'s own ET example (étanchéité)', () => {
    const labels = suggestPhrases('ET').map((s) => s.label);
    expect(labels.some((l) => l.startsWith('Étanchéité'))).toBe(true);
  });

  it('is accent-insensitive both ways', () => {
    const withAccent = suggestPhrases('élec').map((s) => s.label);
    const without = suggestPhrases('elec').map((s) => s.label);
    expect(withAccent).toEqual(without);
    expect(withAccent.length).toBeGreaterThan(0);
  });

  it('is case-insensitive', () => {
    expect(suggestPhrases('ELECTRICITE')).toEqual(suggestPhrases('electricite'));
  });

  it('finds a common variant word, not just the trade name itself', () => {
    const labels = suggestPhrases('electricien').map((s) => s.label);
    expect(labels).toContain('Électricien');
  });

  it('updates as more letters are typed (prefix, not fuzzy)', () => {
    const clim = suggestPhrases('clim').map((s) => s.label);
    expect(clim.some((l) => l.toLowerCase().includes('climatisation'))).toBe(true);
    // A completely different trade must not show up
    expect(clim.some((l) => l.toLowerCase().includes('peinture'))).toBe(false);
  });

  it('does not confuse a look-alike word with a real trade', () => {
    const labels = suggestPhrases('plan climat').map((s) => s.label);
    expect(labels).toEqual([]);
  });

  it('returns nothing for a query shorter than 2 letters', () => {
    expect(suggestPhrases('e')).toEqual([]);
    expect(suggestPhrases('')).toEqual([]);
  });

  it('resolves every suggested phrase to a real trade slug', () => {
    const REAL_SLUGS = new Set([
      'gros-oeuvre', 'demolition', 'maconnerie', 'charpente', 'couverture', 'electricite',
      'plomberie', 'cvc', 'isolation', 'platrerie', 'menuiserie', 'carrelage', 'peinture',
      'vitrerie', 'vrd', 'batiment-general', 'espaces-verts', 'nettoyage', 'maintenance',
    ]);
    for (const q of ['ele', 'et', 'clim', 'fen', 'iso', 'peint', 'menuis', 'carrel', 'nett']) {
      for (const s of suggestPhrases(q)) {
        expect(REAL_SLUGS.has(s.tradeSlug)).toBe(true);
      }
    }
  });

  it('caps results at the requested limit', () => {
    expect(suggestPhrases('e', 3).length).toBeLessThanOrEqual(3);
    // 'e' itself is under the 2-letter floor, use a broader real prefix
    expect(suggestPhrases('me', 3).length).toBeLessThanOrEqual(3);
  });
});
