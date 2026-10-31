import crypto from 'crypto';
import { db } from '../config/database';
import { logger } from '../utils/logger';
import { stopFollowUpsForEmail } from './followUpService';

// ============================================================================
// CONTACT PREFERENCES (client brief 31 Oct, part D: stop reminders when the person objects; never assume consent)
//
// The visitor's "Suivi de ma demande uniquement" choice used to live only in React state: the page said the
// objection was "prise en compte" while the server never heard of it. It is now stored on the request
// (crm_leads.contact_mode) AND in contact_suppressions, which outlives any single request, so every later
// reminder or alert checks the same list. Selecting a company (SIRET) never creates or removes anything here.
// ============================================================================

export type ContactMode = 'followup' | 'request-only';
export const parseContactMode = (v: unknown): ContactMode | null => (v === 'followup' || v === 'request-only' ? v : null);
export const normEmail = (e: string) => e.trim().toLowerCase();

export async function isSuppressed(email: string | null | undefined): Promise<boolean> {
  if (!email) return false;
  try {
    const r = await db.query('SELECT 1 FROM contact_suppressions WHERE email_lower = $1', [normEmail(email)]);
    return r.rows.length > 0;
  } catch (err) {
    logger.error('contact_suppressions unreadable (treated as suppressed, the safe side):', err);
    return true;
  }
}

/** Records the choice for an e-mail address. 'request-only' / 'unsubscribed' stop every later reminder and alert. */
export async function applyContactChoice(email: string, mode: ContactMode, reason: 'request_only' | 'unsubscribed' = 'request_only'): Promise<void> {
  const e = normEmail(email);
  await db.query(`UPDATE crm_leads SET contact_mode = $1, updated_at = NOW() WHERE LOWER(email) = $2`, [mode, e]);
  if (mode === 'request-only') {
    await db.query(
      `INSERT INTO contact_suppressions (email_lower, reason) VALUES ($1, $2) ON CONFLICT (email_lower) DO UPDATE SET reason = EXCLUDED.reason`,
      [e, reason]
    );
    await stopFollowUpsForEmail(e, 'opted_out');
    await db.query(`UPDATE alert_subscriptions SET unsubscribed_at = COALESCE(unsubscribed_at, NOW()) WHERE email_lower = $1`, [e]).catch(() => {});
  } else {
    // Only a choice made through the site's own preference control can be reversed that way; a one-click
    // "unsubscribed" stays until the person re-subscribes explicitly.
    await db.query(`DELETE FROM contact_suppressions WHERE email_lower = $1 AND reason = 'request_only'`, [e]);
  }
}

/** The visitor's session identifies them (same as the lead gate); the e-mail is the one they gave for that session. */
export async function setContactModeForSession(sessionId: string, mode: ContactMode): Promise<{ ok: boolean; reason?: 'no_contact' }> {
  const r = await db.query('SELECT email FROM siret_lookups WHERE session_id = $1 AND email IS NOT NULL', [sessionId]);
  const email: string | undefined = r.rows[0]?.email;
  if (!email) return { ok: false, reason: 'no_contact' };
  await applyContactChoice(email, mode);
  return { ok: true };
}

// One-click unsubscribe links (reminders, alerts): HMAC of the address, so nobody can unsubscribe someone else.
const secret = () => process.env.CONTACT_LINK_SECRET || process.env.JWT_SECRET || '';
export const canSignLinks = () => Boolean(secret());
export const signEmail = (email: string) => crypto.createHmac('sha256', secret()).update(normEmail(email)).digest('hex').slice(0, 32);
export function verifyEmailSignature(email: string, sig: string): boolean {
  if (!secret() || !sig) return false;
  const a = Buffer.from(signEmail(email));
  const b = Buffer.from(String(sig));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
export const unsubscribeUrl = (email: string): string | null => {
  const base = process.env.PUBLIC_API_URL;
  if (!base || !canSignLinks()) return null;
  return `${base.replace(/\/$/, '')}/api/contact/unsubscribe?e=${encodeURIComponent(normEmail(email))}&s=${signEmail(email)}`;
};
