import { Router, Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
import axios from 'axios';
import { db } from '../config/database';
import { logger } from '../utils/logger';

const router = Router();

const APE_LABELS: Record<string, string> = {
  '4120A': 'Construction de maisons individuelles',
  '4120B': "Construction d'autres bâtiments",
  '4211Z': 'Construction de routes et autoroutes',
  '4321A': 'Travaux d\'installation électrique',
  '4322A': 'Travaux de plomberie',
  '4331Z': 'Travaux de plâtrerie',
  '4332A': 'Travaux de menuiserie bois et PVC',
  '4334Z': 'Travaux de peinture et vitrerie',
  '4391A': 'Travaux de charpente',
  '4399C': 'Travaux de maçonnerie générale',
};

// GET /api/siret/status?sessionId=... - "companyKnown" is a single global
// flag per browser session (prototype V17, section 2.3), not per-opportunity:
// once identified on any fiche, a visitor is recognized everywhere without
// re-entering their SIRET. This is what the frontend calls on load to
// restore that state.
router.get('/status', async (req: Request, res: Response) => {
  try {
    const sessionId = req.query.sessionId as string;
    if (!sessionId) return res.json({ companyKnown: false });
    const result = await db.query('SELECT siret, company_data FROM siret_lookups WHERE session_id = $1', [sessionId]);
    if (result.rows.length === 0) return res.json({ companyKnown: false });
    res.json({ companyKnown: true, siret: result.rows[0].siret, company: result.rows[0].company_data });
  } catch (err: any) {
    logger.error('SIRET status error:', err);
    res.status(500).json({ error: 'Failed to check status' });
  }
});

// POST /api/siret/lookup - "reconnaissance d'entreprise" (prototype V17,
// section 3.3). Validates the SIRET is exactly 14 digits (spec's own rule),
// fetches the legal unit from INSEE Sirene, and caches it against the
// visitor's session so it's recognized on every fiche from then on.
//
// Open point: needs INSEE_API_KEY (free, but requires registering an app at
// https://portail-api.insee.fr - same pattern as PLACE_API_KEY). Two fields
// the spec asks for aren't available from this API at all and would need
// separate data sources to confirm with the client:
//   - `director` (dirigeant) - INSEE's RNE/INPI API, not Sirene
//   - online-presence detection (website/Facebook/Google rating) - no
//     company-registry API provides this; would need a search/SERP source
router.post(
  '/lookup',
  [
    body('siret').matches(/^\d{14}$/).withMessage('Le SIRET doit contenir 14 chiffres.'),
    body('sessionId').isString().trim().isLength({ min: 8, max: 100 }),
  ],
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }
    const apiKey = process.env.INSEE_API_KEY;
    if (!apiKey) {
      return res.status(501).json({ error: 'insee_api_key_not_configured', message: "La reconnaissance d'entreprise par SIRET n'est pas encore configurée." });
    }

    const { siret, sessionId } = req.body;
    try {
      const { data } = await axios.get(`https://api.insee.fr/entreprises/sirene/V3.11/siret/${siret}`, {
        headers: { 'X-INSEE-Api-Key-Integration': apiKey, Accept: 'application/json' },
        timeout: 8000,
      });
      const etab = data.etablissement;
      const unite = etab?.uniteLegale || {};
      const adresse = etab?.adresseEtablissement || {};
      const apeCode = unite.activitePrincipaleUniteLegale || null;

      const company = {
        name: unite.denominationUniteLegale || unite.denominationUsuelle1UniteLegale
          || [unite.prenom1UniteLegale, unite.nomUniteLegale].filter(Boolean).join(' ') || null,
        legal: unite.categorieJuridiqueUniteLegale || null,
        created: unite.dateCreationUniteLegale || etab?.dateCreationEtablissement || null,
        // Capital social isn't in the /siret unit response - would need a
        // separate call to /siren for the légale unit's financials, left
        // null rather than guessed until that's wired in.
        capital: null,
        address: [adresse.numeroVoieEtablissement, adresse.typeVoieEtablissement, adresse.libelleVoieEtablissement]
          .filter(Boolean).join(' ') || null,
        city: adresse.libelleCommuneEtablissement || null,
        postal: adresse.codePostalEtablissement || null,
        director: null, // see note above - not available from this API
        employees: unite.trancheEffectifsUniteLegale || null,
        ape: apeCode,
        activity: apeCode ? (APE_LABELS[apeCode] || null) : null,
        // Online presence (website/Facebook/Google) not available from any
        // company-registry API - left unset rather than fabricated.
      };

      await db.query(
        `INSERT INTO siret_lookups (session_id, siret, company_data)
         VALUES ($1, $2, $3)
         ON CONFLICT (session_id) DO UPDATE SET siret = $2, company_data = $3, created_at = NOW()`,
        [sessionId, siret, JSON.stringify(company)]
      );

      res.json({ companyKnown: true, siret, company });
    } catch (err: any) {
      if (err.response?.status === 404) {
        return res.status(404).json({ error: 'siret_not_found', message: 'Aucune entreprise trouvée pour ce SIRET.' });
      }
      logger.error('SIRET lookup error:', err.response?.data || err.message);
      res.status(502).json({ error: 'siret_lookup_failed', message: "La vérification du SIRET a échoué. Réessayez." });
    }
  }
);

export default router;
