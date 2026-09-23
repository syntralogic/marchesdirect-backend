import { tokenizeQuery, stemOf, synonymsOf, isTradeWord, tsqueryAlternatives, FR_STOPWORDS } from '../searchQuery';

// 20 Sep client audit ("valider sur l'ensemble des métiers... préparer des
// tests avec plusieurs formulations et localisations... conserver ces
// tests"). These lock in the exact reported cases so a future change to the
// search query logic can't silently reintroduce them.

describe('tokenizeQuery', () => {
  it('drops filler words but keeps the meaningful ones (client: "Installation et maintenance de climatisation")', () => {
    expect(tokenizeQuery('Installation et maintenance de climatisation')).toEqual(['Installation', 'maintenance', 'climatisation']);
  });

  it('treats apostrophes as separators instead of gluing words together', () => {
    expect(tokenizeQuery("l'eau potable")).toEqual(['eau', 'potable']);
  });

  it('strips a bare hyphen instead of producing a to_tsquery syntax error', () => {
    expect(tokenizeQuery('chauffage - climatisation')).toEqual(['chauffage', 'climatisation']);
    expect(tokenizeQuery('-')).toEqual([]);
  });

  it('falls back to the raw words when the query is only stopwords, rather than matching everything', () => {
    expect(tokenizeQuery('de la')).toEqual(['de', 'la']);
  });

  it('single-word queries are unaffected (direct typing, e.g. "peintre")', () => {
    expect(tokenizeQuery('peintre')).toEqual(['peintre']);
  });

  it('every stopword folds to lowercase for the drop check', () => {
    expect(tokenizeQuery('Les Travaux Du Batiment')).toEqual(['Travaux', 'Batiment']);
    expect([...FR_STOPWORDS]).toContain('les');
  });
});

describe('stemOf (agent-noun -> trade-noun bridge)', () => {
  it.each([
    ['peintre', 'peint'],
    ['electricien', 'electric'],
    ['plombier', 'plomb'],
    ['carreleur', 'carrel'],
  ])('%s stems to %s so it can OR-match the trade-name form', (word, expected) => {
    expect(stemOf(word)).toBe(expected);
  });

  it('returns null when there is no agent suffix to strip', () => {
    expect(stemOf('climatisation')).toBeNull();
    expect(stemOf('menuiserie')).toBeNull();
  });

  it('does not strip below the 4-letter floor', () => {
    // "cour" ends in no agent suffix long enough to leave >=4 letters after stripping
    expect(stemOf('mur')).toBeNull();
  });
});

describe('synonymsOf (référentiel de synonymes/abréviations)', () => {
  it('client\'s named examples: ITE, Clim, couvreur', () => {
    expect(synonymsOf('ITE')).toEqual(['isolation', 'exterieur']);
    expect(synonymsOf('Clim')).toEqual(['climatisation']);
    expect(synonymsOf('couvreur')).toEqual(['toiture', 'couverture']);
  });

  it('is accent/case-insensitive', () => {
    expect(synonymsOf('ÉLECTRICIEN')).toEqual(['electricite']);
  });

  it('returns empty for a word with no entry, not undefined/throw', () => {
    expect(synonymsOf('bordeaux')).toEqual([]);
    expect(synonymsOf('')).toEqual([]);
  });
});

describe('isTradeWord (title/AI-classification gate for a métier word)', () => {
  it('recognises the word itself, its synonyms, and its stem as naming a métier', () => {
    expect(isTradeWord('clim')).toBe(true);
    expect(isTradeWord('couvreur')).toBe(true);
    expect(isTradeWord('electricien')).toBe(true); // stems to "electric", not directly in the map
  });

  it('client\'s exact case: "fenêtre" is a trade word (menuiserie), "électricité" search should not casually match it either way', () => {
    expect(isTradeWord('fenêtre')).toBe(true);
    expect(isTradeWord('fenetres')).toBe(true); // plural, accent-stripped
  });

  it('does not treat an ordinary non-trade word as a métier concept', () => {
    expect(isTradeWord('bordeaux')).toBe(false);
    expect(isTradeWord('travaux')).toBe(false); // generic, deliberately not in the référentiel
  });
});

describe('tsqueryAlternatives (what a word actually expands to in the search)', () => {
  it('"Clim" expands to itself and its synonym, not just the literal word', () => {
    expect(tsqueryAlternatives('Clim').sort()).toEqual(['Clim:*', 'climatisation:*'].sort());
  });

  it('"peintre" expands to itself and its stem, with no synonym entry', () => {
    expect(tsqueryAlternatives('peintre').sort()).toEqual(['peint:*', 'peintre:*'].sort());
  });

  it('a word with neither a stem nor a synonym expands to just itself', () => {
    expect(tsqueryAlternatives('Bordeaux')).toEqual(['Bordeaux:*']);
  });

  it('"couvreur" (client\'s example) expands to itself, its stem, and the canonical trade names', () => {
    expect(tsqueryAlternatives('couvreur').sort()).toEqual(['couvreur:*', 'couvr:*', 'toiture:*', 'couverture:*'].sort());
  });
});
