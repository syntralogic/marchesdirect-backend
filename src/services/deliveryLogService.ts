import { redactLogText } from '../utils/logPrivacy';
import { db } from '../config/database';
import { logger } from '../utils/logger';
import { sendEmail } from './emailService';
import { dossierStatesFor } from './dossierStateService';

// ============================================================================
// MESSAGE DELIVERY LOG (client brief 31 Oct, part D)
//
// "L'enregistrement, la synchronisation CRM et la livraison du message doivent avoir des statuts distincts" and
// "Ne pas annoncer e-mail envoyé si l'envoi a échoué". The request itself (crm_leads), its CRM sync
// (crm_leads.crm_sync_status) and each outgoing message (this table) each carry their own status:
//
//   sent            the provider (Resend) ACCEPTED the message. Inbox delivery / bounces are not known yet.
//   failed          the provider refused it or the call failed (reason in `error`)
//   not_configured  no provider is configured on this server: nothing left the building
//   disabled        deliberately switched off (a template or provider not validated yet)
//
// Nothing here ever throws: a message problem must never break saving a request.
// ============================================================================

export type DeliveryStatus = 'sent' | 'failed' | 'not_configured' | 'disabled';
export type DeliveryKind = 'dossier' | 'appointment_confirmation' | 'follow_up' | 'alert';

export type DeliveryContext = {
  generationId?: string | null;
  siret?: string | null;
  leadId?: string | null;
  sessionId?: string | null;
  opportunityId?: string | null;
  /** Same key + status 'sent' = already delivered: lets a retry skip a second identical message. */
  dedupeKey?: string | null;
};

const shortError = (err: unknown): string =>
  redactLogText(String((err as any)?.message || 'delivery_error')).slice(0, 500);

export async function recordDelivery(
  kind: DeliveryKind, recipient: string, status: DeliveryStatus, ctx: DeliveryContext = {}, error?: string
): Promise<void> {
  try {
    await db.query(
      `INSERT INTO message_deliveries (kind, channel, recipient, status, error, lead_id, session_id, opportunity_id, dedupe_key, generation_id)
       VALUES ($1, 'email', $2, $3, $4, $5, $6, $7, $8, $9)`,
      [kind, recipient, status, error ? redactLogText(error).slice(0,500) : null, ctx.leadId || null, ctx.sessionId || null, ctx.opportunityId || null, ctx.dedupeKey || null, ctx.generationId || null]
    );
  } catch (err) {
    logger.error('Could not record message delivery (non-fatal):', err);
  }
}

export async function alreadySent(dedupeKey: string): Promise<boolean> {
  try {
    const r = await db.query(`SELECT 1 FROM message_deliveries WHERE dedupe_key = $1 AND status = 'sent' LIMIT 1`, [dedupeKey]);
    return r.rows.length > 0;
  } catch {
    return false;
  }
}

export async function deliverEmail(args: {
  kind: DeliveryKind; to: string; subject: string; html: string;
  attachments?: { filename: string; content: Buffer }[]; ctx?: DeliveryContext;
}): Promise<{ status: DeliveryStatus; sent: boolean }> {
  const ctx = args.ctx || {};
  let status: DeliveryStatus;
  let error: string | undefined;
  try {
    const accepted = await sendEmail({ to: args.to, subject: args.subject, html: args.html, attachments: args.attachments });
    // sendEmail returns false only when no provider key is configured (it throws on a provider failure).
    status = accepted ? 'sent' : 'not_configured';
  } catch (err) {
    status = 'failed';
    error = shortError(err);
  }
  await recordDelivery(args.kind, args.to, status, ctx, error);
  return { status, sent: status === 'sent' };
}

// Compatibility wrapper; e-mail acceptance no longer defines PDF generation.
export async function dossierStatusFor(sessionId: string | null | undefined, opportunityId: string | null | undefined) {
  return (await dossierStatesFor({ sessionId, opportunityId })).dossierStatus;
}
