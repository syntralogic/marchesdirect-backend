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

// Plafonds (7 nov., audit) : un SMS est payant ; sans plafond, un robot qui saisit des numéros en boucle fait payer
// chaque envoi. Au plus SMS_PER_NUMBER_24H envois par numéro sur 24 h glissantes et SMS_DAILY_MAX par jour (heure
// de Paris) pour tout le site. Compteurs en mémoire du serveur : remis à zéro au redémarrage, ce qui reste un garde-fou
// suffisant contre une rafale. Au-delà : erreur « sms_cap_reached », que l'appelant affiche comme un échec d'envoi.
const SMS_DAILY_MAX = Number(process.env.SMS_DAILY_MAX) > 0 ? Number(process.env.SMS_DAILY_MAX) : 100;
const SMS_PER_NUMBER_24H = Number(process.env.SMS_PER_NUMBER_24H) > 0 ? Number(process.env.SMS_PER_NUMBER_24H) : 3;
const smsByNumber = new Map<string, number[]>();
let smsDay = ''; let smsToday = 0;
export function smsCapCheck(e164: string, now = Date.now()): string | null {
  const day = new Date(now).toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris' });
  if (day !== smsDay) { smsDay = day; smsToday = 0; }
  if (smsToday >= SMS_DAILY_MAX) return 'plafond quotidien atteint';
  const recent = (smsByNumber.get(e164) || []).filter(t => now - t < 86400000);
  if (recent.length >= SMS_PER_NUMBER_24H) return 'plafond par numéro atteint';
  recent.push(now); smsByNumber.set(e164, recent); smsToday++;
  if (smsByNumber.size > 5000) for (const [k, v] of smsByNumber) if (!v.some(t => now - t < 86400000)) smsByNumber.delete(k);
  return null;
}

export async function sendSms(to: string, body: string): Promise<SmsSendResult> {
  const e164 = toE164French(to);
  const capped = smsCapCheck(e164);
  if (capped) { logger.warn(`[SMS] envoi refusé (${capped}) pour ${e164.slice(0, 6)}…`); throw new Error(`sms_cap_reached: ${capped}`); }

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
