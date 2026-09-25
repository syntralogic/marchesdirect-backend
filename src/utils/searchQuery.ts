// ============================================================================
// SEARCH QUERY TOKENIZATION - pure logic extracted out of routes/opportunities.ts
//
// Client (20 Sep audit, search overhaul, point 8): "valider sur l'ensemble
// des métiers... préparer des tests avec plusieurs formulations et
// localisations... conserver ces tests pour éviter que les problèmes
// réapparaissent après une mise à jour." This logic decides which notices a
// free-text search word matches (stopwords, accent/plural folding, the
// synonym/abbreviation référentiel, and which words count as naming a
// métier at all) and used to live inline inside the route handler, where it
// could only ever be exercised by hitting a live database. Pulled out here,
// unchanged, so it can be unit-tested directly - see
// __tests__/searchQuery.test.ts for the regression cases the audits reported
// (peintre/peinture, "Clim" vs "Installation et maintenance de
// climatisation", ITE, couvreur, fenêtre-vs-électricité lot mixing).
//
// opportunities.ts imports every export below instead of redefining them -
// there is exactly one copy of this logic.
// ============================================================================

export const FR_STOPWORDS = new Set([
  'de', 'du', 'des', 'la', 'le', 'les', 'et', 'en', 'au', 'aux', 'pour', 'avec', 'un', 'une', 'sur', 'dans', 'd', 'l',
]);

export const foldAccents = (v: string): string =>
  v.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/**
 * Splits a raw search-box query into meaningful words: apostrophes treated
 * as separators (so "l'eau" doesn't glue into "leau"), punctuation and
 * leading/trailing hyphens stripped, stopwords dropped unless removing them
 * would leave nothing at all (a query that is only stopwords still has to
 * search on something rather than silently matching everything).
 */
export function tokenizeQuery(q: string): string[] {
  const qWordsRaw = q
    .replace(/['\u2019`]/g, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}-]/gu, '').replace(/^-+|-+$/g, '').trim())
    .filter(Boolean);
  const qWordsMeaningful = qWordsRaw.filter((w) => !FR_STOPWORDS.has(w.toLowerCase()));
  return qWordsMeaningful.length > 0 ? qWordsMeaningful : qWordsRaw;
}

// A profession typed the way people say it ("peintre", "electricien",
// "plombier", "carreleur") never shares a French-stemmer stem with the
// trade/notice wording ("Peinture", "Electricite", "Plomberie", "Carrelage").
const AGENT_SUFFIXES = ['ienne', 'ien', 'iere', 'ier', 'euse', 'eur', 'iste', 're'];

export const stemOf = (w: string): string | null => {
  const f = foldAccents(w);
  for (const suf of AGENT_SUFFIXES) {
    if (f.endsWith(suf) && f.length - suf.length >= 4) return f.slice(0, f.length - suf.length);
  }
  return null;
};

// Client (19 Sep, référentiel de synonymes/abréviations, points 3/4): "ITE",
// "Clim" and "isolation thermique" as examples of poor matching. Stemming
// handles word-forms of the SAME word (peintre/peinture); an acronym like
// "ITE" shares no letters with "isolation" at all and can only come from an
// explicit lookup.
export const TRADE_KEYWORD_SYNONYMS: Record<string, string[]> = {
  ite: ['isolation', 'exterieur'],
  iti: ['isolation', 'interieur'],
  clim: ['climatisation'],
  cvc: ['climatisation', 'chauffage', 'ventilation'],
  vmc: ['ventilation'],
  pac: ['pompe', 'chaleur'],
  couvreur: ['toiture', 'couverture'],
  toiture: ['couverture'],
  etancheite: ['etancheur'],
  macon: ['maconnerie'],
  elec: ['electricite'],
  electricien: ['electricite'],
  plombier: ['plomberie'],
  chauffagiste: ['chauffage'],
  menuisier: ['menuiserie'],
  fenetre: ['menuiserie'],
  fenetres: ['menuiserie'],
  carreleur: ['carrelage'],
  platrier: ['platrerie'],
  placo: ['platrerie'],
  placoplatre: ['platrerie'],
  vrd: ['voirie', 'reseaux'],
  terrassement: ['vrd'],
  proprete: ['nettoyage'],
  paysagiste: ['espaces', 'verts'],
  paysagisme: ['espaces', 'verts'],
};

export const synonymsOf = (w: string): string[] => TRADE_KEYWORD_SYNONYMS[foldAccents(w).toLowerCase()] || [];

// Client report (25 Sep): searching "elec" (or "Électricité", which folds
// to the same lookup) surfaced "électronique" notices - unrelated to the
// requested trade. Cause: "elec" is a literal substring of "electronique"
// once accents are stripped, and the raw typed word is always included
// as one of the OR'd match alternatives alongside its synonym expansion
// (see matchTermsOf/tsqueryAlternatives below) - so the short abbreviation
// itself, not just its "electricite" synonym, was doing the matching.
// Listed explicitly (real known collisions) rather than inferred from
// word length, since prefix/substring matching the raw word is exactly
// right for most synonym keys ("clim" -> matches "climatiseur" fine, no
// unrelated trade starts with "clim").
export const AMBIGUOUS_ABBREVIATIONS = new Set(['elec']);

// The folded terms (itself, its stem, its synonyms) a word should be
// substring/prefix-matched against - with a known-ambiguous abbreviation's
// own literal form left out (see AMBIGUOUS_ABBREVIATIONS above), so it can
// only ever match through its synonym expansion. Shared by the ILIKE
// patterns built in opportunities.ts and by tsqueryAlternatives below, so
// the fix applies everywhere a word can match a notice.
export function matchTermsOf(w: string): string[] {
  const stem = stemOf(w);
  const syns = synonymsOf(w);
  const folded = foldAccents(w).toLowerCase();
  const includeRaw = !AMBIGUOUS_ABBREVIATIONS.has(folded);
  return [...(includeRaw ? [foldAccents(w)] : []), ...(stem ? [stem] : []), ...syns];
}

const TRADE_CONCEPT_TOKENS = new Set(
  Object.values(TRADE_KEYWORD_SYNONYMS).flat().concat(Object.keys(TRADE_KEYWORD_SYNONYMS))
);

// Client (19/20 Sep, search overhaul points 2 & 5): "Un lot électricité ne
// doit pas ressortir pour « fenêtre » simplement parce que le descriptif
// général du chantier mentionne des fenêtres." Used by the route to decide
// which query words are only allowed to match in the TITLE (or an AI trade
// match) rather than anywhere in a long description - see opportunities.ts
// for why a real per-lot data model isn't attempted here.
export const isTradeWord = (w: string): boolean => {
  if (synonymsOf(w).length > 0) return true;
  const folded = foldAccents(w).toLowerCase();
  if (TRADE_CONCEPT_TOKENS.has(folded)) return true;
  const stem = stemOf(w);
  return !!stem && TRADE_CONCEPT_TOKENS.has(stem);
};

/**
 * The OR-of-alternatives group (word itself, its stem, its synonyms) that
 * the route AND's together across words for a to_tsquery expression, e.g.
 * "clim" -> "(clim:* | climatisation:*)". Exposed standalone so the exact
 * expansion the search actually runs against a word is what gets tested,
 * not a re-derivation of it.
 */
export function tsqueryAlternatives(w: string): string[] {
  const stem = stemOf(w);
  const syns = synonymsOf(w);
  const folded = foldAccents(w).toLowerCase();
  const includeRaw = !AMBIGUOUS_ABBREVIATIONS.has(folded);
  return [...(includeRaw ? [`${w}:*`] : []), ...(stem ? [`${stem}:*`] : []), ...syns.map((s) => `${s}:*`)];
}
