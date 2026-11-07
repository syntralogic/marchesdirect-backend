import { Router, Request, Response } from 'express';
import { db } from '../config/database';
import { logger } from '../utils/logger';
import { authenticate, requireRole } from '../middleware/auth';

// 7 nov. (décision de Hedi) : après 10 fiches consultées, l'artisan continue gratuitement en laissant son portable et
// son e-mail, sans mot de passe (le lien magique s'appuiera dessus). Ce n'est PAS une demande de contact : aucune tâche
// de rappel, rien dans HubSpot ; l'équipe voit la liste des inscrits.
const router = Router();
let ready: Promise<void> | null = null;
const ensure = () => ready ||= db.query(`CREATE TABLE IF NOT EXISTS site_members (id SERIAL PRIMARY KEY, phone TEXT UNIQUE NOT NULL,
    email TEXT, siret TEXT, company TEXT, session_id TEXT, fiches_seen INT, consent_text TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW())`).then(() => undefined).catch(e => { ready = null; throw e; });
const s = (v: unknown, n: number) => (typeof v === 'string' ? v.trim().slice(0, n) : '');

// Portable français : 06 / 07 (ou +33 6 / +33 7), ramené à 10 chiffres.
export function frMobile(v: string): string | null {
  const d = v.replace(/[^\d+]/g, '').replace(/^\+33/, '0').replace(/^0033/, '0');
  return /^0[67]\d{8}$/.test(d) ? d : null;
}

router.post('/', async (req: Request, res: Response) => {
  try {
    const b = req.body || {};
    const phone = frMobile(s(b.phone, 30));
    const email = s(b.email, 200).toLowerCase();
    const fields: Record<string, string> = {};
    if (!phone) fields.phone = 'Indiquez un numéro de portable (06 ou 07).';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) fields.email = 'Indiquez une adresse e-mail valide.';
    if (Object.keys(fields).length) return res.status(400).json({ error: 'invalid', fields });
    await ensure();
    await db.query(`INSERT INTO site_members (phone, email, siret, company, session_id, fiches_seen, consent_text)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (phone) DO UPDATE SET email = EXCLUDED.email, siret = COALESCE(EXCLUDED.siret, site_members.siret),
        company = COALESCE(EXCLUDED.company, site_members.company), session_id = EXCLUDED.session_id, last_seen = NOW()`,
      [phone, email, /^\d{14}$/.test(s(b.siret, 14)) ? s(b.siret, 14) : null, s(b.company, 200) || null, s(b.sessionId, 100) || null,
        Number.isFinite(Number(b.fichesSeen)) ? Math.min(100000, Number(b.fichesSeen)) : null, s(b.consentText, 600) || null]);
    res.json({ ok: true });
  } catch (err) { logger.error('[inscrits] enregistrement :', err); res.status(503).json({ error: 'unavailable' }); }
});

router.get('/', authenticate, requireRole(['admin', 'super_admin']), async (_req: Request, res: Response) => {
  try {
    await ensure();
    const r = await db.query(`SELECT id, phone, email, siret, company, fiches_seen, created_at, last_seen FROM site_members ORDER BY created_at DESC LIMIT 500`);
    const c = await db.query(`SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')::int AS week FROM site_members`);
    res.json({ items: r.rows, total: c.rows[0]?.n || 0, last7days: c.rows[0]?.week || 0 });
  } catch (err) { logger.error('[inscrits] liste :', err); res.status(503).json({ error: 'unavailable' }); }
});

export default router;
