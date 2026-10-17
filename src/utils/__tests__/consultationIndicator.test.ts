import { buildConsultationIndicator as build, ConsultationStats } from '../consultationIndicator';

const base: ConsultationStats = { sessions24h: 0, sessions7d: 0, identified24h: 0, identified7d: 0, lastViewAgeSeconds: null };
const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';

describe('buildConsultationIndicator', () => {
  it('hides the indicator when no reliable data exists', () => {
    expect(build(base, ID_A)).toBeNull();
    expect(build({ ...base, sessions24h: 1, sessions7d: 1, lastViewAgeSeconds: 5 * 86400 }, ID_A)).toBeNull();
  });
  it('says « consultations », never « entreprises », when visitors are not identified', () => {
    const r = build({ ...base, sessions7d: 12, identified7d: 3 }, ID_A)!;
    expect(r.label).toBe('12 consultations de cette annonce ces 7 derniers jours.');
    expect(r.unit).toBe('visits');
  });
  it('says « entreprises » only when every counted visitor is an identified company', () => {
    const r = build({ ...base, sessions7d: 12, identified7d: 12 }, ID_A)!;
    expect(r.label).toBe('12 entreprises ont consulté cette annonce ces 7 derniers jours.');
  });
  it('supports the today and last-view wordings', () => {
    expect(build({ ...base, sessions24h: 5, identified24h: 5 }, ID_A)!.label).toBe('5 entreprises ont consulté cette annonce aujourd’hui.');
    expect(build({ ...base, lastViewAgeSeconds: 2 * 3600 + 120 }, ID_A)!.label).toBe('Dernière consultation il y a 2 heures.');
    expect(build({ ...base, lastViewAgeSeconds: 600 }, ID_A)!.label).toBe('Dernière consultation il y a moins d’une heure.');
  });
  it('is deterministic per announcement (stable wording) and varies across announcements', () => {
    const stats = { ...base, sessions24h: 4, sessions7d: 9, lastViewAgeSeconds: 3600 };
    expect(build(stats, ID_A)!.label).toBe(build(stats, ID_A)!.label);
    const kinds = new Set(Array.from({ length: 30 }, (_, i) => build(stats, `${i}-id`)!.kind));
    expect(kinds.size).toBeGreaterThan(1);
  });
  it('never invents figures: the number in the label is the tracked count', () => {
    const r = build({ ...base, sessions7d: 7 }, ID_B)!;
    expect(r.label).toContain('7 ');
  });
  it('has an English version', () => {
    expect(build({ ...base, sessions7d: 4 }, ID_A, 'en')!.label).toBe('4 views of this listing in the last 7 days.');
  });
});
