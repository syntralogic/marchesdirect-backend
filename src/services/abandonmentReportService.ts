import { db } from '../config/database';

// ============================================================================
// JOURNEY ABANDONMENT REPORT (client brief, part F: "rapports d'abandon du parcours")
//
// Computed from the Supabase event journal (visitor_events), which is the complete history; HubSpot only holds
// summaries, and its report builder cannot draw "sessions that stopped at step X" from them. A visitor = a session.
// ============================================================================

export const FUNNEL_STEPS = [
  'search', 'offer_view', 'company_selected', 'analysis_started', 'analysis_completed', 'dossier_preview', 'request',
] as const;
export const REQUEST_CODES = ['dossier_requested', 'callback_requested', 'appointment_booked'] as const;
const CODES = [
  'search', 'offer_view', 'view_opportunity', 'company_selected', 'analysis_started', 'analysis_completed',
  'dossier_preview', ...REQUEST_CODES,
];

export type FunnelRow = { step: string; sessions: number; pctOfPrevious: number | null; pctOfFirst: number | null };

// Pure: turns per-step session counts into the funnel table.
export function buildFunnel(counts: Record<string, number>): FunnelRow[] {
  const first = counts[FUNNEL_STEPS[0]] || 0;
  return FUNNEL_STEPS.map((step, i) => {
    const sessions = counts[step] || 0;
    const prev = i === 0 ? null : counts[FUNNEL_STEPS[i - 1]] || 0;
    return {
      step, sessions,
      pctOfPrevious: prev === null ? null : prev > 0 ? Math.round((sessions / prev) * 1000) / 10 : null,
      pctOfFirst: first > 0 ? Math.round((sessions / first) * 1000) / 10 : null,
    };
  });
}

export async function abandonmentReport(daysRaw: number) {
  const days = Math.min(Math.max(Math.floor(daysRaw) || 30, 1), 365);
  const base = `WITH ev AS (
      SELECT session_id,
             CASE WHEN event_type = 'view_opportunity' THEN 'offer_view' ELSE event_type END AS t,
             COALESCE(occurred_at, created_at) AS at,
             COALESCE(analysis_id, session_id || ':' || COALESCE(opportunity_id, event_data->>'opportunityId', '')) AS akey
      FROM visitor_events
      WHERE COALESCE(occurred_at, created_at) >= NOW() - ($1::int * INTERVAL '1 day') AND event_type = ANY($2)
    )`;
  const args = [days, CODES];
  const [steps, analyses, lastStep, preview] = await Promise.all([
    db.query(`${base}
      SELECT CASE WHEN t = ANY($3) THEN 'request' ELSE t END AS step, COUNT(DISTINCT session_id)::int AS n
      FROM ev GROUP BY 1`, [...args, REQUEST_CODES]),
    db.query(`${base}
      SELECT COUNT(*)::int AS started,
             COUNT(*) FILTER (WHERE done)::int AS completed
      FROM (SELECT akey, bool_or(t = 'analysis_completed') AS done FROM ev
            WHERE t IN ('analysis_started', 'analysis_completed') GROUP BY akey
            HAVING bool_or(t = 'analysis_started')) a`, args),
    db.query(`${base}
      SELECT last_t AS step, COUNT(*)::int AS n FROM (
        SELECT session_id, (array_agg(t ORDER BY at DESC))[1] AS last_t, bool_or(t = ANY($3)) AS requested
        FROM ev GROUP BY session_id) s
      WHERE NOT requested GROUP BY last_t ORDER BY n DESC`, [...args, REQUEST_CODES]),
    db.query(`${base}
      SELECT COUNT(*)::int AS n FROM (
        SELECT session_id FROM ev GROUP BY session_id
        HAVING bool_or(t = 'dossier_preview') AND NOT bool_or(t = ANY($3))) s`, [...args, REQUEST_CODES]),
  ]);
  const counts: Record<string, number> = {};
  for (const r of steps.rows) counts[r.step] = r.n;
  const started = analyses.rows[0]?.started || 0;
  const completed = analyses.rows[0]?.completed || 0;
  return {
    days,
    funnel: buildFunnel(counts),
    analyses: { started, completed, abandoned: started - completed },
    lastStepOfSessionsWithoutRequest: lastStep.rows as { step: string; n: number }[],
    dossierPreviewWithoutRequest: preview.rows[0]?.n || 0,
  };
}
