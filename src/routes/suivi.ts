import { Router, Response } from 'express';
import { db } from '../config/database';
import { logger } from '../utils/logger';
import { AuthRequest } from '../middleware/auth';
import { generateDossierPdfV2, DossierKind } from '../services/dossierPdfV2';
import { clientSteps, entrustDossier, followupSchema, refreshStages, findLeadFor } from '../services/dossierFollowupService';

// /api/suivi : favoris, « Confier à Elena » et suivi des dossiers (5 nov.).
// Accès : la session du navigateur (visiteur sans compte) ou, une fois connecté par lien magique, l'e-mail vérifié
// du compte et son entreprise. Jamais par SIRET seul : un SIRET est public, un e-mail vérifié ne l'est pas.
const router = Router();
const SID = /^[A-Za-z0-9_-]{8,100}$/;
const UUID = /^[0-9a-f-]{36}$/i;
const sessionsOf = (req: AuthRequest) => {
  const raw = String((req.method === 'GET' ? req.query.sessionId : req.body?.sessionId) || '');
  return SID.test(raw) ? [raw] : [];
};

async function rowsFor(req: AuthRequest, opportunityId?: string) {
  await followupSchema();
  const sessions = sessionsOf(req);
  const email = req.user?.email || null; const companyId = req.user?.companyId || null;
  if (!sessions.length && !email) return [];
  const r = await db.query(
    `SELECT f.*, o.title, o.buyer_name, o.deadline, o.location_city, ot.code AS journey, l.created_at AS lead_at
       FROM dossier_followups f
       JOIN opportunities o ON o.id = f.opportunity_id
       LEFT JOIN opportunity_types ot ON ot.id = o.opportunity_type_id
       LEFT JOIN crm_leads l ON l.id = f.lead_id
      WHERE (f.session_id = ANY($1) OR ($2::text IS NOT NULL AND lower(f.email) = lower($2)) OR ($3::uuid IS NOT NULL AND f.company_id = $3))
        AND ($4::uuid IS NULL OR f.opportunity_id = $4)
      ORDER BY f.updated_at DESC LIMIT 50`, [sessions, email, companyId, opportunityId || null]);
  // Rafraîchit à la demande ce qui n'a pas été relu depuis 5 minutes (le serveur peut avoir dormi).
  const stale = r.rows.filter((x: any) => x.hubspot_deal_id && (!x.synced_at || Date.now() - new Date(x.synced_at).getTime() > 5 * 60000));
  if (stale.length) { try { await refreshStages(stale); } catch (e: any) { logger.warn('[Suivi] relecture HubSpot impossible:', e?.message); } }
  return r.rows;
}

const view = (x: any) => ({
  id: x.id, opportunityId: x.opportunity_id, title: x.title, buyer: x.buyer_name, city: x.location_city, deadline: x.deadline, journey: x.journey,
  stage: x.stage, updatedAt: x.stage_changed_at, createdAt: x.created_at,
  steps: clientSteps({ known: true, analysed: true, leadAt: x.lead_at, followup: { stage: x.stage, created_at: x.created_at, stage_history: x.stage_history || [] } }),
});

// GET /api/suivi?sessionId=… : mes dossiers confiés.
router.get('/', async (req: AuthRequest, res: Response) => {
  try { res.json({ dossiers: (await rowsFor(req)).map(view) }); }
  catch (err: any) { logger.error('[Suivi] liste:', err); res.status(500).json({ error: 'suivi_unavailable' }); }
});

// GET /api/suivi/apercu/:kind : dossier PDF d'EXEMPLE (données fictives) pour contrôler le rendu en production.
router.get('/apercu/:kind', async (req: AuthRequest, res: Response) => {
  const kind = String(req.params.kind);
  if (!['public', 'prive', 'st'].includes(kind)) return res.status(400).json({ error: 'invalid_kind' });
  try {
    const now = new Date(); const deadline = new Date(now.getTime() + 7 * 86400000); deadline.setUTCHours(11, 0, 0, 0);
    const pdf = await generateDossierPdfV2({
      kind: kind as DossierKind, ref: 'MD-EXEMPLE', url: `${(process.env.FRONTEND_URL || 'https://www.marchesdirect.fr').replace(/\/$/, '')}/marches`,
      companyName: 'ENTREPRISE EXEMPLE', siret: '12345678900012',
      company: { legal: 'SAS', created: '2019', address: '1 rue de l’Exemple', city: 'Bordeaux', postal: '33000', director: 'Prénom NOM', employees: '3 à 5 salariés', ape: '43.22B', activity: 'Travaux d’installation d’équipements thermiques et de climatisation' },
      title: kind === 'st' ? 'Construction d’un groupe scolaire : sous-traitance du lot CVC' : kind === 'prive' ? 'Remplacement de la production de chaleur d’une résidence' : 'Rénovation énergétique d’un bâtiment communal (exemple)',
      lotLabel: 'Lot 3 — Chauffage, ventilation, climatisation', buyerName: kind === 'public' ? 'Commune exemple' : null, reference: kind === 'public' ? '26-000000' : null,
      locationCity: 'Gironde (33)', deadline, estimatedValue: null, isClosed: false, now,
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="dossier-exemple-${kind}.pdf"`);
    res.send(pdf);
  } catch (err: any) { logger.error('[Dossier PDF v2] aperçu:', err); res.status(500).json({ error: 'pdf_failed', message: String(err?.message || err).slice(0, 300) }); }
});

// GET /api/suivi/:opportunityId?sessionId=… : la frise de ce marché, même avant tout dossier confié.
router.get('/:opportunityId', async (req: AuthRequest, res: Response) => {
  const opp = req.params.opportunityId;
  if (!UUID.test(opp)) return res.status(400).json({ error: 'invalid_opportunity' });
  try {
    const rows = await rowsFor(req, opp);
    if (rows[0]) return res.json({ dossier: view(rows[0]) });
    const sessions = sessionsOf(req);
    const lead = sessions.length || req.user?.email ? await findLeadFor(sessions, opp, req.user?.email) : null;
    let known = !!lead, analysed = !!lead;
    if (!lead && sessions.length) {
      const k = await db.query(`SELECT EXISTS(SELECT 1 FROM siret_lookups WHERE session_id = ANY($1)) AS known,
        EXISTS(SELECT 1 FROM visitor_events WHERE session_id = ANY($1) AND opportunity_id = $2 AND event_type IN ('concordance_shown','analysis_completed')) AS analysed`, [sessions, opp]);
      known = !!k.rows[0]?.known; analysed = known && !!k.rows[0]?.analysed;
    }
    res.json({ dossier: null, steps: clientSteps({ known, analysed, leadAt: lead?.created_at || null, followup: null }) });
  } catch (err: any) { logger.error('[Suivi] fiche:', err); res.status(500).json({ error: 'suivi_unavailable' }); }
});

// POST /api/suivi/:opportunityId/confier { sessionId } : « Confier à Elena ».
router.post('/:opportunityId/confier', async (req: AuthRequest, res: Response) => {
  const opp = req.params.opportunityId;
  if (!UUID.test(opp)) return res.status(400).json({ error: 'invalid_opportunity' });
  const sessions = sessionsOf(req);
  if (!sessions.length && !req.user) return res.status(400).json({ error: 'session_required' });
  try {
    const out = await entrustDossier({ sessionIds: sessions, opportunityId: opp, email: req.user?.email, companyId: req.user?.companyId });
    if (!out.ok) return res.status(409).json({ error: out.code, message: 'Recevez d’abord votre dossier prérempli : Elena a besoin de votre numéro pour vous appeler.' });
    const rows = await rowsFor(req, opp);
    res.json({ dossier: rows[0] ? view(rows[0]) : null });
  } catch (err: any) { logger.error('[Suivi] confier:', err); res.status(500).json({ error: 'suivi_unavailable' }); }
});

export default router;
