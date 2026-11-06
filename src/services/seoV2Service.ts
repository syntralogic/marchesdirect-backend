import { db } from '../config/database';
import { logger } from '../utils/logger';
import { fold, KEYWORD_TRADE_SLUG, extractTradeSlugs } from './tradeResolver';

// Entités HTML laissées par certaines sources dans les noms d'acheteurs et les titres (« d&#039;Aquitaine »).
const decodeEntities = (v: string) => v.replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

// ============================================================================
// SEO v2 (5 nov., mandat référencement) — AJOUTS SEULEMENT : les routes existantes ne changent pas.
//
// Règles (documentées dans l'audit livré au client) :
//  - Adresses canoniques en minuscules sans accents : /marches-publics/bordeaux, /marches-publics/bordeaux/electricite,
//    /marches-publics/departement/33. Toute autre écriture (majuscules, accents, synonyme de métier) → 301.
//  - État d'une annonce (6 nov.) : « ouverte » = date limite connue et à venir ; « à vérifier » = aucune date limite
//    dans la base ni dans l'avis, diffusion non terminée, publiée depuis moins de 60 jours (jamais comptée comme
//    ouverte) ; « clôturée » = date limite passée, fin de diffusion passée ou avis annulé.
//  - Localisation (6 nov.) : lieu d'exécution, commune de l'acheteur et départements de publication sont distincts
//    (table opportunity_locations, jobs/noticeLocationJob.ts). Une page commune liste d'abord les annonces EXÉCUTÉES
//    dans la commune ; les annonces dont seul l'acheteur y est situé (lieu d'exécution non précisé) sont à part ; un
//    avis seulement PUBLIÉ dans un département n'y est jamais compté.
//  - Indexation (6 nov.) : une page est indexable si elle a au moins une annonce ouverte, OU au moins 3 consultations
//    clôturées depuis moins de 180 jours (historique utile : acheteurs récurrents, métiers). Une absence passagère
//    d'annonce ne fait donc pas sortir une page vivante de l'index ; une zone sans aucun historique reste en noindex.
//  - Les compteurs sont calculés sur la même liste que celle affichée, groupe par groupe.
//  - Aucun appel payant : tout vient de la base, en cache mémoire 15 minutes.
// ============================================================================

export const BASE_JOURNEY: Record<string, 'public_procurement' | 'tender' | 'subcontracting'> = {
  'marches-publics': 'public_procurement', 'appels-doffres': 'tender', 'sous-traitance': 'subcontracting',
};
export const JOURNEY_BASE: Record<string, string> = Object.fromEntries(Object.entries(BASE_JOURNEY).map(([b, j]) => [j, b]));

export const DEPARTMENTS: Record<string, string> = {
  '01': 'Ain', '02': 'Aisne', '03': 'Allier', '04': 'Alpes-de-Haute-Provence', '05': 'Hautes-Alpes', '06': 'Alpes-Maritimes', '07': 'Ardèche', '08': 'Ardennes', '09': 'Ariège',
  '10': 'Aube', '11': 'Aude', '12': 'Aveyron', '13': 'Bouches-du-Rhône', '14': 'Calvados', '15': 'Cantal', '16': 'Charente', '17': 'Charente-Maritime', '18': 'Cher', '19': 'Corrèze',
  '2A': 'Corse-du-Sud', '2B': 'Haute-Corse', '21': "Côte-d'Or", '22': "Côtes-d'Armor", '23': 'Creuse', '24': 'Dordogne', '25': 'Doubs', '26': 'Drôme', '27': 'Eure', '28': 'Eure-et-Loir', '29': 'Finistère',
  '30': 'Gard', '31': 'Haute-Garonne', '32': 'Gers', '33': 'Gironde', '34': 'Hérault', '35': 'Ille-et-Vilaine', '36': 'Indre', '37': 'Indre-et-Loire', '38': 'Isère', '39': 'Jura',
  '40': 'Landes', '41': 'Loir-et-Cher', '42': 'Loire', '43': 'Haute-Loire', '44': 'Loire-Atlantique', '45': 'Loiret', '46': 'Lot', '47': 'Lot-et-Garonne', '48': 'Lozère', '49': 'Maine-et-Loire',
  '50': 'Manche', '51': 'Marne', '52': 'Haute-Marne', '53': 'Mayenne', '54': 'Meurthe-et-Moselle', '55': 'Meuse', '56': 'Morbihan', '57': 'Moselle', '58': 'Nièvre', '59': 'Nord',
  '60': 'Oise', '61': 'Orne', '62': 'Pas-de-Calais', '63': 'Puy-de-Dôme', '64': 'Pyrénées-Atlantiques', '65': 'Hautes-Pyrénées', '66': 'Pyrénées-Orientales', '67': 'Bas-Rhin', '68': 'Haut-Rhin', '69': 'Rhône',
  '70': 'Haute-Saône', '71': 'Saône-et-Loire', '72': 'Sarthe', '73': 'Savoie', '74': 'Haute-Savoie', '75': 'Paris', '76': 'Seine-Maritime', '77': 'Seine-et-Marne', '78': 'Yvelines', '79': 'Deux-Sèvres',
  '80': 'Somme', '81': 'Tarn', '82': 'Tarn-et-Garonne', '83': 'Var', '84': 'Vaucluse', '85': 'Vendée', '86': 'Vienne', '87': 'Haute-Vienne', '88': 'Vosges', '89': 'Yonne',
  '90': 'Territoire de Belfort', '91': 'Essonne', '92': 'Hauts-de-Seine', '93': 'Seine-Saint-Denis', '94': 'Val-de-Marne', '95': "Val-d'Oise",
  '971': 'Guadeloupe', '972': 'Martinique', '973': 'Guyane', '974': 'La Réunion', '976': 'Mayotte',
};

export const slugify = (s: string | null | undefined): string => fold(String(s || '')).replace(/['’]/g, '-').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// Une « ville » qui est en réalité un acheteur (« Bordeaux Métropole », « Office public de l'habitat… ») n'est pas une zone.
const NOT_A_COMMUNE = /(communaut|metropole|agglomeration|agglo\b|syndicat|office|\bspl\b|\bsem\b|\bgie\b|\bsivom\b|\bsivu\b|\bsiv\b|conseil|departement|\bregion\b|centre hospitalier|\bchu\b|\bch\b|hopital|universite|lycee|college|habitat|groupement|coordonnateur|pour le compte|\bpetr\b|\bccas\b|\bsdis\b|\bepci\b|\bsmic|etablissement|direction|ministere|prefecture|mairie|ville de|ville d'|ville d’|commune de|commune d'|commune d’|port\b|aeroport|\bcrous\b|\bopac\b|\boph\b|logement|sa d|\bsas\b|\bsarl\b)/;
export function isCommuneName(name: string | null | undefined): boolean {
  const f = fold(String(name || '')).trim();
  if (!f || f.length > 40 || /\d/.test(f) || /[()\/,;:]/.test(f)) return false;
  if (NOT_A_COMMUNE.test(f)) return false;
  if (f.split(/\s+/).length > 5) return false;
  return true;
}
const normDept = (d: string | null | undefined): string | null => {
  const s = String(d || '').trim().toUpperCase();
  if (/^\d$/.test(s)) return `0${s}`;
  if (DEPARTMENTS[s]) return s;
  const byName = Object.entries(DEPARTMENTS).find(([, n]) => fold(n) === fold(s));
  return byName ? byName[0] : null;
};

// « BORDEAUX » → « Bordeaux », « SAINT-JEAN-D'ILLAC » → « Saint-Jean-d'Illac » (une écriture déjà soignée est gardée).
const SMALL = new Set(['de', 'du', 'des', 'la', 'le', 'les', 'sur', 'sous', 'en', 'et', 'aux', 'au', 'lès', 'les']);
export function displayCity(raw: string): string {
  const t = raw.trim();
  if (/[a-zà-ÿ]/.test(t)) return t;
  return t.toLocaleLowerCase('fr-FR').split(/([\s-]+)/).map((w, k) => {
    if (/^[\s-]+$/.test(w)) return w;
    const ap = w.match(/^([dl])['’](.+)$/); if (ap) return `${k ? ap[1] : ap[1].toUpperCase()}'${ap[2].charAt(0).toUpperCase()}${ap[2].slice(1)}`;
    return k && SMALL.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1);
  }).join('');
}

type Place = { slug: string; name: string; dept: string | null };
export type Item = {
  id: string; title: string; journey: string; reference: string | null; value: number | null; trades: string[]; updatedAt: string;
  buyer: string | null; state: 'open' | 'verify' | 'closed'; deadline: string | null;
  exec: { status: string; communes: Place[]; depts: string[]; text: string | null };
  buyerPlace: Place | null; pubDepts: string[];
};
/** Compatibilité avec l'ancien nom de type. */
export type OpenItem = Item;
type Snapshot = { at: number; items: Item[]; trades: Map<string, string>; cityNames: Map<string, string>; cityDepts: Map<string, Map<string, number>>; withLocations: boolean };
let snap: Snapshot | null = null; let loading: Promise<Snapshot> | null = null;

/** Commune de l'acheteur : ville_avis du BOAMP, sinon la ville de l'organisme dans les données de l'avis, sinon
 *  « Mairie / Commune / Ville de X » dans le nom de l'acheteur. Les noms d'organismes sont rejetés. */
/** Bloc « organisme » de l'avis : du début jusqu'à la section suivante (les sous-objets comme le SIRET y ont leurs propres accolades). */
function orgBlock(raw: string | null | undefined): string | null {
  if (!raw || !raw.startsWith('"organisme"')) return null;
  let end = Math.min(raw.length, 700);
  for (const k of ['"initial"', '"rectif"', '"communication"', '"procedure"', '"natureMarche"']) { const i = raw.indexOf(k, 12); if (i > 0 && i < end) end = i; }
  return raw.slice(0, end);
}
const ORG_VILLE = /"ville"\s*:\s*"([^"]{1,60})"/;
export function buyerCommune(o: { ville_avis?: string | null; organisme?: string | null; buyer_name?: string | null; location_city?: string | null }): string | null {
  const clean = (v: string) => v.replace(/\s+cedex.*$/i, '').replace(/\s+\d+$/, '').trim();
  const cands: string[] = [];
  if (o.ville_avis) cands.push(String(o.ville_avis));
  const org = orgBlock(o.organisme);
  const m = org ? ORG_VILLE.exec(org) : null; if (m) cands.push(m[1]);
  const b = String(o.buyer_name || '').match(/^\s*(?:mairie|commune|ville)\s+(?:de\s+|d['’]\s*)(.{2,40})$/i); if (b) cands.push(b[1]);
  if (o.location_city) cands.push(String(o.location_city));
  for (const c of cands) { const v = clean(c); if (isCommuneName(v)) return v; }
  return null;
}

const BASE_SQL = (withLoc: boolean) => `
    SELECT o.id, o.title, o.location_city, o.location_department, o.deadline, o.buyer_name, ot.code AS journey, o.source_reference,
           o.estimated_value, o.trade_id, o.created_at, COALESCE(o.is_cancelled, false) AS is_cancelled,
           COALESCE(o.updated_at, o.created_at) AS updated_at
           ${withLoc ? `, l.exec_status, l.exec_communes, l.exec_departments, l.exec_text, l.buyer_city, l.buyer_department,
           l.publication_departments, l.notice_deadline, l.diffusion_end` : ''}
      FROM opportunities o
      JOIN opportunity_types ot ON ot.id = o.opportunity_type_id
      LEFT JOIN data_sources ds ON ds.id = o.source_id
      ${withLoc ? 'LEFT JOIN opportunity_locations l ON l.opportunity_id = o.id' : ''}
     WHERE o.deleted_at IS NULL AND COALESCE(o.status, '') = 'active'
       AND COALESCE(ds.code, '') <> 'editorial_catalog'
       AND (ds.code IS DISTINCT FROM 'ted' OR o.location_country IN ('FR', 'FRA'))
       AND (o.deadline >= NOW() - INTERVAL '180 days' OR (o.deadline IS NULL AND o.created_at >= NOW() - INTERVAL '180 days'))
     LIMIT 120000`;

const betterName = (a: string | undefined, b: string) => {
  if (!a) return b;
  const score = (x: string) => (/[a-zà-ÿ]/.test(x) ? 2 : 0) + (/[à-ÿ]/i.test(x) ? 1 : 0) + (/-/.test(x) ? 1 : 0);
  return score(b) > score(a) ? b : a;
};

async function load(): Promise<Snapshot> {
  const t = await db.query('SELECT id, name, slug FROM trades WHERE slug IS NOT NULL');
  const tradeById = new Map<string, string>(t.rows.map((r: any) => [String(r.id), String(r.slug)]));
  const trades = new Map<string, string>(t.rows.map((r: any) => [String(r.slug), String(r.name)]));
  let withLocations = true;
  const r = await db.query(BASE_SQL(true)).catch(async (e: unknown) => { withLocations = false; logger.error('[SEO v2] table des lieux indisponible, repli :', e); return db.query(BASE_SQL(false)); });
  const cityNames = new Map<string, string>();
  const cityDepts = new Map<string, Map<string, number>>();
  const now = Date.now(); const today = new Date().toISOString().slice(0, 10);
  const items: Item[] = [];
  for (const o of r.rows as any[]) {
    const title = String(o.title || '').trim(); if (!title) continue;
    const dl = o.deadline ? new Date(o.deadline) : o.notice_deadline ? new Date(o.notice_deadline) : null;
    const diffEnd = o.diffusion_end ? new Date(o.diffusion_end).toISOString().slice(0, 10) : null;
    let state: Item['state'];
    if (o.is_cancelled) state = 'closed';
    else if (dl) state = dl.getTime() >= now ? 'open' : 'closed';
    else if (diffEnd && diffEnd < today) state = 'closed';
    else if (new Date(o.created_at).getTime() >= now - 60 * 86400000) state = 'verify';
    else continue; // sans date ni signe de vie depuis 60 jours : ni ouverte, ni datée — on ne l'affiche pas
    const execCommunes: Place[] = (Array.isArray(o.exec_communes) ? o.exec_communes : []).map((c: any) => ({ slug: String(c.slug), name: String(c.name), dept: c.department || null }))
      .filter((c: Place) => c.slug);
    const execDepts: string[] = [...new Set<string>([...(o.exec_departments || []), ...execCommunes.map(c => c.dept).filter(Boolean) as string[]])];
    let buyerPlace: Place | null = null;
    if (withLocations && o.buyer_city) buyerPlace = { slug: slugify(o.buyer_city), name: displayCity(o.buyer_city), dept: o.buyer_department || null };
    else if (!withLocations) { const c = buyerCommune(o); if (c) buyerPlace = { slug: slugify(c), name: displayCity(c), dept: normDept(o.location_department) }; }
    for (const p of [...execCommunes, ...(buyerPlace ? [buyerPlace] : [])]) {
      cityNames.set(p.slug, betterName(cityNames.get(p.slug), p.name));
      if (p.dept) { const m = cityDepts.get(p.slug) || new Map<string, number>(); m.set(p.dept, (m.get(p.dept) || 0) + 1); cityDepts.set(p.slug, m); }
    }
    const ts = new Set<string>();
    if (o.trade_id && tradeById.has(String(o.trade_id))) ts.add(tradeById.get(String(o.trade_id))!);
    for (const sl of extractTradeSlugs(title)) if (trades.has(sl)) ts.add(sl);
    items.push({
      id: String(o.id), title: decodeEntities(title), journey: String(o.journey), reference: o.source_reference || null,
      value: o.estimated_value != null && Number.isFinite(Number(o.estimated_value)) ? Number(o.estimated_value) : null,
      trades: [...ts], updatedAt: new Date(o.updated_at).toISOString(),
      buyer: o.buyer_name && !/^\s*\d[\d\s]*$/.test(String(o.buyer_name)) ? decodeEntities(String(o.buyer_name)).trim() : null,
      state, deadline: dl ? dl.toISOString() : null,
      exec: { status: o.exec_status || 'inconnu', communes: execCommunes, depts: execDepts, text: o.exec_text ? decodeEntities(o.exec_text) : null },
      buyerPlace, pubDepts: (o.publication_departments || []).map((d: string) => normDept(d)).filter(Boolean) as string[],
    });
  }
  return { at: Date.now(), items, trades, cityNames, cityDepts, withLocations };
}
export async function snapshot(): Promise<Snapshot> {
  if (snap && Date.now() - snap.at < 15 * 60000) return snap;
  if (!loading) loading = load().then(x => { snap = x; return x; }).finally(() => { loading = null; });
  try { return await loading; } catch (e) { logger.error('[SEO v2] chargement impossible:', e); if (snap) return snap; throw e; }
}

/** Métier depuis l'adresse : slug exact ou synonyme courant (climatisation → cvc, electricien → electricite…). */
export function resolveTrade(raw: string, trades: Map<string, string>): string | null {
  const s = slugify(raw); if (!s) return null;
  if (trades.has(s)) return s;
  const byName = [...trades.entries()].find(([, n]) => slugify(n) === s); if (byName) return byName[0];
  const syn = KEYWORD_TRADE_SLUG[s.replace(/-/g, '')] || KEYWORD_TRADE_SLUG[s.split('-')[0]];
  return syn && trades.has(syn) ? syn : null;
}

// Appartenance d'une annonce à une zone, par rôle. « main » = lieu d'exécution dans la zone ; « buyer » = seul
// l'acheteur y est situé et l'avis ne précise pas de lieu d'exécution au même niveau.
type Zone = { type: 'city' | 'department'; slug: string; name: string; department: string | null; departmentName: string | null; unambiguous?: boolean; urlSlug?: string };
export function roleIn(i: Item, z: { type: 'city' | 'department'; slug: string; department: string | null; unambiguous?: boolean }): 'main' | 'buyer' | 'dept' | null {
  if (z.type === 'city') {
    // Communes homonymes : le département doit concorder ; une commune sans département connu n'est retenue que si
    // le nom n'existe que dans un seul département (z.unambiguous).
    const same = (p: Place) => p.slug === z.slug && (p.dept ? !z.department || p.dept === z.department : !!z.unambiguous);
    if (i.exec.communes.some(same)) return 'main';
    if (i.buyerPlace && same(i.buyerPlace) && !i.exec.communes.length) return 'buyer';
    if (z.department && i.exec.depts.includes(z.department)) return 'dept';
    return null;
  }
  if (i.exec.depts.includes(z.department!)) return 'main';
  if (!i.exec.depts.length && i.buyerPlace?.dept === z.department) return 'buyer';
  return null;
}
const MIN_HISTORY = 3; const PAGE_SIZE = 30;
export const indexRule = (openMain: number, openBuyer: number, closedRecent: number) =>
  openMain + openBuyer > 0 ? { indexable: true, reason: 'au moins une annonce ouverte dans la zone' }
    : closedRecent >= MIN_HISTORY ? { indexable: true, reason: `aucune annonce ouverte aujourd’hui, mais ${closedRecent} consultations clôturées depuis moins de 180 jours : page utile, conservée dans l’index` }
      : { indexable: false, reason: 'ni annonce ouverte, ni historique récent suffisant : page servie en noindex, jamais supprimée' };

const byDeadline = (a: Item, b: Item) => (a.deadline ? Date.parse(a.deadline) : 9e15) - (b.deadline ? Date.parse(b.deadline) : 9e15);
const byRecent = (a: Item, b: Item) => (b.deadline ? Date.parse(b.deadline) : 0) - (a.deadline ? Date.parse(a.deadline) : 0);
const view = (i: Item, trades: Map<string, string>) => ({
  id: i.id, title: i.title, deadline: i.deadline, state: i.state, buyer: i.buyer, reference: i.reference, estimatedValue: i.value,
  trades: i.trades.map(x => trades.get(x) || x), path: `/opportunites/${i.id}`,
  // Trois informations distinctes ; null = inconnu (jamais deviné)
  execution: { status: i.exec.status, communes: i.exec.communes.map(c => c.name), departments: i.exec.depts, text: i.exec.text },
  buyerCity: i.buyerPlace?.name || null, buyerDepartment: i.buyerPlace?.dept || null, publicationDepartments: i.pubDepts,
  // compatibilité : « city » = commune d'exécution si connue
  city: i.exec.communes[0]?.name || null, department: i.exec.depts[0] || null,
});

/** Adresse d'une commune : nue pour le département majoritaire (≥ 90 %), suffixée par le département sinon. */
function citySlugFor(s: Snapshot, slug: string, dept: string | null): string {
  const dc = [...(s.cityDepts.get(slug) || new Map<string, number>()).entries()].sort((a, b) => b[1] - a[1]);
  if (dc.length <= 1 || !dept) return slug;
  const total = dc.reduce((n, [, k]) => n + k, 0);
  return dc[0][1] >= 0.9 * total && dc[0][0] === dept ? slug : `${slug}-${dept.toLowerCase()}`;
}

export async function buildPage(args: { base: string; city?: string; trade?: string; department?: string; page?: string | number }) {
  const journey = BASE_JOURNEY[args.base];
  if (!journey) return { status: 404 as const };
  const s = await snapshot();
  const pool = s.items.filter(i => i.journey === journey);
  let zone: Zone;
  if (args.department) {
    const d = normDept(args.department); if (!d) return { status: 404 as const };
    zone = { type: 'department', slug: d.toLowerCase(), name: DEPARTMENTS[d], department: d, departmentName: DEPARTMENTS[d] };
  } else {
    let cs = slugify(args.city);
    if (!cs) return { status: 404 as const };
    // Communes homonymes (Rochefort 17 / Rochefort 21…) : l'adresse nue désigne le département largement majoritaire
    // (≥ 90 % des mentions) ; les autres ont une adresse suffixée par le département (/marches-publics/rochefort-21).
    // Sans majorité nette, l'adresse nue est une page de choix, jamais un mélange.
    let forcedDept: string | null = null;
    const suff = cs.match(/^(.+)-(\d{2,3}|2a|2b)$/);
    if (suff && s.cityDepts.get(suff[1])?.has(suff[2].toUpperCase())) { cs = suff[1]; forcedDept = suff[2].toUpperCase(); }
    const dc = [...(s.cityDepts.get(cs) || new Map<string, number>()).entries()].sort((a, b) => b[1] - a[1]);
    const totalMentions = dc.reduce((n, [, k]) => n + k, 0);
    const dominant = dc.length && dc[0][1] >= 0.9 * totalMentions ? dc[0][0] : null;
    const homonyms = dc.length > 1;
    let name = s.cityNames.get(cs);
    if (!name) {
      const known = await db.query(`SELECT location_city AS c, location_department AS d FROM opportunities WHERE location_city IS NOT NULL
        AND regexp_replace(lower(unaccent(location_city)), '[^a-z0-9]+', '-', 'g') = $1 LIMIT 1`, [cs]).catch(() => ({ rows: [] as any[] }));
      const legacy = known.rows[0] ? null : await db.query(`SELECT filter_city AS c, filter_department AS d FROM seo_pages WHERE filter_city IS NOT NULL
        AND regexp_replace(lower(unaccent(filter_city)), '[^a-z0-9]+', '-', 'g') = $1 LIMIT 1`, [cs]).catch(() => ({ rows: [] as any[] }));
      const row = known.rows[0] || legacy?.rows[0];
      if (!row) return { status: 404 as const };
      if (!isCommuneName(row.c)) {
        const d = normDept(row.d) || deptInName(row.c);
        return d ? { status: 301 as const, location: `/${args.base}/departement/${d.toLowerCase()}` } : { status: 404 as const };
      }
      name = displayCity(String(row.c).trim());
    }
    let dept: string | null;
    if (forcedDept) {
      if (forcedDept === dominant) return { status: 301 as const, location: `/${args.base}/${cs}${args.trade ? `/${slugify(args.trade)}` : ''}` };
      dept = forcedDept;
    } else if (homonyms && !dominant) {
      return { status: 300 as const, base: args.base, name, choices: dc.map(([d, n]) => ({ department: d, departmentName: DEPARTMENTS[d], mentions: n, path: `/${args.base}/${cs}-${d.toLowerCase()}` })) };
    } else dept = dominant || dc[0]?.[0] || null;
    zone = { type: 'city', slug: cs, name, department: dept, departmentName: dept ? DEPARTMENTS[dept] : null, unambiguous: !homonyms,
      urlSlug: dept && homonyms && dept !== dominant ? `${cs}-${dept.toLowerCase()}` : cs };
  }
  let trade: { slug: string; name: string } | null = null;
  if (args.trade) {
    const t = resolveTrade(args.trade, s.trades);
    if (!t) return { status: 301 as const, location: zone.type === 'city' ? `/${args.base}/${zone.urlSlug || zone.slug}` : `/${args.base}/departement/${zone.slug}` };
    trade = { slug: t, name: s.trades.get(t)! };
  }
  const canonicalPath = zone.type === 'city' ? `/${args.base}/${zone.urlSlug || zone.slug}${trade ? `/${trade.slug}` : ''}` : `/${args.base}/departement/${zone.slug}${trade ? `/${trade.slug}` : ''}`;
  const withTrade = (i: Item) => !trade || i.trades.includes(trade.slug);
  const groups = { main: [] as Item[], buyer: [] as Item[], dept: [] as Item[], verify: [] as Item[], closed: [] as Item[] };
  const zoneAll: Item[] = [];
  for (const i of pool) {
    const role = roleIn(i, zone); if (!role) continue;
    if (role !== 'dept') zoneAll.push(i);
    if (!withTrade(i)) continue;
    if (i.state === 'open') groups[role].push(i);
    else if (role === 'dept') continue;
    else if (i.state === 'verify') groups.verify.push(i);
    else groups.closed.push(i);
  }
  groups.main.sort(byDeadline); groups.buyer.sort(byDeadline); groups.dept.sort(byDeadline); groups.closed.sort(byRecent);
  const publishedOnly = zone.type === 'department'
    ? pool.filter(i => i.state === 'open' && withTrade(i) && i.pubDepts.includes(zone.department!) && !roleIn(i, zone)).length : 0;
  // Pagination de la liste principale (30 par page) ; une page au-delà de la dernière n'existe pas.
  const pages = Math.max(1, Math.ceil(groups.main.length / PAGE_SIZE));
  const page = Math.max(1, Math.floor(Number(args.page) || 1));
  if (page > pages) return { status: 404 as const };
  const tradeCounts = new Map<string, number>(); for (const i of zoneAll) if (i.state === 'open') for (const t of i.trades) tradeCounts.set(t, (tradeCounts.get(t) || 0) + 1);
  const cityCounts = new Map<string, number>();
  if (zone.department) for (const i of pool) if (i.state === 'open') for (const c of i.exec.communes) if (c.dept === zone.department && c.slug !== zone.slug) { const k = citySlugFor(s, c.slug, c.dept); cityCounts.set(k, (cityCounts.get(k) || 0) + 1); }
  const buyerCounts = new Map<string, number>(); for (const i of [...groups.main, ...groups.buyer]) if (i.buyer) buyerCounts.set(i.buyer, (buyerCounts.get(i.buyer) || 0) + 1);
  const otherTypes = Object.entries(JOURNEY_BASE).filter(([j]) => j !== journey).map(([j, b]) => ({ base: b, journey: j,
    count: s.items.filter(i => i.journey === j && i.state === 'open' && withTrade(i) && (roleIn(i, zone) === 'main' || roleIn(i, zone) === 'buyer')).length }));
  const rule = indexRule(groups.main.length, groups.buyer.length, groups.closed.length);
  const lastmod = [...groups.main, ...groups.buyer, ...groups.closed].reduce<string | null>((m, i) => (!m || i.updatedAt > m ? i.updatedAt : m), null);
  const v = (i: Item) => view(i, s.trades);
  return {
    status: 200 as const, journey, base: args.base, zone, trade, canonicalPath, indexable: rule.indexable, indexReason: rule.reason,
    locationsReady: s.withLocations,
    count: groups.main.length, items: groups.main.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map(v), page, pages, pageSize: PAGE_SIZE,
    buyerCount: groups.buyer.length, buyerItems: groups.buyer.slice(0, 20).map(v),
    verifyCount: groups.verify.length, verifyItems: groups.verify.slice(0, 10).map(v),
    nearbyCount: groups.dept.length, nearby: groups.dept.slice(0, 8).map(v),
    closedCount: groups.closed.length, closedItems: groups.closed.slice(0, 6).map(v),
    publishedOnlyCount: publishedOnly,
    trades: [...tradeCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([slug, n]) => ({ slug, name: s.trades.get(slug) || slug, count: n })),
    cities: [...cityCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([slug, n]) => ({ slug, name: s.cityNames.get(slug.replace(/-(\d{2,3}|2a|2b)$/, '')) || slug, count: n })),
    buyers: [...buyerCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([name, n]) => ({ name, count: n })),
    otherTypes, nextDeadline: [...groups.main, ...groups.buyer].sort(byDeadline).find(i => i.deadline)?.deadline || null, lastmod, generatedAt: new Date(s.at).toISOString(),
  };
}

/** Pages indexables (sitemap) : même règle que buildPage (ouverte, ou historique récent ≥ 3). */
export async function indexablePaths(): Promise<{ path: string; lastmod: string; count: number }[]> {
  const s = await snapshot();
  type Acc = { open: number; closed: number; lastmod: string };
  const acc = new Map<string, Acc>();
  const add = (p: string, i: Item) => {
    let a = acc.get(p); if (!a) { a = { open: 0, closed: 0, lastmod: i.updatedAt }; acc.set(p, a); }
    if (i.state === 'open') a.open++; else if (i.state === 'closed') a.closed++;
    if (i.updatedAt > a.lastmod) a.lastmod = i.updatedAt;
  };
  for (const i of s.items) {
    const base = JOURNEY_BASE[i.journey]; if (!base || i.state === 'verify') continue;
    const depts = i.exec.depts.length ? i.exec.depts : i.buyerPlace?.dept ? [i.buyerPlace.dept] : [];
    for (const d of depts) { add(`/${base}/departement/${d.toLowerCase()}`, i); for (const t of i.trades) add(`/${base}/departement/${d.toLowerCase()}/${t}`, i); }
    const cities = (i.exec.communes.length ? i.exec.communes : i.buyerPlace ? [i.buyerPlace] : []).filter(c => c.dept).map(c => citySlugFor(s, c.slug, c.dept));
    for (const c of new Set(cities)) { add(`/${base}/${c}`, i); for (const t of i.trades) add(`/${base}/${c}/${t}`, i); }
  }
  return [...acc.entries()].filter(([, a]) => indexRule(a.open, 0, a.closed).indexable)
    .map(([path, a]) => ({ path, lastmod: a.lastmod, count: a.open })).sort((a, b) => b.count - a.count);
}

/** Liens de navigation pour l'accueil et les pages catégories : zones les plus fournies, annonces ouvertes, lieu d'exécution. */
export async function topLinks(journey?: string) {
  const s = await snapshot();
  const pool = (journey ? s.items.filter(i => i.journey === journey) : s.items).filter(i => i.state === 'open');
  const depts = new Map<string, number>(); const cities = new Map<string, number>(); const trades = new Map<string, number>();
  for (const i of pool) {
    for (const d of i.exec.depts) depts.set(d, (depts.get(d) || 0) + 1);
    for (const c of new Set(i.exec.communes.filter(x => x.dept).map(x => citySlugFor(s, x.slug, x.dept)))) cities.set(c, (cities.get(c) || 0) + 1);
    for (const t of i.trades) trades.set(t, (trades.get(t) || 0) + 1);
  }
  const byType = Object.fromEntries(Object.keys(JOURNEY_BASE).map(j => [j, s.items.filter(i => i.journey === j && i.state === 'open').length]));
  return { total: pool.length, byType,
    departments: [...depts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([code, n]) => ({ code, slug: code.toLowerCase(), name: DEPARTMENTS[code] || code, count: n })),
    cities: [...cities.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([slug, n]) => ({ slug, name: s.cityNames.get(slug.replace(/-(\d{2,3}|2a|2b)$/, '')) || slug, count: n })),
    trades: [...trades.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([slug, n]) => ({ slug, name: s.trades.get(slug) || slug, count: n })),
    generatedAt: new Date(s.at).toISOString() };
}

// ── Anciennes adresses (6 nov.) ────────────────────────────────────────────────────────────────────────────────
// Les 8 464 pages seo_pages générées automatiquement ont des adresses /pages/:slug et des « villes » qui sont souvent
// des noms d'acheteurs. Correspondance proposée, sans rien supprimer : commune réelle → page commune ; acheteur pris pour
// une ville → page département ; rien d'exploitable → page catégorie. La table seo_pages n'est pas modifiée.
/** « Département de l'Oise », « DEPARTEMENT DE L'AUDE - CD11 » → code du département (nom le plus long trouvé). */
const DEPT_NAMES = Object.entries(DEPARTMENTS).map(([c, n]) => [c, fold(n).replace(/[^a-z]+/g, ' ').trim()] as const).sort((a, b) => b[1].length - a[1].length);
export function deptInName(name: string | null | undefined): string | null {
  if (!name) return null;
  const f = ` ${fold(String(name)).replace(/&#0?39;|&apos;/g, "'").replace(/[^a-z]+/g, ' ').trim()} `;
  for (const [c, n] of DEPT_NAMES) if (f.includes(` ${n} `)) return c;
  return null;
}
export async function legacyTargets(opts: { slug?: string; limit?: number; offset?: number }) {
  const r = await db.query(`
    SELECT sp.page_slug, sp.page_type, sp.filter_city, sp.filter_department, t.slug AS trade_slug, ot.code AS journey
      FROM seo_pages sp
      LEFT JOIN trades t ON t.id = sp.filter_trade_id
      LEFT JOIN opportunity_types ot ON ot.id = sp.filter_opportunity_type_id
     WHERE ($1::text IS NULL OR sp.page_slug = $1)
     ORDER BY sp.page_slug
     LIMIT $2 OFFSET $3`, [opts.slug || null, Math.min(opts.limit || 200, 1000), opts.offset || 0]);
  const total = opts.slug ? r.rows.length : Number((await db.query('SELECT COUNT(*)::int AS n FROM seo_pages')).rows[0].n);
  const rows = r.rows.map((p: any) => {
    const base = JOURNEY_BASE[p.journey] || 'marches-publics';
    const trade = p.trade_slug ? `/${p.trade_slug}` : '';
    const dept = normDept(p.filter_department) || deptInName(p.filter_city);
    let target: string; let reason: string;
    if (p.filter_city && isCommuneName(p.filter_city)) { target = `/${base}/${slugify(p.filter_city)}${trade}`; reason = 'commune'; }
    else if (p.filter_city && dept) { target = `/${base}/departement/${dept.toLowerCase()}${trade}`; reason = 'acheteur pris pour une ville → département'; }
    else if (!p.filter_city && dept) { target = `/${base}/departement/${dept.toLowerCase()}${trade}`; reason = 'département'; }
    else { target = `/${base}`; reason = 'aucune zone exploitable → page catégorie'; }
    return { from: `/pages/${p.page_slug}`, legacyCity: p.filter_city || null, legacyDepartment: p.filter_department || null, target, reason };
  });
  return { total, rows };
}

/** Localisation lue pour un avis (contrôle, rapport de tests) : par référence source (ex. 26-11675) ou par id. */
export async function locationOf(ref: string) {
  const r = await db.query(`
    SELECT o.id, o.source_reference, o.title, o.deadline, o.buyer_name, o.raw_data AS raw, l.*
      FROM opportunities o LEFT JOIN opportunity_locations l ON l.opportunity_id = o.id
     WHERE o.source_reference = $1 OR o.id::text = $1
     ORDER BY o.updated_at DESC NULLS LAST LIMIT 1`, [ref]);
  const o = r.rows[0]; if (!o) return null;
  // Avis hors du périmètre du job (ancien, clôturé depuis plus de 200 jours) : lecture directe, sans rien enregistrer.
  if (!o.computed_at && o.raw) {
    const { extractNoticeLocation, extractNoticeDates } = require('./noticeLocation');
    const l = extractNoticeLocation(o.raw); const d = extractNoticeDates(o.raw);
    Object.assign(o, { exec_status: l.execution.status, exec_source: l.execution.source, exec_communes: l.execution.communes, exec_departments: l.execution.departments,
      exec_text: l.execution.text, buyer_city: l.buyer.city, buyer_postal: l.buyer.postalCode, buyer_department: l.buyer.department,
      publication_departments: l.publicationDepartments, notice_deadline: d.deadline, diffusion_end: d.diffusionEnd });
  }
  return {
    id: o.id, reference: o.source_reference, title: decodeEntities(String(o.title || '')), buyer: o.buyer_name ? decodeEntities(o.buyer_name) : null, deadline: o.deadline || o.notice_deadline || null,
    computed: o.computed_at ? 'table opportunity_locations' : 'lecture directe de l’avis',
    execution: { status: o.exec_status || 'inconnu', source: o.exec_source || null, communes: o.exec_communes || [], departments: o.exec_departments || [], text: o.exec_text || null },
    buyerAddress: { city: o.buyer_city || null, postalCode: o.buyer_postal || null, department: o.buyer_department || null },
    publicationDepartments: o.publication_departments || [], diffusionEnd: o.diffusion_end || null,
  };
}

// ── Fiche d'annonce pour le pré-rendu (6 nov.) ─────────────────────────────────────────────────────────────────
// Politique d'indexation d'une annonce clôturée, fondée sur sa valeur réelle (et non un délai unique de 30 jours) :
//  - annulée ou démonstration : hors index tout de suite (la page reste consultable) ;
//  - clôturée : on garde la page dans l'index tant qu'elle sert de référence. Signaux lus dans les données :
//      R = acheteur récurrent (≥ 3 avis de cet acheteur dans la base) — la consultation reviendra, souvent à l'identique ;
//      C = contenu substantiel (description ≥ 400 caractères, montant estimé, ou plusieurs lots) ;
//      A = accord-cadre ou reconduction mentionnés (renouvellement prévisible).
//    C avec R ou A → 12 mois après la clôture ; un seul signal → 90 jours ; aucun → 14 jours (requêtes tardives).
//  - supprimée : 404 avec liens utiles (jamais de redirection vers l'accueil).
export function closedIndexPolicy(o: { cancelled: boolean; demo: boolean; deadline: string | null; descriptionLength: number; estimatedValue: number | null;
  lots: number; buyerHistory: number; framework: boolean }, now = Date.now()) {
  if (o.demo) return { indexable: false, reason: 'annonce de démonstration', keepUntil: null as string | null };
  if (o.cancelled) return { indexable: false, reason: 'consultation annulée', keepUntil: null };
  if (!o.deadline || Date.parse(o.deadline) >= now) return { indexable: true, reason: 'candidatures ouvertes ou date à vérifier', keepUntil: null };
  const R = o.buyerHistory >= 3; const C = o.descriptionLength >= 400 || o.estimatedValue != null || o.lots >= 2; const A = o.framework;
  const days = C && (R || A) ? 365 : (R || C || A) ? 90 : 14;
  const until = Date.parse(o.deadline) + days * 86400000;
  const signals = [R && 'acheteur récurrent', C && 'contenu substantiel', A && 'accord-cadre ou reconduction'].filter(Boolean).join(', ') || 'aucun signal de valeur';
  return { indexable: now < until, reason: `clôturée — ${signals} : conservée ${days} jours après la clôture`, keepUntil: new Date(until).toISOString() };
}

export async function noticeForSeo(id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const r = await db.query(`
    SELECT o.id, o.title, o.description, o.deadline, o.status, o.estimated_value, o.buyer_name, o.source_reference, o.official_url,
           COALESCE(o.is_cancelled, false) AS is_cancelled, (ds.code = 'editorial_catalog') AS is_demo, t.name AS trade_name, ot.code AS journey,
           (SELECT COUNT(*)::int FROM opportunities b WHERE b.buyer_name = o.buyer_name AND b.deleted_at IS NULL) AS buyer_history,
           l.exec_status, l.exec_communes, l.exec_departments, l.exec_text, l.buyer_city, l.buyer_department, l.publication_departments, l.notice_deadline
      FROM opportunities o
      LEFT JOIN trades t ON t.id = o.trade_id
      LEFT JOIN opportunity_types ot ON ot.id = o.opportunity_type_id
      LEFT JOIN data_sources ds ON ds.id = o.source_id
      LEFT JOIN opportunity_locations l ON l.opportunity_id = o.id
     WHERE o.id = $1 AND o.deleted_at IS NULL AND COALESCE(o.status, '') <> 'merged'`, [id]).catch(async () => db.query(`
    SELECT o.id, o.title, o.description, o.deadline, o.status, o.estimated_value, o.buyer_name, o.source_reference, o.official_url,
           COALESCE(o.is_cancelled, false) AS is_cancelled, (ds.code = 'editorial_catalog') AS is_demo, t.name AS trade_name, ot.code AS journey, 0 AS buyer_history
      FROM opportunities o LEFT JOIN trades t ON t.id = o.trade_id LEFT JOIN opportunity_types ot ON ot.id = o.opportunity_type_id
      LEFT JOIN data_sources ds ON ds.id = o.source_id WHERE o.id = $1 AND o.deleted_at IS NULL AND COALESCE(o.status, '') <> 'merged'`, [id]));
  const o = r.rows[0]; if (!o) return null;
  const desc = String(o.description || '');
  const lots = (desc.match(/\blot\s*n?°?\s*\d+/gi) || []).length;
  const deadline = o.deadline ? new Date(o.deadline).toISOString() : o.notice_deadline ? new Date(o.notice_deadline).toISOString() : null;
  const state = o.is_cancelled ? 'cancelled' : deadline ? (Date.parse(deadline) >= Date.now() ? 'open' : 'closed') : 'verify';
  const policy = closedIndexPolicy({ cancelled: !!o.is_cancelled, demo: !!o.is_demo, deadline, descriptionLength: desc.length,
    estimatedValue: o.estimated_value != null ? Number(o.estimated_value) : null, lots, buyerHistory: Number(o.buyer_history || 0), framework: /accord[- ]cadre|reconduct/i.test(desc) });
  const communes = (Array.isArray(o.exec_communes) ? o.exec_communes : []).map((c: any) => String(c.name));
  // Annonces ouvertes proches pour la page d'une annonce clôturée : même acheteur, sinon même département d'exécution.
  const s = await snapshot();
  const execDepts: string[] = o.exec_departments || [];
  const similar = s.items.filter(i => i.state === 'open' && i.id !== String(o.id) && i.journey === o.journey &&
    ((o.buyer_name && i.buyer === o.buyer_name) || (execDepts.length && i.exec.depts.some(d => execDepts.includes(d)))))
    .sort((a, b) => Number(b.buyer === o.buyer_name) - Number(a.buyer === o.buyer_name)).slice(0, 5)
    .map(i => ({ id: i.id, title: i.title, deadline: i.deadline, path: `/opportunites/${i.id}` }));
  return {
    id: o.id, title: decodeEntities(String(o.title || '')), journey: o.journey, tradeName: o.trade_name || null, buyer: o.buyer_name ? decodeEntities(o.buyer_name) : null, reference: o.source_reference || null,
    deadline, state, demo: !!o.is_demo, indexable: policy.indexable, indexReason: policy.reason, keepUntil: policy.keepUntil,
    execution: { status: o.exec_status || 'inconnu', communes, departments: execDepts, text: o.exec_text || null },
    buyerCity: o.buyer_city || null, buyerDepartment: o.buyer_department || null, publicationDepartments: o.publication_departments || [],
    similar,
  };
}
