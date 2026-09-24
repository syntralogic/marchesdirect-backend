import { db } from '../config/database';
import { resolveTradeFromText } from './tradeResolver';

// ============================================================================
// OPPORTUNITY MATCH SCORE
//
// Powers the "Analyse stratégique" tab of the opportunity detail page: a
// 0-100 score with a breakdown of *why*, a diagnostic checklist of documents
// the company still needs, and the criteria weighting the buyer will actually
// score bids on.
//
// Deliberately rule-based rather than an LLM call, consistent with how
// matchOpportunitiesToCompany() in aiService.ts already scores/filters
// opportunity<->company fit elsewhere in this codebase - keeps this cheap and
// instant (renders inline on page load) and, more importantly, keeps every
// point on the score explainable from a real column, not a black box.
// ============================================================================

export interface ScoreFactor {
  label: string;
  points: number;
}

export interface EligibilityItem {
  label: string;
  note: string;
  required: boolean;
  met: boolean | null; // null = unknown (no company profile to check against, e.g. anonymous visitor)
}

export interface CriterionWeight {
  label: string;
  // null when the notice names the criterion but gives no weighting for it.
  weight: number | null;
}

// One line of the numerical justification shown under the score: every
// criterion that COULD contribute (earned or not), with its points, so the
// visitor can reconcile the percentage with the listed lines instead of
// being handed a number and a partial list of positives.
export interface ScoreBreakdownItem {
  label: string;
  points: number;      // points actually earned (0 when not earned)
  maxPoints: number;   // what this criterion is worth when fully met
  earned: boolean;
  detail: string;      // why it was / wasn't earned, in plain French
}

export interface ScoreBreakdown {
  kind: 'listing' | 'profile';
  items: ScoreBreakdownItem[];
  earnedPoints: number;   // sum of earned points
  cappedPoints: number;   // after the 100-point cap
  formula: string;        // how cappedPoints becomes the displayed score
}

export interface MatchScoreResult {
  score: number;
  scoreTitle: string;
  scoreNote: string;
  // Client's explicit wording requirement: the percentage must always be
  // labeled "Indice de correspondance" and carry this fixed disclaimer so
  // it's never read as an odds-of-winning estimate - it measures fit
  // between known company traits and detected requirements, nothing more.
  scoreDisclaimer: string;
  // Short qualitative tier for card badges ("Très pertinent" etc.) -
  // derived from score, not a separate computation, so it can never
  // disagree with the percentage shown next to it.
  matchLabel: string | null;
  positiveFactors: ScoreFactor[];
  scoreBreakdown?: ScoreBreakdown;
  warning: string | null;
  // Award criteria as stated by the buyer in the notice/DCE, nothing else.
  criteria: CriterionWeight[];
  // 'notice' when criteria were actually extracted from the source, 'unknown'
  // when they were not (the UI then says "à vérifier dans le règlement de
  // consultation" instead of showing a generic weighting).
  criteriaSource: 'notice' | 'unknown';
  eligibility: EligibilityItem[];
  whyRespond: string;
}

// C04: ceiling for a score computed with no company profile behind it.
// 55 keeps it inside "À examiner" (40-59) - below the "Pertinent" band at
// 60 - so an unpersonalized number can never be announced as a good match.
const MAX_NON_PERSONALIZED_SCORE = 55;

const SCORE_DISCLAIMER = "Cet indice mesure la correspondance entre les caractéristiques connues de votre entreprise et les exigences détectées dans le marché. Il ne constitue pas une estimation des chances d'attribution.";

const matchLabelFor = (s: number): string =>
  s >= 80 ? 'Très pertinent' : s >= 60 ? 'Pertinent' : s >= 40 ? 'À examiner' : 'Peu pertinent';

// Only used once a real company profile is behind the score (personalized
// case) - the anonymous/generic case keeps its own explanatory note instead,
// since there's no company profile yet for "correspond fortement" to be
// making a claim about.
const correspondenceNoteFor = (s: number): string =>
  s >= 80 ? 'Cette opportunité correspond fortement au profil de votre entreprise.'
  : s >= 60 ? 'Cette opportunité correspond bien au profil de votre entreprise.'
  : s >= 40 ? 'Cette opportunité correspond partiellement au profil de votre entreprise.'
  : "Cette opportunité correspond faiblement au profil de votre entreprise, d'après les informations disponibles.";

// 25 Sep client audit (INRAE): the fiche showed 40 % prix / 40 % technique /
// 20 % délai as "pondération des critères de l'acheteur" while the official
// notice says 60 % prix / 40 % technique. A per-journey default table was
// being presented as the buyer's own weighting. Only criteria the notice
// really states (extracted into ai_extracted_facts.selection_criteria, which
// is instructed never to invent a breakdown) are returned now; when nothing
// was extracted the list stays empty and the UI asks the visitor to check the
// règlement de consultation.
export function criteriaFromFacts(facts: any): CriterionWeight[] {
  let f = facts;
  if (typeof f === 'string') {
    try { f = JSON.parse(f); } catch { return []; }
  }
  const sc = f?.selection_criteria;
  if (!sc || sc.available !== true || !Array.isArray(sc.value)) return [];
  return sc.value
    .filter((c: any) => c && typeof c.label === 'string' && c.label.trim())
    .map((c: any) => ({
      label: String(c.label).trim(),
      weight: typeof c.weight_percent === 'number' && Number.isFinite(c.weight_percent) ? c.weight_percent : null,
    }));
}

// Baseline documents every opportunity type expects, plus a trade-specific
// certification line when the opportunity has a known trade.
function baseRequiredDocs(journey: string, tradeName: string | null): { label: string; note: string; documentType: string }[] {
  const docs = [
    { label: 'Kbis de moins de 3 mois', note: 'Pièce à préparer (liste indicative, à confirmer dans le règlement de consultation).', documentType: 'kbis' },
    { label: 'Assurance décennale', note: 'Pièce à préparer (liste indicative, à confirmer dans le règlement de consultation).', documentType: 'insurance' },
  ];
  if (journey === 'public_procurement') {
    docs.push({ label: 'Attestations fiscale et sociale', note: 'Pièces généralement demandées pour un marché public.', documentType: 'certificate' });
  }
  docs.push({
    label: tradeName ? `Qualification ${tradeName} ou équivalent` : 'Qualification professionnelle du lot',
    note: 'Pièce à préparer (liste indicative, à confirmer dans le règlement de consultation).',
    documentType: 'certificate',
  });
  docs.push({ label: 'Référence récente sur un chantier comparable', note: 'Un projet similaire réalisé dans les 3 dernières années.', documentType: 'reference' });
  return docs;
}


// Whole-word overlap between the company's declared sector and the trade the
// opportunity is classified under. Replaces a 5-character prefix comparison
// that matched unrelated activities (see C04 note below).
// Short words are dropped: "de", "et", "bois" alone shouldn't establish a
// métier match, and generic procurement filler would otherwise match almost
// anything.
const STOP_TOKENS = new Set(['de', 'du', 'des', 'la', 'le', 'les', 'et', 'en', 'aux', 'au', 'autres', 'divers', 'general', 'generale', 'travaux', 'services', 'activites']);

function tokenize(text: string): Set<string> {
  return new Set(
    String(text || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 4 && !STOP_TOKENS.has(w))
  );
}

export function tradeMatchStrength(
  industrySector: string | null | undefined,
  tradeName: string | null | undefined,
  aiMatchedTrades?: unknown
): 'strong' | 'partial' | 'none' {
  const sectorTokens = tokenize(industrySector || '');
  if (sectorTokens.size === 0) return 'none';

  const tradeTokens = tokenize(tradeName || '');
  const overlap = [...tradeTokens].filter((t) => sectorTokens.has(t));
  if (overlap.length > 0) return 'strong';

  // Secondary signal: the AI may have matched this notice to several trades,
  // one of which can line up with the company's sector even when the primary
  // trade_id doesn't.
  let matchedText = '';
  try {
    matchedText = typeof aiMatchedTrades === 'string' ? aiMatchedTrades : JSON.stringify(aiMatchedTrades ?? '');
  } catch {
    matchedText = '';
  }
  const aiTokens = tokenize(matchedText);
  if ([...aiTokens].some((t) => sectorTokens.has(t))) return 'partial';

  return 'none';
}

export const computeMatchScore = async (
  opportunityId: string,
  companyId?: string | null
): Promise<MatchScoreResult> => {
  const oppResult = await db.query(
    `SELECT o.*, ot.code as journey, t.name as trade_name
     FROM opportunities o
     LEFT JOIN opportunity_types ot ON o.opportunity_type_id = ot.id
     LEFT JOIN trades t ON o.trade_id = t.id
     WHERE o.id = $1 AND o.deleted_at IS NULL`,
    [opportunityId]
  );
  if (oppResult.rows.length === 0) {
    throw new Error('Opportunity not found');
  }
  const opp = oppResult.rows[0];
  // 20 Sep client audit (Marssac): a fiche whose classifier never linked a
  // trade read "métier non précisé" although the title says isolation
  // thermique extérieure. Same read-time inference the detail route uses, so
  // fiche and score never disagree about the métier.
  if (!opp.trade_name) {
    const inferred = await resolveTradeFromText(opp.title, opp.description);
    if (inferred) {
      opp.trade_name = inferred.name;
      if (!opp.trade_id) opp.trade_id = inferred.id;
    }
  }
  const journey: string = opp.journey || 'tender';
  const isPublic = journey === 'public_procurement';

  const daysToDeadline = opp.deadline
    ? Math.ceil((new Date(opp.deadline).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
    : null;

  const positiveFactors: ScoreFactor[] = [];
  let warning: string | null = null;
  let score = 0;
  let scoreTitle: string;
  let scoreNote: string;
  let scoreBreakdown: ScoreBreakdown | undefined;

  let company: any = null;
  if (companyId) {
    const companyResult = await db.query('SELECT * FROM companies WHERE id = $1 AND deleted_at IS NULL', [companyId]);
    company = companyResult.rows[0] || null;
  }

  if (!company) {
    // Generic, non-personalized score based purely on how complete/workable
    // the opportunity's own listing is - this is what every visitor sees
    // before they're identified (anonymous, or a public-market listing which
    // never personalizes since it's open to everyone anyway).
    // C04 (contre-audit 15 Sep): a CVC company with statut "Cessée" and 0
    // salariés was shown 92% for "rénovation générale" and 100% for
    // "sous-traitance peinture". None of the factors below look at the
    // company at all - they score how complete and workable the *listing*
    // is. Calling that an "Indice de correspondance" makes it read as a
    // company-compatibility verdict, which is exactly the claim it cannot
    // support: the same listing shows the same number to every visitor,
    // whatever their trade or status. Renamed to say what it actually
    // measures. matchLabel is also suppressed further down for this branch
    // for the same reason ("Très pertinent" is a relevance claim about a
    // company we know nothing about).
    scoreTitle = 'Indice de complétude du dossier';
    scoreNote = isPublic
      ? "Mesure les informations disponibles dans cet avis, pas la compatibilité avec votre entreprise."
      : "Mesure les informations disponibles dans cette annonce. La correspondance avec votre entreprise est calculée après transmission de vos coordonnées.";

    if (opp.description && opp.description.length > 80) positiveFactors.push({ label: 'Dossier complet et structuré', points: 32 });
    if (opp.estimated_value && opp.deadline) positiveFactors.push({ label: 'Budget et calendrier clairement définis', points: 25 });
    if (opp.estimated_value && Number(opp.estimated_value) < 300000) positiveFactors.push({ label: 'Montant adapté aux PME', points: 18 });
    if (opp.location_city) positiveFactors.push({ label: 'Localisation précisée', points: 10 });
    // Two more factors, deliberately based on fields that are populated on
    // almost every listing (unlike estimated_value, which is null on most
    // BOAMP records - "Montant non communiqué" on the listing card) so a
    // real, opportunity-specific score can be computed instead of falling
    // through to the flat isPublic ? 60 : 40 default below on most listings.
    if (opp.deadline) positiveFactors.push({ label: 'Calendrier de réponse identifié', points: 15 });
    if (opp.trade_name) positiveFactors.push({ label: 'Lot / métier identifié', points: 10 });
    // These factors can total up to 110 when every condition is true (a
    // complete listing with both budget and deadline set) - was never
    // capped here (only the personalized branch below was), so the score
    // could actually show over 100%, or land at a misleading 100% off
    // partial data if points changed later. Cap it like the personalized
    // branch does.
    // C04 (contre-audit 15 Sep): "score de correspondance excessif sur des
    // activités sans rapport - 92%, 100%". This is where those numbers came
    // from. Every factor above measures how complete the *listing* is -
    // description length, budget present, deadline present, city present -
    // and not one of them looks at the company at all, because in this
    // branch there is no company to look at. 32+25+10+15+10 is exactly 92,
    // and a listing that also has a sub-300k budget reached 100.
    //
    // Capping was not enough on its own: the number is labelled "Indice de
    // correspondance" and sits next to "Très pertinent" (>=80), so a
    // well-written notice for a completely unrelated trade was being
    // announced as a strong match for a visitor the system knows nothing
    // about. A correspondence index computed without a single company trait
    // cannot honestly enter that band.
    //
    // So the non-personalized score is rescaled into a 0-55 band, which
    // tops out at "À examiner" and never reaches "Pertinent"/"Très
    // pertinent". The factors themselves are unchanged and still shown -
    // they are real and explainable, they just aren't correspondence - and
    // the note now says out loud that no company trait was compared.
    // Proportional rather than a hard clamp so listings still rank against
    // each other instead of all flattening onto the same ceiling.
    const listingQuality = positiveFactors.reduce((sum, f) => sum + f.points, 0);
    score = Math.round(Math.min(100, listingQuality) * (MAX_NON_PERSONALIZED_SCORE / 100));
    // Numerical justification (20 Sep audit: "la justification chiffrée du
    // score initial reste insuffisante"). Only the earned lines were ever
    // returned, and they summed to a different number than the one shown
    // (e.g. 57 points listed, 31 % displayed) because of the rescale above -
    // which was never surfaced. List every criterion with earned/max points
    // and spell out the conversion.
    const hasDescription = !!(opp.description && opp.description.length > 80);
    const hasValue = !!opp.estimated_value;
    const hasDeadline = !!opp.deadline;
    const smallBudget = hasValue && Number(opp.estimated_value) < 300000;
    const item = (label: string, maxPoints: number, earned: boolean, okDetail: string, koDetail: string): ScoreBreakdownItem =>
      ({ label, maxPoints, earned, points: earned ? maxPoints : 0, detail: earned ? okDetail : koDetail });
    const items: ScoreBreakdownItem[] = [
      item('Description complète et structurée', 32, hasDescription, 'La description de l’avis est détaillée.', 'Description absente ou trop courte.'),
      item('Budget et calendrier définis', 25, hasValue && hasDeadline, 'Montant estimé et date limite renseignés.', hasValue ? 'Date limite non renseignée.' : 'Montant non communiqué.'),
      item('Montant adapté aux PME', 18, smallBudget, 'Montant estimé inférieur à 300 000 €.', hasValue ? 'Montant estimé supérieur ou égal à 300 000 €.' : 'Montant non communiqué : critère non évaluable.'),
      item('Localisation précisée', 10, !!opp.location_city, 'Commune d’intervention indiquée.', 'Commune d’intervention non précisée.'),
      item('Calendrier de réponse identifié', 15, hasDeadline, 'Date limite de remise identifiée.', 'Date limite non communiquée.'),
      item('Lot / métier identifié', 10, !!opp.trade_name, `Métier retenu : ${opp.trade_name}.`, 'Aucun métier n’a pu être rattaché à cette annonce.'),
    ];
    const earnedPoints = items.reduce((sum, i) => sum + i.points, 0);
    const cappedPoints = Math.min(100, earnedPoints);
    scoreBreakdown = {
      kind: 'listing',
      items,
      earnedPoints,
      cappedPoints,
      formula: earnedPoints === 0
        ? `Aucun critère rempli : score plancher de ${Math.min(isPublic ? 45 : 30, MAX_NON_PERSONALIZED_SCORE)} %.`
        : `${earnedPoints} point${earnedPoints > 1 ? 's' : ''} sur 110 possibles${earnedPoints > 100 ? ' (plafonnés à 100)' : ''}. Tant qu’aucune caractéristique de votre entreprise n’est comparée, ce total est ramené à un maximum de ${MAX_NON_PERSONALIZED_SCORE} % : ${cappedPoints} × ${MAX_NON_PERSONALIZED_SCORE} % = ${score} %.`,
    };
    scoreNote = isPublic
      ? 'Score du dossier public, non personnalisé : aucune caractéristique de votre entreprise n’a encore été comparée.'
      : 'Non personnalisé pour l’instant : aucune caractéristique de votre entreprise n’a encore été comparée. Renseignez votre profil pour obtenir un indice de correspondance réel.';
  } else {
    scoreTitle = 'Indice de correspondance';
    scoreNote = 'Calculée à partir de votre profil et de cette opportunité.'; // overwritten below with the real tiered note once `score` is final

    // Trade match.
    // C04: this compared the company's sector against the first 5
    // characters of the trade name. Truncating to 5 characters makes
    // unrelated activities collide on a shared prefix - "Électricité" vs
    // "Électroménager" both reduce to "elect", so an appliance retailer
    // scored "Métier parfaitement compatible" (50 points, half the index)
    // on an electrical-works notice. That is the excessive score on an
    // unrelated activity the audit reported, in the personalized branch.
    // Compares whole words instead, accent- and case-folded, against both
    // the trade name and the AI's own matched-trades list (the same signal
    // the search ranking uses - see opportunities.ts), so a genuine match
    // still scores and a shared prefix no longer does.
    const tradeMatch = tradeMatchStrength(company.industry_sector, opp.trade_name, opp.ai_matched_trades);
    if (tradeMatch === 'strong') {
      positiveFactors.push({ label: 'Métier parfaitement compatible', points: 50 });
    } else if (tradeMatch === 'partial') {
      positiveFactors.push({ label: 'Métier proche de votre activité', points: 25 });
    } else if (opp.trade_id) {
      // Unchanged in spirit (an identified lot is still worth something)
      // but it must not read as evidence of fit: the previous label said
      // "à vérifier" while silently contributing the same points whether
      // the sector was related or not.
      positiveFactors.push({ label: 'Lot identifié, compatibilité métier non confirmée', points: 8 });
    }
    const tradePoints = tradeMatch === 'strong' ? 50 : tradeMatch === 'partial' ? 25 : opp.trade_id ? 8 : 0;

    // Location / working radius match (Haversine, same approach as
    // matchOpportunitiesToCompany in aiService.ts)
    let zoneEarned = false;
    let zoneDetail = 'Distance non évaluable : localisation de l’entreprise ou du marché inconnue.';
    if (company.location_latitude && opp.location_latitude) {
      const R = 6371;
      const dLat = ((opp.location_latitude - company.location_latitude) * Math.PI) / 180;
      const dLng = ((opp.location_longitude - company.location_longitude) * Math.PI) / 180;
      const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos((company.location_latitude * Math.PI) / 180) *
          Math.cos((opp.location_latitude * Math.PI) / 180) *
          Math.sin(dLng / 2) ** 2;
      const distanceKm = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      const radius = company.working_radius_km || 100;
      if (distanceKm <= radius) {
        positiveFactors.push({ label: 'Zone d’intervention couverte', points: 12 });
        zoneEarned = true;
        zoneDetail = `Marché à environ ${Math.round(distanceKm)} km, dans votre rayon d’intervention de ${radius} km.`;
      } else {
        zoneDetail = `Marché à environ ${Math.round(distanceKm)} km, au-delà de votre rayon d’intervention de ${radius} km.`;
      }
    }

    // Budget within a plausible multiple of company revenue
    let budgetEarned = false;
    let budgetDetail = 'Montant du marché ou chiffre d’affaires de l’entreprise non renseigné : critère non évaluable.';
    if (opp.estimated_value && company.annual_revenue) {
      if (Number(opp.estimated_value) <= Number(company.annual_revenue) * 3) {
        positiveFactors.push({ label: 'Budget dans votre gamme habituelle', points: 8 });
        budgetEarned = true;
        budgetDetail = 'Montant estimé inférieur ou égal à 3 fois votre chiffre d’affaires.';
      } else {
        warning = 'Le montant de cette opportunité dépasse largement votre chiffre d’affaires habituel.';
        budgetDetail = 'Montant estimé supérieur à 3 fois votre chiffre d’affaires.';
      }
    }

    // Recent comparable reference on file
    const refResult = await db.query(
      `SELECT id FROM company_references WHERE company_id = $1 AND completion_date > NOW() - INTERVAL '3 years' LIMIT 1`,
      [company.id]
    );
    const refEarned = refResult.rows.length > 0;
    if (refEarned) positiveFactors.push({ label: 'Référence récente détectée', points: 6 });

    const profileItems: ScoreBreakdownItem[] = [
      {
        label: tradeMatch === 'strong' ? 'Métier parfaitement compatible' : tradeMatch === 'partial' ? 'Métier proche de votre activité' : 'Compatibilité du métier',
        points: tradePoints,
        maxPoints: 50,
        earned: tradePoints > 0,
        detail: tradeMatch === 'strong'
          ? `Votre activité déclarée recoupe le métier de l’annonce (${opp.trade_name}).`
          : tradeMatch === 'partial'
            ? 'Votre activité recoupe l’un des métiers associés à cette annonce.'
            : opp.trade_id
              ? `Métier identifié (${opp.trade_name}) mais sans lien confirmé avec votre activité déclarée : 8 points seulement.`
              : 'Aucun métier rattaché à l’annonce ou lien avec votre activité non établi.',
      },
      { label: 'Zone d’intervention couverte', points: zoneEarned ? 12 : 0, maxPoints: 12, earned: zoneEarned, detail: zoneDetail },
      { label: 'Budget dans votre gamme habituelle', points: budgetEarned ? 8 : 0, maxPoints: 8, earned: budgetEarned, detail: budgetDetail },
      { label: 'Référence récente détectée', points: refEarned ? 6 : 0, maxPoints: 6, earned: refEarned, detail: refEarned ? 'Une référence de moins de 3 ans figure dans votre dossier.' : 'Aucune référence de moins de 3 ans dans votre dossier.' },
    ];
    const profileEarned = profileItems.reduce((sum, i) => sum + i.points, 0);
    scoreBreakdown = {
      kind: 'profile',
      items: profileItems,
      earnedPoints: profileEarned,
      cappedPoints: Math.min(100, profileEarned),
      formula: profileEarned === 0
        ? 'Aucun critère confirmé : score plancher de 40 %.'
        : `${profileEarned} point${profileEarned > 1 ? 's' : ''} sur 76 possibles = ${Math.min(100, profileEarned)} %.`,
    };

    score = Math.min(100, positiveFactors.reduce((sum, f) => sum + f.points, 0));
  }

  if (daysToDeadline !== null) {
    // Was `daysToDeadline <= 10` checked first, which also matches
    // negative values (deadline already passed) since -3 <= 10 - so an
    // opportunity whose deadline passed 3 days ago showed "Délai de
    // remise de -3 jour(s)" instead of the intended "dépassée" message
    // below, which could then never actually fire. Check the passed-
    // deadline case first.
    if (daysToDeadline <= 0) {
      if (!warning) warning = 'La date limite de remise est dépassée.';
    } else if (daysToDeadline <= 10 && !warning) {
      warning = `Délai de remise de ${daysToDeadline} jour${daysToDeadline > 1 ? 's' : ''} : organisation à lancer rapidement.`;
    }
  }

  // Last-resort floor for the rare listing with none of the factors above
  // (no description, no deadline, no trade, no location) - not expected to
  // fire often now that deadline/trade_name are scored above, since those
  // two are populated on nearly every ingested listing.
  // C04: the fallback floor (60 for public) sat above the non-personalized
  // ceiling, so a listing with none of the factors above jumped straight
  // back to "Pertinent" - undoing the cap for exactly the emptiest listings.
  // Floored within the band that applies to this branch.
  const scoreCeiling = company ? 100 : MAX_NON_PERSONALIZED_SCORE;
  const scoreFloor = score || (company ? 40 : Math.min(isPublic ? 45 : 30, MAX_NON_PERSONALIZED_SCORE));
  score = Math.max(0, Math.min(scoreCeiling, scoreFloor));

  // Now that score is final: personalized case gets the tiered
  // "correspond fortement/bien/..." note: the generic/anonymous case above
  // keeps its own explanatory note since there's no company profile yet for
  // a correspondence claim to be about.
  if (company) scoreNote = correspondenceNoteFor(score);
  // C04: "Très pertinent" / "Pertinent" are relevance claims about a
  // company. In the anonymous branch there is no company profile behind
  // the number (see the scoreTitle comment above), so the label is left
  // null rather than asserting a fit that was never evaluated.
  const matchLabel = company ? matchLabelFor(score) : null;

  // Eligibility checklist - if we know the company, actually check its
  // documents/certifications on file; otherwise every line is just shown as
  // "required" with no check mark (met: null), matching the anonymous/public
  // view in the design (labels only, nothing verified yet).
  const requiredDocs = baseRequiredDocs(journey, opp.trade_name);
  const eligibility: EligibilityItem[] = [];
  if (company) {
    const docsResult = await db.query(
      `SELECT document_type, is_expired FROM company_documents WHERE company_id = $1 AND deleted_at IS NULL`,
      [company.id]
    );
    const certsResult = await db.query(
      `SELECT certification_name, is_expired FROM company_certifications WHERE company_id = $1`,
      [company.id]
    );
    const hasDoc = (type: string) => docsResult.rows.some((d) => d.document_type === type && !d.is_expired);
    const hasCert = certsResult.rows.some((c) => !c.is_expired);
    for (const doc of requiredDocs) {
      const met = doc.documentType === 'certificate' ? (hasDoc('certificate') || hasCert) : hasDoc(doc.documentType);
      eligibility.push({ label: doc.label, note: doc.note, required: true, met });
    }
  } else {
    for (const doc of requiredDocs) {
      eligibility.push({ label: doc.label, note: doc.note, required: true, met: null });
    }
  }

  const criteria = criteriaFromFacts(opp.ai_extracted_facts);

  // 20 Sep client audit: this always opened with "Budget cadré" even when the
  // notice gives no amount at all ("montant non communiqué" right above on the
  // fiche), and claimed "critères de notation transparents" although the
  // weighting shown is a per-journey default, not read from the notice. Every
  // clause below is now conditional on the data actually being there.
  const euro = (n: number) => `${new Intl.NumberFormat('fr-FR').format(Math.round(n))} € HT`;
  const publicFacts = [
    opp.estimated_value ? `budget estimé à ${euro(Number(opp.estimated_value))}` : 'montant non communiqué dans l’avis',
    opp.trade_name ? `lot ${String(opp.trade_name).toLowerCase()} identifié` : null,
    opp.deadline ? 'date limite de remise connue' : null,
  ].filter(Boolean).join(', ');
  const whyRespond = isPublic
    ? `Marché public : ${publicFacts}. Paiement public et règles de consultation publiées : vous savez où concentrer votre réponse.`
    : company
    ? 'Cette opportunité correspond à votre métier et votre zone d’intervention d’après votre profil renseigné.'
    : 'Laissez vos coordonnées pour recevoir une analyse personnalisée à partir de votre profil d’entreprise.';

  return { score, scoreTitle, scoreNote, scoreDisclaimer: SCORE_DISCLAIMER, matchLabel, positiveFactors, scoreBreakdown, warning, criteria, criteriaSource: criteria.length > 0 ? 'notice' : 'unknown', eligibility, whyRespond };
};

export const computeSubcontractNeedMatchScore = (need: {
  trade: string;
  lot: string | null;
  description: string | null;
  budget_min: number | null;
  budget_max: number | null;
  team_size: string | null;
  qualifications: string | null;
}): MatchScoreResult => {
  const positiveFactors: ScoreFactor[] = [];
  if (need.trade && need.lot) positiveFactors.push({ label: 'Métier et lot définis', points: 30 });
  if (need.description && need.description.length > 40) positiveFactors.push({ label: 'Zone et démarrage précisés', points: 24 });
  if (need.budget_min || need.budget_max) positiveFactors.push({ label: 'Budget et durée renseignés', points: 20 });
  if (need.qualifications) positiveFactors.push({ label: 'Qualifications demandées', points: 14 });

  const score = Math.min(100, 22 + positiveFactors.reduce((s, f) => s + f.points, 0));
  return {
    score,
    scoreTitle: 'Qualité de votre demande',
    scoreNote: 'Calculée à partir des informations réellement saisies.',
    scoreDisclaimer: SCORE_DISCLAIMER,
    matchLabel: matchLabelFor(score),
    positiveFactors,
    warning: !need.team_size ? 'Précisez l’effectif recherché pour affiner les candidatures reçues.' : null,
    criteria: [],
    criteriaSource: 'unknown',
    eligibility: [],
    whyRespond: 'Besoin diffusé aux entreprises correspondant au métier, à la zone et aux qualifications demandées.',
  };
};

export default { computeMatchScore, computeSubcontractNeedMatchScore };
