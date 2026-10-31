// ============================================================================
// HUBSPOT -> INTERNAL JOURNEY PAGE (client brief, part E)
//
// The full visitor history stays in Supabase (visitor_events). From a HubSpot contact or deal, staff open a link
// to an AUTHENTICATED internal page (/admin/leads/:id/journey): the page needs an admin login and every call goes
// through /api/admin (requireRole). The link carries only the request id (a UUID), never a token or personal data.
//
// The link is stored in ONE extra text property, md_journey_url (contacts and deals). It is NOT one of the brief's
// listed properties, so it is only written when HUBSPOT_JOURNEY_LINK_ENABLED=true, after
// `npx ts-node scripts/ensureHubspotJourneyProperty.ts` has created it (writing an unknown property makes HubSpot
// reject the whole update).
// ============================================================================

export const JOURNEY_PROPERTY = 'md_journey_url';

export const isJourneyLinkEnabled = (): boolean =>
  process.env.HUBSPOT_JOURNEY_LINK_ENABLED === 'true' && !!(process.env.FRONTEND_URL || '').trim();

export function buildJourneyUrl(leadId: string | null | undefined): string | null {
  if (!leadId || !/^[0-9a-f-]{36}$/i.test(String(leadId))) return null;
  const base = (process.env.FRONTEND_URL || '').trim().replace(/\/$/, '');
  if (!/^https?:\/\//.test(base)) return null;
  return `${base}/admin/leads/${leadId}/journey`;
}

// Property fragment to merge into a contact/deal payload; empty when the feature is off.
export function journeyLinkProperties(leadId: string | null | undefined): Record<string, string> {
  if (!isJourneyLinkEnabled()) return {};
  const url = buildJourneyUrl(leadId);
  return url ? { [JOURNEY_PROPERTY]: url } : {};
}
