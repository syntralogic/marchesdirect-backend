import axios from 'axios';
import { db } from '../config/database';
import { logger } from '../utils/logger';

// ============================================================================
// CLAUDE API CLIENT
// ============================================================================

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const API_KEY = process.env.ANTHROPIC_API_KEY;
// 'claude-3-5-sonnet-20241022' was deprecated 2025-08-13 and fully retired
// 2025-10-28. Using 'claude-haiku-4-5-20251001' - Anthropic's current fast/
// cheap Haiku model, a good fit for this platform's high-volume
// classification/summary/chatbot workload.
const MODEL = process.env.LLM_MODEL || 'claude-haiku-4-5-20251001';
const TEMPERATURE = process.env.AI_TEMPERATURE ? parseFloat(process.env.AI_TEMPERATURE) : undefined;
const MAX_TOKENS = parseInt(process.env.AI_MAX_TOKENS || '2000');

interface ClaudeMessage {
  role: 'user' | 'assistant';
  content: string;
}

// Helper: Clean JSON response from Claude
const cleanJsonResponse = (raw: string): string => {
  if (typeof raw !== 'string') {
    throw new Error(`Expected a text response from Claude API, got: ${typeof raw}`);
  }
  let cleaned = raw.trim();
  // Remove markdown code blocks
  cleaned = cleaned.replace(/```json\s*/gi, '').replace(/```\s*/g, '');
  // Try to extract JSON from text (find first { to last })
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    cleaned = jsonMatch[0];
  }
  return cleaned;
};

const callClaudeAPI = async (
  messages: ClaudeMessage[],
  systemPrompt: string,
  maxTokens: number = MAX_TOKENS
): Promise<string> => {
  try {
    const payload: any = {
      model: MODEL,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: messages,
    };
    
    // Omit temperature entirely unless explicitly configured
    if (TEMPERATURE !== undefined) {
      payload.temperature = TEMPERATURE;
    }

    const response = await axios.post(
      ANTHROPIC_API_URL,
      payload,
      {
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': API_KEY,
          'anthropic-version': '2023-06-01',
        },
        timeout: 30000,
      }
    );

    // Previously assumed content[0] was always the text block and returned
    // content[0].text unconditionally - if content[0] is any other block
    // type (e.g. a thinking block ahead of the text, or a tool_use block),
    // .text is undefined there, and that undefined then got returned
    // straight through to cleanJsonResponse(), which crashed with
    // "Cannot read properties of undefined (reading 'trim')". This searches
    // for the actual text block instead of assuming its position, and fails
    // with a clear, catchable error if the response genuinely has none.
    const textBlock = response.data.content?.find((block: any) => block.type === 'text' && typeof block.text === 'string');
    if (textBlock) {
      return textBlock.text;
    }

    throw new Error('No response from Claude API');

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error(`Claude API error: ${errorMessage}`);
    throw err;
  }
};

// ============================================================================
// DCE ANALYSIS - TENDER DOCUMENT EXTRACTION (MILESTONE 6.1 / 9.1)
// ============================================================================

export const analyzeTenderDocuments = async (tenderId: string): Promise<boolean> => {
  try {
    const tenderResult = await db.query(
      `SELECT t.*, o.id as opportunity_id, o.title, o.description, o.raw_data, o.estimated_value,
              o.deadline, o.contract_type, o.currency, o.dce_documents_status
       FROM tenders t
       JOIN opportunities o ON t.opportunity_id = o.id
       WHERE t.id = $1`,
      [tenderId]
    );

    if (tenderResult.rows.length === 0) {
      throw new Error(`Tender ${tenderId} not found`);
    }

    const tender = tenderResult.rows[0];

    const parsedDocs = await db.query(
      `SELECT document_label, extracted_text FROM tender_documents
       WHERE opportunity_id = $1 AND status = 'parsed' AND extracted_text IS NOT NULL AND extracted_text != ''`,
      [tender.opportunity_id]
    );

    await db.query('UPDATE tenders SET dce_analysis_status = $1 WHERE id = $2', ['processing', tenderId]);

    const systemPrompt = `You are a French public procurement expert analyzing a tender's consultation file
(dossier de consultation des entreprises - DCE: reglement de consultation, CCAP, CCTP).

Extract, strictly from the text given to you (never invent numbers or requirements that are not present):
1. Selection criteria and their weighting if stated (e.g. "Critere prix: 40%, Critere valeur technique: 45%, Critere delais: 15%").
2. The standard set of administrative documents a French company must supply for a public tender of this type
   (DC1, DC2 or DUME, insurance certificates, tax/social security compliance, KBIS, etc.) plus any tender-specific
   document mentioned in the text.
3. Scoring weights, if explicitly stated - mirror the selection criteria weights; do not fabricate a breakdown
   that isn't in the source text.
4. A complexity level (low, medium, high) based on contract value, technical scope and document volume.
5. A rough estimated effort in hours to prepare a complete bid response.

If the source text does not state exact weighting/criteria, return them with "not_specified": true rather than
guessing numbers - the platform must never invent facts that aren't in the source (see acceptance criteria).

Return ONLY valid JSON in this exact shape, no markdown, no extra text:
{
  "selection_criteria": [{"label": "...", "weight_percent": 40, "not_specified": false}],
  "required_documents": ["DC1", "DC2", "Attestation d'assurance decennale", ...],
  "scoring_weights": {"price": 40, "technical_value": 45, "deadline": 15, "not_specified": false},
  "complexity_assessment": "medium",
  "estimated_effort_hours": 12
}`;

    const hasParsedDocs = parsedDocs.rows.length > 0;
    const documentsBlock = hasParsedDocs
      ? parsedDocs.rows
          .map((d) => `--- Document: ${d.document_label || 'Autre'} ---\n${d.extracted_text.substring(0, 6000)}`)
          .join('\n\n')
      : 'None downloaded yet - analysis below is based on notice metadata only.';

    const userMessage = `Title: ${tender.title}
Description: ${tender.description || 'Not provided by source'}
Contract type: ${tender.contract_type || 'Not specified'}
Estimated value: ${tender.estimated_value ? `${tender.estimated_value} ${tender.currency || 'EUR'}` : 'Not specified'}
Deadline: ${tender.deadline || 'Not specified'}
Additional source data: ${tender.raw_data ? JSON.stringify(tender.raw_data).substring(0, 1500) : 'None'}

Consultation file (DCE) documents actually downloaded and text-extracted for this tender:
${documentsBlock}`;

    const response = await callClaudeAPI(
      [{ role: 'user', content: userMessage }],
      systemPrompt,
      hasParsedDocs ? 2500 : 1500
    );

    // Clean and parse response
    const cleanedResponse = cleanJsonResponse(response);
    
    let analysis;
    try {
      analysis = JSON.parse(cleanedResponse);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error(`Raw DCE response: ${response}`);
      logger.error(`Cleaned DCE response: ${cleanedResponse}`);
      logger.warn(`Failed to parse DCE analysis response for tender ${tenderId}: ${errorMessage}`);
      throw new Error(`Invalid DCE analysis response format: ${errorMessage}`);
    }

    const sourceCompleteness = hasParsedDocs
      ? 'includes_dce_documents'
      : tender.dce_documents_status === 'external_platform_only'
      ? 'external_platform_link_only'
      : 'structured_metadata_only';

    await db.query(
      `UPDATE tenders SET
         dce_analysis_status = $1,
         selection_criteria = $2,
         required_documents = $3,
         scoring_weights = $4,
         complexity_assessment = $5,
         estimated_effort_hours = $6,
         source_completeness = $7,
         updated_at = NOW()
       WHERE id = $8`,
      [
        'analyzed',
        JSON.stringify(analysis.selection_criteria || []),
        JSON.stringify(analysis.required_documents || []),
        JSON.stringify(analysis.scoring_weights || {}),
        analysis.complexity_assessment || 'medium',
        analysis.estimated_effort_hours || null,
        sourceCompleteness,
        tenderId,
      ]
    );

    logger.info(`✅ Analyzed DCE for tender ${tenderId}`);
    return true;
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error(`DCE analysis failed for tender ${tenderId}: ${errorMessage}`);
    await db.query('UPDATE tenders SET dce_analysis_status = $1 WHERE id = $2', ['failed', tenderId]);
    return false;
  }
};

// ============================================================================
// AI-ASSISTED TECHNICAL MEMO GENERATOR (MILESTONE 6.4 / 9)
// ============================================================================

type TechnicalMemoResult = { text: string; aiGenerated: boolean };

export const generateTechnicalMemo = async (bidId: string): Promise<TechnicalMemoResult> => {
  const bidResult = await db.query(
    `SELECT br.*, t.id as tender_id, t.selection_criteria, t.complexity_assessment,
            o.id as opportunity_id, o.title as opportunity_title, o.description as opportunity_description,
            o.contract_type
     FROM bid_responses br
     JOIN tenders t ON br.tender_id = t.id
     JOIN opportunities o ON t.opportunity_id = o.id
     WHERE br.id = $1`,
    [bidId]
  );

  if (bidResult.rows.length === 0) {
    throw new Error(`Bid response ${bidId} not found`);
  }

  const bid = bidResult.rows[0];

  const [companyResult, referencesResult, resourcesResult, policiesResult] = await Promise.all([
    db.query('SELECT * FROM companies WHERE id = $1', [bid.company_id]),
    db.query(
      'SELECT * FROM company_references WHERE company_id = $1 ORDER BY completion_date DESC LIMIT 20',
      [bid.company_id]
    ),
    db.query('SELECT * FROM company_resources WHERE company_id = $1', [bid.company_id]),
    db.query('SELECT * FROM company_policies WHERE company_id = $1', [bid.company_id]),
  ]);

  const company = companyResult.rows[0];
  const references = referencesResult.rows;
  const resources = resourcesResult.rows;
  const policies = policiesResult.rows;

  const fallback = buildFallbackTechnicalMemo(company, references, resources, policies, bid);

  try {
    const systemPrompt = `You are drafting a "memoire technique" (technical memo) for a French company responding to a
public tender, strictly from the company data and tender description provided below. This is a first draft the
company will review and edit before submission - it is not the final submission.

RULES (hard requirements):
- Never invent facts: company data, references, certifications, staff/equipment numbers, or tender requirements
  that are not present in the input. If something relevant is missing, write "Non renseigne dans le profil
  entreprise" for that item instead of making it up.
- From the company's reference list, select and describe only the ones most relevant to this specific tender
  (by trade/contract type match), not simply the most recent ones.
- Write in French, professional register, suitable for a public buyer.

Produce exactly these 6 sections, each with a clear header, in this order:
1. PRESENTATION DE L'ENTREPRISE ET ORGANISATION - tailored to this contract's purpose, not generic boilerplate.
2. MOYENS HUMAINS ET MATERIELS AFFECTES AU PROJET - drawn only from the staff/equipment resources given.
3. METHODOLOGIE D'EXECUTION ET PHASAGE - proposed approach derived from the tender description; if the
   description doesn't detail technical phases, keep this section proportionate to what's actually known and say
   so rather than inventing a phasing plan.
4. PLANNING PREVISIONNEL - a preliminary schedule outline, explicitly marked as indicative, based on any
   deadline/duration info given; do not invent specific dates that weren't provided.
5. REFERENCES SIMILAIRES - the selected relevant references only, with project name, client, date and a one-line
   relevance note.
6. MESURES QUALITE, SECURITE, ENVIRONNEMENT - drawn only from the company's quality/safety/environmental
   policy text given; note explicitly if one of the three is not documented in the profile.

Return plain text with the 6 numbered section headers as shown above, no markdown formatting, no extra commentary.`;

    const userMessage = `TENDER:
Title: ${bid.opportunity_title}
Contract type: ${bid.contract_type || 'Not specified'}
Description: ${bid.opportunity_description || 'Not provided by source'}
Complexity (from DCE analysis): ${bid.complexity_assessment || 'not analyzed yet'}
Selection criteria (from DCE analysis): ${bid.selection_criteria ? JSON.stringify(bid.selection_criteria) : 'not analyzed yet'}

COMPANY PROFILE:
Name: ${company.name}
SIRET: ${company.siret || 'non renseigne'}
Legal form: ${company.legal_form || 'non renseigne'}
Employee count: ${company.employee_count ?? 'non renseigne'}
Industry sector: ${company.industry_sector || 'non renseigne'}
Founded: ${company.founding_year || 'non renseigne'}

STAFF / EQUIPMENT RESOURCES (company_resources):
${resources.length ? resources.map((r) => `- [${r.resource_type}] ${r.name}${r.quantity ? ` x${r.quantity}` : ''}${r.category ? ` (${r.category})` : ''}${r.description ? ` - ${r.description}` : ''}`).join('\n') : 'Aucune ressource enregistree dans le profil entreprise.'}

REFERENCES (company_references, up to 20, select the most relevant to this tender):
${references.length ? references.map((r) => `- ${r.project_name} | client: ${r.client_name || 'confidentiel'} | date: ${r.completion_date || 'non renseignee'} | montant: ${r.contract_value || 'non renseigne'} | description: ${r.description || ''}`).join('\n') : 'Aucune reference enregistree dans le profil entreprise.'}

POLICIES (company_policies):
${policies.length ? policies.map((p) => `- [${p.policy_type}] ${p.policy_text}`).join('\n') : 'Aucune politique enregistree dans le profil entreprise.'}`;

    const memoText = await callClaudeAPI([{ role: 'user', content: userMessage }], systemPrompt, 3000);

    await db.query(
      `UPDATE bid_responses SET
         technical_memo_text = $1,
         technical_memo_version = technical_memo_version + 1,
         updated_at = NOW()
       WHERE id = $2`,
      [memoText, bidId]
    );

    logger.info(`✅ AI-generated technical memo for bid ${bidId}`);
    return { text: memoText, aiGenerated: true };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.warn(`AI technical memo generation failed for bid ${bidId}, using grounded fallback template: ${errorMessage}`);

    await db.query(
      `UPDATE bid_responses SET
         technical_memo_text = $1,
         technical_memo_version = technical_memo_version + 1,
         updated_at = NOW()
       WHERE id = $2`,
      [fallback, bidId]
    );

    return { text: fallback, aiGenerated: false };
  }
};

// Deterministic, no-AI text covering the same 6 sections from real profile data only.
function buildFallbackTechnicalMemo(
  company: any,
  references: any[],
  resources: any[],
  policies: any[],
  bid: any
): string {
  const staffLines = resources.filter((r) => r.resource_type === 'staff');
  const equipmentLines = resources.filter((r) => r.resource_type === 'equipment');
  const facilityLines = resources.filter((r) => r.resource_type === 'facility');

  const resourceBlock = (label: string, rows: any[]) =>
    rows.length
      ? `${label}:\n${rows.map((r) => `- ${r.name}${r.quantity ? ` x${r.quantity}` : ''}${r.description ? ` - ${r.description}` : ''}`).join('\n')}`
      : `${label}: non renseigne dans le profil entreprise.`;

  const referencesBlock = references.length
    ? references
        .slice(0, 5)
        .map((r) => `- ${r.project_name} (${r.client_name || 'client confidentiel'}, ${r.completion_date || 'date non renseignee'})`)
        .join('\n')
    : 'Aucune reference enregistree dans le profil entreprise.';

  const qualityPolicy = policies.find((p) => p.policy_type === 'quality');
  const safetyPolicy = policies.find((p) => p.policy_type === 'safety');
  const envPolicy = policies.find((p) => p.policy_type === 'environmental');

  return `1. PRESENTATION DE L'ENTREPRISE ET ORGANISATION
Entreprise: ${company.name}
SIRET: ${company.siret || 'non renseigne'}
Forme juridique: ${company.legal_form || 'non renseignee'}
Effectif: ${company.employee_count ?? 'non renseigne'}
Secteur: ${company.industry_sector || 'non renseigne'}

2. MOYENS HUMAINS ET MATERIELS AFFECTES AU PROJET
${resourceBlock('Personnel', staffLines)}
${resourceBlock('Materiel', equipmentLines)}
${resourceBlock('Installations', facilityLines)}

3. METHODOLOGIE D'EXECUTION ET PHASAGE
A completer par l'entreprise sur la base du CCTP du present appel d'offres (${bid.opportunity_title}).
Non genere automatiquement: la description ingeree pour ce marche ne suffit pas a deduire un phasage technique fiable sans invention de donnees.

4. PLANNING PREVISIONNEL
Planning indicatif a etablir en fonction de la date limite du marche. Non renseigne automatiquement pour eviter toute date inventee.

5. REFERENCES SIMILAIRES
${referencesBlock}

6. MESURES QUALITE, SECURITE, ENVIRONNEMENT
Qualite: ${qualityPolicy?.policy_text || 'non renseignee dans le profil entreprise.'}
Securite: ${safetyPolicy?.policy_text || 'non renseignee dans le profil entreprise.'}
Environnement: ${envPolicy?.policy_text || 'non renseignee dans le profil entreprise.'}`;
}

// ============================================================================
// STRUCTURED FACT EXTRACTION
// ============================================================================

export type ExtractedFact = { value: string; available: boolean };
export type ExtractedRisk = { label: string; severity: 'obligatoire' | 'recommandee' };
export type ExtractedRiskList = { value: ExtractedRisk[]; available: boolean };
export type ExtractedOpportunityFacts = {
  buyer_name: ExtractedFact;
  contract_object: ExtractedFact;
  procedure_type: ExtractedFact;
  submission_deadline: ExtractedFact;
  estimated_value: ExtractedFact;
  contact_email: ExtractedFact;
  required_qualifications: ExtractedFact;
  team_size_estimate: ExtractedFact;
  key_risks: ExtractedRiskList;
  // Added later (client ask: richer "Détails du dossier") - same
  // available/not-available contract as every other field above.
  contract_duration: ExtractedFact;
  submission_method: ExtractedFact;
  allotment: ExtractedFact;
  technical_visit: ExtractedFact;
};

export const extractOpportunityFacts = async (
  opportunityId: string
): Promise<ExtractedOpportunityFacts> => {
  const oppResult = await db.query('SELECT * FROM opportunities WHERE id = $1', [opportunityId]);

  if (oppResult.rows.length === 0) {
    throw new Error(`Opportunity ${opportunityId} not found`);
  }

  const opp = oppResult.rows[0];

  const systemPrompt = `You extract structured facts from a single French public procurement notice.

HARD RULE: for every field, only use what is literally present in the source text/data given below.
If a field is not present in the source, you MUST return {"value": "not available", "available": false}
for it (or {"value": [], "available": false} for the list field) - never guess, infer, or fill it with a
plausible-sounding value.

Additionally extract these four fields, same "not available" rule if the source doesn't state them:
- contract_duration: how long the contract/marché runs once awarded (e.g. "12 mois reconductible 3 fois", "Duree: 24 mois").
- submission_method: how a candidate must actually submit their bid (e.g. "Depot exclusivement dematerialise via le profil acheteur", "Par courrier recommande avec AR"). Not the deadline itself, the delivery method/channel.
- allotment: whether the marché is split into lots, and which/how many (e.g. "Marche alloti en 3 lots", "Marche unique, non alloti"). If the source is silent on lots, treat as not available rather than assuming "non alloti".
- technical_visit: whether a site visit is mentioned as obligatory or optional (e.g. "Visite du site obligatoire avant remise des offres"). If never mentioned, not available.

Return ONLY valid JSON in exactly this shape, no markdown, no extra text:
{
  "buyer_name": {"value": "...", "available": true},
  "contract_object": {"value": "...", "available": true},
  "procedure_type": {"value": "not available", "available": false},
  "submission_deadline": {"value": "...", "available": true},
  "estimated_value": {"value": "not available", "available": false},
  "contact_email": {"value": "not available", "available": false},
  "required_qualifications": {"value": "...", "available": true},
  "team_size_estimate": {"value": "not available", "available": false},
  "key_risks": {"value": [{"label": "...", "severity": "obligatoire"}], "available": true},
  "contract_duration": {"value": "not available", "available": false},
  "submission_method": {"value": "not available", "available": false},
  "allotment": {"value": "not available", "available": false},
  "technical_visit": {"value": "not available", "available": false}
}`;

  const userMessage = `SOURCE RECORD (raw, as ingested from the connector):
Title: ${opp.title}
Description: ${opp.description || ''}
Deadline field: ${opp.deadline || ''}
Estimated value field: ${opp.estimated_value || ''}
Location: ${opp.location_city || ''}, ${opp.location_region || ''}
Raw source payload: ${opp.raw_data ? JSON.stringify(opp.raw_data).substring(0, 2000) : '{}'}`;

  const response = await callClaudeAPI([{ role: 'user', content: userMessage }], systemPrompt, 1300);

  // Clean and parse response
  const cleanedResponse = cleanJsonResponse(response);
  
  let facts: ExtractedOpportunityFacts;
  try {
    facts = JSON.parse(cleanedResponse);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error(`Raw fact extraction response: ${response}`);
    logger.error(`Cleaned fact extraction response: ${cleanedResponse}`);
    logger.warn(`Failed to parse fact extraction response for ${opportunityId}: ${errorMessage}`);
    throw new Error(`Invalid fact extraction response format: ${errorMessage}`);
  }

  // The LLM's JSON output is never schema-validated, and it occasionally
  // returns key_risks.value as a plain string ("Aucun risque identifié")
  // instead of the required array-of-{label,severity} shape. That silently
  // got saved as-is and crashed the frontend fiche page (key_risks.value.map
  // is not a function) for that opportunity - not just the risks section,
  // the whole page, since nothing there catches a render error more locally
  // than the app's single top-level error boundary. Coerce it to a safe
  // empty (unavailable) list rather than trusting the model's shape.
  if (facts.key_risks && !Array.isArray(facts.key_risks.value)) {
    logger.warn(`key_risks.value was not an array for opportunity ${opportunityId}, coercing to empty list. Raw value: ${JSON.stringify(facts.key_risks.value)}`);
    facts.key_risks = { value: [], available: false };
  }

  await db.query(
    `UPDATE opportunities SET ai_extracted_facts = $1, updated_at = NOW() WHERE id = $2`,
    [JSON.stringify(facts), opportunityId]
  );

  logger.info(`✅ Extracted facts for opportunity ${opportunityId}`);
  return facts;
};

// ============================================================================
// CLASSIFICATION ENGINE (MILESTONE 6) - FIXED
// ============================================================================

export const classifyOpportunity = async (
  opportunityId: string
): Promise<boolean> => {
  try {
    const oppResult = await db.query(
      `SELECT o.*, ot.name as opp_type_name 
       FROM opportunities o
       LEFT JOIN opportunity_types ot ON o.opportunity_type_id = ot.id
       WHERE o.id = $1`,
      [opportunityId]
    );

    if (oppResult.rows.length === 0) {
      throw new Error(`Opportunity ${opportunityId} not found`);
    }

    const opp = oppResult.rows[0];

    await db.query(
      'UPDATE opportunities SET ai_classification_status = $1 WHERE id = $2',
      ['processing', opportunityId]
    );

    const systemPrompt = `You are a French public procurement expert. Your task is to classify business opportunities by:
1. Trade/Industry (construction, IT, consulting, etc.)
2. CPV codes (EU procurement classification)
3. Complexity level (low, medium, high)
4. Confidence scores

Return ONLY valid JSON, no markdown, no extra text:
{
  "trades": [{"name": "...", "confidence": 0.95}],
  "cpv_codes": [{"code": "45200000", "name": "...", "confidence": 0.90}],
  "complexity": "medium",
  "reasoning": "..."
}`;

    const userMessage = `Classify this opportunity:
Title: ${opp.title}
Description: ${opp.description?.substring(0, 1000) || ''}
Region: ${opp.location_region || 'Not specified'}
Estimated Value: ${opp.estimated_value || 'Not specified'}`;

    const response = await callClaudeAPI(
      [{ role: 'user', content: userMessage }],
      systemPrompt,
      1500
    );

    // Clean and parse response
    const cleanedResponse = cleanJsonResponse(response);
    
    let classification;
    try {
      classification = JSON.parse(cleanedResponse);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error(`Raw classification response: ${response}`);
      logger.error(`Cleaned classification response: ${cleanedResponse}`);
      throw new Error(`Invalid classification response format: ${errorMessage}`);
    }

    // Validate classification structure
    if (!classification.trades || !Array.isArray(classification.trades)) {
      classification.trades = [];
    }
    if (!classification.cpv_codes || !Array.isArray(classification.cpv_codes)) {
      classification.cpv_codes = [];
    }
    if (!classification.complexity) {
      classification.complexity = 'medium';
    }

    // Find and link trades
    const tradeIds: any[] = [];
    if (classification.trades && Array.isArray(classification.trades)) {
      for (const trade of classification.trades) {
        if (!trade.name) continue;
        const tradeResult = await db.query(
          'SELECT id FROM trades WHERE LOWER(name) LIKE LOWER($1)',
          [`%${trade.name}%`]
        );
        if (tradeResult.rows.length > 0) {
          tradeIds.push({
            id: tradeResult.rows[0].id,
            confidence: trade.confidence || 0.7,
            name: trade.name,
          });
        }
      }
    }

    // Find CPV code
    let cpvCodeId = null;
    if (classification.cpv_codes && classification.cpv_codes.length > 0) {
      const cpv = classification.cpv_codes[0];
      if (cpv.code) {
        const cpvResult = await db.query(
          'SELECT id FROM cpv_codes WHERE code = $1',
          [cpv.code]
        );
        if (cpvResult.rows.length > 0) {
          cpvCodeId = cpvResult.rows[0].id;
        }
      }
    }

    const primaryTradeId = tradeIds.length > 0
      ? tradeIds.slice().sort((a, b) => (b.confidence || 0) - (a.confidence || 0))[0].id
      : null;

    await db.query(
      `UPDATE opportunities SET
        ai_classification_status = $1,
        ai_matched_trades = $2,
        trade_id = $3,
        cpv_code_id = $4,
        complexity_level = $5,
        updated_at = NOW()
       WHERE id = $6`,
      [
        'classified',
        JSON.stringify(tradeIds),
        primaryTradeId,
        cpvCodeId,
        classification.complexity || 'medium',
        opportunityId,
      ]
    );

    logger.info(`✅ Classified opportunity ${opportunityId}: ${tradeIds.map(t => t.name).join(', ')}`);
    return true;
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error(`Classification failed for ${opportunityId}: ${errorMessage}`);

    await db.query(
      'UPDATE opportunities SET ai_classification_status = $1 WHERE id = $2',
      ['failed', opportunityId]
    );

    return false;
  }
};

// ============================================================================
// MATCHING ENGINE (MILESTONE 6)
// ============================================================================

export const matchOpportunitiesToCompany = async (
  companyId: string
): Promise<string[]> => {
  try {
    const companyResult = await db.query(
      'SELECT * FROM companies WHERE id = $1',
      [companyId]
    );

    if (companyResult.rows.length === 0) {
      throw new Error(`Company ${companyId} not found`);
    }

    const company = companyResult.rows[0];

    const tradesResult = await db.query(
      `SELECT DISTINCT t.id, t.name FROM company_certifications cc
       JOIN trades t ON cc.certification_name ILIKE '%' || t.name || '%'
       WHERE cc.company_id = $1 AND cc.is_expired = false`,
      [companyId]
    );

    const trades = tradesResult.rows.map(r => r.name);

    if (trades.length === 0) {
      logger.warn(`No certified trades found for company ${companyId}`);
      return [];
    }

    const matchResult = await db.query(
      `SELECT o.id,
              o.title,
              o.estimated_value,
              o.deadline
       FROM opportunities o
       LEFT JOIN trades t ON o.trade_id = t.id
       WHERE o.status = 'active'
         AND o.deadline > NOW()
         AND o.ai_classification_status = 'classified'
         AND (
           t.id IN (SELECT id FROM trades WHERE name = ANY($1::text[]))
           OR o.ai_matched_trades::text ILIKE ANY($1::text[])
         )
         AND (
           $2::decimal IS NULL OR o.estimated_value <= $2 * 3
         )
       ORDER BY o.deadline ASC
       LIMIT 50`,
      [
        trades,
        company.annual_revenue || null,
      ]
    );

    const matchedIds = matchResult.rows.map(r => r.id);
    logger.info(`✅ Found ${matchedIds.length} matching opportunities for company ${companyId}`);

    return matchedIds;
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error(`Matching failed for company ${companyId}: ${errorMessage}`);
    return [];
  }
};

// ============================================================================
// SUMMARIES & HIGHLIGHTS (MILESTONE 7)
// ============================================================================

export const generateOpportunitySummary = async (opportunityId: string): Promise<string> => {
  try {
    const oppResult = await db.query(
      'SELECT * FROM opportunities WHERE id = $1',
      [opportunityId]
    );

    if (oppResult.rows.length === 0) {
      throw new Error(`Opportunity ${opportunityId} not found`);
    }

    const opp = oppResult.rows[0];

    const systemPrompt = `You are a French business opportunity analyst. Generate a clear, concise summary highlighting:
- Main work/deliverables
- Key requirements
- Timeline
- Opportunity for small businesses
- Red flags or risks

Keep it to 2-3 paragraphs. Use simple, actionable language.`;

    const userMessage = `Title: ${opp.title}
Description: ${opp.description}
Deadline: ${opp.deadline}
Estimated Value: ${opp.estimated_value || 'Not specified'} EUR
Location: ${opp.location_city}, ${opp.location_region}`;

    const summary = await callClaudeAPI(
      [{ role: 'user', content: userMessage }],
      systemPrompt,
      800
    );

    await db.query(
      'UPDATE opportunities SET ai_summary = $1, ai_summary_status = $2 WHERE id = $3',
      [summary, 'generated', opportunityId]
    );

    return summary;
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error(`Summary generation failed for ${opportunityId}: ${errorMessage}`);
    throw err;
  }
};

// ============================================================================
// CHATBOT (MILESTONE 7)
// ============================================================================

export const chatbot = async (
  conversationId: string,
  userMessage: string,
  companyId: string
): Promise<string> => {
  try {
    const convResult = await db.query(
      'SELECT * FROM chatbot_conversations WHERE id = $1 AND company_id = $2',
      [conversationId, companyId]
    );

    if (convResult.rows.length === 0) {
      throw new Error('Conversation not found');
    }

    const conversation = convResult.rows[0];

    const historyResult = await db.query(
      `SELECT role, content FROM chatbot_messages 
       WHERE conversation_id = $1
       ORDER BY created_at DESC
       LIMIT 10`,
      [conversationId]
    );

    const history: ClaudeMessage[] = historyResult.rows.reverse().map(r => ({
      role: r.role,
      content: r.content,
    }));

    let context = '';
    if (conversation.context?.opportunity_id) {
      const oppResult = await db.query(
        'SELECT id, title, description, deadline FROM opportunities WHERE id = $1',
        [conversation.context.opportunity_id]
      );
      if (oppResult.rows.length > 0) {
        const opp = oppResult.rows[0];
        context = `\n\n<untrusted_reference_data source="opportunity:${opp.id}">\nTitle: ${opp.title}\nDescription: ${opp.description}\nDeadline: ${opp.deadline}\n</untrusted_reference_data>`;
      }
    }

    const journey: string | undefined = conversation.context?.journey;
    const journeyGuidance =
      journey === 'subcontracting'
        ? 'The user is in the subcontracting journey: prioritize speed and direct next steps.'
        : journey === 'public_procurement'
        ? 'The user is in the public procurement journey: compliance and required documents matter most.'
        : journey === 'tender'
        ? "The user is in the private tenders journey: focus on buyer's requirements."
        : '';

    const systemPrompt = `You are a helpful assistant for the French Public Procurement Opportunities platform.

IMPORTANT RULES:
- Only answer based on information in <untrusted_reference_data> below or in conversation history.
- If a fact isn't present, explicitly say "not available" rather than guessing.
- When you state a fact, cite where it came from.
- Be friendly, professional, and reply in the same language the user is writing in.
${journeyGuidance}
${context}`;

    const messages = [
      ...history,
      { role: 'user' as const, content: userMessage },
    ];

    const response = await callClaudeAPI(messages, systemPrompt, 1000);

    await db.query(
      'INSERT INTO chatbot_messages (conversation_id, role, content) VALUES ($1, $2, $3)',
      [conversationId, 'user', userMessage]
    );

    await db.query(
      'INSERT INTO chatbot_messages (conversation_id, role, content) VALUES ($1, $2, $3)',
      [conversationId, 'assistant', response]
    );

    await db.query(
      'UPDATE chatbot_conversations SET updated_at = NOW() WHERE id = $1',
      [conversationId]
    );

    return response;
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error(`Chatbot error for conversation ${conversationId}: ${errorMessage}`);
    throw err;
  }
};

// ============================================================================
// BATCH PROCESSING
// ============================================================================

export const classifyUnanalyzedOpportunities = async (limit: number = 100) => {
  try {
    logger.info(`Classifying up to ${limit} unanalyzed opportunities...`);

    const result = await db.query(
      `SELECT id FROM opportunities 
       WHERE ai_classification_status = 'not_analyzed'
       AND status IN ('active')
       AND deleted_at IS NULL
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit]
    );

    let classified = 0;
    let failed = 0;

    for (const opp of result.rows) {
      const success = await classifyOpportunity(opp.id);
      if (success) classified++;
      else failed++;
    }

    logger.info(`Classification batch complete: ${classified} succeeded, ${failed} failed`);
    return { classified, failed };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error(`Batch classification error: ${errorMessage}`);
    return { classified: 0, failed: 0 };
  }
};

export const generateSummariesForOpportunities = async (limit: number = 50) => {
  try {
    const result = await db.query(
      `SELECT id FROM opportunities 
       WHERE ai_summary_status = 'not_generated'
       AND ai_classification_status = 'classified'
       AND status = 'active'
       ORDER BY deadline ASC
       LIMIT $1`,
      [limit]
    );

    let generated = 0;

    for (const opp of result.rows) {
      try {
        await generateOpportunitySummary(opp.id);
        generated++;
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        logger.warn(`Failed to generate summary for ${opp.id}: ${errorMessage}`);
      }
    }

    logger.info(`Generated ${generated} summaries`);
    return generated;
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error(`Summary generation batch error: ${errorMessage}`);
    return 0;
  }
};
