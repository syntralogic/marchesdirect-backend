// Who is asking to see a private-tender / sous-traitance fiche's buyer identity?
//
// SECURITY: the unlock lookup (resolveIdentityUnlocked) matches crm_leads rows
// by session id OR email. The email used to be read from the unauthenticated
// `?email=` query string whenever the caller wasn't logged in, so anyone who
// knew (or guessed) the email of a visitor who had booked a callback slot could
// pass `?email=victim@example.com` and see the buyer identity that is supposed
// to be unlocked only by that visitor's own booking. An email is not a secret,
// so it must only ever come from the authenticated session (req.user, set by
// optionalAuth from a verified JWT).
//
// The anonymous path is the visitor's own sessionId - a random id generated in
// their browser (crypto.randomUUID when storage is allowed) that acts as a
// capability. It is accepted only when it is a plausible string, never an
// array/object (`?sessionId[]=...`).

export const MAX_SESSION_ID_LENGTH = 100;

interface IdentityRequestLike {
  query?: Record<string, unknown>;
  user?: { email?: string | null } | null;
}

export function getIdentityLookupKeys(req: IdentityRequestLike): { sessionId: string; email: string } {
  const raw = req.query?.sessionId;
  const sessionId =
    typeof raw === 'string' && raw.length > 0 && raw.length <= MAX_SESSION_ID_LENGTH ? raw : '';
  const email = typeof req.user?.email === 'string' ? req.user.email : '';
  return { sessionId, email };
}
