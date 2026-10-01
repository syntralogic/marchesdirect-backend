import { tokenizeQuery, stemOf, synonymsOf, isTradeWord, tsqueryAlternatives, matchTermsOf, FR_STOPWORDS, domainMismatchExclusion, domainMismatchExclusionSqlPattern } from '../searchQuery';

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

  it('client report (25 Sep): a short prefix ("fen") of "fenetre"/"fenetres" resolves the same as the full word', () => {
    expect(synonymsOf('fen')).toEqual(['menuiserie']);
    expect(synonymsOf('etanch')).toEqual(['etancheur']);
  });

  it('does not prefix-match below the 3-char floor', () => {
    expect(synonymsOf('fe')).toEqual([]);
  });

  it('client audit (27 Sep): "climaticien" resolves to climatisation, not just "clim"/"cvc"', () => {
    expect(synonymsOf('climaticien')).toEqual(['climatisation']);
    expect(synonymsOf('Climaticien')).toEqual(['climatisation']);
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

  it('client report (25 Sep): "elec" drops its own ambiguous prefix, matching only via "electricite" - never "electronique"', () => {
    expect(tsqueryAlternatives('elec')).toEqual(['electricite:*']);
    expect(tsqueryAlternatives('elec')).not.toContain('elec:*');
  });

  it('a non-ambiguous abbreviation like "clim" is unaffected', () => {
    expect(tsqueryAlternatives('Clim')).toContain('Clim:*');
  });

  it('client audit (27 Sep): "climaticien" now expands to itself, its (unhelpful) stem, and "climatisation"', () => {
    expect(tsqueryAlternatives('climaticien').sort()).toEqual(['climaticien:*', 'climatic:*', 'climatisation:*'].sort());
  });
});

describe('domainMismatchExclusion (27 Sep client audit, point 3: keyword hit, wrong domain)', () => {
  it('"cvc"/"ventilation" reject a biomedical-equipment notice, not a real HVAC one', () => {
    const rule = domainMismatchExclusion('cvc');
    expect(rule).not.toBeNull();
    expect(rule!.test('maintenance des equipements biomedicaux, ventilation medicale')).toBe(true);
    expect(rule!.test('remplacement de la chaudiere et des unites de ventilation du gymnase')).toBe(false);
  });

  it('"electricien" rejects a commodity energy-supply notice, not real trade work', () => {
    const rule = domainMismatchExclusion('electricien');
    expect(rule).not.toBeNull();
    expect(rule!.test("fourniture et acheminement d'electricite pour les fournisseurs d'electricite")).toBe(true);
    expect(rule!.test('mise en conformite electrique du tableau general basse tension')).toBe(false);
  });

  it('"voirie"/"vrd" reject a bare snow-clearing-equipment rental notice, not real roadwork (3rd client audit, point 6)', () => {
    const rule = domainMismatchExclusion('voirie');
    expect(rule).not.toBeNull();
    expect(rule!.test('location de materiel de deneigement sans chauffeur')).toBe(true);
    expect(rule!.test('refection de voirie et reseaux divers du lotissement')).toBe(false);
    expect(domainMismatchExclusion('vrd')).not.toBeNull();
  });

  it('returns null for a word with no domain-mismatch rule', () => {
    expect(domainMismatchExclusion('peintre')).toBeNull();
    expect(domainMismatchExclusion('bordeaux')).toBeNull();
  });

  it('the SQL pattern converts \\b to Postgres\'s \\y and stays otherwise identical', () => {
    const pattern = domainMismatchExclusionSqlPattern('cvc');
    expect(pattern).not.toBeNull();
    expect(pattern).not.toContain('\\b');
    expect(pattern).toContain('\\y');
  });

  it('null SQL pattern for a word with no rule', () => {
    expect(domainMismatchExclusionSqlPattern('peintre')).toBeNull();
  });
});

describe('matchTermsOf (ILIKE substring/prefix alternatives)', () => {
  it('client report (25 Sep): "elec" only matches through "electricite", not as a bare "elec" substring of "electronique"', () => {
    expect(matchTermsOf('elec')).toEqual(['electricite']);
    expect(matchTermsOf('elec')).not.toContain('elec');
  });

  it('a non-ambiguous word still includes its own folded form', () => {
    expect(matchTermsOf('couvreur').sort()).toEqual(['couvreur', 'couvr', 'toiture', 'couverture'].sort());
  });
});

import { lotMatchSqlPattern, lotMatchTermsOf, canMatchInsideTitle } from '../searchQuery';

describe('lot / description matching for trade words (30 Sep comparatif)', () => {
  const re = (w: string) => new RegExp((lotMatchSqlPattern(w) as string).replace(/\\y/g, '\\b'), 'i');

  it('"électricité" finds a lot Électricité CFO-CFA inside a global works title', () => {
    expect(re('électricité').test('travaux micro-tomographe lots : lot 4 electricite cfo-cfa ; lot 2 plomberie')).toBe(true);
  });
  it('accent / variant forms reach the same lots', () => {
    for (const w of ['electricite', 'électricien', 'elec']) {
      expect(re(w).test('lot 14 electricite cfo-cfa')).toBe(true);
    }
  });
  it('covers CFO/CFA, courants faibles and IRVE wording', () => {
    expect(re('électricité').test('lot 3 courants faibles')).toBe(true);
    expect(re('électricité').test('deploiement de bornes irve')).toBe(true);
  });
  it('does not match unrelated words', () => {
    expect(re('électricité').test('livraison de fournitures de bureau')).toBe(false);
    expect(re('électricité').test('messagerie electronique')).toBe(false);
  });
  it('"elec" never matches literally, only through its expansion', () => {
    expect(lotMatchTermsOf('elec')).not.toContain('elec');
  });
  it('glued reference words can be matched inside a title', () => {
    expect(canMatchInsideTitle('VALDAHON')).toBe(true);
    expect(canMatchInsideTitle('26')).toBe(false);
  });
});
