import { db } from '../config/database';
import { logger } from '../utils/logger';
import { formatSlotFr } from '../utils/appointmentSlots';
import { deliverEmail, recordDelivery, alreadySent } from './deliveryLogService';

// E-mail to the visitor once an appointment is really CONFIRMED (slot reserved and attached to the request).
// OFF by default: the brief forbids real sends before the template, the provider and the tests are validated.
// Set APPOINTMENT_CONFIRMATION_EMAILS=true when they are. While off, a 'disabled' row is recorded so the team
// can see that no confirmation left (and the site must not promise one).
export const appointmentConfirmationEnabled = () => process.env.APPOINTMENT_CONFIRMATION_EMAILS === 'true';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

export function buildAppointmentConfirmationEmail(args: { firstName?: string | null; slotAt: Date | string; marketTitle?: string | null; lotLabel?: string | null }) {
  const when = formatSlotFr(args.slotAt);
  const html = `
    <p>Bonjour${args.firstName ? ` ${esc(args.firstName)}` : ''},</p>
    <p>Votre rendez-vous avec un chargé d'affaires Marchés Direct est confirmé : <strong>${esc(when)}</strong> (heure de Paris).</p>
    ${args.marketTitle ? `<p>Marché concerné : <strong>${esc(args.marketTitle)}</strong>${args.lotLabel ? ` (lot : ${esc(args.lotLabel)})` : ''}.</p>` : ''}
    <p>Si vous ne pouvez pas être disponible à ce moment, répondez simplement à ce message.</p>
    <p>— L'équipe Marchés Direct</p>`;
  return { subject: `Rendez-vous confirmé - ${when}`, html };
}

// Never throws; safe to call fire-and-forget. Returns the delivery status for tests/logs.
export async function sendAppointmentConfirmation(leadId: string): Promise<string> {
  try {
    const r = await db.query(
      `SELECT l.email, l.first_name, l.lot_label, o.title, b.slot_at
       FROM crm_leads l
       JOIN appointment_bookings b ON b.lead_id = l.id AND b.status = 'booked'
       LEFT JOIN opportunities o ON o.id = l.opportunity_id
       WHERE l.id = $1 ORDER BY b.created_at DESC LIMIT 1`,
      [leadId]
    );
    const row = r.rows[0];
    if (!row || !row.email) return 'skipped';           // no confirmed booking (or no address) = nothing to confirm
    const dedupeKey = `appointment_confirmation:${leadId}:${new Date(row.slot_at).toISOString()}`;
    if (await alreadySent(dedupeKey)) return 'already_sent';
    const ctx = { leadId, dedupeKey };
    if (!appointmentConfirmationEnabled()) {
      await recordDelivery('appointment_confirmation', row.email, 'disabled', ctx);
      return 'disabled';
    }
    const { subject, html } = buildAppointmentConfirmationEmail({ firstName: row.first_name, slotAt: row.slot_at, marketTitle: row.title, lotLabel: row.lot_label });
    return (await deliverEmail({ kind: 'appointment_confirmation', to: row.email, subject, html, ctx })).status;
  } catch (err) {
    logger.error(`Appointment confirmation error for lead ${leadId} (non-fatal):`, err);
    return 'error';
  }
}

