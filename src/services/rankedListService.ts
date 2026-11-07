// Refonte v26, écran 2 « Vos marchés »: the open markets of the visitor's trade and zone, WITHOUT their percentage.
// The cards must appear at once; each percentage is then computed by the existing match-score endpoint (rules only, no AI)
// and the page fills them in as they arrive. A market outside the trade is never added "to make up the numbers".
import { keywordsForSlugs } from './tradeResolver';
import { domainMismatchExclusionSqlPattern } from '../utils/searchQuery';
export const MAX_CANDIDATES = 200; // 7 nov. : « Voir plus » sur la liste par entreprise (par pas de 40)
// Expressions de métier fréquentes dans les intitulés, en plus du vocabulaire mot à mot (texte sans accents, minuscules).
const EXTRA_TITLE_PATTERNS: Record<string, string[]> = {
  cvc: ['climatiseurs?', 'pompes? a chaleur', 'pac', 'vmc', 'frigoristes?', 'genie climatique', 'chaufferies?', 'chaudieres'],
  plomberie: ['plombiers?', 'sanitaires?'],
  electricite: ['electriciens?', 'courants? (forts?|faibles?)'],
};

// Same normalisation the department statistics use: "5" and "05" are the same department.
const DEPT_SQL = `(CASE WHEN TRIM(o.location_department) ~ '^[0-9]+$' THEN LPAD(TRIM(o.location_department), 2, '0') ELSE UPPER(TRIM(o.location_department)) END)`;

export function normaliseZone(zone: unknown): string | null {
  if (typeof zone !== 'string') return null;
  const z = zone.trim().toUpperCase();
  if (z === '' || z === 'FRANCE') return null;
  return /^(\d{1,3}|2A|2B)$/.test(z) ? (/^\d{1,2}$/.test(z) ? z.padStart(2, '0') : z) : null;
}

// 7 nov. : (1) toute la France par défaut, le département de l'entreprise en premier (preferDepartment) ; (2) une annonce
// sans métier classé entre aussi quand son intitulé contient un mot du métier (« climatisation », « pompe à chaleur »…),
// avec les mêmes exclusions que la recherche (ex. « chauffage urbain » pour un chauffagiste) : avant, 6 000 annonces
// ouvertes sans métier reconnu étaient invisibles pour une entreprise identifiée.
// immutable_unaccent existe dès que search_vector existe (même condition que routes/opportunities.ts) ; on le suppose
// présent en production, et buildCandidatesQuery accepte `ua: 'unaccent'` pour une base sans ce wrapper.
let UA = 'immutable_unaccent';
export function setUnaccentFn(fn: 'immutable_unaccent' | 'unaccent') { UA = fn; }
export function buildCandidatesQuery(opts: { tradeSlugs: string[]; department: string | null; preferDepartment?: string | null; limit?: number; offset?: number; v2?: boolean; journey?: string | null }) {
  const limit = Math.min(Math.max(Math.floor(opts.limit || 40), 1), MAX_CANDIDATES);
  const offset = Math.min(Math.max(Math.floor(opts.offset || 0), 0), 10000); // 7 nov. : « Voir plus » sans plafond, par pages de 40
  const params: unknown[] = [opts.tradeSlugs];
  const where = [
    `o.deleted_at IS NULL`,
    `o.status = 'active'`,
    `(o.deadline IS NULL OR o.deadline >= NOW())`,
    `__TRADE__`,
    // 4 Nov (mandat client : « aucun faux résultat ») : pas d'annonce de démonstration dans la liste classée.
    `COALESCE(ds.code, '') <> 'editorial_catalog'`,
  ];
  // v2 (aperçu seulement, ?loc=2) : date limite relue dans l'avis, annulées exclues, lieu d'exécution prioritaire,
  // acheteur seul quand l'avis ne donne aucun lieu ; un avis seulement publié dans le département n'y entre pas.
  const DL = opts.v2 ? 'COALESCE(l.notice_deadline, o.deadline)' : 'o.deadline';
  if (opts.v2) { where[2] = `(${DL} IS NULL OR ${DL} >= NOW())`; where.push('NOT COALESCE(o.is_cancelled, false)'); }
  const kws = keywordsForSlugs(opts.tradeSlugs).map(k => k.toLowerCase()).filter(k => k.length >= 3);
  const extra = opts.tradeSlugs.flatMap(s => EXTRA_TITLE_PATTERNS[s] || []);
  // Le métier par son identifiant (index opportunities_trade) plutôt que par la jointure trades : avec le OU mot-clé
  // ci-dessous, PostgreSQL peut alors combiner les deux index (BitmapOr) au lieu de lire toute la table.
  let tradeCond = `o.trade_id = ANY(ARRAY(SELECT id FROM trades WHERE slug = ANY($1::text[])))`;
  if (kws.length) {
    params.push(`\\y(${[...kws.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), ...extra].join('|')})\\y`);
    // Annonce privée ou de sous-traitance : son intitulé décrit le besoin précis, il suffit qu'il cite le métier.
    // 7 nov. (Hedi : « la liste n'a pas pu être chargée ») : depuis le passage à toute la France, cette expression
    // parcourt toute la table. unaccent() est STABLE, donc jamais indexée ; immutable_unaccent() correspond à l'index
    // trigramme opportunities_title_unaccent_trgm (config/database.ts), qui accélère aussi les expressions régulières.
    let kw = `((o.trade_id IS NULL OR COALESCE(ot.code, '') <> 'public_procurement') AND ${UA}(o.title) ~* $${params.length})`;
    for (const ex of [...new Set(kws.map(k => domainMismatchExclusionSqlPattern(k)).filter((x): x is string => !!x))]) {
      params.push(ex); kw = `(${kw} AND ${UA}(o.title) !~* $${params.length})`;
    }
    tradeCond = `(${tradeCond} OR ${kw})`;
  }
  where[where.indexOf('__TRADE__')] = tradeCond;
  // 7 nov. : pastille de type (marchés publics / appels d'offres privés / sous-traitance) appliquée côté serveur.
  if (opts.journey && ['public_procurement', 'tender', 'subcontracting'].includes(opts.journey)) { params.push(opts.journey); where.push(`ot.code = $${params.length}`); }
  if (opts.department) {
    params.push(opts.department);
    where.push(opts.v2
      ? `((l.opportunity_id IS NOT NULL AND ($${params.length} = ANY(l.exec_departments) OR (cardinality(l.exec_departments) = 0 AND l.buyer_department = $${params.length}))) OR (l.opportunity_id IS NULL AND ${DEPT_SQL} = $${params.length}))`
      : `${DEPT_SQL} = $${params.length}`);
  }
  const base = `FROM opportunities o
     LEFT JOIN opportunity_types ot ON o.opportunity_type_id = ot.id
     LEFT JOIN trades t ON o.trade_id = t.id
     LEFT JOIN data_sources ds ON o.source_id = ds.id${opts.v2 ? '\n     LEFT JOIN opportunity_locations l ON l.opportunity_id = o.id' : ''}
     WHERE ${where.join(' AND ')}`;
  let prefIdx = 0;
  if (!opts.department && opts.preferDepartment) { params.push(opts.preferDepartment); prefIdx = params.length; }
  const pref = prefIdx ? (opts.v2
    ? `(CASE WHEN $${prefIdx} = ANY(l.exec_departments) OR (l.opportunity_id IS NULL AND ${DEPT_SQL} = $${prefIdx}) OR (cardinality(COALESCE(l.exec_departments, '{}')) = 0 AND l.buyer_department = $${prefIdx}) THEN 0 ELSE 1 END)`
    : `(CASE WHEN ${DEPT_SQL} = $${prefIdx} THEN 0 ELSE 1 END)`) : '';
  // Sans département, « 0 » nu dans un ORDER BY est lu par PostgreSQL comme une position de colonne (erreur « ORDER BY
  // position 0 ») : d'où la liste « Vos marchés » vide depuis le passage à toute la France (7 nov.). On ordonne par une
  // constante typée, jamais par un entier nu.
  const lvl = opts.v2 && opts.department ? `(CASE WHEN $${params.length} = ANY(l.exec_departments) THEN 0 WHEN l.opportunity_id IS NOT NULL THEN 1 ELSE 2 END)` : '(0)::int';
  const v2Cols = opts.v2 ? `, ${DL} AS deadline_checked, CASE WHEN ${DL} IS NULL THEN 'verify' ELSE 'open' END AS open_state, ${lvl} AS location_level,
      l.exec_status, l.exec_communes, l.exec_departments, l.exec_text, l.buyer_city, l.buyer_department, l.publication_departments` : '';
  return {
    listSql: `SELECT o.id, o.title, o.description, ot.code AS journey, o.buyer_name, o.location_city, o.location_department, o.deadline${v2Cols}
      ${base} ORDER BY ${pref ? `${pref} ASC, ` : ''}${opts.v2 ? `(${DL} IS NULL) ASC, ${lvl} ASC, ` : ''}${DL} ASC NULLS LAST, o.publication_date DESC NULLS LAST${opts.v2 ? ', o.id ASC' : ''} LIMIT ${limit}${offset ? ` OFFSET ${offset}` : ''}`,
    // 7 nov. : répartition par type sur tout le résultat (les pastilles « Marchés publics / Appels d'offres privés /
    // Sous-traitance » comptaient seulement les 40 annonces chargées).
    countSql: `SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE ot.code = 'public_procurement')::int AS n_public,
      COUNT(*) FILTER (WHERE ot.code = 'tender')::int AS n_tender, COUNT(*) FILTER (WHERE ot.code = 'subcontracting')::int AS n_sub ${base}`,
    params,
    // 7 nov. : le département préféré n'apparaît que dans l'ORDER BY de la liste ; le comptage ne doit pas le recevoir
    // (« bind message supplies 4 parameters, but prepared statement requires 3 » : c'était l'échec de « Vos marchés »
    // en production depuis le passage à toute la France).
    countParams: prefIdx ? params.slice(0, prefIdx - 1) : params,
  };
}
