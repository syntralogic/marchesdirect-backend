// ============================================================================
// NATURE DE LA PRESTATION - heuristic fallback + shared SQL expression
// ============================================================================
//
// Contre-audit 15 Sep 2026, ticket R02: searching "espaces verts" still
// returns vehicle/machinery spare-part notices mixed in with the actual
// landscaping work. Those rows are not homonyms (R03's problem) and not a
// wrong métier either - "Fourniture de pièces détachées pour matériels
// espaces verts" really is an espaces-verts notice. It is the *nature of
// the prestation* that is wrong for someone looking for work to bid on:
// it's a parts purchase, not a landscaping contract.
//
// commit 32a6bd8 added the `nature_prestation` column and taught
// classifyOpportunity() to fill it, and opportunities.ts demotes
// fournitures/études when a métier is being searched. Why that wasn't
// enough in practice:
//   1. The column is only populated by the AI classification pass. The
//      ~47k pre-existing rows are still NULL, and the audit deliberately
//      does not push NULL rows down (it can't tell "not supplies" from
//      "not looked at yet"), so for most of the corpus the demotion is a
//      no-op - which is exactly what the tester saw.
//   2. It was only ever a *tiebreaker*. A visitor who explicitly wants
//      travaux had no way to say so and simply exclude the rest.
//
// This module fixes both: a deterministic, no-AI fallback that resolves a
// nature for rows the classifier hasn't reached yet (so the demotion works
// today, on the whole corpus), and a single shared expression so the same
// resolved value drives the new explicit `nature` filter, the ranking, and
// what the API returns to the UI.
//
// Deliberately conservative: the patterns below only fire on wording that
// is unambiguous in French public-procurement notices. Anything it can't
// read confidently resolves to NULL and is treated exactly as it is today
// (ranked alongside travaux, never hidden). A heuristic that guessed
// aggressively would silently drop real work from results, which is a far
// worse failure than the one being fixed.

// 25 Sep client audit, point 7: "Ajouter Services aux natures de
// prestations : nettoyage et maintenance ne se résument pas aux travaux ou
// fournitures." A cleaning/gardiennage/collecte contract is recurring
// service delivery, not on-site construction work (travaux) and not a
// goods purchase (fournitures) - lumping it into travaux is exactly the
// kind of mismatch the concordance work elsewhere in this audit was fixing.

/** The five values classifyOpportunity() is allowed to store (see aiService.ts). */
export const NATURE_VALUES = ['travaux', 'fournitures', 'etudes', 'mixte', 'services'] as const;
export type NaturePrestation = (typeof NATURE_VALUES)[number];

export function isNaturePrestation(value: unknown): value is NaturePrestation {
  return typeof value === 'string' && (NATURE_VALUES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------
// Written unaccented/lowercase: both the TS and the SQL path normalise the
// text first (lower(unaccent(...))), so "rénovation" and "renovation",
// "pièces" and "pieces" hit the same pattern. Same normalisation rationale
// as the R11 accent-folding fix (commit a4e9b07).

/**
 * A supply purchase that is explicitly *also* an installation/works job -
 * "fourniture et pose de menuiseries" is travaux, not fournitures. Checked
 * before the supply patterns so the leading "fourniture" doesn't win.
 */
const SUPPLY_WITH_WORKS =
  /\b(et|avec)\s+(la\s+)?(pose|installation|mise\s+en\s+(oeuvre|service)|remplacement|montage|raccordement)\b/;

/** Unambiguous "this is a purchase of goods" wording. */
const SUPPLY_PATTERNS: RegExp[] = [
  // Notices that *open* with the purchase verb - the strongest signal there is.
  /^\s*(fourniture|fournitures|acquisition|achat|approvisionnement)\b/,
  /\bpieces?\s+detachees?\b/,
  /\bconsommables?\b/,
  /\bfournitures?\s+de\s+bureau\b/,
  /\bmobilier\s+(de|scolaire|urbain|de\s+bureau)\b/,
  /\bcarburants?\b/,
  /\b(fourniture|livraison)\s+de\s+(materiel|materiels|equipement|equipements|produits|vehicules)\b/,
];

/** Intellectual / advisory missions rather than execution. */
const STUDY_PATTERNS: RegExp[] = [
  /\bmaitrise\s+d'?\s*oeuvre\b/,
  /\bassistance\s+a\s+maitrise\s+d'?\s*ouvrage\b/,
  /\b(amo|moe)\b/,
  /\betudes?\s+(de|d'|prealable|preliminaire|technique|diagnostic|faisabilite)\b/,
  /\bmission\s+de\s+(diagnostic|controle\s+technique|coordination)\b/,
  /\bcoordination\s+sps\b/,
  /\bdiagnostic\s+(amiante|plomb|energetique|technique)\b/,
  /\baudit\s+(energetique|technique|organisationnel)\b/,
  /\bleve\s+topographique\b/,
  /\bmaitrise\s+d'?\s*oeuvre\b/,
];

/**
 * Recurring service delivery: cleaning, security, catering, collection,
 * technical-equipment upkeep (CVC/chauffage/ascenseurs, as opposed to the
 * building-fabric upkeep already covered by WORKS_PATTERNS below) and other
 * prestations that are neither a one-off construction job nor a goods
 * purchase. This is what the client's "peinture" vs "chauffagiste" example
 * (point 3 of the same audit) was really asking to be told apart from
 * travaux - a maintenance *contract* is a services market, not a worksite.
 */
const SERVICES_PATTERNS: RegExp[] = [
  /\bnettoyage\s+(de\s+)?(locaux|batiments?|vitres?|voirie)?\b/,
  /\b(gardiennage|surveillance|telesurveillance)\b/,
  /\brestauration\s+(collective|scolaire)\b/,
  /\bcollecte\s+(des?\s+|et\s+traitement\s+des?\s+)?dechets\b/,
  /\bblanchisserie\b/,
  /\baccueil\s+et\s+standard|standard\s+telephonique\b/,
  /\b(maintenance|entretien)\s+(du\s+|des\s+|de\s+la\s+|de\s+l'|d'|des\s+installations?\s+de\s+)?(chauffage|climatisation|ventilation|cvc|chaudieres?|ascenseurs?|extincteurs?|desenfumage)\b/,
  /\btransport\s+(scolaire|de\s+personnes|sanitaire)\b/,
  /\bprestations?\s+de\s+services?\b/,
  /\bexploitation\s+(et\s+maintenance\s+)?(du\s+|des\s+)?(chauffage|reseau\s+de\s+chaleur)\b/,
];

/** Execution on site. */
const WORKS_PATTERNS: RegExp[] = [
  /\btravaux\b/,
  /\b(rehabilitation|renovation|refection|restructuration|demolition|desamiantage)\b/,
  /\bconstruction\s+(d'|de|du|des)\b/,
  /\b(amenagement|extension|surelevation)\s+(d'|de|du|des)\b/,
  /\bpose\s+(d'|de|du|des)\b/,
  /\b(entretien|maintenance)\s+(des?\s+)?(espaces\s+verts|voirie|batiments?|reseaux|toitures?)\b/,
  /\bmarche\s+de\s+travaux\b/,
];

function normalise(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/**
 * Best-effort nature of prestation from the notice wording alone.
 * Returns null whenever the text doesn't say clearly - callers must treat
 * null as "unknown", never as "not supplies".
 */
export function inferNaturePrestation(title: string | null, description?: string | null): NaturePrestation | null {
  const normalisedTitle = normalise(title || '');
  // Descriptions are long and full of incidental words; the title carries the
  // object of the contract. The description is only consulted when the title
  // alone is silent, and only for the strongest (supply / study) patterns.
  const normalisedBody = normalise(`${title || ''} ${description || ''}`).slice(0, 2000);

  const worksInTitle = WORKS_PATTERNS.some((p) => p.test(normalisedTitle));
  const supplyInTitle = SUPPLY_PATTERNS.some((p) => p.test(normalisedTitle));

  // "Fourniture et pose" / "acquisition et installation": both natures are
  // genuinely present, which is what the classifier's own 'mixte' value is
  // for - don't force it into one bucket.
  if (supplyInTitle && SUPPLY_WITH_WORKS.test(normalisedTitle)) return 'mixte';
  if (supplyInTitle && worksInTitle) return 'mixte';

  if (supplyInTitle) return 'fournitures';
  if (STUDY_PATTERNS.some((p) => p.test(normalisedTitle))) return 'etudes';
  // Checked before WORKS_PATTERNS: "maintenance chauffage/climatisation" is
  // a recurring services contract, not a worksite, even though it shares
  // the "maintenance"/"entretien" verb with the building-fabric upkeep
  // patterns below.
  if (SERVICES_PATTERNS.some((p) => p.test(normalisedTitle))) return 'services';
  if (worksInTitle) return 'travaux';

  if (SUPPLY_PATTERNS.some((p) => p.test(normalisedBody))) return 'fournitures';
  if (STUDY_PATTERNS.some((p) => p.test(normalisedBody))) return 'etudes';
  if (SERVICES_PATTERNS.some((p) => p.test(normalisedBody))) return 'services';

  return null;
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------
// The same rules as a single expression so the search can filter/rank on a
// resolved nature without a backfill having to run first. Kept as one
// COALESCE so an AI-assigned value always wins over the heuristic: once
// classifyOpportunity() has looked at a row, this never second-guesses it.
//
// No bound parameters on purpose - every literal here is a compile-time
// constant from this file, nothing from the request reaches it.

function sqlRegexAny(column: string, patterns: string[]): string {
  return patterns.map((p) => `${column} ~ '${p.replace(/'/g, "''")}'`).join(' OR ');
}

// Postgres regex flavour: no \b, use the POSIX \y word boundary instead.
function toPgPattern(re: RegExp): string {
  return re.source.replace(/\\b/g, '\\y');
}

const PG_SUPPLY = SUPPLY_PATTERNS.map(toPgPattern);
const PG_STUDY = STUDY_PATTERNS.map(toPgPattern);
const PG_SERVICES = SERVICES_PATTERNS.map(toPgPattern);
const PG_WORKS = WORKS_PATTERNS.map(toPgPattern);
const PG_SUPPLY_WITH_WORKS = toPgPattern(SUPPLY_WITH_WORKS);

/**
 * SQL expression resolving to 'travaux' | 'fournitures' | 'etudes' | 'mixte'
 * | NULL for a row of `opportunities` aliased as `alias`.
 */
export function naturePrestationSql(alias = 'o'): string {
  const title = `lower(unaccent(COALESCE(${alias}.title, '')))`;
  const body = `left(lower(unaccent(COALESCE(${alias}.title, '') || ' ' || COALESCE(${alias}.description, ''))), 2000)`;

  const supplyTitle = `(${sqlRegexAny(title, PG_SUPPLY)})`;
  const studyTitle = `(${sqlRegexAny(title, PG_STUDY)})`;
  const servicesTitle = `(${sqlRegexAny(title, PG_SERVICES)})`;
  const worksTitle = `(${sqlRegexAny(title, PG_WORKS)})`;
  const supplyBody = `(${sqlRegexAny(body, PG_SUPPLY)})`;
  const studyBody = `(${sqlRegexAny(body, PG_STUDY)})`;
  const servicesBody = `(${sqlRegexAny(body, PG_SERVICES)})`;
  const supplyWithWorks = `(${title} ~ '${PG_SUPPLY_WITH_WORKS.replace(/'/g, "''")}')`;

  return `COALESCE(
    ${alias}.nature_prestation,
    CASE
      WHEN ${supplyTitle} AND ${supplyWithWorks} THEN 'mixte'
      WHEN ${supplyTitle} AND ${worksTitle} THEN 'mixte'
      WHEN ${supplyTitle} THEN 'fournitures'
      WHEN ${studyTitle} THEN 'etudes'
      WHEN ${servicesTitle} THEN 'services'
      WHEN ${worksTitle} THEN 'travaux'
      WHEN ${supplyBody} THEN 'fournitures'
      WHEN ${studyBody} THEN 'etudes'
      WHEN ${servicesBody} THEN 'services'
      ELSE NULL
    END
  )`;
}

/**
 * The expression above is ~20 regex evaluations per row, and the search
 * references the resolved nature in WHERE, ORDER BY and SELECT at once.
 * Spelling it out in each of those would re-evaluate it three or four times
 * per row on a table that is already seq-scanned (see the search route's note
 * on reading straight off `opportunities`). This LATERAL computes it once per
 * row and lets every clause read `np.nature` instead.
 *
 * Append to the FROM clause of both the list and the count query - they share
 * the same WHERE, so they have to share the same joins.
 */
export function naturePrestationLateral(alias = 'o', as = 'np'): string {
  return `CROSS JOIN LATERAL (SELECT ${naturePrestationSql(alias)} AS nature) ${as}`;
}
