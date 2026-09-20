import PDFDocument from 'pdfkit';
import { logger } from '../utils/logger';

// ============================================================================
// FREE "DOSSIER PRÉ-REMPLI" PDF
// ============================================================================
//
// Client's brief (concordance -> dossier flow, 20 Sep): once a visitor
// validates their email + phone on an opportunity's Concordance screen, a
// PDF must be sent by email and the visitor taken straight to the Dossier
// screen with a clear confirmation - no account creation required.
//
// This is deliberately a lighter document than the authenticated bid
// package (see documentService.ts's generateBidPackageZip): at this point
// in the funnel we only have what SIRET lookup + the opportunity record
// gave us, not the company's full profile (references, pricing, etc.) that
// only exists once they've signed in and filled out CompanyVaultPage. It's
// the "aperçu" the Concordance screen already promises, made into a real,
// emailed document instead of only an on-screen preview.

export interface PrefilledDossierInput {
  companyName: string;
  siret?: string | null;
  opportunityTitle: string;
  buyerName?: string | null;
  reference?: string | null;
  locationCity?: string | null;
  submissionDeadline?: string | null;
  estimatedValue?: number | null;
  currency?: string | null;
  matchScore?: number | null;
}

export function generatePrefilledDossierPdf(input: PrefilledDossierInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(18).font('Helvetica-Bold').text('Votre dossier pré-rempli', { align: 'left' });
    doc.fontSize(10).font('Helvetica').fillColor('#5B6B80')
      .text('Marchés Direct - document préparatoire offert, non contractuel', { align: 'left' });
    doc.moveDown(1.5);

    doc.fillColor('#000000').fontSize(13).font('Helvetica-Bold').text(input.companyName);
    if (input.siret) {
      doc.fontSize(10).font('Helvetica').fillColor('#5B6B80').text(`SIRET : ${input.siret}`);
    }
    doc.moveDown(1);

    doc.fillColor('#000000').fontSize(13).font('Helvetica-Bold').text(input.opportunityTitle);
    doc.moveDown(0.3);
    const facts: string[] = [];
    if (input.buyerName) facts.push(`Donneur d'ordre : ${input.buyerName}`);
    if (input.reference) facts.push(`Référence : ${input.reference}`);
    if (input.locationCity) facts.push(`Lieu : ${input.locationCity}`);
    if (input.submissionDeadline) facts.push(`Échéance de dépôt : ${input.submissionDeadline}`);
    if (input.estimatedValue) facts.push(`Montant estimé : ${input.estimatedValue.toLocaleString('fr-FR')} ${input.currency || 'EUR'}`);
    if (typeof input.matchScore === 'number') facts.push(`Score de compatibilité : ${Math.round(input.matchScore)}%`);
    doc.fontSize(10).font('Helvetica');
    facts.forEach(f => doc.text(f));
    doc.moveDown(1.5);

    doc.fontSize(11).font('Helvetica-Bold').text('Pour finaliser votre candidature');
    doc.moveDown(0.3);
    doc.fontSize(10).font('Helvetica').list([
      'Confirmer les informations et la situation de votre entreprise.',
      'Compléter vos références, vos moyens et le périmètre de votre réponse.',
      "Rassembler les pièces demandées et relire l'ensemble.",
      "Vérifier les modalités et l'échéance du dépôt sur la plateforme officielle.",
    ], { bulletRadius: 2 });
    doc.moveDown(1.5);

    doc.fontSize(9).font('Helvetica').fillColor('#5B6B80').text(
      "Ce document est une synthèse préparatoire offerte, pas une candidature déposée. "
      + "Un chargé d'affaires peut vous accompagner pour la suite : prise de rendez-vous "
      + "ou demande de rappel depuis votre espace \"Votre dossier\"."
    );

    doc.end();
  });
}

// Best-effort helper: builds + emails the PDF, swallowing/logging any
// failure so a hiccup here (PDF render, Resend outage) never blocks the
// lead-capture response itself - matching the same non-fatal pattern
// already used for CRM linking in POST /siret/lead.
export async function sendPrefilledDossierEmail(
  to: string,
  input: PrefilledDossierInput
): Promise<boolean> {
  try {
    const { sendEmail } = await import('./emailService');
    const pdf = await generatePrefilledDossierPdf(input);
    const html = `
      <p>Bonjour,</p>
      <p>Voici votre dossier pré-rempli pour <strong>${input.opportunityTitle}</strong>, préparé à partir des informations de votre entreprise et de cette opportunité.</p>
      <p>Vous pouvez retrouver ce document et la suite de votre accompagnement à tout moment depuis la page "Votre dossier" de cette opportunité.</p>
      <p>— L'équipe Marchés Direct</p>
    `;
    await sendEmail({
      to,
      subject: `Votre dossier pré-rempli - ${input.opportunityTitle}`,
      html,
      attachments: [{ filename: 'dossier-pre-rempli.pdf', content: pdf }],
    });
    return true;
  } catch (err) {
    logger.error('Prefilled dossier email failed (non-fatal):', err);
    return false;
  }
}
