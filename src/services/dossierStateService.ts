import { db } from '../config/database';

export type DossierGenerationStatus = 'requested' | 'available' | 'error';
export type DossierEmailStatus = 'sent' | 'failed' | 'not_configured' | 'disabled' | 'not_attempted';
export type DossierContext = { leadId?: string | null; sessionId?: string | null; opportunityId?: string | null; siret?: string | null };

// This journal is deliberately independent of message_deliveries. A generated
// PDF remains generated when Resend refuses or cannot send the e-mail.
export async function recordDossierGeneration(ctx: DossierContext, status: 'generated' | 'failed', errorCode?: string): Promise<string> {
  const r = await db.query(
    `INSERT INTO dossier_generations (lead_id, session_id, opportunity_id, siret, status, error_code)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [ctx.leadId || null, ctx.sessionId || null, ctx.opportunityId || null, ctx.siret || null, status, errorCode || null]);
  return r.rows[0].id;
}

export async function dossierStatesFor(ctx: DossierContext): Promise<{
  dossierStatus: DossierGenerationStatus | null; emailStatus: DossierEmailStatus | null; errorAt?: string; errorCode?: string;
}> {
  if (!ctx.sessionId || !ctx.opportunityId) return { dossierStatus: null, emailStatus: null };
  const generation = await db.query(
    `SELECT id, status, error_code, created_at FROM dossier_generations WHERE session_id=$1 AND opportunity_id=$2
     AND ($3::text IS NULL OR siret=$3) ORDER BY created_at DESC, id DESC LIMIT 1`,
    [ctx.sessionId, ctx.opportunityId, ctx.siret || null]);
  const g = generation.rows[0];
  const delivery = g ? await db.query(
    `SELECT status, error, created_at FROM message_deliveries WHERE generation_id=$1 ORDER BY created_at DESC, id DESC LIMIT 1`, [g.id])
    : await db.query(
      `SELECT status, error FROM message_deliveries WHERE kind='dossier' AND session_id=$1 AND opportunity_id=$2
       AND generation_id IS NULL ORDER BY created_at DESC, id DESC LIMIT 1`, [ctx.sessionId, ctx.opportunityId]);
  const m = delivery.rows[0];
  if (g) {
    const failed = g.status === 'failed' || ['failed','not_configured'].includes(m?.status);
    // Only new generation records can raise alerts: old failures are held for review.
    return { dossierStatus: g.status === 'generated' ? 'available' : 'error', emailStatus: m?.status || 'not_attempted',
      ...(failed ? { errorAt: new Date(g.status === 'failed' ? g.created_at : m.created_at).toISOString(),
        errorCode: g.status === 'failed' ? 'pdf_generation_failed' : m.status === 'not_configured' ? 'email_not_configured' : 'email_send_failed' } : {}) };
  }
  // Historical proof only: the old code called Resend AFTER generating the PDF.
  // No regeneration and no resend is performed by this read or by CRM retries.
  const status = m?.status;
  const generated = status === 'sent' || status === 'not_configured';
  return { dossierStatus: generated ? 'available' : m?.error === 'pdf generation failed' ? 'error' : null,
    emailStatus: m ? (m.error === 'pdf generation failed' ? 'not_attempted' : status) : null };
}
