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
// Guide v24 s.5: what the data really establishes for one criterion.
//   verified_match = 1, declared_match = 0.5 (an answer "Oui" is a declaration, not a check),
//   mismatch = 0, unknown = 0, not_applicable = left out of the denominator.
export type EvidenceState = 'verified_match' | 'declared_match' | 'mismatch' | 'unknown' | 'not_applicable';
export const EVIDENCE_COEFFICIENT: Record<EvidenceState, number> = { verified_match: 1, declared_match: 0.5, mismatch: 0, unknown: 0, not_applicable: 0 };
export type VerdictCode = 'MARKET_CLOSED' | 'MANDATORY_UNMET' | 'REVIEW_REQUIRED' | 'ACTIVITY_MATCH' | 'ACTIVITY_UNCLEAR';
export interface MatchVerdict { code: VerdictCode; label: string; tone: 'neutral' | 'amber' | 'green'; priorityIssue: string | null; }
// The five fixed verdicts of the guide (priority order = this order).
export const VERDICT_LABELS: Record<VerdictCode, string> = {
  MARKET_CLOSED: 'Ce marché est clôturé',
  MANDATORY_UNMET: 'Une condition doit être vérifiée avant de candidater',
  REVIEW_REQUIRED: 'À étudier de près : des points demandent une vérification',
  ACTIVITY_MATCH: 'Votre activité correspond : étudiez ce marché',
  ACTIVITY_UNCLEAR: 'Précisons votre activité pour examiner ce marché',
};
export const CONCORDANCE_DISCLAIMER = 'Il ne mesure pas vos chances de gagner le marché.';
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
  evidence?: EvidenceState; // guide v24 s.5 state behind status/factor
  mandatory?: boolean;      // a condition the market makes compulsory
  conflict?: boolean;       // the visitor's answer contradicts what the data shows: to examine, never silently overwritten
  // v28 (5 Nov) — calcul continu : valeur 0..1 tirée des données (distance, ratio montant/CA, jours restants…),
  // points réellement gagnés et maximum possible sur 100 (la somme des points = le pourcentage affiché).
  value?: number;
  points?: number;
  maxPoints?: number;
}

export interface MatchFacts {
  km: number | null;               // distance siège -> lieu d'exécution, quand les deux sont géolocalisés
  radiusKm: number;                // rayon utilisé (déclaré, sinon 80 km par défaut)
  radiusDeclared: boolean;
  daysLeft: number | null;         // jours avant la date limite
  metierLevel: 'exact' | 'secondary' | 'general' | 'none' | 'unknown';
  revenueRatio: number | null;     // montant du marché / chiffre d'affaires
}
export interface MatchUpgrade { key: 'experience' | 'capacity' | 'location' | 'calendar'; label: string; points: number }

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
  // true when annualRevenue comes from a third-party estimate (e.g. a
  // Pappers/SIRET lookup marking the figure "estimé") rather than a real
  // filed amount - an estimate alone must not settle "moyens compatibles".
  revenueEstimated: boolean;
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
  // Criteria the market makes compulsory. Empty until Marchés Direct provides the
  // per-market list (guide: "critères obligatoires par marché" is still to be supplied).
  mandatoryCriteria?: MatchCriterion['key'][];
}

export interface MatchEvaluation {
  score: number | null;
  verdict: MatchVerdict;
  documentedCount: number;   // criteria settled by data (verified match or mismatch)
  toConfirmCount: number;    // applicable criteria still declared-only or unknown
  mandatoryUnmet: string[];
  criteria: MatchCriterion[];
  metierStatus: CriterionStatus;
  facts: MatchFacts;
  upgrades: MatchUpgrade[];        // ce que chaque réponse « oui » ferait gagner, en points
  adjustment: string | null;       // phrase quand un métier différent ou une zone hors de portée réduit le total
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
  '4211Z': ['vrd'], '4212Z': ['vrd'], '4213A': ['vrd'], '4213B': ['vrd'], '4221Z': ['vrd'], '4222Z': ['electricite', 'vrd'], '4291Z': ['vrd'], '4299Z': ['vrd'],
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

// 30 Sep client audit: "Bordeaux-Bordeaux affiché à 4 988 km" and "Marseille -> Ecully
// 4 850 km". Cause: unresolved geocodes are stored as a (0,0) sentinel (see
// geocodingService / the radius search, which already excludes them) but this
// criterion only null-checked, so (0,0) was measured as a real place - and
// Bordeaux to the Gulf of Guinea is ~4 990 km. A coordinate pair only counts
// as a location when it is finite, in range and not the (0,0) sentinel.
export const isUsableCoordinate = (lat: unknown, lng: unknown): boolean => {
  if (lat == null || lng == null || lat === '' || lng === '') return false;
  const la = Number(lat);
  const lo = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) return false;
  if (Math.abs(la) > 90 || Math.abs(lo) > 180) return false;
  if (Math.abs(la) < 0.0001 && Math.abs(lo) < 0.0001) return false;
  return true;
};

// 1 Oct client report: Bordeaux-Bordeaux still read ~4 988 km. Beyond the (0,0)
// sentinel, a geocoder can also return a homonym abroad (Bordeaux, Canada...).
// A point only counts as a location for a French market when it lies in
// metropolitan France or the row's own department says it is overseas (97x/98x).
export const isPlausibleFrenchLocation = (lat: unknown, lng: unknown, department?: string | null): boolean => {
  if (!isUsableCoordinate(lat, lng)) return false;
  const la = Number(lat);
  const lo = Number(lng);
  if (la >= 41 && la <= 51.5 && lo >= -5.6 && lo <= 10) return true;
  return /^9[78]/.test(String(department || '').trim());
};

function distanceKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// v28 (validé par le client le 5 nov.) : activité 30, zone 20, moyens 15, calendrier 15, références 10, qualifications 10.
// (Guide v24 : 40/15/15/10/10/10 en tout-ou-rien, ce qui ne donnait que des multiples de 5.)
const WEIGHTS = { metier: 30, moyens: 15, experience: 10, zone: 20, disponibilite: 15, qualifications: 10 } as const;
export const DEFAULT_RADIUS_KM = 80;
// Courbes continues (aucune IA, aucune donnée inventée) :
//  - zone : 1 / (1 + (d / R)²) — 12 km ≈ 0,98 ; 28 km ≈ 0,89 ; 80 km = 0,5 ; 150 km ≈ 0,22 (R = rayon, 80 km par défaut) ;
//  - moyens : r = montant / CA, 1 / (1 + (r / 0,9)³) — r 0,5 (CA = 2× le montant, plafond légal d'exigence) ≈ 0,85 ;
//  - calendrier : (jours − 2) / 19, borné 0..1 — J-21 et plus = 1 ; J-7 ≈ 0,26 ; J-2 = 0 ;
//  - donnée inconnue : 0 point (règle de Hedi, 6 nov. : « une inconnue reste inconnue », jamais une valeur flatteuse par
//    défaut). Elle reste dans le dénominateur et n'est jamais un refus ; un « oui » du visiteur la fait passer en déclaration.
export const zoneValue = (km: number, radius: number) => 1 / (1 + (km / radius) ** 2);
export const capacityValue = (ratio: number) => 1 / (1 + (ratio / 0.9) ** 3);
export const calendarValue = (days: number) => Math.max(0, Math.min(1, (days - 2) / 19));
const UNKNOWN_VALUE = 0;
const DECLARED_VALUE = 0.85;   // un « oui » du visiteur : déclaration, pas une preuve
const DECLARED_NO_VALUE = 0.1; // un « non » du visiteur sur ce chantier

// A visitor's answer is a declaration, never a check (guide s.5):
//  - "oui" on something unknown            -> declared_match (half the weight)
//  - "oui" on something the data refutes   -> conflict to examine, the evidence stays
//  - "oui" on something already verified   -> nothing to add
//  - "non"                                 -> mismatch (declared answer about this chantier always stands)
const apply = (base: MatchCriterion, answer: RefineAnswer | undefined, texts: { oui: string; non: string }): MatchCriterion => {
  if (answer === 'oui') {
    if (base.status === 'mismatch') return { ...base, answered: true, conflict: true, detail: `${base.detail} Vous avez répondu « oui » : ce point est à examiner, il ne remplace pas ce que montrent les données.` };
    if (base.status === 'match') return base;
    return { ...base, status: 'confirm', factor: 0.5, evidence: 'declared_match', answered: true, detail: texts.oui };
  }
  if (answer === 'non') {
    // Client audit (18 Oct): all four questions are about THIS chantier (experience, means, zone, calendar). General
    // company data (chiffre d'affaires, a past reference, the postal address) must never override what the visitor
    // says about their availability for it: a « non » always stands as the declared answer.
    return { ...base, status: 'mismatch', factor: 0, evidence: 'mismatch', answered: true, detail: texts.non };
  }
  return base;
};

const evidenceOf = (c: MatchCriterion): EvidenceState => {
  if (c.evidence) return c.evidence;
  if (c.status === 'match') return 'verified_match';
  if (c.status === 'mismatch') return 'mismatch';
  return c.factor > 0 ? 'declared_match' : 'unknown';
};

export function evaluateMatch(company: CompanyProfile | null, market: MarketInput, answers: RefineAnswers = {}, now: Date = new Date(), withUpgrades = true): MatchEvaluation {
  let metierLevel: MatchFacts['metierLevel'] = 'unknown';
  let factKm: number | null = null;
  let factDays: number | null = null;
  let factRatio: number | null = null;
  // --- Métier ---------------------------------------------------------------
  let metier: MatchCriterion;
  const marketLabel = labelList(market.tradeSlugs);
  if (!company) {
    metier = { key: 'metier', label: 'Activité', status: 'confirm', factor: 0, weight: WEIGHTS.metier, answered: false, detail: 'Identifiez votre entreprise pour comparer ses activités aux prestations demandées.' };
  } else if (market.tradeSlugs.length === 0) {
    // v28 : une activité non identifiable ne vaut pas « neutre » (un marché de repas scolaires ne doit pas sortir
    // à 49 % pour une entreprise de CVC) : 0,35, et la réduction « métier » s'applique.
    metier = { key: 'metier', label: 'Activité', status: 'confirm', factor: 0, value: 0.35, weight: WEIGHTS.metier, answered: false, detail: 'Les prestations demandées ne sont pas identifiables avec certitude dans l’annonce : à confirmer.' };
  } else if (company.tradeSlugs.length === 0) {
    metier = { key: 'metier', label: 'Activité', status: 'confirm', factor: 0, value: 0.35, weight: WEIGHTS.metier, answered: false, detail: `Le marché demande : ${marketLabel}. Votre activité n’a pas pu être rattachée à un métier : précisez vos prestations.` };
  } else {
    const common = market.tradeSlugs.filter((s) => company.tradeSlugs.includes(s));
    const companyIsGeneral = company.tradeSlugs.some((s) => GENERAL_CONTRACTOR.has(s));
    if (common.length > 0) {
      // Métier principal (code NAF) = 1 ; métier secondaire de l'entreprise = 0,85.
      const primary = common.includes(company.tradeSlugs[0]);
      metierLevel = primary ? 'exact' : 'secondary';
      metier = { key: 'metier', label: 'Activité', status: 'match', factor: 1, value: primary ? 1 : 0.85, weight: WEIGHTS.metier, answered: false, detail: primary ? `Le marché demande : ${marketLabel}. C’est votre métier principal.` : `Le marché demande : ${marketLabel}. Cela fait partie de vos activités (${labelList(common)}).` };
    } else if (companyIsGeneral && market.tradeSlugs.some((s) => BUILDING_TRADES.has(s))) {
      metierLevel = 'general';
      metier = { key: 'metier', label: 'Activité', status: 'confirm', factor: 0.5, value: 0.55, evidence: 'declared_match', weight: WEIGHTS.metier, answered: false, detail: `Le marché demande : ${marketLabel}. En tant qu’entreprise de bâtiment général, vous pouvez y répondre ou sous-traiter : à confirmer.` };
    } else {
      metierLevel = 'none';
      metier = { key: 'metier', label: 'Activité', status: 'mismatch', factor: 0, value: 0, weight: WEIGHTS.metier, answered: false, detail: `Le marché demande : ${marketLabel}. Votre activité déclarée (${labelList(company.tradeSlugs)}) ne correspond pas.` };
    }
  }

  // --- Zone -----------------------------------------------------------------
  // 27 Sep client audit, point 4: a company that never declared its rayon
  // d'intervention was silently given one (100 km) and scored match/mismatch
  // against it as if the visitor had confirmed it. A distance can still be
  // shown as information, but it only settles the criterion once the radius
  // is either the company's own declared value or confirmed by the visitor's
  // own answer (applied below via `apply`).
  let zone: MatchCriterion = { key: 'zone', label: 'Zone d’intervention', status: 'confirm', factor: 0, weight: WEIGHTS.zone, answered: false, detail: 'Distance non évaluable : localisation de l’entreprise ou du marché inconnue. Précisez votre zone d’intervention.' };
  if (company) {
    const sameDepartment = !!(company.department && market.department && company.department === market.department);
    const kmRaw = isPlausibleFrenchLocation(company.latitude, company.longitude, company.department) && isPlausibleFrenchLocation(market.latitude, market.longitude, market.department)
      ? Math.round(distanceKm(Number(company.latitude), Number(company.longitude), Number(market.latitude), Number(market.longitude)))
      // Same department but a huge distance can only be a bad geocode:
      // never display it, fall back to the department comparison below.
      : null;
    const km = kmRaw != null && !(sameDepartment && kmRaw > 250) ? kmRaw : null;
    if (km != null) {
      factKm = km;
      const v = zoneValue(km, company.radiusKm ?? DEFAULT_RADIUS_KM);
      if (company.radiusKm != null) {
        const radius = company.radiusKm;
        zone = km <= radius
          ? { ...zone, status: 'match', factor: 1, value: v, detail: `Marché à environ ${km} km, dans votre rayon d’intervention de ${radius} km.` }
          : { ...zone, status: 'mismatch', factor: 0, value: v, detail: `Marché à environ ${km} km, au-delà de votre rayon d’intervention de ${radius} km.` };
      } else {
        zone = { ...zone, value: v, detail: `Marché à environ ${km} km de votre siège.` };
      }
    } else if (company.department && market.department && company.department === market.department) {
      zone = { ...zone, status: 'match', factor: 1, value: 0.85, detail: `Le marché se situe dans votre département (${company.department}).` };
    } else if (company.department && market.department) {
      // Sans coordonnées : départements différents. Outre-mer contre métropole = hors de portée habituelle.
      const overseas = (d: string) => /^97/.test(d);
      const far = overseas(company.department) !== overseas(market.department);
      zone = { ...zone, value: far ? 0.02 : 0.35, detail: far ? `Marché en outre-mer (${market.department}), loin de votre siège (${company.department}).` : `Marché dans un autre département (${market.department}) que votre siège (${company.department}).` };
    }
  }
  zone = apply(zone, answers.location, {
    oui: 'Vous indiquez pouvoir intervenir sur cette zone : déclaration à vérifier.',
    non: 'Vous avez indiqué ne pas pouvoir intervenir sur cette zone.',
  });

  // --- Expérience -------------------------------------------------------------
  let experience: MatchCriterion = { key: 'experience', label: 'Références', status: 'confirm', factor: 0, weight: WEIGHTS.experience, answered: false, detail: 'Aucune référence comparable enregistrée : à confirmer.' };
  if (company && (company.recentReferenceCount || 0) > 0) {
    experience = { ...experience, status: 'match', factor: 1, detail: 'Une référence de moins de 3 ans figure dans votre dossier.' };
  }
  experience = apply(experience, answers.experience, {
    oui: 'Vous indiquez avoir des références comparables : déclaration à documenter.',
    non: 'Vous avez indiqué ne pas avoir d’expérience comparable.',
  });

  // --- Moyens -----------------------------------------------------------------
  // 27 Sep client audit, point 4: an estimated chiffre d'affaires (third-party
  // lookup, not a filed figure) was enough on its own to declare "moyens
  // compatibles" - a mismatch stays reliable either way (the market clearly
  // exceeds even the estimate), but a match on an estimate alone is only
  // provisional until the visitor confirms it or a real account figure backs it.
  let moyens: MatchCriterion = { key: 'moyens', label: 'Moyens', status: 'confirm', factor: 0, weight: WEIGHTS.moyens, answered: false, detail: 'Vos moyens humains et matériels ne sont pas connus : à confirmer.' };
  if (!market.estimatedValue) moyens = { ...moyens, detail: 'Montant du marché non publié : valeur neutre en attendant.' };
  if (company && market.estimatedValue && company.annualRevenue) {
    const ratio = Number(market.estimatedValue) / Number(company.annualRevenue);
    factRatio = Math.round(ratio * 100) / 100;
    const v = capacityValue(ratio);
    const share = ratio < 1 ? `${Math.max(1, Math.round(ratio * 100))} % de votre chiffre d’affaires` : `${(Math.round(ratio * 10) / 10).toString().replace('.', ',')} fois votre chiffre d’affaires`;
    const compatible = Number(market.estimatedValue) <= Number(company.annualRevenue) * 3;
    if (!compatible) {
      moyens = { ...moyens, status: 'mismatch', factor: 0, value: v, detail: `Montant du marché : ${share}, au-delà de ce qu’un acheteur accepte en général.` };
    } else if (!company.revenueEstimated) {
      moyens = { ...moyens, status: 'match', factor: 1, value: v, detail: `Montant du marché : ${share}.` };
    } else {
      moyens = { ...moyens, value: v, detail: `Montant du marché : ${share} (chiffre d’affaires estimé). Confirmez vos moyens ci-dessous.` };
    }
  }
  moyens = apply(moyens, answers.capacity, {
    oui: 'Vous indiquez disposer des moyens nécessaires : déclaration à vérifier.',
    non: 'Vous avez indiqué ne pas disposer des moyens nécessaires.',
  });

  // --- Disponibilité ------------------------------------------------------------
  let dispo: MatchCriterion = { key: 'disponibilite', label: 'Calendrier', status: 'confirm', factor: 0, weight: WEIGHTS.disponibilite, answered: false, detail: 'Votre disponibilité sur le calendrier du marché est à confirmer.' };
  if (market.deadline) {
    const days = Math.ceil((new Date(market.deadline).getTime() - now.getTime()) / 86400000);
    factDays = days;
    const v = calendarValue(days);
    // Le délai est un fait sur le marché ; la disponibilité de l'entreprise, elle, reste inconnue tant qu'elle ne l'a
    // pas confirmée : aucun point d'office (6 nov.). Le délai reste visible dans le texte et dans facts.daysLeft.
    if (days <= 0) dispo = { ...dispo, status: 'mismatch', factor: 0, value: 0, detail: 'La date limite de remise est dépassée.' };
    else if (days <= 3) dispo = { ...dispo, detail: `Échéance dans ${days} jour${days > 1 ? 's' : ''} : confirmez que vous pouvez répondre dans ce délai.` };
    else if (days <= 10) dispo = { ...dispo, detail: `J-${days} : délai serré pour préparer un mémoire technique (environ 10 jours ouvrés). Confirmez votre disponibilité.` };
    else if (days < 21) dispo = { ...dispo, detail: `J-${days} : délai correct, à organiser dès maintenant. Confirmez votre disponibilité.` };
    else dispo = { ...dispo, detail: `J-${days} : délai confortable pour préparer votre réponse. Confirmez votre disponibilité.` };
    void v;
  }
  dispo = apply(dispo, answers.calendar, {
    oui: 'Vous indiquez être disponible sur ce calendrier : déclaration à confirmer.',
    non: 'Vous avez indiqué ne pas être disponible sur ce calendrier.',
  });

  // --- Qualifications ---------------------------------------------------------
  // Scored (weight 10). Not applicable only when the notice itself says none is required;
  // missing data is "unknown", never a silent exclusion (guide s.5).
  const q = (market.requiredQualifications || '').trim();
  const explicitNone = /^(aucune?\b|non (exig|requis))/i.test(q);
  const unspecified = !q || /^(non pr[ée]cis|not available|n\/?a\b)/i.test(q);
  let qualifications: MatchCriterion;
  if (explicitNone) {
    qualifications = { key: 'qualifications', label: 'Qualifications', status: 'confirm', factor: 0, weight: WEIGHTS.qualifications, answered: false, evidence: 'not_applicable', detail: 'L’avis n’exige aucune qualification : critère non applicable.' };
  } else if (unspecified) {
    qualifications = { key: 'qualifications', label: 'Qualifications', status: 'confirm', factor: 0, weight: WEIGHTS.qualifications, answered: false, evidence: 'unknown', detail: 'Aucune qualification précisée dans les données disponibles : à vérifier dans le règlement de consultation.' };
  } else {
    qualifications = { key: 'qualifications', label: 'Qualifications', status: 'confirm', factor: 0, weight: WEIGHTS.qualifications, answered: false, evidence: 'unknown', detail: `Qualifications indiquées dans l’avis : ${q}. Vérifiez que vous les détenez.` };
    if (company?.certificationText) {
      const wanted = q.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4);
      if (wanted.some((w) => company.certificationText.toLowerCase().includes(w))) {
        qualifications = { ...qualifications, status: 'match', factor: 1, evidence: 'verified_match', detail: `Qualifications indiquées dans l’avis : ${q}. Une certification correspondante figure à votre dossier.` };
      }
    }
  }

  const mandatoryKeys = new Set(market.mandatoryCriteria || []);
  // v28 : facteur continu. Preuve des données -> valeur mesurée ; « oui » -> au moins 0,85 ; « non » -> 0,1 ; inconnu -> 0.
  const continuous = (c: MatchCriterion, evidence: EvidenceState): number => {
    if (evidence === 'not_applicable') return 0;
    if (c.answered && evidence === 'mismatch' && !c.conflict) return DECLARED_NO_VALUE;
    if (evidence === 'declared_match') return c.answered ? Math.max(c.value ?? 0, DECLARED_VALUE) : (c.value ?? DECLARED_VALUE);
    if (evidence === 'verified_match') return c.value ?? 1;
    if (evidence === 'mismatch') return c.value ?? 0;
    return c.value ?? UNKNOWN_VALUE;
  };
  const criteria = [metier, zone, experience, moyens, dispo, qualifications].map((c) => {
    const evidence = evidenceOf(c);
    return { ...c, evidence, factor: Math.round(continuous(c, evidence) * 1000) / 1000, mandatory: mandatoryKeys.has(c.key), conflict: !!c.conflict };
  });

  // --- Score (guide s.5) -----------------------------------------------------------
  // score = round(100 x sum(weight x coefficient) / sum(applicable weight)).
  // Unknowns earn nothing but are not refusals; a missing revenue figure carries no penalty of
  // its own; "not applicable" leaves the denominator. No percentage without an identified
  // company or without an applicable weight (guide s.5: "Si aucun poids applicable, ne pas afficher de pourcentage").
  // 17 Oct client report: a company with nothing documented yet (e.g. an unusual market such as a stand design,
  // no métier link, no zone/revenue/reference known) used to get NO percentage at all - the ring said "À confirmer"
  // and the page looked broken. The guide's formula still applies: unknowns earn 0 points, stay in the denominator
  // and are never a refusal, so the index is shown (0 % when nothing is established) as PROVISIONAL, with the
  // documented / to-confirm counts next to it. The verdict sentence is unchanged.
  const applicable = criteria.filter((c) => c.evidence !== 'not_applicable');
  const denominator = applicable.reduce((sum, c) => sum + c.weight, 0);
  // Un métier différent ou une zone hors de portée réduisent tout le total (sinon une entreprise à 7 000 km
  // garderait 40 % grâce aux autres critères). Inconnu = pas de réduction.
  const m0 = criteria.find((c) => c.key === 'metier')!;
  const z0 = criteria.find((c) => c.key === 'zone')!;
  const gateMetier = !company ? 1 : 0.2 + 0.8 * m0.factor;
  const gateZone = z0.evidence === 'unknown' && z0.value === undefined ? 1 : 0.3 + 0.7 * Math.min(1, z0.factor / 0.5);
  const gate = gateMetier * gateZone;
  for (const c of criteria) {
    if (c.evidence === 'not_applicable' || denominator === 0) { c.points = 0; c.maxPoints = 0; continue; }
    c.maxPoints = Math.round((1000 * c.weight) / denominator) / 10;
    c.points = Math.round((1000 * c.weight * c.factor * gate) / denominator) / 10;
  }
  const earned = applicable.reduce((sum, c) => sum + c.weight * c.factor, 0);
  const score: number | null = company && denominator > 0 ? Math.round((100 * earned * gate) / denominator) : null;
  const adjustment = !company || score === null ? null
    : gateMetier < 0.999 && m0.evidence === 'mismatch' ? 'Activité différente de la vôtre : le pourcentage est fortement réduit.'
    : gateZone < 0.999 ? 'Zone éloignée de votre siège : le pourcentage est réduit.' : null;

  // Ce que chaque réponse « oui » ferait gagner (même calcul, réponse simulée), seulement pour les questions sans réponse.
  const upgrades: MatchUpgrade[] = [];
  if (withUpgrades && company && score !== null) {
    const LABELS: Record<MatchUpgrade['key'], string> = {
      experience: 'Vous avez des chantiers comparables', capacity: 'Vos moyens couvrent ce marché',
      location: 'Vous intervenez sur cette zone', calendar: 'Vous êtes disponible sur ce calendrier',
    };
    for (const key of ['experience', 'capacity', 'location', 'calendar'] as const) {
      if (answers[key]) continue;
      const alt = evaluateMatch(company, market, { ...answers, [key]: 'oui' }, now, false).score;
      if (alt !== null && alt - score >= 1) upgrades.push({ key, label: LABELS[key], points: alt - score });
    }
    upgrades.sort((a, b) => b.points - a.points);
    upgrades.splice(3);
  }

  const documentedCount = applicable.filter((c) => c.evidence === 'verified_match' || c.evidence === 'mismatch').length;
  const toConfirmCount = applicable.filter((c) => c.evidence === 'declared_match' || c.evidence === 'unknown').length;

  // --- Verdict: five fixed outcomes, in priority order ------------------------------
  const deadlineMs = market.deadline ? new Date(market.deadline).getTime() : NaN;
  const closed = Number.isFinite(deadlineMs) && deadlineMs <= now.getTime();
  const mandatoryUnmet = criteria.filter((c) => c.mandatory && c.evidence === 'mismatch').map((c) => c.label);
  const hasMismatch = criteria.some((c) => c.evidence === 'mismatch' || c.conflict);
  const activityOk = !!company && (metier.evidence === 'verified_match' || metier.evidence === 'declared_match' || metier.status === 'match' || metier.factor > 0);
  let verdict: MatchVerdict;
  if (closed) verdict = { code: 'MARKET_CLOSED', label: VERDICT_LABELS.MARKET_CLOSED, tone: 'neutral', priorityIssue: 'date limite dépassée' };
  else if (mandatoryUnmet.length > 0) verdict = { code: 'MANDATORY_UNMET', label: VERDICT_LABELS.MANDATORY_UNMET, tone: 'amber', priorityIssue: mandatoryUnmet[0] };
  else if (hasMismatch) verdict = { code: 'REVIEW_REQUIRED', label: VERDICT_LABELS.REVIEW_REQUIRED, tone: 'amber', priorityIssue: (criteria.find((c) => c.evidence === 'mismatch' || c.conflict)?.label) || null };
  else if (activityOk) verdict = { code: 'ACTIVITY_MATCH', label: VERDICT_LABELS.ACTIVITY_MATCH, tone: metier.status === 'match' ? 'green' : 'neutral', priorityIssue: null };
  else verdict = { code: 'ACTIVITY_UNCLEAR', label: VERDICT_LABELS.ACTIVITY_UNCLEAR, tone: 'neutral', priorityIssue: null };

  const facts: MatchFacts = {
    km: factKm, radiusKm: company?.radiusKm ?? DEFAULT_RADIUS_KM, radiusDeclared: company?.radiusKm != null,
    daysLeft: factDays, metierLevel, revenueRatio: factRatio,
  };
  return { score, verdict, documentedCount, toConfirmCount, mandatoryUnmet, criteria, metierStatus: metier.status, facts, upgrades, adjustment };
}

// Version of the deterministic scoring rules: stored on every analysis snapshot.
export const RULES_VERSION = 'concordance-v28.0';
