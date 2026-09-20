import { logger } from '../utils/logger';

// No email provider was configured anywhere in this codebase (confirmed:
// grepped for RESEND/SENDGRID/POSTMARK/SMTP - nothing, and
// requestPasswordReset's own comment already says "In production, send
// email with reset link" and just logs). This is deliberately pluggable so
// the magic-link flow works end-to-end today (logged, retrievable from
// Render logs for testing) and switches to real delivery the moment
// RESEND_API_KEY is set - no code change needed later, just the env var.
//
// Resend picked as the default target: simple REST API (no SDK needed, one
// fetch call), generous free tier, sender domain verification is the only
// setup step. Swap this file's sendEmail() body for a different provider
// (SendGrid/Postmark/SMTP) if the client already has one of those instead.

interface EmailAttachment {
  filename: string;
  // Raw file bytes - base64-encoded before being sent to Resend below.
  content: Buffer;
}

interface EmailPayload {
  to: string;
  subject: string;
  html: string;
  attachments?: EmailAttachment[];
}

export const sendEmail = async ({ to, subject, html, attachments }: EmailPayload): Promise<void> => {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM || 'Marchés Direct <onboarding@resend.dev>';

  if (!apiKey) {
    // Not configured - log the content so the link is still usable for
    // testing (grep Render logs for "EMAIL (not sent" ) rather than the
    // magic-link feature silently doing nothing.
    const attachmentNote = attachments?.length ? ` [${attachments.length} attachment(s): ${attachments.map(a => a.filename).join(', ')}]` : '';
    logger.warn(`EMAIL (not sent - no RESEND_API_KEY configured) to=${to} subject="${subject}"${attachmentNote}\n${html}`);
    return;
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to,
        subject,
        html,
        attachments: attachments?.map(a => ({ filename: a.filename, content: a.content.toString('base64') })),
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Resend API ${res.status}: ${body}`);
    }
  } catch (err) {
    logger.error(`Failed to send email to ${to}:`, err);
    throw err;
  }
};
