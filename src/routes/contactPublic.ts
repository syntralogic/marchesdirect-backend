import { Router, Request, Response } from 'express';
import { body, query, validationResult } from 'express-validator';
import { logger } from '../utils/logger';
import { parseContactMode, setContactModeForSession, applyContactChoice, verifyEmailSignature } from '../services/contactPreferenceService';
import { subscribe, confirm, unsubscribe, verifySig } from '../services/alertSubscriptionService';

// Public (no login): the visitor's own contact choices. Mounted at /api.
const router = Router();
const page = (title: string, text: string) =>
  `<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
   <body style="font-family:system-ui,sans-serif;max-width:480px;margin:15vh auto;padding:0 20px;text-align:center"><h1 style="font-size:20px">${title}</h1><p>${text}</p></body></html>`;

// POST /api/contact/preferences { sessionId, mode: 'followup' | 'request-only' }
router.post('/contact/preferences', [body('sessionId').isString().trim().isLength({ min: 8, max: 100 })], async (req: Request, res: Response) => {
  if (!validationResult(req).isEmpty()) return res.status(400).json({ error: 'Session invalide.' });
  const mode = parseContactMode(req.body?.mode);
  if (!mode) return res.status(400).json({ error: "Choix invalide." });
  try {
    const r = await setContactModeForSession(req.body.sessionId, mode);
    // saved:false => the server holds nothing for this person yet; the page must not say the choice was recorded.
    if (!r.ok) return res.status(200).json({ saved: false, reason: r.reason });
    return res.json({ saved: true, mode });
  } catch (err) {
    logger.error('contact preferences error:', err);
    return res.status(500).json({ saved: false, error: "Votre choix n'a pas pu être enregistré. Réessayez." });
  }
});

// GET /api/contact/unsubscribe?e=<email>&s=<signature> - one click from a reminder or alert e-mail
router.get('/contact/unsubscribe', [query('e').isEmail(), query('s').isString()], async (req: Request, res: Response) => {
  const e = String(req.query.e || ''), s = String(req.query.s || '');
  if (!validationResult(req).isEmpty() || !verifyEmailSignature(e, s)) return res.status(400).send(page('Lien invalide', "Ce lien n'est pas valide ou a expiré."));
  try {
    await applyContactChoice(e, 'request-only', 'unsubscribed');
    return res.send(page('Vous ne recevrez plus de relances', 'Vos demandes en cours restent traitées. Aucun rappel ni alerte ne vous sera envoyé.'));
  } catch (err) {
    logger.error('unsubscribe error:', err);
    return res.status(500).send(page('Une erreur est survenue', "Votre désinscription n'a pas pu être enregistrée. Réessayez dans un instant."));
  }
});

// POST /api/alert-subscriptions { email, tradeId?, area?, sessionId?, consent }
router.post('/alert-subscriptions', [body('email').isEmail().normalizeEmail(), body('tradeId').optional({ nullable: true }).isInt({ min: 1 }), body('area').optional({ nullable: true }).isString()], async (req: Request, res: Response) => {
  if (!validationResult(req).isEmpty()) return res.status(400).json({ error: "Vérifiez l'adresse e-mail." });
  try {
    const r = await subscribe({ email: req.body.email, tradeId: req.body.tradeId ? Number(req.body.tradeId) : null, area: req.body.area || null, sessionId: req.body.sessionId || null, consent: req.body.consent === true });
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    // saved = the request is stored; confirmationEmail = what really happened to the e-mail (sent | failed | not_configured | disabled).
    return res.status(201).json({ saved: true, active: r.alreadyConfirmed, confirmationEmail: r.confirmationEmail });
  } catch (err) {
    logger.error('alert subscription error:', err);
    return res.status(500).json({ error: "Votre demande d'alerte n'a pas pu être enregistrée. Réessayez." });
  }
});

router.get('/alert-subscriptions/confirm', async (req: Request, res: Response) => {
  const id = String(req.query.id || ''), s = String(req.query.s || '');
  if (!verifySig('confirm', id, s)) return res.status(400).send(page('Lien invalide', "Ce lien n'est pas valide."));
  const ok = await confirm(id).catch(() => false);
  return res.status(ok ? 200 : 404).send(ok ? page('Alertes activées', 'Vous recevrez les nouvelles opportunités correspondant à votre alerte. Chaque message contient un lien pour vous désinscrire.') : page('Alerte introuvable', "Cette demande n'existe plus."));
});
router.get('/alert-subscriptions/unsubscribe', async (req: Request, res: Response) => {
  const id = String(req.query.id || ''), s = String(req.query.s || '');
  if (!verifySig('unsub', id, s)) return res.status(400).send(page('Lien invalide', "Ce lien n'est pas valide."));
  const ok = await unsubscribe(id).catch(() => false);
  return res.status(ok ? 200 : 404).send(ok ? page('Alerte désactivée', 'Vous ne recevrez plus cette alerte.') : page('Alerte introuvable', "Cette alerte n'existe plus."));
});

export default router;
