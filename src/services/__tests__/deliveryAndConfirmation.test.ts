jest.mock('../../config/database', () => ({ db: { query: jest.fn() } }));
jest.mock('../emailService', () => ({ sendEmail: jest.fn() }));

import { db } from '../../config/database';
import { sendEmail } from '../emailService';
import { deliverEmail, dossierStatusFor, alreadySent } from '../deliveryLogService';
import { sendAppointmentConfirmation, buildAppointmentConfirmationEmail } from '../appointmentConfirmationService';

const q = db.query as jest.Mock;
const send = sendEmail as jest.Mock;
const insertedStatus = () => q.mock.calls.filter(c => String(c[0]).includes('INSERT INTO message_deliveries')).map(c => c[1][2]);

beforeEach(() => { jest.clearAllMocks(); delete process.env.APPOINTMENT_CONFIRMATION_EMAILS; q.mockResolvedValue({ rows: [] }); });

describe('deliverEmail', () => {
  const base = { kind: 'dossier' as const, to: 'a@x.fr', subject: 's', html: 'h', ctx: { sessionId: 's1', opportunityId: 'o1' } };
  it('records sent only when the provider accepted the message', async () => {
    send.mockResolvedValue(true);
    expect(await deliverEmail(base)).toEqual({ status: 'sent', sent: true });
    expect(insertedStatus()).toEqual(['sent']);
  });
  it('never claims a send when no provider is configured', async () => {
    send.mockResolvedValue(false);
    expect(await deliverEmail(base)).toEqual({ status: 'not_configured', sent: false });
    expect(insertedStatus()).toEqual(['not_configured']);
  });
  it('records a provider failure with its reason and does not throw', async () => {
    send.mockRejectedValue(new Error('Resend API 422: invalid to Bearer abc'));
    const r = await deliverEmail(base);
    expect(r).toEqual({ status: 'failed', sent: false });
    const row = q.mock.calls.find(c => String(c[0]).includes('INSERT INTO message_deliveries'))!;
    expect(row[1][3]).toBe('Resend API 422: invalid to Bearer ***');
  });
  it('still returns the real status when the log itself cannot be written', async () => {
    send.mockResolvedValue(true);
    q.mockRejectedValue(new Error('db down'));
    expect(await deliverEmail(base)).toEqual({ status: 'sent', sent: true });
  });
});

describe('dossier status for the CRM', () => {
  it('maps the latest real delivery', async () => {
    q.mockResolvedValueOnce({ rows: [{ status: 'sent' }] });
    expect(await dossierStatusFor('s1', 'o1')).toBe('available');
    q.mockResolvedValueOnce({ rows: [{ status: 'failed' }] });
    expect(await dossierStatusFor('s1', 'o1')).toBe('error');
    q.mockResolvedValueOnce({ rows: [{ status: 'not_configured' }] });
    expect(await dossierStatusFor('s1', 'o1')).toBe('error');
    q.mockResolvedValueOnce({ rows: [] });
    expect(await dossierStatusFor('s1', 'o1')).toBeNull();
    expect(await dossierStatusFor(null, 'o1')).toBeNull();
  });
});

describe('appointment confirmation', () => {
  const booking = { email: 'a@x.fr', first_name: 'Ali', lot_label: 'Lot 2', title: 'École', slot_at: '2026-11-05T09:00:00Z' };

  it('is off by default: nothing is sent, a disabled row says so', async () => {
    q.mockResolvedValueOnce({ rows: [booking] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValue({ rows: [] });
    expect(await sendAppointmentConfirmation('L1')).toBe('disabled');
    expect(send).not.toHaveBeenCalled();
    expect(insertedStatus()).toEqual(['disabled']);
  });

  it('sends once enabled, and not twice for the same slot', async () => {
    process.env.APPOINTMENT_CONFIRMATION_EMAILS = 'true';
    send.mockResolvedValue(true);
    q.mockResolvedValueOnce({ rows: [booking] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValue({ rows: [] });
    expect(await sendAppointmentConfirmation('L1')).toBe('sent');
    expect(send).toHaveBeenCalledTimes(1);
    q.mockResolvedValueOnce({ rows: [booking] }).mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
    expect(await sendAppointmentConfirmation('L1')).toBe('already_sent');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('does nothing without a confirmed booking', async () => {
    process.env.APPOINTMENT_CONFIRMATION_EMAILS = 'true';
    q.mockResolvedValueOnce({ rows: [] });
    expect(await sendAppointmentConfirmation('L1')).toBe('skipped');
    expect(send).not.toHaveBeenCalled();
  });

  it('writes the time in Paris time and escapes the visitor’s name', () => {
    const { subject, html } = buildAppointmentConfirmationEmail({ firstName: '<b>Ali</b>', slotAt: '2026-11-05T09:00:00Z', marketTitle: 'École', lotLabel: 'Lot 2' });
    expect(subject).toContain('10:00');
    expect(html).toContain('&lt;b&gt;Ali&lt;/b&gt;');
    expect(html).toContain('Lot 2');
  });
});

describe('alreadySent', () => {
  it('is false when the lookup fails rather than blocking a message forever', async () => {
    q.mockRejectedValueOnce(new Error('x'));
    expect(await alreadySent('k')).toBe(false);
  });
});
