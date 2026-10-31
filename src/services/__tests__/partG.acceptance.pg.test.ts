/**
 * Part G acceptance run (client brief "Vérifications avant livraison", 10 checks).
 * Real PostgreSQL + the real Express routes and services; only HubSpot is replaced by an in-process fake
 * (src/services/__tests__/support/fakeHubspot.ts). Skipped unless TEST_DATABASE_URL points at a throw-away database:
 *   TEST_DATABASE_URL=postgres://postgres:pw@localhost:5432/mdtest npx jest partG.acceptance --forceExit
 *
 * What this proves and what it cannot: see docs/PART_G_TEST_REPORT.md (HubSpot-side automations, real e-mail/SMS
 * delivery and the HubSpot dashboard can only be verified on the real account).
 */
import http from 'http';
import type { AddressInfo } from 'net';
import { FakeHubspot } from './support/fakeHubspot';

const URL_ = process.env.TEST_DATABASE_URL;
const d = URL_ ? describe : describe.skip;

d('Part G - acceptance (real PostgreSQL, fake HubSpot)', () => {
  let db: any; let server: http.Server; let base = '';
  const hs = new FakeHubspot();
  let crmSync: any; let dealSvc: any; let slots: any; let score: any;
  let brandId = ''; let tenderOpp = ''; let publicOpp = ''; let tenderOpp2 = '';
  const ENV = { ...process.env };

  const post = async (path: string, body: any, headers: Record<string, string> = {}) => {
    const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => ({})) as any };
  };
  const event = (sessionId: string, eventType: string, extra: any = {}) =>
    post('/api/visitor-events', { sessionId, eventType, ...extra });
  const settled = async (leadId: string, want: string[] = ['synced', 'failed']) => {
    for (let i = 0; i < 100; i++) {
      const r = await db.query('SELECT crm_sync_status FROM crm_leads WHERE id = $1', [leadId]);
      if (want.includes(r.rows[0]?.crm_sync_status)) return r.rows[0].crm_sync_status;
      await new Promise((r2) => setTimeout(r2, 100));
    }
    throw new Error('sync did not settle for ' + leadId);
  };
  const lead = (email: string) => db.query('SELECT * FROM crm_leads WHERE LOWER(email) = LOWER($1) ORDER BY created_at', [email]);
  const siretLookup = (sessionId: string, siret: string, name = 'DUPONT ELECTRICITE') =>
    db.query(`INSERT INTO siret_lookups (session_id, siret, company_data) VALUES ($1, $2, $3)
              ON CONFLICT (session_id) DO UPDATE SET siret = EXCLUDED.siret`,
      [sessionId, siret, JSON.stringify({ name, ape: '4321A', activity: 'Installation électrique', postal: '69003', city: 'Lyon' })]);
  // Same SQL as the dossier gate in routes/siret.ts (the OTP step in front of it is not part of this check).
  const dossierLead = async (email: string, sessionId: string, opportunityId: string, lot: string | null = null) => {
    const r = await db.query(
      `INSERT INTO crm_leads (brand_id, email, phone, company_name, lead_source, opportunity_id, session_id, crm_sync_status, lot_label)
       VALUES ($1, $2, '+33612345678', 'DUPONT ELECTRICITE', 'analysis_gate', $3, $4, 'pending', $5) RETURNING id`,
      [brandId, email, opportunityId, sessionId, lot]);
    await crmSync.syncLeadToCrm(r.rows[0].id);
    return r.rows[0].id as string;
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = URL_; process.env.DB_SSL = 'false';
    const database = require('../../config/database'); db = database.db; await database.ensureSchema();
    await hs.start();
    Object.assign(process.env, { CRM_SYSTEM: 'hubspot', HUBSPOT_ACCESS_TOKEN: 'test-token', HUBSPOT_BASE_URL: hs.baseUrl });
    delete process.env.HUBSPOT_JOURNEY_LINK_ENABLED;
    crmSync = require('../crmSyncService'); dealSvc = require('../hubspotDealService'); slots = require('../appointmentService'); score = require('../matchScoreService');
    const express = require('express');
    const app = express(); app.use(express.json());
    app.use('/api/crm/leads', require('../../routes/crmPublic').default);
    app.use('/api/visitor-events', require('../../routes/visitorEvents').default);
    app.use('/api/opportunities', require('../../routes/opportunities').default);
    server = http.createServer(app); await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    await db.query('TRUNCATE crm_leads, visitor_events, siret_lookups, analysis_snapshots, appointment_bookings, opportunities CASCADE');
    brandId = (await db.query('SELECT id FROM brands ORDER BY created_at LIMIT 1')).rows[0].id;
    const src = (await db.query("SELECT id FROM data_sources WHERE code = 'boamp'")).rows[0].id;
    const type = async (code: string) => (await db.query('SELECT id FROM opportunity_types WHERE code = $1', [code])).rows[0].id;
    const trade = (await db.query("SELECT id FROM trades WHERE slug = 'electricite'")).rows[0].id;
    const opp = async (ref: string, typeCode: string, title: string) => (await db.query(
      `INSERT INTO opportunities (source_id, source_reference, opportunity_type_id, title, description, publication_date, deadline, status,
         trade_id, location_city, location_department, location_region, location_country, official_url)
       VALUES ($1,$2,$3,$4,$5, NOW() - INTERVAL '3 days', NOW() + INTERVAL '20 days', 'active', $6, 'Lyon', '69', 'Auvergne-Rhône-Alpes', 'FR', $7) RETURNING id`,
      [src, ref, await type(typeCode), title, title + ' - lot 2 électricité', trade, `https://example.test/${ref}`])).rows[0].id;
    tenderOpp = await opp('REF-T1', 'tender', 'Installation électrique bureaux Lyon');
    tenderOpp2 = await opp('REF-T2', 'tender', 'Rénovation électrique école Villeurbanne');
    publicOpp = await opp('REF-P1', 'public_procurement', 'Marché public électricité mairie');
  }, 60000);

  afterAll(async () => { process.env = { ...ENV }; await hs.stop(); await new Promise((r) => server.close(r)); await db.end?.(); });
  beforeEach(() => { hs.reset(); });

  // ------------------------------------------------------------------------------------------------ 1
  it('1. a search, then the selection of a SIRET: the company is found and reused', async () => {
    const S = 'sess-check-1-aaaa';
    await event(S, 'search', { eventId: 'e1-search-0001', eventLabel: 'electricien lyon', eventData: { q: 'électricien', location: 'Lyon' } });
    await event(S, 'company_selected', { eventId: 'e1-company-0001', siret: '12345678901234' });
    await siretLookup(S, '12345678901234');
    const id1 = await dossierLead('one@example.fr', S, tenderOpp);
    expect(await settled(id1)).toBe('synced');
    const companies = hs.find('companies', 'md_siret', '12345678901234');
    expect(companies).toHaveLength(1);
    expect(companies[0].properties.md_siret).toMatch(/^\d{14}$/);
    // a second, unrelated visitor on the same SIRET reuses that company
    await siretLookup('sess-check-1-bbbb', '12345678901234');
    const id2 = await dossierLead('two@example.fr', 'sess-check-1-bbbb', tenderOpp2);
    expect(await settled(id2)).toBe('synced');
    expect(hs.companies.size).toBe(1);
    const c = await db.query("SELECT event_type, siret FROM visitor_events WHERE session_id = $1 ORDER BY created_at", [S]);
    expect(c.rows.map((r: any) => r.event_type)).toEqual(['search', 'company_selected']);
    expect(c.rows[1].siret).toBe('12345678901234');
  });

  // ------------------------------------------------------------------------------------------------ 2
  it('2. several offers viewed: full history kept, counters coherent after de-duplication', async () => {
    const S = 'sess-check-2-aaaa';
    await event(S, 'offer_view', { eventId: 'e2-view-0001', opportunityId: tenderOpp, eventData: { opportunityId: tenderOpp } });
    await event(S, 'offer_view', { eventId: 'e2-view-0002', opportunityId: tenderOpp2, eventData: { opportunityId: tenderOpp2 } });
    await event(S, 'offer_view', { eventId: 'e2-view-0003', opportunityId: publicOpp, eventData: { opportunityId: publicOpp } });
    await event(S, 'offer_view', { eventId: 'e2-view-0002', opportunityId: tenderOpp2, eventData: { opportunityId: tenderOpp2 } }); // network retry
    await siretLookup(S, '22222222222222');
    const id = await dossierLead('views@example.fr', S, tenderOpp);
    expect(await settled(id)).toBe('synced');
    const journal = await db.query("SELECT COUNT(*)::int n FROM visitor_events WHERE session_id = $1 AND event_type = 'offer_view'", [S]);
    expect(journal.rows[0].n).toBe(3);
    const contact = hs.find('contacts', 'email', 'views@example.fr')[0];
    expect(contact.properties.md_offer_views_count).toBe('3');
    expect(contact.properties.md_last_journey_step).toBe('offer_view');
    expect(hs.find('companies', 'md_siret', '22222222222222')[0].properties.md_offer_views_count).toBe('3');
  });

  // ------------------------------------------------------------------------------------------------ 3
  it('3. an analysis: right market, lot, index and answers reach the deal', async () => {
    const S = 'sess-check-3-aaaa';
    await siretLookup(S, '33333333333333');
    await db.query(`INSERT INTO analysis_snapshots (session_id, siret, opportunity_id, lot_id, answers)
                    VALUES ($1, '33333333333333', $2, 'Lot 2', $3)`,
      [S, tenderOpp, JSON.stringify({ capacity: 'oui', experience: 'non', calendar: 'a_confirmer', location: 'oui' })]);
    await event(S, 'analysis_started', { eventId: 'e3-start-0001', analysisId: 'an-3', opportunityId: tenderOpp });
    await event(S, 'analysis_completed', { eventId: 'e3-done-00001', analysisId: 'an-3', opportunityId: tenderOpp });
    const id = await dossierLead('analysis@example.fr', S, tenderOpp, 'Lot 2');
    expect(await settled(id)).toBe('synced');
    const deal = hs.find('deals', 'md_request_id', id)[0];
    expect(deal).toBeTruthy();
    const p = deal.properties;
    expect(p.md_market_type).toBe('private');
    expect(p.md_market_reference).toBe('REF-T1');
    expect(p.md_market_url).toBe('https://example.test/REF-T1');
    expect(p.md_lot_reference).toBe('Lot 2');
    expect([p.md_answer_moyens, p.md_answer_references, p.md_answer_disponibilite, p.md_answer_zone]).toEqual(['yes', 'no', 'unanswered', 'yes']);
    const expected = await score.computeMatchScore(tenderOpp, null, { sessionId: S, answers: { capacity: 'oui', experience: 'non', calendar: 'a_confirmer', location: 'oui' }, lot: 'Lot 2' });
    if (typeof expected.score === 'number') {
      expect(Number(p.md_compatibility_score)).toBe(expected.score);
      expect(p.md_score_version).toBeTruthy();
      expect(p.md_score_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    } else {
      expect(p.md_compatibility_score).toBeUndefined(); // never invented
    }
    expect(hs.find('contacts', 'email', 'analysis@example.fr')[0].properties.md_analyses_count).toBe('1');
  });

  // ------------------------------------------------------------------------------------------------ 4
  it('4. one request: one contact, one deal, one callback task, correctly associated', async () => {
    const S = 'sess-check-4-aaaa';
    await siretLookup(S, '44444444444444');
    const id = await dossierLead('request@example.fr', S, tenderOpp);
    expect(await settled(id)).toBe('synced');
    expect(hs.contacts.size).toBe(1); expect(hs.deals.size).toBe(1);
    const deal = [...hs.deals.values()][0]; const contact = [...hs.contacts.values()][0]; const company = [...hs.companies.values()][0];
    expect(deal.properties.pipeline).toBe('4280487115');
    expect(deal.properties.dealstage).toBe('6323584230'); // À rappeler
    expect(hs.associated('deals', deal.id, 'contacts', contact.id)).toBe(true);
    expect(hs.associated('deals', deal.id, 'companies', company.id)).toBe(true);
    expect(hs.tasks).toEqual([{ dealId: deal.id, stage: '6323584230', kind: 'prise_en_charge' }]); // simulated automation
    // a visit or a search never creates a deal
    await event(S, 'search', { eventId: 'e4-search-0001', eventData: { q: 'x' } });
    expect(hs.deals.size).toBe(1);
  });

  // ------------------------------------------------------------------------------------------------ 5
  it('5. double click / network retry: no duplicate lead, contact, deal or event', async () => {
    const S = 'sess-check-5-aaaa';
    const payload = { brandId, firstName: 'Dora', lastName: 'Click', email: 'double@example.fr', phone: '0612345678', companyName: 'DC SARL',
      leadSource: 'callback_modal', message: 'Rappel', sessionId: S };
    const [a, b] = await Promise.all([post('/api/crm/leads', payload), post('/api/crm/leads', payload)]);
    const keyed = { ...payload, sessionId: 'sess-check-5-bbbb', email: 'retry@example.fr', idempotencyKey: 'idem-key-check-5' };
    const [c, e] = await Promise.all([post('/api/crm/leads', keyed), post('/api/crm/leads', keyed)]);
    const retry = await post('/api/crm/leads', keyed);
    expect([a.status, b.status, c.status, e.status, retry.status].every((s) => s === 200 || s === 201)).toBe(true);
    expect((await lead('double@example.fr')).rows).toHaveLength(1);
    expect((await lead('retry@example.fr')).rows).toHaveLength(1);
    for (const id of [a.body.id, c.body.id]) await settled(id);
    expect(hs.find('contacts', 'email', 'double@example.fr')).toHaveLength(1);
    expect(hs.find('contacts', 'email', 'retry@example.fr')).toHaveLength(1);
    // the same sync run twice (retry sweep after a lost response) does not duplicate the deal either
    await crmSync.syncLeadToCrm(c.body.id); await crmSync.syncLeadToCrm(c.body.id);
    expect(hs.find('deals', 'md_request_id', c.body.id)).toHaveLength(1);
    // the same event resent: one row
    for (let i = 0; i < 3; i++) await event(S, 'offer_view', { eventId: 'e5-view-0001', opportunityId: tenderOpp });
    expect((await db.query("SELECT COUNT(*)::int n FROM visitor_events WHERE session_id = $1 AND event_id = 'e5-view-0001'", [S])).rows[0].n).toBe(1);
  });

  // ------------------------------------------------------------------------------------------------ 6
  it('6. a booking: right CRM stage, then the real outcome of the appointment', async () => {
    const S = 'sess-check-6-aaaa';
    const day = (await slots.freeAlternatives(3))[0];
    const slot = day.slots[0].slotAt;
    const res = await post('/api/crm/leads', { brandId, firstName: 'Rémi', lastName: 'Rdv', email: 'rdv@example.fr', phone: '0612345678',
      companyName: 'RDV SARL', leadSource: 'appointment_modal', message: 'Motif', slotAt: slot, sessionId: S });
    expect(res.status).toBe(201);
    const id = res.body.id;
    expect(await settled(id)).toBe('synced');
    let deal = hs.find('deals', 'md_request_id', id)[0];
    expect(deal.properties.md_request_type).toBe('appointment');
    expect(deal.properties.dealstage).toBe('6323584232'); // RDV confirmé
    expect(deal.properties.md_appointment_outcome).toBe('scheduled');
    expect(hs.tasks.some((t) => t.stage === '6323584233')).toBe(false); // nothing "réalisé" yet
    // the meeting really takes place (what POST /admin/leads/:id/appointment-outcome does once the slot is in the past)
    await db.query("UPDATE appointment_bookings SET slot_at = NOW() - INTERVAL '1 day', outcome = 'attended' WHERE lead_id = $1", [id]);
    await crmSync.syncLeadToCrm(id);
    deal = hs.find('deals', 'md_request_id', id)[0];
    expect(deal.properties.dealstage).toBe('6323584233'); // RDV réalisé
    expect(deal.properties.md_appointment_outcome).toBe('attended');
    expect(hs.tasks.filter((t) => t.dealId === deal.id && t.stage === '6323584233')).toHaveLength(1);
    await crmSync.syncLeadToCrm(id); // re-sync does not recreate the task (re-enrolment off)
    expect(hs.tasks.filter((t) => t.dealId === deal.id)).toHaveLength(1);
  });

  it('6b. a dossier request that becomes an appointment on the same market keeps the SAME deal', async () => {
    const S = 'sess-check-6b-aaa';
    await siretLookup(S, '66666666666666');
    const id = await dossierLead('extend@example.fr', S, tenderOpp);
    expect(await settled(id)).toBe('synced');
    const dealId = hs.find('deals', 'md_request_id', id)[0].id;
    const slot = (await slots.freeAlternatives(5))[1].slots[0].slotAt;
    const r = await post(`/api/opportunities/${tenderOpp}/request-access`, { email: 'extend@example.fr', firstName: 'Eve', mode: 'slot', slotLabel: 'x', slotAt: slot, sessionId: S + '-later' });
    expect(r.status).toBe(201);
    await settled(id, ['synced']); await new Promise((r2) => setTimeout(r2, 800));
    expect(hs.deals.size).toBe(1);
    const deal = hs.deals.get(dealId)!;
    expect(deal.properties.md_request_type).toBe('appointment');
    expect(deal.properties.dealstage).toBe('6323584232');
  });

  // ------------------------------------------------------------------------------------------------ 7
  it('7. two visitors on the same SIRET: separate journeys, never merged', async () => {
    const A = 'sess-check-7-aaaa'; const B = 'sess-check-7-bbbb';
    for (const [s, ids] of [[A, ['a1', 'a2']], [B, ['b1']]] as [string, string[]][]) {
      await siretLookup(s, '77777777777777');
      for (const i of ids) await event(s, 'offer_view', { eventId: `e7-${i}-000001`, opportunityId: tenderOpp });
    }
    const ia = await dossierLead('visitor.a@example.fr', A, tenderOpp);
    const ib = await dossierLead('visitor.b@example.fr', B, tenderOpp2);
    await settled(ia); await settled(ib);
    expect(hs.contacts.size).toBe(2);
    expect(hs.companies.size).toBe(1);
    expect(hs.find('contacts', 'email', 'visitor.a@example.fr')[0].properties.md_offer_views_count).toBe('2');
    expect(hs.find('contacts', 'email', 'visitor.b@example.fr')[0].properties.md_offer_views_count).toBe('1');
    const company = [...hs.companies.values()][0];
    expect(company.properties.md_visitors_count).toBe('2');
    expect(company.properties.md_offer_views_count).toBe('3');
    expect(hs.deals.size).toBe(2);
    expect(hs.find('deals', 'md_request_id', ia)[0].properties.md_market_reference).toBe('REF-T1');
    expect(hs.find('deals', 'md_request_id', ib)[0].properties.md_market_reference).toBe('REF-T2');
  });

  // ------------------------------------------------------------------------------------------------ 8
  it('8. HubSpot down: the request is kept, the failure is journaled, then it is synchronised', async () => {
    hs.down = true;
    const res = await post('/api/crm/leads', { brandId, firstName: 'Olga', email: 'outage@example.fr', phone: '0612345678',
      companyName: 'OUT SARL', leadSource: 'appointment_modal', message: 'Motif', slotAt: (await slots.freeAlternatives(5))[2].slots[0].slotAt, sessionId: 'sess-check-8-aaaa' });
    expect(res.status).toBe(201); // confirmation only because the request really is saved
    const id = res.body.id;
    expect(await settled(id)).toBe('failed');
    const failed = (await db.query('SELECT crm_sync_status, crm_last_error FROM crm_leads WHERE id = $1', [id])).rows[0];
    expect(failed.crm_last_error).toBeTruthy();
    expect(failed.crm_last_error).not.toContain('test-token');
    expect(hs.contacts.size + hs.deals.size).toBe(0);
    hs.down = false;
    const n = await crmSync.retryPendingCrmSyncs(50);
    expect(n).toBeGreaterThanOrEqual(1);
    expect((await db.query('SELECT crm_sync_status, crm_last_error FROM crm_leads WHERE id = $1', [id])).rows[0]).toMatchObject({ crm_sync_status: 'synced', crm_last_error: null });
    expect(hs.find('contacts', 'email', 'outage@example.fr')).toHaveLength(1);
    expect(hs.find('deals', 'md_request_id', id)).toHaveLength(1);
    await crmSync.retryPendingCrmSyncs(50); // nothing left to retry, nothing duplicated
    expect(hs.deals.size).toBe(1);
  });

  // ------------------------------------------------------------------------------------------------ 8b
  it('8b. a callback request with a phone number only (the real CallbackModal payload) reaches HubSpot', async () => {
    const res = await post('/api/crm/leads', { brandId, firstName: 'Paul', phone: '0612345679', companyName: 'TEL SARL',
      leadSource: 'callback_modal', message: 'Créneau souhaité : matin', sessionId: 'sess-check-8b-aaaa' });
    expect(res.status).toBe(201);
    expect(await settled(res.body.id)).toBe('synced');
    expect(hs.find('deals', 'md_request_id', res.body.id)).toHaveLength(1);
  });

  // ------------------------------------------------------------------------------------------------ 9
  it.todo('9. e-mails / SMS really received and errors visible - needs a real mailbox/phone and the real provider (manual, see report)');

  // ------------------------------------------------------------------------------------------------ 10
  it('10. our side of the dashboard: deals match the commercial requests and held meetings', async () => {
    const S = 'sess-check-10-aaa';
    await siretLookup(S, '10101010101010');
    const ids = [await dossierLead('d1@example.fr', S, tenderOpp), await dossierLead('d2@example.fr', S + 'x', tenderOpp2)];
    const cb = await post('/api/crm/leads', { brandId, firstName: 'Z', email: 'd3@example.fr', phone: '0612345678', leadSource: 'callback_modal', message: 'm', sessionId: S + 'y' });
    await post('/api/crm/leads', { brandId, firstName: 'Contact', email: 'd4@example.fr', leadSource: 'website_form', message: 'simple question', sessionId: S + 'z' });
    for (const id of [...ids, cb.body.id]) await settled(id);
    await new Promise((r) => setTimeout(r, 500));
    const commercial = (await db.query("SELECT COUNT(*)::int n FROM crm_leads WHERE LOWER(email) LIKE 'd_@example.fr' AND lead_source IN ('analysis_gate','callback_modal','appointment_modal')")).rows[0].n;
    expect(hs.deals.size).toBe(commercial); // a plain contact message never becomes a deal
    expect((await db.query('SELECT COUNT(*)::int n FROM crm_deals WHERE lead_id = ANY($1)', [[...ids, cb.body.id]])).rows[0].n).toBe(hs.deals.size);
    const held = (await db.query("SELECT COUNT(*)::int n FROM appointment_bookings WHERE outcome = 'attended' AND lead_id = ANY($1)", [[...ids, cb.body.id]])).rows[0].n;
    expect([...hs.deals.values()].filter((x) => x.properties.dealstage === '6323584233')).toHaveLength(held);
  });
});
