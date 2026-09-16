import crypto from 'crypto';
import { db } from '../config/database';
import { logger } from '../utils/logger';
import { sendSms, isSmsConfigured } from './smsService';

// ============================================================================
// PHONE VERIFICATION (OTP) - contre-audit ticket C08
// ============================================================================
//
// The lead gate asks for a phone number and hands it to a chargé d'affaires
// to call. Until now nothing checked that the number belonged to the person
// typing it, so an invented-but-well-formed number produced a real CRM lead
// and a wasted callback. This issues a one-time code to the line and only
// marks the number usable once it comes back.
//
// Design notes:
// - Codes are stored hashed (SHA-256 + per-row salt), never in plaintext.
//   They're short-lived and low-entropy, so a DB leak shouldn't hand over
//   live codes; the salt stops a 10^6 rainbow table over all rows at once.
// - The code is never returned in any API response, in any environment.
//   With no SMS provider configured it goes to the logs only (see
//   smsService) so staging stays testable without the gate becoming fake.
// - Attempt limit (5) and expiry (10 min) are enforced server-side; a wrong
//   code burns an attempt rather than being silently retryable forever.
// - Resend throttle (max 3 sends per number per hour, 60s between sends)
//   so this can't be used as an SMS-pumping/toll-fraud amplifier.

const CODE_TTL_MINUTES = 10;
const MAX_ATTEMPTS = 5;
const MAX_SENDS_PER_HOUR = 3;
const MIN_SECONDS_BETWEEN_SENDS = 60;

/** French fixed/mobile line: leading 0, then 1-9, then 8 digits (same rule as the lead validator). */
export const FR_PHONE_RE = /^0[1-9]\d{8}$/;

export function normalisePhone(phone: string): string {
  return (phone || '').replace(/[\s.\-()]/g, '');
}

function hashCode(code: string, salt: string): string {
  return crypto.createHash('sha256').update(`${salt}:${code}`).digest('hex');
}

/**
 * Whether a verified phone is *required* before a lead is accepted.
 * Defaults to on whenever a provider is configured (so production enforces it
 * as soon as credentials land) and can be forced either way with
 * PHONE_VERIFICATION_REQUIRED, which is what staging/local use.
 */
export function isVerificationRequired(): boolean {
  const flag = process.env.PHONE_VERIFICATION_REQUIRED;
  if (flag === 'true') return true;
  if (flag === 'false') return false;
  return isSmsConfigured();
}

export type RequestCodeResult =
  | { ok: true; expiresInSeconds: number; delivered: boolean }
  | { ok: false; error: 'invalid_phone' | 'too_many_requests' | 'send_failed'; message: string; retryAfterSeconds?: number };

export async function requestVerificationCode(sessionId: string, rawPhone: string): Promise<RequestCodeResult> {
  const phone = normalisePhone(rawPhone);
  if (!FR_PHONE_RE.test(phone)) {
    return { ok: false, error: 'invalid_phone', message: 'Le numéro doit être un numéro français à 10 chiffres.' };
  }

  const recent = await db.query(
    `SELECT COUNT(*)::int AS sends,
            MAX(last_sent_at) AS last_sent
       FROM phone_verifications
      WHERE phone = $1 AND last_sent_at > NOW() - INTERVAL '1 hour'`,
    [phone]
  );
  const sends: number = recent.rows[0]?.sends ?? 0;
  const lastSent: Date | null = recent.rows[0]?.last_sent ?? null;

  if (lastSent) {
    const elapsed = (Date.now() - new Date(lastSent).getTime()) / 1000;
    if (elapsed < MIN_SECONDS_BETWEEN_SENDS) {
      return {
        ok: false,
        error: 'too_many_requests',
        message: 'Un code vient déjà d’être envoyé. Patientez quelques instants avant d’en demander un autre.',
        retryAfterSeconds: Math.ceil(MIN_SECONDS_BETWEEN_SENDS - elapsed),
      };
    }
  }
  if (sends >= MAX_SENDS_PER_HOUR) {
    return {
      ok: false,
      error: 'too_many_requests',
      message: 'Trop de demandes pour ce numéro. Réessayez dans une heure ou demandez à être rappelé.',
      retryAfterSeconds: 3600,
    };
  }

  // 6 digits, from a CSPRNG (Math.random would be guessable across
  // concurrent sessions), uniformly distributed over 000000-999999.
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const salt = crypto.randomBytes(16).toString('hex');

  // One live row per (session, phone): a new request replaces the previous
  // code rather than leaving several valid at once.
  await db.query(
    `INSERT INTO phone_verifications (session_id, phone, code_hash, code_salt, attempts, expires_at, last_sent_at)
     VALUES ($1, $2, $3, $4, 0, NOW() + INTERVAL '${CODE_TTL_MINUTES} minutes', NOW())
     ON CONFLICT (session_id, phone) DO UPDATE SET
       code_hash = EXCLUDED.code_hash,
       code_salt = EXCLUDED.code_salt,
       attempts = 0,
       verified_at = NULL,
       expires_at = EXCLUDED.expires_at,
       last_sent_at = NOW()`,
    [sessionId, phone, hashCode(code, salt), salt]
  );

  try {
    const { delivered } = await sendSms(
      phone,
      `Marchés Direct : votre code de vérification est ${code}. Il expire dans ${CODE_TTL_MINUTES} minutes.`
    );
    return { ok: true, expiresInSeconds: CODE_TTL_MINUTES * 60, delivered };
  } catch (err) {
    logger.error('Phone verification SMS send failed:', err);
    return {
      ok: false,
      error: 'send_failed',
      message: 'L’envoi du code a échoué. Réessayez ou demandez à être rappelé.',
    };
  }
}

export type ConfirmCodeResult =
  | { ok: true }
  | { ok: false; error: 'not_found' | 'expired' | 'too_many_attempts' | 'wrong_code'; message: string; attemptsLeft?: number };

export async function confirmVerificationCode(sessionId: string, rawPhone: string, code: string): Promise<ConfirmCodeResult> {
  const phone = normalisePhone(rawPhone);
  const result = await db.query(
    `SELECT id, code_hash, code_salt, attempts, expires_at, verified_at
       FROM phone_verifications
      WHERE session_id = $1 AND phone = $2`,
    [sessionId, phone]
  );
  const row = result.rows[0];
  if (!row) {
    return { ok: false, error: 'not_found', message: 'Aucun code en cours pour ce numéro. Demandez un nouveau code.' };
  }
  if (row.verified_at) return { ok: true };
  if (new Date(row.expires_at).getTime() < Date.now()) {
    return { ok: false, error: 'expired', message: 'Ce code a expiré. Demandez-en un nouveau.' };
  }
  if (row.attempts >= MAX_ATTEMPTS) {
    return { ok: false, error: 'too_many_attempts', message: 'Trop de tentatives. Demandez un nouveau code.' };
  }

  const submitted = (code || '').replace(/\D/g, '');
  const expected = Buffer.from(row.code_hash, 'hex');
  const actual = Buffer.from(hashCode(submitted, row.code_salt), 'hex');
  const matches = expected.length === actual.length && crypto.timingSafeEqual(expected, actual);

  if (!matches) {
    const updated = await db.query(
      `UPDATE phone_verifications SET attempts = attempts + 1 WHERE id = $1 RETURNING attempts`,
      [row.id]
    );
    const attemptsLeft = Math.max(MAX_ATTEMPTS - (updated.rows[0]?.attempts ?? MAX_ATTEMPTS), 0);
    return { ok: false, error: 'wrong_code', message: 'Code incorrect.', attemptsLeft };
  }

  await db.query(`UPDATE phone_verifications SET verified_at = NOW() WHERE id = $1`, [row.id]);
  return { ok: true };
}

/** Has this session already proved it controls this number? */
export async function isPhoneVerified(sessionId: string, rawPhone: string): Promise<boolean> {
  const phone = normalisePhone(rawPhone);
  const result = await db.query(
    `SELECT 1 FROM phone_verifications
      WHERE session_id = $1 AND phone = $2 AND verified_at IS NOT NULL
      LIMIT 1`,
    [sessionId, phone]
  );
  return result.rows.length > 0;
}
