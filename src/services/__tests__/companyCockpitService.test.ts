import { buildCompanyCockpit,buildCompanyCockpitForRequests } from '../companyCockpitService';
import { STAGES } from '../hubspotDealService';
jest.mock('../../config/database', () => ({ db: { query: jest.fn() } }));

const now = new Date('2026-10-31T10:00:00Z');
it('keeps anonymous exploration distinct from a commercial request', () => {
  expect(buildCompanyCockpit({ events: ['company_selected'], hasCoordinates: false }, now)).toMatchObject({ md_progress_stage: 'company_selected', md_followup_priority: 'monitor' });
});
it('keeps the furthest observed step while highlighting a new callback', () => {
  expect(buildCompanyCockpit({ events: ['appointment_booked','offer_view'], hasCoordinates: true, requestType: 'callback', dealStage: STAGES.callback }, now)).toMatchObject({ md_progress_stage: 'appointment_booked', md_followup_priority: 'urgent' });
});
it('never equates a dossier request with a successful email delivery', () => {
  const p = buildCompanyCockpit({ events: ['analysis_completed'], hasCoordinates: true, requestType: 'dossier' }, now);
  expect(p.md_progress_stage).toBe('dossier_requested');
  expect(p.md_next_action).toContain('vérifier séparément sa livraison');
});
it('plans a future confirmed appointment and flags an unqualified past appointment', () => {
  const f = { events: [], hasCoordinates: true, requestType: 'appointment' as const, booking: { status: 'booked', outcome: 'scheduled', slot_at: '2026-11-06T10:00:00Z' } };
  expect(buildCompanyCockpit(f, now).md_followup_priority).toBe('scheduled');
  expect(buildCompanyCockpit({ ...f, booking: { ...f.booking, slot_at: '2026-10-30T10:00:00Z' } }, now).md_next_action).toContain('Renseigner le résultat');
});
it('does not recreate an urgent callback after the team closes it', () => {
  expect(buildCompanyCockpit({ events: ['callback_requested'], hasCoordinates: true, requestType: 'callback', dealStage: STAGES.lost }, now).md_followup_priority).toBe('monitor');
  expect(buildCompanyCockpit({ events: ['callback_requested'], hasCoordinates: true, requestType: 'callback', dealStage: STAGES.contact }, now).md_followup_priority).toBe('monitor');
});
it('distinguishes an attended or cancelled appointment from an upcoming one', () => {
  const f = { events: ['appointment_booked'], hasCoordinates: true, requestType: 'appointment' as const, booking: { status: 'booked', outcome: 'attended', slot_at: '2026-10-30T10:00:00Z' } };
  expect(buildCompanyCockpit(f, now).md_followup_priority).toBe('monitor');
  expect(buildCompanyCockpit({ ...f, booking: { ...f.booking, status: 'cancelled', outcome: 'cancelled' } }, now).md_next_action).toContain('replanification');
});

it('retains an older urgent open callback when the newest deal is closed',()=>{
 expect(buildCompanyCockpitForRequests({events:[],hasCoordinates:true},[
  {requestType:'dossier',dealStage:STAGES.lost},{requestType:'callback',dealStage:STAGES.callback}
 ],now).md_followup_priority).toBe('urgent');
});
it('closed requests do not override a future open appointment',()=>{
 expect(buildCompanyCockpitForRequests({events:[],hasCoordinates:true},[
  {requestType:'callback',dealStage:STAGES.signed},{requestType:'appointment',dealStage:STAGES.confirmed,booking:{status:'booked',outcome:'scheduled',slot_at:'2026-11-03T09:00:00Z'}}
 ],now).md_followup_priority).toBe('scheduled');
});
