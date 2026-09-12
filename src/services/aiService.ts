import axios from 'axios';
import { db } from '../config/database';
import { logger } from '../utils/logger';
import { syncLeadToCrm } from './crmSyncService';
import { formatFaqForPrompt } from '../data/chatbotFaq';

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

// Logged once at boot so a bad LLM_MODEL env var override on Render (e.g.
// still pointing at a retired dated snapshot from before this file's own
// default was fixed) is visible immediately in logs, instead of only
// showing up indirectly as a 100%-failure-rate "Request failed with status
// code 400" on every single classification/summary/facts call with no
// obvious cause.
logger.info(`[aiService] Using Claude model: ${MODEL}${process.env.LLM_MODEL ? ' (from LLM_MODEL env override)' : ' (default)'}`);

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

// Cost fix (11 Sep, client flagged AI spend): extractOpportunityFacts and
// generateOpportunityAnalysisSections were each independently dumping
// JSON.stringify(opp.raw_data).substring(0, 8000/6000) as input - full price
// input tokens on every single call, for every opportunity, duplicated
// across every AI feature that reads raw_data (facts, analysis-sections,
// classification/summary elsewhere in this file all do their own separate
// call+truncation of the same row's raw_data).
//
// Two problems, one fix:
//  1. Cost: most of a BOAMP/TED record's raw_data is connector/EFORMS
//     plumbing (party IDs, NUTS codes, UBL extension wrappers, repeated
//     addresses for the platform operator/tribunal/buyer) that a summary
//     never needs - paying to ship all of that as input on every call for
//     every opportunity is the actual spend driver, not max_tokens (max_tokens
//     only caps output; raising it earlier for the truncation bug did not
//     raise cost).
//  2. Quality: for EFORMS-shaped notices (TED/European, e.g. the CHU de la
//     Réunion case) the real free-text description
//     (ProcurementProject > cbc:Description) sits AFTER several KB of that
//     boilerplate in the JSON, so a positional substring(0, N) cut it off
//     entirely - the model was working from less real content than a
//     smaller, targeted extract gives it.
// Pull out the actual free-text description(s) wherever they live in the
// object shape (works across BOAMP/PLACE/DECP/TED without per-source
// schema-specific parsing) and put them first, then cap the rest of the
// payload much smaller than before - the model gets the part that matters
// even on a huge notice, while paying for far fewer boilerplate tokens on
// every call.
function extractRawDataContext(rawData: any, restCap: number = 2500): string {
  if (!rawData) return '{}';
  const descriptions: string[] = [];
  const seen = new Set<string>();
  const visit = (node: any) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      const bareKey = key.includes(':') ? key.split(':').pop()! : key;
      if (
        typeof value === 'string' &&
        value.trim().length > 40 &&
        /^(description|note|objet|resume_objet)$/i.test(bareKey)
      ) {
        if (!seen.has(value)) {
          seen.add(value);
          descriptions.push(value.trim());
        }
      } else if (value && typeof value === 'object') {
        visit(value);
      } else if (typeof value === 'string' && bareKey === '#text' && value.trim().length > 40) {
        // EFORMS wraps text as {"#text": "..."} under the real key
        // (handled above via the key check on the parent), but some
        // connectors' Description-equivalent nodes are one level off -
        // this catches those without a full schema map.
      }
    }
  };
  try {
    visit(rawData);
  } catch {
    // Malformed/circular raw_data - fall back to the plain truncated dump below.
  }
  descriptions.sort((a, b) => b.length - a.length);
  const topDescriptions = descriptions.slice(0, 2).join('\n---\n');
  let full: string;
  try {
    full = JSON.stringify(rawData);
  } catch {
    full = String(rawData);
  }
  const rest = full.substring(0, restCap);
  return topDescriptions
    ? `Full description text found in source:\n${topDescriptions}\n\nRest of source payload (truncated):\n${rest}`
    : rest;
}

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
    
    // Omit temperature entirely unless explicitly configured to a real
    // number - AI_TEMPERATURE set to anything non-numeric (typo, empty
    // string with whitespace, etc.) previously still passed the
    // `!== undefined` check (NaN !== undefined is true) and sent
    // `temperature: NaN` on every single call, which JSON.stringify
    // silently turns into `temperature: null` on the wire - a malformed
    // value Anthropic's API rejects.
    if (TEMPERATURE !== undefined && !Number.isNaN(TEMPERATURE)) {
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
    // BUG (found live on Render, 2026-09-07): this only ever logged
    // err.message, which for an axios error is just the generic "Request
    // failed with status code 400" - Anthropic's actual error body (the
    // one field that says *why* - e.g. "model: X has been deprecated",
    // "max_tokens: ...", a specific invalid field) was never logged at all.
    // Every single classification/facts/summary/chatbot call was failing
    // with 400 (100% failure rate, not intermittent) and there was no way
    // to tell why from the logs. Logging the real response body here is
    // what actually makes this diagnosable going forward.
    const status = axios.isAxiosError(err) ? err.response?.status : undefined;
    const detail = axios.isAxiosError(err) ? JSON.stringify(err.response?.data) : undefined;
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error(`Claude API error${status ? ` (${status})` : ''}: ${errorMessage}${detail ? ` — ${detail}` : ''}`);
    throw err;
  }
};

// Forces a schema-conformant JSON object back from Claude via tool use
// (tool_choice: {type: 'tool', name: ...}) instead of asking for "raw JSON"
// in prose and hoping the model doesn't wrap it in commentary, markdown
// fences, or truncate it mid-string. generateOpportunityAnalysisSections
// below was built the "ask for JSON in the system prompt" way and kept
// failing in production in ways that were hard to pin down without shell/
// log access (900 tokens too tight, then 2200, then 2800 - three rounds of
// "give it more room" without solid proof any of them was the actual
// cause). Tool-forced output isn't a length workaround, it's a different
// mechanism: Anthropic validates the response against input_schema before
// it comes back, so cleanJsonResponse's brace-matching regex and its
// silent failure modes (stray prose before/after the JSON, a fenced code
// block, truncation cutting off mid-object) stop being possible outcomes
// for calls that go through this path.
const callClaudeAPIWithTool = async (
  messages: ClaudeMessage[],
  systemPrompt: string,
  toolName: string,
  toolDescription: string,
  inputSchema: Record<string, any>,
  maxTokens: number = MAX_TOKENS
): Promise<Record<string, any>> => {
  try {
    const payload: any = {
      model: MODEL,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages,
      tools: [
        {
          name: toolName,
          description: toolDescription,
          input_schema: inputSchema,
        },
      ],
      tool_choice: { type: 'tool', name: toolName },
    };
    if (TEMPERATURE !== undefined && !Number.isNaN(TEMPERATURE)) {
      payload.temperature = TEMPERATURE;
    }

    const response = await axios.post(ANTHROPIC_API_URL, payload, {
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
      },
      timeout: 30000,
    });

    const toolBlock = response.data.content?.find(
      (block: any) => block.type === 'tool_use' && block.name === toolName
    );
    if (toolBlock && toolBlock.input && typeof toolBlock.input === 'object') {
      return toolBlock.input;
    }

    // If Claude stopped because it ran out of tokens mid-arguments, the
    // tool_use block itself may be missing or have partial/absent input.
    // Surface stop_reason so this is distinguishable in logs from an
    // outright API error.
    throw new Error(
      `No valid tool_use block from Claude API (stop_reason: ${response.data.stop_reason ?? 'unknown'})`
    );
  } catch (err) {
    const status = axios.isAxiosError(err) ? err.response?.status : undefined;
    const detail = axios.isAxiosError(err) ? JSON.stringify(err.response?.data) : undefined;
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error(`Claude API (tool) error${status ? ` (${status})` : ''}: ${errorMessage}${detail ? ` — ${detail}` : ''}`);
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
export type ExtractedCriterion = { label: string; weight_percent: number | null; not_specified: boolean };
export type ExtractedCriteriaList = { value: ExtractedCriterion[]; available: boolean };
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
  // Client's "Critères de notation" card (dix images de référence, écran
  // "Détails du dossier") - mirrors the exact selection_criteria shape
  // already proven in the paid tender DCE analysis above, but run for
  // every opportunity (public included) since that block is free-tier in
  // the reference screenshots, not gated behind a subscription.
  selection_criteria: ExtractedCriteriaList;
  // Client's audit: "les informations d'attribution lorsque le marché est
  // terminé" - completely absent until now. Only meaningful once a notice
  // has actually been awarded (BOAMP publishes a separate "avis
  // d'attribution" for that, DECP records are award data by definition -
  // see normalizeDecpRecord), so "not available" is the correct/expected
  // result for any notice that's still just a call for tenders, not a bug.
  attribution_winner: ExtractedFact;
  attribution_amount: ExtractedFact;
  attribution_date: ExtractedFact;
  // Coordonnées du donneur d'ordre beyond the email already captured by
  // contact_email - client's audit listed phone and website as separately
  // missing fields.
  buyer_phone: ExtractedFact;
  buyer_website: ExtractedFact;
  // Real count of distinct requirements found in actually-parsed DCE
  // documents (see documentIngestionService.ts) - available:false whenever
  // no documents have been parsed yet, never estimated from the notice text.
  requirements_detected: { value: number; available: boolean };
};

export const extractOpportunityFacts = async (
  opportunityId: string
): Promise<ExtractedOpportunityFacts> => {
  const oppResult = await db.query('SELECT * FROM opportunities WHERE id = $1', [opportunityId]);

  if (oppResult.rows.length === 0) {
    throw new Error(`Opportunity ${opportunityId} not found`);
  }

  const opp = oppResult.rows[0];

  // Real parsed DCE attachments for this opportunity (RC/CCAP/CCTP - see
  // documentIngestionService.ts), if any were found. The BOAMP notice alone
  // almost never itemizes discrete requirements ("exigences"); those live in
  // these documents. When there's nothing parsed yet, requirements_detected
  // below stays unavailable rather than guessing from the thin notice text.
  const docsResult = await db.query(
    `SELECT document_label, extracted_text FROM tender_documents
     WHERE opportunity_id = $1 AND status = 'parsed' AND extracted_text IS NOT NULL AND extracted_text != ''
     ORDER BY created_at ASC LIMIT 6`,
    [opportunityId]
  );
  const parsedDocumentsText = docsResult.rows
    .map((d: any) => `--- ${d.document_label || 'Document'} ---\n${String(d.extracted_text).slice(0, 6000)}`)
    .join('\n\n')
    .slice(0, 30000);

  const systemPrompt = `You extract structured facts from a single French public procurement notice.

HARD RULE: for every field, only use what is literally present in the source text/data given below.
If a field is not present in the source, you MUST return {"value": "not available", "available": false}
for it (or {"value": [], "available": false} for a list field) - never guess, infer, or fill it with a
plausible-sounding value.

Additionally extract these four fields, same "not available" rule if the source doesn't state them:
- contract_duration: how long the contract/marché runs once awarded (e.g. "12 mois reconductible 3 fois", "Duree: 24 mois").
- submission_method: how a candidate must actually submit their bid (e.g. "Depot exclusivement dematerialise via le profil acheteur", "Par courrier recommande avec AR"). Not the deadline itself, the delivery method/channel.
- allotment: whether the marché is split into lots, and which/how many (e.g. "Marche alloti en 3 lots", "Marche unique, non alloti"). If the source is silent on lots, treat as not available rather than assuming "non alloti".
- technical_visit: whether a site visit is mentioned as obligatory or optional (e.g. "Visite du site obligatoire avant remise des offres"). If never mentioned, not available.

Also extract, when the source states them:
- attribution_winner: the name of the company/companies the contract was actually awarded to ("titulaire", "attributaire"). Only present on an "avis d'attribution" / award notice or award data (DECP) - a plain call-for-tenders notice will not have this, which is expected: return not available rather than guessing.
- attribution_amount: the awarded amount, if stated separately from the estimated_value of the original call for tenders.
- attribution_date: the date the contract was signed/notified/awarded, if stated.
- buyer_phone: the awarding buyer's phone number, if stated.
- buyer_website: the awarding buyer's website URL, if stated.

Also extract selection_criteria: the award/scoring criteria and their weighting, if explicitly stated
(e.g. "Critere prix: 40%, Critere valeur technique: 45%, Critere delais: 15%"). Only include criteria the
source actually names; if a weight isn't given for a named criterion, set weight_percent to null and
not_specified to true for that entry. If the source states no criteria at all, return
{"value": [], "available": false}. Never invent a weighting breakdown that isn't in the source.

${parsedDocumentsText ? `Also count requirements_detected: the real DCE documents below (RC/CCAP/CCTP) are
provided in full. Count the distinct concrete requirements they actually state - eligibility conditions,
mandatory certifications/qualifications, technical specifications, administrative pieces to submit,
deadlines, insurance/guarantee clauses, etc. Count each distinct requirement once. This must be a real
count of things literally stated in the documents below, never an estimate or a round number picked to
look complete. Return {"requirements_detected": {"value": <integer count>, "available": true}}.` : `No
DCE documents have been parsed for this opportunity yet, so you cannot count real requirements from source
documents. Return {"requirements_detected": {"value": 0, "available": false}} - do not estimate a count
from the notice text alone.`}

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
  "technical_visit": {"value": "not available", "available": false},
  "attribution_winner": {"value": "not available", "available": false},
  "attribution_amount": {"value": "not available", "available": false},
  "attribution_date": {"value": "not available", "available": false},
  "buyer_phone": {"value": "not available", "available": false},
  "buyer_website": {"value": "not available", "available": false},
  "selection_criteria": {"value": [{"label": "Prix", "weight_percent": 40, "not_specified": false}], "available": true},
  "requirements_detected": {"value": 0, "available": false}
}`;

  // opp.deadline (a TIMESTAMP column) comes back from pg as a native JS
  // Date object, and opp.estimated_value (DECIMAL) as a numeric string.
  // Interpolating either directly into the prompt below used to call
  // Date.prototype.toString() implicitly (e.g. "Wed Sep 23 2026 08:27:02
  // GMT+0000"), which the model then faithfully echoed verbatim into
  // submission_deadline.value per the "only use what's literally in the
  // source" rule - showing up unformatted on the fiche. Format both into
  // plain, unambiguous text before they ever reach the prompt.
  const deadlineText = opp.deadline ? new Date(opp.deadline).toISOString().slice(0, 10) : '';
  const estimatedValueText = opp.estimated_value != null && opp.estimated_value !== ''
    ? `${Number(opp.estimated_value).toLocaleString('fr-FR', { maximumFractionDigits: 0 })} EUR`
    : '';

  // The full BOAMP/PLACE record (procedure type, conditions de participation,
  // critères de sélection, modalités de dépôt all live in here) was
  // hard-capped at 2000 chars of its JSON serialization. Metadata fields and
  // a long objet/description come first in that JSON, so on a record with a
  // moderately detailed description the budget was often exhausted before
  // the string ever reached procedure/criteria fields - they'd then look
  // "not in the source" to the model purely from truncation, not real
  // absence. Parsed DCE documents below get a 30000-char budget for the same
  // reason; 2000 for the raw record was inconsistent with that and too
  // tight. Raised to 8000.
  const userMessage = `SOURCE RECORD (raw, as ingested from the connector):
Title: ${opp.title}
Description: ${opp.description || ''}
Deadline field: ${deadlineText}
Estimated value field: ${estimatedValueText}
Location: ${opp.location_city || ''}, ${opp.location_region || ''}
Raw source payload: ${opp.raw_data ? extractRawDataContext(opp.raw_data, 3000) : '{}'}
${parsedDocumentsText ? `\nREAL PARSED DCE DOCUMENTS (use these for requirements_detected):\n${parsedDocumentsText}` : ''}`;

  // 1800 -> 2200: five more fields added (attribution_*, buyer_phone/website)
  // without headroom risked truncating the JSON mid-object on notices with
  // a long key_risks/selection_criteria list, which would fail JSON.parse
  // below rather than just omitting a field.
  const response = await callClaudeAPI([{ role: 'user', content: userMessage }], systemPrompt, 2200);

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
  if (facts.selection_criteria && !Array.isArray(facts.selection_criteria.value)) {
    logger.warn(`selection_criteria.value was not an array for opportunity ${opportunityId}, coercing to empty list. Raw value: ${JSON.stringify(facts.selection_criteria.value)}`);
    facts.selection_criteria = { value: [], available: false };
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

    // Was `o.deadline > NOW()` - same NULL-drops-silently bug already fixed
    // in dashboard.ts's activeOpportunities counter and opportunities.ts's
    // search route (DECP, the largest source, publishes no deadline on most
    // records). Left unfixed here meant the dashboard's personalized
    // "matches" recommendations - the one feature meant to actually surface
    // relevant opportunities to a given company - silently never included
    // any DECP listing, no matter how good a fit.
    const matchResult = await db.query(
      `SELECT o.id,
              o.title,
              o.estimated_value,
              o.deadline
       FROM opportunities o
       LEFT JOIN trades t ON o.trade_id = t.id
       WHERE o.status = 'active'
         AND (o.deadline IS NULL OR o.deadline > NOW())
         AND o.ai_classification_status = 'classified'
         AND (
           t.id IN (SELECT id FROM trades WHERE name = ANY($1::text[]))
           OR o.ai_matched_trades::text ILIKE ANY($1::text[])
         )
         AND (
           $2::decimal IS NULL OR o.estimated_value <= $2 * 3
         )
       ORDER BY o.deadline ASC NULLS LAST
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

    // Plain prose only, no markdown (client's ask, screenshot evidence
    // 8 Sep: raw "# Résumé..." / "**bold**" markers were showing up
    // verbatim on the opportunity page, which only ever renders this in a
    // plain <p> tag, never through a markdown renderer). Also kept short
    // and single-purpose - client's separate brief on duplicated content:
    // "Résumé : explication simple de l'opportunité", not a full
    // multi-section report (that's what "Le marché en 30 secondes" and
    // "Points de vigilance" are already for elsewhere on the page).
    //
    // Client feedback (7 Sep, screenshot): a summary was still running
    // hundreds of words long with its own section headers ("Objet et
    // livrables principaux", "Exigences clés et calendrier") - an
    // ai_summary generated under an older, more permissive version of this
    // same prompt, before "2 à 4 phrases" was added. Tightened further
    // below with a hard word cap and an explicit ban on header-like lines,
    // since the sentence-count instruction alone wasn't enough to stop the
    // model from writing a structured multi-section answer when the
    // source description was itself long and detailed.
    const systemPrompt = `Tu es un analyste de marchés publics/privés français. Rédige un résumé simple de cette opportunité, en 2 à 4 phrases maximum (120 mots maximum au total), en français courant.

Ce résumé doit se limiter à expliquer simplement en quoi consiste l'opportunité (l'objet de la mission). Ne développe pas les exigences, le calendrier, ou les points de vigilance - ces informations sont déjà présentées ailleurs sur la page et ne doivent pas être répétées ici.

Règles de formatage strictes :
- Texte brut uniquement, sans aucun markdown (pas de #, pas de **, pas de listes à puces, pas de titres).
- N'écris jamais de titre de section (par exemple "Objet et livrables principaux", "Exigences clés et calendrier", "Résumé de l'opportunité") - un seul paragraphe continu, sans aucune ligne de titre.
- Pas de titre du type "Résumé de l'opportunité" - va directement au contenu.
- Un seul paragraphe court (2 à 4 phrases, 120 mots maximum) - jamais plusieurs paragraphes, jamais plusieurs sections.`;

    // Same GMT/English-Date.toString() leak as generateOpportunityFacts
    // above (opp.deadline is a raw JS Date from pg) - format before
    // interpolating, not after the model has already echoed it.
    const deadlineText = opp.deadline ? new Date(opp.deadline).toISOString().slice(0, 10) : 'non communiquée';
    const userMessage = `Title: ${opp.title}
Description: ${opp.description}
Deadline: ${deadlineText}
Estimated Value: ${opp.estimated_value || 'Not specified'} EUR
Location: ${opp.location_city}, ${opp.location_region}`;

    const summary = await callClaudeAPI(
      [{ role: 'user', content: userMessage }],
      systemPrompt,
      220
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

// Client's 10 Sep spec: the opportunity page's free-form analysis text
// ("Analyse de l'opportunité") is hard to read as one dense block, even on
// a fully-populated fiche (their own example: Saint-Yrieix-sur-Charente
// food supply notice). Wants exactly 3 fixed accordions, reused on every
// fiche, first one open by default:
//   - Présentation du marché: objet, prestations, périmètre.
//   - Conditions et points à vérifier: calendrier, exigences, critères,
//     contraintes.
//   - Entreprises concernées: métiers/profils concernés - explicitly NOT a
//     guarantee of unverified eligibility, so the prompt below is worded
//     to describe fit rather than certify it.
// Same "never invent, mark missing" discipline as extractOpportunityFacts
// above - each section says so in French when the source doesn't cover it,
// rather than padding with generic filler.
export const generateOpportunityAnalysisSections = async (
  opportunityId: string
): Promise<{ presentation: string; conditions: string; entreprises: string }> => {
  const oppResult = await db.query('SELECT * FROM opportunities WHERE id = $1', [opportunityId]);
  if (oppResult.rows.length === 0) {
    throw new Error(`Opportunity ${opportunityId} not found`);
  }
  const opp = oppResult.rows[0];

  const deadlineText = opp.deadline ? new Date(opp.deadline).toISOString().slice(0, 10) : 'non communiquée';
  const estimatedValueText = opp.estimated_value != null && opp.estimated_value !== ''
    ? `${Number(opp.estimated_value).toLocaleString('fr-FR', { maximumFractionDigits: 0 })} EUR`
    : 'non communiqué';

  const systemPrompt = `Tu es un analyste de marchés publics/privés français. À partir de la fiche source ci-dessous, rédige exactement 3 sections destinées à 3 accordéons fixes sur la page d'une opportunité. Chaque section fait 2 à 5 phrases, en français courant, texte brut (aucun markdown, aucun titre répété dans le texte).

1. presentation ("Présentation du marché") : l'objet du marché, les prestations demandées et le périmètre de la mission.
2. conditions ("Conditions et points à vérifier") : calendrier (dates clés), exigences, critères de sélection et contraintes à connaître avant de candidater.
3. entreprises ("Entreprises concernées") : les métiers et profils d'entreprises concernés par ce marché. Décris uniquement le type d'entreprise auquel ce marché correspond a priori (taille, secteur, spécialité) - ne certifie jamais qu'une entreprise est éligible, puisque l'éligibilité réelle dépend de critères que tu ne peux pas vérifier.

RÈGLE STRICTE : n'utilise que ce qui est réellement présent dans la source ci-dessous. Si une section manque d'information dans la source (ex : aucune exigence mentionnée, aucun montant), dis-le explicitement dans cette section plutôt que d'inventer un contenu plausible.`;

  const userMessage = `Title: ${opp.title}
Description: ${opp.description || ''}
Deadline: ${deadlineText}
Estimated Value: ${estimatedValueText}
Location: ${opp.location_city || ''}, ${opp.location_region || ''}
Raw source payload: ${opp.raw_data ? extractRawDataContext(opp.raw_data, 2000) : '{}'}`;

  try {
    // Switched from "ask for raw JSON in the system prompt" to a forced
    // tool call (see callClaudeAPIWithTool above) - three rounds of
    // "maybe it's a token-limit truncation issue" (900 -> 2200 -> 2800)
    // never conclusively fixed the client's "fails for every opportunity"
    // report, which pointed at the JSON-in-prose approach itself (stray
    // prose, code fences, or mid-string truncation defeating
    // cleanJsonResponse's brace-matching) rather than at length alone.
    // Anthropic validates tool_use input against input_schema before it
    // comes back, so a malformed response is no longer a possible outcome
    // of this call - only a genuine API-level failure (auth/quota/model)
    // can fail it now, which the catch block below already logs with the
    // real status + response body.
    const sections = await callClaudeAPIWithTool(
      [{ role: 'user', content: userMessage }],
      systemPrompt,
      'submit_analysis_sections',
      'Submit the 3 analysis sections (presentation, conditions, entreprises) for this opportunity.',
      {
        type: 'object',
        properties: {
          presentation: { type: 'string', description: 'Présentation du marché : objet, prestations, périmètre (2-5 phrases, texte brut).' },
          conditions: { type: 'string', description: 'Conditions et points à vérifier : calendrier, exigences, critères, contraintes (2-5 phrases, texte brut).' },
          entreprises: { type: 'string', description: 'Entreprises concernées : métiers/profils concernés (2-5 phrases, texte brut).' },
        },
        required: ['presentation', 'conditions', 'entreprises'],
      },
      2800
    );
    // Same defensive coercion as extractOpportunityFacts - never let a
    // malformed field (wrong type, missing key) crash the fiche page.
    const safeSections = {
      presentation: typeof sections.presentation === 'string' ? sections.presentation : '',
      conditions: typeof sections.conditions === 'string' ? sections.conditions : '',
      entreprises: typeof sections.entreprises === 'string' ? sections.entreprises : '',
    };

    await db.query(
      'UPDATE opportunities SET ai_analysis_sections = $1, ai_analysis_sections_status = $2, ai_analysis_sections_error = NULL WHERE id = $3',
      [JSON.stringify(safeSections), 'generated', opportunityId]
    );

    return safeSections;
  } catch (err) {
    // Persist the real error alongside the status (see ai_analysis_sections_error
    // migration, 11 Sep) - this is what's surfaced in the public GET /:id
    // response for diagnosis without needing an authenticated admin session.
    const isAxiosErr = axios.isAxiosError(err);
    const apiStatus = isAxiosErr ? err.response?.status : undefined;
    const apiBody = isAxiosErr ? JSON.stringify(err.response?.data) : undefined;
    const errorMessage = err instanceof Error ? err.message : String(err);
    const storedError = [apiStatus ? `HTTP ${apiStatus}` : null, errorMessage, apiBody]
      .filter(Boolean)
      .join(' | ')
      .slice(0, 2000);
    await db.query(
      'UPDATE opportunities SET ai_analysis_sections_status = $1, ai_analysis_sections_error = $2 WHERE id = $3',
      ['failed', storedError, opportunityId]
    );
    logger.error(`Analysis-sections generation failed for ${opportunityId}: ${errorMessage}`);
    throw err;
  }
};

// Backfill sibling to generateSummariesForOpportunities below - same
// not_generated/failed selection, same batch-size/rate-limit shape, kept as
// its own function (not merged into that one) since the two are genuinely
// different pieces of AI-generated copy (short blurb vs. 3 structured
// sections) that can succeed/fail independently.
export const generateAnalysisSectionsForOpportunities = async (limit: number = 50) => {
  const result = await db.query(
    // Also re-picks rows stuck at status='generated' with an effectively
    // empty sections object (all 3 keys blank) - same edge case
    // ensureAnalysisSectionsGenerated's hasAnalysisContent() guards against
    // on the on-demand path in routes/opportunities.ts; without this here
    // too, a row that got saved empty once would never be retried by this
    // batch job either.
    `SELECT id FROM opportunities
     WHERE (
       ai_analysis_sections_status IS NULL
       OR ai_analysis_sections_status IN ('not_generated', 'failed')
       OR (
         ai_analysis_sections_status = 'generated'
         AND coalesce(ai_analysis_sections->>'presentation', '') = ''
         AND coalesce(ai_analysis_sections->>'conditions', '') = ''
         AND coalesce(ai_analysis_sections->>'entreprises', '') = ''
       )
     )
       AND description IS NOT NULL AND description != ''
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit]
  );

  let succeeded = 0;
  let failed = 0;
  for (const row of result.rows) {
    try {
      await generateOpportunityAnalysisSections(row.id);
      succeeded++;
    } catch (err) {
      failed++;
      logger.error(`Analysis-sections backfill failed for ${row.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  logger.info(`[AnalysisSectionsBackfill] ${succeeded} generated, ${failed} failed, ${result.rows.length} attempted`);
  return { succeeded, failed, attempted: result.rows.length };
};

// ============================================================================
// CHATBOT (MILESTONE 7)
// ============================================================================

export const chatbot = async (
  conversationId: string,
  userMessage: string,
  companyId: string | null,
  sessionId?: string | null
): Promise<string> => {
  try {
    // Anonymous-visitor support (FAQ brief: "Marchés publics : accès libre...
    // y compris pour un visiteur anonyme" - the chatbot is the primary
    // anonymous search entry point) - a conversation belongs to either a
    // logged-in company or a session_id, never neither.
    const convResult = companyId
      ? await db.query('SELECT * FROM chatbot_conversations WHERE id = $1 AND company_id = $2', [conversationId, companyId])
      : await db.query('SELECT * FROM chatbot_conversations WHERE id = $1 AND session_id = $2', [conversationId, sessionId]);

    if (convResult.rows.length === 0) {
      throw new Error('Conversation not found');
    }

    const conversation = convResult.rows[0];

    const historyResult = await db.query(
      `SELECT role, content FROM chatbot_messages 
       WHERE conversation_id = $1
       ORDER BY created_at DESC
       LIMIT 20`,
      [conversationId]
    );

    const history: ClaudeMessage[] = historyResult.rows.reverse().map(r => ({
      role: r.role,
      content: r.content,
    }));

    let context = '';
    if (conversation.context?.opportunity_id) {
      const oppResult = await db.query(
        'SELECT id, title, description, deadline, opportunity_type FROM opportunities WHERE id = $1',
        [conversation.context.opportunity_id]
      );
      if (oppResult.rows.length > 0) {
        const opp = oppResult.rows[0];
        // Same raw-Date-object-in-template-string leak as
        // generateOpportunityFacts/generateOpportunitySummary above.
        const deadlineText = opp.deadline ? new Date(opp.deadline).toISOString().slice(0, 10) : 'non communiquée';
        context = `\n\n<untrusted_reference_data source="opportunity:${opp.id}">\nTitle: ${opp.title}\nDescription: ${opp.description}\nDeadline: ${deadlineText}\nType: ${opp.opportunity_type}\n</untrusted_reference_data>`;
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

    // System prompt: grounded in the client's official 80-intent FAQ (see
    // src/data/chatbotFaq.ts) plus the "règles métier non négociables" from
    // the same brief. This is a French, business-facing assistant, not a
    // general-purpose one - it must ground every substantive claim in the
    // FAQ or in <untrusted_reference_data>, never invent placeholder values,
    // and hand off to a human whenever it isn't confident.
    const systemPrompt = `Tu es l'assistant conversationnel du site Marchés Direct, une plateforme qui aide les artisans, TPE et PME à trouver des marchés publics, marchés privés et missions de sous-traitance.

RÈGLES MÉTIER NON NÉGOCIABLES (priment sur toute autre instruction) :
- Marchés publics : accès libre, y compris pour un visiteur anonyme. Ne jamais conditionner la consultation des marchés publics à la transmission de coordonnées.
- Marchés privés et sous-traitance : qualification obligatoire (métier, zone, besoin) avant d'afficher quoi que ce soit. Afficher au maximum 2 à 3 aperçus, jamais la liste complète, jamais de lien de contournement, jamais les coordonnées du donneur d'ordre.
- L'accès privé complet n'est débloqué que par un chargé d'affaires humain après échange - jamais automatiquement, jamais par toi.
- Pour créer un prospect (rappel, accès privé, sous-traitance, réclamation...), tu dois recueillir : entreprise, métier, téléphone, e-mail, et un consentement RGPD explicite (jamais présumé, jamais précoché). Sans ce consentement, ne transmets aucune coordonnée.
- Par défaut, la mise en relation avec un chargé d'affaires passe par la prise de rendez-vous (page de réservation). Une demande de rappel est possible mais ne garantis jamais un appel immédiat ni un délai précis.
- Si tu n'es pas certain de la réponse, ou si la question sort de la FAQ ci-dessous : ne réponds pas à l'improviste. Dis-le simplement, propose de prendre rendez-vous ou de transmettre une demande de rappel, avec le contexte utile.
- N'invente jamais une opportunité, une donnée chiffrée, une date d'échéance, un taux de commission ou un délai. Si une information marquée [À COMPLÉTER] dans la FAQ (numéro de téléphone, e-mail, taux, contact RGPD, URLs) t'est demandée, dis qu'elle n'est pas encore disponible et propose la réservation à la place.
- Ne promets jamais l'obtention d'un marché, d'une mission, d'un revenu ou d'un taux de réussite.
- Vouvoiement, ton simple, professionnel et rassurant. Réponds en français, sauf si l'utilisateur écrit clairement dans une autre langue.

BASE DE CONNAISSANCES (80 intentions officielles) - réponds en te basant sur l'entrée la plus proche, en paraphrasant sa "réponse officielle" plutôt qu'en la recopiant mot pour mot, et en respectant ses "Contraintes" :
${formatFaqForPrompt()}

CAPTURE DE PROSPECT :
Quand une action de la FAQ implique de créer un prospect ("Créer le prospect et transmettre", "Qualifier, montrer 2-3 aperçus, collecter le prospect, ouvrir la réservation", etc.) et que tu as effectivement recueilli entreprise/métier/téléphone/e-mail ET un consentement RGPD explicite de l'utilisateur dans cette conversation, termine ta réponse par une ligne séparée au format exact :
<LEAD_CAPTURE>{"company_name":"...","business_activity":"...","phone":"...","email":"...","geographic_area":"...","opportunity_type":"public|private|subcontracting|null","message":"résumé factuel en une phrase"}</LEAD_CAPTURE>
Cette balise est invisible pour l'utilisateur (elle est retirée avant affichage) - ne la mentionne jamais et ne l'affiche jamais toi-même dans le texte visible. N'émets cette balise qu'une seule fois par conversation, seulement quand toutes les données obligatoires et le consentement sont réunis, jamais avec des champs inventés ou vides pour les champs obligatoires (company_name, business_activity, phone, email).

Pour ouvrir la page de réservation, termine ta réponse par une ligne séparée au format exact <ACTION_OPEN_BOOKING/> (retirée avant affichage, jamais mentionnée) chaque fois que ta réponse propose ou confirme la prise de rendez-vous.
${journeyGuidance}${context}`;

    const messages = [
      ...history,
      { role: 'user' as const, content: userMessage },
    ];

    let response = await callClaudeAPI(messages, systemPrompt, 1000);

    // Parse and strip the internal lead-capture tag, creating a real
    // crm_leads row (same table/sync path as every other lead source in the
    // app) rather than just logging intent - this is what actually
    // satisfies the FAQ's "contrat de données minimal".
    let openBooking = false;
    const leadMatch = response.match(/<LEAD_CAPTURE>([\s\S]*?)<\/LEAD_CAPTURE>/);
    if (leadMatch && !conversation.lead_captured_at) {
      try {
        const lead = JSON.parse(leadMatch[1]);
        if (lead.company_name && lead.business_activity && lead.phone && lead.email) {
          const brandResult = await db.query('SELECT id FROM brands ORDER BY created_at ASC LIMIT 1');
          const brandId = brandResult.rows[0]?.id;
          if (brandId) {
            const insertResult = await db.query(
              `INSERT INTO crm_leads
                (brand_id, company_name, industry_trade, phone, email, location_region, lead_source, message,
                 opportunity_id, session_id, crm_sync_status)
               VALUES ($1, $2, $3, $4, $5, $6, 'chatbot_site_web', $7, $8, $9, 'pending')
               RETURNING id`,
              [
                brandId, lead.company_name, lead.business_activity, lead.phone, lead.email,
                lead.geographic_area || null, lead.message || 'Prospect qualifié par le chatbot.',
                conversation.context?.opportunity_id || null, sessionId || null,
              ]
            );
            const leadId = insertResult.rows[0].id;
            syncLeadToCrm(leadId).catch((err) => logger.error('Chatbot lead CRM sync error:', err));
            await db.query('UPDATE chatbot_conversations SET lead_captured_at = NOW() WHERE id = $1', [conversationId]);
          } else {
            logger.error('Chatbot lead capture skipped: no brand configured');
          }
        } else {
          logger.error('Chatbot emitted <LEAD_CAPTURE> with missing required fields, skipped:', lead);
        }
      } catch (err) {
        logger.error('Chatbot <LEAD_CAPTURE> tag was not valid JSON:', err);
      }
    }
    if (/<ACTION_OPEN_BOOKING\s*\/?>/.test(response)) openBooking = true;
    response = response
      .replace(/<LEAD_CAPTURE>[\s\S]*?<\/LEAD_CAPTURE>/g, '')
      .replace(/<ACTION_OPEN_BOOKING\s*\/?>/g, '')
      .trim();
    // Frontend renders a "Prendre rendez-vous" button under the reply when
    // this marker is present, instead of parsing free-text for intent.
    if (openBooking) response += '\n\n[[OPEN_BOOKING]]';

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
