import { Router, Request, Response } from 'express';
import axios from 'axios';
import { createHmac } from 'crypto';
import { db } from '../config/database';
import { logger } from '../utils/logger';

// Sonde du parcours critique (7 nov., après la panne de « Vos marchés » : entreprise reconnue mais liste en erreur
// pendant une journée sans que personne ne le voie). GET /api/health/parcours rejoue, par de vraies requêtes HTTP sur
// ce serveur, ce qu'un visiteur fait : identification mémorisée → liste « Vos marchés » → recherche « climatisation »
// en Gironde → ouverture d'une fiche. 200 si tout répond avec des annonces, 503 sinon, avec le détail de l'étape.
// À brancher sur une surveillance externe (UptimeRobot) : Hedi est prévenu en quelques minutes.
// Aucun effet de bord : pas d'identification Pappers/INSEE (la session de sonde est insérée depuis le cache
// d'identification), pas d'événement de parcours, pas de HubSpot.
const router = Router();
const PROBE_SESSION = 'health-probe-' + createHmac('sha256', process.env.JWT_SECRET!).update('parcours-v1').digest('hex').slice(0, 40);
const PROBE_SIRET = process.env.HEALTH_PROBE_SIRET || '92939307200012'; // Verifrance Habitat (CVC, 92) : l'entreprise de référence de Hedi
const PROBE_QUERY = process.env.HEALTH_PROBE_QUERY || 'climatisation';
const PROBE_DEPT = process.env.HEALTH_PROBE_DEPT || '33';

async function ensureProbeSession(): Promise<string | null> {
  const known = await db.query('SELECT 1 FROM siret_lookups WHERE session_id = $1', [PROBE_SESSION]);
  if (known.rows.length) return null;
  const c = await db.query('SELECT company_data FROM company_lookup_cache WHERE siren = $1', [PROBE_SIRET.slice(0, 9)]);
  if (!c.rows[0]?.company_data) return `entreprise de référence ${PROBE_SIRET} absente du cache d'identification`;
  await db.query(`INSERT INTO siret_lookups (session_id, siret, company_data) VALUES ($1, $2, $3::jsonb) ON CONFLICT (session_id) DO NOTHING`,
    [PROBE_SESSION, PROBE_SIRET, JSON.stringify(c.rows[0].company_data)]);
  return null;
}

let inflight: Promise<{ ok: boolean; steps: Record<string, unknown> }> | null = null;
let lastResult: { at: number; value: { ok: boolean; steps: Record<string, unknown> } } | null = null;
async function runProbe(): Promise<{ ok: boolean; steps: Record<string, unknown> }> {
  const base = `http://127.0.0.1:${process.env.PORT || 5000}/api`;
  const steps: Record<string, unknown> = {};
  const timed = async <T>(name: string, fn: () => Promise<T>, check: (v: T) => string | null): Promise<T | null> => {
    const t0 = Date.now();
    try { const v = await fn(); const bad = check(v); steps[name] = { ok: !bad, ms: Date.now() - t0, ...(bad ? { error: bad } : {}) }; return bad ? null : v; }
    catch (e: any) { steps[name] = { ok: false, ms: Date.now() - t0, error: String(e?.response?.status ? `HTTP ${e.response.status} ${JSON.stringify(e.response.data).slice(0, 200)}` : e?.message || e).slice(0, 300) }; return null; }
  };
  const http = axios.create({ timeout: 25000, validateStatus: () => true });
  const get = async (path: string) => { const r = await http.get(base + path); if (r.status !== 200) throw Object.assign(new Error(`HTTP ${r.status}`), { response: r }); return r.data; };

  await timed('session', () => ensureProbeSession(), v => v);
  if (!(steps.session as { ok: boolean }).ok) return { ok: false, steps };
  const status = await timed('identification', () => get(`/siret/status?sessionId=${PROBE_SESSION}`), v => v?.companyKnown ? null : 'companyKnown faux');
  const ranked = await timed('vos_marches', () => get(`/opportunities/ranked/candidates?sessionId=${PROBE_SESSION}&loc=2`),
    v => Array.isArray(v?.items) && v.items.length > 0 ? null : `aucune annonce (${JSON.stringify(v).slice(0, 120)})`);
  const search = await timed('recherche', () => get(`/opportunities?q=${encodeURIComponent(PROBE_QUERY)}&department=${PROBE_DEPT}&loc=2&limit=5`),
    v => Array.isArray(v?.results) && v.results.length > 0 ? null : 'aucun résultat');
  const firstId = (ranked as any)?.items?.[0]?.id || (search as any)?.results?.[0]?.id;
  if (firstId) await timed('fiche', () => get(`/opportunities/${firstId}?loc=2`), v => v?.id ? null : 'fiche vide');
  const ok = !!status && !!ranked && !!search && Object.values(steps).every((s: any) => s.ok);
  return { ok, steps };
}

router.get('/parcours', async (_req: Request, res: Response) => {
  try {
    // A public monitor must not become a way to repeat expensive SQL nonstop.
    const fresh = lastResult && Date.now() - lastResult.at < (lastResult.value.ok ? 60_000 : 10_000);
    if (!fresh) {
      inflight ||= runProbe().then(value => { lastResult = { at: Date.now(), value }; return value; })
        .finally(() => { inflight = null; });
      await inflight;
    }
    const r = lastResult!.value;
    if (!r.ok) logger.error('[sonde parcours] échec', r.steps);
    res.set('Cache-Control', 'no-store');
    res.status(r.ok ? 200 : 503).json({ status: r.ok ? 'ok' : 'ko', checkedAt: new Date(lastResult!.at).toISOString(), ...r });
  } catch (err: any) {
    logger.error('[sonde parcours] erreur', err);
    res.status(503).json({ status: 'ko', error: 'Vérification du parcours indisponible.' });
  }
});

export default router;

