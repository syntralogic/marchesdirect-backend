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
  // DEV-02/DEV-09: true when the marché is closed (declared status or deadline
  // passed) at generation time - the document must not promise an open candidature.
  isClosed?: boolean;
}

function escapeHtml(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
      .text('Marchés Direct - aperçu préparatoire offert, non contractuel. Ce n\'est pas un dossier prêt au dépôt.', { align: 'left' });
    doc.moveDown(1);

    if (input.isClosed) {
      doc.fillColor('#B42318').fontSize(11).font('Helvetica-Bold')
        .text('Marché clôturé : la candidature n\'est plus possible. Ce document ne sert que d\'exemple.');
      doc.moveDown(1);
    }

    doc.fillColor('#000000').fontSize(11).font('Helvetica-Bold').text('Sommaire');
    doc.fontSize(10).font('Helvetica').list([
      '1. Entreprise',
      '2. Marché concerné',
      '3. Éléments à compléter ou à vérifier',
      '4. Pour finaliser votre candidature',
    ], { bulletRadius: 0.1, textIndent: 6 });
    doc.moveDown(1.2);

    doc.fillColor('#000000').fontSize(12).font('Helvetica-Bold').text('1. Entreprise');
    doc.moveDown(0.3);
    doc.fontSize(13).text(input.companyName);
    doc.fontSize(10).font('Helvetica').fillColor('#5B6B80')
      .text(input.siret ? `SIRET : ${input.siret}` : 'SIRET : non communiqué');
    doc.moveDown(1.2);

    doc.fillColor('#000000').fontSize(12).font('Helvetica-Bold').text('2. Marché concerné');
    doc.moveDown(0.3);
    doc.fontSize(13).text(input.opportunityTitle);
    doc.moveDown(0.3);
    const facts: string[] = [];
    const missing: string[] = [];
    if (input.buyerName) facts.push(`Donneur d'ordre : ${input.buyerName}`); else missing.push("Donneur d'ordre");
    if (input.reference) facts.push(`Référence : ${input.reference}`); else missing.push('Référence de l\'avis');
    if (input.locationCity) facts.push(`Lieu : ${input.locationCity}`); else missing.push("Lieu d'exécution");
    if (input.submissionDeadline) facts.push(`Échéance de dépôt : ${input.submissionDeadline}`); else missing.push("Date limite de dépôt");
    if (input.estimatedValue) facts.push(`Montant estimé : ${input.estimatedValue.toLocaleString('fr-FR')} ${input.currency || 'EUR'}`); else missing.push('Montant estimé');
    if (typeof input.matchScore === 'number') facts.push(`Score de compatibilité : ${Math.round(input.matchScore)}%`);
    doc.fontSize(10).font('Helvetica').fillColor('#000000');
    facts.forEach(f => doc.text(f));
    doc.moveDown(1.2);

    doc.fontSize(12).font('Helvetica-Bold').text('3. Éléments à compléter ou à vérifier');
    doc.moveDown(0.3);
    doc.fontSize(10).font('Helvetica').list([
      ...missing.map(m => `Non communiqué par la source : ${m} (à vérifier dans l'avis officiel).`),
      'Références de votre entreprise, moyens humains et techniques, périmètre de votre réponse.',
      'Pièces administratives demandées par le règlement de consultation.',
    ], { bulletRadius: 2 });
    doc.moveDown(1.2);

    doc.fontSize(12).font('Helvetica-Bold').text('4. Pour finaliser votre candidature');
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
      <p>Voici votre dossier pré-rempli (aperçu préparatoire, pas un dossier prêt au dépôt) pour <strong>${escapeHtml(input.opportunityTitle)}</strong>, préparé à partir des informations de votre entreprise et de cette opportunité.</p>
      ${input.isClosed ? '<p><strong>Ce marché est clôturé : la candidature n\'est plus possible.</strong></p>' : ''}
      <p>Vous pouvez retrouver ce document et la suite de votre accompagnement à tout moment depuis la page "Votre dossier" de cette opportunité.</p>
      <p>— L'équipe Marchés Direct</p>
    `;
    // 27 Sep audit, point 5: propagate the real Resend result instead of
    // returning true just because sendEmail didn't throw - see the comment
    // in emailService.ts. A misconfigured/no-op send (no RESEND_API_KEY)
    // now correctly reports dossierEmailed: false to the caller, instead of
    // the site claiming "Dossier envoyé" for a message nobody received.
    return await sendEmail({
      to,
      subject: `Votre dossier pré-rempli - ${input.opportunityTitle}`,
      html,
      attachments: [{ filename: 'dossier-pre-rempli.pdf', content: pdf }],
    });
  } catch (err) {
    logger.error('Prefilled dossier email failed (non-fatal):', err);
    return false;
  }
}
