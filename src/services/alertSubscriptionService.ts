import crypto from 'crypto';
import { db } from '../config/database';
import { logger } from '../utils/logger';
import { deliverEmail, DeliveryStatus } from './deliveryLogService';
import { isSuppressed, normEmail, canSignLinks, unsubscribeUrl } from './contactPreferenceService';

// ============================================================================
// ALERTS BY TRADE AND AREA (client brief 31 Oct, part D: "Alertes correspondant au métier et à la zone demandés")
//
// A visitor who searched a trade + area can ask for e-mail alerts. Nothing is assumed: the request records the
// wording shown, then a confirmation e-mail must be clicked (double opt-in). Every alert carries a one-click
// unsubscribe. Real sending stays OFF until ALERT_EMAILS_ENABLED=true (templates/provider validated): while off, the
// subscription is saved and the answer says plainly that no e-mail was sent.
// ============================================================================

export const alertEmailsEnabled = () => process.env.ALERT_EMAILS_ENABLED === 'true';
export const ALERT_CONSENT_TEXT = "Je souhaite recevoir par e-mail les nouvelles opportunités correspondant à ce métier et à cette zone. Je peux me désinscrire à tout moment.";
const MAX_PER_DIGEST = 10;

const sign = (kind: string, id: string) => crypto.createHmac('sha256', process.env.CONTACT_LINK_SECRET || process.env.JWT_SECRET || '').update(`${kind}:${id}`).digest('hex').slice(0, 32);
export const verifySig = (kind: string, id: string, sig: string): boolean => {
  if (!canSignLinks() || !sig) return false;
  const a = Buffer.from(sign(kind, id)); const b = Buffer.from(String(sig));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const link = (path: string, kind: string, id: string) => {
  const base = process.env.PUBLIC_API_URL;
  return base && canSignLinks() ? `${base.replace(/\/$/, '')}${path}?id=${id}&s=${sign(kind, id)}` : null;
};
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

export type SubscribeResult =
  | { ok: true; id: string; alreadyConfirmed: boolean; confirmationEmail: DeliveryStatus | 'not_needed' }
  | { ok: false; status: number; error: string };

export async function subscribe(args: { email: string; tradeId?: number | null; area?: string | null; sessionId?: string | null; consent: boolean }): Promise<SubscribeResult> {
  if (!args.consent) return { ok: false, status: 400, error: "Cochez la case pour confirmer que vous souhaitez recevoir ces alertes." };
  const email = args.email.trim();
  const area = args.area ? args.area.trim().slice(0, 100) : null;
  if (!args.tradeId && !area) return { ok: false, status: 400, error: 'Indiquez un métier ou une zone.' };
  if (await isSuppressed(email)) {
    return { ok: false, status: 409, error: "Cette adresse a demandé à ne plus être contactée. Elle doit d'abord modifier ses préférences de contact." };
  }
  const r = await db.query(
    `INSERT INTO alert_subscriptions (email, email_lower, trade_id, area, session_id, consent_text)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (email_lower, COALESCE(trade_id, 0), COALESCE(LOWER(area), ''))
     DO UPDATE SET unsubscribed_at = NULL, consent_at = NOW(), consent_text = EXCLUDED.consent_text,
                   confirmed_at = CASE WHEN alert_subscriptions.unsubscribed_at IS NULL THEN alert_subscriptions.confirmed_at ELSE NULL END
     RETURNING id, confirmed_at`,
    [email, normEmail(email), args.tradeId || null, area, args.sessionId || null, ALERT_CONSENT_TEXT]);
  const id: string = r.rows[0].id;
  if (r.rows[0].confirmed_at) return { ok: true, id, alreadyConfirmed: true, confirmationEmail: 'not_needed' };

  const confirmUrl = link('/api/alert-subscriptions/confirm', 'confirm', id);
  if (!alertEmailsEnabled() || !confirmUrl) {
    // Saved, but nothing left the building: the caller must not tell the visitor to check their inbox.
    return { ok: true, id, alreadyConfirmed: false, confirmationEmail: alertEmailsEnabled() ? 'not_configured' : 'disabled' };
  }
  const html = `<p>Bonjour,</p><p>Vous avez demandé à recevoir des alertes Marchés Direct. Pour les activer, confirmez votre adresse :</p>
    <p><a href="${confirmUrl}">Oui, je souhaite recevoir ces alertes</a></p>
    <p style="font-size:12px;color:#666">Si vous n'êtes pas à l'origine de cette demande, ignorez ce message : aucune alerte ne sera envoyée.</p>`;
  const out = await deliverEmail({ kind: 'alert', to: email, subject: 'Confirmez vos alertes Marchés Direct', html, ctx: { dedupeKey: null } });
  return { ok: true, id, alreadyConfirmed: false, confirmationEmail: out.status };
}

export async function confirm(id: string): Promise<boolean> {
  const r = await db.query(`UPDATE alert_subscriptions SET confirmed_at = COALESCE(confirmed_at, NOW()), unsubscribed_at = NULL WHERE id = $1 RETURNING id`, [id]);
  return r.rows.length > 0;
}
export async function unsubscribe(id: string): Promise<boolean> {
  const r = await db.query(`UPDATE alert_subscriptions SET unsubscribed_at = COALESCE(unsubscribed_at, NOW()) WHERE id = $1 RETURNING id`, [id]);
  return r.rows.length > 0;
}

/** One digest per confirmed subscription: opportunities published since the last alert, matching trade AND area. */
export async function sendDueAlerts(): Promise<{ sent: number; skipped: number; failed: number }> {
  const out = { sent: 0, skipped: 0, failed: 0 };
  if (!alertEmailsEnabled()) return out;                    // off = nothing happens, nothing is consumed
  const subs = await db.query(
    `SELECT id, email, trade_id, area, COALESCE(last_alert_at, confirmed_at) AS since
     FROM alert_subscriptions WHERE confirmed_at IS NOT NULL AND unsubscribed_at IS NULL`);
  for (const s of subs.rows) {
    try {
      if (await isSuppressed(s.email)) { out.skipped++; continue; }
      const stop = link('/api/alert-subscriptions/unsubscribe', 'unsub', s.id);
      if (!stop) { out.skipped++; continue; }                // never send an alert without a working unsubscribe link
      const params: any[] = [s.id, s.since];
      let where = `o.deleted_at IS NULL AND o.status IN ('active','updated') AND (o.deadline IS NULL OR o.deadline > NOW())
                   AND o.created_at > $2 AND NOT EXISTS (SELECT 1 FROM alert_sent_items i WHERE i.subscription_id = $1 AND i.opportunity_id = o.id)`;
      if (s.trade_id) { params.push(s.trade_id); where += ` AND o.trade_id = $${params.length}`; }
      if (s.area) {
        params.push(s.area);
        const n = params.length;
        where += ` AND (o.location_department = $${n} OR LOWER(o.location_region) = LOWER($${n}) OR LOWER(o.location_city) = LOWER($${n}))`;
      }
      const m = await db.query(`SELECT o.id, o.title, o.location_city, o.deadline FROM opportunities o WHERE ${where} ORDER BY o.created_at DESC LIMIT ${MAX_PER_DIGEST}`, params);
      if (m.rows.length === 0) { out.skipped++; continue; }
      const site = (process.env.FRONTEND_URL || '').replace(/\/$/, '');
      const items = m.rows.map((o: any) =>
        `<li><a href="${site}/opportunites/${o.id}">${esc(o.title)}</a>${o.location_city ? ` — ${esc(o.location_city)}` : ''}${o.deadline ? ` (avant le ${new Date(o.deadline).toLocaleDateString('fr-FR')})` : ''}</li>`).join('');
      const html = `<p>Bonjour,</p><p>Nouvelles opportunités correspondant à votre alerte :</p><ul>${items}</ul>
        <p style="font-size:12px;color:#666"><a href="${stop}">Me désinscrire de cette alerte</a></p>`;
      const sent = await deliverEmail({ kind: 'alert', to: s.email, subject: `${m.rows.length} nouvelle(s) opportunité(s) pour votre alerte`, html, ctx: { dedupeKey: null } });
      if (sent.sent) {
        for (const o of m.rows) await db.query(`INSERT INTO alert_sent_items (subscription_id, opportunity_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [s.id, o.id]);
        await db.query(`UPDATE alert_subscriptions SET last_alert_at = NOW() WHERE id = $1`, [s.id]);
        out.sent++;
      } else out.failed++;                                   // not advanced: the same items are retried next sweep
    } catch (err) {
      logger.error(`Alert sweep error for subscription ${s.id} (non-fatal):`, err);
      out.failed++;
    }
  }
  return out;
}
