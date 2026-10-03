// DEV-02: one rule for "is this marché still open to candidature", reused by the
// dossier request (and anything else that must not promise an open candidature).
// Closed = status declared by the source (expired / awarded / cancelled) OR a
// deadline that has already passed (exact timestamp, not just the date).
export function isOpportunityClosed(opp: { status?: string | null; deadline?: Date | string | null }, now: Date = new Date()): boolean {
  if (opp.status && ['expired', 'awarded', 'cancelled'].includes(String(opp.status))) return true;
  if (opp.deadline) {
    const t = new Date(opp.deadline as any).getTime();
    if (!Number.isNaN(t) && t < now.getTime()) return true;
  }
  return false;
}
