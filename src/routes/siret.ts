import { Router, Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
import axios from 'axios';
import { db } from '../config/database';
import { logger } from '../utils/logger';
import { syncLeadToCrm } from '../services/crmSyncService';

const router = Router();

const APE_LABELS: Record<string, string> = {
  '4120A': 'Construction de maisons individuelles',
  '4120B': "Construction d'autres bâtiments",
  '4211Z': 'Construction de routes et autoroutes',
  '4321A': "Travaux d'installation électrique",
  '4322A': 'Travaux de plomberie',
  '4331Z': 'Travaux de plâtrerie',
  '4332A': 'Travaux de menuiserie bois et PVC',
  '4334Z': 'Travaux de peinture et vitrerie',
  '4391A': 'Travaux de charpente',
  '4399C': 'Travaux de maçonnerie générale',
};

interface CompanyData {
  name: string | null;
  legal: string | null;
  created: string | null;
  capital: string | null;
  address: string | null;
  city: string | null;
  postal: string | null;
  director: string | null;
  employees: string | null;
  ape: string | null;
  activity: string | null;
  website: string | null;
  // "Présence détectée" (prototype V17, section 3.3.3) - Pappers has no
  // Facebook page or Google rating data (it's a legal/financial registry,
  // not a search/SERP source), so those two stay null here regardless of
  // source. Flagged as an open point below rather than fabricated.
  facebook: string | null;
  googleRating: string | null;
  googleReviewCount: number | null;
  // "Présence détectée" also asks for an RGE checkmark - Pappers exposes
  // this (and other labels like ORIAS, "Société à mission") via
  // champs_supplementaires=labels, which INSEE Sirene has no equivalent
  // for at all.
  certifications: string[];
  source: 'pappers' | 'insee' | 'demo';
}

// Fixed demo SIRET so the whole SIRET-recognition -> score -> lead flow is
// testable end-to-end with zero external API keys configured (no
// PAPPERS_API_KEY, no INSEE_API_KEY) - matches the client's own reference
// screenshots (KB Electricite / Karim Benali) exactly, paired with the
// DEMO-PUB-4 Bordeaux electricite listing seed.js inserts fully pre-
// analyzed. Works even when both keys ARE configured (checked first), so a
// developer testing locally never needs real credentials just to see the
// full journey once - short-circuits before the "not configured" 501 below.
const DEMO_SIRET = '12345678900012';
const DEMO_COMPANY: CompanyData = {
  name: 'KB Électricité',
  legal: 'SASU',
  created: '14 mars 2018',
  capital: '25 000 €',
  address: '12 avenue des Artisans',
  city: 'Bordeaux',
  postal: '33000',
  director: 'Karim Benali',
  employees: '6 à 9 salariés',
  ape: '4321A',
  activity: "Travaux d'installation électrique",
  website: 'kbelectricite.fr',
  facebook: 'KB Électricité Bordeaux',
  googleRating: '4.7',
  googleReviewCount: 32,
  certifications: ['RGE'],
  source: 'demo',
};

// Client's explicit instruction (WhatsApp, 31 Aug): use Pappers as the
// primary source for SIRET auto-fill, since it covers capital/dirigeant/
// certifications that INSEE Sirene doesn't - Societe.com as a fallback if
// Pappers doesn't have the company. Note: Societe.com has no official public
// API (unlike Pappers/INSEE, which are documented REST APIs with API keys) -
// scraping it would be fragile and is not implemented here; flagged as an
// open point rather than built as something unreliable. INSEE Sirene is kept
// as the fallback instead, since it's already wired, free, and official.
async function lookupViaPappers(siret: string, apiKey: string): Promise<CompanyData | null> {
  const { data } = await axios.get('https://api.pappers.fr/v2/entreprise', {
    params: { api_token: apiKey, siret, champs_supplementaires: 'labels' },
    timeout: 8000,
  });

  const siege = data.siege || {};
  const dirigeant = (data.representants || [])[0] || (data.dirigeants || [])[0] || {};
  const directorName = [dirigeant.prenom, dirigeant.nom].filter(Boolean).join(' ') || dirigeant.nom_complet || null;
  const labels: string[] = Array.isArray(data.labels) ? data.labels.map((l: any) => l.label || l.nom || l).filter(Boolean) : [];

  return {
    name: data.nom_entreprise || data.denomination || null,
    legal: data.forme_juridique || null,
    created: data.date_creation || null,
    capital: data.capital != null ? `${data.capital} ${data.devise_capital || 'EUR'}` : null,
    address: siege.adresse_ligne_1 || null,
    city: siege.ville || null,
    postal: siege.code_postal || null,
    director: directorName,
    employees: data.effectif || data.tranche_effectif || null,
    ape: data.code_naf || null,
    activity: data.libelle_code_naf || (data.code_naf ? APE_LABELS[data.code_naf] || null : null),
    website: data.site_web || null,
    facebook: null,
    googleRating: null,
    googleReviewCount: null,
    certifications: labels,
    source: 'pappers',
  };
}

async function lookupViaInsee(siret: string, apiKey: string): Promise<CompanyData> {
  const { data } = await axios.get(`https://api.insee.fr/entreprises/sirene/V3.11/siret/${siret}`, {
    headers: { 'X-INSEE-Api-Key-Integration': apiKey, Accept: 'application/json' },
    timeout: 8000,
  });
  const etab = data.etablissement;
  const unite = etab?.uniteLegale || {};
  const adresse = etab?.adresseEtablissement || {};
  const apeCode = unite.activitePrincipaleUniteLegale || null;

  return {
    name: unite.denominationUniteLegale || unite.denominationUsuelle1UniteLegale
      || [unite.prenom1UniteLegale, unite.nomUniteLegale].filter(Boolean).join(' ') || null,
    legal: unite.categorieJuridiqueUniteLegale || null,
    created: unite.dateCreationUniteLegale || etab?.dateCreationEtablissement || null,
    // Not available from the /siret unit response (would need a separate
    // /siren call for the légale unit's financials) - this is exactly the
    // gap Pappers covers, which is why it's tried first.
    capital: null,
    address: [adresse.numeroVoieEtablissement, adresse.typeVoieEtablissement, adresse.libelleVoieEtablissement]
      .filter(Boolean).join(' ') || null,
    city: adresse.libelleCommuneEtablissement || null,
    postal: adresse.codePostalEtablissement || null,
    director: null, // needs INPI/RNE, not available from Sirene
    employees: unite.trancheEffectifsUniteLegale || null,
    ape: apeCode,
    activity: apeCode ? (APE_LABELS[apeCode] || null) : null,
    website: null,
    facebook: null,
    googleRating: null,
    googleReviewCount: null,
    certifications: [],
    source: 'insee',
  };
}

// Resolves a free-text company name to a SIRET via Pappers' search endpoint
// (client's ask: let the user type "SIRET ou entreprise" - either works).
// Returns the first/best match's headquarters SIRET, or null if nothing
// matched - callers should surface that as a normal "not found", not an
// error, same as an unrecognized SIRET number.
async function resolveCompanyNameToSiret(name: string, apiKey: string): Promise<string | null> {
  const { data } = await axios.get('https://api.pappers.fr/v2/recherche', {
    params: { api_token: apiKey, q: name, par_page: 1 },
    timeout: 8000,
  });
  const first = (data.resultats || [])[0];
  return first?.siege?.siret || first?.siret || null;
}


// flag per browser session (prototype V17, section 2.3), not per-opportunity:
// once identified on any fiche, a visitor is recognized everywhere without
// re-entering their SIRET. This is what the frontend calls on load to
// restore that state.
router.get('/status', async (req: Request, res: Response) => {
  try {
    const sessionId = req.query.sessionId as string;
    if (!sessionId) return res.json({ companyKnown: false, leadCaptured: false });
    const result = await db.query(
      'SELECT siret, company_data, phone, email, lead_captured_at FROM siret_lookups WHERE session_id = $1',
      [sessionId]
    );
    if (result.rows.length === 0) return res.json({ companyKnown: false, leadCaptured: false });
    const row = result.rows[0];
    res.json({
      companyKnown: true,
      siret: row.siret,
      company: row.company_data,
      leadCaptured: !!row.lead_captured_at,
      phone: row.phone || null,
      email: row.email || null,
    });
  } catch (err: any) {
    logger.error('SIRET status error:', err);
    res.status(500).json({ error: 'Failed to check status' });
  }
});

// POST /api/siret/lead - client's newest brief: phone + email are requested
// once the visitor has already seen value (score + why-it-matches), and
// gate the fuller breakdown (criteria weighting, eligibility checklist,
// "Affinez votre analyse") - global per session once given, per prototype
// V17's `lead` state (section 2.3), never re-asked on another opportunity.
// Requires the company to already be SIRET-identified (this session must
// have a siret_lookups row) - the lead gate only ever follows recognition,
// never replaces it.
// Also creates/updates a crm_leads row tied to the specific opportunity
// being viewed, per the client's explicit ask ("les coordonnées doivent
// être rattachées à l'entreprise et à l'opportunité consultée afin que le
// chargé d'affaires sache exactement pourquoi rappeler le prospect") -
// reuses the same brand-resolution pattern as POST /opportunities/:id/request-access.
router.post(
  '/lead',
  [
    body('sessionId').isString().trim().isLength({ min: 8, max: 100 }),
    body('phone').matches(/^\d{10}$/).withMessage('Le téléphone doit contenir 10 chiffres.'),
    body('email').isEmail().withMessage("L'e-mail n'est pas valide.").normalizeEmail(),
    body('opportunityId').optional({ checkFalsy: true }).isUUID(),
  ],
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }

    const { sessionId, phone, email, opportunityId } = req.body;

    const existing = await db.query('SELECT id, company_data FROM siret_lookups WHERE session_id = $1', [sessionId]);
    if (existing.rows.length === 0) {
      return res.status(409).json({ error: 'company_not_identified', message: "Identifiez d'abord votre entreprise." });
    }

    await db.query(
      `UPDATE siret_lookups SET phone = $1, email = $2, lead_captured_at = NOW() WHERE session_id = $3`,
      [phone, email, sessionId]
    );

    if (opportunityId) {
      try {
        const companyName = existing.rows[0].company_data?.name || null;
        const oppResult = await db.query(
          `SELECT o.id, ot.brand_id FROM opportunities o
           LEFT JOIN opportunity_types ot ON o.opportunity_type_id = ot.id
           WHERE o.id = $1 AND o.deleted_at IS NULL`,
          [opportunityId]
        );
        if (oppResult.rows.length > 0) {
          let brandId = oppResult.rows[0].brand_id;
          if (!brandId) {
            const brandResult = await db.query('SELECT id FROM brands ORDER BY created_at ASC LIMIT 1');
            brandId = brandResult.rows[0]?.id;
          }
          const dup = await db.query(
            `SELECT id FROM crm_leads WHERE opportunity_id = $1 AND LOWER(email) = LOWER($2) LIMIT 1`,
            [opportunityId, email]
          );
          if (dup.rows.length === 0 && brandId) {
            const insertResult = await db.query(
              `INSERT INTO crm_leads
                (brand_id, email, phone, company_name, lead_source, opportunity_id, session_id, crm_sync_status)
               VALUES ($1, $2, $3, $4, 'analysis_gate', $5, $6, 'pending')
               RETURNING id`,
              [brandId, email, phone, companyName, opportunityId, sessionId]
            );
            syncLeadToCrm(insertResult.rows[0].id).catch((err) => logger.error('Unexpected error firing CRM sync:', err));
          }
        }
      } catch (err) {
        // Non-fatal: the session-level lead gate above already succeeded -
        // a CRM sync hiccup shouldn't block the visitor from proceeding.
        logger.error('Lead-capture CRM linking error (non-fatal):', err);
      }
    }

    res.json({ leadCaptured: true });
  }
);

// POST /api/siret/lookup - "reconnaissance d'entreprise" (prototype V17,
// section 3.3). Accepts either a 14-digit SIRET or a free-text company name
// (client's ask: label the field "SIRET ou entreprise" so either works) -
// a name is resolved to a SIRET via Pappers' search endpoint first, then
// follows the exact same Pappers-primary/INSEE-fallback lookup as before.
// Caches whichever result against the visitor's session so it's recognized
// on every fiche from then on.
router.post(
  '/lookup',
  [
    body('query').isString().trim().isLength({ min: 2, max: 200 }).withMessage("Indiquez un SIRET (14 chiffres) ou le nom de l'entreprise."),
    body('sessionId').isString().trim().isLength({ min: 8, max: 100 }),
  ],
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }

    const { sessionId } = req.body;
    const query: string = req.body.query;

    // Demo shortcut - checked before the key-configured gate, and before
    // treating the query as a name-search, so it works identically whether
    // or not PAPPERS_API_KEY/INSEE_API_KEY are set.
    if (query.trim() === DEMO_SIRET) {
      await db.query(
        `INSERT INTO siret_lookups (session_id, siret, company_data)
         VALUES ($1, $2, $3)
         ON CONFLICT (session_id) DO UPDATE SET siret = $2, company_data = $3, created_at = NOW()`,
        [sessionId, DEMO_SIRET, JSON.stringify(DEMO_COMPANY)]
      );
      return res.json({ companyKnown: true, siret: DEMO_SIRET, company: DEMO_COMPANY });
    }

    const pappersKey = process.env.PAPPERS_API_KEY;
    const inseeKey = process.env.INSEE_API_KEY;
    if (!pappersKey && !inseeKey) {
      return res.status(501).json({
        error: 'company_lookup_not_configured',
        message: "La reconnaissance d'entreprise n'est pas encore configurée.",
      });
    }

    let siret: string;

    if (/^\d{14}$/.test(query)) {
      siret = query;
    } else {
      // Not a SIRET - treat as a company name. Needs Pappers specifically
      // (INSEE Sirene's own free-text search is a separate, differently-
      // shaped endpoint not wired here yet - name search is Pappers-only
      // for now, SIRET number entry still works either way).
      if (!pappersKey) {
        return res.status(400).json({
          error: 'name_search_not_configured',
          message: "La recherche par nom d'entreprise n'est pas disponible pour le moment. Indiquez le numéro de SIRET (14 chiffres).",
        });
      }
      let resolved: string | null = null;
      try {
        resolved = await resolveCompanyNameToSiret(query, pappersKey);
      } catch (err: any) {
        logger.error('Pappers company-name search error:', err.response?.data || err.message);
        return res.status(502).json({ error: 'siret_lookup_failed', message: 'La recherche a échoué. Réessayez.' });
      }
      if (!resolved) {
        return res.status(404).json({ error: 'siret_not_found', message: "Aucune entreprise trouvée pour ce nom. Essayez avec le numéro de SIRET." });
      }
      siret = resolved;
    }

    let company: CompanyData | null = null;
    let lastError: any = null;

    if (pappersKey) {
      try {
        company = await lookupViaPappers(siret, pappersKey);
      } catch (err: any) {
        lastError = err;
        if (err.response?.status === 404) {
          logger.info(`Pappers lookup: SIRET ${siret} not found, falling back to INSEE if configured`);
        } else {
          logger.error('Pappers lookup error:', err.response?.data || err.message);
        }
      }
    }

    if (!company && inseeKey) {
      try {
        company = await lookupViaInsee(siret, inseeKey);
      } catch (err: any) {
        lastError = err;
        if (err.response?.status !== 404) {
          logger.error('INSEE lookup error:', err.response?.data || err.message);
        }
      }
    }

    if (!company) {
      if (lastError?.response?.status === 404) {
        return res.status(404).json({ error: 'siret_not_found', message: 'Aucune entreprise trouvée pour ce SIRET.' });
      }
      return res.status(502).json({ error: 'siret_lookup_failed', message: "La vérification du SIRET a échoué. Réessayez." });
    }

    await db.query(
      `INSERT INTO siret_lookups (session_id, siret, company_data)
       VALUES ($1, $2, $3)
       ON CONFLICT (session_id) DO UPDATE SET siret = $2, company_data = $3, created_at = NOW()`,
      [sessionId, siret, JSON.stringify(company)]
    );

    res.json({ companyKnown: true, siret, company });
  }
);

export default router;
