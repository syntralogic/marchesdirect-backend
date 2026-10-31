// Creates the md_journey_url text property on HubSpot contacts and deals (idempotent: an existing one is left alone).
// Usage: HUBSPOT_ACCESS_TOKEN=... npx ts-node scripts/ensureHubspotJourneyProperty.ts
// Needs the private-app scopes crm.schemas.contacts.write and crm.schemas.deals.write.
import axios from 'axios';

const BASE = (process.env.HUBSPOT_BASE_URL || 'https://api.hubapi.com').replace(/\/$/, '');
const TOKEN = process.env.HUBSPOT_ACCESS_TOKEN;

async function ensure(objectType: 'contacts' | 'deals') {
  const headers = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
  try {
    await axios.get(`${BASE}/crm/v3/properties/${objectType}/md_journey_url`, { headers });
    console.log(`${objectType}: md_journey_url already exists`);
    return;
  } catch (e: any) {
    if (e.response?.status !== 404) throw e;
  }
  await axios.post(`${BASE}/crm/v3/properties/${objectType}`, {
    name: 'md_journey_url',
    label: 'Marchés Direct — Parcours détaillé',
    type: 'string',
    fieldType: 'text',
    groupName: objectType === 'contacts' ? 'contactinformation' : 'dealinformation',
    description: 'Lien vers la page interne authentifiée avec tout l’historique du visiteur (connexion admin requise).',
  }, { headers });
  console.log(`${objectType}: md_journey_url created`);
}

(async () => {
  if (!TOKEN) { console.error('HUBSPOT_ACCESS_TOKEN is not set'); process.exit(1); }
  await ensure('contacts');
  await ensure('deals');
})().catch(e => { console.error(e.response?.data || e.message); process.exit(1); });
