import { buildJourneyUrl, journeyLinkProperties } from '../journeyLinkService';
import { buildContactProperties } from '../hubspotSyncService';

const ID = '123e4567-e89b-12d3-a456-426614174000';
const j = { lastTrade: null, lastArea: null, lastStep: null, lastActivity: null, offerViews: 0, analyses: 0 };
const lead: any = { id: ID, email: 'a@b.fr', first_name: null, last_name: null, phone: null, company_name: null, session_id: null };

describe('journey link (HubSpot -> internal page)', () => {
  const env = { ...process.env };
  afterEach(() => { process.env = { ...env }; });

  it('builds an admin page URL from the request id only', () => {
    process.env.FRONTEND_URL = 'https://site.example/';
    expect(buildJourneyUrl(ID)).toBe(`https://site.example/admin/leads/${ID}/journey`);
  });
  it('refuses a non-UUID id or a missing site URL', () => {
    process.env.FRONTEND_URL = 'https://site.example';
    expect(buildJourneyUrl('1; drop')).toBeNull();
    delete process.env.FRONTEND_URL;
    expect(buildJourneyUrl(ID)).toBeNull();
  });
  it('writes nothing unless explicitly enabled', () => {
    process.env.FRONTEND_URL = 'https://site.example';
    delete process.env.HUBSPOT_JOURNEY_LINK_ENABLED;
    expect(journeyLinkProperties(ID)).toEqual({});
    expect(buildContactProperties(lead, j as any)).not.toHaveProperty('md_journey_url');
    process.env.HUBSPOT_JOURNEY_LINK_ENABLED = 'true';
    expect(buildContactProperties(lead, j as any).md_journey_url).toBe(`https://site.example/admin/leads/${ID}/journey`);
  });
});
