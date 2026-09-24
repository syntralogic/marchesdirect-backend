import { db } from '../config/database';
import { resolveTradeFromText } from './tradeResolver';
import { reconcileOfficialFields } from '../utils/officialFields';
import { extractTradeSlugs } from './tradeResolver';
import { geocodeCity } from './geocodingService';
import { evaluateMatch, tradeSlugsForCompany, MatchCriterion, RefineAnswers, CompanyProfile } from './matchEngine';

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

export interface MatchScoreResult {
  // null = not enough information to really compare the company with the
  // market (métier or zone still to confirm): the UI shows "à confirmer".
  score: number | null;
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
  // Per-criterion comparison (métier, zone, expérience, moyens, disponibilité,
  // qualifications), each with a status and a justifying sentence.
  matchCriteria: MatchCriterion[];
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

const geocodeCache = new Map<string, { lat: number; lng: number } | null>();

const departmentFromPostal = (postal: string | null | undefined): string | null => {
  const p = String(postal || '').trim();
  if (!/^\d{5}$/.test(p)) return null;
  return p.startsWith('97') || p.startsWith('98') ? p.slice(0, 3) : p.slice(0, 2);
};

const toNumber = (v: any): number | null => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

// Builds the company side of the comparison. A registered account uses its
// stored profile; a visitor identified only by SIRET (no account yet - the
// client's own test path) uses what the SIRET lookup returned. Before this,
// the SIRET-only visitor fell into a branch that never read the company at
// all.
async function loadCompanyProfile(companyId: string | null | undefined, sessionId?: string | null): Promise<CompanyProfile | null> {
  if (companyId) {
    const r = await db.query('SELECT * FROM companies WHERE id = $1 AND deleted_at IS NULL', [companyId]);
    const c = r.rows[0];
    if (!c) return null;
    let ape: string | null = null;
    let apeActivity: string | null = null;
    if (c.siret && String(c.siret).length >= 9) {
      const cached = await db.query('SELECT company_data FROM company_lookup_cache WHERE siren = $1', [String(c.siret).replace(/\s/g, '').slice(0, 9)]);
      ape = cached.rows[0]?.company_data?.ape || null;
      apeActivity = cached.rows[0]?.company_data?.activity || null;
    }
    const refs = await db.query(`SELECT 1 FROM company_references WHERE company_id = $1 AND completion_date > NOW() - INTERVAL '3 years' LIMIT 1`, [c.id]);
    const certs = await db.query('SELECT certification_name FROM company_certifications WHERE company_id = $1 AND (is_expired IS NOT TRUE)', [c.id]);
    return {
      source: 'account',
      name: c.name || null,
      tradeSlugs: tradeSlugsForCompany(ape, c.industry_sector, apeActivity, c.description),
      activityText: c.industry_sector || apeActivity || null,
      latitude: toNumber(c.location_latitude), longitude: toNumber(c.location_longitude),
      department: departmentFromPostal(c.address_postal_code), city: c.address_city || null,
      radiusKm: toNumber(c.working_radius_km),
      annualRevenue: toNumber(c.annual_revenue),
      recentReferenceCount: refs.rows.length,
      certificationText: certs.rows.map((x) => x.certification_name).join(' '),
    };
  }
  if (!sessionId) return null;
  const l = await db.query('SELECT company_data FROM siret_lookups WHERE session_id = $1', [sessionId]);
  const d = l.rows[0]?.company_data;
  if (!d) return null;
  const department = departmentFromPostal(d.postal);
  let coords: { lat: number; lng: number } | null = null;
  if (d.city) {
    const key = `${d.city}|${department || ''}`;
    if (!geocodeCache.has(key)) geocodeCache.set(key, await geocodeCity(d.city, department).catch(() => null));
    coords = geocodeCache.get(key) || null;
  }
  return {
    source: 'siret',
    name: d.name || null,
    tradeSlugs: tradeSlugsForCompany(d.ape, d.activity),
    activityText: d.activity || null,
    latitude: coords?.lat ?? null, longitude: coords?.lng ?? null,
    department, city: d.city || null,
    radiusKm: null,
    annualRevenue: toNumber(d.revenue),
    recentReferenceCount: null,
    certificationText: d.rgeOrganisme || '',
  };
}

// The market side: what the notice asks for, as normalised métiers. The
// title, the linked trade and the lots come first; the description is only a
// fallback, because a description that mentions another trade in passing
// (an electrical connection in an air-conditioning job) must not make a
// painter look like a match.
function marketTradeSlugs(opp: any, facts: any): string[] {
  const primary = new Set<string>();
  for (const sl of extractTradeSlugs(opp.title)) primary.add(sl);
  if (opp.trade_slug) primary.add(opp.trade_slug);
  if (facts?.allotment?.available) for (const sl of extractTradeSlugs(String(facts.allotment.value))) primary.add(sl);
  try {
    const matched = typeof opp.ai_matched_trades === 'string' ? JSON.parse(opp.ai_matched_trades) : opp.ai_matched_trades;
    if (Array.isArray(matched)) for (const m of matched) for (const sl of extractTradeSlugs(m?.trade_name || m?.name || '')) primary.add(sl);
  } catch { /* malformed ai_matched_trades: ignore */ }
  if (primary.size > 0) return [...primary];
  return extractTradeSlugs(String(opp.description || '').slice(0, 1500));
}

export const computeMatchScore = async (
  opportunityId: string,
  companyId?: string | null,
  options: { sessionId?: string | null; answers?: RefineAnswers } = {}
): Promise<MatchScoreResult> => {
  const oppResult = await db.query(
    `SELECT o.*, ot.code as journey, t.name as trade_name, t.slug as trade_slug
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
  // Same resolved amount/buyer as the fiche itself (25 Sep audit: header and
  // details disagreed).
  reconcileOfficialFields(opp);
  // 20 Sep client audit (Marssac): a fiche whose classifier never linked a
  // trade read "métier non précisé" although the title says isolation
  // thermique extérieure. Same read-time inference the detail route uses.
  if (!opp.trade_name) {
    const inferred = await resolveTradeFromText(opp.title, opp.description);
    if (inferred) {
      opp.trade_name = inferred.name;
      if (!opp.trade_id) opp.trade_id = inferred.id;
    }
  }
  const journey: string = opp.journey || 'tender';
  const isPublic = journey === 'public_procurement';
  const facts = opp.ai_extracted_facts;

  const daysToDeadline = opp.deadline
    ? Math.ceil((new Date(opp.deadline).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
    : null;

  const company = await loadCompanyProfile(companyId, options.sessionId);
  const evaluation = evaluateMatch(
    company,
    {
      tradeSlugs: marketTradeSlugs(opp, facts),
      latitude: toNumber(opp.location_latitude), longitude: toNumber(opp.location_longitude),
      department: opp.location_department || null,
      estimatedValue: toNumber(opp.estimated_value),
      deadline: opp.deadline || null,
      requiredQualifications: facts?.required_qualifications?.available ? String(facts.required_qualifications.value) : null,
    },
    options.answers || {}
  );
  const score = evaluation.score;

  let warning: string | null = null;
  if (daysToDeadline !== null) {
    if (daysToDeadline <= 0) warning = 'La date limite de remise est dépassée.';
    else if (daysToDeadline <= 10) warning = `Délai de remise de ${daysToDeadline} jour${daysToDeadline > 1 ? 's' : ''} : organisation à lancer rapidement.`;
  }
  const money = evaluation.criteria.find((c) => c.key === 'moyens');
  if (money?.status === 'mismatch' && !money.answered && !warning) warning = 'Le montant de cette opportunité dépasse largement votre chiffre d’affaires habituel.';

  const scoreTitle = 'Indice de correspondance';
  const toConfirm = evaluation.criteria.filter((c) => c.weight > 0 && c.status === 'confirm' && c.factor === 0).length;
  const scoreNote = !company
    ? 'Identifiez votre entreprise pour comparer ses activités, sa zone et ses moyens à ce marché.'
    : score === null
      ? 'Pas encore assez d’informations pour calculer un pourcentage : confirmez les critères marqués « à confirmer ».'
      : toConfirm > 0
        ? `${correspondenceNoteFor(score)} ${toConfirm} critère${toConfirm > 1 ? 's' : ''} à confirmer ne ${toConfirm > 1 ? 'sont' : 'est'} pas encore compté${toConfirm > 1 ? 's' : ''}.`
        : correspondenceNoteFor(score);
  const matchLabel = score === null ? null : matchLabelFor(score);

  // Eligibility checklist - if we know the company, actually check its
  // documents/certifications on file; otherwise every line is just shown as
  // "to prepare" with no check mark (met: null).
  const requiredDocs = baseRequiredDocs(journey, opp.trade_name);
  const eligibility: EligibilityItem[] = [];
  if (companyId) {
    const docsResult = await db.query(
      `SELECT document_type, is_expired FROM company_documents WHERE company_id = $1 AND deleted_at IS NULL`,
      [companyId]
    );
    const certsResult = await db.query(
      `SELECT certification_name, is_expired FROM company_certifications WHERE company_id = $1`,
      [companyId]
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

  // 20 Sep client audit: every clause below is conditional on the data
  // actually being there (no "Budget cadré" when no amount is given).
  const euro = (n: number) => `${new Intl.NumberFormat('fr-FR').format(Math.round(n))} € HT`;
  const publicFacts = [
    opp.estimated_value ? `budget estimé à ${euro(Number(opp.estimated_value))}` : 'montant non communiqué dans l’avis',
    opp.trade_name ? `lot ${String(opp.trade_name).toLowerCase()} identifié` : null,
    opp.deadline ? 'date limite de remise connue' : null,
  ].filter(Boolean).join(', ');
  const whyRespond = isPublic
    ? `Marché public : ${publicFacts}. Paiement public et règles de consultation publiées : vous savez où concentrer votre réponse.`
    : company
    ? 'Comparez les critères ci-dessus à votre activité avant de répondre.'
    : 'Laissez vos coordonnées pour recevoir une analyse personnalisée à partir de votre profil d’entreprise.';

  return {
    score, scoreTitle, scoreNote, scoreDisclaimer: SCORE_DISCLAIMER, matchLabel,
    positiveFactors: [], matchCriteria: evaluation.criteria, warning,
    criteria, criteriaSource: criteria.length > 0 ? 'notice' : 'unknown', eligibility, whyRespond,
  };
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
    matchCriteria: [],
    warning: !need.team_size ? 'Précisez l’effectif recherché pour affiner les candidatures reçues.' : null,
    criteria: [],
    criteriaSource: 'unknown',
    eligibility: [],
    whyRespond: 'Besoin diffusé aux entreprises correspondant au métier, à la zone et aux qualifications demandées.',
  };
};

export default { computeMatchScore, computeSubcontractNeedMatchScore };
