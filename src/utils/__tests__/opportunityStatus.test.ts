import { isOpportunityClosed } from '../opportunityStatus';

describe('isOpportunityClosed (DEV-02)', () => {
  const now = new Date('2026-10-03T20:00:00Z');
  it('open: active with a future deadline or no deadline', () => {
    expect(isOpportunityClosed({ status: 'active', deadline: '2026-10-10T10:00:00Z' }, now)).toBe(false);
    expect(isOpportunityClosed({ status: 'active', deadline: null }, now)).toBe(false);
  });
  it('closed once the exact hour has passed, even the same day', () => {
    expect(isOpportunityClosed({ status: 'active', deadline: '2026-10-03T17:00:00Z' }, now)).toBe(true);
  });
  it('closed when the source says expired / awarded / cancelled', () => {
    for (const status of ['expired', 'awarded', 'cancelled']) expect(isOpportunityClosed({ status, deadline: null }, now)).toBe(true);
  });
});
