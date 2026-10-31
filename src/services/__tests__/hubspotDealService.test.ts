jest.mock('../../config/database', () => ({ db: { query: jest.fn() } }));
jest.mock('axios', () => ({ __esModule: true, default: { request: jest.fn() } }));
jest.mock('../matchScoreService', () => ({ computeMatchScore: jest.fn() }));

import axios from 'axios';
import { db } from '../../config/database';
import { computeMatchScore } from '../matchScoreService';
import {
  requestTypeForLead, strongestType, marketTypeOf, answerProperties, targetStage, shouldWriteStage,
  buildDealProperties, syncDealForLead, STAGES, PIPELINE_ID,
} from '../hubspotDealService';

const q = db.query as jest.Mock;
const req = (axios as any).request as jest.Mock;
const score = computeMatchScore as jest.Mock;

beforeEach(() => { jest.clearAllMocks(); process.env.HUBSPOT_ACCESS_TOKEN = 't'; });

describe('request type', () => {
  it('only real commercial requests become deals', () => {
    expect(requestTypeForLead({ id: 'a', appointment_mode: 'slot' })).toBe('appointment');
    expect(requestTypeForLead({ id: 'a', lead_source: 'appointment_modal' })).toBe('appointment');
    expect(requestTypeForLead({ id: 'a', appointment_mode: 'callback' })).toBe('callback');
    expect(requestTypeForLead({ id: 'a', lead_source: 'callback_modal' })).toBe('callback');
    expect(requestTypeForLead({ id: 'a', lead_source: 'analysis_gate' })).toBe('dossier');
    expect(requestTypeForLead({ id: 'a', lead_source: 'contact_form' })).toBeNull();
    expect(requestTypeForLead({ id: 'a', lead_source: 'chatbot' })).toBeNull();
  });
  it('a request grows but never shrinks', () => {
    expect(strongestType('appointment', 'callback')).toBe('appointment');
    expect(strongestType('dossier', 'callback')).toBe('callback');
    expect(strongestType(null, 'dossier')).toBe('dossier');
  });
  it('maps market journeys', () => {
    expect(marketTypeOf('public_procurement')).toBe('public');
    expect(marketTypeOf('tender')).toBe('private');
    expect(marketTypeOf('subcontracting')).toBe('subcontracting');
    expect(marketTypeOf(null)).toBeNull();
  });
});

describe('answers and stages', () => {
  it('maps the four answers, unanswered by default', () => {
    expect(answerProperties({ capacity: 'oui', experience: 'non', calendar: 'a_confirmer' })).toEqual({
      md_answer_moyens: 'yes', md_answer_references: 'no', md_answer_disponibilite: 'unanswered', md_answer_zone: 'unanswered',
    });
  });
  it('a booking confirms the RDV, only an attended outcome reaches RDV réalisé', () => {
    expect(targetStage('callback', false, null)).toBe(STAGES.callback);
    expect(targetStage('dossier', false, null)).toBe(STAGES.callback);
    expect(targetStage('appointment', true, 'scheduled')).toBe(STAGES.confirmed);
    expect(targetStage('appointment', true, 'no_show')).toBe(STAGES.confirmed);
    expect(targetStage('appointment', true, 'attended')).toBe(STAGES.held);
    expect(targetStage('appointment', false, null)).toBe(STAGES.callback);
  });
  it('moves forward only and leaves the team’s own moves alone', () => {
    expect(shouldWriteStage(STAGES.callback, STAGES.confirmed)).toBe(true);
    expect(shouldWriteStage(STAGES.confirmed, STAGES.callback)).toBe(false);
    expect(shouldWriteStage(STAGES.proposal, STAGES.confirmed)).toBe(false);
    expect(shouldWriteStage(STAGES.lost, STAGES.confirmed)).toBe(false);
    expect(shouldWriteStage('999', STAGES.confirmed)).toBe(false);
  });
});

describe('deal properties', () => {
  const lead = { id: 'L1', lot_label: 'Lot 2', created_at: '2026-10-30T09:00:00Z' };
  const market = { title: 'Rénovation école', source_reference: 'BOAMP-26-1', official_url: 'https://x.fr/a', journey: 'public_procurement' };
  it('fills what exists and never invents a score', () => {
    const p = buildDealProperties({ lead, type: 'callback', market, answers: { capacity: 'oui' }, score: null, booking: null, forCreate: true, contactLabel: 'ACME' });
    expect(p).toMatchObject({ md_request_id: 'L1', md_request_type: 'callback', md_market_type: 'public', md_market_reference: 'BOAMP-26-1',
      md_lot_reference: 'Lot 2', md_market_url: 'https://x.fr/a', md_answer_moyens: 'yes', md_request_date: '2026-10-30T09:00:00.000Z' });
    expect(p).not.toHaveProperty('md_compatibility_score');
    expect(p).not.toHaveProperty('md_score_version');
    expect(p).not.toHaveProperty('md_appointment_outcome');
  });
  it('carries score + version + date when really computed, and scheduled for a booked slot', () => {
    const p = buildDealProperties({ lead, type: 'appointment', market, answers: null, score: 72, booking: { status: 'booked', outcome: null }, forCreate: false, contactLabel: 'ACME', now: new Date('2026-10-31T10:00:00Z') });
    expect(p).toMatchObject({ md_compatibility_score: 72, md_score_date: '2026-10-31', md_appointment_outcome: 'scheduled' });
    expect(p.md_score_version).toBeTruthy();
    expect(p).not.toHaveProperty('dealname');
  });
});

describe('syncDealForLead', () => {
  const lead = { id: 'L1', first_name: 'Ali', last_name: 'K', email: 'a@x.fr', company_name: 'ACME', appointment_mode: 'callback', opportunity_id: 'O1', session_id: 's1', created_at: '2026-10-30T09:00:00Z' };
  const factsRows = () => q
    .mockResolvedValueOnce({ rows: [{ title: 'T', source_reference: 'R', official_url: null, journey: 'tender' }] }) // opportunity
    .mockResolvedValueOnce({ rows: [{ answers: { capacity: 'oui' }, lot_id: '' }] })                                  // snapshot
    .mockResolvedValueOnce({ rows: [] });                                                                              // booking

  it('does nothing for a contact-form lead', async () => {
    expect(await syncDealForLead({ id: 'x', lead_source: 'contact_form' }, 'c1', 'co1')).toBeNull();
    expect(req).not.toHaveBeenCalled();
  });

  it('creates ONE deal in À rappeler with both associations, then remembers it', async () => {
    factsRows();
    score.mockResolvedValue({ score: 64 });
    q.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });   // crm_deals lookup, insert
    req.mockResolvedValueOnce({ data: { results: [] } })     // search by md_request_id
       .mockResolvedValueOnce({ data: { id: 'D1' } })        // create
       .mockResolvedValue({ data: {} });                     // associations
    expect(await syncDealForLead(lead, 'c1', 'co1')).toBe('D1');
    const create = req.mock.calls[1][0];
    expect(create.url).toBe('/crm/v3/objects/deals');
    expect(create.data.properties).toMatchObject({ pipeline: PIPELINE_ID, dealstage: STAGES.callback, md_request_id: 'L1', md_market_type: 'private', md_compatibility_score: 64 });
    expect(req.mock.calls.slice(2).map(c => c[0].url)).toEqual([
      '/crm/v4/objects/deals/D1/associations/default/contacts/c1', '/crm/v4/objects/deals/D1/associations/default/companies/co1']);
    expect(q.mock.calls[4][0]).toContain('INSERT INTO crm_deals');
  });

  it('a second sync of the same request updates the deal instead of creating another', async () => {
    factsRows();
    score.mockResolvedValue({ score: null });
    q.mockResolvedValueOnce({ rows: [{ hubspot_deal_id: 'D1' }] }).mockResolvedValueOnce({ rows: [] });
    req.mockResolvedValueOnce({ data: { properties: { dealstage: STAGES.callback, md_request_type: 'callback' } } })
       .mockResolvedValue({ data: {} });
    await syncDealForLead({ ...lead, appointment_mode: 'slot' }, 'c1', null);
    const methods = req.mock.calls.map(c => c[0].method + ' ' + c[0].url);
    expect(methods).not.toContain('POST /crm/v3/objects/deals');
    expect(methods).toContain('PATCH /crm/v3/objects/deals/D1');
    expect(methods.filter(m => m.includes('/companies/')).length).toBe(0);
  });

  it('keeps a deal the team already moved further, and finds a deal whose local row was lost', async () => {
    factsRows();
    score.mockResolvedValue({ score: null });
    q.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    req.mockResolvedValueOnce({ data: { results: [{ id: 'D7' }] } })                                 // found by md_request_id
       .mockResolvedValueOnce({ data: { properties: { dealstage: STAGES.proposal, md_request_type: 'appointment' } } })
       .mockResolvedValue({ data: {} });
    expect(await syncDealForLead(lead, 'c1', 'co1')).toBe('D7');
    const patch = req.mock.calls.find(c => c[0].method === 'PATCH')![0];
    expect(patch.data.properties).not.toHaveProperty('dealstage');
    expect(patch.data.properties.md_request_type).toBe('appointment');
  });
});
