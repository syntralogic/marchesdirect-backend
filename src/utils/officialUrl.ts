// Builds the link back to the official notice (BOAMP/TED/PLACE/DECP) shown
// on the fiche. Client's audit (6 Sep) flagged this as one of the fields
// missing entirely - the fiche currently has no way to cross-check against
// the source.
//
// Only builds a URL when we actually know the source's real, documented
// scheme for a given identifier - same "don't invent data" rule the rest of
// the normalizers already follow (see normalizeDecpRecord's comment on
// buyer_name/location_city). A source with no confirmed public per-notice
// URL scheme (DECP; PLACE beyond whatever its own API returns) gets null
// rather than a guessed link that might 404.

export const buildOfficialUrl = (
  sourceCode: string,
  sourceReference: string | null | undefined,
  raw?: any
): string | null => {
  if (!sourceReference) return null;

  switch (sourceCode) {
    case 'boamp':
      // BOAMP's own stable notice identifier (idweb) resolves on the public
      // site via its search-by-idweb query param.
      return `https://www.boamp.fr/pages/avis/?q=idweb:${encodeURIComponent(sourceReference)}`;

    case 'ted':
      // TED (eForms-era "new TED") notice detail page, keyed by
      // publication-number. Language segment defaults to French since the
      // rest of the site is FR-only; TED redirects to an available
      // translation if 'fr' isn't published for that notice.
      return `https://ted.europa.eu/fr/notice/-/detail/${encodeURIComponent(sourceReference)}`;

    case 'place':
      // PLACE's API response sometimes includes its own canonical link -
      // use that verbatim rather than guessing a URL scheme for a source
      // that isn't even active in data_sources yet.
      return raw?.url || raw?.notice_url || null;

    case 'decp':
    case 'batiweb':
    default:
      // No confirmed stable per-notice public URL for these sources.
      return null;
  }
};
