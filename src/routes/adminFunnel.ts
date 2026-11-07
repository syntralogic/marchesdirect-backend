import { Router, Request, Response } from 'express';
import { db } from '../config/database';
import { logger } from '../utils/logger';
import { authenticate, requireRole } from '../middleware/auth';
import { cached } from '../utils/ttlCache';

// Tableau de suivi interne (7 nov., demande de Hedi) : la progression des visiteurs vers l'accompagnement, par semaine,
// à partir des événements déjà enregistrés. Un favori n'est jamais compté comme une demande. Les packs vendus se
// déclarent à la main (l'équipe les saisit) : aucune vente n'est inventée. Données agrégées : aucune personne nommée.
const router = Router();
router.use(authenticate, requireRole(['admin', 'super_admin']));
let ready: Promise<void> | null = null;
const ensure = () => ready ||= db.query(`CREATE TABLE IF NOT EXISTS pack_sales (id SERIAL PRIMARY KEY, sold_on DATE NOT NULL, amount NUMERIC, label TEXT, lead_id UUID, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`).then(() => undefined).catch(e => { ready = null; throw e; });
const q = async (sql: string, p: unknown[] = []) => { try { return (await db.query(sql, p)).rows; } catch { return []; } };

router.get('/funnel', async (req: Request, res: Response) => {
  try {
    await ensure();
    const weeks = Math.max(4, Math.min(26, Number(req.query.weeks) || 8));
    const out = await cached(`admin:funnel:${weeks}`, 300_000, async () => {
      const W = `date_trunc('week', created_at)`;
      const since = `created_at >= date_trunc('week', NOW()) - ($1 || ' weeks')::interval`;
      const [visitors, searches, views, returning, companies, members, favs, savedSearches, needs, requests, sales, gaps] = await Promise.all([
        q(`SELECT ${W} AS w, COUNT(DISTINCT session_id)::int AS n FROM visitor_events WHERE ${since} GROUP BY 1`, [String(weeks)]),
        q(`SELECT ${W} AS w, COUNT(DISTINCT session_id)::int AS n FROM visitor_events WHERE event_type = 'search' AND ${since} GROUP BY 1`, [String(weeks)]),
        q(`SELECT ${W} AS w, COUNT(DISTINCT session_id)::int AS n FROM visitor_events WHERE event_type IN ('view_opportunity', 'offer_view') AND ${since} GROUP BY 1`, [String(weeks)]),
        // Revenus : sessions vues cette semaine ET au moins 2 jours distincts d'activité au total.
        q(`WITH days AS (SELECT session_id, COUNT(DISTINCT created_at::date) AS d FROM visitor_events WHERE created_at >= NOW() - INTERVAL '90 days' GROUP BY 1),
                wk AS (SELECT DISTINCT session_id, ${W} AS w FROM visitor_events WHERE ${since})
           SELECT wk.w, COUNT(*)::int AS n FROM wk JOIN days USING (session_id) WHERE days.d >= 2 GROUP BY 1`, [String(weeks)]),
        q(`SELECT ${W} AS w, COUNT(DISTINCT session_id)::int AS n FROM siret_lookups WHERE ${since} GROUP BY 1`, [String(weeks)]),
        q(`SELECT ${W} AS w, COUNT(*)::int AS n FROM site_members WHERE ${since} GROUP BY 1`, [String(weeks)]),
        q(`SELECT w, SUM(n)::int AS n FROM (SELECT ${W} AS w, COUNT(DISTINCT session_id) AS n FROM session_favorites WHERE ${since} GROUP BY 1
            UNION ALL SELECT ${W}, COUNT(DISTINCT user_id) FROM favorites WHERE ${since} GROUP BY 1) t GROUP BY 1`, [String(weeks)]),
        q(`SELECT ${W} AS w, COUNT(*)::int AS n FROM market_alerts WHERE ${since} GROUP BY 1`, [String(weeks)]),
        q(`SELECT ${W} AS w, COUNT(*)::int AS n FROM client_needs WHERE ${since} GROUP BY 1`, [String(weeks)]),
        q(`SELECT ${W} AS w, COUNT(*)::int AS n, COUNT(*) FILTER (WHERE lead_source IN ('callback_modal', 'contact_form', 'dossier_request', 'appointment'))::int AS voluntary FROM crm_leads WHERE ${since} GROUP BY 1`, [String(weeks)]),
        q(`SELECT date_trunc('week', sold_on) AS w, COUNT(*)::int AS n, COALESCE(SUM(amount), 0)::float AS amount FROM pack_sales WHERE sold_on >= date_trunc('week', NOW()) - ($1 || ' weeks')::interval GROUP BY 1`, [String(weeks)]),
        // Besoins mal servis : recherches fréquentes (métier × département) avec peu ou pas de résultats, 4 dernières semaines.
        q(`SELECT COALESCE(event_data->>'q', event_data->>'trade', '?') AS q, COALESCE(event_data->>'department', event_data->>'zone', '') AS dept,
              COUNT(*)::int AS searches, AVG(COALESCE((event_data->>'results')::numeric, (event_data->>'total')::numeric))::float AS avg_results
            FROM visitor_events WHERE event_type = 'search' AND created_at >= NOW() - INTERVAL '28 days' GROUP BY 1, 2 HAVING COUNT(*) >= 3 AND COALESCE(AVG(COALESCE((event_data->>'results')::numeric, (event_data->>'total')::numeric)), 0) < 3
            ORDER BY 3 DESC LIMIT 25`),
      ]);
      const key = (r: any) => new Date(r.w).toISOString().slice(0, 10);
      const allWeeks = new Set<string>(); for (const rows of [visitors, searches, views, returning, companies, members, favs, savedSearches, needs, requests, sales]) for (const r of rows) allWeeks.add(key(r));
      const m = (rows: any[], f: string = 'n') => Object.fromEntries(rows.map(r => [key(r), Number(r[f])]));
      const V = m(visitors), S = m(searches), O = m(views), R = m(returning), C = m(companies), M = m(members), F = m(favs), A = m(savedSearches), N = m(needs), Q = m(requests), QV = m(requests, 'voluntary'), P = m(sales), PA = m(sales, 'amount');
      const rows = [...allWeeks].sort().map(w => ({ week: w, visitors: V[w] || 0, searched: S[w] || 0, viewed: O[w] || 0, returning: R[w] || 0, companyIdentified: C[w] || 0,
        members: M[w] || 0, favorites: F[w] || 0, alerts: A[w] || 0, needsPublished: N[w] || 0, requests: Q[w] || 0, voluntaryRequests: QV[w] || 0, packsSold: P[w] || 0, packsAmount: PA[w] || 0 }));
      return { weeks: rows, underserved: gaps.map((g: any) => ({ query: g.q, department: g.dept, searches: g.searches, avgResults: g.avg_results != null ? Math.round(Number(g.avg_results) * 10) / 10 : null })),
        definitions: { visitors: 'sessions avec au moins un événement (visiteurs ayant accepté la mesure)', returning: 'sessions actives sur 2 jours distincts ou plus', requests: 'demandes reçues (toutes sources)', voluntaryRequests: 'rappel, question, dossier, rendez-vous demandés par le visiteur', packsSold: 'saisis à la main par l’équipe' } };
    });
    res.json(out);
  } catch (err) { logger.error('[suivi] funnel :', err); res.status(503).json({ error: 'unavailable' }); }
});

// POST /api/admin/funnel/pack-sale { soldOn, amount, label } : une vente d'accompagnement, déclarée par l'équipe.
router.post('/pack-sale', async (req: Request, res: Response) => {
  try {
    await ensure();
    const d = typeof req.body?.soldOn === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.body.soldOn) ? req.body.soldOn : new Date().toISOString().slice(0, 10);
    const amount = Number(req.body?.amount); const label = typeof req.body?.label === 'string' ? req.body.label.trim().slice(0, 200) : null;
    await db.query(`INSERT INTO pack_sales (sold_on, amount, label) VALUES ($1, $2, $3)`, [d, Number.isFinite(amount) && amount > 0 ? amount : null, label]);
    res.json({ ok: true });
  } catch (err) { logger.error('[suivi] vente :', err); res.status(503).json({ error: 'unavailable' }); }
});

export default router;
