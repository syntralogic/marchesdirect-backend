jest.mock('../../config/database', () => ({ db: { query: jest.fn() } }));
jest.mock('../emailService', () => ({ sendEmail: jest.fn() }));

import { db } from '../../config/database';
import { sendEmail } from '../emailService';
import { busyFromIcs, overlapsBusy, removeBusySlots, getBusy, resetCalendarCache } from '../calendarAvailabilityService';
import { processDueFollowUps, scheduleFollowUps } from '../followUpService';
import { signEmail, verifyEmailSignature, unsubscribeUrl } from '../contactPreferenceService';
import { subscribe, sendDueAlerts } from '../alertSubscriptionService';

const q = db.query as jest.Mock;
const send = sendEmail as jest.Mock;
const ics = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:a
DTSTART;TZID=Europe/Paris:20261103T100000
DTEND;TZID=Europe/Paris:20261103T110000
RRULE:FREQ=WEEKLY;COUNT=2
SUMMARY:Rendez-vous
END:VEVENT
BEGIN:VEVENT
UID:free
DTSTART:20261104T090000Z
DTEND:20261104T100000Z
TRANSP:TRANSPARENT
SUMMARY:libre
END:VEVENT
END:VCALENDAR`;
const from = new Date('2026-11-01T00:00:00Z'), to = new Date('2026-12-01T00:00:00Z');

beforeEach(() => {
  jest.clearAllMocks(); resetCalendarCache();
  for (const k of ['FOLLOW_UP_EMAILS_ENABLED', 'ALERT_EMAILS_ENABLED', 'APPOINTMENT_BUSY_ICS_URL', 'PUBLIC_API_URL', 'APPOINTMENT_CALENDAR_FAIL_OPEN']) delete process.env[k];
  process.env.JWT_SECRET = 'test-secret';
  q.mockResolvedValue({ rows: [] });
});

describe('real calendar availability', () => {
  it('blocks the real calendar events (recurring expanded, TZID honoured) but not events marked free', () => {
    const busy = busyFromIcs(ics, from, to);
    expect(busy.map((b) => new Date(b.start).toISOString())).toEqual(['2026-11-03T09:00:00.000Z', '2026-11-10T09:00:00.000Z']);
  });
  it('a slot overlapping a busy interval is not offered, an adjacent one is', () => {
    const busy = busyFromIcs(ics, from, to);
    const t = (iso: string) => new Date(iso).getTime();
    expect(overlapsBusy(t('2026-11-03T09:00:00Z'), busy)).toBe(true);
    expect(overlapsBusy(t('2026-11-03T09:45:00Z'), busy, 30)).toBe(true);   // 09:45-10:15Z runs into the event (09:00-10:00Z)
    expect(overlapsBusy(t('2026-11-03T10:00:00Z'), busy)).toBe(false);
  });
  it('offers no slot at all when the calendar is configured but unreadable (fail closed)', () => {
    const days = [{ date: '2026-11-03', label: 'x', slots: [{ slotAt: '2026-11-03T13:00:00.000Z', time: '14:00' }] }];
    expect(removeBusySlots(days, { available: false, busy: [] })).toEqual([]);
    expect(removeBusySlots(days, { available: true, busy: [] })).toHaveLength(1);
  });
  it('manual blocks from the admin table remove slots', async () => {
    q.mockResolvedValueOnce({ rows: [{ starts_at: '2026-11-03T13:00:00Z', ends_at: '2026-11-03T15:00:00Z' }] });
    const cal = await getBusy(new Date('2026-11-02T08:00:00Z'));
    const days = [{ date: '2026-11-03', label: 'x', slots: [{ slotAt: '2026-11-03T13:30:00.000Z', time: '14:30' }, { slotAt: '2026-11-03T16:00:00.000Z', time: '17:00' }] }];
    expect(removeBusySlots(days, cal)[0].slots.map((s) => s.time)).toEqual(['17:00']);
  });
});

describe('reminders', () => {
  const due = (over: any = {}) => ({ rows: [{ id: 'f1', lead_id: 'L1', step: 1, email: 'a@x.fr', first_name: 'Ana', contact_mode: null, reply_received_at: null, title: 'Marché', ...over }] });
  const closedWith = () => q.mock.calls.filter((c) => String(c[0]).includes('UPDATE follow_ups SET status')).map((c) => [c[1][1], c[1][2]]);

  it('does not schedule anything for a booked appointment or an objection', async () => {
    q.mockResolvedValueOnce({ rows: [{ email: 'a@x.fr', appointment_mode: 'slot' }] });
    expect(await scheduleFollowUps('L1')).toBe(0);
    q.mockResolvedValueOnce({ rows: [{ email: 'a@x.fr', contact_mode: 'request-only' }] });
    expect(await scheduleFollowUps('L1')).toBe(0);
  });
  it('stops when the person has objected, even if the reminder was scheduled earlier', async () => {
    process.env.FOLLOW_UP_EMAILS_ENABLED = 'true'; process.env.PUBLIC_API_URL = 'https://api.x';
    q.mockImplementation(async (sql: string) => String(sql).includes('FROM follow_ups f') ? due({ contact_mode: 'request-only' }) : { rows: [] });
    const r = await processDueFollowUps();
    expect(r.stopped).toBe(1); expect(send).not.toHaveBeenCalled();
    expect(closedWith()).toContainEqual(['stopped', 'opted_out']);
  });
  it('stops when an appointment has been booked since', async () => {
    process.env.FOLLOW_UP_EMAILS_ENABLED = 'true'; process.env.PUBLIC_API_URL = 'https://api.x';
    q.mockImplementation(async (sql: string) => String(sql).includes('FROM follow_ups f') ? due() : String(sql).includes('appointment_bookings') ? { rows: [{ '?column?': 1 }] } : { rows: [] });
    expect((await processDueFollowUps()).stopped).toBe(1); expect(send).not.toHaveBeenCalled();
    expect(closedWith()).toContainEqual(['stopped', 'appointment_booked']);
  });
  it('stops when a reply was received', async () => {
    q.mockImplementation(async (sql: string) => String(sql).includes('FROM follow_ups f') ? due({ reply_received_at: '2026-11-02' }) : { rows: [] });
    expect((await processDueFollowUps()).stopped).toBe(1);
    expect(closedWith()).toContainEqual(['stopped', 'reply_received']);
  });
  it('sends nothing while switched off: closes the reminder as disabled and records it', async () => {
    q.mockImplementation(async (sql: string) => String(sql).includes('FROM follow_ups f') ? due() : { rows: [] });
    const r = await processDueFollowUps();
    expect(r.disabled).toBe(1); expect(send).not.toHaveBeenCalled();
    expect(q.mock.calls.some((c) => String(c[0]).includes('INSERT INTO message_deliveries') && c[1][2] === 'disabled')).toBe(true);
  });
  it('sends once enabled, with a working unsubscribe link, and records the real status', async () => {
    process.env.FOLLOW_UP_EMAILS_ENABLED = 'true'; process.env.PUBLIC_API_URL = 'https://api.x';
    send.mockResolvedValue(true);
    q.mockImplementation(async (sql: string) => String(sql).includes('FROM follow_ups f') ? due() : { rows: [] });
    const r = await processDueFollowUps();
    expect(r.sent).toBe(1);
    expect(send.mock.calls[0][0].html).toContain('https://api.x/api/contact/unsubscribe?e=a%40x.fr&s=');
  });
  it('refuses to send a reminder without an unsubscribe link', async () => {
    process.env.FOLLOW_UP_EMAILS_ENABLED = 'true';       // PUBLIC_API_URL missing
    q.mockImplementation(async (sql: string) => String(sql).includes('FROM follow_ups f') ? due() : { rows: [] });
    expect((await processDueFollowUps()).disabled).toBe(1); expect(send).not.toHaveBeenCalled();
  });
});

describe('unsubscribe links', () => {
  it('only the signed address can be unsubscribed', () => {
    expect(verifyEmailSignature('a@x.fr', signEmail('A@x.fr '))).toBe(true);
    expect(verifyEmailSignature('b@x.fr', signEmail('a@x.fr'))).toBe(false);
    expect(verifyEmailSignature('a@x.fr', '')).toBe(false);
  });
  it('no link without a public URL', () => { expect(unsubscribeUrl('a@x.fr')).toBeNull(); });
});

describe('trade/zone alerts', () => {
  it('needs an explicit consent and refuses an address that objected', async () => {
    expect(await subscribe({ email: 'a@x.fr', tradeId: 3, consent: false })).toMatchObject({ ok: false, status: 400 });
    q.mockResolvedValueOnce({ rows: [{ 1: 1 }] });
    expect(await subscribe({ email: 'a@x.fr', tradeId: 3, consent: true })).toMatchObject({ ok: false, status: 409 });
  });
  it('saves the request but says plainly that no e-mail went out while switched off', async () => {
    q.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ id: 'S1', confirmed_at: null }] });
    const r = await subscribe({ email: 'a@x.fr', tradeId: 3, area: '69', consent: true });
    expect(r).toMatchObject({ ok: true, alreadyConfirmed: false, confirmationEmail: 'disabled' });
    expect(send).not.toHaveBeenCalled();
  });
  it('the sweep does nothing while switched off', async () => {
    expect(await sendDueAlerts()).toEqual({ sent: 0, skipped: 0, failed: 0 });
    expect(q).not.toHaveBeenCalled();
  });
});
