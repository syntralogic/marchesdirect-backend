import { db } from '../config/database';
import { logger } from '../utils/logger';

// Surveillance de toute la chaîne (6 nov., demande de Hedi : « que le système se surveille lui-même »).
// Chaque maillon a une règle écrite et mesurable ; le résultat est vert (ok), orange (warn), rouge (ko) ou
// « non mesuré » (unknown) — jamais vert par défaut. Lecture seule : aucune IA, aucun appel payant, aucun envoi.
// Un instantané est gardé chaque jour (health_snapshots) pour comparer avec la veille et la semaine passée.
export type Check = { id: string; group: string; label: string; status: 'ok' | 'warn' | 'ko' | 'unknown'; value: string; rule: string; detail?: string };

const ago = (d: Date | string | null) => (d ? (Date.now() - new Date(d).getTime()) / 3600000 : null);
const fmtH = (h: number | null) => (h == null ? 'jamais' : h < 1 ? `il y a ${Math.round(h * 60)} min` : h < 48 ? `il y a ${Math.round(h)} h` : `il y a ${Math.round(h / 24)} jours`);
const n = (v: unknown) => Number(v || 0);
const q = async (sql: string, p: any[] = []) => (await db.query(sql, p)).rows;
const safe = async <T>(f: () => Promise<T>, fallback: T): Promise<T> => { try { return await f(); } catch (e: any) { logger.warn(`[Santé] contrôle impossible : ${e?.code || e?.message}`); return fallback; } };

export async function ensureHealthSchema() {
  await db.query(`CREATE TABLE IF NOT EXISTS health_snapshots (day DATE PRIMARY KEY, metrics JSONB NOT NULL, checks JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
}

export async function runHealthChecks(): Promise<{ at: string; overall: Check['status']; checks: Check[]; metrics: Record<string, number> }> {
  const checks: Check[] = []; const metrics: Record<string, number> = {};
  const add = (c: Check) => checks.push(c);

  // 1. Import : chaque source active, dernier import réussi au regard de sa fréquence
  const sources = await safe(() => q(`
    SELECT ds.id, ds.code, ds.name, ds.frequency_hours, ds.last_run,
           (SELECT MAX(completed_at) FROM connector_logs c WHERE c.source_id = ds.id AND c.status = 'success') AS last_ok,
           (SELECT status FROM connector_logs c WHERE c.source_id = ds.id ORDER BY started_at DESC NULLS LAST LIMIT 1) AS last_status,
           (SELECT error_message FROM connector_logs c WHERE c.source_id = ds.id AND c.status = 'failed' ORDER BY started_at DESC NULLS LAST LIMIT 1) AS last_error,
           (SELECT COUNT(*) FROM connector_logs c WHERE c.source_id = ds.id AND c.status = 'failed' AND c.started_at >= NOW() - INTERVAL '24 hours') AS fails24,
           (SELECT COUNT(*) FROM opportunities o WHERE o.source_id = ds.id AND o.created_at >= NOW() - INTERVAL '24 hours') AS new24
      FROM data_sources ds WHERE ds.active = true AND COALESCE(ds.code, '') <> 'editorial_catalog' ORDER BY ds.code`), [] as any[]);
  for (const s of sources) {
    // Un passage sans erreur compte même s'il n'a rien écrit dans connector_logs (ex. DECP : plafond volontaire de
    // 100 000 attributions atteint, le passage est sauté et seul data_sources.last_run avance).
    const lastPass = s.last_status === 'failed' ? s.last_ok : (s.last_ok && s.last_run ? (new Date(s.last_ok) > new Date(s.last_run) ? s.last_ok : s.last_run) : s.last_ok || s.last_run);
    const h = ago(lastPass); const f = n(s.frequency_hours) || 24;
    const status = h == null ? 'ko' : h > f * 4 ? 'ko' : h > f * 2 ? 'warn' : s.last_status === 'failed' ? 'warn' : 'ok';
    add({ id: `import.${s.code}`, group: 'Import des annonces', label: `Source ${s.name || s.code}`, status,
      value: `dernier passage sans erreur ${fmtH(h)} · ${n(s.new24)} nouvelles en 24 h${n(s.fails24) ? ` · ${n(s.fails24)} échec(s) en 24 h` : ''}`,
      // Cause technique courte (ex. « status code 400 »), sans adresse ni clé : de quoi diagnostiquer.
      detail: s.last_error ? String(s.last_error).replace(/https?:\/\/\S+/g, '[url]').replace(/[A-Za-z0-9_-]{24,}/g, '[…]').slice(0, 300) : undefined,
      rule: `vert si importée depuis moins de ${f * 2} h (2 × sa fréquence de ${f} h), rouge au-delà de ${f * 4} h` });
    metrics[`new24_${s.code}`] = n(s.new24);
  }
  const tot = (await safe(() => q(`SELECT
      COUNT(*) FILTER (WHERE o.created_at >= NOW() - INTERVAL '24 hours')::int AS new24,
      COUNT(*) FILTER (WHERE o.status = 'active' AND NOT COALESCE(o.is_cancelled, false) AND COALESCE(l.notice_deadline, o.deadline) >= NOW() AND COALESCE(l.notice_deadline, o.deadline) <= NOW() + INTERVAL '3 years')::int AS open,
      COUNT(*) FILTER (WHERE o.status = 'active' AND COALESCE(l.notice_deadline, o.deadline) IS NULL)::int AS verify,
      COUNT(*) FILTER (WHERE o.status = 'active' AND (o.deadline IS NULL OR o.deadline >= NOW()) AND l.opportunity_id IS NULL)::int AS unread,
      COUNT(*) FILTER (WHERE o.status = 'active' AND o.deadline < NOW() - INTERVAL '3 hours')::int AS stale_status
    FROM opportunities o LEFT JOIN opportunity_locations l ON l.opportunity_id = o.id
    LEFT JOIN data_sources ds ON ds.id = o.source_id
    WHERE o.deleted_at IS NULL AND COALESCE(ds.code, '') <> 'editorial_catalog'`), [{}] as any[]))[0] || {};
  Object.assign(metrics, { new24: n(tot.new24), open: n(tot.open), verify: n(tot.verify), unread: n(tot.unread), staleStatus: n(tot.stale_status) });
  add({ id: 'import.total', group: 'Import des annonces', label: 'Nouvelles annonces en 24 h (toutes sources)', status: metrics.new24 === 0 ? 'ko' : metrics.new24 < 100 ? 'warn' : 'ok',
    value: `${metrics.new24}`, rule: 'rouge si aucune, orange sous 100 (un jour ouvré normal en apporte plusieurs centaines)' });

  // 2. Qualité des données
  const prev = await safe(() => q(`SELECT metrics FROM health_snapshots WHERE day <= CURRENT_DATE - 7 ORDER BY day DESC LIMIT 1`), [] as any[]);
  const prevOpen = prev[0]?.metrics?.open;
  add({ id: 'data.open', group: 'Qualité des données', label: 'Marchés ouverts (date limite confirmée)', status: prevOpen && metrics.open < prevOpen * 0.7 ? 'warn' : metrics.open > 0 ? 'ok' : 'ko',
    value: `${metrics.open}${prevOpen ? ` (il y a 7 jours : ${prevOpen})` : ''}`, rule: 'orange si baisse de plus de 30 % en 7 jours (signe d’un import arrêté)' });
  const openish = metrics.open + metrics.unread;
  add({ id: 'data.location', group: 'Qualité des données', label: 'Annonces ouvertes relues (lieu et heure)', status: metrics.unread === 0 ? 'ok' : metrics.unread / Math.max(1, openish) < 0.1 ? 'warn' : 'ko',
    value: `${metrics.unread} non relues`, rule: 'vert si toutes relues, orange sous 10 % en attente' });
  add({ id: 'data.status', group: 'Qualité des données', label: 'Statuts à jour après la date limite', status: metrics.staleStatus < 50 ? 'ok' : metrics.staleStatus < 500 ? 'warn' : 'ko',
    value: `${metrics.staleStatus} annonces encore « actives » 3 h après leur date limite`, rule: 'le job horaire des statuts doit les passer en « expirée »' });
  add({ id: 'data.verify', group: 'Qualité des données', label: 'Annonces sans date limite', status: 'ok', value: `${metrics.verify}`, rule: 'information : affichées « à vérifier », jamais comptées comme ouvertes' });

  // 3. Parcours client
  const mail = process.env.EMAIL_DELIVERY_ENABLED === 'true' && !!process.env.RESEND_API_KEY && !!process.env.EMAIL_FROM;
  add({ id: 'journey.email', group: 'Parcours client', label: 'Envoi des e-mails (lien magique, dossier, alertes)', status: mail ? 'ok' : 'ko',
    value: mail ? 'configuré' : 'en pause (EMAIL_DELIVERY_ENABLED)', rule: 'le lien magique et l’envoi du dossier en dépendent' });
  const del = (await safe(() => q(`SELECT COUNT(*) FILTER (WHERE status = 'sent')::int AS sent, COUNT(*) FILTER (WHERE status = 'failed')::int AS failed FROM message_deliveries WHERE created_at >= NOW() - INTERVAL '24 hours'`), [{}] as any[]))[0] || {};
  add({ id: 'journey.deliveries', group: 'Parcours client', label: 'Messages envoyés en 24 h', status: n(del.failed) > 0 ? 'warn' : 'ok', value: `${n(del.sent)} envoyés, ${n(del.failed)} en échec`, rule: 'orange dès un échec' });
  const crm = (await safe(() => q(`SELECT COUNT(*) FILTER (WHERE crm_sync_status = 'failed')::int AS failed, COUNT(*) FILTER (WHERE crm_sync_status IN ('pending', 'queued'))::int AS pending, MAX(created_at) AS last FROM crm_leads WHERE created_at >= NOW() - INTERVAL '7 days'`), [null] as any[]))[0];
  add(crm ? { id: 'journey.hubspot', group: 'Parcours client', label: 'Demandes de contact remontées dans HubSpot (7 jours)', status: n(crm.failed) > 0 ? 'ko' : n(crm.pending) > 5 ? 'warn' : 'ok',
    value: `${n(crm.failed)} en échec, ${n(crm.pending)} en attente · dernière demande ${fmtH(ago(crm.last))}`, rule: 'rouge dès une demande non remontée' }
    : { id: 'journey.hubspot', group: 'Parcours client', label: 'Demandes de contact remontées dans HubSpot', status: 'unknown', value: 'non mesuré', rule: 'table crm_leads illisible' });

  // 4. Coûts
  const ai = (await safe(() => q(`SELECT spent_microusd FROM ai_daily_spend WHERE day = CURRENT_DATE`), [] as any[]))[0];
  const aiUsd = n(ai?.spent_microusd) / 1e6;
  add({ id: 'cost.ai', group: 'Coûts', label: 'Dépense IA aujourd’hui', status: aiUsd < 0.8 ? 'ok' : aiUsd < 1 ? 'warn' : 'ko', value: `${aiUsd.toFixed(2)} $ sur 1 $ autorisé`, rule: 'plafond quotidien de 1 $' });
  const pap = (await safe(() => q(`SELECT COUNT(*)::int AS n FROM pappers_api_calls WHERE called_at >= CURRENT_DATE`), [{ n: null }] as any[]))[0];
  add({ id: 'cost.pappers', group: 'Coûts', label: 'Appels Pappers aujourd’hui', status: pap?.n == null ? 'unknown' : n(pap.n) < 150 ? 'ok' : n(pap.n) < 400 ? 'warn' : 'ko',
    value: pap?.n == null ? 'non mesuré' : `${n(pap.n)}`, rule: 'orange au-delà de 150 par jour, rouge au-delà de 400' });
  metrics.pappersToday = n(pap?.n); metrics.aiUsdToday = aiUsd;

  const overall: Check['status'] = checks.some(c => c.status === 'ko') ? 'ko' : checks.some(c => c.status === 'warn') ? 'warn' : 'ok';
  return { at: new Date().toISOString(), overall, checks, metrics };
}

export async function snapshotHealth() {
  await ensureHealthSchema();
  const r = await runHealthChecks();
  await db.query(`INSERT INTO health_snapshots (day, metrics, checks) VALUES (CURRENT_DATE, $1, $2)
    ON CONFLICT (day) DO UPDATE SET metrics = EXCLUDED.metrics, checks = EXCLUDED.checks, created_at = NOW()`, [JSON.stringify(r.metrics), JSON.stringify(r.checks)]);
  const red = r.checks.filter(c => c.status === 'ko');
  if (red.length) logger.warn(`[Santé] ${red.length} maillon(s) au rouge : ${red.map(c => c.label).join(' ; ')}`);
  return r;
}
