jest.mock('../../config/database', () => ({ db: { query: jest.fn() } }));
jest.mock('axios', () => ({ __esModule: true, default: { request: jest.fn() } }));

import axios from 'axios';
import { db } from '../../config/database';
import {
  buildContactProperties, buildCompanyProperties, syncLeadToHubspot, describeHubspotError, JourneySummary,
} from '../hubspotSyncService';

const q = db.query as jest.Mock;
const req = (axios as any).request as jest.Mock;

const journey: JourneySummary = {
  lastTrade: 'isolation', lastArea: 'Lyon', lastStep: 'view_opportunity',
  lastActivity: new Date('2026-10-30T10:00:00Z'), offerViews: 3, analyses: 1,
};
const lead = { id: 'l1', first_name: 'Ali', last_name: 'K', email: ' Ali@Example.fr ', phone: '0601020304', company_name: 'ACME', session_id: 's1' };

beforeEach(() => {
  jest.clearAllMocks();
  process.env.HUBSPOT_ACCESS_TOKEN = 'secret-token';
});

describe('property builders', () => {
  it('maps the journal summary onto the agreed contact property names', () => {
    expect(buildContactProperties(lead, journey)).toEqual({
      firstname: 'Ali', lastname: 'K', email: 'ali@example.fr', phone: '0601020304',
      md_search_trade: 'isolation', md_search_area: 'Lyon', md_last_journey_step: 'offer_view',
      md_last_site_activity: '2026-10-30T10:00:00.000Z', md_offer_views_count: 3, md_analyses_count: 1,
    });
  });

  it('leaves unknown values out instead of blanking them in HubSpot', () => {
    const p = buildContactProperties({ ...lead, phone: null }, { ...journey, lastTrade: null, lastActivity: null });
    expect(p).not.toHaveProperty('phone');
    expect(p).not.toHaveProperty('md_search_trade');
    expect(p).not.toHaveProperty('md_last_site_activity');
    expect(p.md_offer_views_count).toBe(3);
  });

  it('writes the company name only on creation and keeps the SIRET as 14-digit text', () => {
    const agg = { visitors: 2, offerViews: 5, analyses: 1, lastActivity: null };
    expect(buildCompanyProperties('12345678901234', 'ACME', agg, true)).toMatchObject({ name: 'ACME', md_siret: '12345678901234', md_visitors_count: 2 });
    expect(buildCompanyProperties('12345678901234', 'ACME', agg, false)).not.toHaveProperty('name');
  });
});

describe('syncLeadToHubspot', () => {
  const journalRows = () => {
    // journeyForSessions = 3 queries (counts, step, search); called once for the contact, once for the company
    q.mockResolvedValueOnce({ rows: [{ session_id: 's1' }] })                                   // sessions of this e-mail
     .mockResolvedValueOnce({ rows: [{ offer_views: 3, analyses: 1, last_activity: '2026-10-30T10:00:00Z' }] })
     .mockResolvedValueOnce({ rows: [{ event_type: 'analysis_completed' }] })
     .mockResolvedValueOnce({ rows: [{ event_data: { q: 'isolation', location: 'Lyon' } }] })
     .mockResolvedValueOnce({ rows: [{ siret: '12345678901234', company_data: { name: 'ACME SARL' } }] }) // lookup
     .mockResolvedValueOnce({ rows: [{ session_id: 's1' }, { session_id: 's2' }] })              // every visitor of that SIRET
     .mockResolvedValueOnce({ rows: [{ offer_views: 7, analyses: 2, last_activity: '2026-10-30T11:00:00Z' }] })
     .mockResolvedValueOnce({ rows: [{ event_type: 'offer_view' }] })
     .mockResolvedValueOnce({ rows: [] });
  };

  it('creates the contact and company when absent, then associates them', async () => {
    journalRows();
    req.mockResolvedValueOnce({ data: { results: [] } })               // contact search
       .mockResolvedValueOnce({ data: { id: 'c1' } })                  // contact create
       .mockResolvedValueOnce({ data: { results: [] } })               // company search
       .mockResolvedValueOnce({ data: { id: 'co1' } })                 // company create
       .mockResolvedValueOnce({ data: {} });                           // association
    const r = await syncLeadToHubspot(lead);
    expect(r).toEqual({ contactId: 'c1', companyId: 'co1' });
    const calls = req.mock.calls.map(c => c[0]);
    expect(calls[0].data.filterGroups[0].filters[0]).toMatchObject({ propertyName: 'email', value: 'ali@example.fr' });
    expect(calls[2].data.filterGroups[0].filters[0]).toMatchObject({ propertyName: 'md_siret', value: '12345678901234' });
    expect(calls[3].data.properties).toMatchObject({ name: 'ACME SARL', md_visitors_count: 2, md_offer_views_count: 7 });
    expect(calls[4]).toMatchObject({ method: 'PUT', url: '/crm/v4/objects/contacts/c1/associations/default/companies/co1' });
    expect(calls.every(c => c.headers.Authorization === 'Bearer secret-token')).toBe(true);
  });

  it('reuses existing objects instead of creating duplicates', async () => {
    journalRows();
    req.mockResolvedValueOnce({ data: { results: [{ id: 'c9' }] } })
       .mockResolvedValueOnce({ data: {} })                            // contact patch
       .mockResolvedValueOnce({ data: { results: [{ id: 'co9' }] } })
       .mockResolvedValueOnce({ data: {} })                            // company patch
       .mockResolvedValueOnce({ data: {} });
    expect(await syncLeadToHubspot(lead)).toEqual({ contactId: 'c9', companyId: 'co9' });
    const methods = req.mock.calls.map(c => c[0].method);
    expect(methods).toEqual(['POST', 'PATCH', 'POST', 'PATCH', 'PUT']);
    expect(req.mock.calls[3][0].data.properties).not.toHaveProperty('name');
  });

  it('still syncs the contact when the visitor never selected a company', async () => {
    q.mockResolvedValueOnce({ rows: [{ session_id: 's1' }] })
     .mockResolvedValueOnce({ rows: [{ offer_views: 0, analyses: 0, last_activity: null }] })
     .mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] })
     .mockResolvedValueOnce({ rows: [] });                              // no siret lookup
    req.mockResolvedValueOnce({ data: { results: [] } }).mockResolvedValueOnce({ data: { id: 'c1' } });
    expect(await syncLeadToHubspot(lead)).toEqual({ contactId: 'c1', companyId: null });
    expect(req).toHaveBeenCalledTimes(2);
  });

  it('refuses to run without a token, or without any e-mail or phone to identify the contact', async () => {
    delete process.env.HUBSPOT_ACCESS_TOKEN;
    await expect(syncLeadToHubspot(lead)).rejects.toThrow('HUBSPOT_ACCESS_TOKEN');
    process.env.HUBSPOT_ACCESS_TOKEN = 'x';
    await expect(syncLeadToHubspot({ ...lead, email: '', phone: null })).rejects.toThrow('no e-mail and no phone');
  });
});

describe('describeHubspotError', () => {
  it('keeps status and reason, never the token', () => {
    const s = describeHubspotError({ response: { status: 400, data: { category: 'VALIDATION_ERROR', message: 'Property "md_siret" does not exist Bearer abc123' } } });
    expect(s).toBe('HTTP 400 - VALIDATION_ERROR - Property "md_siret" does not exist Bearer ***');
    expect(describeHubspotError(new Error('timeout of 10000ms exceeded'))).toBe('no response - timeout of 10000ms exceeded');
  });
});
