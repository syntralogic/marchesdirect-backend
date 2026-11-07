import { db } from '../config/database';
import { logger } from '../utils/logger';
import { deliverEmail } from './deliveryLogService';
import { isSuppressed } from './contactPreferenceService';
import { alertEmailsEnabled } from './alertSubscriptionService';
import { searchOpportunities } from '../routes/opportunities';
import { ensureSavedSearchSchema } from '../routes/savedSearches';

// 7 nov. (diagnostic, point 5) : une alerte doit être fidèle à la recherche sauvegardée. Elle rejoue donc la même
// recherche que le site (mêmes métiers, familles, zone, rayon, budget, types, échéance), triée par publication, et ne
// retient que les annonces jamais envoyées pour cette recherche et publiées après l'activation de l'alerte. 10 au plus
// par e-mail, les plus anciennes d'abord : ce qui reste part au passage suivant, rien n'est oublié. Les envois restent
// coupés tant que ALERT_EMAILS_ENABLED n'est pas « true » (décision Hedi).
const MAX_PER_DIGEST = 10;
const esc = (s: string) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

export async function runSavedSearch(query: string, extra: Record<string, string> = {}): Promise<{ results: any[]; total: number } | null> {
  const q: Record<string, string> = {};
  new URLSearchParams(query).forEach((v, k) => { q[k] = v; });
  Object.assign(q, { loc: '2', status: 'active', limit: '50', sort: 'recent' }, extra);
  delete q.page; delete q.source; delete q.zone;
  let body: any = null; let code = 200;
  const fakeRes: any = { statusCode: 200, status(c: number) { code = c; return this; }, set() { return this; }, json(b: any) { body = b; return this; } };
  await searchOpportunities({ query: q, headers: {}, ip: '127.0.0.1', get() { return ''; } } as any, fakeRes);
  if (code >= 400 || !body) return null;
  return { results: body.results || [], total: body.pagination?.total ?? 0 };
}

/** Annonces nouvelles pour une recherche sauvegardée (non envoyées, publiées après la ligne de départ). */
export async function newItemsFor(s: { id: string; query: string; alert_baseline_at: string | Date | null }, max = MAX_PER_DIGEST): Promise<any[]> {
  const r = await runSavedSearch(s.query, { recent_days: '14' });
  if (!r) return [];
  const since = s.alert_baseline_at ? new Date(s.alert_baseline_at).getTime() : 0;
  const ids = r.results.map((o: any) => o.id);
  if (!ids.length) return [];
  const sent = await db.query(`SELECT opportunity_id FROM saved_search_sent_items WHERE saved_search_id = $1 AND opportunity_id = ANY($2::uuid[])`, [s.id, ids]);
  const done = new Set(sent.rows.map((x: any) => x.opportunity_id));
  return r.results
    .filter((o: any) => !done.has(o.id) && new Date(o.publication_date || o.created_at || 0).getTime() >= since)
    .sort((a: any, b: any) => new Date(a.publication_date || 0).getTime() - new Date(b.publication_date || 0).getTime())
    .slice(0, max);
}

export async function sendSavedSearchAlerts(): Promise<{ sent: number; skipped: number; failed: number; pending: number }> {
  const out = { sent: 0, skipped: 0, failed: 0, pending: 0 };
  await ensureSavedSearchSchema();
  const subs = await db.query(`SELECT s.id, s.label, s.query, s.alert_baseline_at, COALESCE(u.email, s.email_lower) AS email
    FROM saved_searches s LEFT JOIN users u ON u.id = s.user_id
    WHERE s.deleted_at IS NULL AND s.alert_enabled AND COALESCE(u.email, s.email_lower) IS NOT NULL`);
  const site = (process.env.FRONTEND_URL || 'https://www.marchesdirect.fr').replace(/\/$/, '');
  for (const s of subs.rows) {
    try {
      const items = await newItemsFor(s);
      if (!items.length) { out.skipped++; continue; }
      if (!alertEmailsEnabled()) { out.pending++; continue; }      // coupé : rien n'est envoyé ni consommé
      if (await isSuppressed(s.email)) { out.skipped++; continue; }
      const lis = items.map((o: any) => `<li><a href="${site}/opportunites/${o.id}">${esc(o.title)}</a>${o.buyer_city || o.location_city ? ` — ${esc(o.buyer_city || o.location_city)}` : ''}${o.deadline_checked || o.deadline ? ` (avant le ${new Date(o.deadline_checked || o.deadline).toLocaleDateString('fr-FR')})` : ''}</li>`).join('');
      const html = `<p>Bonjour,</p><p>${items.length} nouvelle${items.length > 1 ? 's' : ''} annonce${items.length > 1 ? 's' : ''} pour votre recherche « ${esc(s.label)} » :</p><ul>${lis}</ul>
        <p><a href="${site}/vos-marches?${esc(s.query)}">Voir la recherche complète</a></p>
        <p style="font-size:12px;color:#666">Vous recevez ce message parce que vous avez activé l'alerte sur cette recherche dans Mon espace. Vous pouvez l'y désactiver à tout moment.</p>`;
      const sent = await deliverEmail({ kind: 'alert', to: s.email, subject: `${items.length} nouvelle${items.length > 1 ? 's' : ''} annonce${items.length > 1 ? 's' : ''} · ${s.label}`, html, ctx: { dedupeKey: null } });
      if (sent.sent) {
        for (const o of items) await db.query(`INSERT INTO saved_search_sent_items (saved_search_id, opportunity_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [s.id, o.id]);
        await db.query(`UPDATE saved_searches SET last_alert_at = NOW() WHERE id = $1`, [s.id]);
        out.sent++;
      } else out.failed++;
    } catch (err) { logger.error(`[recherches] alerte ${s.id} :`, err); out.failed++; }
  }
  return out;
}
