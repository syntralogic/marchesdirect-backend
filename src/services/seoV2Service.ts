import { db } from '../config/database';
import { logger } from '../utils/logger';
import { fold, KEYWORD_TRADE_SLUG, extractTradeSlugs } from './tradeResolver';

// ============================================================================
// SEO v2 (5 nov., mandat référencement) — AJOUTS SEULEMENT : les routes existantes ne changent pas.
//
// Règles (documentées dans l'audit livré au client) :
//  - Adresses canoniques en minuscules sans accents : /marches-publics/bordeaux, /marches-publics/bordeaux/electricite,
//    /marches-publics/departement/33. Toute autre écriture (majuscules, accents, synonyme de métier) → 301.
//  - « Ouvert » = annonce active, non fusionnée, hors catalogue de démonstration, hors avis TED étrangers, dont la date
//    limite n'est pas passée ; une annonce sans date limite connue n'est comptée que si elle a moins de 45 jours.
//  - Une page n'est indexable que si sa zone est une vraie commune ou un département ET qu'elle affiche au moins une
//    annonce ouverte de la zone (dans la commune pour une page ville). Sinon : page servie (200) avec un état vide honnête
//    et des alternatives, en « noindex, follow », jamais supprimée — elle redevient indexable dès qu'une annonce arrive.
//  - Les compteurs sont calculés sur la même liste que celle affichée. Les annonces « à proximité » sont séparées et
//    étiquetées comme telles.
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

export type OpenItem = { id: string; title: string; city: string | null; citySlug: string | null; dept: string | null; deadline: string | null;
  buyer: string | null; journey: string; reference: string | null; value: number | null; trades: string[]; updatedAt: string };
type Snapshot = { at: number; items: OpenItem[]; trades: Map<string, string>; cityNames: Map<string, string> };
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
const ORG_CP = /"cp"\s*:\s*"(\d{5})"/;
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
function deptFromCp(raw: string | null | undefined): string | null {
  const org = orgBlock(raw);
  const m = org ? ORG_CP.exec(org) : null; if (!m) return null;
  const cp = m[1]; if (cp.startsWith('97')) return DEPARTMENTS[cp.slice(0, 3)] ? cp.slice(0, 3) : null;
  if (cp.startsWith('20')) return Number(cp) < 20200 ? '2A' : '2B';
  return DEPARTMENTS[cp.slice(0, 2)] ? cp.slice(0, 2) : null;
}

async function load(): Promise<Snapshot> {
  const t = await db.query('SELECT id, name, slug FROM trades WHERE slug IS NOT NULL');
  const tradeById = new Map<string, string>(t.rows.map((r: any) => [String(r.id), String(r.slug)]));
  const trades = new Map<string, string>(t.rows.map((r: any) => [String(r.slug), String(r.name)]));
  const RICH = `
    SELECT o.id, o.title, o.location_city, o.location_department, o.deadline, o.buyer_name, ot.code AS journey, o.source_reference,
           o.estimated_value, o.trade_id, COALESCE(o.updated_at, o.created_at) AS updated_at,
           o.raw_data->>'ville_avis' AS ville_avis,
           NULLIF(substring(o.raw_data->>'donnees', strpos(o.raw_data->>'donnees', '"organisme"'), 1200), '') AS organisme
      FROM opportunities o
      JOIN opportunity_types ot ON ot.id = o.opportunity_type_id
      LEFT JOIN data_sources ds ON ds.id = o.source_id
     WHERE o.deleted_at IS NULL AND COALESCE(o.status, '') = 'active'
       AND COALESCE(ds.code, '') <> 'editorial_catalog'
       AND (ds.code IS DISTINCT FROM 'ted' OR o.location_country IN ('FR', 'FRA'))
       AND (o.deadline >= NOW() OR (o.deadline IS NULL AND o.created_at >= NOW() - INTERVAL '45 days'))
     LIMIT 60000`;
  const PLAIN = `
    SELECT o.id, o.title, o.location_city, o.location_department, o.deadline, o.buyer_name, ot.code AS journey, o.source_reference,
           o.estimated_value, o.trade_id, COALESCE(o.updated_at, o.created_at) AS updated_at
      FROM opportunities o
      JOIN opportunity_types ot ON ot.id = o.opportunity_type_id
      LEFT JOIN data_sources ds ON ds.id = o.source_id
     WHERE o.deleted_at IS NULL AND COALESCE(o.status, '') = 'active'
       AND COALESCE(ds.code, '') <> 'editorial_catalog'
       AND (ds.code IS DISTINCT FROM 'ted' OR o.location_country IN ('FR', 'FRA'))
       AND (o.deadline >= NOW() OR (o.deadline IS NULL AND o.created_at >= NOW() - INTERVAL '45 days'))
     LIMIT 60000`;
  // La lecture de la commune dans l'avis (raw_data) est un plus : si elle échoue ou dépasse le délai, on garde les pages.
  const r = await db.query(RICH).catch(async (e: unknown) => { logger.error('[SEO v2] lecture des avis impossible, repli :', e); return db.query(PLAIN); });
  const cityNames = new Map<string, string>();
  const items: OpenItem[] = r.rows.map((o: any) => {
    // Commune = commune de l'ACHETEUR (adresse de l'organisme dans l'avis), jamais présentée comme lieu d'exécution :
    // le BOAMP ne donne le lieu d'exécution qu'au niveau du département dans la plupart des avis.
    const city = buyerCommune(o);
    const citySlug = city ? slugify(city) : null;
    if (citySlug && (!cityNames.has(citySlug) || /^[^a-zà-ÿ]*$/.test(cityNames.get(citySlug)!))) cityNames.set(citySlug, displayCity(city!));
    const ts = new Set<string>();
    if (o.trade_id && tradeById.has(String(o.trade_id))) ts.add(tradeById.get(String(o.trade_id))!);
    for (const s of extractTradeSlugs(o.title)) if (trades.has(s)) ts.add(s);
    return { id: String(o.id), title: String(o.title || '').trim(), city, citySlug, dept: normDept(o.location_department) || deptFromCp(o.organisme), deadline: o.deadline ? new Date(o.deadline).toISOString() : null,
      buyer: o.buyer_name && !/^\s*\d[\d\s]*$/.test(String(o.buyer_name)) ? String(o.buyer_name).trim() : null, journey: String(o.journey), reference: o.source_reference || null, value: o.estimated_value != null && Number.isFinite(Number(o.estimated_value)) ? Number(o.estimated_value) : null,
      trades: [...ts], updatedAt: new Date(o.updated_at).toISOString() };
  }).filter((i: OpenItem) => i.title);
  return { at: Date.now(), items, trades, cityNames };
}
export async function snapshot(): Promise<Snapshot> {
  if (snap && Date.now() - snap.at < 15 * 60000) return snap;
  if (!loading) loading = load().then(s => { snap = s; return s; }).finally(() => { loading = null; });
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

const byDeadline = (a: OpenItem, b: OpenItem) => (a.deadline ? Date.parse(a.deadline) : 9e15) - (b.deadline ? Date.parse(b.deadline) : 9e15);
const view = (i: OpenItem, trades: Map<string, string>) => ({ id: i.id, title: i.title, city: i.city, department: i.dept, deadline: i.deadline, buyer: i.buyer,
  reference: i.reference, estimatedValue: i.value, trades: i.trades.map(s => trades.get(s) || s), path: `/opportunites/${i.id}` });

export async function buildPage(args: { base: string; city?: string; trade?: string; department?: string }) {
  const journey = BASE_JOURNEY[args.base];
  if (!journey) return { status: 404 as const };
  const s = await snapshot();
  const pool = s.items.filter(i => i.journey === journey);
  let zone: { type: 'city' | 'department'; slug: string; name: string; department: string | null; departmentName: string | null };
  if (args.department) {
    const d = normDept(args.department); if (!d) return { status: 404 as const };
    zone = { type: 'department', slug: d.toLowerCase(), name: DEPARTMENTS[d], department: d, departmentName: DEPARTMENTS[d] };
  } else {
    const cs = slugify(args.city);
    if (!cs) return { status: 404 as const };
    let name = s.cityNames.get(cs);
    if (!name) {
      // Commune sans annonce ouverte aujourd'hui : on la reconnaît si elle a déjà eu une page ou une annonce (pas de page inventée).
      const known = await db.query(`SELECT location_city AS c, location_department AS d FROM opportunities WHERE location_city IS NOT NULL
        AND regexp_replace(lower(unaccent(location_city)), '[^a-z0-9]+', '-', 'g') = $1 LIMIT 1`, [cs]).catch(() => ({ rows: [] as any[] }));
      const legacy = known.rows[0] ? null : await db.query(`SELECT filter_city AS c, filter_department AS d FROM seo_pages WHERE filter_city IS NOT NULL
        AND regexp_replace(lower(unaccent(filter_city)), '[^a-z0-9]+', '-', 'g') = $1 LIMIT 1`, [cs]).catch(() => ({ rows: [] as any[] }));
      const row = known.rows[0] || legacy?.rows[0];
      if (!row) return { status: 404 as const };
      if (!isCommuneName(row.c)) {
        // Un acheteur pris pour une ville : on renvoie vers son département s'il est connu, sinon page introuvable.
        const d = normDept(row.d);
        return d ? { status: 301 as const, location: `/${args.base}/departement/${d.toLowerCase()}` } : { status: 404 as const };
      }
      name = String(row.c).trim();
    }
    const deptCounts = new Map<string, number>(); for (const i of s.items) if (i.citySlug === cs && i.dept) deptCounts.set(i.dept, (deptCounts.get(i.dept) || 0) + 1);
    const dept = [...deptCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    zone = { type: 'city', slug: cs, name, department: dept, departmentName: dept ? DEPARTMENTS[dept] : null };
  }
  let trade: { slug: string; name: string } | null = null;
  if (args.trade) {
    const t = resolveTrade(args.trade, s.trades);
    if (!t) return { status: 301 as const, location: zone.type === 'city' ? `/${args.base}/${zone.slug}` : `/${args.base}/departement/${zone.slug}` };
    trade = { slug: t, name: s.trades.get(t)! };
  }
  const canonicalPath = zone.type === 'city' ? `/${args.base}/${zone.slug}${trade ? `/${trade.slug}` : ''}` : `/${args.base}/departement/${zone.slug}${trade ? `/${trade.slug}` : ''}`;
  const inZoneAll = pool.filter(i => (zone.type === 'city' ? i.citySlug === zone.slug : i.dept === zone.department));
  const inZone = (trade ? inZoneAll.filter(i => i.trades.includes(trade!.slug)) : inZoneAll).sort(byDeadline);
  const nearbyPool = zone.type === 'city' && zone.department ? pool.filter(i => i.dept === zone.department && i.citySlug !== zone.slug && (!trade || i.trades.includes(trade.slug))) : [];
  const tradeCounts = new Map<string, number>(); for (const i of inZoneAll) for (const t of i.trades) tradeCounts.set(t, (tradeCounts.get(t) || 0) + 1);
  const cityCounts = new Map<string, number>();
  for (const i of pool) if (i.citySlug && i.dept && i.dept === zone.department && i.citySlug !== (zone.type === 'city' ? zone.slug : '')) cityCounts.set(i.citySlug, (cityCounts.get(i.citySlug) || 0) + 1);
  const buyerCounts = new Map<string, number>(); for (const i of inZone) if (i.buyer) buyerCounts.set(i.buyer, (buyerCounts.get(i.buyer) || 0) + 1);
  const otherTypes = Object.entries(JOURNEY_BASE).filter(([j]) => j !== journey).map(([j, b]) => ({ base: b, journey: j,
    count: s.items.filter(i => i.journey === j && (zone.type === 'city' ? i.citySlug === zone.slug : i.dept === zone.department) && (!trade || i.trades.includes(trade.slug))).length }));
  const indexable = inZone.length > 0;
  const lastmod = inZone.reduce<string | null>((m, i) => (!m || i.updatedAt > m ? i.updatedAt : m), null);
  return {
    status: 200 as const, journey, base: args.base, zone, trade, canonicalPath, indexable,
    indexReason: indexable ? 'au moins une annonce ouverte dans la zone' : 'aucune annonce ouverte dans la zone aujourd’hui (page conservée, non indexée)',
    count: inZone.length, items: inZone.slice(0, 60).map(i => view(i, s.trades)), nearbyCount: nearbyPool.length, nearby: nearbyPool.sort(byDeadline).slice(0, 8).map(i => view(i, s.trades)),
    trades: [...tradeCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([slug, n]) => ({ slug, name: s.trades.get(slug) || slug, count: n })),
    cities: [...cityCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([slug, n]) => ({ slug, name: s.cityNames.get(slug) || slug, count: n })),
    buyers: [...buyerCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([name, n]) => ({ name, count: n })),
    otherTypes, nextDeadline: inZone.find(i => i.deadline)?.deadline || null, lastmod, generatedAt: new Date(s.at).toISOString(),
  };
}

/** Pages indexables (sitemap) : seules les zones/métiers avec au moins une annonce ouverte. */
export async function indexablePaths(): Promise<{ path: string; lastmod: string; count: number }[]> {
  const s = await snapshot();
  const acc = new Map<string, { lastmod: string; count: number }>();
  const add = (p: string, i: OpenItem) => { const a = acc.get(p); if (!a) acc.set(p, { lastmod: i.updatedAt, count: 1 }); else { a.count++; if (i.updatedAt > a.lastmod) a.lastmod = i.updatedAt; } };
  for (const i of s.items) {
    const base = JOURNEY_BASE[i.journey]; if (!base) continue;
    if (i.dept) { add(`/${base}/departement/${i.dept.toLowerCase()}`, i); for (const t of i.trades) add(`/${base}/departement/${i.dept.toLowerCase()}/${t}`, i); }
    if (i.citySlug) { add(`/${base}/${i.citySlug}`, i); for (const t of i.trades) add(`/${base}/${i.citySlug}/${t}`, i); }
  }
  return [...acc.entries()].map(([path, v]) => ({ path, ...v })).sort((a, b) => b.count - a.count);
}

/** Liens de navigation pour l'accueil et les pages catégories : zones les plus fournies, chiffres réels. */
export async function topLinks(journey?: string) {
  const s = await snapshot();
  const pool = journey ? s.items.filter(i => i.journey === journey) : s.items;
  const depts = new Map<string, number>(); const cities = new Map<string, number>(); const trades = new Map<string, number>();
  for (const i of pool) { if (i.dept) depts.set(i.dept, (depts.get(i.dept) || 0) + 1); if (i.citySlug) cities.set(i.citySlug, (cities.get(i.citySlug) || 0) + 1); for (const t of i.trades) trades.set(t, (trades.get(t) || 0) + 1); }
  const byType = Object.fromEntries(Object.keys(JOURNEY_BASE).map(j => [j, s.items.filter(i => i.journey === j).length]));
  return { total: pool.length, byType,
    departments: [...depts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([code, n]) => ({ code, slug: code.toLowerCase(), name: DEPARTMENTS[code] || code, count: n })),
    cities: [...cities.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([slug, n]) => ({ slug, name: s.cityNames.get(slug) || slug, count: n })),
    trades: [...trades.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([slug, n]) => ({ slug, name: s.trades.get(slug) || slug, count: n })),
    generatedAt: new Date(s.at).toISOString() };
}
