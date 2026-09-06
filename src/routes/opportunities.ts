import { Router, Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
import { db } from '../config/database';
import { logger } from '../utils/logger';
import { classifyOpportunity, generateOpportunitySummary, extractOpportunityFacts } from '../services/aiService';
import { computeMatchScore } from '../services/matchScoreService';
import { syncLeadToCrm } from '../services/crmSyncService';
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

// GET /api/opportunities - search & filter listings (public, powers the 3 journeys)
router.get('/', optionalAuth, async (req: Request, res: Response) => {
  try {
    const {
      journey,       // 'tender' | 'public_procurement' | 'subcontracting'
      q,             // free text search
      trade_id,
      region,
      city,
      department,
      min_value,
      max_value,
      page = '1',
      limit = '20',
    } = req.query as Record<string, string>;

    // Reads from opportunity_search_index (refreshed every 15 min by
    // jobs/searchIndexRefresh.ts) instead of joining `opportunities` on every
    // request - the view pre-joins opportunity_types/trades and carries its
    // own GIN-indexed search_vector, which is what actually pays off at the
    // 1M-row scale Milestone 12's load test targets. Trade-off: listings can
    // be up to ~15 min stale here (new/updated rows won't appear until the
    // next refresh) - acceptable for a browse/search page, but do NOT reuse
    // this view for anything that needs the current row (e.g. the bid flow
    // reads `opportunities` directly for that reason, unchanged by this).
    // deleted_at/cancelled/expired/merged are already filtered by the view's
    // own WHERE clause (see schema.sql), so they don't need repeating here.
    const conditions: string[] = ['1=1'];
    const params: any[] = [];
    let idx = 1;

    // The view's own WHERE clause (schema.sql) excludes status IN
    // ('cancelled','expired','merged'), but nothing ever flips an
    // opportunity's status to 'expired' when its deadline actually passes -
    // there's no cron job for it. Without this, a listing with a
    // submission deadline in the past stays 'active' forever and keeps
    // showing up in search (worse: sorted to the very top, since results
    // are ORDER BY deadline ASC). Filtering here is an immediate, always-
    // correct fix regardless of whether a status-flipping job ever gets
    // built - deadline IS NULL is kept visible since a missing deadline
    // isn't the same as a passed one.
    conditions.push(`(osi.deadline IS NULL OR osi.deadline >= NOW())`);

    if (journey) {
      conditions.push(`osi.opportunity_type = $${idx++}`);
      params.push(journey);
    }
    if (q) {
      conditions.push(`osi.search_vector @@ plainto_tsquery('french', $${idx++})`);
      params.push(q);
    }
    if (trade_id) {
      conditions.push(`osi.trade_id = $${idx++}`);
      params.push(trade_id);
    }
    if (region) {
      conditions.push(`osi.location_region ILIKE $${idx++}`);
      params.push(`%${region}%`);
    }
    if (city) {
      conditions.push(`osi.location_city ILIKE $${idx++}`);
      params.push(`%${city}%`);
    }
    if (department) {
      conditions.push(`osi.location_department = $${idx++}`);
      params.push(department);
    }
    if (min_value) {
      conditions.push(`osi.estimated_value >= $${idx++}`);
      params.push(min_value);
    }
    if (max_value) {
      conditions.push(`osi.estimated_value <= $${idx++}`);
      params.push(max_value);
    }

    const pageNum = Math.max(parseInt(page) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit) || 20, 1), 100);
    const offset = (pageNum - 1) * limitNum;

    const whereClause = conditions.join(' AND ');

    const listResult = await db.query(
      `SELECT osi.id, osi.title, osi.description, osi.deadline, osi.publication_date,
              osi.estimated_value, osi.currency, osi.location_city, osi.location_region,
              osi.location_department, osi.estimated_start_date, osi.estimated_end_date,
              osi.ai_classification_status, osi.ai_summary, osi.ai_matched_trades, osi.status,
              osi.opportunity_type as journey, osi.trade_name, osi.buyer_name
       FROM opportunity_search_index osi
       WHERE ${whereClause}
       ORDER BY osi.deadline ASC NULLS LAST
       LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, limitNum, offset]
    );

    const countResult = await db.query(
      `SELECT COUNT(*) as total
       FROM opportunity_search_index osi
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
// "still open" definition the main search route uses (deadline not
// passed; the view's own WHERE already drops cancelled/expired/merged),
// so this can never disagree with what clicking through to a category
// actually shows.
router.get('/stats/counts', async (req: Request, res: Response) => {
  try {
    const result = await db.query(
      `SELECT opportunity_type AS journey, COUNT(*)::int AS count
       FROM opportunity_search_index
       WHERE (deadline IS NULL OR deadline >= NOW())
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
router.get('/stats/regions', async (req: Request, res: Response) => {
  try {
    const result = await db.query(
      `SELECT location_region AS region, COUNT(*)::int AS count
       FROM opportunities
       WHERE location_region IS NOT NULL AND location_region != ''
         AND status != 'archived'
       GROUP BY location_region
       ORDER BY count DESC`
    );
    res.json({ regions: result.rows });
  } catch (err: any) {
    logger.error('Region stats error:', err);
    res.status(500).json({ error: 'Failed to load region stats' });
  }
});

// GET /api/opportunities/stats/departments - same, grouped by French
// department (numeric code, e.g. "33" for Gironde).
router.get('/stats/departments', async (req: Request, res: Response) => {
  try {
    const result = await db.query(
      `SELECT location_department AS department, COUNT(*)::int AS count
       FROM opportunities
       WHERE location_department IS NOT NULL AND location_department != ''
         AND status != 'archived'
       GROUP BY location_department
       ORDER BY count DESC`
    );
    res.json({ departments: result.rows });
  } catch (err: any) {
    logger.error('Department stats error:', err);
    res.status(500).json({ error: 'Failed to load department stats' });
  }
});

// GET /api/opportunities/stats/near?lat=&lng=&radius_km= - count within a
// radius of a point, for the "Villes" (city) tab. Uses the Haversine formula
// directly in SQL since PostGIS isn't set up on this database.
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
         AND status != 'archived'
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
    opportunity.ai_extracted_facts = await ensureFactsExtracted(opportunity.id, opportunity.ai_extracted_facts);

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
