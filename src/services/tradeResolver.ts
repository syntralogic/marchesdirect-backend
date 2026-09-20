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

const fold = (text: string): string =>
  String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

const tokens = (text: string): string[] =>
  fold(text)
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3)
    // crude singularisation so "fenetres" matches "fenetre", "menuiseries" "menuiserie"
    .map((w) => (w.length > 4 && (w.endsWith('s') || w.endsWith('x')) ? w.slice(0, -1) : w));

// Keyword -> trade slug. Deliberately small and specific: only words that
// unambiguously name a trade of the canonical list above.
const KEYWORD_TRADE_SLUG: Record<string, string> = {
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
  vitrerie: 'vitrerie', voirie: 'vrd', assainissement: 'vrd', vrd: 'vrd',
};

let tradeCache: { rows: TradeRow[]; loadedAt: number } | null = null;
const TRADE_CACHE_MS = 10 * 60 * 1000;

async function loadTrades(): Promise<TradeRow[]> {
  if (tradeCache && Date.now() - tradeCache.loadedAt < TRADE_CACHE_MS) return tradeCache.rows;
  const result = await db.query('SELECT id, name, slug, description FROM trades');
  tradeCache = { rows: result.rows, loadedAt: Date.now() };
  return tradeCache.rows;
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
