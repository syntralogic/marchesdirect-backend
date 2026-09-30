import { db } from '../config/database';
import { logger } from '../utils/logger';
import { sendEmail } from './emailService';

// Until now a submitted contact/callback/lead form only landed in crm_leads
// (and the CRM sync) - nobody on the team was told. This emails the team the
// moment a lead comes in. Best-effort and fire-and-forget: it must never
// delay or fail the visitor's form submission.

export interface LeadForNotification {
  id: string;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
  companyName?: string | null;
  industryTrade?: string | null;
  locationCity?: string | null;
  locationRegion?: string | null;
  leadSource?: string | null;
  message?: string | null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const escapeHtml = (v: unknown): string =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const SOURCE_LABELS: Record<string, string> = {
  contact_form: 'Formulaire de contact',
  website_form: 'Formulaire du site',
  callback_request: 'Demande de rappel',
};

// Order: LEAD_NOTIFICATION_EMAILS env (comma separated) -> support email
// saved in Admin Settings -> active admin users. First non-empty wins.
export const resolveLeadRecipients = async (): Promise<string[]> => {
  const clean = (list: string[]) =>
    Array.from(new Set(list.map((e) => e.trim().toLowerCase()).filter((e) => EMAIL_RE.test(e))));

  const fromEnv = clean((process.env.LEAD_NOTIFICATION_EMAILS || '').split(','));
  if (fromEnv.length) return fromEnv;

  try {
    const setting = await db.query(`SELECT value FROM app_settings WHERE key = 'supportEmail'`);
    const raw = setting.rows[0]?.value;
    const fromSetting = clean(typeof raw === 'string' ? [raw] : []);
    if (fromSetting.length) return fromSetting;
  } catch (err) {
    logger.warn('Lead notification: could not read supportEmail setting:', err);
  }

  try {
    const admins = await db.query(
      `SELECT email FROM users
       WHERE role IN ('admin', 'super_admin') AND status = 'active' AND deleted_at IS NULL AND email IS NOT NULL`
    );
    return clean(admins.rows.map((r: { email: string }) => r.email));
  } catch (err) {
    logger.warn('Lead notification: could not load admin recipients:', err);
    return [];
  }
};

export const buildLeadEmail = (lead: LeadForNotification) => {
  const name = [lead.firstName, lead.lastName].filter(Boolean).join(' ').trim() || 'Visiteur';
  const sourceLabel = SOURCE_LABELS[lead.leadSource || ''] || lead.leadSource || 'Site web';
  const subject = `Nouveau contact (${sourceLabel}) : ${name}${lead.companyName ? ` - ${lead.companyName}` : ''}`;

  const rows: Array<[string, string]> = [];
  const add = (label: string, value?: string | null, html?: string) => {
    if (value && String(value).trim()) rows.push([label, html ?? escapeHtml(value)]);
  };
  add('Nom', name);
  add('Entreprise', lead.companyName);
  add('E-mail', lead.email, lead.email ? `<a href="mailto:${escapeHtml(lead.email)}">${escapeHtml(lead.email)}</a>` : undefined);
  add('Téléphone', lead.phone, lead.phone ? `<a href="tel:${escapeHtml(String(lead.phone).replace(/\s/g, ''))}">${escapeHtml(lead.phone)}</a>` : undefined);
  add('Métier', lead.industryTrade);
  add('Localisation', [lead.locationCity, lead.locationRegion].filter(Boolean).join(', '));
  add('Origine', sourceLabel);

  const table = rows
    .map(
      ([k, v]) =>
        `<tr><td style="padding:6px 12px 6px 0;color:#6b7280;vertical-align:top;white-space:nowrap">${k}</td><td style="padding:6px 0;color:#111827">${v}</td></tr>`
    )
    .join('');

  const message = lead.message && lead.message.trim()
    ? `<div style="margin-top:16px"><div style="color:#6b7280;margin-bottom:6px">Message</div><div style="white-space:pre-wrap;background:#f3f4f6;border-radius:8px;padding:12px;color:#111827">${escapeHtml(lead.message)}</div></div>`
    : '';

  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;max-width:560px">
<h2 style="margin:0 0 12px;color:#111827">Nouveau contact reçu</h2>
<table style="border-collapse:collapse">${table}</table>${message}
<p style="margin-top:20px;color:#6b7280;font-size:12px">Référence : ${escapeHtml(lead.id)} · à retrouver dans l'espace admin (Leads / Contacts).</p>
</div>`;

  return { subject, html };
};

export const notifyTeamOfNewLead = async (lead: LeadForNotification): Promise<void> => {
  try {
    const recipients = await resolveLeadRecipients();
    if (recipients.length === 0) {
      logger.warn(`Lead ${lead.id}: no notification recipient configured (set LEAD_NOTIFICATION_EMAILS)`);
      return;
    }
    const { subject, html } = buildLeadEmail(lead);
    const results = await Promise.all(recipients.map((to) => sendEmail({ to, subject, html })));
    logger.info(`Lead ${lead.id}: team notified ${results.filter(Boolean).length}/${recipients.length}`);
  } catch (err) {
    logger.error(`Lead ${lead.id}: team notification failed:`, err);
  }
};
