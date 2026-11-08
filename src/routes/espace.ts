import { Router, Response } from 'express';
import { db } from '../config/database';
import { logger } from '../utils/logger';
import { AuthRequest } from '../middleware/auth';
import { followupSchema, messagesSchema } from '../services/dossierFollowupService';
import { ensureSavedSearchSchema } from './savedSearches';
import { newItemsFor } from '../services/savedSearchAlertService';
import { recordVisit, marketPulse } from '../services/espaceService';

// 8 nov. (Hedi : « il faut qu'il ait un tableau de bord où il se sente à l'aise, où il retrouve tout, où il prend
// plaisir à revenir ») : le fil de « Mon espace ». Un seul endroit qui rassemble, du plus récent au plus ancien :
//  - les nouvelles annonces de chaque recherche suivie depuis sa dernière consultation (même moteur que le site) ;
//  - les échéances proches des annonces enregistrées (7 jours) ;
//  - les réponses d'Elena sur les dossiers ;
//  - l'avancement des dossiers.
// Le « non lu » est mémorisé par visiteur (session du téléphone, puis compte). Les notifications téléphone et e-mail
// renverront vers ce fil. Rien n'est estimé : chaque nombre vient d'une requête réelle.
const router = Router();
const SID = /^[A-Za-z0-9_-]{8,100}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STAGE_LABEL: Record<string, string> = {
  entrusted: 'Dossier confié à Elena', documents: 'Pièces demandées', drafting: 'Rédaction en cours', signature: 'À signer',
  filed: 'Candidature déposée', won: 'Marché gagné', lost: 'Non retenu',
};
const ACTIVE = ['entrusted', 'documents', 'drafting', 'signature', 'filed'];

let readsReady: Promise<void> | null = null;
const readsSchema = () => (readsReady ??= db.query(`CREATE TABLE IF NOT EXISTS espace_reads (
    owner_key VARCHAR(140) PRIMARY KEY, last_read_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`).then(async () => {
      await db.query('ALTER TABLE saved_searches ADD COLUMN IF NOT EXISTS last_viewed_at TIMESTAMPTZ').catch(() => {});
    }).catch(e => { readsReady = null; throw e; }));

const owner = (req: AuthRequest) => {
  const raw = String((req.method === 'GET' ? req.query.sessionId : req.body?.sessionId) || '');
  return { sessionId: SID.test(raw) ? raw : null, userId: req.user?.id || null, email: req.user?.email || null, companyId: req.user?.companyId || null };
};
const ownerKey = (o: ReturnType<typeof owner>) => (o.userId ? `u:${o.userId}` : o.sessionId ? `s:${o.sessionId}` : null);

type Item = { id: string; kind: 'nouveautes' | 'echeance' | 'message' | 'dossier'; at: string; title: string; detail: string | null; link: string; count?: number; unread?: boolean };

const cache = new Map<string, { at: number; body: any }>();

router.get('/fil', async (req: AuthRequest, res: Response) => {
  const o = owner(req); const key = ownerKey(o);
  if (!key) return res.status(400).json({ error: 'session_required' });
  const favIds = String(req.query.fav || '').split(',').filter(x => UUID.test(x)).slice(0, 100);
  const cacheKey = `${key}|${favIds.join(',')}`;
  // La visite est comptée à chaque ouverture (même servie depuis le cache) : base du « depuis votre dernière visite »
  // et des relances (personne n'est relancé s'il est venu depuis moins de 2 jours).
  const visit = await recordVisit(key, o.sessionId, o.email).catch(() => ({ prevSeenAt: null, visitDays: 1 }));
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < 60_000) return res.json({ ...hit.body, visit });
  try {
    await readsSchema(); await ensureSavedSearchSchema(); await followupSchema(); await messagesSchema();
    const lastRead = (await db.query('SELECT last_read_at FROM espace_reads WHERE owner_key = $1', [key])).rows[0]?.last_read_at || null;
    const items: Item[] = [];

    // 1. Recherches suivies : annonces nouvelles depuis la dernière consultation de chaque recherche.
    const sp: any[] = []; const sw: string[] = [];
    if (o.userId) { sp.push(o.userId); sw.push(`user_id = $${sp.length}`); }
    if (o.sessionId) { sp.push(o.sessionId); sw.push(`session_id = $${sp.length}`); }
    const searches = (await db.query(`SELECT id, label, query, created_at, last_viewed_at FROM saved_searches
      WHERE deleted_at IS NULL AND (${sw.join(' OR ')}) ORDER BY created_at DESC LIMIT 10`, sp)).rows;
    let nouveautes = 0;
    const picks = new Map<string, any>(); // « À ne pas manquer » : nouvelles annonces des suivis, échéance la plus proche d'abord
    for (const s of searches) {
      try {
        const since = s.last_viewed_at || s.created_at;
        const fresh = await newItemsFor({ id: s.id, query: s.query, alert_baseline_at: since }, 50);
        if (!fresh.length) continue;
        nouveautes += fresh.length;
        for (const x of fresh) if (!picks.has(x.id)) picks.set(x.id, { id: x.id, title: x.title, city: x.buyer_city || x.location_city || null,
          deadline: x.deadline_checked || x.deadline || null, journey: x.journey || null, lot: x.matched_lot || null, follow: s.label });
        const latest = fresh.reduce((m: string, x: any) => (x.publication_date && x.publication_date > m ? x.publication_date : m), String(since instanceof Date ? since.toISOString() : since));
        items.push({ id: `n:${s.id}`, kind: 'nouveautes', at: new Date(latest).toISOString(), count: fresh.length,
          title: `${fresh.length >= 50 ? '50+' : fresh.length} nouvelle${fresh.length > 1 ? 's' : ''} annonce${fresh.length > 1 ? 's' : ''} · ${s.label}`,
          detail: fresh.slice(-2).map((x: any) => x.title).join(' · ').slice(0, 220), link: `/vos-marches?${s.query}&suivi=${s.id}` });
      } catch (e: any) { logger.warn(`[Espace] recherche ${s.id} :`, e?.message); }
    }

    // 2. Annonces enregistrées dont la date limite (relue dans l'avis) tombe dans les 7 jours.
    let echeances = 0;
    if (favIds.length) {
      const r = await db.query(`SELECT o.id, o.title, COALESCE(l.notice_deadline, o.deadline) AS dl FROM opportunities o
        LEFT JOIN opportunity_locations l ON l.opportunity_id = o.id
        WHERE o.id = ANY($1::uuid[]) AND o.deleted_at IS NULL AND o.status = 'active'
          AND COALESCE(l.notice_deadline, o.deadline) BETWEEN NOW() AND NOW() + INTERVAL '7 days'
        ORDER BY 3 ASC`, [favIds]).catch(() => ({ rows: [] as any[] }));
      for (const x of r.rows) {
        echeances++;
        const days = Math.max(0, Math.ceil((new Date(x.dl).getTime() - Date.now()) / 86400000));
        items.push({ id: `e:${x.id}`, kind: 'echeance', at: new Date(Date.now() - days * 60000).toISOString(),
          title: days === 0 ? 'Dernier jour pour répondre' : `Plus que ${days} jour${days > 1 ? 's' : ''} pour répondre`,
          detail: x.title, link: `/opportunites/${x.id}` });
      }
    }

    // 3 et 4. Dossiers : réponses d'Elena et changements d'étape.
    const f = await db.query(`SELECT f.id, f.opportunity_id, f.stage, f.stage_changed_at, f.created_at, o.title FROM dossier_followups f
      JOIN opportunities o ON o.id = f.opportunity_id
      WHERE (f.session_id = $1 OR ($2::text IS NOT NULL AND lower(f.email) = lower($2)) OR ($3::uuid IS NOT NULL AND f.company_id = $3))
      ORDER BY f.updated_at DESC LIMIT 30`, [o.sessionId, o.email, o.companyId]);
    const dossiersEnCours = f.rows.filter((x: any) => ACTIVE.includes(x.stage)).length;
    if (f.rows.length) {
      const m = await db.query(`SELECT id, followup_id, body, created_at FROM dossier_messages WHERE author = 'elena' AND followup_id = ANY($1::uuid[])
        ORDER BY created_at DESC LIMIT 30`, [f.rows.map((x: any) => x.id)]);
      const byId = new Map(f.rows.map((x: any) => [x.id, x]));
      for (const x of m.rows) {
        const d: any = byId.get(x.followup_id);
        items.push({ id: `m:${x.id}`, kind: 'message', at: new Date(x.created_at).toISOString(), title: 'Elena vous a répondu',
          detail: `${String(x.body).slice(0, 180)}${String(x.body).length > 180 ? '…' : ''}`, link: `/opportunites/${d?.opportunity_id}#suivi` });
      }
      for (const x of f.rows) {
        if (Date.now() - new Date(x.stage_changed_at).getTime() > 30 * 86400000) continue;
        items.push({ id: `d:${x.id}:${x.stage}`, kind: 'dossier', at: new Date(x.stage_changed_at).toISOString(),
          title: STAGE_LABEL[x.stage] || 'Dossier mis à jour', detail: x.title, link: `/opportunites/${x.opportunity_id}#suivi` });
      }
    }

    items.sort((a, b) => (a.at < b.at ? 1 : -1));
    const lr = lastRead ? new Date(lastRead).getTime() : 0;
    for (const it of items) it.unread = it.kind === 'echeance' || it.kind === 'nouveautes' ? true : new Date(it.at).getTime() > lr;
    const messagesNonLus = items.filter(i => i.kind === 'message' && i.unread).length;
    const now = Date.now();
    const aNePasManquer = [...picks.values()]
      .filter(x => !x.deadline || new Date(x.deadline).getTime() > now)
      .sort((a, b) => (a.deadline ? new Date(a.deadline).getTime() : Infinity) - (b.deadline ? new Date(b.deadline).getTime() : Infinity))
      .slice(0, 8);
    const pouls = await marketPulse({ userId: o.userId, companyId: o.companyId, sessionId: o.sessionId }).catch((e: any) => { logger.warn('[Espace] pouls :', e?.message); return null; });
    const body = { summary: { nouveautes, echeances, messagesNonLus, dossiersEnCours }, items: items.slice(0, 40), lastReadAt: lastRead, searches: searches.length, aNePasManquer, pouls };
    cache.set(cacheKey, { at: Date.now(), body });
    if (cache.size > 500) cache.delete(cache.keys().next().value as string);
    res.json({ ...body, visit });
  } catch (err) { logger.error('[Espace] fil :', err); res.status(503).json({ error: 'unavailable' }); }
});

// Tout marquer comme lu (messages et étapes de dossier). Les nouveautés d'une recherche se lisent en l'ouvrant.
router.post('/lu', async (req: AuthRequest, res: Response) => {
  const key = ownerKey(owner(req));
  if (!key) return res.status(400).json({ error: 'session_required' });
  try {
    await readsSchema();
    await db.query(`INSERT INTO espace_reads (owner_key, last_read_at) VALUES ($1, NOW()) ON CONFLICT (owner_key) DO UPDATE SET last_read_at = NOW()`, [key]);
    for (const k of [...cache.keys()]) if (k.startsWith(`${key}|`)) cache.delete(k);
    res.json({ ok: true });
  } catch (err) { logger.error('[Espace] lu :', err); res.status(503).json({ error: 'unavailable' }); }
});

// Une recherche suivie a été ouverte : ses annonces actuelles ne sont plus « nouvelles ».
router.post('/recherche-vue/:id', async (req: AuthRequest, res: Response) => {
  const o = owner(req); const key = ownerKey(o);
  if (!key || !UUID.test(req.params.id)) return res.status(400).json({ error: 'invalid' });
  try {
    await readsSchema(); await ensureSavedSearchSchema();
    await db.query(`UPDATE saved_searches SET last_viewed_at = NOW() WHERE id = $1 AND deleted_at IS NULL
      AND ((user_id IS NOT NULL AND user_id = $2) OR (session_id IS NOT NULL AND session_id = $3))`, [req.params.id, o.userId, o.sessionId]);
    for (const k of [...cache.keys()]) if (k.startsWith(`${key}|`)) cache.delete(k);
    res.json({ ok: true });
  } catch (err) { logger.error('[Espace] recherche vue :', err); res.status(503).json({ error: 'unavailable' }); }
});

export default router;
