import { logger } from '../utils/logger';
interface EmailPayload {
  to: string; subject: string; html: string;
  attachments?: { filename: string; content: Buffer }[];
}
export class EmailDeliveryError extends Error {
  constructor(public readonly code: string, public readonly status?: number) {
    super(code); this.name = 'EmailDeliveryError';
  }
}
// true = accepted by Resend, not proof of delivery to the inbox.
export async function sendEmail({ to, subject, html, attachments }: EmailPayload): Promise<boolean> {
  // Outbound email stays paused until the owner explicitly enables delivery
  // after domain verification. Existing credentials alone cannot send mail.
  if (process.env.EMAIL_DELIVERY_ENABLED !== 'true') {
    logger.warn('Email not sent: delivery paused', { code: 'email_delivery_paused' });
    return false;
  }
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.EMAIL_FROM?.trim();
  if (!apiKey || !from) {
    logger.warn('Email not sent: provider configuration missing', { code: !apiKey ? 'resend_key_missing' : 'email_from_missing' });
    return false;
  }
  if (process.env.NODE_ENV === 'production' && /@resend\.dev\b/i.test(from)) {
    logger.warn('Email not sent: verified sender required', { code: 'sender_not_verified' });
    return false;
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, subject, html,
        attachments: attachments?.map(a => ({ filename: a.filename, content: a.content.toString('base64') })) }),
      signal: AbortSignal.timeout(20_000),
    });
    // Provider bodies may contain addresses or the rejected payload. Discard them.
    if (!res.ok) {
      await res.body?.cancel();
      throw new EmailDeliveryError(`resend_http_${res.status}`, res.status);
    }
    await res.body?.cancel();
    return true;
  } catch (err) {
    const failure = err instanceof EmailDeliveryError ? err : new EmailDeliveryError('resend_transport_error');
    logger.error('Email delivery failed', { code: failure.code, httpStatus: failure.status });
    throw failure;
  }
}
