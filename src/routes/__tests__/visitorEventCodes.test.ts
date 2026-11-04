import { HUBSPOT_EVENT_CODES } from '../visitorEvents';

// Refonte v26: existing codes are kept as they are, and exactly the agreed new ones are added.
describe('visitor event codes', () => {
  it('keeps every existing code', () => {
    for (const c of ['offer_view', 'company_selected', 'analysis_started', 'analysis_completed', 'dossier_preview', 'dossier_requested', 'callback_requested', 'appointment_booked']) {
      expect(HUBSPOT_EVENT_CODES).toContain(c);
    }
  });
  it('adds the refonte codes', () => {
    for (const c of ['ranked_list_shown', 'alert_requested', 'invitation_30min_shown', 'invitation_30min_closed', 'invitation_30min_clicked']) {
      expect(HUBSPOT_EVENT_CODES).toContain(c);
    }
  });
});
