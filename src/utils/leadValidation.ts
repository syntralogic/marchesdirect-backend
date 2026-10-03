import { toE164French } from '../services/smsService';

// DEV-08 ("valider les champs côté serveur"): a phone typed into the public
// request forms is checked here instead of being stored as-is. French numbers
// must be complete (06 12 34 56 78, +33 6 12 34 56 78, 0033...), foreign ones
// must be in international form (+44..., 0044...). Letters, stray text and
// truncated numbers are rejected so a team member is never handed a number
// that cannot be dialled.
const FR_E164_RE = /^\+33[1-9]\d{8}$/;
const INTL_E164_RE = /^\+[1-9]\d{7,14}$/;

export function isValidLeadPhone(raw: unknown): boolean {
  if (typeof raw !== 'string') return false;
  const cleaned = raw.trim();
  if (!cleaned) return false;
  if (!/^[+\d\s().-]+$/.test(cleaned)) return false;

  let n = toE164French(cleaned);
  if (n.startsWith('00')) n = `+${n.slice(2)}`;
  if (n.startsWith('+33')) return FR_E164_RE.test(n); // a truncated French number must not pass as "international"
  return INTL_E164_RE.test(n);
}
