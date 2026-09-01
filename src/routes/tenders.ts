import { Router, Response } from 'express';
import { db } from '../config/database';
import { logger } from '../utils/logger';
import { AuthRequest, requireActiveSubscription } from '../middleware/auth';
import { generateBidPackageZip, uploadToS3IfConfigured } from '../services/documentService';
import { analyzeTenderDocuments, generateTechnicalMemo } from '../services/aiService';
import { buildUnifiedDocumentChecklist } from '../utils/documentMatching';

const router = Router();

// POST /api/tenders/:tenderId/analyze - run DCE analysis (selection criteria, required
// documents, scoring weights, complexity) via AI - Milestone 6.1. Not company-scoped:
// a tender's DCE analysis is shared across every company bidding on it.
router.post('/:tenderId/analyze', requireActiveSubscription, async (req: AuthRequest, res: Response) => {
  try {
    const tenderResult = await db.query('SELECT id FROM tenders WHERE id = $1', [req.params.tenderId]);
    if (tenderResult.rows.length === 0) {
      return res.status(404).json({ error: 'Tender not found' });
    }

    const success = await analyzeTenderDocuments(req.params.tenderId);
    const updated = await db.query('SELECT * FROM tenders WHERE id = $1', [req.params.tenderId]);

    if (!success) {
      return res.status(502).json({
        error: 'DCE analysis failed - see tender.dce_analysis_status',
        tender: updated.rows[0],
      });
    }

    res.json(updated.rows[0]);
  } catch (err: any) {
    logger.error('DCE analysis route error:', err);
    res.status(500).json({ error: 'Failed to analyze tender documents' });
  }
});

// GET /api/tenders/bids/mine - list all bid responses for the logged-in company
router.get('/bids/mine', async (req: AuthRequest, res: Response) => {
  try {
    const { status } = req.query as Record<string, string>;
    const conditions = ['br.company_id = $1'];
    const params: any[] = [req.user!.companyId];

    if (status) {
      conditions.push('br.status = $2');
      params.push(status);
    }

    const result = await db.query(
      `SELECT br.id, br.status, br.submission_deadline, br.submitted_at, br.total_bid_amount,
              o.id as opportunity_id, o.title, o.deadline, o.location_city
       FROM bid_responses br
       JOIN tenders t ON br.tender_id = t.id
       JOIN opportunities o ON t.opportunity_id = o.id
       WHERE ${conditions.join(' AND ')}
       ORDER BY br.updated_at DESC`,
      params
    );

    res.json(result.rows);
  } catch (err: any) {
    logger.error('My bids list error:', err);
    res.status(500).json({ error: 'Failed to fetch bid responses' });
  }
});

// GET /api/tenders/:opportunityId/documents - list DCE attachments ingested for this
// opportunity (see documentIngestionService.ts). Never returns extracted_text in full -
// just enough for the UI to show what was actually found and its status honestly.
router.get('/:opportunityId/documents', async (req: AuthRequest, res: Response) => {
  try {
    const result = await db.query(
      `SELECT id, document_label, source_url, status, mime_type, file_size_bytes,
              (extracted_text IS NOT NULL AND extracted_text != '') as has_extracted_text,
              error_message, created_at
       FROM tender_documents
       WHERE opportunity_id = $1
       ORDER BY created_at ASC`,
      [req.params.opportunityId]
    );

    const oppResult = await db.query('SELECT dce_documents_status FROM opportunities WHERE id = $1', [
      req.params.opportunityId,
    ]);

    res.json({
      dce_documents_status: oppResult.rows[0]?.dce_documents_status || 'pending',
      documents: result.rows,
    });
  } catch (err: any) {
    logger.error('Tender documents list error:', err);
    res.status(500).json({ error: 'Failed to fetch tender documents' });
  }
});

// GET /api/tenders/:opportunityId - fetch or lazily create tender record for an opportunity
router.get('/:opportunityId', async (req: AuthRequest, res: Response) => {
  try {
    let result = await db.query('SELECT * FROM tenders WHERE opportunity_id = $1', [
      req.params.opportunityId,
    ]);

    if (result.rows.length === 0) {
      result = await db.query(
        `INSERT INTO tenders (opportunity_id, dce_analysis_status) VALUES ($1, 'not_analyzed') RETURNING *`,
        [req.params.opportunityId]
      );
    }

    res.json(result.rows[0]);
  } catch (err: any) {
    logger.error('Tender fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch tender' });
  }
});

// GET /api/tenders/:tenderId/bid - fetch this company's bid response for a tender (auto-create draft)
router.get('/:tenderId/bid', async (req: AuthRequest, res: Response) => {
  try {
    let result = await db.query(
      'SELECT * FROM bid_responses WHERE tender_id = $1 AND company_id = $2',
      [req.params.tenderId, req.user!.companyId]
    );

    if (result.rows.length === 0) {
      // submission_deadline is sourced from the opportunity's own deadline at
      // creation time - it was never being set here, which meant
      // GET /api/dashboard/today's "upcoming deadlines" widget always came back
      // empty (it filters on this column) even for bids due imminently.
      result = await db.query(
        `INSERT INTO bid_responses (tender_id, company_id, status, submission_deadline)
         SELECT $1, $2, 'draft', o.deadline
         FROM tenders t JOIN opportunities o ON t.opportunity_id = o.id
         WHERE t.id = $1
         RETURNING *`,
        [req.params.tenderId, req.user!.companyId]
      );
    }

    res.json(result.rows[0]);
  } catch (err: any) {
    logger.error('Bid fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch bid response' });
  }
});

// PUT /api/tenders/bid/:bidId - update bid response (pricing, engagement act, memo edits)
// PUT /api/tenders/bid/:bidId - save/validate the candidature workspace
// (mémoire technique, pricing schedule, engagement act, submission status).
// Gated behind an active subscription like the rest of the candidature
// flow ("Analyse du DCE et candidature : réservées à l'offre payante" is
// shown everywhere else in the app) - this was the one write path that
// wasn't actually checked: a free/trial company could type its own memo
// text into this endpoint directly (bypassing the gated AI-generate step
// entirely) and then successfully download the finished ZIP package, since
// GET /bid/:bidId/package only checks whether technical_memo_text is
// non-null, not how it got there.
router.put('/bid/:bidId', requireActiveSubscription, async (req: AuthRequest, res: Response) => {
  try {
    const fields = [
      'technical_memo_text', 'is_technical_memo_approved', 'engagement_act_text',
      'is_engagement_act_signed', 'pricing_schedule_json', 'total_bid_amount',
      'submission_deadline', 'status',
    ];

    const updates: string[] = [];
    const params: any[] = [];
    let idx = 1;

    for (const field of fields) {
      if (req.body[field] !== undefined) {
        updates.push(`${field} = $${idx++}`);
        params.push(
          field === 'pricing_schedule_json' ? JSON.stringify(req.body[field]) : req.body[field]
        );
      }
    }

    // submitted_at was never set anywhere - a client marking status
    // 'submitted' had no way to also set this column (it wasn't in the
    // updatable field list, and shouldn't be client-supplied anyway since
    // that's trivially spoofable). Stamp it server-side the moment status
    // actually transitions to 'submitted'.
    if (req.body.status === 'submitted') {
      updates.push(`submitted_at = NOW()`);
    }

    // Any direct edit to the pricing schedule through this endpoint means the
    // company has taken over from the profile-catalog pre-fill - mark it
    // 'manual' so a later POST /bid/:bidId/generate (e.g. after re-running
    // the technical memo) never silently clobbers their edits back to catalog
    // defaults. See /bid/:bidId/generate for the pre-fill side of this.
    if (req.body.pricing_schedule_json !== undefined) {
      updates.push(`pricing_schedule_source = $${idx++}`);
      params.push('manual');
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    params.push(req.params.bidId, req.user!.companyId);
    const result = await db.query(
      `UPDATE bid_responses SET ${updates.join(', ')}, updated_at = NOW()
       WHERE id = $${idx++} AND company_id = $${idx}
       RETURNING *`,
      params
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Bid response not found' });
    }

    res.json(result.rows[0]);
  } catch (err: any) {
    logger.error('Bid update error:', err);
    res.status(500).json({ error: 'Failed to update bid response' });
  }
});

// POST /api/tenders/bid/:bidId/generate - populate the bid's generated documents
// (technical memo, engagement act) from the company's own profile data, and flag
// any mandatory documents missing from that profile.
//
// The technical memo is delegated to aiService.generateTechnicalMemo(), which
// produces the full 6-section memo the Technical Requirements (section 6.4) ask
// for (company presentation, resources, methodology, schedule, references,
// QSE measures) - grounded only in real company_resources/company_references/
// company_policies data, with a deterministic no-AI fallback if the Claude API
// call fails, so this endpoint never hard-fails on an AI outage.
router.post('/bid/:bidId/generate', requireActiveSubscription, async (req: AuthRequest, res: Response) => {
  try {
    const bidResult = await db.query(
      `SELECT br.*, t.opportunity_id, t.required_documents as tender_required_documents, o.title as opportunity_title
       FROM bid_responses br
       JOIN tenders t ON br.tender_id = t.id
       JOIN opportunities o ON t.opportunity_id = o.id
       WHERE br.id = $1 AND br.company_id = $2`,
      [req.params.bidId, req.user!.companyId]
    );

    if (bidResult.rows.length === 0) {
      return res.status(404).json({ error: 'Bid response not found' });
    }
    const bid = bidResult.rows[0];

    const [companyResult, documentsResult, existingBidResult, pricingCatalogResult] = await Promise.all([
      db.query('SELECT * FROM companies WHERE id = $1', [req.user!.companyId]),
      db.query(
        `SELECT document_type FROM company_documents
         WHERE company_id = $1 AND deleted_at IS NULL AND (expiry_date IS NULL OR expiry_date > CURRENT_DATE)`,
        [req.user!.companyId]
      ),
      db.query('SELECT pricing_schedule_json, pricing_schedule_source FROM bid_responses WHERE id = $1', [
        req.params.bidId,
      ]),
      db.query(
        `SELECT label, category, unit, default_unit_price FROM company_pricing_items
         WHERE company_id = $1 AND is_active = true ORDER BY category, label`,
        [req.user!.companyId]
      ),
    ]);

    const company = companyResult.rows[0];
    const availableDocTypes = documentsResult.rows.map((d) => d.document_type);

    // Required documents for a standard French public tender response, merged
    // with the DCE analysis's per-tender, buyer-worded list (tender.required_documents)
    // via documentMatching.ts's deterministic keyword rules. Anything that doesn't
    // confidently match an internal type is kept as 'needs_manual_review' rather
    // than guessed - see documentMatching.ts for why.
    const requiredDocTypes = ['kbis', 'insurance', 'dc1', 'dc2', 'dume', 'attestation_fiscale', 'attestation_sociale'];
    const tenderSpecificRequiredDocuments: string[] = bid.tender_required_documents || [];
    const documentChecklist = buildUnifiedDocumentChecklist(
      tenderSpecificRequiredDocuments,
      requiredDocTypes,
      availableDocTypes
    );
    // Kept for backward compatibility with anything still reading the old
    // internal-codes-only shape (e.g. dashboard widgets built against it).
    const missingDocuments = requiredDocTypes.filter((d) => !availableDocTypes.includes(d));
    // What actually gets printed in the downloadable bid package (see
    // documentService.ts) - the merged, human-readable checklist, so a
    // tender-specific requirement the DCE caught (even one with no internal
    // type match) shows up in the pack instead of only the 7 generic codes.
    const missingDocumentsForPackage = documentChecklist
      .filter((item) => item.status !== 'present')
      .map((item) =>
        item.status === 'needs_manual_review'
          ? `${item.requirement} (a verifier manuellement - non reconnu automatiquement)`
          : item.requirement
      );

    // Engagement act stays a direct template fill (per spec 6.3 this is a
    // pre-filled form the company reviews/signs, not AI-drafted prose) - but it
    // does need the contract's purpose, which the earlier inline version omitted.
    const engagementActText = `ACTE D'ENGAGEMENT\n\nRaison sociale: ${company.name}\nForme juridique: ${company.legal_form || 'non renseignee'}\nSIRET: ${company.siret || 'non renseigne'}\nAdresse: ${company.address_street || ''}, ${company.address_city || ''}\n\nObjet du marche: ${bid.opportunity_title}\n\nLe soussigne s'engage sur la base de son offre a executer les prestations dans les conditions definies au present acte d'engagement. Montant et conditions a verifier et confirmer par l'entreprise avant signature.`;

    const memoResult = await generateTechnicalMemo(req.params.bidId);

    // Pre-fill the pricing schedule from the company's reusable catalog only
    // the first time this bid is generated (or if it was never customized) -
    // once the company has edited it ('manual'), regenerating the technical
    // memo/checklist must never silently overwrite their pricing work. This
    // is the actual "adjust only what's specific to the new tender" behavior
    // the profile-reuse requirement (section 6.7) asks for: quantities start
    // blank (per-tender), unit prices start from the company's own defaults.
    const existingBid = existingBidResult.rows[0];
    const alreadyCustomized = existingBid?.pricing_schedule_source === 'manual';
    let pricingScheduleJson = existingBid?.pricing_schedule_json;
    let pricingScheduleSource = existingBid?.pricing_schedule_source;

    if (!alreadyCustomized) {
      if (pricingCatalogResult.rows.length > 0) {
        pricingScheduleJson = pricingCatalogResult.rows.map((item) => ({
          label: item.label,
          category: item.category,
          unit: item.unit,
          unit_price: item.default_unit_price !== null ? Number(item.default_unit_price) : undefined,
          quantity: undefined, // always tender-specific - never carried over from the catalog
        }));
        pricingScheduleSource = 'profile_catalog';
      } else if (!pricingScheduleJson) {
        pricingScheduleJson = [];
      }
    }

    await db.query(
      `UPDATE bid_responses SET
         engagement_act_text = $1,
         missing_documents = $2,
         pricing_schedule_json = $3,
         pricing_schedule_source = $4,
         status = 'in_progress',
         updated_at = NOW()
       WHERE id = $5`,
      [
        engagementActText,
        JSON.stringify(missingDocumentsForPackage),
        JSON.stringify(pricingScheduleJson),
        pricingScheduleSource,
        req.params.bidId,
      ]
    );

    const result = await db.query('SELECT * FROM bid_responses WHERE id = $1', [req.params.bidId]);
    const needsManualReviewCount = documentChecklist.filter((i) => i.status === 'needs_manual_review').length;

    res.json({
      bid: result.rows[0],
      technicalMemoAiGenerated: memoResult.aiGenerated,
      documentChecklist,
      // Kept alongside documentChecklist for any existing frontend code built
      // against the old two-list shape - documentChecklist is the merged,
      // authoritative view and should be preferred for new UI.
      missingDocuments,
      tenderSpecificRequiredDocuments,
      note: missingDocumentsForPackage.length === 0
        ? 'Tous les documents obligatoires sont presents dans le profil entreprise.'
        : needsManualReviewCount > 0
          ? `Certains documents manquent ou n'ont pas pu etre reconnus automatiquement (${needsManualReviewCount} a verifier manuellement).`
          : 'Certains documents obligatoires manquent dans le profil entreprise et doivent etre ajoutes avant soumission.',
    });
  } catch (err: any) {
    logger.error('Bid document generation error:', err);
    res.status(500).json({ error: 'Failed to generate bid documents' });
  }
});

// GET /api/tenders/bid/:bidId/package - generate the real downloadable bid package
// (technical memo, engagement act, pricing schedule, DC1/DC2/DUME summary) as a ZIP.
// This is the actual acceptance proof for Milestone 9 - text fields alone don't count.
router.get('/bid/:bidId/package', async (req: AuthRequest, res: Response) => {
  try {
    const bidResult = await db.query(
      `SELECT br.*, o.title as opportunity_title, o.source_reference,
              COALESCE(o.raw_data->>'nomacheteur', o.raw_data->>'acheteur', o.location_city) as buyer_name
       FROM bid_responses br
       JOIN tenders t ON br.tender_id = t.id
       JOIN opportunities o ON t.opportunity_id = o.id
       WHERE br.id = $1 AND br.company_id = $2`,
      [req.params.bidId, req.user!.companyId]
    );

    if (bidResult.rows.length === 0) {
      return res.status(404).json({ error: 'Bid response not found' });
    }

    const bid = bidResult.rows[0];

    if (!bid.technical_memo_text || !bid.engagement_act_text) {
      return res.status(400).json({
        error: 'Documents not generated yet - call POST /bid/:bidId/generate first',
      });
    }

    const [companyResult, referencesResult] = await Promise.all([
      db.query(
        `SELECT name, legal_form, siret, address_street, address_city, address_postal_code,
                email, phone, employee_count, annual_revenue, founding_year
         FROM companies WHERE id = $1`,
        [req.user!.companyId]
      ),
      db.query(
        `SELECT project_name, client_name, contract_value, completion_date
         FROM company_references WHERE company_id = $1 ORDER BY completion_date DESC LIMIT 5`,
        [req.user!.companyId]
      ),
    ]);

    const company = companyResult.rows[0];
    if (!company) {
      return res.status(400).json({ error: 'Company profile not found - complete your profile first' });
    }

    const zip = await generateBidPackageZip({
      company,
      buyer: {
        name: bid.buyer_name,
        reference: bid.source_reference,
        title: bid.opportunity_title,
        lotDescription: null,
      },
      references: referencesResult.rows,
      technicalMemoText: bid.technical_memo_text,
      engagementActText: bid.engagement_act_text,
      pricingSchedule: bid.pricing_schedule_json || [],
      missingDocuments: bid.missing_documents || [],
    });

    const key = `bid-packages/${req.user!.companyId}/${bid.id}.zip`;
    const s3Url = await uploadToS3IfConfigured(key, zip, 'application/zip');

    if (s3Url) {
      return res.json({ url: s3Url });
    }

    // No S3 configured (e.g. local dev) - stream the ZIP straight to the client instead.
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="dossier-candidature-${bid.id}.zip"`);
    res.send(zip);
  } catch (err: any) {
    logger.error('Bid package generation error:', err);
    res.status(500).json({ error: 'Failed to generate bid package' });
  }
});

export default router;
