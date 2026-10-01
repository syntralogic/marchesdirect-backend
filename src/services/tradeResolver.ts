import { db } from '../config/database';

// ============================================================================
// TRADE (MÉTIER) RESOLUTION
//
// The `trades` table holds short canonical names ("Isolation", "Couverture",
// "Plomberie"), while the AI classifier and the notices themselves talk in
// long descriptive phrases ("Isolation thermique par l'extérieur (ITE)").
// classifyOpportunity() used to look trades up with
//   LOWER(trades.name) LIKE '%<ai name>%'
// i.e. "does the short canonical name CONTAIN the long AI phrase", which is
// practically never true - so most classified notices ended up with
// trade_id = NULL and the fiche said "Le métier n'est pas précisé" even when
// the title spelled it out (20 Sep client audit: Marssac, isolation
// thermique extérieure).
//
// Two helpers fix that:
//  - findTradeByName(): match an AI/free-text trade phrase to a canonical
//    trade, in either containment direction, then by whole-word overlap.
//  - resolveTradeFromText(): last-resort read-time inference straight from
//    the notice's title/description when no trade was ever linked.
// Both only ever return a trade that exists in the table - nothing invented.
// ============================================================================

export interface ResolvedTrade {
  id: string;
  name: string;
}

interface TradeRow extends ResolvedTrade {
  slug: string | null;
  description: string | null;
}

export const fold = (text: string): string =>
  String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

export const tokens = (text: string): string[] =>
  fold(text)
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3)
    // crude singularisation so "fenetres" matches "fenetre", "menuiseries" "menuiserie"
    .map((w) => (w.length > 4 && (w.endsWith('s') || w.endsWith('x')) ? w.slice(0, -1) : w));

// Keyword -> trade slug. Deliberately small and specific: only words that
// unambiguously name a trade of the canonical list above.
export const KEYWORD_TRADE_SLUG: Record<string, string> = {
  isolation: 'isolation', isolant: 'isolation', calorifugeage: 'isolation', ite: 'isolation',
  couverture: 'couverture', toiture: 'couverture', etancheite: 'couverture', zinguerie: 'couverture',
  peinture: 'peinture', peintre: 'peinture',
  plomberie: 'plomberie', sanitaire: 'plomberie',
  electricite: 'electricite', electrique: 'electricite',
  chauffage: 'cvc', ventilation: 'cvc', climatisation: 'cvc', cvc: 'cvc', chaudiere: 'cvc',
  menuiserie: 'menuiserie', fenetre: 'menuiserie',
  carrelage: 'carrelage', faience: 'carrelage',
  platrerie: 'platrerie', placo: 'platrerie', cloison: 'platrerie',
  maconnerie: 'maconnerie', charpente: 'charpente', demolition: 'demolition', deconstruction: 'demolition',
  vitrerie: 'vitrerie', vitrage: 'vitrerie', voirie: 'vrd', assainissement: 'vrd', vrd: 'vrd', terrassement: 'vrd',
  electricien: 'electricite', plombier: 'plomberie', chauffagiste: 'cvc', frigorifique: 'cvc',
  nettoyage: 'nettoyage', proprete: 'nettoyage', paysager: 'espaces-verts', jardin: 'espaces-verts', elagage: 'espaces-verts',
  tonte: 'espaces-verts', platre: 'platrerie', doublage: 'platrerie', gypse: 'platrerie',
};

// Every canonical trade a free text names (accent/case/plural-insensitive),
// used to compare what a market asks for with what a company does.
// Keyword hits only - no fuzzy substring matching, so "plan climat" is not
// "climatisation" and "messagerie électronique" is not "électricité".
//
// 30 Sep client audit: "Acquisition et livraison d'un camion neuf électrique
// avec hayon - Jardins de Nonères" scored 100 % for an electrical contractor
// (and read as electricité + espaces verts). "électrique" described the
// vehicle, "Jardins" was part of the buyer's name - neither is a work trade.
// A purchase of a vehicle/equipment (fourniture) is not a works contract for
// any building trade, so such a title names no métier unless it also names
// actual works (installation, pose, travaux, maintenance...).
const VEHICLE_SUPPLY_RE = /\b(acquisition|achat|acheter|fourniture|livraison|location|renouvellement)\b[^.;]{0,80}\b(vehicules?|camions?|camionnettes?|fourgons?|fourgonnettes?|utilitaires?|voitures?|autobus|autocars?|bus|minibus|tracteurs?|tondeuses?|remorques?|engins?|velos?)\b/;
const WORKS_WORD_RE = /\b(travaux|installation|installations|pose|maintenance|entretien|raccordement|deploiement|renovation|rehabilitation|reparation|construction|amenagement)\b/;

export const isVehicleOrEquipmentSupply = (text: string | null | undefined): boolean => {
  const f = fold(text || '');
  return VEHICLE_SUPPLY_RE.test(f) && !WORKS_WORD_RE.test(f);
};

export function extractTradeSlugs(text: string | null | undefined): string[] {
  if (isVehicleOrEquipmentSupply(text)) return [];
  const found = new Set<string>();
  for (const w of tokens(text || '')) {
    if (KEYWORD_TRADE_SLUG[w]) found.add(KEYWORD_TRADE_SLUG[w]);
  }
  return [...found];
}

let tradeCache: { rows: TradeRow[]; loadedAt: number } | null = null;
const TRADE_CACHE_MS = 10 * 60 * 1000;

async function loadTrades(): Promise<TradeRow[]> {
  if (tradeCache && Date.now() - tradeCache.loadedAt < TRADE_CACHE_MS) return tradeCache.rows;
  const result = await db.query('SELECT id, name, slug, description FROM trades');
  tradeCache = { rows: result.rows, loadedAt: Date.now() };
  return tradeCache.rows;
}

// ============================================================================
// PER-LOT TITLE OVERRIDE
//
// Client audit (27 Sep), point 4: a lot notice titled "Lot 1 : Plâtrerie -
// Peinture - Menuiserie bois" (Le Havre, chauffage urbain tender) surfaced
// under a CVC search even though its own title names three unrelated
// trades. Cause: BOAMP/DECP tenders routinely repeat the SAME overall
// project description on every lot's row (only the title differs lot by
// lot), and classifyOpportunity() (aiService.ts) reads title+description
// together - so a lot whose OWN object is plâtrerie/peinture/menuiserie can
// still pick up "chauffage urbain" from the shared description and get
// tagged with the CVC trade in ai_matched_trades.
//
// When a title explicitly names a lot, what follows the "Lot N :" marker is
// this row's own stated object and is the one thing that can't be
// contaminated by another lot's or the whole tender's wording - it should
// always be trusted over anything pulled from the description. Kept
// separate from resolveTradeFromText() above (which reads the whole
// title+description and is deliberately conservative/best-effort): this is
// a narrow, structural pattern match on the title alone, used to OVERRIDE a
// classification rather than merely supply one when none exists.
const LOT_TITLE_RE = /^\s*lot\s*[\dA-Z]+\s*[:\-\u2013\u2014]\s*(.+)$/i;

/** The trade slugs a "Lot N : ..." title names for itself, or [] if the
 * title doesn't have that shape (or names nothing recognisable). */
export function extractLotTradeSlugs(title: string | null | undefined): string[] {
  const m = LOT_TITLE_RE.exec(String(title || '').trim());
  if (!m) return [];
  return extractTradeSlugs(m[1]);
}

// ============================================================================
// KEYWORDS FOR A TRADE (métier category browsing)
//
// 27 Sep client audit, point 7: "Nettoyage" browsed as a category showed 134
// (all private) results, while typing "nettoyage" in the search box found
// 147 more, public, notices too. Cause: the category/métier filter
// (opportunities.ts's trade_id condition) only ever matches o.trade_id or
// ai_matched_trades - both are ONLY ever written by classifyOpportunity(),
// an AI call that runs asynchronously, in small batches, well after a notice
// is first ingested (see aiProcessing.ts). BOAMP/PLACE ingest thousands of
// public notices per run; until the batch job catches up, a freshly-ingested
// public notice sits at ai_classification_status='not_analyzed' - invisible
// to any métier filter - while the free-text search (q param) matches
// straight off title/description and finds it immediately. That backlog
// skews public listings specifically (private/tender sources are lower
// volume, so their queue drains faster), which is exactly the "toutes
// privées" symptom reported.
//
// keywordsForSlugs() exposes the same KEYWORD_TRADE_SLUG vocabulary
// classifyOpportunity's own text-inference already trusts, so the category
// filter can fall back to a direct keyword hit on title/description - the
// same standard this route already applies to a manually-typed word - for
// exactly the not-yet-classified rows the AI hasn't reached yet, without
// waiting on the batch job or inventing a second classification vocabulary.
export function keywordsForSlug(slug: string): string[] {
  return Object.keys(KEYWORD_TRADE_SLUG).filter((k) => KEYWORD_TRADE_SLUG[k] === slug);
}

export function keywordsForSlugs(slugs: string[]): string[] {
  const found = new Set<string>();
  for (const slug of slugs) for (const kw of keywordsForSlug(slug)) found.add(kw);
  return [...found];
}

/** Canonical trade rows for a set of slugs, in no particular order -
 * used to turn extractLotTradeSlugs()'s output back into real trade ids. */
export async function findTradesBySlugs(slugs: string[]): Promise<ResolvedTrade[]> {
  if (slugs.length === 0) return [];
  const wanted = new Set(slugs);
  const trades = await loadTrades();
  return trades.filter((t) => t.slug && wanted.has(t.slug)).map((t) => ({ id: t.id, name: t.name }));
}

export async function findTradeByName(rawName: string): Promise<ResolvedTrade | null> {
  const name = fold(rawName).trim();
  if (!name) return null;
  const trades = await loadTrades();

  // 1. Containment, either direction ("isolation" <-> "isolation thermique par l'exterieur").
  const contained = trades
    .filter((t) => {
      const tn = fold(t.name).trim();
      return tn.length >= 4 && (name.includes(tn) || tn.includes(name));
    })
    .sort((a, b) => b.name.length - a.name.length)[0];
  if (contained) return { id: contained.id, name: contained.name };

  // 2. Whole-word / keyword overlap.
  const nameTokens = new Set(tokens(name));
  let best: { trade: TradeRow; score: number } | null = null;
  for (const t of trades) {
    const tradeTokens = new Set([...tokens(t.name), ...tokens(t.slug || '')]);
    let score = [...tradeTokens].filter((w) => w.length >= 4 && nameTokens.has(w)).length;
    for (const w of nameTokens) if (KEYWORD_TRADE_SLUG[w] && KEYWORD_TRADE_SLUG[w] === t.slug) score += 1;
    if (score > 0 && (!best || score > best.score)) best = { trade: t, score };
  }
  return best ? { id: best.trade.id, name: best.trade.name } : null;
}

// Read-time inference from the notice text itself. Title hits weigh more than
// description hits; anything ambiguous (two trades tied) resolves to null so a
// wrong métier is never asserted - "not specified" stays the honest fallback.
export async function resolveTradeFromText(
  title: string | null | undefined,
  description: string | null | undefined
): Promise<ResolvedTrade | null> {
  const trades = await loadTrades();
  const titleTokens = tokens(title || '');
  const descTokens = tokens((description || '').slice(0, 1500));
  const scores = new Map<string, number>();
  const bump = (slug: string, by: number) => scores.set(slug, (scores.get(slug) || 0) + by);

  for (const w of titleTokens) if (KEYWORD_TRADE_SLUG[w]) bump(KEYWORD_TRADE_SLUG[w], 3);
  for (const w of descTokens) if (KEYWORD_TRADE_SLUG[w]) bump(KEYWORD_TRADE_SLUG[w], 1);

  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  if (ranked.length === 0) return null;
  const [topSlug, topScore] = ranked[0];
  if (topScore < 3) return null; // needs a title hit (or 3+ description hits)
  if (ranked.length > 1 && ranked[1][1] === topScore) return null; // ambiguous
  const trade = trades.find((t) => t.slug === topSlug);
  return trade ? { id: trade.id, name: trade.name } : null;
}
