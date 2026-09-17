// Contre-audit 15 Sep 2026, ticket R07: notice titles from BOAMP/DECP/TED
// sometimes carry raw, undecoded HTML/XML character references - the
// client's example was literally "&#8211;" (an en dash) showing up as text
// instead of "–" in search results. Source notices are entered via web
// forms elsewhere in the public-procurement ecosystem and evidently aren't
// always re-encoded before reaching the open-data feeds we ingest, so this
// decodes on our side rather than assuming upstream data is always clean
// text.
//
// Deliberately narrow: numeric character references (decimal &#8211; and
// hex &#x2013;) plus the five HTML-spec named entities that actually show
// up in prose (amp/lt/gt/quot/apos). NOT a general mojibake repair - the
// audit's other examples ("d¿un", "L¿ECOLE") look like a source-encoding
// mismatch (an apostrophe or similar byte misread as U+00BF), but without
// being able to inspect the actual raw bytes from BOAMP/DECP/TED (not
// reachable from this sandbox's network egress allowlist - see the
// HONESTY NOTE on collectBatiwebData in dataCollectionService.ts for the
// same constraint), a blind "fix" risks silently corrupting other
// correctly-encoded text instead. That part needs a raw sample from one of
// the affected notices before a real fix can be written with confidence.
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

export const decodeHtmlEntities = (text: string | null | undefined): string | null | undefined => {
  if (!text || typeof text !== 'string' || text.indexOf('&') === -1) return text;
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, ref: string) => {
    if (ref[0] === '#') {
      const isHex = ref[1] === 'x' || ref[1] === 'X';
      const codePoint = parseInt(ref.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      if (Number.isNaN(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return match;
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return match;
      }
    }
    return NAMED_ENTITIES[ref] ?? match;
  });
};

// A single oversized field (e.g. a BOAMP `location_city` falling back to a
// long buyer/institution name - "Communauté de Communes du Pays de la
// Vallée de ... - Service de la Commande Publique" easily clears 255
// chars) was throwing "value too long for type character varying(255)" on
// the INSERT - and since opportunities are inserted one row per statement
// here, that error killed the ENTIRE notice, not just the long field, so a
// real, legitimate public-procurement opportunity silently never made it
// onto the site. Truncating defensively at the DB boundary means a messy
// source value shortens instead of discarding the whole opportunity - used
// wherever a VARCHAR-limited column gets a value from source data that
// isn't already guaranteed to fit (see insertOpportunity/
// bulkUpsertOpportunities in dataCollectionService.ts).
export const truncateForColumn = (
  value: string | null | undefined,
  maxLen: number
): string | null | undefined => {
  if (!value || typeof value !== 'string') return value;
  return value.length > maxLen ? value.slice(0, maxLen) : value;
};
