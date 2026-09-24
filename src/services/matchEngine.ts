import { extractTradeSlugs } from './tradeResolver';

// ============================================================================
// COMPANY <-> MARKET MATCH (pure, no DB)
//
// 25 Sep client audit: the "indice de concordance" scored how COMPLETE the
// notice was (description length, budget present, deadline present...) and
// showed 55 % for a painting job to a heating/air-conditioning company, while
// telling the visitor it compared the company with the market. It never
// looked at the company at all.
//
// This engine compares what the market asks for with what the company does,
// criterion by criterion, and each criterion ends in one of three states:
//   match     - the data shows it fits
//   confirm   - not known yet, the visitor has to confirm
//   mismatch  - the data (or the visitor) says it does not fit
// A percentage is produced only when the métier AND the zone could really be
// compared; otherwise the score stays null and the UI says "à confirmer".
// Nothing about the notice's length, budget presence or Google reviews counts.
// ============================================================================

export type CriterionStatus = 'match' | 'confirm' | 'mismatch';
export type RefineAnswer = 'oui' | 'non' | 'a_confirmer';

export interface RefineAnswers {
  experience?: RefineAnswer;
  capacity?: RefineAnswer;
  location?: RefineAnswer;
  calendar?: RefineAnswer;
}

export interface MatchCriterion {
  key: 'metier' | 'zone' | 'experience' | 'moyens' | 'disponibilite' | 'qualifications';
  label: string;
  status: CriterionStatus;
  detail: string;          // one plain-French sentence justifying the status
  weight: number;          // share of the index (0 = informational)
  factor: number;          // 0..1, how much of the weight is earned
  answered: boolean;       // true when the visitor's own answer decided it
}

export interface CompanyProfile {
  source: 'account' | 'siret';
  name: string | null;
  tradeSlugs: string[];            // normalised métiers the company does
  activityText: string | null;     // human wording of the declared activity
  latitude: number | null;
  longitude: number | null;
  department: string | null;
  city: string | null;
  radiusKm: number | null;
  annualRevenue: number | null;
  recentReferenceCount: number | null;   // null = not known (no account data)
  certificationText: string;             // certifications/labels on file
}

export interface MarketInput {
  tradeSlugs: string[];            // normalised métiers the market asks for
  latitude: number | null;
  longitude: number | null;
  department: string | null;
  estimatedValue: number | null;
  deadline: Date | string | null;
  requiredQualifications: string | null;
}

export interface MatchEvaluation {
  score: number | null;
  criteria: MatchCriterion[];
  metierStatus: CriterionStatus;
}

export const TRADE_LABELS: Record<string, string> = {
  'gros-oeuvre': 'gros œuvre', demolition: 'démolition', maconnerie: 'maçonnerie', charpente: 'charpente',
  couverture: 'couverture / étanchéité', electricite: 'électricité', plomberie: 'plomberie', cvc: 'chauffage, ventilation, climatisation',
  isolation: 'isolation', platrerie: 'plâtrerie', menuiserie: 'menuiserie', carrelage: 'carrelage', peinture: 'peinture',
  vitrerie: 'vitrerie', vrd: 'voirie et réseaux', 'batiment-general': 'bâtiment général', 'espaces-verts': 'espaces verts',
  nettoyage: 'nettoyage', maintenance: 'maintenance',
};

const labelList = (slugs: string[]) => slugs.map((s) => TRADE_LABELS[s] || s).join(', ');

// Building trades a general contractor (bâtiment général / gros œuvre) can
// plausibly take on or sub-contract: a partial, not a full, match.
const GENERAL_CONTRACTOR = new Set(['batiment-general', 'gros-oeuvre']);
const BUILDING_TRADES = new Set(['maconnerie', 'charpente', 'couverture', 'isolation', 'platrerie', 'menuiserie', 'carrelage', 'peinture', 'vitrerie', 'demolition', 'gros-oeuvre', 'batiment-general']);

// APE / NAF code -> normalised métiers. Used as an indication of what the
// company does (the client's rule: APE as a hint, then let the craftsman
// refine).
export const APE_TRADE_SLUGS: Record<string, string[]> = {
  '4120A': ['batiment-general'], '4120B': ['batiment-general'],
  '4211Z': ['vrd'], '4212Z': ['vrd'], '4213A': ['vrd'], '4213B': ['vrd'], '4221Z': ['vrd'], '4222Z': ['vrd'], '4291Z': ['vrd'], '4299Z': ['vrd'],
  '4311Z': ['demolition'], '4312A': ['vrd'], '4312B': ['vrd'],
  '4321A': ['electricite'], '4321B': ['electricite'],
  '4322A': ['plomberie'], '4322B': ['cvc'],
  '4329A': ['isolation'], '4329B': [],
  '4331Z': ['platrerie'], '4332A': ['menuiserie'], '4332B': ['menuiserie'], '4332C': ['menuiserie'],
  '4333Z': ['carrelage'], '4334Z': ['peinture', 'vitrerie'],
  '4391A': ['charpente'], '4391B': ['couverture'],
  '4399A': ['couverture'], '4399B': [], '4399C': ['maconnerie', 'gros-oeuvre'], '4399D': [], '4399E': [],
  '8121Z': ['nettoyage'], '8122Z': ['nettoyage'], '8129A': ['nettoyage'], '8129B': ['nettoyage'], '8130Z': ['espaces-verts'],
};

export function tradeSlugsForCompany(apeCode: string | null | undefined, ...texts: (string | null | undefined)[]): string[] {
  const found = new Set<string>();
  const code = String(apeCode || '').replace(/[.\s]/g, '').toUpperCase();
  for (const s of APE_TRADE_SLUGS[code] || []) found.add(s);
  for (const t of texts) for (const s of extractTradeSlugs(t)) found.add(s);
  return [...found];
}

function distanceKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const WEIGHTS = { metier: 40, zone: 20, experience: 10, moyens: 15, disponibilite: 15 } as const;

const apply = (base: MatchCriterion, answer: RefineAnswer | undefined, texts: { oui: string; non: string }): MatchCriterion => {
  if (answer === 'oui') return { ...base, status: 'match', factor: 1, answered: true, detail: texts.oui };
  if (answer === 'non') return { ...base, status: 'mismatch', factor: 0, answered: true, detail: texts.non };
  return base;
};

export function evaluateMatch(company: CompanyProfile | null, market: MarketInput, answers: RefineAnswers = {}, now: Date = new Date()): MatchEvaluation {
  // --- Métier ---------------------------------------------------------------
  let metier: MatchCriterion;
  const marketLabel = labelList(market.tradeSlugs);
  if (!company) {
    metier = { key: 'metier', label: 'Métier', status: 'confirm', factor: 0, weight: WEIGHTS.metier, answered: false, detail: 'Identifiez votre entreprise pour comparer ses activités aux prestations demandées.' };
  } else if (market.tradeSlugs.length === 0) {
    metier = { key: 'metier', label: 'Métier', status: 'confirm', factor: 0, weight: WEIGHTS.metier, answered: false, detail: 'Les prestations demandées ne sont pas identifiables avec certitude dans l’annonce : à confirmer.' };
  } else if (company.tradeSlugs.length === 0) {
    metier = { key: 'metier', label: 'Métier', status: 'confirm', factor: 0, weight: WEIGHTS.metier, answered: false, detail: `Le marché demande : ${marketLabel}. Votre activité n’a pas pu être rattachée à un métier : précisez vos prestations.` };
  } else {
    const common = market.tradeSlugs.filter((s) => company.tradeSlugs.includes(s));
    const companyIsGeneral = company.tradeSlugs.some((s) => GENERAL_CONTRACTOR.has(s));
    if (common.length > 0) {
      metier = { key: 'metier', label: 'Métier', status: 'match', factor: 1, weight: WEIGHTS.metier, answered: false, detail: `Le marché demande : ${marketLabel}. Cela correspond à votre activité (${labelList(common)}).` };
    } else if (companyIsGeneral && market.tradeSlugs.some((s) => BUILDING_TRADES.has(s))) {
      metier = { key: 'metier', label: 'Métier', status: 'confirm', factor: 0.6, weight: WEIGHTS.metier, answered: false, detail: `Le marché demande : ${marketLabel}. En tant qu’entreprise de bâtiment général, vous pouvez y répondre ou sous-traiter : à confirmer.` };
    } else {
      metier = { key: 'metier', label: 'Métier', status: 'mismatch', factor: 0, weight: WEIGHTS.metier, answered: false, detail: `Le marché demande : ${marketLabel}. Votre activité déclarée (${labelList(company.tradeSlugs)}) ne correspond pas.` };
    }
  }

  // --- Zone -----------------------------------------------------------------
  let zone: MatchCriterion = { key: 'zone', label: 'Zone d’intervention', status: 'confirm', factor: 0, weight: WEIGHTS.zone, answered: false, detail: 'Distance non évaluable : localisation de l’entreprise ou du marché inconnue. Précisez votre zone d’intervention.' };
  if (company) {
    if (company.latitude != null && company.longitude != null && market.latitude != null && market.longitude != null) {
      const km = Math.round(distanceKm(Number(company.latitude), Number(company.longitude), Number(market.latitude), Number(market.longitude)));
      const radius = company.radiusKm || 100;
      zone = km <= radius
        ? { ...zone, status: 'match', factor: 1, detail: `Marché à environ ${km} km, dans votre rayon d’intervention de ${radius} km.` }
        : { ...zone, status: 'mismatch', factor: 0, detail: `Marché à environ ${km} km, au-delà de votre rayon d’intervention de ${radius} km.` };
    } else if (company.department && market.department && company.department === market.department) {
      zone = { ...zone, status: 'match', factor: 1, detail: `Le marché se situe dans votre département (${company.department}).` };
    }
  }
  zone = apply(zone, answers.location, {
    oui: 'Vous avez confirmé pouvoir intervenir sur cette zone.',
    non: 'Vous avez indiqué ne pas pouvoir intervenir sur cette zone.',
  });

  // --- Expérience -------------------------------------------------------------
  let experience: MatchCriterion = { key: 'experience', label: 'Expérience', status: 'confirm', factor: 0, weight: WEIGHTS.experience, answered: false, detail: 'Aucune référence comparable enregistrée : à confirmer.' };
  if (company && (company.recentReferenceCount || 0) > 0) {
    experience = { ...experience, status: 'match', factor: 1, detail: 'Une référence de moins de 3 ans figure dans votre dossier.' };
  }
  experience = apply(experience, answers.experience, {
    oui: 'Vous avez confirmé une expérience sur des marchés comparables.',
    non: 'Vous avez indiqué ne pas avoir d’expérience comparable.',
  });

  // --- Moyens -----------------------------------------------------------------
  let moyens: MatchCriterion = { key: 'moyens', label: 'Moyens', status: 'confirm', factor: 0, weight: WEIGHTS.moyens, answered: false, detail: 'Vos moyens humains et matériels ne sont pas connus : à confirmer.' };
  if (company && market.estimatedValue && company.annualRevenue) {
    moyens = Number(market.estimatedValue) <= Number(company.annualRevenue) * 3
      ? { ...moyens, status: 'match', factor: 1, detail: 'Montant du marché compatible avec votre chiffre d’affaires (au plus 3 fois).' }
      : { ...moyens, status: 'mismatch', factor: 0, detail: 'Montant du marché supérieur à 3 fois votre chiffre d’affaires.' };
  }
  moyens = apply(moyens, answers.capacity, {
    oui: 'Vous avez confirmé disposer des moyens nécessaires.',
    non: 'Vous avez indiqué ne pas disposer des moyens nécessaires.',
  });

  // --- Disponibilité ------------------------------------------------------------
  let dispo: MatchCriterion = { key: 'disponibilite', label: 'Disponibilité', status: 'confirm', factor: 0, weight: WEIGHTS.disponibilite, answered: false, detail: 'Votre disponibilité sur le calendrier du marché est à confirmer.' };
  if (market.deadline) {
    const days = Math.ceil((new Date(market.deadline).getTime() - now.getTime()) / 86400000);
    if (days <= 0) dispo = { ...dispo, status: 'mismatch', factor: 0, detail: 'La date limite de remise est dépassée.' };
    else if (days <= 3) dispo = { ...dispo, detail: `Échéance dans ${days} jour${days > 1 ? 's' : ''} : confirmez que vous pouvez répondre dans ce délai.` };
  }
  dispo = apply(dispo, answers.calendar, {
    oui: 'Vous avez confirmé être disponible sur ce calendrier.',
    non: 'Vous avez indiqué ne pas être disponible sur ce calendrier.',
  });

  // --- Qualifications (informational: never invented, never scored) -------------
  const q = (market.requiredQualifications || '').trim();
  const noQualNeeded = !q || /^(aucune?|non (exig|requis|pr[ée]cis)|not available|n\/?a)/i.test(q);
  const qualifications: MatchCriterion = noQualNeeded
    ? { key: 'qualifications', label: 'Qualifications', status: 'confirm', factor: 0, weight: 0, answered: false, detail: 'Aucune qualification précisée dans les données disponibles : à vérifier dans le règlement de consultation.' }
    : { key: 'qualifications', label: 'Qualifications', status: 'confirm', factor: 0, weight: 0, answered: false, detail: `Qualifications indiquées dans l’avis : ${q}. Vérifiez que vous les détenez.` };
  if (!noQualNeeded && company?.certificationText) {
    const wanted = q.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4);
    if (wanted.some((w) => company.certificationText.toLowerCase().includes(w))) {
      qualifications.status = 'match';
      qualifications.detail = `Qualifications indiquées dans l’avis : ${q}. Une certification correspondante figure à votre dossier.`;
    }
  }

  const criteria = [metier, zone, experience, moyens, dispo, qualifications];

  // --- Score ---------------------------------------------------------------------
  // Only when the two structural criteria could really be compared.
  const metierKnown = metier.status !== 'confirm' || metier.factor > 0;
  const zoneKnown = zone.status !== 'confirm';
  let score: number | null = null;
  // A confirmed métier mismatch already settles the verdict (capped below),
  // so it does not have to wait for the zone to be known.
  if (company && metierKnown && (zoneKnown || metier.status === 'mismatch')) {
    const total = criteria.reduce((s, c) => s + c.weight, 0);
    const earned = criteria.reduce((s, c) => s + c.weight * c.factor, 0);
    score = Math.round((earned / total) * 100);
    if (metier.status === 'mismatch') score = Math.min(score, 25);
  }
  return { score, criteria, metierStatus: metier.status };
}
