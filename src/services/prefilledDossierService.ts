import { recordDossierGeneration } from './dossierStateService';
import PDFDocument from 'pdfkit';
import { generateDossierPdfV2, DossierKind, DossierV2Input } from './dossierPdfV2';
import { logger } from '../utils/logger';
import { deliverEmail, recordDelivery, DeliveryContext } from './deliveryLogService';

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
  /** The lot the visitor is looking at, when known (shown in the e-mail and on the document). */
  lotLabel?: string | null;
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
  // v2 (5 nov.) : type de marché, fiche entreprise et date limite exacte pour le dossier adapté.
  journey?: string | null;
  company?: DossierV2Input['company'];
  deadlineAt?: Date | null;
  opportunityId?: string | null;
}

export const dossierKindFor = (journey?: string | null): DossierKind =>
  journey === 'subcontracting' ? 'st' : journey === 'tender' ? 'prive' : 'public';
export function dossierRef(opportunityId?: string | null, now = new Date()): string {
  const p = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
  const tail = (opportunityId || '').replace(/[^0-9a-f]/gi, '').slice(0, 4).toUpperCase() || '0000';
  return `MD-${String(p.getFullYear()).slice(2)}${String(p.getMonth() + 1).padStart(2, '0')}-${tail}`;
}

function escapeHtml(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// v28 (5 nov., contrôle client : « moins soigné que le site ») : mise en page aux couleurs du site — bandeau bleu nuit,
// accents orange, fiche du marché encadrée, « déjà prérempli », « qui fait quoi », calendrier et contact Elena.
// Polices standard (Helvetica, encodage WinAnsi) : pas de symbole hors jeu (ni ✓ ni espace fine), d'où les puces dessinées.
const C = { navy: '#0A1628', navy2: '#142B4A', orange: '#F97316', orangeDark: '#C2410C', ink: '#0A1628', grey: '#4B5B70', light: '#F2F5F9', line: '#D6E0EC', green: '#15803D', red: '#B42318' };
const pdfText = (v: string) => v.replace(/[\u202f\u00a0]/g, ' ').replace(/[\u2713\u2714]/g, '').replace(/[\u2018]/g, "'");

// Point d'entrée : dossier v2 adapté au type de marché ; en cas d'erreur, ancien gabarit (jamais de dossier perdu).
export async function generatePrefilledDossierPdf(input: PrefilledDossierInput): Promise<Buffer> {
  if (process.env.DOSSIER_PDF_V2 !== 'false') {
    try {
      const base = (process.env.FRONTEND_URL || 'https://www.marchesdirect.fr').trim().replace(/\/$/, '');
      return await generateDossierPdfV2({
        kind: dossierKindFor(input.journey), ref: dossierRef(input.opportunityId),
        url: input.opportunityId ? `${base}/mon-dossier/${input.opportunityId}` : `${base}/tableau-de-bord`,
        companyName: input.companyName, siret: input.siret, company: input.company || null, title: input.opportunityTitle, lotLabel: input.lotLabel,
        buyerName: input.buyerName, reference: input.reference, locationCity: input.locationCity, deadline: input.deadlineAt || null,
        estimatedValue: input.estimatedValue, isClosed: input.isClosed, ...((input as any).amountUnqualified ? { amountUnqualified: true } : {}),
      } as any);
    } catch (err) {
      logger.error('[Dossier PDF v2] échec, ancien gabarit utilisé :', err);
    }
  }
  return generateLegacyDossierPdf(input);
}

function generateLegacyDossierPdf(input: PrefilledDossierInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margins: { top: 50, bottom: 60, left: 50, right: 50 }, bufferPages: true, info: { Title: `Dossier prérempli - ${input.companyName}`, Author: 'Marchés Direct' } });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const W = doc.page.width; const L = 50; const CW = W - 100;
    const t = (v: string) => pdfText(v);
    const ensure = (h: number) => { if (doc.y + h > doc.page.height - 70) doc.addPage(); };
    const sectionTitle = (label: string) => {
      ensure(40);
      doc.moveDown(0.6);
      const y = doc.y;
      doc.rect(L, y + 2, 3, 13).fill(C.orange);
      doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(12.5).text(t(label), L + 10, y, { width: CW - 10 });
      doc.moveDown(0.4);
    };
    const bullet = (text: string, color: string = C.green) => {
      ensure(18);
      const y = doc.y;
      doc.rect(L + 2, y + 3.5, 5, 5).fill(color);
      doc.fillColor(C.ink).font('Helvetica').fontSize(10).text(t(text), L + 14, y, { width: CW - 14, lineGap: 2 });
      doc.moveDown(0.25);
    };

    // --- Bandeau ---------------------------------------------------------------------------------
    doc.rect(0, 0, W, 92).fill(C.navy);
    doc.rect(0, 92, W, 4).fill(C.orange);
    doc.font('Helvetica-Bold').fontSize(22).fillColor('#FFFFFF').text('Marchés', L, 30, { continued: true }).fillColor('#FB923C').text(' Direct');
    doc.font('Helvetica').fontSize(9).fillColor('#B4C1D3').text('Les marchés faits pour votre entreprise', L, 58);
    const today = new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Paris' });
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#FFFFFF').text('Dossier prérempli', L, 32, { width: CW, align: 'right' });
    doc.font('Helvetica').fontSize(9).fillColor('#B4C1D3').text(t(`Préparé le ${today}`), L, 50, { width: CW, align: 'right' });

    // --- Entreprise ---------------------------------------------------------------------------------
    doc.y = 110;
    doc.font('Helvetica').fontSize(9).fillColor(C.grey).text('PRÉPARÉ POUR', L, doc.y, { characterSpacing: 1 });
    doc.font('Helvetica-Bold').fontSize(20).fillColor(C.ink).text(t(input.companyName), L, doc.y + 2, { width: CW });
    doc.font('Helvetica').fontSize(10).fillColor(C.grey).text(input.siret ? `SIRET ${input.siret.replace(/(\d{3})(\d{3})(\d{3})(\d{5})/, '$1 $2 $3 $4')}` : 'SIRET non communiqué', L, doc.y + 2);

    if (input.isClosed) {
      doc.moveDown(0.8);
      const y = doc.y;
      doc.roundedRect(L, y, CW, 28, 6).fill('#FEE4E2');
      doc.font('Helvetica-Bold').fontSize(10).fillColor(C.red).text('Marché clôturé : la candidature n’est plus possible. Ce document ne sert que d’exemple.', L + 12, y + 9, { width: CW - 24 });
      doc.y = y + 28;
    }

    // --- Fiche du marché ---------------------------------------------------------------------------
    doc.moveDown(1);
    const facts: [string, string][] = [];
    const missing: string[] = [];
    if (input.buyerName) facts.push(['Acheteur', input.buyerName]); else missing.push('l’acheteur');
    if (input.reference) facts.push(['Référence', input.reference]); else missing.push('la référence de l’avis');
    if (input.locationCity) facts.push(['Lieu d’exécution', input.locationCity]); else missing.push('le lieu d’exécution');
    if (input.submissionDeadline) facts.push(['Date limite de dépôt', input.submissionDeadline]); else missing.push('la date limite de dépôt');
    if (input.estimatedValue) facts.push(['Montant estimé', `${input.estimatedValue.toLocaleString('fr-FR')} ${input.currency === 'EUR' || !input.currency ? '€' : input.currency}`]); else missing.push('le montant estimé');
    if (typeof input.matchScore === 'number') facts.push(['Indice de correspondance', `${Math.round(input.matchScore)} %`]);
    const top = doc.y;
    doc.font('Helvetica-Bold').fontSize(13);
    const titleH = doc.heightOfString(t(input.opportunityTitle), { width: CW - 28 });
    const lotH = input.lotLabel ? 16 : 0;
    const rows = Math.ceil(facts.length / 2);
    const boxH = 34 + titleH + lotH + 12 + rows * 30 + 8;
    ensure(boxH + 10);
    const by = doc.y;
    doc.roundedRect(L, by, CW, boxH, 10).fillAndStroke(C.light, C.line);
    doc.rect(L, by + 10, 4, boxH - 20).fill(C.orange);
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(C.orangeDark).text('MARCHÉ CONCERNÉ', L + 16, by + 14, { characterSpacing: 1 });
    doc.font('Helvetica-Bold').fontSize(13).fillColor(C.ink).text(t(input.opportunityTitle), L + 16, by + 28, { width: CW - 28 });
    let fy = by + 28 + titleH + 4;
    if (input.lotLabel) { doc.font('Helvetica').fontSize(10).fillColor(C.grey).text(t(`Lot : ${input.lotLabel}`), L + 16, fy, { width: CW - 28 }); fy += lotH; }
    fy += 8;
    const colW = (CW - 32) / 2;
    facts.forEach(([k, v], idx) => {
      const x = L + 16 + (idx % 2) * colW; const y = fy + Math.floor(idx / 2) * 30;
      doc.font('Helvetica').fontSize(8.5).fillColor(C.grey).text(t(k.toUpperCase()), x, y, { width: colW - 10, characterSpacing: 0.5 });
      doc.font('Helvetica-Bold').fontSize(10.5).fillColor(C.ink).text(t(v), x, y + 11, { width: colW - 10, height: 22, ellipsis: true });
    });
    doc.y = by + boxH; doc.x = L;
    void top;

    // --- Déjà prérempli -----------------------------------------------------------------------------
    sectionTitle('Déjà prérempli pour vous');
    bullet(`Raison sociale : ${input.companyName}`);
    bullet('Identification du marché, de l’acheteur et des échéances connues');
    if (missing.length) bullet(`Non publié par la source, à vérifier dans l’avis officiel : ${missing.join(', ')}`, C.orange);

    // --- Qui fait quoi --------------------------------------------------------------------------------
    sectionTitle('Préparer votre candidature : qui fait quoi');
    const who: [string, 'Vous' | 'Nous' | 'Ensemble'][] = [
      ['Références de chantiers similaires', 'Vous'], ['Moyens humains et matériels', 'Vous'], ['Attestations et pièces administratives', 'Vous'],
      ['Formulaires de candidature', 'Nous'], ['Mémoire technique', 'Nous'], ['Offre de prix', 'Ensemble'], ['Dépôt de la candidature', 'Nous'],
    ];
    ensure(who.length * 18 + 10);
    who.forEach(([k, v], idx) => {
      const y = doc.y;
      if (idx % 2 === 0) doc.rect(L, y - 3, CW, 18).fill(C.light);
      doc.font('Helvetica').fontSize(10).fillColor(C.ink).text(t(k), L + 10, y + 1, { width: CW - 120 });
      const color = v === 'Vous' ? C.grey : v === 'Nous' ? C.orangeDark : C.navy2;
      doc.font('Helvetica-Bold').fontSize(10).fillColor(color).text(v, L, y + 1, { width: CW - 10, align: 'right' });
      doc.y = y + 18; doc.x = L;
    });

    // --- Calendrier -------------------------------------------------------------------------------------
    sectionTitle('Votre calendrier jusqu’au dépôt');
    bullet('Aujourd’hui : indice de correspondance calculé, dossier prérempli', C.orange);
    bullet('Sous 24 h ouvrées : point téléphonique avec Elena (30 minutes offertes)', C.orange);
    bullet('Les jours suivants : vous réunissez vos pièces, nous rédigeons le mémoire technique', C.orange);
    if (input.submissionDeadline && !input.isClosed) bullet(`${input.submissionDeadline} : date limite de dépôt de la candidature`, C.orange);

    // --- Contact Elena ------------------------------------------------------------------------------------
    ensure(84);
    doc.moveDown(0.7);
    const ey = doc.y;
    doc.roundedRect(L, ey, CW, 74, 10).fill(C.navy);
    doc.rect(L, ey + 12, 4, 50).fill(C.orange);
    doc.font('Helvetica-Bold').fontSize(11.5).fillColor('#FFFFFF').text('Votre interlocutrice : Elena Popescu, chargée de relation', L + 18, ey + 12, { width: CW - 36 });
    doc.font('Helvetica').fontSize(10).fillColor('#D6E0EC').text(
      'Elena vous appelle avec ce dossier sous les yeux pour faire le point sur vos atouts, ce qu’il faut fournir et la suite. '
      + '30 minutes offertes, sans engagement. Si vous le souhaitez, nous préparons ensuite la candidature avec vous.',
      L + 18, ey + 29, { width: CW - 36, lineGap: 1.5 });
    doc.y = ey + 74; doc.x = L;

    // --- Pied de page sur chaque page ---------------------------------------------------------------------
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      doc.page.margins.bottom = 0; // sinon pdfkit ouvre une page blanche pour le pied de page
      const fy2 = doc.page.height - 42;
      doc.moveTo(L, fy2 - 8).lineTo(W - L, fy2 - 8).lineWidth(0.5).strokeColor(C.line).stroke();
      doc.font('Helvetica').fontSize(8).fillColor(C.grey).text(
        t(`Marchés Direct · marchesdirect.fr · Aperçu préparatoire offert, non contractuel : ce n’est pas une candidature déposée.   ${i - range.start + 1} / ${range.count}`),
        L, fy2, { width: CW, align: 'center', lineBreak: false });
    }
    doc.end();
  });
}

// Best-effort helper: builds + emails the PDF, swallowing/logging any
// failure so a hiccup here (PDF render, Resend outage) never blocks the
// lead-capture response itself - matching the same non-fatal pattern
// already used for CRM linking in POST /siret/lead.
export async function sendPrefilledDossierEmail(
  to: string,
  input: PrefilledDossierInput,
  ctx: DeliveryContext = {}
): Promise<boolean> {
  let pdf: Buffer;
  try {
    pdf = await generatePrefilledDossierPdf(input);
  } catch (err) {
    logger.error('Prefilled dossier PDF failed (non-fatal):', err);
    await recordDossierGeneration(ctx, 'failed', 'pdf_generation_failed');
    return false;
  }
  try {
    // Persist proof before attempting delivery; failure here must never start an untracked send.
    const generationId = await recordDossierGeneration(ctx, 'generated');
    const html = `
      <p>Bonjour,</p>
      <p>Voici votre dossier pré-rempli (aperçu préparatoire, pas un dossier prêt au dépôt) pour <strong>${escapeHtml(input.opportunityTitle)}</strong>${input.lotLabel ? ` (lot : <strong>${escapeHtml(input.lotLabel)}</strong>)` : ''}, préparé à partir des informations de votre entreprise et de cette opportunité.</p>
      ${input.isClosed ? '<p><strong>Ce marché est clôturé : la candidature n\'est plus possible.</strong></p>' : ''}
      <p>Vous pouvez retrouver ce document et la suite de votre accompagnement à tout moment depuis la page "Votre dossier" de cette opportunité.</p>
      <p>— L'équipe Marchés Direct</p>
    `;
    // 27 Sep audit, point 5: propagate the real Resend result instead of
    // returning true just because sendEmail didn't throw - see the comment
    // in emailService.ts. A misconfigured/no-op send (no RESEND_API_KEY)
    // now correctly reports dossierEmailed: false to the caller, instead of
    // the site claiming "Dossier envoyé" for a message nobody received.
    // Every attempt leaves a delivery row (sent / failed / not_configured): the site only says "envoyé" for 'sent'.
    return (await deliverEmail({
      kind: 'dossier',
      to,
      subject: `Votre dossier pré-rempli - ${input.opportunityTitle}${input.lotLabel ? ` (lot : ${input.lotLabel})` : ''}`,
      html,
      attachments: [{ filename: 'dossier-pre-rempli.pdf', content: pdf }],
      ctx: { ...ctx, generationId },
    })).sent;
  } catch (err) {
    logger.error('Prefilled dossier email failed (non-fatal):', err);
    return false;
  }
}
