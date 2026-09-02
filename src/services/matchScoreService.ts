import { db } from '../config/database';

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
  weight: number;
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
  matchLabel: string;
  positiveFactors: ScoreFactor[];
  warning: string | null;
  criteria: CriterionWeight[];
  eligibility: EligibilityItem[];
  whyRespond: string;
}

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

// Buyers score bids on different weightings depending on the opportunity
// type - these are the standard defaults used across French procurement
// (public-market weighting is regulated practice; private/subcontracting
// mirror it loosely). A future improvement could parse actual weights out of
// raw_data when a source publishes them, but no connector currently does.
const CRITERIA_BY_JOURNEY: Record<string, CriterionWeight[]> = {
  public_procurement: [
    { label: 'Prix de l’offre', weight: 40 },
    { label: 'Valeur technique', weight: 40 },
    { label: 'Délai et organisation', weight: 20 },
  ],
  tender: [
    { label: 'Qualité technique', weight: 45 },
    { label: 'Prix', weight: 35 },
    { label: 'Planning proposé', weight: 20 },
  ],
  subcontracting: [
    { label: 'Prix et chiffrage', weight: 50 },
    { label: 'Moyens et références', weight: 30 },
    { label: 'Disponibilité', weight: 20 },
  ],
};

// Baseline documents every opportunity type expects, plus a trade-specific
// certification line when the opportunity has a known trade.
function baseRequiredDocs(journey: string, tradeName: string | null): { label: string; note: string; documentType: string }[] {
  const docs = [
    { label: 'Kbis de moins de 3 mois', note: 'Pièce ou capacité demandée pour répondre.', documentType: 'kbis' },
    { label: 'Assurance décennale', note: 'Pièce ou capacité demandée pour répondre.', documentType: 'insurance' },
  ];
  if (journey === 'public_procurement') {
    docs.push({ label: 'Attestations fiscale et sociale', note: 'Pièces exigées pour tout marché public.', documentType: 'certificate' });
  }
  docs.push({
    label: tradeName ? `Qualification ${tradeName} ou équivalent` : 'Qualification professionnelle du lot',
    note: 'Pièce ou capacité demandée pour répondre.',
    documentType: 'certificate',
  });
  docs.push({ label: 'Référence récente sur un chantier comparable', note: 'Un projet similaire réalisé dans les 3 dernières années.', documentType: 'reference' });
  return docs;
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
    scoreTitle = 'Indice de correspondance';
    scoreNote = isPublic
      ? 'Score du dossier public, non personnalisé.'
      : 'Calculée à partir du profil renseigné après transmission de vos coordonnées.';

    if (opp.description && opp.description.length > 80) positiveFactors.push({ label: 'Dossier complet et structuré', points: 32 });
    if (opp.estimated_value && opp.deadline) positiveFactors.push({ label: 'Budget et calendrier clairement définis', points: 25 });
    if (opp.estimated_value && Number(opp.estimated_value) < 300000) positiveFactors.push({ label: 'Montant adapté aux PME', points: 18 });
    if (opp.location_city) positiveFactors.push({ label: 'Localisation précisée', points: 10 });
    score = positiveFactors.reduce((sum, f) => sum + f.points, 0);
  } else {
    scoreTitle = 'Indice de correspondance';
    scoreNote = 'Calculée à partir de votre profil et de cette opportunité.'; // overwritten below with the real tiered note once `score` is final

    // Trade match
    if (opp.trade_id && company.industry_sector && opp.trade_name &&
        String(company.industry_sector).toLowerCase().includes(String(opp.trade_name).toLowerCase().slice(0, 5))) {
      positiveFactors.push({ label: 'Métier parfaitement compatible', points: 50 });
    } else if (opp.trade_id) {
      positiveFactors.push({ label: 'Métier à vérifier avec votre profil', points: 15 });
    }

    // Location / working radius match (Haversine, same approach as
    // matchOpportunitiesToCompany in aiService.ts)
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
      if (distanceKm <= (company.working_radius_km || 100)) {
        positiveFactors.push({ label: 'Zone d’intervention couverte', points: 12 });
      }
    }

    // Budget within a plausible multiple of company revenue
    if (opp.estimated_value && company.annual_revenue) {
      if (Number(opp.estimated_value) <= Number(company.annual_revenue) * 3) {
        positiveFactors.push({ label: 'Budget dans votre gamme habituelle', points: 8 });
      } else {
        warning = 'Le montant de cette opportunité dépasse largement votre chiffre d’affaires habituel.';
      }
    }

    // Recent comparable reference on file
    const refResult = await db.query(
      `SELECT id FROM company_references WHERE company_id = $1 AND completion_date > NOW() - INTERVAL '3 years' LIMIT 1`,
      [company.id]
    );
    if (refResult.rows.length > 0) positiveFactors.push({ label: 'Référence récente détectée', points: 6 });

    score = Math.min(100, positiveFactors.reduce((sum, f) => sum + f.points, 0));
  }

  if (daysToDeadline !== null) {
    if (daysToDeadline <= 10 && !warning) {
      warning = `Délai de remise de ${daysToDeadline} jour${daysToDeadline > 1 ? 's' : ''} : organisation à lancer rapidement.`;
    } else if (daysToDeadline <= 0) {
      warning = 'La date limite de remise est dépassée.';
    }
  }

  score = Math.max(0, Math.min(100, score || (isPublic ? 60 : 40)));

  // Now that score is final: personalized case gets the tiered
  // "correspond fortement/bien/..." note: the generic/anonymous case above
  // keeps its own explanatory note since there's no company profile yet for
  // a correspondence claim to be about.
  if (company) scoreNote = correspondenceNoteFor(score);
  const matchLabel = matchLabelFor(score);

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

  const criteria = CRITERIA_BY_JOURNEY[journey] || CRITERIA_BY_JOURNEY.tender;

  const whyRespond = isPublic
    ? `Budget cadré${opp.trade_name ? `, lot ${opp.trade_name.toLowerCase()} identifié` : ''}, paiement public et critères de notation transparents : vous savez exactement où concentrer votre réponse.`
    : company
    ? 'Cette opportunité correspond à votre métier et votre zone d’intervention d’après votre profil renseigné.'
    : 'Laissez vos coordonnées pour recevoir une analyse personnalisée à partir de votre profil d’entreprise.';

  return { score, scoreTitle, scoreNote, scoreDisclaimer: SCORE_DISCLAIMER, matchLabel, positiveFactors, warning, criteria, eligibility, whyRespond };
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
    criteria: CRITERIA_BY_JOURNEY.subcontracting,
    eligibility: [],
    whyRespond: 'Besoin diffusé aux entreprises correspondant au métier, à la zone et aux qualifications demandées.',
  };
};

export default { computeMatchScore, computeSubcontractNeedMatchScore };
