import { Router, Response } from 'express';
import { body, validationResult } from 'express-validator';
import axios from 'axios';
import { db } from '../config/database';
import { logger } from '../utils/logger';
import { syncLeadToCrm } from '../services/crmSyncService';
import { AuthRequest } from '../middleware/auth';

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
  // Added for client priority #7 ("Votre entreprise et votre concordance"):
  // siren/siret/statut so the page can show them without the caller having
  // to re-derive siren from siret itself; revenue+year from Pappers'
  // `finances` array (most recent exercice available - Pappers returns
  // these newest-first).
  siren: string | null;
  siret: string | null;
  statut: string | null;
  revenue: string | null;
  revenueEstimated?: boolean;
  revenueYear: number | null;
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
  siren: '123456789',
  siret: DEMO_SIRET,
  statut: 'Active',
  revenue: '412000',
  revenueYear: 2025,
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
    // "finances_estimations" added alongside "finances" (per Pappers' own
    // API changelog): a company's most recent turnover on pappers.fr is
    // sometimes an ESTIMATION rather than a filed compte annuel, and that
    // only comes back from the API under this separate champ - the base
    // "finances" array only covers officially filed exercices. This is
    // exactly the SOW CLIM case the client tested: CA visible on the
    // Pappers website but absent here, because only "finances" was
    // requested and its latest year had no filed accounts yet.
    params: { api_token: apiKey, siret, champs_supplementaires: 'labels,finances,finances_estimations' },
    timeout: 8000,
  });

  const siege = data.siege || {};
  const dirigeant = (data.representants || [])[0] || (data.dirigeants || [])[0] || {};
  const directorName = [dirigeant.prenom, dirigeant.nom].filter(Boolean).join(' ') || dirigeant.nom_complet || null;
  const labels: string[] = Array.isArray(data.labels) ? data.labels.map((l: any) => l.label || l.nom || l).filter(Boolean) : [];
  // Pappers returns `finances` newest-exercice-first; take the first entry
  // that actually has a turnover figure rather than assuming index 0 always
  // does (a just-filed exercice can show up with other fields still null).
  // Fall back to `finances_estimations` (Pappers' own estimate for a year
  // with no filed accounts yet) only when no filed figure exists at all -
  // filed data always wins when both are present.
  const finances: any[] = Array.isArray(data.finances) ? data.finances : [];
  const financesEstimations: any[] = Array.isArray(data.finances_estimations) ? data.finances_estimations : [];
  const latestFinance = finances.find(f => f && f.chiffre_affaires != null)
    || financesEstimations.find(f => f && f.chiffre_affaires != null)
    || null;
  const isEstimated = !finances.find(f => f && f.chiffre_affaires != null) && !!latestFinance;

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
    siren: data.siren || siret.slice(0, 9) || null,
    siret: data.siege?.siret || siret || null,
    statut: data.entreprise_cessee ? 'Cessée' : (data.statut_rcs || (data.entreprise_cessee === false ? 'Active' : null)),
    revenue: latestFinance?.chiffre_affaires != null ? String(latestFinance.chiffre_affaires) : null,
    // Marked so the frontend can show "(estimé)" next to an estimated
    // figure rather than presenting it as an equally-certain filed number -
    // client's own rule against ever displaying something as more certain
    // than it is.
    revenueEstimated: isEstimated,
    revenueYear: latestFinance?.annee ?? null,
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
    siren: unite.siren || siret.slice(0, 9) || null,
    siret: siret || null,
    statut: unite.etatAdministratifUniteLegale === 'A' ? 'Active' : (unite.etatAdministratifUniteLegale === 'C' ? 'Cessée' : null),
    revenue: null, // Sirene has no financial data at all - Pappers-only field
    revenueYear: null,
    facebook: null,
    googleRating: null,
    googleReviewCount: null,
    certifications: [],
    source: 'insee',
  };
}

export interface CompanyCandidate {
  siret: string;
  siren: string | null;
  name: string | null;
  address: string | null;
  city: string | null;
  postal: string | null;
  ape: string | null;
  activity: string | null;
  statut: string | null;
}

// Client's updated brief (5 Sep, "parcours définitif"): a name search must
// show a results LIST for the visitor to pick from and confirm - not
// silently auto-resolve to Pappers' first/best guess as before. Pappers'
// /v2/recherche already returns enough for a picker (name/address/APE) per
// candidate without needing a separate paid per-SIRET call for each one -
// only the confirmed choice triggers the full (cached) lookup below.
// Client priority #6 (candidate list must show raison sociale, ville,
// activité, SIREN/SIRET, AND the company's active/ceased statut) - added
// statut + activity label + explicit siren alongside the fields already here.
async function searchCompaniesByName(name: string, apiKey: string): Promise<CompanyCandidate[]> {
  const { data } = await axios.get('https://api.pappers.fr/v2/recherche', {
    params: { api_token: apiKey, q: name, par_page: 5 },
    timeout: 8000,
  });
  return (data.resultats || []).map((r: any) => ({
    siret: r.siege?.siret || r.siret || null,
    siren: r.siren || null,
    name: r.nom_entreprise || r.denomination || null,
    address: r.siege?.adresse_ligne_1 || null,
    city: r.siege?.ville || null,
    postal: r.siege?.code_postal || null,
    ape: r.code_naf || null,
    activity: r.libelle_code_naf || (r.code_naf ? APE_LABELS[r.code_naf] || null : null),
    statut: r.entreprise_cessee === true ? 'Cessée' : (r.entreprise_cessee === false ? 'Active' : null),
  })).filter((c: CompanyCandidate) => !!c.siret);
}

// Client's Pappers-protection brief (WhatsApp, 5 Sep) - four rules, all
// enforced here:
//  1. "enregistrer chaque fiche entreprise ... à partir du SIREN" +
//     "ne jamais effectuer un nouvel appel payant si la fiche existe déjà" +
//     "ne consommer aucun crédit Pappers supplémentaire lorsque la même
//     entreprise analyse plusieurs opportunités" - company_lookup_cache,
//     keyed by SIREN (the first 9 digits of any SIRET at that company,
//     shared across all its établissements), checked before ever calling
//     Pappers/INSEE again for the same company.
//  2. "limiter à deux entreprises différentes par adresse IP avant la
//     création du compte" - siret_ip_throttle. Only applies pre-account
//     (req.user is null); a real logged-in company has no cap.
//  3. "ajouter une protection complémentaire par navigateur/appareil" -
//     honest limitation: there's no real device-fingerprinting anywhere in
//     this codebase (would need a frontend fingerprint library, e.g.
//     FingerprintJS, wired through as its own field). sessionId is recorded
//     alongside each throttle row as the closest available signal today,
//     but it is NOT a substitute for a real device id and can't be trusted
//     to survive a cleared cookie/localStorage the way a real fingerprint
//     would. Flagged rather than presented as solved.
//  4. "suivre précisément les appels payants et signaler toute consommation
//     anormale" - pappers_api_calls logs every real (non-cached) paid call.
//     No alerting/notification is wired up (would need email/Slack
//     integration, a separate decision) - this is the audit trail an admin
//     could query, not an automatic alert.
const THROTTLE_MAX_COMPANIES_PER_IP = 2;

class SiretThrottleError extends Error {}

async function getCompanyWithProtection(
  siret: string,
  ip: string | undefined,
  sessionId: string,
  isAuthenticated: boolean,
  fetchFn: () => Promise<CompanyData | null>
): Promise<CompanyData | null> {
  const siren = siret.slice(0, 9);

  const cached = await db.query('SELECT company_data, source FROM company_lookup_cache WHERE siren = $1', [siren]);
  if (cached.rows.length > 0) {
    const cachedData = cached.rows[0].company_data || {};
    // Client's test case (SOW CLIM, 5 Sep): "le chiffre d'affaires est
    // disponible sur Pappers mais n'apparaît pas sur Marchés Direct". Root
    // cause - revenue/revenueYear/siren/statut were added to CompanyData
    // after this cache table started filling up, so a company looked up
    // BEFORE that change has a company_data blob that's simply missing
    // those keys outright (not `null` - Pappers really does return null for
    // some fields when it has no data - but *absent*, meaning this row
    // predates the code that populates them). The permanent-cache rule
    // above ("never re-call Pappers for a company we've already fetched")
    // is about avoiding wasted paid calls for a company we already have a
    // complete profile for - it was never meant to permanently freeze an
    // incomplete/outdated snapshot. Detect that one specific case and treat
    // it as a cache miss so it self-heals on the next lookup, instead of
    // silently keeping stale data forever.
    const isOutdatedShape = !('revenue' in cachedData) || !('siren' in cachedData) || !('statut' in cachedData);
    if (!isOutdatedShape) {
      return { ...cachedData, source: cached.rows[0].source };
    }
  }

  if (!isAuthenticated && ip) {
    const existing = await db.query('SELECT siren FROM siret_ip_throttle WHERE ip_address = $1', [ip]);
    const knownSirens = new Set(existing.rows.map(r => r.siren));
    if (!knownSirens.has(siren) && knownSirens.size >= THROTTLE_MAX_COMPANIES_PER_IP) {
      throw new SiretThrottleError();
    }
  }

  const company = await fetchFn();
  if (!company) return null;

  await db.query(
    `INSERT INTO company_lookup_cache (siren, company_data, source)
     VALUES ($1, $2, $3)
     ON CONFLICT (siren) DO UPDATE SET company_data = $2, source = $3, fetched_at = NOW()`,
    [siren, JSON.stringify(company), company.source]
  );
  await db.query(
    `INSERT INTO pappers_api_calls (siren, endpoint, ip_address, session_id) VALUES ($1, $2, $3, $4)`,
    [siren, company.source === 'pappers' ? 'entreprise' : company.source, ip || null, sessionId]
  );
  if (ip) {
    await db.query(
      `INSERT INTO siret_ip_throttle (ip_address, siren, session_id) VALUES ($1, $2, $3) ON CONFLICT (ip_address, siren) DO NOTHING`,
      [ip, siren, sessionId]
    );
  }

  return company;
}


// flag per browser session (prototype V17, section 2.3), not per-opportunity:
// once identified on any fiche, a visitor is recognized everywhere without
// re-entering their SIRET. This is what the frontend calls on load to
// restore that state.
router.get('/status', async (req: AuthRequest, res: Response) => {
  try {
    const sessionId = req.query.sessionId as string;
    if (!sessionId) return res.json({ companyKnown: false, leadCaptured: false });
    const result = await db.query(
      'SELECT siret, company_data, phone, email, lead_captured_at FROM siret_lookups WHERE session_id = $1',
      [sessionId]
    );
    if (result.rows.length > 0) {
      const row = result.rows[0];
      return res.json({
        companyKnown: true,
        siret: row.siret,
        company: row.company_data,
        leadCaptured: !!row.lead_captured_at,
        phone: row.phone || null,
        email: row.email || null,
      });
    }

    // Logged-in users skip the SIRET gate entirely (OpportunityDetailPage
    // treats isAuthenticated as "company known"), but until now this was
    // the ONLY place that ever populated `company` - and it only ever
    // checked the anonymous siret_lookups row. A real account's own SIRET
    // was never looked up here, so `company` came back null and the whole
    // enriched fiche (raison sociale, dirigeant, statut, effectif, CA, RGE,
    // Présence détectée...) silently never rendered for anyone actually
    // logged in - exactly the reported "AI/company data doesn't show up"
    // bug. Auto-resolve their own company's SIRET the same way /confirm
    // does for an anonymous visitor, reusing the same Pappers/INSEE cache -
    // no re-typing needed, we already know their SIRET from their profile.
    if (req.user?.companyId) {
      const companyRow = await db.query('SELECT siret FROM companies WHERE id = $1', [req.user.companyId]);
      const mySiret: string | undefined = companyRow.rows[0]?.siret;
      if (mySiret && /^\d{14}$/.test(mySiret)) {
        const pappersKey = process.env.PAPPERS_API_KEY;
        const inseeKey = process.env.INSEE_API_KEY;
        if (pappersKey || inseeKey) {
          try {
            const { company } = await resolveAndCacheCompany(mySiret, pappersKey, inseeKey, req.ip, sessionId, true);
            if (company) {
              return res.json({ companyKnown: true, siret: mySiret, company, leadCaptured: true, phone: null, email: null });
            }
          } catch (err) {
            logger.error('Auto SIRET resolution for authenticated user failed:', err);
          }
        }
      }
    }

    res.json({ companyKnown: false, leadCaptured: false });
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
  async (req: AuthRequest, res: Response) => {
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

// Shared by /lookup's direct-SIRET path and /confirm: does the actual
// Pappers-primary/INSEE-fallback fetch, wrapped in the SIREN cache + IP
// throttle protection (getCompanyWithProtection above).
async function resolveAndCacheCompany(
  siret: string,
  pappersKey: string | undefined,
  inseeKey: string | undefined,
  ip: string | undefined,
  sessionId: string,
  isAuthenticated: boolean
): Promise<{ company: CompanyData | null; notFound: boolean }> {
  let lastError: any = null;
  let notFound = false;

  const company = await getCompanyWithProtection(siret, ip, sessionId, isAuthenticated, async () => {
    if (pappersKey) {
      try {
        return await lookupViaPappers(siret, pappersKey);
      } catch (err: any) {
        lastError = err;
        if (err.response?.status === 404) {
          logger.info(`Pappers lookup: SIRET ${siret} not found, falling back to INSEE if configured`);
        } else {
          logger.error('Pappers lookup error:', err.response?.data || err.message);
        }
      }
    }
    if (inseeKey) {
      try {
        return await lookupViaInsee(siret, inseeKey);
      } catch (err: any) {
        lastError = err;
        if (err.response?.status !== 404) {
          logger.error('INSEE lookup error:', err.response?.data || err.message);
        }
      }
    }
    return null;
  });

  if (!company && lastError?.response?.status === 404) notFound = true;
  return { company, notFound };
}

// POST /api/siret/lookup - "reconnaissance d'entreprise" (client's 5 Sep
// "parcours définitif"). A 14-digit SIRET is unambiguous and resolved
// immediately, same as before. A free-text name now returns a LIST of
// candidates instead of silently auto-picking Pappers' first match - the
// client was explicit that the visitor must see and confirm the right one
// ("Une liste de résultats lui est proposée. Dès qu'il sélectionne et
// confirme la bonne entreprise..."). Nothing is saved to siret_lookups (and
// no paid per-company Pappers call happens) until the visitor actually
// confirms one via POST /siret/confirm below.
router.post(
  '/lookup',
  [
    body('query').isString().trim().isLength({ min: 2, max: 200 }).withMessage("Indiquez un SIRET (14 chiffres) ou le nom de l'entreprise."),
    body('sessionId').isString().trim().isLength({ min: 8, max: 100 }),
  ],
  async (req: AuthRequest, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }

    const { sessionId } = req.body;
    const query: string = req.body.query;
    const ip = req.ip;
    const isAuthenticated = !!req.user;

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

    // Free-text name -> candidates list, no lookup/cache/throttle yet.
    if (!/^\d{14}$/.test(query)) {
      if (!pappersKey) {
        return res.status(400).json({
          error: 'name_search_not_configured',
          message: "La recherche par nom d'entreprise n'est pas disponible pour le moment. Indiquez le numéro de SIRET (14 chiffres).",
        });
      }
      let candidates: CompanyCandidate[] = [];
      try {
        candidates = await searchCompaniesByName(query, pappersKey);
      } catch (err: any) {
        logger.error('Pappers company-name search error:', err.response?.data || err.message);
        return res.status(502).json({ error: 'siret_lookup_failed', message: 'La recherche a échoué. Réessayez.' });
      }
      if (candidates.length === 0) {
        return res.status(404).json({ error: 'siret_not_found', message: "Aucune entreprise trouvée pour ce nom. Essayez avec le numéro de SIRET." });
      }
      return res.json({ companyKnown: false, candidates });
    }

    // Direct 14-digit SIRET - unambiguous, resolve immediately (protected
    // by the same cache/throttle as /confirm).
    let result: { company: CompanyData | null; notFound: boolean };
    try {
      result = await resolveAndCacheCompany(query, pappersKey, inseeKey, ip, sessionId, isAuthenticated);
    } catch (err) {
      if (err instanceof SiretThrottleError) {
        return res.status(429).json({
          error: 'company_lookup_throttled',
          message: "Vous avez déjà consulté deux entreprises différentes. Créez un compte pour continuer vos recherches.",
        });
      }
      throw err;
    }
    if (!result.company) {
      if (result.notFound) {
        return res.status(404).json({ error: 'siret_not_found', message: 'Aucune entreprise trouvée pour ce SIRET.' });
      }
      return res.status(502).json({ error: 'siret_lookup_failed', message: "La vérification du SIRET a échoué. Réessayez." });
    }

    await db.query(
      `INSERT INTO siret_lookups (session_id, siret, company_data)
       VALUES ($1, $2, $3)
       ON CONFLICT (session_id) DO UPDATE SET siret = $2, company_data = $3, created_at = NOW()`,
      [sessionId, query, JSON.stringify(result.company)]
    );

    res.json({ companyKnown: true, siret: query, company: result.company });
  }
);

// POST /api/siret/confirm - the visitor picked one candidate off the list
// POST /siret/lookup returned for a name search. Does the actual (cached/
// throttled) per-SIRET lookup and saves it as the recognized company for
// this session, exactly like the direct-SIRET path in /lookup above.
router.post(
  '/confirm',
  [
    body('siret').matches(/^\d{14}$/).withMessage('SIRET invalide.'),
    body('sessionId').isString().trim().isLength({ min: 8, max: 100 }),
  ],
  async (req: AuthRequest, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }

    const { siret, sessionId } = req.body;
    const ip = req.ip;
    const isAuthenticated = !!req.user;

    if (siret === DEMO_SIRET) {
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
      return res.status(501).json({ error: 'company_lookup_not_configured', message: "La reconnaissance d'entreprise n'est pas encore configurée." });
    }

    let result: { company: CompanyData | null; notFound: boolean };
    try {
      result = await resolveAndCacheCompany(siret, pappersKey, inseeKey, ip, sessionId, isAuthenticated);
    } catch (err) {
      if (err instanceof SiretThrottleError) {
        return res.status(429).json({
          error: 'company_lookup_throttled',
          message: "Vous avez déjà consulté deux entreprises différentes. Créez un compte pour continuer vos recherches.",
        });
      }
      throw err;
    }
    if (!result.company) {
      if (result.notFound) {
        return res.status(404).json({ error: 'siret_not_found', message: 'Aucune entreprise trouvée pour ce SIRET.' });
      }
      return res.status(502).json({ error: 'siret_lookup_failed', message: "La vérification du SIRET a échoué. Réessayez." });
    }

    await db.query(
      `INSERT INTO siret_lookups (session_id, siret, company_data)
       VALUES ($1, $2, $3)
       ON CONFLICT (session_id) DO UPDATE SET siret = $2, company_data = $3, created_at = NOW()`,
      [sessionId, siret, JSON.stringify(result.company)]
    );

    res.json({ companyKnown: true, siret, company: result.company });
  }
);

export default router;
