jest.mock('../../config/database', () => ({ db: { query: jest.fn() } }));
jest.mock('../emailService', () => ({ sendEmail: jest.fn().mockResolvedValue(true) }));

import { db } from '../../config/database';
import { sendEmail } from '../emailService';
import { buildLeadEmail, resolveLeadRecipients, notifyTeamOfNewLead, escapeHtml } from '../leadNotificationService';

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
