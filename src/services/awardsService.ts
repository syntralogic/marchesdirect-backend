import { db } from '../config/database';
import { cached } from '../utils/ttlCache';
import { APE_TRADE_SLUGS } from './matchEngine';

// Contrats attribués (7 nov.) : ce que les attributions publiques (DECP, Licence Ouverte) disent d'un marché, d'un acheteur
// et des entreprises qui gagnent. Règles d'honnêteté : jamais de probabilité de gagner ; des fourchettes seulement entre
// marchés COMPARABLES (même famille CPV à 4 chiffres, même type, montants hors anomalies, 5 marchés au moins) ; la
// saisonnalité seulement avec 12 mois d'historique et 8 marchés au moins ; les « entreprises comme la vôtre » comptées,
// jamais nommées (le nom des titulaires est public, mais l'artisan n'en a pas besoin pour décider).

// Métier → codes NAF des entreprises qui l'exercent (inverse de la table APE → métier du moteur de correspondance).
const NAF_BY_TRADE: Record<string, string[]> = {};
for (const [ape, slugs] of Object.entries(APE_TRADE_SLUGS)) for (const s of slugs) (NAF_BY_TRADE[s] ||= []).push(`${ape.slice(0, 2)}.${ape.slice(2)}`);

// Famille CPV (4 premiers chiffres) par métier : la base des comparaisons de prix. Source : vocabulaire commun CPV.
export const CPV_BY_TRADE: Record<string, string[]> = {
  cvc: ['4533', '4525', '5072', '5073', '4523'], plomberie: ['4533', '4523'], electricite: ['4531', '4521', '5071', '4531'], couverture: ['4526', '4526'],
  isolation: ['4532', '4542'], platrerie: ['4541', '4532'], menuiserie: ['4542', '4544'], carrelage: ['4543'], peinture: ['4544'], vitrerie: ['4544'],
  charpente: ['4526', '4542'], maconnerie: ['4526', '4522'], 'gros-oeuvre': ['4521', '4522', '4526'], demolition: ['4511'], vrd: ['4523', '4511', '4524'],
  'batiment-general': ['4521', '4526', '4545'], 'espaces-verts': ['7731', '4511'], nettoyage: ['9091', '9092', '9060'], maintenance: ['5070', '5071', '5072'],
};

const hasTable = () => cached('awards:table', 600_000, async () =>
  (await db.query(`SELECT 1 FROM information_schema.tables WHERE table_name = 'public_awards'`)).rows.length > 0).catch(() => false);

export interface PriceRange { count: number; low: number; median: number; high: number; scope: 'departement' | 'region' | 'france'; years: number; cpvFamily: string; sample: { objet: string; montant: number; acheteur: string | null; year: number }[] }

/** Fourchette de montants des marchés comparables (même famille CPV, même type), au plus près géographiquement. */
export async function priceRange(cpv: string | null, type: string | null, department: string | null): Promise<PriceRange | null> {
  if (!cpv || cpv.length < 4 || !(await hasTable())) return null;
  const fam = cpv.slice(0, 4);
  return cached(`awards:price:${fam}:${type}:${department}`, 6 * 3600_000, async () => {
    const scopes: [PriceRange['scope'], string, unknown[]][] = [];
    if (department) scopes.push(['departement', `AND lieu_departement = $3`, [department]]);
    scopes.push(['france', '', []]);
    for (const [scope, cond, extra] of scopes) {
      const r = await db.query(`SELECT COUNT(*)::int AS n,
          percentile_cont(0.2) WITHIN GROUP (ORDER BY montant_rationalise) AS low, percentile_cont(0.5) WITHIN GROUP (ORDER BY montant_rationalise) AS med,
          percentile_cont(0.8) WITHIN GROUP (ORDER BY montant_rationalise) AS high
        FROM public_awards WHERE left(cpv, 4) = $1 AND ($2::text IS NULL OR type = $2) AND COALESCE(montant_anomalie, '') <> 'aberrant'
          AND montant_rationalise BETWEEN 1000 AND 50000000 AND date_notification >= CURRENT_DATE - INTERVAL '3 years' ${cond}`, [fam, type, ...extra]);
      const n = r.rows[0]?.n || 0;
      if (n >= 5) {
        const s = await db.query(`SELECT objet, montant_rationalise AS montant, acheteur_nom, EXTRACT(YEAR FROM date_notification)::int AS year FROM public_awards
          WHERE left(cpv, 4) = $1 AND ($2::text IS NULL OR type = $2) AND COALESCE(montant_anomalie, '') <> 'aberrant' AND montant_rationalise BETWEEN 1000 AND 50000000
            AND date_notification >= CURRENT_DATE - INTERVAL '3 years' ${cond} AND objet IS NOT NULL ORDER BY date_notification DESC LIMIT 3`, [fam, type, ...extra]);
        return { count: n, low: Math.round(r.rows[0].low), median: Math.round(r.rows[0].med), high: Math.round(r.rows[0].high), scope, years: 3, cpvFamily: fam,
          sample: s.rows.map((x: any) => ({ objet: String(x.objet).slice(0, 140), montant: Math.round(Number(x.montant)), acheteur: x.acheteur_nom, year: x.year })) };
      }
    }
    return null;
  });
}

export interface Peers { trade: string; count: number; pme: number; sameDepartment: number; recentExample: { objet: string; year: number; department: string | null } | null }

/** Entreprises du même métier (code NAF) ayant gagné un marché comparable (même famille CPV) depuis 3 ans. Comptées, non nommées. */
export async function peersWhoWon(tradeSlugs: string[], cpv: string | null, department: string | null, companySize: 'PME' | 'ETI' | 'GE' | null): Promise<Peers | null> {
  if (!cpv || cpv.length < 4 || !tradeSlugs.length || !(await hasTable())) return null;
  const nafs = [...new Set(tradeSlugs.flatMap(s => NAF_BY_TRADE[s] || []))]; if (!nafs.length) return null;
  const fam = cpv.slice(0, 4);
  return cached(`awards:peers:${fam}:${nafs.join('|')}:${department}:${companySize}`, 6 * 3600_000, async () => {
    const r = await db.query(`SELECT COUNT(DISTINCT titulaire_id)::int AS n, COUNT(DISTINCT titulaire_id) FILTER (WHERE titulaire_categorie = 'PME')::int AS pme,
        COUNT(DISTINCT titulaire_id) FILTER (WHERE lieu_departement = $3)::int AS same_dept
      FROM public_awards WHERE left(cpv, 4) = $1 AND titulaire_naf = ANY($2::text[]) AND date_notification >= CURRENT_DATE - INTERVAL '3 years'`, [fam, nafs, department]);
    const n = r.rows[0]?.n || 0; if (!n) return null;
    const ex = await db.query(`SELECT objet, EXTRACT(YEAR FROM date_notification)::int AS year, lieu_departement FROM public_awards
      WHERE left(cpv, 4) = $1 AND titulaire_naf = ANY($2::text[]) AND date_notification >= CURRENT_DATE - INTERVAL '3 years' AND objet IS NOT NULL
      ORDER BY (lieu_departement = $3) DESC, date_notification DESC LIMIT 1`, [fam, nafs, department]);
    return { trade: tradeSlugs[0], count: n, pme: r.rows[0].pme, sameDepartment: r.rows[0].same_dept,
      recentExample: ex.rows[0] ? { objet: String(ex.rows[0].objet).slice(0, 140), year: ex.rows[0].year, department: ex.rows[0].lieu_departement } : null };
  });
}

export interface BuyerAwards { contracts: number; years: number; byMonth: number[]; peakMonths: number[]; topTypes: { label: string; count: number }[]; pmeShare: number | null; medianAmount: number | null; avgOffers: number | null }

/** Habitudes d'un acheteur : mois de notification, familles de travaux, part de PME, nombre d'offres reçues. */
export async function buyerAwards(buyerSiret: string | null, buyerName: string | null): Promise<BuyerAwards | null> {
  if (!(await hasTable())) return null;
  const key = buyerSiret ? `siret:${buyerSiret}` : buyerName ? `nom:${buyerName.toLowerCase()}` : null; if (!key) return null;
  return cached(`awards:buyer:${key}`, 12 * 3600_000, async () => {
    const cond = buyerSiret ? `acheteur_id = $1` : `unaccent(lower(acheteur_nom)) = unaccent(lower($1))`;
    const p = [buyerSiret || buyerName];
    const r = await db.query(`SELECT COUNT(DISTINCT uid)::int AS n, MIN(date_notification) AS first, MAX(date_notification) AS last,
        AVG(offres_recues) FILTER (WHERE offres_recues > 0) AS offers, percentile_cont(0.5) WITHIN GROUP (ORDER BY montant_rationalise) AS med,
        COUNT(*) FILTER (WHERE titulaire_categorie = 'PME')::float / NULLIF(COUNT(*) FILTER (WHERE titulaire_categorie IS NOT NULL), 0) AS pme
      FROM public_awards WHERE ${cond} AND type IN ('Travaux', 'Services')`, p);
    const n = r.rows[0]?.n || 0; if (n < 8) return null;
    const months = await db.query(`SELECT EXTRACT(MONTH FROM date_notification)::int AS m, COUNT(DISTINCT uid)::int AS n FROM public_awards WHERE ${cond} AND type IN ('Travaux', 'Services') GROUP BY 1`, p);
    const byMonth = Array(12).fill(0); for (const x of months.rows) byMonth[x.m - 1] = x.n;
    const span = (new Date(r.rows[0].last).getTime() - new Date(r.rows[0].first).getTime()) / (365.25 * 86400000);
    const avg = n / 12; const peak = byMonth.map((v, i) => [v, i + 1] as const).filter(([v]) => v >= Math.max(3, avg * 1.6)).map(([, m]) => m);
    const types = await db.query(`SELECT left(cpv, 4) AS fam, COUNT(DISTINCT uid)::int AS n FROM public_awards WHERE ${cond} AND cpv IS NOT NULL AND type IN ('Travaux', 'Services') GROUP BY 1 ORDER BY 2 DESC LIMIT 4`, p);
    return { contracts: n, years: Math.max(1, Math.round(span * 10) / 10), byMonth, peakMonths: span >= 1 ? peak : [], topTypes: types.rows.map((x: any) => ({ label: CPV_LABEL[x.fam] || `CPV ${x.fam}`, count: x.n })),
      pmeShare: r.rows[0].pme != null ? Math.round(Number(r.rows[0].pme) * 100) : null, medianAmount: r.rows[0].med != null ? Math.round(Number(r.rows[0].med)) : null,
      avgOffers: r.rows[0].offers != null ? Math.round(Number(r.rows[0].offers) * 10) / 10 : null };
  });
}

export const CPV_LABEL: Record<string, string> = {
  '4521': 'bâtiments', '4522': 'gros œuvre', '4523': 'voirie et réseaux', '4524': 'ouvrages hydrauliques', '4525': 'installations techniques', '4526': 'toiture et structures',
  '4531': 'électricité', '4532': 'isolation', '4533': 'plomberie, chauffage, climatisation', '4541': 'plâtrerie', '4542': 'menuiserie', '4543': 'revêtements de sol et murs',
  '4544': 'peinture et vitrerie', '4545': 'rénovation et entretien de bâtiments', '4511': 'démolition et terrassement', '5070': 'réparation et entretien de bâtiments',
  '5071': 'entretien des installations électriques', '5072': 'entretien chauffage et climatisation', '5073': 'entretien des installations de refroidissement',
  '9091': 'nettoyage', '9092': 'désinfection et désinsectisation', '9060': 'nettoyage urbain', '7731': 'espaces verts',
};
export const MONTHS_FR = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
