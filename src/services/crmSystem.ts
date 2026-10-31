// Single source of truth for "which CRM do leads sync to".
// An explicit CRM_SYSTEM always wins. If it is unset but HUBSPOT_ACCESS_TOKEN exists, HubSpot is used, so adding the
// token on the server is enough to turn the integration on (previously the silent default was 'pipedrive').
export function activeCrmSystem(): string {
  const explicit = (process.env.CRM_SYSTEM || '').trim().toLowerCase();
  if (explicit) return explicit;
  return (process.env.HUBSPOT_ACCESS_TOKEN || '').trim() ? 'hubspot' : 'pipedrive';
}
