import { Router, Request, Response } from 'express';
import { db } from '../config/database';
import { readStoredObject } from '../services/storageService';

// 8 nov. : photos de profil avec un stockage privé (Supabase Storage). Le serveur lit l'image et la sert, en cache 1 h.
// Seule la photo est exposée (jamais le chemin du stockage ni d'autre document) ; un identifiant inconnu → 404.
const router = Router();
router.get('/:userId', async (req: Request, res: Response) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.userId)) return res.status(404).end();
  try {
    const u = await db.query('SELECT avatar_url FROM users WHERE id = $1 AND deleted_at IS NULL', [req.params.userId]);
    const ref: string | null = u.rows[0]?.avatar_url || null;
    if (!ref || !/^(avatars\/|\/uploads\/avatars\/)/.test(ref)) return res.status(404).end();
    const o = await readStoredObject(ref);
    if (!o) return res.status(404).end();
    res.set('Content-Type', o.contentType); res.set('Cache-Control', 'public, max-age=600'); res.set('X-Content-Type-Options', 'nosniff');
    res.send(o.body);
  } catch { res.status(404).end(); }
});
export default router;
