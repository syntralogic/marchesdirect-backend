import http from 'http';
import { AddressInfo } from 'net';

// Fake HubSpot: verifies the real HTTP flow (auth header, search -> create/patch, 409 race,
// missing custom property fallback, company + association + note payloads).
let server: http.Server;
const calls: Array<{ method: string; url: string; body: any; auth?: string }> = [];
let contactExists = false;
let customPropsMissing = false;
let raceConflict = false;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      calls.push({ method: req.method!, url: req.url!, body, auth: req.headers.authorization });
      const send = (code: number, obj: any) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      const hasCustom = body?.properties && Object.keys(body.properties).some((k) => k.startsWith('md_') || k === 'siret');
      if (req.url!.includes('/search')) return send(200, { results: contactExists && req.url!.includes('contacts') ? [{ id: '42' }] : [] });
      if (hasCustom && customPropsMissing) return send(400, { category: 'VALIDATION_ERROR', errors: [{ code: 'PROPERTY_DOESNT_EXIST' }] });
      if (req.method === 'POST' && req.url === '/crm/v3/objects/contacts' && raceConflict) return send(409, { message: 'Contact already exists. Existing ID: 77' });
      if (req.method === 'POST') return send(201, { id: '100' });
      return send(200, { id: '42' });
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  process.env.HUBSPOT_API_BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.HUBSPOT_ACCESS_TOKEN = 'pat-test';
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => { calls.length = 0; contactExists = false; customPropsMissing = false; raceConflict = false; });

const load = () => { jest.resetModules(); return require('../hubspotService'); };

describe('HubSpot API flow (fake server)', () => {
  it('creates a contact when none exists, with bearer auth', async () => {
    const hs = load();
    expect(await hs.upsertContact({ email: 'A@B.fr', firstName: 'Ali' })).toBe('100');
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(['POST /crm/v3/objects/contacts/search', 'POST /crm/v3/objects/contacts']);
    expect(calls[0].auth).toBe('Bearer pat-test');
    expect(calls[1].body.properties).toEqual({ email: 'a@b.fr', firstname: 'Ali' });
  });

  it('updates the existing contact instead of duplicating', async () => {
    contactExists = true;
    const hs = load();
    expect(await hs.upsertContact({ email: 'a@b.fr', phone: '+33612345678' })).toBe('42');
    expect(calls[1].method).toBe('PATCH');
    expect(calls[1].url).toBe('/crm/v3/objects/contacts/42');
  });

  it('reuses the contact on a 409 race', async () => {
    raceConflict = true;
    const hs = load();
    expect(await hs.upsertContact({ email: 'a@b.fr' })).toBe('77');
    expect(calls[calls.length - 1].url).toBe('/crm/v3/objects/contacts/77');
  });

  it('falls back to standard properties when custom ones do not exist yet', async () => {
    customPropsMissing = true;
    const hs = load();
    expect(await hs.upsertContact({ email: 'a@b.fr', siret: '12345678900011' })).toBe('100');
    const last = calls[calls.length - 1];
    expect(last.body.properties).toEqual({ email: 'a@b.fr' });
  });

  it('creates a company, associates it and writes a note on contact + company', async () => {
    const hs = load();
    const companyId = await hs.upsertCompany({ siret: '12345678900011', name: 'ACME' });
    expect(companyId).toBe('100');
    await hs.associateContactWithCompany('42', companyId);
    await hs.createNote({ contactId: '42', companyId, html: '<p>x</p>' });
    const assoc = calls.find((c) => c.url.includes('/associations/default/'));
    expect(assoc).toMatchObject({ method: 'PUT', url: '/crm/v4/objects/contacts/42/associations/default/companies/100' });
    const note = calls[calls.length - 1];
    expect(note.url).toBe('/crm/v3/objects/notes');
    expect(note.body.associations.map((a: any) => a.types[0].associationTypeId)).toEqual([202, 190]);
  });
});
