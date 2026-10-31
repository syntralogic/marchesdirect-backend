import { buildFunnel } from '../abandonmentReportService';

describe('buildFunnel', () => {
  it('computes step-to-step and overall conversion', () => {
    const f = buildFunnel({ search: 200, offer_view: 100, company_selected: 50, analysis_started: 40, analysis_completed: 20, dossier_preview: 10, request: 5 });
    expect(f[0]).toMatchObject({ step: 'search', sessions: 200, pctOfPrevious: null, pctOfFirst: 100 });
    expect(f[1]).toMatchObject({ pctOfPrevious: 50, pctOfFirst: 50 });
    expect(f[6]).toMatchObject({ step: 'request', sessions: 5, pctOfPrevious: 50, pctOfFirst: 2.5 });
  });
  it('does not divide by zero on an empty period', () => {
    const f = buildFunnel({});
    expect(f.every(r => r.sessions === 0 && r.pctOfFirst === null)).toBe(true);
    expect(f[1].pctOfPrevious).toBeNull();
  });
});
