import { db } from '../config/database';
import { logger } from '../utils/logger';
import { deliverEmail, recordDelivery } from './deliveryLogService';

// ============================================================================
// REMINDERS ("relances") - client brief 31 Oct, part D
//
//  - Scheduled when a dossier or callback request with an e-mail address is saved (never for a booked appointment).
//  - STOPPED when: an appointment is booked, a reply is received (staff mark it), or the person objects /
//    unsubscribes. Each stop is re-checked at send time, not only when the event happens.
//  - NOTHING is really sent until FOLLOW_UP_EMAILS_ENABLED=true, i.e. after the template, the provider and the
//    tests are validated. While off, a due reminder is closed as 'disabled' (no stale reminder is sent later)
//    and a 'disabled' delivery row says so. Sending also needs a working unsubscribe link (PUBLIC_API_URL + a secret).
// ============================================================================

export type StopReason = 'appointment_booked' | 'reply_received' | 'opted_out' | 'no_email';
export const FOLLOW_UP_DELAYS_HOURS = [48, 120];
export const followUpsEnabled = () => process.env.FOLLOW_UP_EMAILS_ENABLED === 'true';

export async function scheduleFollowUps(leadId: string): Promise<number> {
  try {
    const r = await db.query(
      `SELECT l.email, l.contact_mode, l.appointment_mode, l.reply_received_at, l.created_at
       FROM crm_leads l WHERE l.id = $1`, [leadId]);
    const lead = r.rows[0];
    if (!lead || !lead.email || lead.appointment_mode === 'slot' || lead.reply_received_at || lead.contact_mode === 'request-only') return 0;
    let n = 0;
    for (let i = 0; i < FOLLOW_UP_DELAYS_HOURS.length; i++) {
      const ins = await db.query(
        `INSERT INTO follow_ups (lead_id, step, due_at) VALUES ($1, $2, NOW() + ($3 || ' hours')::interval)
         ON CONFLICT (lead_id, step) DO NOTHING RETURNING id`,
        [leadId, i + 1, String(FOLLOW_UP_DELAYS_HOURS[i])]);
      n += ins.rows.length;
    }
    return n;
  } catch (err) {
    logger.error(`Could not schedule follow-ups for lead ${leadId} (non-fatal):`, err);
    return 0;
  }
}

export async function stopFollowUpsForLead(leadId: string, reason: StopReason): Promise<number> {
  const r = await db.query(
    `UPDATE follow_ups SET status = 'stopped', stop_reason = $2, processed_at = NOW() WHERE lead_id = $1 AND status = 'pending' RETURNING id`,
    [leadId, reason]);
  return r.rows.length;
}

/** Any request by the same person: an appointment or an objection on one request covers all of them. */
export async function stopFollowUpsForEmail(email: string, reason: StopReason): Promise<number> {
  try {
    const r = await db.query(
      `UPDATE follow_ups f SET status = 'stopped', stop_reason = $2, processed_at = NOW()
       FROM crm_leads l WHERE f.lead_id = l.id AND LOWER(l.email) = LOWER($1) AND f.status = 'pending' RETURNING f.id`,
      [email, reason]);
    return r.rows.length;
  } catch (err) {
    logger.error('Could not stop follow-ups (non-fatal):', err);
    return 0;
  }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

// DRAFT template: to be validated by the client before FOLLOW_UP_EMAILS_ENABLED is switched on.
export function buildFollowUpEmail(args: { firstName?: string | null; marketTitle?: string | null; step: number; unsubscribeUrl: string }) {
  const hello = `Bonjour${args.firstName ? ` ${esc(args.firstName)}` : ''},`;
  const about = args.marketTitle ? ` concernant « ${esc(args.marketTitle)} »` : '';
  const html = `
    <p>${hello}</p>
    <p>Vous avez demandé un dossier${about} sur Marchés Direct. Souhaitez-vous qu'un chargé d'affaires vous aide à le finaliser ?</p>
    <p>Répondez simplement à ce message, ou réservez un rendez-vous directement sur le site.</p>
    <p>— L'équipe Marchés Direct</p>
    <p style="font-size:12px;color:#666">Vous ne souhaitez plus recevoir ces messages ? <a href="${args.unsubscribeUrl}">Ne plus être relancé</a>.</p>`;
  return { subject: args.step === 1 ? 'Votre dossier Marchés Direct : besoin d\'aide ?' : 'Dernier rappel pour votre dossier', html };
}

export type ProcessResult = { sent: number; stopped: number; disabled: number; failed: number };

export async function processDueFollowUps(limit = 50): Promise<ProcessResult> {
  const res: ProcessResult = { sent: 0, stopped: 0, disabled: 0, failed: 0 };
  const { isSuppressed, unsubscribeUrl } = await import('./contactPreferenceService');
  const due = await db.query(
    `SELECT f.id, f.lead_id, f.step, l.email, l.first_name, l.contact_mode, l.reply_received_at, o.title
     FROM follow_ups f JOIN crm_leads l ON l.id = f.lead_id LEFT JOIN opportunities o ON o.id = l.opportunity_id
     WHERE f.status = 'pending' AND f.due_at <= NOW() ORDER BY f.due_at LIMIT $1`, [limit]);
  const close = (id: string, status: string, reason: string | null) =>
    db.query(`UPDATE follow_ups SET status = $2, stop_reason = $3, processed_at = NOW() WHERE id = $1`, [id, status, reason]);

  for (const f of due.rows) {
    try {
      // Re-check every stop condition NOW - the situation may have changed since the reminder was scheduled.
      let stop: StopReason | null = null;
      if (!f.email) stop = 'no_email';
      else if (f.reply_received_at) stop = 'reply_received';
      else if (f.contact_mode === 'request-only' || (await isSuppressed(f.email))) stop = 'opted_out';
      else {
        const booked = await db.query(
          `SELECT 1 FROM appointment_bookings b JOIN crm_leads l2 ON l2.id = b.lead_id
           WHERE LOWER(l2.email) = LOWER($1) AND b.status = 'booked' LIMIT 1`, [f.email]);
        if (booked.rows.length) stop = 'appointment_booked';
      }
      if (stop) { await close(f.id, 'stopped', stop); res.stopped++; continue; }

      const ctx = { leadId: f.lead_id, dedupeKey: `follow_up:${f.lead_id}:${f.step}` };
      const link = followUpsEnabled() ? unsubscribeUrl(f.email) : null;
      if (!followUpsEnabled() || !link) {
        await recordDelivery('follow_up', f.email, 'disabled', ctx, followUpsEnabled() ? 'no unsubscribe link (PUBLIC_API_URL / secret missing)' : undefined);
        await close(f.id, 'disabled', null);
        res.disabled++;
        continue;
      }
      const { subject, html } = buildFollowUpEmail({ firstName: f.first_name, marketTitle: f.title, step: f.step, unsubscribeUrl: link });
      const out = await deliverEmail({ kind: 'follow_up', to: f.email, subject, html, ctx });
      await close(f.id, out.sent ? 'sent' : 'failed', null);
      out.sent ? res.sent++ : res.failed++;
    } catch (err) {
      logger.error(`Follow-up ${f.id} error (non-fatal):`, err);
      res.failed++;
    }
  }
  return res;
}
