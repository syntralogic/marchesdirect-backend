// utm_source / utm_campaign of a visit: short plain tokens only (never free text, never PII).
export function cleanUtm(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim().slice(0, max);
  return /^[A-Za-z0-9._~:+\- ]{1,}$/.test(t) ? t : null;
}
