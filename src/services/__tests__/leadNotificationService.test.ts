jest.mock('../../config/database', () => ({ db: { query: jest.fn() } }));
jest.mock('../emailService', () => ({ sendEmail: jest.fn().mockResolvedValue(true) }));

import { db } from '../../config/database';
import { sendEmail } from '../emailService';
import { buildLeadEmail, resolveLeadRecipients, notifyTeamOfNewLead, retryFailedLeadNotifications, escapeHtml } from '../leadNotificationService';

const q = db.query as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.LEAD_NOTIFICATION_EMAILS;
});

describe('buildLeadEmail', () => {
  it('escapes visitor-supplied HTML', () => {
    const { html } = buildLeadEmail({ id: 'x', firstName: '<b>Bob</b>', message: '<script>alert(1)</script>' });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(escapeHtml(`"'&`)).toBe('&quot;&#39;&amp;');
  });

  it('puts source, name and company in the subject', () => {
    const { subject } = buildLeadEmail({ id: 'x', firstName: 'Ali', lastName: 'K', companyName: 'ACME', leadSource: 'contact_form' });
    expect(subject).toBe('Nouveau contact (Formulaire de contact) : Ali K - ACME');
  });
});

describe('resolveLeadRecipients', () => {
  it('prefers the env list, deduped and validated', async () => {
    process.env.LEAD_NOTIFICATION_EMAILS = 'a@x.fr, A@x.fr, nope, b@x.fr';
    expect(await resolveLeadRecipients()).toEqual(['a@x.fr', 'b@x.fr']);
    expect(q).not.toHaveBeenCalled();
  });

  it('falls back to stored support email, then admins', async () => {
    q.mockResolvedValueOnce({ rows: [{ value: 'team@x.fr' }] });
    expect(await resolveLeadRecipients()).toEqual(['team@x.fr']);
    q.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ email: 'root@x.fr' }] });
    expect(await resolveLeadRecipients()).toEqual(['root@x.fr']);
  });
});

describe('notifyTeamOfNewLead', () => {
  it('emails every recipient and never throws', async () => {
    process.env.LEAD_NOTIFICATION_EMAILS = 'a@x.fr,b@x.fr';
    await notifyTeamOfNewLead({ id: '1', firstName: 'Ali' });
    expect(sendEmail).toHaveBeenCalledTimes(2);
    (sendEmail as jest.Mock).mockRejectedValueOnce(new Error('boom'));
    await expect(notifyTeamOfNewLead({ id: '2' })).resolves.toBeUndefined();
  });
});

describe('notification tracking and retry (DEV-08)', () => {
  const statusUpdates = () =>
    q.mock.calls.filter((c) => String(c[0]).includes('SET notification_status')).map((c) => c[1]);

  it('records sent / failed / no_recipient on the lead row', async () => {
    q.mockResolvedValue({ rows: [] });
    process.env.LEAD_NOTIFICATION_EMAILS = 'a@x.fr';

    (sendEmail as jest.Mock).mockResolvedValueOnce(true);
    await notifyTeamOfNewLead({ id: 'L1' });
    (sendEmail as jest.Mock).mockResolvedValueOnce(false);
    await notifyTeamOfNewLead({ id: 'L2' });
    (sendEmail as jest.Mock).mockRejectedValueOnce(new Error('boom'));
    await notifyTeamOfNewLead({ id: 'L3' });

    const withRecipient = statusUpdates();
    expect(withRecipient).toEqual([['L1', 'sent'], ['L2', 'failed'], ['L3', 'failed']]);

    delete process.env.LEAD_NOTIFICATION_EMAILS;
    q.mockReset();
    q.mockResolvedValue({ rows: [] }); // supportEmail setting + admins both empty
    await notifyTeamOfNewLead({ id: 'L4' });
    expect(statusUpdates()).toEqual([['L4', 'no_recipient']]);
  });

  it('retry re-sends only what the query returns and reports the count', async () => {
    process.env.LEAD_NOTIFICATION_EMAILS = 'a@x.fr';
    q.mockReset();
    q.mockResolvedValueOnce({ rows: [{ id: 'R1', first_name: 'Ali', lead_source: 'contact_form', message: 'hi' }] })
     .mockResolvedValue({ rows: [] });
    (sendEmail as jest.Mock).mockResolvedValue(true);

    expect(await retryFailedLeadNotifications(20)).toBe(1);
    const sql = String(q.mock.calls[0][0]);
    expect(sql).toContain("notification_status IN ('failed', 'no_recipient')");
    expect(sql).toContain('notification_attempts < 5');
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(statusUpdates()).toEqual([['R1', 'sent']]);
  });
});
