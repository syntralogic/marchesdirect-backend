import crypto from 'crypto';

// JWTs exceed bcrypt's 72-byte input limit. Hash the entire, high-entropy token.
export const refreshTokenDigest = (token: string): string =>
  `sha256:${crypto.createHash('sha256').update(token).digest('hex')}`;

export function isAccessTokenRevoked(issuedAt: unknown, validAfter: unknown): boolean {
  if (!validAfter) return false;
  const cutoff = new Date(validAfter as string).getTime();
  return typeof issuedAt !== 'number' || !Number.isFinite(cutoff) || issuedAt <= Math.floor(cutoff / 1000);
}
