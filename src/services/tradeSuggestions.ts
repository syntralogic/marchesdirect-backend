import { fold } from './tradeResolver';

// ============================================================================
// MÉTIER SUGGESTIONS ("Rechercher par métier ou secteur d'activité")
//
// 26 Sep client spec: typing "ELE" must suggest "Électricité générale",
// "Électricité industrielle", "courants faibles", "bornes de recharge";
// typing "ET" must suggest "étanchéité" phrases - accent/case-insensitive,
// updating as the visitor types, without needing to press a search button.
//
// Every suggestion still resolves to one of the real trades already used for
// classification, search and matching (src/services/tradeResolver.ts) - a
// suggestion is a natural-language way to reach an existing, real trade_id,
// never a label invented just for this box. Where the client's own example
// names something with no backing category in the app today (their "études
// techniques" example, or sectors named in point 2 such as informatique,
// transport, santé, restauration, formation, services) no suggestion is
// generated for it: inventing a label that would filter to nothing, or
// silently attach unrelated results to it, would be worse than a missing
// suggestion. Extending the real trade catalog to those sectors is a
// separate, larger change (it touches classification everywhere those trades
// are used, not just this search box) and is intentionally left out of this
// step so as not to risk the existing BTP classification while iterating on
// the search box itself.
// ============================================================================

export interface TradeSuggestion {
  label: string;
  tradeId: number;
  tradeSlug: string;
  tradeName: string;
}

interface SynonymGroup {
  tradeSlug: string;
  // Ordered roughly general -> specific, matching the client's own example
  // ("générale" before "industrielle" before "courants faibles").
  phrases: string[];
}

// One entry per real trade (src/services/tradeResolver.ts's KEYWORD_TRADE_SLUG
// is the base vocabulary this was built from), each phrase a natural way a
// visitor might type or a specialisation they might look for. Selecting any
// phrase under a trade filters to that trade's real opportunities - the
// phrases are entry points, not a finer classification the backend doesn't
// have yet.
const CATALOG: SynonymGroup[] = [
  { tradeSlug: 'electricite', phrases: [
    'Électricité générale', 'Électricité industrielle', 'Électricité — courants faibles',
    'Électricité — bornes de recharge', 'Installations électriques', 'Maintenance électrique',
    'Électricien', 'Mise aux normes électriques', 'Éclairage public', 'Domotique',
  ] },
  { tradeSlug: 'couverture', phrases: [
    'Étanchéité', 'Étanchéité des terrasses', 'Étanchéité de toiture', 'Couverture',
    'Zinguerie', 'Toiture', 'Couvreur', 'Réfection de toiture',
  ] },
  { tradeSlug: 'plomberie', phrases: [
    'Plomberie', 'Plombier', 'Sanitaire', 'Installations sanitaires', 'Chauffe-eau',
    'Canalisations', 'Robinetterie',
  ] },
  { tradeSlug: 'cvc', phrases: [
    'Chauffage', 'Ventilation', 'Climatisation', 'Installation et maintenance de climatisation',
    'CVC', 'Chaudières', 'Pompes à chaleur', 'Chauffagiste', 'Frigoriste',
  ] },
  { tradeSlug: 'isolation', phrases: [
    'Isolation thermique', 'Isolation extérieure', 'Isolation des combles', 'Isolation phonique',
    'ITE', 'Isolation par soufflage',
  ] },
  { tradeSlug: 'platrerie', phrases: [
    'Plâtrerie', 'Cloisons', 'Doublages', 'Faux plafonds', 'Plaquiste',
  ] },
  { tradeSlug: 'menuiserie', phrases: [
    'Menuiserie', 'Fenêtres', 'Pose et remplacement de fenêtres', 'Menuiseries extérieures',
    'Menuiserie intérieure', 'Volets', 'Portes', 'Parquet', 'Agencement bois',
  ] },
  { tradeSlug: 'carrelage', phrases: [
    'Carrelage', 'Carreleur', 'Faïence', 'Revêtements de sols durs',
  ] },
  { tradeSlug: 'peinture', phrases: [
    'Peinture', 'Peintre', 'Peinture intérieure', 'Peinture extérieure', 'Revêtements muraux',
    'Ravalement de façade',
  ] },
  { tradeSlug: 'vitrerie', phrases: [
    'Vitrerie', 'Vitrage', 'Miroiterie', 'Remplacement de vitres',
  ] },
  { tradeSlug: 'vrd', phrases: [
    'Voirie et réseaux divers', 'VRD', 'Terrassement', 'Assainissement', 'Réseaux enterrés',
  ] },
  { tradeSlug: 'gros-oeuvre', phrases: [
    'Gros œuvre', 'Fondations', 'Maçonnerie de structure', 'Béton armé',
  ] },
  { tradeSlug: 'maconnerie', phrases: [
    'Maçonnerie', 'Maçon', 'Ravalement', 'Rejointoiement',
  ] },
  { tradeSlug: 'demolition', phrases: [
    'Démolition', 'Désamiantage', 'Curage',
  ] },
  { tradeSlug: 'charpente', phrases: [
    'Charpente', 'Charpente bois', 'Charpente métallique', 'Ossature bois',
  ] },
  { tradeSlug: 'batiment-general', phrases: [
    'Bâtiment général', 'Rénovation générale', 'Entreprise générale',
  ] },
  { tradeSlug: 'espaces-verts', phrases: [
    'Espaces verts', 'Paysagiste', 'Entretien des espaces verts', 'Élagage', 'Tonte',
  ] },
  { tradeSlug: 'nettoyage', phrases: [
    'Nettoyage', 'Propreté', 'Nettoyage de locaux', 'Nettoyage industriel',
  ] },
  { tradeSlug: 'maintenance', phrases: [
    'Maintenance', 'Maintenance multi-technique', 'Entretien de bâtiments',
  ] },
];

interface CompiledPhrase {
  label: string;
  tradeSlug: string;
  folded: string;          // whole phrase, accent/case-folded
  wordStarts: string[];    // folded start of each significant word, for word-prefix matching
}

let compiled: CompiledPhrase[] | null = null;

function compile(): CompiledPhrase[] {
  if (compiled) return compiled;
  compiled = CATALOG.flatMap((g) =>
    g.phrases.map((label) => {
      const folded = fold(label);
      const wordStarts = folded.split(/[^a-z0-9]+/).filter((w) => w.length > 0);
      return { label, tradeSlug: g.tradeSlug, folded, wordStarts };
    })
  );
  return compiled;
}

// Exported for tests only - lets a test add/replace the catalog without
// depending on module-load order.
export function _resetCompiledCacheForTests(): void {
  compiled = null;
}

export function suggestPhrases(query: string, limit = 8): { label: string; tradeSlug: string }[] {
  const q = fold(query).trim();
  if (q.length < 2) return [];
  const matches: CompiledPhrase[] = [];
  for (const p of compile()) {
    // Matches when the query is a prefix of the whole phrase (handles
    // multi-word typing, e.g. "electricite ind...") or a prefix of any
    // individual word in it (handles typing just "ele" or "ind...").
    if (p.folded.startsWith(q) || p.wordStarts.some((w) => w.startsWith(q))) {
      matches.push(p);
    }
  }
  // Shorter phrases first (more general matches, matching the client's own
  // ordering example), then catalog order within a tie.
  matches.sort((a, b) => a.folded.length - b.folded.length);
  const seen = new Set<string>();
  const out: { label: string; tradeSlug: string }[] = [];
  for (const m of matches) {
    if (seen.has(m.label)) continue;
    seen.add(m.label);
    out.push({ label: m.label, tradeSlug: m.tradeSlug });
    if (out.length >= limit) break;
  }
  return out;
}
