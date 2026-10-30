// One-time (idempotent) setup: creates the custom HubSpot properties used by the integration and
// checks the token. Usage:  HUBSPOT_ACCESS_TOKEN=... npm run hubspot:setup
import { ensureHubspotProperties, pingHubspot } from '../src/services/hubspotService';

(async () => {
  const ping = await pingHubspot();
  console.log('Token check:', ping.ok ? 'OK' : `FAILED (${ping.status ?? ''} ${ping.message ?? ''})`);
  if (!ping.ok) process.exit(1);
  const r = await ensureHubspotProperties();
  console.log('Created :', r.created.join(', ') || '-');
  console.log('Existing:', r.existing.join(', ') || '-');
  console.log('Failed  :', r.failed.join(', ') || '-', r.failed.length ? '\n -> add the scopes crm.schemas.contacts.write and crm.schemas.companies.write to the key, then re-run.' : '');
  process.exit(r.failed.length ? 2 : 0);
})();
