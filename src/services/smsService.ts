import { logger } from '../utils/logger';

// ============================================================================
// SMS DELIVERY
// ============================================================================
//
// Contre-audit 15 Sep 2026, ticket C08: the phone field on the lead gate was
// only ever *format*-validated. Commit babbb9b tightened the regex so
// "0000000000" stops passing, but any well-formed number a visitor makes up
// ("0612345678") still sails through - the audit's point was that a chargé
// d'affaires ends up calling numbers that were never real. Format validation
// can't fix that; only sending something to the line and getting it back can.
//
// Same pluggable shape as emailService.ts, and for the same reason: the flow
// has to work end-to-end today (code written to the logs, so the gate is
// testable on Render without a provider account) and switch to real delivery
// the moment credentials are set, with no code change.
//
// Twilio is the default target (REST, no SDK needed - the dependency list
// stays as it is). OVH/other French providers usually expose a plain
// GET/POST HTTP endpoint too; SMS_WEBHOOK_URL covers those without another
// branch here.

export type SmsSendResult = { delivered: boolean; provider: string };

/** True once a real provider is configured - used to decide whether the OTP gate is enforced. */
export function isSmsConfigured(): boolean {
  return Boolean(
    (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM_NUMBER) ||
      process.env.SMS_WEBHOOK_URL
  );
}

/**
 * French national number (0X XX XX XX XX) to E.164 (+33XXXXXXXXX).
 * Numbers already in international form are passed through untouched.
 */
export function toE164French(phone: string): string {
  const digits = phone.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return digits;
  if (digits.startsWith('0033')) return `+${digits.slice(2)}`;
  if (digits.startsWith('33') && digits.length === 11) return `+${digits}`;
  if (digits.startsWith('0') && digits.length === 10) return `+33${digits.slice(1)}`;
  return digits;
}

export async function sendSms(to: string, body: string): Promise<SmsSendResult> {
  const e164 = toE164French(to);

  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;

  if (sid && token && from) {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: e164, From: from, Body: body }).toString(),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Twilio API ${res.status}: ${text}`);
    }
    return { delivered: true, provider: 'twilio' };
  }

  const webhook = process.env.SMS_WEBHOOK_URL;
  if (webhook) {
    const res = await fetch(webhook, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.SMS_WEBHOOK_AUTH ? { Authorization: process.env.SMS_WEBHOOK_AUTH } : {}),
      },
      body: JSON.stringify({ to: e164, message: body }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`SMS webhook ${res.status}: ${text}`);
    }
    return { delivered: true, provider: 'webhook' };
  }

  // Not configured. The code is logged, never returned to the caller - a
  // response that carried it would turn the whole gate into decoration.
  logger.warn(`SMS (not sent - no provider configured) to=${e164} body="${body}"`);
  return { delivered: false, provider: 'none' };
}
