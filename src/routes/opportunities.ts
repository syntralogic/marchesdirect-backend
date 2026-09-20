import { Router, Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
import { db } from '../config/database';
import { logger } from '../utils/logger';
import { naturePrestationLateral, NATURE_VALUES } from '../utils/naturePrestation';
import { classifyOpportunity, generateOpportunitySummary, extractOpportunityFacts, generateOpportunityAnalysisSections } from '../services/aiService';
import { ingestOpportunityDocuments } from '../services/documentIngestionService';
import { computeMatchScore } from '../services/matchScoreService';
import { syncLeadToCrm } from '../services/crmSyncService';
import { geocodeCity } from '../services/geocodingService';
import { optionalAuth, authenticate, requireRole, AuthRequest } from '../middleware/auth';

const router = Router();

// Shared by GET /:id (to decide what to redact) and GET /:id/access (to
// report the unlock state directly) so the two can never disagree.
//
// Business rule (client, prototype V17): a public-market fiche is always
// fully open - the data is public record already. A private-tender or
// sous-traitance fiche stays open too (amount, tasks, deadline, score,
// criteria - everything a company needs to judge fit) EXCEPT the buyer's
// identity, which unlocks only when the visitor books a *specific* callback
// slot for that opportunity - never merely by leaving an email, and never
// by choosing "call me back, no particular time".
export async function resolveIdentityUnlocked(opportunityId: string, journey: string, sessionId: string, email: string): Promise<boolean> {
  if (journey === 'public_procurement') return true;
  if (!sessionId && !email) return false;

  const conditions: string[] = ['opportunity_id = $1'];
  const params: any[] = [opportunityId];
  let idx = 2;
  const matchClauses: string[] = [];
  if (sessionId) { matchClauses.push(`session_id = $${idx++}`); params.push(sessionId); }
  if (email) { matchClauses.push(`LOWER(email) = $${idx++}`); params.push(email.trim().toLowerCase()); }
  conditions.push(`(${matchClauses.join(' OR ')})`);
  // A booked slot unlocks it directly (appointment_mode = 'slot'); so does a
  // manual staff grant on the older access_level column, kept for backward
  // compatibility with the admin "Demandes" review flow.
  conditions.push(`(appointment_mode = 'slot' OR access_level = 'level3')`);

  const result = await db.query(`SELECT 1 FROM crm_leads WHERE ${conditions.join(' AND ')} LIMIT 1`, params);
  return result.rows.length > 0;
}

// Buyer-identity fields hidden on a private tender / sous-traitance fiche
// until resolveIdentityUnlocked() is true. Deliberately narrow - per the
// rule above, nothing else on the fiche is ever locked. Note: the schema
// only stores buyer_name today; a named contact person, direct email/phone,
// and exact street address (also called out in the spec) aren't captured
// anywhere yet - see the ingest pipeline, not this list, for that gap.
const IDENTITY_REDACTED_FIELDS = ['buyer_name', 'raw_data'];

// Sub-fields *inside* ai_extracted_facts (a JSONB blob, so not covered by
// IDENTITY_REDACTED_FIELDS above) that can carry the same identity/contact
// info the extraction step pulled out of raw_data - e.g. contact_email for
// a private tender. POST /:id/extract-facts has no journey restriction, so
// this can get populated on a locked opportunity same as a public one;
// without this, `SELECT o.*` would leak it straight past the redaction
// above the moment it's set, before any callback slot is ever booked.
const IDENTITY_REDACTED_FACT_KEYS = ['buyer_name', 'contact_email'];

function redactExtractedFacts(facts: Record<string, any> | null | undefined) {
  if (!facts) return facts;
  const redacted = { ...facts };
  for (const key of IDENTITY_REDACTED_FACT_KEYS) {
    if (redacted[key]) redacted[key] = { value: 'not available', available: false };
  }
  return redacted;
}

// Same "needs backfill" shape as jobs/factsBackfillJob.ts's SQL condition,
// checked in JS here since we already have the row in hand. Used by GET
// /:id below to extract on the spot for whatever opportunity a visitor
// actually opens, instead of making them wait for that opportunity's turn
// in the 15-minute batch job - the client's explicit ask ("jo bhi click
// karoon uska data extract kare", not just whichever 50 the cron reaches
// first).
function factsNeedExtraction(facts: Record<string, any> | null | undefined): boolean {
  if (!facts) return true;
  if (!facts.team_size_estimate) return true;
  if (!facts.key_risks) return true;
  if (!Array.isArray(facts.key_risks.value)) return true;
  // Richer "Détails du dossier" (client ask): four fields added later. A
  // record extracted before this exists but is missing them - re-run it too.
  if (!facts.contract_duration) return true;
  // "Critères de notation" card: selection_criteria added later, free-tier.
  // Was missing from this on-demand check entirely - a record extracted
  // before this field existed (but already has team_size_estimate/key_risks/
  // contract_duration from an earlier catch-up) would silently never
  // re-extract here, leaving "Critères de notation" permanently absent from
  // the fiche until the throttled batch job (factsBackfillJob.ts) happened
  // to reach it - which, given ingestion volume, could be a very long time.
  // Keep this in sync with factsBackfillJob.ts's SQL condition.
  if (!facts.selection_criteria) return true;
  return false;
}

// De-dupes concurrent extraction calls for the same opportunity id within
// this process - e.g. several visitors opening the same freshly-ingested,
// not-yet-processed fiche at nearly the same moment would otherwise each
// fire their own Claude API call for identical work. Lives only for the
// process's lifetime; that's fine, this only matters for the short window
// before an opportunity has been processed once.
const inFlightFactsExtractions = new Map<string, Promise<any>>();

async function ensureFactsExtracted(opportunityId: string, currentFacts: Record<string, any> | null | undefined) {
  if (!factsNeedExtraction(currentFacts)) return currentFacts;
  try {
    let pending = inFlightFactsExtractions.get(opportunityId);
    if (!pending) {
      pending = extractOpportunityFacts(opportunityId).finally(() => inFlightFactsExtractions.delete(opportunityId));
      inFlightFactsExtractions.set(opportunityId, pending);
    }
    return await pending;
  } catch (err) {
    logger.warn(`On-demand facts extraction failed for ${opportunityId} while serving a detail view: ${err instanceof Error ? err.message : err}`);
    // Fall through with whatever facts already existed (likely none) - the
    // rest of the fiche still renders, and the batch job will retry later.
    return currentFacts;
  }
}

// Same on-demand + de-dupe pattern as ensureFactsExtracted above, for the 3
// analysis accordions (analysisSectionsBackfillJob.ts is the slow hourly
// catch-up for everything this doesn't reach first) - a visitor opening a
// fiche the backfill hasn't gotten to yet gets it generated for their
// request instead of an empty accordion until the next cron run.
const inFlightAnalysisSections = new Map<string, Promise<any>>();

// BUG (found 10 Sep, live-testing "Commune d'Anse" signalisation fiche vs.
// the client's own Saint-Yrieix-sur-Charente sample): `if (currentSections
// || ...)` treated ANY saved object as "already generated", including
// `{presentation: '', conditions: '', entreprises: ''}` - which
// generateOpportunityAnalysisSections's defensive coercion can produce for
// a very thin/edge-case notice (safeSections falls back to '' per key
// rather than throwing). Once that shape is saved once, this guard skipped
// regeneration on every later visit forever, AND the frontend's own
// `opportunity.ai_analysis_sections ? <Accordions/> : <ai_summary/>` check
// treats that same non-null-but-empty object as truthy - so the fiche
// never re-tried and never fell back to ai_summary either; a visitor
// landing mid-way through a first, still-empty save saw nothing rendered
// at all where a paragraph used to be. Checking for real content in at
// least one field, on both ends, is what actually means "generated".
function hasAnalysisContent(sections: Record<string, any> | null | undefined): boolean {
  if (!sections) return false;
  return ['presentation', 'conditions', 'entreprises'].some(
    key => typeof sections[key] === 'string' && sections[key].trim().length > 0
  );
}

async function ensureAnalysisSectionsGenerated(
  opportunityId: string,
  currentSections: Record<string, any> | null | undefined,
  status: string | null
) {
  if (hasAnalysisContent(currentSections) || status === 'processing') return currentSections;
  try {
    let pending = inFlightAnalysisSections.get(opportunityId);
    if (!pending) {
      pending = generateOpportunityAnalysisSections(opportunityId).finally(() => inFlightAnalysisSections.delete(opportunityId));
      inFlightAnalysisSections.set(opportunityId, pending);
    }
    return await pending;
  } catch (err) {
    logger.warn(`On-demand analysis-sections generation failed for ${opportunityId} while serving a detail view: ${err instanceof Error ? err.message : err}`);
    return currentSections;
  }
}

// Unlike ensureFactsExtracted above, DCE document ingestion downloads from
// arbitrary (sometimes slow/unreliable) buyer platforms - that's exactly why
// it already runs as its own separate job rather than inline during BOAMP
// collection. Awaiting it inline here would risk slow/hung page loads. But
// with no on-demand path at all, a specifically-viewed opportunity was
// purely at the mercy of the batch job's queue order (see
// documentIngestionService.ts's starvation fix) - and Qualifications
// requises / Modalité de dépôt / Critères de notation usually live in these
// documents (RC/CCAP), not the thin BOAMP notice text, so a record stuck
// pending would show a permanently thinner "Détails du dossier" than it
// should. Kick it off in the background (fire-and-forget, de-duped per
// process like the facts extraction above) so the *next* visit or the
// batch job's next pass picks up real documents sooner, without making
// this request wait on it.
const inFlightDocumentIngestions = new Set<string>();

function kickOffDocumentIngestionIfPending(opportunityId: string, dceDocumentsStatus: string | null) {
  if (dceDocumentsStatus && dceDocumentsStatus !== 'pending') return;
  if (inFlightDocumentIngestions.has(opportunityId)) return;
  inFlightDocumentIngestions.add(opportunityId);
  ingestOpportunityDocuments(opportunityId)
    .catch(err => logger.warn(`On-demand DCE ingestion failed for ${opportunityId} while serving a detail view: ${err instanceof Error ? err.message : err}`))
    .finally(() => inFlightDocumentIngestions.delete(opportunityId));
}

// GET /api/opportunities - search & filter listings (public, powers the 3 journeys)
router.get('/', optionalAuth, async (req: Request, res: Response) => {
  try {
    const {
      journey,       // 'tender' | 'public_procurement' | 'subcontracting'
      q,             // free text search
      trade_id,
      region,
      city,
      lat,           // client audit (19 Sep): city-radius search never actually filtered by
      lng,           // distance ("Angoulême à 25 km puis à 200 km: exactement les mêmes huit
      radius_km,     // marchés"). See geocodingService.ts/geocodingBackfillJob.ts for why
                     // opportunities didn't have coordinates until now, and why this needs to
                     // stay a distinct lat/lng+radius_km filter rather than folding into `city`:
                     // a visitor picking a city from the map/autocomplete now sends its real
                     // coordinates, and this filters by actual distance instead of a text match.
      department,
      min_value,
      max_value,
      status,        // 'active' | 'expired' | 'awarded' | 'cancelled' (comma-separated for multiple)
      nature,        // R02: 'travaux' | 'fournitures' | 'etudes' | 'mixte' (comma-separated).
                      // Explicit nature-of-prestation filter - see naturePrestation.ts.
      recent_days,   // client's filter list ("marchés nouveaux") - publication_date within N days,
                      // independent of status: a just-published notice can still be 'active' whether
                      // or not it's "new", so this has to be its own filter, not folded into status.
      sort,          // client audit (R08): explicit sort was missing entirely - only a fixed
                      // active-first/soonest-deadline order existed, with no control and no
                      // stated default. 'recent' | 'match' | 'deadline' (falls back to the
                      // existing default order for any other/absent value, so old callers with
                      // no sort param keep today's behavior unchanged).
      page = '1',
      limit = '20',
    } = req.query as Record<string, string>;

    // Client's explicit ask: show every opportunity in the DB regardless of
    // status - no automatic hiding of expired/cancelled/awarded/merged rows,
    // no deadline-passed filter. Previously this read from
    // opportunity_search_index, a materialized view whose own WHERE clause
    // (schema.sql) hard-excludes status IN ('cancelled','expired','merged')
    // at the database level - so even removing every condition in this route
    // couldn't have shown those rows, the view itself never carried them.
    // Reading straight off `opportunities` instead removes that ceiling.
    // Trade-off (RESOLVED - 20 Sep, client's "réduire cette attente" /
    // 10-15s load complaint): search_vector was precomputed + GIN-indexed
    // on the view for speed; reading straight off `opportunities` meant
    // recomputing to_tsvector(unaccent(...)) from scratch per row per
    // request instead, with no index at all - likely the actual cause of
    // the slow initial load, not just a UI loading-state issue. Fixed by
    // regenerating opportunities' own search_vector (GENERATED STORED,
    // GIN-indexed) to include unaccent via an immutable wrapper function -
    // see config/database.ts's applyIncrementalMigrations for the why. The
    // @@ / ts_rank below now query that column directly instead of
    // recomputing the expression.
    //
    // status = 'merged' is the one exception kept hard-excluded below:
    // that's not a real-world tender status the client asked to surface,
    // it's deduplicationService.ts's internal marker on the losing side of
    // a duplicate pair (~2,670 rows at last count). Client's "sab dikhna
    // chahiye" ask was about not hiding cancelled/expired/awarded - not
    // about undoing deduplication. Without this, merged duplicates that
    // were already fixed once (see dedup commit) silently reappear here.
    const conditions: string[] = ["o.deleted_at IS NULL", "COALESCE(o.status, '') != 'merged'"];
    const params: any[] = [];
    let idx = 1;
    // Captured when the q filter below builds its tsvector/tsquery match,
    // so sort=match can rank by the same relevance expression instead of
    // rebuilding (and re-binding) it a second time.
    let tsRankParamIdx: number | null = null;
    // R03/R04 (client audit): homonyms and cross-category mixing ("fenêtre"
    // matching prestressing-cable "fenêtres", "couverture" matching fleece
    // blankets; travaux mixed with fournitures/études across several
    // métiers) - "classer selon le métier et le lot, pas seulement selon le
    // mot". A keyword blacklist for the couple of documented examples would
    // be exactly "selon le mot" again and wouldn't generalize to the other
    // reported métiers. classifyOpportunity (aiService.ts) already tags
    // each opportunity with an AI-reviewed trade_id/ai_matched_trades - the
    // gap is that this search never used it as a signal, so an
    // AI-classified match and an incidental text-only match (wrong métier,
    // wrong nature of prestation) ranked identically. Reuses the same
    // trade-name/ai_matched_trades condition already built for the q filter
    // below (same params, no extra binding) as a ranking boost applied
    // ahead of whichever sort the visitor picked, in every branch - not a
    // full fix for every case in the audit's 15-search annex (that needs
    // reviewing against live data this environment can't query), but a
    // real, general lever rather than a per-word patch.
    let tradeMatchExpr: string | null = null;
    // R02: which natures the visitor explicitly asked for, so the ranking
    // below can put exact matches ahead of the unknown-nature rows that the
    // filter deliberately keeps (see the `nature` filter for why).
    let requestedNatures: string[] = [];

    if (journey) {
      // Client's journey step lets several opportunity types be selected
      // at once - was a single `=` match so the frontend picking 2+ types
      // (comma-separated, same convention as region/city/department below)
      // only ever matched the first one.
      const journeys = journey.split(',').map(j => j.trim()).filter(Boolean);
      if (journeys.length > 0) {
        conditions.push(`ot.code = ANY($${idx++}::text[])`);
        params.push(journeys);
      }
    }
    if (q) {
      // Was plainto_tsquery(q), which AND's every word together - fine for
      // a single word but the journey page's search step (and its trade
      // suggestion chips, e.g. "Installation et maintenance de
      // climatisation" or "Chauffage / plomberie") sends multi-word
      // phrases, and a title/description matching most-but-not-all of
      // those words was silently excluded, undercounting real matches for
      // any query longer than one word. Builds an OR'd tsquery from the
      // individual words instead (still French-stemmed via to_tsquery's
      // 'french' config on each lexeme) so a fiche matches on any of the
      // terms, same as a normal search engine. If sanitizing strips the
      // query down to nothing (e.g. it was only punctuation), the q filter
      // is simply skipped rather than erroring or matching nothing.
      // Also: RecherchePage fires this on every keystroke (400ms debounce),
      // so the in-progress word (e.g. "trav" on the way to "travaux") was
      // still whole-word matched even after the OR fix above and returned
      // nothing until fully typed. Suffixing each term with `:*` makes
      // to_tsquery match it as a prefix instead, so live typing shows
      // results immediately rather than only once each word is complete.
      //
      // Client report (Sep 2026): typing a profession directly into the
      // search box (e.g. "peintre", "électricien") returned an inconsistent/
      // too-small number of results. Root cause: this only ever matched the
      // literal notice text (title+description) - a listing already
      // correctly AI-classified into the "Peinture" trade (trade_id set by
      // classifyOpportunity, see aiService.ts) is invisible to this box
      // whenever the raw BOAMP/DECP wording doesn't happen to contain the
      // word "peintre" itself (common - French notices often say "travaux
      // de finition" or just list a CPV code). The trade-chip flow already
      // avoided this by sending trade_id directly instead of q - the manual
      // search box had no equivalent. Now also matches against the joined
      // trade's name and the AI's own matched-trades list (same
      // ai_matched_trades::text ILIKE pattern already used by
      // matchOpportunitiesToCompany in aiService.ts), so a profession typed
      // as free text finds the same results a trade-chip search would.
      // Client audit (15 Sep): "Clim" correctly suggests "Climatisation"
      // (one word - matches fine) but also "Installation et maintenance de
      // climatisation" (multi-word), and picking that second one returned
      // thousands of unrelated results - fire-extinguisher servicing,
      // security-gate installs, photovoltaic installs. Cause: this OR'd
      // every word together, so a listing matching only "installation" OR
      // only "maintenance" (both extremely common generic words across
      // totally unrelated trades) counted as a match, even with zero
      // mention of climatisation. Filler words ("de", "et", "du"...) carry
      // no discriminating value and are dropped before matching; the
      // remaining meaningful words are now AND'd - a multi-word "métier"
      // phrase or lot has to be recognized as a whole, not as a bag of
      // independently-broadening words. Single-word queries (still the
      // common case for direct typing, e.g. "peintre") are completely
      // unaffected: AND of one term is identical to OR of one term, so the
      // earlier fix for under-matching short/typed-while-typing queries is
      // unchanged. Same AND logic applied to the trade-name / AI
      // matched-trades fallback so it can't reintroduce the same
      // broadening through that path instead.
      const FR_STOPWORDS = new Set(['de', 'du', 'des', 'la', 'le', 'les', 'et', 'en', 'au', 'aux', 'pour', 'avec', 'un', 'une', 'sur', 'dans', 'd', 'l']);
      // Apostrophes/typographic quotes used to be deleted outright by the
      // sanitizer below, gluing "l'eau" into the single non-word "leau"
      // (matches nothing). Treat them as word separators instead.
      // Leading/trailing hyphens are stripped and hyphen-only tokens dropped:
      // a bare "-" reaching to_tsquery is a syntax error -> HTTP 500 -> the
      // page showed no results at all.
      const foldAccents = (v: string) => v.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      const qWordsRaw = q
        .replace(/['\u2019`]/g, ' ')
        .split(/\s+/)
        .map(w => w.replace(/[^\p{L}\p{N}-]/gu, '').replace(/^-+|-+$/g, '').trim())
        .filter(Boolean);
      const qWordsMeaningful = qWordsRaw.filter(w => !FR_STOPWORDS.has(w.toLowerCase()));
      const qWords = qWordsMeaningful.length > 0 ? qWordsMeaningful : qWordsRaw;
      // A profession typed the way people say it ("peintre", "electricien",
      // "plombier", "carreleur") never shares a stem with the trade/notice
      // wording ("Peinture", "Electricite", "Plomberie", "Carrelage"): French
      // stemming keeps peintre->peintr but peinture->peintur, so the exact
      // word matched only the few notices that literally contain it. Each
      // word therefore also gets a shorter stem (agent suffix removed, at
      // least 4 letters kept) that is OR'd with the original word - a fiche
      // matches a word if it matches either form, while different words are
      // still AND'd with each other as before.
      const AGENT_SUFFIXES = ['ienne', 'ien', 'iere', 'ier', 'euse', 'eur', 'iste', 're'];
      const stemOf = (w: string): string | null => {
        const f = foldAccents(w);
        for (const suf of AGENT_SUFFIXES) {
          if (f.endsWith(suf) && f.length - suf.length >= 4) return f.slice(0, f.length - suf.length);
        }
        return null;
      };
      // Client (19 Sep): "ITE", "Clim" and "isolation thermique" as examples
      // of poor matching, point 3/4 of the numbered list - a référentiel of
      // synonyms/abbreviations per métier. Stemming/prefix matching above
      // handles word-forms of the SAME word (peintre/peinture,
      // climat/climatisation), but an acronym like "ITE" (isolation
      // thermique par l'extérieur) shares no letters with "isolation" at
      // all - no amount of stemming or prefix matching bridges that; it can
      // only come from an explicit lookup. Each entry's synonyms are added
      // as extra OR-alternatives for that one word's slot (still AND'd
      // against the query's other words as before), on both the tsquery
      // side and the trade-name/ai_matched_trades ILIKE side.
      const TRADE_KEYWORD_SYNONYMS: Record<string, string[]> = {
        ite: ['isolation', 'exterieur'],
        iti: ['isolation', 'interieur'],
        clim: ['climatisation'],
        cvc: ['climatisation', 'chauffage', 'ventilation'],
        vmc: ['ventilation'],
        pac: ['pompe', 'chaleur'],
        couvreur: ['toiture', 'couverture'],
        toiture: ['couverture'],
        etancheite: ['etancheur'],
        macon: ['maconnerie'],
        elec: ['electricite'],
        electricien: ['electricite'],
        plombier: ['plomberie'],
        chauffagiste: ['chauffage'],
        menuisier: ['menuiserie'],
        fenetre: ['menuiserie'],
        fenetres: ['menuiserie'],
        carreleur: ['carrelage'],
        platrier: ['platrerie'],
        placo: ['platrerie'],
        placoplatre: ['platrerie'],
        vrd: ['voirie', 'reseaux'],
        terrassement: ['vrd'],
        proprete: ['nettoyage'],
        paysagiste: ['espaces', 'verts'],
        paysagisme: ['espaces', 'verts'],
      };
      const synonymsOf = (w: string): string[] => TRADE_KEYWORD_SYNONYMS[foldAccents(w).toLowerCase()] || [];
      // Client (19/20 Sep, search overhaul points 2 & 5): "Un lot électricité
      // ne doit pas ressortir pour « fenêtre » simplement parce que le
      // descriptif général du chantier mentionne des fenêtres... une mention
      // accessoire dans une longue description ne doit pas suffire." The
      // opportunities table has no per-lot structure at all (BOAMP/DECP
      // notices covering several lots get flattened into one title+
      // description at ingestion - a real per-lot fix would mean parsing lot
      // structure out of raw_data, which isn't safely doable without live
      // access to confirm the actual BOAMP/DECP field shapes first), so this
      // targets the same symptom the client's example describes without
      // guessing at that: for a query WORD that names a trade/métier concept
      // (the same référentiel used for synonym expansion below, e.g. "clim",
      // "ite", "fenêtre" -> menuiserie, or the trade's own name), an
      // incidental mention buried in the long description is no longer
      // enough on its own - it has to be either in the TITLE (short, lot-
      // specific: "Lot 3 - Menuiseries extérieures", not a page of prose) or
      // confirmed by the AI's own trade classification for that listing
      // (trade_id/ai_matched_trades - already computed by classifyOpportunity,
      // aiService.ts). A non-trade word (a city name, a generic term not in
      // this référentiel) keeps matching the full title+description as
      // before - this is specifically about métier words, not a general
      // tightening of every search.
      const TRADE_CONCEPT_TOKENS = new Set(
        Object.values(TRADE_KEYWORD_SYNONYMS).flat().concat(Object.keys(TRADE_KEYWORD_SYNONYMS))
      );
      const isTradeWord = (w: string): boolean => {
        if (synonymsOf(w).length > 0) return true;
        const folded = foldAccents(w).toLowerCase();
        if (TRADE_CONCEPT_TOKENS.has(folded)) return true;
        const stem = stemOf(w);
        return !!stem && TRADE_CONCEPT_TOKENS.has(stem);
      };
      if (qWords.length > 0) {
        const tsIdx = idx++;
        tsRankParamIdx = tsIdx;
        // Pushed immediately (matching tsIdx's allocation order, the first
        // $N in this block) rather than after the loop below - params must
        // land in the array in the exact same order their $N was allocated.
        params.push(
          qWords
            .map(w => {
              const stem = stemOf(w);
              const syns = synonymsOf(w);
              const alts = [`${w}:*`, ...(stem ? [`${stem}:*`] : []), ...syns.map(s => `${s}:*`)];
              return alts.length > 1 ? `(${alts.join(' | ')})` : alts[0];
            })
            .join(' & ')
        );
        const tradeConds: string[] = [];
        const wordConds: string[] = [];
        for (const w of qWords) {
          const stem = stemOf(w);
          const syns = synonymsOf(w);
          const patterns = [`%${foldAccents(w)}%`, ...(stem ? [`%${stem}%`] : []), ...syns.map(s => `%${s}%`)];

          const nameIdx = idx++;
          params.push(patterns);
          const matchedIdx = idx++;
          params.push(patterns);
          // BUG (found 19 Sep, client report "har search mein kam/koi result
          // nahi hota"): the DB's accented trade name / matched-trades text
          // ("Electricite" with accent) was compared straight against an
          // unaccented typed pattern - ILIKE folds case, not accents.
          // unaccent() on the column side + pre-folded patterns on the
          // parameter side make the match accent-insensitive.
          const tradeCond = `(unaccent(t.name) ILIKE ANY($${nameIdx}::text[]) OR unaccent(o.ai_matched_trades::text) ILIKE ANY($${matchedIdx}::text[]))`;
          tradeConds.push(tradeCond);

          if (isTradeWord(w)) {
            const titleIdx = idx++;
            params.push(patterns);
            wordConds.push(`(unaccent(o.title) ILIKE ANY($${titleIdx}::text[]) OR ${tradeCond})`);
          } else {
            const wordTsIdx = idx++;
            const alts = [`${w}:*`, ...(stem ? [`${stem}:*`] : []), ...syns.map(s => `${s}:*`)];
            params.push(alts.length > 1 ? `(${alts.join(' | ')})` : alts[0]);
            wordConds.push(`o.search_vector @@ to_tsquery('french', unaccent($${wordTsIdx}))`);
          }
        }
        conditions.push(wordConds.join(' AND '));
        tradeMatchExpr = tradeConds.join(' AND ');
      }
    }
    if (trade_id) {
      conditions.push(`o.trade_id = $${idx++}`);
      params.push(trade_id);
    }
    if (region) {
      // Client's map lets several regions be selected at once (e.g.
      // "Nouvelle-Aquitaine, Bretagne") - was a single ILIKE match, so
      // picking 2+ regions on the map silently searched only the first one
      // once the frontend passed them through (comma-separated below).
      //
      // G13 (contre-audit 15 Sep): "carte vs liste count discrepancy (Grand
      // Est etc.)" - clicking a region on the map and landing on this list
      // showed a different total than the map's own count for that region.
      // Root cause was upstream in /stats/regions (unaccented + summed
      // there now - see that route), but a plain ILIKE here would still
      // under-match against it: /stats/regions now sums every accent/case
      // variant of a region name under one number, and hands this filter
      // whichever raw variant happened to be picked as the label (e.g.
      // "Île-de-France"). A DB row stored as "Ile-de-France" (no accent)
      // would count toward the map's total but fail a plain ILIKE '%Île-de-
      // France%' here, so the list would show fewer than the map promised.
      // unaccent() on both sides of the comparison keeps the two endpoints
      // in agreement regardless of which accent/case variant is on either
      // side.
      const regions = region.split(',').map(r => r.trim()).filter(Boolean);
      if (regions.length > 0) {
        conditions.push(
          `unaccent(o.location_region) ILIKE ANY(ARRAY(SELECT unaccent(p) FROM unnest($${idx++}::text[]) AS p))`
        );
        params.push(regions.map(r => `%${r}%`));
      }
    }
    const latNum = parseFloat(lat);
    const lngNum = parseFloat(lng);
    const radiusNum = parseFloat(radius_km);
    const hasRadiusSearch = !isNaN(latNum) && !isNaN(lngNum) && !isNaN(radiusNum) && radiusNum > 0;

    if (hasRadiusSearch) {
      // Real distance filter, not a text match - a visitor searching
      // "around Angoulême, 25 km" should see nearby communes too, not just
      // rows whose location_city literally says "Angoulême". Same
      // Haversine formula as /stats/near above, so the count shown there
      // and the results list here always agree (client audit point 10/G14
      // territory - a count and its destination list disagreeing was
      // already flagged once for region/department).
      // location_latitude = 0 AND location_longitude = 0 is the
      // geocoding-backfill-job sentinel for "couldn't geocode this city" -
      // excluded explicitly rather than relying on it always failing the
      // distance check, since a radius large enough to reach off the coast
      // of Africa is not something to depend on staying true forever.
      conditions.push(`
        o.location_latitude IS NOT NULL AND o.location_longitude IS NOT NULL
        AND NOT (o.location_latitude = 0 AND o.location_longitude = 0)
        AND (
          6371 * acos(
            LEAST(1, GREATEST(-1,
              cos(radians($${idx++})) * cos(radians(o.location_latitude)) *
              cos(radians(o.location_longitude) - radians($${idx++})) +
              sin(radians($${idx++})) * sin(radians(o.location_latitude))
            ))
          )
        ) <= $${idx++}
      `);
      params.push(latNum, lngNum, latNum, radiusNum);
    } else if (city) {
      const cities = city.split(',').map(c => c.trim()).filter(Boolean);
      if (cities.length > 0) {
        // BOAMP/DECP store city names inconsistently ("BORDEAUX",
        // "Angouleme", "Angoulême") - ILIKE folds case but not accents, so a
        // city picked with its accent missed unaccented rows and vice versa.
        // Same unaccent() treatment the region filter already has.
        conditions.push(`unaccent(o.location_city) ILIKE ANY(ARRAY(SELECT unaccent(p) FROM unnest($${idx++}::text[]) AS p))`);
        params.push(cities.map(c => `%${c}%`));
      }
    }
    if (department) {
      // Was a strict `=` match against whatever format the frontend sent -
      // fine when it exactly matches how location_department was stored,
      // but dataCollectionService.ts falls back to the source's raw,
      // un-normalized department string whenever normalizeDepartmentCode()
      // can't parse it (see departmentRegion.ts), so some rows carry "5"
      // instead of the padded "05", stray whitespace, or lowercase "2a"/
      // "2b" for Corsica. A visitor picking "Whole department" (which
      // sends the clean 2/3-digit code from the address lookup) would
      // silently miss every one of those rows - real matches quietly
      // dropped, not a search problem, a comparison-strictness one.
      // Compares case-insensitively, trimmed, and against both the padded
      // and unpadded form of each requested code instead.
      const departments = department.split(',').map(d => d.trim().toUpperCase()).filter(Boolean);
      if (departments.length > 0) {
        const departmentVariants = new Set<string>();
        for (const d of departments) {
          departmentVariants.add(d);
          departmentVariants.add(d.padStart(2, '0'));
          departmentVariants.add(d.padStart(3, '0'));
          departmentVariants.add(d.replace(/^0+/, '') || d);
        }
        conditions.push(`UPPER(TRIM(o.location_department)) = ANY($${idx++}::text[])`);
        params.push(Array.from(departmentVariants));
      }
    }
    if (min_value) {
      conditions.push(`o.estimated_value >= $${idx++}`);
      params.push(min_value);
    }
    if (max_value) {
      conditions.push(`o.estimated_value <= $${idx++}`);
      params.push(max_value);
    }
    if (status) {
      // Only filters by status when the caller explicitly asks for one -
      // otherwise every status is included (see comment above).
      const statuses = status.split(',').map(s => s.trim()).filter(Boolean);
      if (statuses.length > 0) {
        conditions.push(`o.status = ANY($${idx++}::text[])`);
        params.push(statuses);
      }
    }
    if (nature) {
      // R02 (contre-audit 15 Sep): "espaces verts" kept returning
      // spare-parts-for-mower notices alongside the actual landscaping
      // contracts. Those aren't homonyms or a wrong métier - they really
      // are espaces-verts notices - so neither the R03 trade boost nor a
      // relevance tweak can separate them. What's wrong for the visitor is
      // the *nature* of the prestation, and until now the only handling of
      // that was a silent tiebreaker (commit 32a6bd8) that a visitor
      // couldn't see, couldn't control, and which did nothing at all on the
      // ~47k rows the classifier hasn't re-tagged yet. This makes it an
      // explicit, visible filter instead: "je cherche des travaux" actually
      // removes the fournitures rows rather than pushing them a few places
      // down.
      //
      // Unknown-nature rows (naturePrestationSql returns NULL: neither the
      // classifier nor the heuristic could read the notice confidently) are
      // deliberately KEPT when a nature is requested. Dropping them would
      // silently hide real work from a visitor who asked to narrow, not to
      // lose results - the same reasoning as the NULL handling in the
      // ranking below. They just rank last (see orderClause).
      const natures = nature
        .split(',')
        .map((n) => n.trim().toLowerCase())
        .filter((n) => (NATURE_VALUES as readonly string[]).includes(n));
      if (natures.length > 0) {
        conditions.push(`(np.nature = ANY($${idx++}::text[]) OR np.nature IS NULL)`);
        params.push(natures);
        requestedNatures = natures;
      }
    }
    if (recent_days) {
      // "Nouveau" is a temporary badge on recently-published notices, not a
      // real status (client's 8 Sep audit) - so it has to be filterable on
      // its own, on top of whatever status filter (if any) is also applied,
      // rather than being one of the status values above.
      const days = Math.max(parseInt(recent_days, 10) || 0, 0);
      if (days > 0) {
        conditions.push(`o.publication_date >= NOW() - ($${idx++}::text || ' days')::interval`);
        params.push(String(days));
      }
    }

    const pageNum = Math.max(parseInt(page) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit) || 20, 1), 100);
    const offset = (pageNum - 1) * limitNum;

    const whereClause = conditions.join(' AND ');

    // Default order (unchanged from before this ticket): active-and-not-yet-
    // expired opportunities first, then soonest deadline. Kept as the
    // fallback for sort=deadline, no sort param, or an unrecognized value -
    // so existing callers see no behavior change.
    // Root cause of the client's pagination glitch (counter said 306,
    // list stopped at 305 with no way to continue): neither DEFAULT_ORDER
    // nor sort=recent had a stable final tiebreaker, so rows sharing the
    // same deadline (or both NULL) or the same publication_date could be
    // ordered differently between the page-1 query and the page-2 query if
    // anything in the table changed between the two requests (or even just
    // from query-plan nondeterminism on ties) - a row could land on both
    // pages (duplicate id -> React only renders one, so the list looks one
    // short) or be skipped by both. Appending o.id ASC makes the order
    // fully deterministic across pages regardless of ties.
    const DEFAULT_ORDER = `(o.status = 'active' AND (o.deadline IS NULL OR o.deadline >= NOW())) DESC, o.deadline ASC NULLS LAST, o.id ASC`;
    // Client (19/20 Sep, search overhaul point 5): title match should
    // outrank a description-only match of the same word, and this needs to
    // hold for an ordinary search, not just when the visitor manually picks
    // "Pertinence" from the sort dropdown - most visitors typing a search
    // never touch that control. search_vector is now weighted (title 'A' >
    // description 'B' - see database.ts), so ts_rank genuinely reflects
    // that distinction once used. Applied as a tiebreaker ahead of the
    // date-based order whenever a real text query was given, for the
    // default order (below) and kept for sort=match; sort=recent is a
    // visitor's explicit, deliberate ask for pure chronological order and
    // isn't touched.
    const relevanceTiebreak = tsRankParamIdx !== null
      ? `ts_rank(o.search_vector, to_tsquery('french', unaccent($${tsRankParamIdx}))) DESC, `
      : '';
    let orderClause = `${relevanceTiebreak}${DEFAULT_ORDER}`;
    if (sort === 'recent') {
      orderClause = `o.publication_date DESC NULLS LAST, o.id ASC`;
    } else if (sort === 'match') {
      // Relevance only means something with a text query to rank against;
      // with no q, there's nothing to score, so this falls back to the
      // default order rather than an arbitrary/meaningless ranking.
      orderClause = tsRankParamIdx !== null
        ? `ts_rank(o.search_vector, to_tsquery('french', unaccent($${tsRankParamIdx}))) DESC, ${DEFAULT_ORDER}`
        : DEFAULT_ORDER;
    }
    // R03/R04 boost: an AI-classified trade match outranks a same-word,
    // wrong-métier text match, regardless of which sort the visitor chose.
    if (tradeMatchExpr) {
      orderClause = `(CASE WHEN (${tradeMatchExpr}) THEN 0 ELSE 1 END) ASC, ${orderClause}`;
    }
    // R04 (deeper fix, needs nature_prestation - see database.ts migration
    // and classifyOpportunity in aiService.ts): audit's own examples are
    // all métier/trade searches (chauffage, peinture, plomberie,
    // maçonnerie, électricité, carrelage, menuiserie) where "travaux mixed
    // with fournitures et études" was the complaint, so this only applies
    // as a secondary tiebreaker alongside the trade-match boost above, not
    // globally - a query with no métier signal has no basis to prefer one
    // nature over another. Rows not yet reclassified (nature_prestation
    // still NULL - existing 47k backlog until the batch job above catches
    // up) rank alongside travaux/mixte rather than being pushed down, so
    // this only demotes rows the AI has positively tagged as fournitures
    // or études, not everything unclassified.
    // R02 update: this used the raw `o.nature_prestation` column, which is
    // only ever written by the AI classification pass - so on the ~47k rows
    // that pass hasn't reached, every row read NULL and the demotion did
    // nothing. That is why "espaces verts" still showed spare parts after
    // 32a6bd8 shipped. naturePrestationSql() keeps the AI value whenever
    // there is one and falls back to a conservative reading of the notice
    // wording otherwise, so this works on the whole corpus from the first
    // request instead of waiting on a reclassification backlog. Rows the
    // fallback still can't read stay NULL and are still not demoted.
    if (tradeMatchExpr) {
      orderClause = `(CASE WHEN np.nature IN ('fournitures', 'etudes') THEN 1 ELSE 0 END) ASC, ${orderClause}`;
    }
    // R02: when the visitor picked a nature explicitly, rows that actually
    // match it come first and the unknown-nature rows kept by the filter
    // follow - narrowing changes the order of the page, not just its length.
    if (requestedNatures.length > 0) {
      const naturesLiteral = requestedNatures.map((n) => `'${n}'`).join(', ');
      orderClause = `(CASE WHEN np.nature IN (${naturesLiteral}) THEN 0 ELSE 1 END) ASC, ${orderClause}`;
    }

    const listResult = await db.query(
      `SELECT o.id, o.title, o.description, o.deadline, o.publication_date,
              o.estimated_value, o.currency, o.location_city, o.location_region,
              o.location_department, o.estimated_start_date, o.estimated_end_date,
              o.ai_classification_status, o.ai_summary, o.ai_matched_trades, o.status,
              ot.code as journey, t.name as trade_name, o.buyer_name,
              -- R02: the resolved nature (AI value when classified, notice-wording
              -- fallback otherwise, NULL when genuinely unreadable) so the result
              -- card can say "Fournitures" out loud instead of the visitor having
              -- to open a spare-parts notice to find out.
              np.nature AS nature_prestation
       FROM opportunities o
       LEFT JOIN opportunity_types ot ON o.opportunity_type_id = ot.id
       LEFT JOIN trades t ON o.trade_id = t.id
       ${naturePrestationLateral('o')}
       WHERE ${whereClause}
       ORDER BY ${orderClause}
       LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, limitNum, offset]
    );

    const countResult = await db.query(
      `SELECT COUNT(*) as total
       FROM opportunities o
       LEFT JOIN opportunity_types ot ON o.opportunity_type_id = ot.id
       LEFT JOIN trades t ON o.trade_id = t.id
       ${naturePrestationLateral('o')}
       WHERE ${whereClause}`,
      params
    );

    res.json({
      results: listResult.rows,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: parseInt(countResult.rows[0].total),
        totalPages: Math.ceil(parseInt(countResult.rows[0].total) / limitNum),
      },
    });
  } catch (err: any) {
    logger.error('Opportunities search error:', err);
    res.status(500).json({ error: 'Failed to search opportunities' });
  }
});

// Best-effort link to the original notice on its source platform, extracted
// from raw_data. The open-data feeds we ingest (BOAMP etc.) publish notice
// metadata, not the DCE PDF itself - the actual consultation documents live
// on the buyer's own "profil acheteur" platform, referenced from the notice.
// So this links out to the official source rather than pretending to host a
// file we were never given. Tries a few plausible field names defensively
// since we can't fully verify the schema from field names alone; a source
// with no matching field simply gets no link (frontend hides the button).
const extractSourceUrl = (rawData: any): string | null => {
  if (!rawData) return null;
  const fields = rawData.fields || rawData;
  const candidates = [
    fields.url_avis, fields.url, fields.lien_avis, fields.link,
    rawData.link, rawData.source_url,
  ];
  const found = candidates.find((c) => typeof c === 'string' && c.startsWith('http'));
  return found || null;
};

// GET /api/opportunities/stats/counts - real, live opportunity counts per
// journey (public_procurement/tender/subcontracting) plus a grand total,
// for the homepage/dashboard counters. Client's report (WhatsApp): three
// different numbers appeared across the homepage (~3,421, hardcoded),
// dashboard (~2,940) and search (46,000+), with no way to tell what each
// one represented. Uses opportunity_search_index with the exact same
// scope the main search route uses (deadline-based hiding removed
// 2026-09-09 - closed/awarded rows are labeled by the frontend now
// instead of being excluded), so this can never disagree with what
// clicking through to a category actually shows.
router.get('/stats/counts', async (req: Request, res: Response) => {
  try {
    const result = await db.query(
      `SELECT opportunity_type AS journey, COUNT(*)::int AS count
       FROM opportunity_search_index
       GROUP BY opportunity_type`
    );
    const byJourney: Record<string, number> = {};
    let total = 0;
    for (const row of result.rows) {
      byJourney[row.journey] = row.count;
      total += row.count;
    }
    res.json({
      total,
      public_procurement: byJourney['public_procurement'] || 0,
      tender: byJourney['tender'] || 0,
      subcontracting: byJourney['subcontracting'] || 0,
    });
  } catch (err: any) {
    logger.error('Opportunity counts error:', err);
    res.status(500).json({ error: 'Failed to load opportunity counts' });
  }
});

// GET /api/opportunities/stats/regions - opportunity count per French region,
// for the interactive map on /zones. Groups on location_region as stored by
// the connectors (BOAMP etc. give a region name directly on most notices).
//
// Client's explicit ask: count regardless of status - no excluding
// expired/cancelled/awarded/merged, no deadline-passed filter. Reads
// straight off `opportunities` (not opportunity_search_index, whose own
// WHERE clause hard-excludes cancelled/expired/merged at the view
// definition level) so every row counts here exactly like the main search
// (GET /) now does. Exception: status = 'merged' (deduplicationService.ts's
// marker for the losing side of a duplicate pair) stays excluded here too,
// same reasoning as the GET / route above - "show everything" was never
// meant to bring back already-deduplicated rows.
router.get('/stats/regions', async (req: Request, res: Response) => {
  try {
    // G13 (contre-audit 15 Sep): "carte vs liste count discrepancy (Grand
    // Est etc.)" - the map's per-region number and the list total for the
    // same region disagreed. This grouped on the raw location_region string,
    // so "Grand Est", "grand est" and "Grand Est " (connector feeds are not
    // consistent about case/whitespace/accents) landed as separate rows with
    // separate counts instead of one. The frontend then folds them together
    // client-side (normalizeFr in HomePage.tsx) by writing each into the
    // same map key - which means the LAST variant processed silently
    // overwrote the earlier ones rather than summing, so the map showed only
    // one variant's count while the list search (a single ILIKE '%region%'
    // that matches all of them at once, now case/accent-insensitive too -
    // see the region filter above) showed the true total. Grouping by the
    // normalized key here means there is exactly one row per region to begin
    // with, so summing happens once, in SQL, instead of depending on every
    // caller to fold duplicates correctly.
    const result = await db.query(
      `SELECT MAX(location_region) AS region, COUNT(*)::int AS count
       FROM opportunities
       WHERE location_region IS NOT NULL AND location_region != ''
         AND deleted_at IS NULL
         AND status != 'merged'
       GROUP BY lower(unaccent(trim(location_region)))
       ORDER BY count DESC`
    );
    res.json({ regions: result.rows });
  } catch (err: any) {
    logger.error('Region stats error:', err);
    res.status(500).json({ error: 'Failed to load region stats' });
  }
});

// GET /api/opportunities/stats/departments - same, grouped by French
// department (numeric code, e.g. "33" for Gironde). Same "count everything
// except merged duplicates" rule as /stats/regions above.
router.get('/stats/departments', async (req: Request, res: Response) => {
  try {
    // Same fix as /stats/regions just above, for the same reason: raw
    // location_department carries whatever the source sent - "5" and "05"
    // for the same département (see the department filter's own padding
    // comment a few hundred lines up), so grouping on the raw value split
    // one département's count across two rows, which the frontend's map
    // (keyed by code, no normalization applied there) then only picked one
    // of. Grouping on the padded/trimmed code sums them into one row.
    const result = await db.query(
      `SELECT MAX(TRIM(location_department)) AS department, COUNT(*)::int AS count
       FROM opportunities
       WHERE location_department IS NOT NULL AND location_department != ''
         AND deleted_at IS NULL
         AND status != 'merged'
       GROUP BY CASE
         WHEN TRIM(location_department) ~ '^[0-9]+$' THEN LPAD(TRIM(location_department), 2, '0')
         ELSE UPPER(TRIM(location_department))
       END
       ORDER BY count DESC`
    );
    res.json({ departments: result.rows });
  } catch (err: any) {
    logger.error('Department stats error:', err);
    res.status(500).json({ error: 'Failed to load department stats' });
  }
});

// GET /api/opportunities/geocode-city?city=&department= - resolves a city
// name (typed into the location search box) to coordinates, so the
// frontend can then search by real lat/lng/radius_km instead of a plain
// city-name text match. Proxied through our own backend rather than
// called directly from the browser so the frontend never has to depend on
// api-adresse.data.gouv.fr's CORS policy (undocumented/uncertain - see
// geocodingService.ts) and so this stays the one place that talks to it.
router.get('/geocode-city', async (req: Request, res: Response) => {
  try {
    const city = (req.query.city as string || '').trim();
    const department = (req.query.department as string || '').trim() || null;
    if (!city) {
      return res.status(400).json({ error: 'city is required' });
    }
    const result = await geocodeCity(city, department);
    if (!result) {
      return res.status(404).json({ error: 'Could not geocode this city' });
    }
    res.json(result);
  } catch (err: any) {
    logger.error('Geocode-city error:', err);
    res.status(500).json({ error: 'Failed to geocode city' });
  }
});

// GET /api/opportunities/stats/near?lat=&lng=&radius_km= - count within a
// radius of a point, for the "Villes" (city) tab. Uses the Haversine formula
// directly in SQL since PostGIS isn't set up on this database. Same "count
// everything except merged duplicates" rule as /stats/regions above.
router.get('/stats/near', async (req: Request, res: Response) => {
  try {
    const lat = parseFloat(req.query.lat as string);
    const lng = parseFloat(req.query.lng as string);
    const radiusKm = parseFloat((req.query.radius_km as string) || '50');
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ error: 'lat and lng are required numeric query params' });
    }
    const result = await db.query(
      `SELECT COUNT(*)::int AS count
       FROM opportunities
       WHERE location_latitude IS NOT NULL AND location_longitude IS NOT NULL
         AND deleted_at IS NULL
         AND status != 'merged'
         AND (
           6371 * acos(
             LEAST(1, GREATEST(-1,
               cos(radians($1)) * cos(radians(location_latitude)) *
               cos(radians(location_longitude) - radians($2)) +
               sin(radians($1)) * sin(radians(location_latitude))
             ))
           )
         ) <= $3`,
      [lat, lng, radiusKm]
    );
    res.json({ count: result.rows[0]?.count ?? 0, radius_km: radiusKm });
  } catch (err: any) {
    logger.error('Near stats error:', err);
    res.status(500).json({ error: 'Failed to load nearby stats' });
  }
});

// Spec section 3.2/3.4: an aggregated, name-free stat about the buyer
// ("14 marchés similaires publiés en 3 ans") that must stay visible even
// when the buyer's identity itself is locked - grouped server-side by the
// real buyer_name before it's ever redacted from the response, so the count
// is accurate without the name leaking. Pure SQL, no AI/LLM involved.
async function computeBuyerHistoryCount(buyerName: string | null, opportunityId: string): Promise<number | null> {
  if (!buyerName) return null;
  const result = await db.query(
    `SELECT COUNT(*)::int as count FROM opportunities
     WHERE buyer_name = $1 AND id != $2 AND deleted_at IS NULL
       AND publication_date > NOW() - INTERVAL '3 years'`,
    [buyerName, opportunityId]
  );
  return result.rows[0]?.count ?? 0;
}

// Client's "Documents analysés" stat (dix images, écran "Détails du
// dossier"): a real count of DCE attachments this platform actually
// downloaded and parsed for this opportunity - see
// documentIngestionService.ts. Counts only rows that reached 'parsed'
// (real extracted text), never candidates that were only found as a link
// (status 'external_platform_only'/'pending'/'failed') - those weren't
// actually analyzed. Returns null (not 0) while ingestion hasn't run yet
// at all, so the UI can tell "not analyzed yet" apart from "zero found".
async function computeDocumentsAnalyzedCount(opportunityId: string, dceDocumentsStatus: string | null): Promise<number | null> {
  if (!dceDocumentsStatus || dceDocumentsStatus === 'pending') return null;
  const result = await db.query(
    `SELECT COUNT(*)::int as count FROM tender_documents WHERE opportunity_id = $1 AND status = 'parsed'`,
    [opportunityId]
  );
  return result.rows[0]?.count ?? 0;
}

// GET /api/opportunities/:id - detail page
router.get('/:id', optionalAuth, async (req: AuthRequest, res: Response) => {
  try {
    const result = await db.query(
      `SELECT o.*, ot.code as journey, ot.name as journey_name, t.name as trade_name,
              c.code as cpv_display
       FROM opportunities o
       LEFT JOIN opportunity_types ot ON o.opportunity_type_id = ot.id
       LEFT JOIN trades t ON o.trade_id = t.id
       LEFT JOIN cpv_codes c ON o.cpv_code_id = c.id
       WHERE o.id = $1 AND o.deleted_at IS NULL`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Opportunity not found' });
    }

    const opportunity = result.rows[0];

    // On-demand extraction: whatever opportunity a visitor actually opens
    // gets its facts filled in right now if the batch job hasn't reached it
    // yet, rather than showing an empty "Détails du dossier" until its turn
    // comes up in a future 15-minute run. Only fires when facts are
    // genuinely missing/malformed (see factsNeedExtraction) - already-good
    // records never re-call the LLM here.
    // Run these two on-demand LLM calls in parallel rather than back-to-back
    // awaits - a fiche that needs BOTH facts and analysis-sections generated
    // for the first time (2 sequential Claude calls, easily several seconds
    // each) roughly doubled the response time this request had to sit
    // through, and a slow/cold generation on either side risked tripping
    // the platform's own gateway timeout before the response ever went out
    // - which reads to the visitor as "the fiche just didn't update",
    // indistinguishable from generation never having run at all.
    const [extractedFacts, analysisSections] = await Promise.all([
      ensureFactsExtracted(opportunity.id, opportunity.ai_extracted_facts),
      ensureAnalysisSectionsGenerated(opportunity.id, opportunity.ai_analysis_sections, opportunity.ai_analysis_sections_status),
    ]);
    opportunity.ai_extracted_facts = extractedFacts;
    opportunity.ai_analysis_sections = analysisSections;
    kickOffDocumentIngestionIfPending(opportunity.id, opportunity.dce_documents_status);

    const sessionId = (req.query.sessionId as string) || '';
    const email = (req.user?.email || (req.query.email as string) || '');
    const unlocked = await resolveIdentityUnlocked(req.params.id, opportunity.journey, sessionId, email);

    // Computed from the real buyer_name *before* it's redacted below - the
    // count itself is never identity-revealing, so it goes out regardless
    // of unlock state (spec explicitly calls this out as an exception).
    opportunity.buyer_history_count = await computeBuyerHistoryCount(opportunity.buyer_name, opportunity.id);
    opportunity.documents_analyzed_count = await computeDocumentsAnalyzedCount(opportunity.id, opportunity.dce_documents_status);

    if (!unlocked) {
      for (const field of IDENTITY_REDACTED_FIELDS) delete opportunity[field];
      opportunity.ai_extracted_facts = redactExtractedFacts(opportunity.ai_extracted_facts);
    } else {
      opportunity.source_url = extractSourceUrl(opportunity.raw_data);
    }
    opportunity.identity_unlocked = unlocked;


    res.json(opportunity);
  } catch (err: any) {
    logger.error('Opportunity detail error:', err);
    res.status(500).json({ error: 'Failed to fetch opportunity' });
  }
});

// ============================================================================
// GRADUATED ACCESS (opportunity detail page "Conditions et accès")
//
// Public-procurement opportunities are always fully open. Private tenders and
// subcontracting opportunities start at level1 (teaser only); level2 unlocks
// the instant a visitor leaves their contact details (POST .../request-access
// below); level3 ("accès complet") is only ever granted by a staff member
// from the admin panel (PUT /api/admin/opportunity-leads/:id/grant-access) -
// there is intentionally no code path that sets it automatically.
// ============================================================================

// GET /api/opportunities/:id/access?email=... - current access level.
// Logged-in users are matched by their account email; anonymous visitors who
// already submitted the lead form pass the same email back as a query param
// so a returning visitor can see if a chargé d'affaires has since upgraded
// them to level3, without needing an account.
router.get('/:id/access', optionalAuth, async (req: AuthRequest, res: Response) => {
  try {
    const oppResult = await db.query(
      `SELECT o.id, ot.code as journey FROM opportunities o
       LEFT JOIN opportunity_types ot ON o.opportunity_type_id = ot.id
       WHERE o.id = $1 AND o.deleted_at IS NULL`,
      [req.params.id]
    );
    if (oppResult.rows.length === 0) {
      return res.status(404).json({ error: 'Opportunity not found' });
    }
    const sessionId = (req.query.sessionId as string) || '';
    const email = (req.user?.email || (req.query.email as string) || '');
    const unlocked = await resolveIdentityUnlocked(req.params.id, oppResult.rows[0].journey, sessionId, email);
    res.json({ identityUnlocked: unlocked });
  } catch (err: any) {
    logger.error('Opportunity access check error:', err);
    res.status(500).json({ error: 'Failed to check access' });
  }
});

// POST /api/opportunities/:id/request-access - "Comment souhaitez-vous
// continuer ?" (prototype V17, section 3.5): exactly two choices, both of
// which create/update the CRM lead, but only 'slot' unlocks the buyer's
// identity - 'callback' (no particular time) never does, however many
// times it's used. No-op on a public-market opportunity, which has nothing
// to unlock.
router.post(
  '/:id/request-access',
  [
    body('email').trim().isEmail().withMessage("L'adresse e-mail n'est pas valide.").normalizeEmail(),
    body('phone').optional({ checkFalsy: true }).isString().trim(),
    body('firstName').optional({ checkFalsy: true }).isString().trim(),
    body('lastName').optional({ checkFalsy: true }).isString().trim(),
    body('companyName').optional({ checkFalsy: true }).isString().trim(),
    body('sessionId').optional({ checkFalsy: true }).isString().trim().isLength({ max: 100 }),
    body('mode').isIn(['slot', 'callback']).withMessage("Mode d'accès invalide."),
    body('slotLabel').if(body('mode').equals('slot')).isString().trim().isLength({ min: 1, max: 100 }).withMessage('Créneau invalide.'),
    body('slotAt').optional({ checkFalsy: true }).isISO8601(),
  ],
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      // Same fix as crmPublic.ts's lead form: this used to always send back
      // the literal string 'Validation failed' with no field-level detail,
      // so a rejected "request a callback" / "book a slot" submission gave
      // the visitor nothing to act on regardless of the actual cause.
      return res.status(400).json({ error: errors.array()[0].msg || 'Validation failed', details: errors.array() });
    }
    try {
      const oppResult = await db.query(
        `SELECT o.id, o.title, o.trade_id, o.location_city, o.location_region, ot.code as journey, b.id as brand_id
         FROM opportunities o
         LEFT JOIN opportunity_types ot ON o.opportunity_type_id = ot.id
         LEFT JOIN brands b ON ot.brand_id = b.id
         WHERE o.id = $1 AND o.deleted_at IS NULL`,
        [req.params.id]
      );
      if (oppResult.rows.length === 0) {
        return res.status(404).json({ error: 'Opportunity not found' });
      }
      const opp = oppResult.rows[0];
      if (opp.journey === 'public_procurement') {
        return res.json({ identityUnlocked: true });
      }

      const { firstName, lastName, email, phone, companyName, sessionId, mode, slotLabel, slotAt } = req.body;

      // A default brand is used when the opportunity's type isn't itself
      // brand-scoped (opportunity_types.brand_id can be NULL, meaning "all
      // brands") - crm_leads.brand_id is NOT NULL, same constraint the public
      // contact form already has to satisfy in routes/crmPublic.ts.
      let brandId = opp.brand_id;
      if (!brandId) {
        const brandResult = await db.query('SELECT id FROM brands ORDER BY created_at ASC LIMIT 1');
        brandId = brandResult.rows[0]?.id;
      }

      const existing = await db.query(
        `SELECT id FROM crm_leads WHERE opportunity_id = $1 AND LOWER(email) = LOWER($2) LIMIT 1`,
        [req.params.id, email]
      );

      const message = mode === 'slot' ? `Créneau choisi : ${slotLabel}` : 'Rappel demandé, sans créneau précis';
      let leadId: string;
      if (existing.rows.length > 0) {
        leadId = existing.rows[0].id;
        await db.query(
          `UPDATE crm_leads SET first_name = COALESCE($1, first_name), last_name = COALESCE($2, last_name),
             phone = COALESCE($3, phone), company_name = COALESCE($4, company_name),
             session_id = COALESCE(session_id, $5), appointment_mode = $6, appointment_slot_at = $7,
             message = $8, updated_at = NOW()
           WHERE id = $9`,
          [firstName, lastName, phone, companyName, sessionId || null, mode, mode === 'slot' ? slotAt || null : null, message, leadId]
        );
      } else {
        const insertResult = await db.query(
          `INSERT INTO crm_leads
            (brand_id, first_name, last_name, email, phone, company_name, lead_source, message,
             opportunity_id, session_id, appointment_mode, appointment_slot_at, crm_sync_status)
           VALUES ($1, $2, $3, $4, $5, $6, 'opportunity_detail_page', $7, $8, $9, $10, $11, 'pending')
           RETURNING id`,
          [brandId, firstName, lastName, email, phone, companyName, message, req.params.id, sessionId || null, mode, mode === 'slot' ? slotAt || null : null]
        );
        leadId = insertResult.rows[0].id;
        syncLeadToCrm(leadId).catch((err) => logger.error('Unexpected error firing CRM sync:', err));
      }

      res.status(201).json({ identityUnlocked: mode === 'slot', leadId });
    } catch (err: any) {
      logger.error('Opportunity access request error:', err);
      res.status(500).json({ error: 'Failed to submit — please try again' });
    }
  }
);

// GET /api/opportunities/:id/match-score - "Analyse stratégique" tab data.
// Personalizes against the logged-in user's company profile when available,
// otherwise returns the generic (non-personalized) breakdown.
// POST /api/opportunities/match-scores - lightweight bulk scores for a
// results list (prototype V17, section 3.1: a score badge on every card
// once the visitor's company is identified, never before). Reuses
// computeMatchScore per id rather than a separate calculation path, so a
// card's badge and the fiche's full "Analyse stratégique" tab can never
// disagree on the number. Capped at 30 ids - a results page, not a bulk
// export.
router.post(
  '/match-scores',
  [body('ids').isArray({ min: 1, max: 30 }), body('ids.*').isString()],
  optionalAuth,
  async (req: AuthRequest, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Validation failed', details: errors.array() });
    }
    try {
      let companyId: string | null = null;
      if (req.user?.email) {
        const userResult = await db.query('SELECT company_id FROM users WHERE email = $1 AND deleted_at IS NULL', [req.user.email]);
        companyId = userResult.rows[0]?.company_id || null;
      }
      if (!companyId) {
        const sessionId = req.body.sessionId as string;
        const siretResult = sessionId
          ? await db.query('SELECT 1 FROM siret_lookups WHERE session_id = $1', [sessionId])
          : { rows: [] };
        if (siretResult.rows.length === 0) {
          return res.status(403).json({ error: 'company_not_identified' });
        }
      }

      const scores: Record<string, { score: number; scoreTitle: string }> = {};
      for (const oppId of req.body.ids as string[]) {
        try {
          const result = await computeMatchScore(oppId, companyId);
          scores[oppId] = { score: result.score, scoreTitle: result.scoreTitle };
        } catch {
          // Skip an individual bad id rather than failing the whole batch -
          // a card just shows no badge if its score couldn't be computed.
        }
      }
      res.json({ scores });
    } catch (err: any) {
      logger.error('Bulk match score error:', err);
      res.status(500).json({ error: 'Failed to compute match scores' });
    }
  }
);

router.get('/:id/match-score', optionalAuth, async (req: AuthRequest, res: Response) => {
  try {
    // optionalAuth only decodes the JWT (userId/email) - it does not run the
    // DB lookups `authenticate` does, so req.company is never populated here.
    // Resolve the company from the token's email instead when present.
    let companyId: string | null = null;
    if (req.user?.email) {
      const userResult = await db.query('SELECT company_id FROM users WHERE email = $1 AND deleted_at IS NULL', [req.user.email]);
      companyId = userResult.rows[0]?.company_id || null;
    }

    // Prototype V17 rule: the score never displays before the visitor's
    // company is identified (via SIRET, or by being logged in) - not on
    // this fiche, not anywhere. A logged-in company always counts; an
    // anonymous visitor needs a completed SIRET lookup for this session.
    if (!companyId) {
      const sessionId = req.query.sessionId as string;
      const siretResult = sessionId
        ? await db.query('SELECT 1 FROM siret_lookups WHERE session_id = $1', [sessionId])
        : { rows: [] };
      if (siretResult.rows.length === 0) {
        return res.status(403).json({ error: 'company_not_identified', message: "Identifiez votre entreprise (SIRET) pour voir le score de compatibilité." });
      }
    }

    // Note: a SIRET-identified-but-not-yet-registered visitor still gets the
    // generic (non-personalized) breakdown below, same as before - fully
    // personalizing against the SIRET-derived profile (trade/location
    // inferred from the APE code, without an account) needs a deeper change
    // to computeMatchScore, which today only reads a real `companies` row.
    const result = await computeMatchScore(req.params.id, companyId);
    res.json(result);
  } catch (err: any) {
    logger.error('Match score error:', err);
    if (err.message === 'Opportunity not found') {
      return res.status(404).json({ error: 'Opportunity not found' });
    }
    res.status(500).json({ error: 'Failed to compute match score' });
  }
});

// POST /api/opportunities/:id/classify - trigger AI classification (Milestone 6)
router.post('/:id/classify', async (req: Request, res: Response) => {
  try {
    const success = await classifyOpportunity(req.params.id);
    if (!success) {
      return res.status(500).json({ error: 'Classification failed' });
    }
    res.json({ success: true });
  } catch (err: any) {
    logger.error('Manual classify error:', err);
    res.status(500).json({ error: 'Classification failed' });
  }
});

// POST /api/opportunities/:id/summarize - trigger AI summary (Milestone 7).
// Admin-only: this calls the LLM on demand and has no rate limiting of its
// own, so it stayed unauthenticated it'd be an open cost/DoS vector for
// anyone who found the URL.
router.post('/:id/summarize', authenticate, requireRole(['admin', 'super_admin']), async (req: Request, res: Response) => {
  try {
    const summary = await generateOpportunitySummary(req.params.id);
    res.json({ summary });
  } catch (err: any) {
    logger.error('Manual summarize error:', err);
    res.status(500).json({ error: 'Summary generation failed' });
  }
});

// POST /api/opportunities/:id/extract-facts - structured fact extraction with explicit
// "not available" on missing fields (technical POC test acceptance criteria).
// Admin-only for the same reason as /summarize above - also worth noting this
// can populate ai_extracted_facts.contact_email on a *locked* private tender,
// which is exactly why GET /:id redacts it via redactExtractedFacts() above.
router.post('/:id/extract-facts', authenticate, requireRole(['admin', 'super_admin']), async (req: Request, res: Response) => {
  try {
    const facts = await extractOpportunityFacts(req.params.id);
    res.json({ facts });
  } catch (err: any) {
    logger.error('Fact extraction error:', err);
    res.status(500).json({ error: 'Fact extraction failed' });
  }
});

export default router;
