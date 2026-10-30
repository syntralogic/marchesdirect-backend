import { describeEvent, buildJourneyNoteHtml, summarizeJourney, contactProperties } from '../hubspotService';

const ev = (event_type: string, event_label: string | null, event_data: any = null, at = '2026-10-30T10:00:00Z') =>
  ({ event_type, event_label, event_data, created_at: at });

describe('hubspotService pure helpers', () => {
  it('describes events in French', () => {
    expect(describeEvent(ev('search', 'Recherche : plomberie · Lyon'))).toBe('Recherche : plomberie · Lyon');
    expect(describeEvent(ev('view_opportunity', 'Rénovation école'))).toBe('Annonce consultée : Rénovation école');
    expect(describeEvent(ev('company_identified', null))).toContain('SIRET');
  });

  it('escapes HTML and caps the note length', () => {
    const html = buildJourneyNoteHtml([ev('view_opportunity', '<script>alert(1)</script>')]);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    const many = Array.from({ length: 200 }, (_, i) => ev('search', `Recherche : ${i}`));
    const big = buildJourneyNoteHtml(many);
    expect((big.match(/<li>/g) || []).length).toBe(60);
    expect(big).toContain('140 action(s) plus anciennes');
  });

  it('summarizes searches and distinct announcements', () => {
    const s = summarizeJourney([
      ev('search', 'Recherche : a'), ev('search', 'Recherche : b'),
      ev('view_opportunity', 'X', { opportunityId: '1' }), ev('view_opportunity', 'X', { opportunityId: '1' }),
      ev('view_opportunity', 'Y', { opportunityId: '2' }),
    ]);
    expect(s).toEqual({ searches: 2, opportunitiesViewed: 2, lastSearch: 'b', lastOpportunity: 'Y' });
  });

  it('only sends known values and lowercases the e-mail', () => {
    const p = contactProperties({ email: 'A@B.fr', phone: '', firstName: null, siret: '123', leadSource: 'x' });
    expect(p).toEqual({ email: 'a@b.fr', md_siret: '123', md_lead_source: 'x' });
  });
});
