import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import fs from 'fs';
import path from 'path';

// ============================================================================
// DOSSIER PDF v2 (5 nov., validé par le client sur aperçu)
//  - Marché public : dossier administratif NEUTRE, noir et blanc, au nom du candidat. Partie A = pièces à remettre
//    (bordereau, identification, capacités, références, moyens, attestations, mémoire technique prérempli), sans
//    marque Marchés Direct ; partie B = notice interne « ne pas joindre ». Aucun pourcentage.
//  - Appel d'offres privé et sous-traitance : habillage Marchés Direct, « préparé par Marchés Direct pour le candidat ».
//    Aucun pourcentage non plus (donnée commerciale du site).
// Les formulaires officiels (DC1, DC2, DC4, DUME) ne sont jamais imités : on fournit leurs données à reporter.
// En cas d'erreur, l'appelant retombe sur l'ancien gabarit (prefilledDossierService).
// ============================================================================

export type DossierKind = 'public' | 'prive' | 'st';
export interface DossierV2Input {
  kind: DossierKind;
  ref: string;
  url: string;
  companyName: string;
  siret?: string | null;
  company?: { legal?: string | null; created?: string | null; address?: string | null; city?: string | null; postal?: string | null;
              director?: string | null; employees?: string | null; ape?: string | null; activity?: string | null; source?: string | null } | null;
  title: string;
  lotLabel?: string | null;
  buyerName?: string | null;
  reference?: string | null;
  locationCity?: string | null;
  deadline?: Date | null;
  estimatedValue?: number | null;
  isClosed?: boolean;
  now?: Date;
}

const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const JOURS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const paris = (d: Date) => new Date(d.toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
export const fdate = (d: Date, day = false) => { const p = paris(d); return `${day ? JOURS[p.getDay()] + ' ' : ''}${p.getDate()} ${MOIS[p.getMonth()]} ${p.getFullYear()}`; };
const fhour = (d: Date) => { const p = paris(d); return p.getHours() === 0 && p.getMinutes() === 0 ? null : `${p.getHours()} h ${String(p.getMinutes()).padStart(2, '0')}`; };
const fsiret = (s?: string | null) => (s && /^\d{14}$/.test(s) ? s.replace(/(\d{3})(\d{3})(\d{3})(\d{5})/, '$1 $2 $3 $4') : s || '');
// « HT » n'est écrit que si l'on sait que le montant est hors taxes (v2 : jamais affirmé sans source).
// Provenance réelle des données de l'entreprise (6 nov.) : Pappers (registres officiels) ou INSEE, jamais affirmée d'office.
const provenance = (input: DossierV2Input) => {
  const src = input.company?.source || undefined;
  return src === 'pappers' ? 'registres officiels via Pappers' : src === 'insee' ? 'répertoire SIRENE de l’INSEE' : 'registres publics (Pappers ou INSEE)';
};
const money = (v?: number | null, ht = false) => (v ? `${Math.round(v).toLocaleString('fr-FR').replace(/[\u00a0\u202f]/g, ' ')} €${ht ? ' HT' : ' (montant indiqué dans l’avis, HT/TTC non précisé)'}` : null);
const clean = (s: string) => s.replace(/[  ]/g, ' ');

function fontDir(): string | null {
  for (const c of [path.join(process.cwd(), 'assets/fonts'), path.join(__dirname, '../../assets/fonts'), path.join(__dirname, '../../../assets/fonts')]) {
    if (fs.existsSync(path.join(c, 'LiberationSans-Regular.ttf'))) return c;
  }
  return null;
}

// --------------------------------------------------------------------------------------------- mise en page commune
type Theme = { ink: string; grey: string; line: string; light: string; head: string; headText: string; accent: string; accentDark: string; brand: boolean };
const BRAND: Theme = { ink: '#0A1628', grey: '#4B5B70', line: '#D6E0EC', light: '#F2F5F9', head: '#142B4A', headText: '#FFFFFF', accent: '#F97316', accentDark: '#C2410C', brand: true };
const NEUTRAL: Theme = { ink: '#111111', grey: '#555555', line: '#111111', light: '#EEEEEE', head: '#EEEEEE', headText: '#111111', accent: '#111111', accentDark: '#111111', brand: false };
const PILL: Record<string, [string, string]> = {
  'Prérempli': ['#E7F6EC', '#15803D'], 'À fournir': ['#FEF3C7', '#B45309'], 'À vérifier': ['#E8EEF7', '#142B4A'], 'Pris en charge': ['#FFF3EA', '#C2410C'],
  'Ensemble': ['#E8EEF7', '#142B4A'], 'Vous': ['#FEF3C7', '#B45309'], 'Nous': ['#FFF3EA', '#C2410C'], 'Si exigé': ['#F2F5F9', '#4B5B70'], 'Inclus': ['#E7F6EC', '#15803D'],
};
type Cell = string | { pill: string } | { bold: string };

class Layout {
  doc: PDFKit.PDFDocument; t: Theme; L = 52; W: number; CW: number; F: { r: string; b: string; i: string; h: string; hm: string };
  bottom: number;
  constructor(doc: PDFKit.PDFDocument, t: Theme, fonts: boolean) {
    this.doc = doc; this.t = t; this.W = doc.page.width; this.CW = this.W - 2 * this.L; this.bottom = doc.page.height - 62;
    this.F = fonts ? { r: 'R', b: 'B', i: 'I', h: t.brand ? 'H' : 'B', hm: t.brand ? 'HM' : 'B' } : { r: 'Helvetica', b: 'Helvetica-Bold', i: 'Helvetica-Oblique', h: 'Helvetica-Bold', hm: 'Helvetica-Bold' };
  }
  get y() { return this.doc.y; } set y(v: number) { this.doc.y = v; }
  ensure(h: number) { if (this.doc.y + h > this.bottom) { this.doc.addPage(); } }
  space(h: number) { this.doc.y += h; }
  text(s: string, o: { size?: number; font?: string; color?: string; x?: number; width?: number; align?: 'left' | 'center' | 'right' | 'justify'; gap?: number } = {}) {
    const { doc } = this; doc.font(o.font || this.F.r).fontSize(o.size || 9.6).fillColor(o.color || this.t.ink);
    const w = o.width ?? this.CW; const h = doc.heightOfString(clean(s), { width: w, lineGap: o.gap ?? 2.4 });
    this.ensure(h);
    doc.text(clean(s), o.x ?? this.L, doc.y, { width: w, align: o.align || 'left', lineGap: o.gap ?? 2.4 });
    doc.x = this.L;
  }
  small(s: string) { this.text(s, { size: 8.2, color: this.t.grey, gap: 1.8 }); }
  kicker(s: string) { this.text(s.toUpperCase(), { size: 7.8, font: this.F.hm, color: this.t.accentDark }); }
  h1(s: string) { this.text(s, { size: this.t.brand ? 16.5 : 13, font: this.F.h }); this.space(2); }
  h2(s: string) { this.ensure(40); this.space(9); this.text(s, { size: this.t.brand ? 11.5 : 10.4, font: this.F.h }); this.space(3); }
  section(num: string, kick: string, title: string, intro?: string) {
    this.kicker(`${num} · ${kick}`); this.h1(title);
    if (intro) { this.text(intro, { size: 9.6, color: this.t.grey }); this.space(6); }
  }
  private cellHeight(c: Cell, w: number, size: number) {
    const { doc } = this;
    if (typeof c === 'object' && 'pill' in c) return 13;
    const s = typeof c === 'string' ? c : c.bold;
    doc.font(typeof c === 'string' ? this.F.r : this.F.b).fontSize(size);
    return doc.heightOfString(clean(s), { width: w - 10, lineGap: 1.6 });
  }
  private drawCell(c: Cell, x: number, y: number, w: number, size: number, color?: string) {
    const { doc } = this;
    if (typeof c === 'object' && 'pill' in c) {
      const [bg, fg] = this.t.brand ? (PILL[c.pill] || ['#F2F5F9', '#4B5B70']) : ['#FFFFFF', '#111111'];
      const pw = Math.min(w - 10, 66);
      doc.roundedRect(x + 5, y - 1, pw, 13, 3).fill(bg);
      if (!this.t.brand) doc.roundedRect(x + 5, y - 1, pw, 13, 3).lineWidth(0.5).stroke('#111111');
      doc.font(this.F.b).fontSize(7.2).fillColor(fg).text(c.pill, x + 5, y + 2, { width: pw, align: 'center', lineBreak: false });
      return;
    }
    const s = typeof c === 'string' ? c : c.bold;
    doc.font(typeof c === 'string' ? this.F.r : this.F.b).fontSize(size).fillColor(color || this.t.ink).text(clean(s), x + 5, y, { width: w - 10, lineGap: 1.6 });
  }
  table(head: string[] | null, rows: Cell[][], widths: number[], o: { size?: number; zebra?: boolean; minRow?: number; sectionRows?: number[] } = {}) {
    const { doc, t } = this; const size = o.size ?? 8.6; const pad = 4.5;
    const drawHead = () => {
      if (!head) return;
      const hh = Math.max(...head.map((h, i) => { doc.font(this.F.b).fontSize(7.8); return doc.heightOfString(h, { width: widths[i] - 10 }); })) + 2 * pad;
      let x = this.L; doc.rect(this.L, doc.y, this.CW, hh).fill(t.head);
      head.forEach((h, i) => { doc.font(this.F.b).fontSize(7.8).fillColor(t.headText).text(h, x + 5, doc.y + pad, { width: widths[i] - 10, lineBreak: true }); x += widths[i]; });
      if (!t.brand) this.gridRow(doc.y, hh, widths);
      doc.y += hh;
    };
    this.ensure(40); drawHead();
    rows.forEach((r, ri) => {
      const sectionRow = o.sectionRows?.includes(ri);
      const h = Math.max(o.minRow ?? 0, sectionRow ? 16 : Math.max(...r.map((c, i) => this.cellHeight(c, widths[i], size))) + 2 * pad);
      if (doc.y + h > this.bottom) { doc.addPage(); drawHead(); }
      const y0 = doc.y;
      if (sectionRow) { doc.rect(this.L, y0, this.CW, h).fill(t.light); this.drawCell({ bold: String(r[0]) }, this.L, y0 + pad, this.CW, size); }
      else {
        if (t.brand && o.zebra !== false && ri % 2 === 1) doc.rect(this.L, y0, this.CW, h).fill(t.light);
        let x = this.L; r.forEach((c, i) => { this.drawCell(c, x, y0 + pad, widths[i], size); x += widths[i]; });
      }
      if (t.brand) doc.moveTo(this.L, y0 + h).lineTo(this.L + this.CW, y0 + h).lineWidth(0.4).stroke(t.line);
      else this.gridRow(y0, h, sectionRow ? [this.CW] : widths);
      doc.y = y0 + h;
    });
    doc.x = this.L; this.space(4);
  }
  private gridRow(y: number, h: number, widths: number[]) {
    const { doc } = this; doc.lineWidth(0.5).strokeColor('#111111').rect(this.L, y, this.CW, h).stroke();
    let x = this.L; widths.slice(0, -1).forEach(w => { x += w; doc.moveTo(x, y).lineTo(x, y + h).stroke(); });
  }
  kv(rows: [string, string][], w1 = 150) {
    const { doc, t } = this; const pad = 4.5;
    rows.forEach(([k, v]) => {
      doc.font(this.F.r).fontSize(8.6); const h = Math.max(doc.heightOfString(clean(v), { width: this.CW - w1 - 10, lineGap: 1.6 }), doc.font(this.F.b).heightOfString(k, { width: w1 - 10 })) + 2 * pad;
      this.ensure(h); const y0 = doc.y;
      doc.rect(this.L, y0, w1, h).fill(t.light);
      doc.font(this.F.b).fontSize(8.3).fillColor(t.brand ? t.grey : t.ink).text(k, this.L + 6, y0 + pad, { width: w1 - 10 });
      doc.font(this.F.r).fontSize(8.6).fillColor(t.ink).text(clean(v), this.L + w1 + 6, y0 + pad, { width: this.CW - w1 - 10, lineGap: 1.6 });
      if (t.brand) doc.moveTo(this.L, y0 + h).lineTo(this.L + this.CW, y0 + h).lineWidth(0.4).stroke(t.line); else this.gridRow(y0, h, [w1, this.CW - w1]);
      doc.y = y0 + h;
    });
    doc.x = this.L; this.space(4);
  }
  box(title: string | null, body: string, o: { bg?: string; bar?: string } = {}) {
    const { doc, t } = this; const pad = 10;
    doc.font(this.F.r).fontSize(9.2); const bh = doc.heightOfString(clean(body), { width: this.CW - 2 * pad - 6, lineGap: 2 }) + (title ? 14 : 0) + 2 * pad;
    this.ensure(bh + 6); const y0 = doc.y;
    if (t.brand) { doc.rect(this.L, y0, this.CW, bh).fill(o.bg || '#FFF3EA'); doc.rect(this.L, y0, 3, bh).fill(o.bar || t.accent); }
    else doc.lineWidth(0.8).rect(this.L, y0, this.CW, bh).stroke('#111111');
    let yy = y0 + pad;
    if (title) { doc.font(this.F.hm).fontSize(7.8).fillColor(t.brand ? t.accentDark : t.ink).text(title.toUpperCase(), this.L + pad + 6, yy); yy += 14; }
    doc.font(this.F.r).fontSize(9.2).fillColor(t.ink).text(clean(body), this.L + pad + 6, yy, { width: this.CW - 2 * pad - 6, lineGap: 2 });
    doc.y = y0 + bh + 6; doc.x = this.L;
  }
  bullets(items: string[], color: string) {
    const { doc } = this;
    items.forEach(it => {
      doc.font(this.F.r).fontSize(9.4); const h = doc.heightOfString(clean(it), { width: this.CW - 14, lineGap: 2 });
      this.ensure(h + 3); const y0 = doc.y; doc.rect(this.L + 1, y0 + 3.5, 5, 5).fill(color);
      doc.fillColor(this.t.ink).text(clean(it), this.L + 13, y0, { width: this.CW - 14, lineGap: 2 }); doc.y += 3;
    });
    doc.x = this.L;
  }
  pageBreak() { this.doc.addPage(); }
}

// --------------------------------------------------------------------------------------------- génération
export async function generateDossierPdfV2(input: DossierV2Input): Promise<Buffer> {
  const qr = await QRCode.toBuffer(input.url, { margin: 0, width: 300, errorCorrectionLevel: 'M' });
  const fonts = fontDir();
  return new Promise((resolve, reject) => {
    const theme = input.kind === 'public' ? NEUTRAL : BRAND;
    const doc = new PDFDocument({ size: 'A4', margins: { top: 62, bottom: 50, left: 52, right: 52 }, bufferPages: true, autoFirstPage: true,
      info: { Title: input.kind === 'public' ? `Dossier de candidature - ${input.companyName}` : `Dossier de préparation - ${input.ref}`, Author: input.kind === 'public' ? input.companyName : 'Marchés Direct' } });
    const chunks: Buffer[] = []; doc.on('data', c => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    if (fonts) {
      doc.registerFont('R', path.join(fonts, 'LiberationSans-Regular.ttf')); doc.registerFont('B', path.join(fonts, 'LiberationSans-Bold.ttf'));
      doc.registerFont('I', path.join(fonts, 'LiberationSans-Italic.ttf')); doc.registerFont('H', path.join(fonts, 'Poppins-Bold.ttf')); doc.registerFont('HM', path.join(fonts, 'Poppins-Medium.ttf'));
    }
    const ly = new Layout(doc, theme, !!fonts);
    try {
      if (input.kind === 'public') buildPublic(ly, input, qr); else buildBranded(ly, input, qr);
      decorate(ly, input, qr);
      doc.end();
    } catch (e) { reject(e); }
  });
}

function dl(input: DossierV2Input) {
  const d = input.deadline || null; const now = input.now || new Date();
  const days = d ? Math.max(0, Math.ceil((d.getTime() - now.getTime()) / 86400000)) : null;
  return { d, days, txt: d ? `${fdate(d, true)}${fhour(d) ? ' à ' + fhour(d) : ''}` : 'Non publiée : à vérifier dans l’avis', now };
}
const FILL = '[à compléter]';

// ----------------------------------------------------------------------------------- en-têtes, pieds, couverture
function decorate(ly: Layout, input: DossierV2Input, qr: Buffer) {
  const { doc, t } = ly; const range = doc.bufferedPageRange(); const n = range.count; const D = dl(input);
  const notice = (ly as any).noticeFrom as number | undefined;
  for (let i = 0; i < n; i++) {
    doc.switchToPage(range.start + i); const bm = doc.page.margins.bottom; doc.page.margins.bottom = 0;
    const H = doc.page.height;
    if (i === 0) { cover(ly, input, qr); doc.page.margins.bottom = bm; continue; }
    if (t.brand) {
      doc.rect(0, 0, ly.W, 40).fill('#0A1628'); doc.rect(0, 40, ly.W, 2.3).fill('#F97316');
      doc.font(ly.F.h).fontSize(9.5).fillColor('#FFFFFF').text('Marchés', ly.L, 15, { continued: true, lineBreak: false }).fillColor('#FB923C').text(' Direct', { lineBreak: false });
      doc.font(ly.F.r).fontSize(7.6).fillColor('#D6E0EC').text(`Dossier ${input.ref}  ·  ${input.companyName}  ·  ${input.kind === 'prive' ? 'Appel d’offres privé' : 'Sous-traitance'}`, ly.L, 16, { width: ly.CW, align: 'right', lineBreak: false });
      doc.image(qr, ly.W - ly.L - 90, H - 40, { width: 25 });
    } else {
      const isNotice = notice !== undefined && i >= notice;
      doc.font(ly.F.r).fontSize(7.8).fillColor('#111111').text(`${input.companyName} — Candidature — ${input.buyerName || 'Pouvoir adjudicateur'}${input.lotLabel ? ' — ' + input.lotLabel.slice(0, 40) : ''}`, ly.L, 30, { width: ly.CW - 150, lineBreak: false, ellipsis: true });
      doc.text(isNotice ? 'Partie B — Notice interne, ne pas joindre' : 'Partie A — Pièces remises', ly.L, 30, { width: ly.CW, align: 'right', lineBreak: false });
      doc.moveTo(ly.L, 42).lineTo(ly.W - ly.L, 42).lineWidth(0.6).stroke('#111111');
    }
    doc.moveTo(ly.L, H - 44).lineTo(ly.W - ly.L, H - 44).lineWidth(0.5).stroke(t.brand ? t.line : '#111111');
    const title = input.title.length > 64 ? input.title.slice(0, 64).replace(/\s+\S*$/, '') + '…' : input.title;
    doc.font(ly.F.r).fontSize(7.3).fillColor(t.grey).text(clean(`${title}  ·  Remise : ${D.d ? fdate(D.d) : 'à vérifier'}`), ly.L, H - 36, { width: ly.CW - 120, lineBreak: false });
    doc.text(`Page ${i + 1} / ${n}`, ly.L, H - 36, { width: ly.CW, align: 'right', lineBreak: false });
    doc.page.margins.bottom = bm;
  }
}

function cover(ly: Layout, input: DossierV2Input, qr: Buffer) {
  const { doc } = ly; const W = ly.W, H = doc.page.height, L = ly.L, CW = ly.CW; const D = dl(input);
  if (input.kind === 'public') {
    const c = input.company || {};
    doc.fillColor('#111111').font(ly.F.b).fontSize(10).text('CANDIDAT', L, 58);
    doc.font(ly.F.r).fontSize(10).text(`${input.companyName}${c.legal ? ' (' + c.legal + ')' : ''}`, L, 73).text(`SIRET ${fsiret(input.siret)}`, L, 87).text(`Siège : ${[c.postal, c.city].filter(Boolean).join(' ') || FILL}`, L, 101);
    doc.font(ly.F.b).text('POUVOIR ADJUDICATEUR', L, 58, { width: CW, align: 'right' });
    doc.font(ly.F.r).text(input.buyerName || '[à reporter depuis l’avis]', L + CW / 2, 73, { width: CW / 2, align: 'right' });
    doc.moveTo(L, 128).lineTo(W - L, 128).lineWidth(1).stroke('#111111');
    doc.font(ly.F.b).fontSize(11).text('MARCHÉ PUBLIC', L, 170, { width: CW, align: 'center' });
    doc.font(ly.F.r).fontSize(9.6).text('Code de la commande publique — procédure indiquée dans l’avis de publicité', L, 187, { width: CW, align: 'center' });
    const bx = L + 22, by = 215, bw = CW - 44;
    doc.font(ly.F.b).fontSize(13.5); const th = doc.heightOfString(clean(input.title), { width: bw - 40 });
    const bh = 60 + th + (input.lotLabel ? 16 : 0);
    doc.lineWidth(1.4).rect(bx, by, bw, bh).stroke(); doc.lineWidth(0.5).rect(bx + 4, by + 4, bw - 8, bh - 8).stroke();
    doc.font(ly.F.r).fontSize(8.8).text('OBJET DE LA CONSULTATION', bx, by + 14, { width: bw, align: 'center' });
    doc.font(ly.F.b).fontSize(13.5).text(clean(input.title), bx + 20, by + 30, { width: bw - 40, align: 'center' });
    if (input.lotLabel) doc.font(ly.F.r).fontSize(11).text(clean(input.lotLabel), bx + 20, by + 32 + th, { width: bw - 40, align: 'center' });
    doc.font(ly.F.r).fontSize(8.8).text(`Référence de la consultation : ${input.reference || '________________________'}`, bx, by + bh - 20, { width: bw, align: 'center' });
    let y = by + bh + 32;
    doc.font(ly.F.b).fontSize(16.5).text('DOSSIER DE CANDIDATURE ET D’OFFRE', L, y, { width: CW, align: 'center' });
    doc.font(ly.F.r).fontSize(10.4).text('Pièces administratives, pièces techniques et mémoire technique', L, y + 24, { width: CW, align: 'center' });
    y += 62;
    const rows: [string, string][] = [['Date limite de réception des offres', D.txt], ['Mode de transmission', 'Selon l’avis : dépôt électronique sur le profil d’acheteur'], ['Lieu d’exécution', input.locationCity || 'Selon l’avis']];
    if (input.estimatedValue) rows.push(['Montant estimé', money(input.estimatedValue)!]);
    rows.forEach(([k, v]) => {
      doc.lineWidth(0.5).rect(L + 22, y, 200, 22).stroke().rect(L + 222, y, CW - 244, 22).stroke();
      doc.font(ly.F.b).fontSize(9).text(k, L + 29, y + 7, { width: 190, lineBreak: false }); doc.font(ly.F.r).fontSize(9.3).text(clean(v), L + 229, y + 7, { width: CW - 258, lineBreak: false, ellipsis: true }); y += 22;
    });
    y += 22; doc.font(ly.F.b).fontSize(9.4).text('COMPOSITION DU DOSSIER', L + 22, y); y += 16;
    doc.font(ly.F.r).fontSize(9.2).text('•  Partie A — Pièces à remettre au pouvoir adjudicateur (pièces 1 à 6)', L + 32, y).text('•  Partie B — Notice de préparation, document interne au candidat, à ne pas joindre', L + 32, y + 15);
    if (input.isClosed) doc.font(ly.F.b).fontSize(10).text('Consultation clôturée à la date d’établissement : document fourni à titre d’exemple.', L, y + 46, { width: CW, align: 'center' });
    doc.moveTo(L, H - 86).lineTo(W - L, H - 86).lineWidth(0.5).stroke('#111111');
    doc.font(ly.F.r).fontSize(7.8).fillColor('#555555').text(`Dossier établi le ${fdate(D.now)} — n° ${input.ref}`, L, H - 74).text(`Les données du candidat proviennent des ${provenance(input)}. Les pièces de la consultation font foi.`, L, H - 62);
    doc.image(qr, W - L - 46, H - 80, { width: 46 }); doc.fontSize(6.4).text('Accès au dossier en ligne', L, H - 50, { width: CW - 52, align: 'right' });
    return;
  }
  // --- couverture Marchés Direct (privé, sous-traitance)
  const top = 335;
  doc.rect(0, 0, W, top).fill('#0A1628'); doc.rect(0, top, W, 6).fill('#F97316');
  doc.lineWidth(0.6).strokeColor('#16294A'); for (let i = 0; i < 14; i++) doc.moveTo(W - 270 + i * 23, 0).lineTo(W - 85 + i * 23, top).stroke();
  doc.font(ly.F.h).fontSize(19).fillColor('#FFFFFF').text('Marchés', L, 52, { continued: true, lineBreak: false }).fillColor('#FB923C').text(' Direct', { lineBreak: false });
  doc.font(ly.F.r).fontSize(8.5).fillColor('#B4C1D3').text('Les marchés faits pour votre entreprise', L, 78);
  doc.roundedRect(W - L - 176, 46, 176, 57, 4).fill('#142B4A');
  doc.font(ly.F.r).fontSize(7).fillColor('#B4C1D3').text('N° DE DOSSIER', W - L - 165, 56); doc.font(ly.F.h).fontSize(12).fillColor('#FFFFFF').text(input.ref, W - L - 165, 67);
  doc.font(ly.F.r).fontSize(7).fillColor('#B4C1D3').text(`Établi le ${fdate(D.now)}`, W - L - 165, 87);
  const kind = input.kind === 'prive' ? 'APPEL D’OFFRES PRIVÉ' : 'SOUS-TRAITANCE';
  doc.font(ly.F.h).fontSize(8); const kw = doc.widthOfString(kind) + 16; doc.roundedRect(L, 140, kw, 18, 3).fill('#F97316'); doc.fillColor('#FFFFFF').text(kind, L + 8, 145, { lineBreak: false });
  doc.font(ly.F.h).fontSize(25).fillColor('#FFFFFF').text('Dossier de préparation', L, 172).text('de candidature', L, 203);
  doc.font(ly.F.b).fontSize(11).fillColor('#FFFFFF').text(clean(input.title), L, 258, { width: CW - 20, height: 44, ellipsis: true });
  if (input.lotLabel) doc.font(ly.F.r).fontSize(10).fillColor('#D6E0EC').text(clean(input.lotLabel), L, doc.y + 2, { width: CW - 20, lineBreak: false, ellipsis: true });
  let y = top + 40;
  const rows: [string, string][] = [['Préparé pour', input.companyName], ['SIRET', fsiret(input.siret) || 'Non communiqué'],
    [input.kind === 'prive' ? 'Donneur d’ordre' : 'Entreprise principale', input.buyerName || 'Communiqué par Elena'], ['Date limite de remise', D.txt], ['Dossier préparé par', 'Marchés Direct, pour le candidat']];
  rows.forEach(([k, v]) => {
    doc.font(ly.F.r).fontSize(7.8).fillColor('#4B5B70').text(k.toUpperCase(), L, y + 2, { width: 140, lineBreak: false });
    doc.font(ly.F.b).fontSize(10.5).fillColor('#0A1628').text(clean(v), L + 145, y, { width: CW - 145 - 140, lineBreak: false, ellipsis: true });
    doc.moveTo(L, y + 18).lineTo(W - L - 140, y + 18).lineWidth(0.5).stroke('#D6E0EC'); y += 30;
  });
  doc.roundedRect(W - L - 118, top + 28, 118, 136, 4).lineWidth(0.6).fillAndStroke('#FFFFFF', '#D6E0EC');
  doc.image(qr, W - L - 104, top + 40, { width: 90 });
  doc.font(ly.F.b).fontSize(7).fillColor('#0A1628').text('Retrouvez ce dossier en ligne', W - L - 118, top + 138, { width: 118, align: 'center' });
  doc.font(ly.F.r).fontSize(6.6).fillColor('#4B5B70').text(input.ref, W - L - 118, top + 149, { width: 118, align: 'center' });
  y += 16;
  if (D.days !== null) {
    doc.rect(L, y, CW, 60).fill('#FFF3EA'); doc.rect(L, y, 3.5, 60).fill('#F97316');
    doc.font(ly.F.h).fontSize(21).fillColor('#C2410C').text(`J-${D.days}`, L + 18, y + 18, { lineBreak: false });
    doc.font(ly.F.b).fontSize(10.4).fillColor('#0A1628').text(`${D.days} jour${D.days > 1 ? 's' : ''} avant la remise de votre ${input.kind === 'st' ? 'proposition' : 'offre'}`, L + 92, y + 16);
    doc.font(ly.F.r).fontSize(8.8).fillColor('#4B5B70').text('Le rétroplanning détaillé figure en section 8. Elena vous appelle pour le caler avec vous.', L + 92, y + 33, { width: CW - 104 });
    y += 76;
  }
  if (input.isClosed) { doc.font(ly.F.b).fontSize(10).fillColor('#B42318').text('Marché clôturé : ce dossier ne sert que d’exemple.', L, y); y += 20; }
  doc.font(ly.F.r).fontSize(7.8).fillColor('#4B5B70').text('CE DOSSIER CONTIENT', L, y); y += 14;
  const items = ['Synthèse et questions à poser', 'Identité du marché et pièces à lire', 'Liste des pièces à fournir', 'Données préremplies de votre entreprise',
    input.kind === 'prive' ? 'Trame de la note méthodologique' : 'Trame de votre proposition technique', input.kind === 'prive' ? 'Rétroplanning et remise' : 'Rétroplanning et formalités d’agrément'];
  items.forEach((it, i) => { const x = L + (i % 2) * (CW / 2), yy = y + Math.floor(i / 2) * 17; doc.rect(x, yy + 3, 5.5, 5.5).fill('#F97316'); doc.font(ly.F.r).fontSize(9.2).fillColor('#0A1628').text(it, x + 12, yy, { lineBreak: false }); });
  doc.moveTo(L, H - 64).lineTo(W - L, H - 64).lineWidth(0.5).stroke('#D6E0EC');
  doc.font(ly.F.r).fontSize(7).fillColor('#4B5B70').text(`Document préparatoire établi par Marchés Direct à partir de données publiques (avis, ${provenance(input)}).`, L, H - 54)
    .text('Il ne remplace ni les pièces de la consultation ni les formulaires officiels.', L, H - 44);
}

// ----------------------------------------------------------------------------------- MARCHÉ PUBLIC (neutre)
function pieceTitle(ly: Layout, n: number, title: string, sub?: string) {
  const { doc } = ly; ly.ensure(60); const y0 = doc.y;
  doc.rect(ly.L, y0, 74, 28).fill('#EEEEEE'); doc.lineWidth(1).rect(ly.L, y0, ly.CW, 28).stroke('#111111'); doc.moveTo(ly.L + 74, y0).lineTo(ly.L + 74, y0 + 28).stroke();
  doc.font(ly.F.b).fontSize(9).fillColor('#111111').text(`PIÈCE ${n}`, ly.L + 8, y0 + 10, { lineBreak: false });
  doc.fontSize(11).text(title.toUpperCase(), ly.L + 84, y0 + 8.5, { width: ly.CW - 92, lineBreak: false });
  doc.y = y0 + 34; doc.x = ly.L; if (sub) { ly.small(sub); ly.space(4); }
}
function art(ly: Layout, s: string) { ly.ensure(40); ly.space(8); ly.text(s, { size: 9.8, font: ly.F.b }); ly.space(2); }

function buildPublic(ly: Layout, input: DossierV2Input, _qr: Buffer) {
  const c = input.company || {}; const D = dl(input); const CW = ly.CW; const name = input.companyName;
  ly.pageBreak(); // page 1 = couverture (dessinée par decorate)
  ly.text('BORDEREAU DES PIÈCES REMISES', { size: 13, font: ly.F.b, align: 'center' });
  ly.text(`${input.title}${input.lotLabel ? ' — ' + input.lotLabel : ''}`, { size: 9.4, color: '#555555', align: 'center' }); ly.space(10);
  ly.table(['N°', 'Désignation de la pièce', 'Origine', 'Jointe'], [
    ['A. CANDIDATURE'], ['1', 'Lettre de candidature (formulaire DC1) ou DUME', 'Formulaire officiel — données en pièce 1', '□'],
    ['2', 'Déclaration du candidat (formulaire DC2) ou DUME', 'Formulaire officiel — données en pièce 2', '□'], ['3', 'Références de travaux similaires', 'Pièce 3 du présent dossier', '□'],
    ['4', 'Moyens humains et matériels', 'Pièce 4 du présent dossier', '□'], ['5', 'Attestations et certificats (Kbis, URSSAF, fiscale, assurances, qualifications)', 'Documents originaux du candidat', '□'],
    ['B. OFFRE'], ['6', 'Mémoire technique', 'Pièce 6 du présent dossier', '□'], ['7', 'Acte d’engagement (ATTRI1 ou modèle de l’acheteur)', 'Pièce du DCE à compléter', '□'],
    ['8', 'Décomposition du prix global et forfaitaire (DPGF) ou bordereau des prix', 'Pièce du DCE à compléter', '□'], ['9', 'Autres pièces exigées par le règlement de la consultation', '[selon RC]', '□'],
  ], [30, CW - 210, 135, 45], { sectionRows: [0, 6] });
  ly.small('Les formulaires DC1 et DC2 sont les modèles publiés par la Direction des affaires juridiques du ministère de l’Économie ; le document unique de marché européen (DUME) peut les remplacer. Le règlement de la consultation précise les pièces exigées.');
  ly.space(26); ly.text('Fait à [lieu], le [date]'); ly.space(4); ly.text(`Pour ${name}, [nom et qualité du signataire]`);

  ly.pageBreak(); pieceTitle(ly, 1, 'Identification du candidat', `Données à reporter dans le formulaire DC1 ou dans la partie II du DUME. Source : ${provenance(input)}, à vérifier par le candidat.`);
  art(ly, '1.1 — Candidat');
  ly.kv([['Dénomination sociale', name], ['Forme juridique', c.legal || FILL], ['Numéro SIRET', fsiret(input.siret) || FILL], ['Code APE (NAF)', [c.ape, c.activity].filter(Boolean).join(' — ') || FILL],
    ['Adresse du siège social', [c.address, [c.postal, c.city].filter(Boolean).join(' ')].filter(Boolean).join(', ') || FILL], ['Date de création', c.created || FILL],
    ['N° de TVA intracommunautaire', FILL], ['Adresse électronique', FILL], ['Téléphone', FILL]]);
  art(ly, '1.2 — Mode de candidature');
  ly.kv([['Candidature', '■ Candidat individuel      □ Membre d’un groupement'], ['Lot(s) concerné(s)', input.lotLabel || '[selon l’avis]'], ['Sous-traitance envisagée', '□ Oui (formulaire DC4)      □ Non']]);
  art(ly, '1.3 — Personne habilitée à engager le candidat');
  ly.kv([['Nom, prénom', c.director || FILL], ['Qualité', '[président, gérant…]'], ['Délégation de pouvoir', '□ Non requise (représentant légal)      □ Jointe']]);
  ly.small('Les déclarations sur l’honneur (absence d’interdiction de soumissionner, articles L2141-1 à L2141-5 du Code de la commande publique) figurent dans le formulaire DC1 ou le DUME : elles doivent être cochées et signées par le candidat lui-même.');

  ly.pageBreak(); pieceTitle(ly, 2, 'Capacités économiques, financières et professionnelles', 'Données à reporter dans le formulaire DC2 ou dans la partie IV du DUME.');
  const y = (D.now.getFullYear() - 1);
  art(ly, '2.1 — Chiffre d’affaires des trois derniers exercices disponibles');
  ly.table(['Exercice', 'Chiffre d’affaires global HT', 'Chiffre d’affaires relatif aux travaux du lot HT', 'Part (%)'], [y, y - 1, y - 2].map(e => [String(e), FILL, FILL, FILL]), [60, 140, CW - 260, 60]);
  art(ly, '2.2 — Effectifs');
  ly.table(['Année', 'Effectif moyen annuel', 'Dont encadrement'], [y, y - 1, y - 2].map(e => [String(e), FILL, FILL]), [80, (CW - 80) / 2, (CW - 80) / 2]);
  if (c.employees) ly.small(`Tranche d’effectif (${provenance(input)}) : ${c.employees}.`);
  art(ly, '2.3 — Qualifications et certifications professionnelles');
  ly.table(['Organisme', 'Qualification ou certification', 'N°', 'Validité'], [['Qualibat / Qualifelec / Qualit’EnR / autre', FILL, FILL, FILL], ['Mention RGE', FILL, FILL, FILL], ['Autre habilitation utile au lot', FILL, FILL, FILL]], [130, CW - 310, 80, 100]);
  art(ly, '2.4 — Assurances');
  ly.table(['Garantie', 'Assureur', 'N° de police', 'Période de validité'], [['Responsabilité civile professionnelle', FILL, FILL, FILL], ['Responsabilité civile décennale', FILL, FILL, FILL]], [150, CW - 330, 80, 100]);

  ly.pageBreak(); pieceTitle(ly, 3, 'Références de travaux similaires', 'Travaux de même nature réalisés au cours des cinq dernières années. Joindre, si possible, les attestations de bonne exécution.');
  ly.table(['N°', 'Maître d’ouvrage et contact', 'Nature des travaux', 'Montant HT', 'Année', 'Attestation'], [1, 2, 3, 4, 5].map(i => [String(i), FILL, FILL, FILL, FILL, FILL]), [24, 120, CW - 342, 70, 52, 76], { minRow: 50 });

  ly.pageBreak(); pieceTitle(ly, 4, 'Moyens humains et matériels', 'Moyens dont dispose le candidat et moyens affectés au présent lot.');
  art(ly, '4.1 — Personnel affecté au chantier');
  ly.table(['Fonction', 'Nom', 'Qualification, habilitations', 'Ancienneté'], [['Conducteur de travaux / responsable du lot', FILL, FILL, FILL], ['Chef d’équipe', FILL, FILL, FILL], ['Ouvrier qualifié', FILL, FILL, FILL], ['Compagnon', FILL, FILL, FILL]], [150, 95, CW - 315, 70]);
  art(ly, '4.2 — Matériel et outillage');
  ly.table(['Désignation', 'Nombre', 'Observations'], [['Véhicules utilitaires', FILL, ''], ['Outillage spécifique au lot', FILL, ''], ['Appareils de mesure et de contrôle', FILL, ''], ['Moyens de levage et d’accès en hauteur', FILL, '']], [CW - 230, 75, 155]);
  art(ly, '4.3 — Pièces à joindre (pièce 5)');
  ly.table(['Document', 'Délivré par', 'Validité exigée', 'Joint'], [['Extrait Kbis', 'Greffe du tribunal de commerce', 'Moins de 3 mois', '□'], ['Attestation de vigilance', 'URSSAF', 'Moins de 6 mois (art. D8222-5 du Code du travail)', '□'],
    ['Attestation de régularité fiscale', 'Direction générale des finances publiques', 'En cours de validité', '□'], ['Attestation d’assurance RC professionnelle', 'Assureur', 'Année en cours', '□'],
    ['Attestation d’assurance décennale', 'Assureur', 'Année en cours, activités du lot', '□'], ['Certificats de qualification', 'Organisme certificateur', 'En cours de validité', '□']], [150, 130, CW - 325, 45]);

  ly.pageBreak(); pieceTitle(ly, 6, 'Mémoire technique', `Établi par ${name} en réponse au cahier des clauses techniques particulières (CCTP). Les passages entre crochets sont à compléter par le candidat.`);
  const mem: [string, string][] = [
    ['1. Présentation du candidat', `${name}${c.legal ? ', ' + c.legal : ''}${input.siret ? ' immatriculée sous le numéro SIRET ' + fsiret(input.siret) : ''}, exerce l’activité ${c.activity ? '« ' + c.activity.toLowerCase() + ' »' : '[activité]'}${c.ape ? ' (code APE ' + c.ape + ')' : ''}${c.created ? ' depuis ' + c.created : ''}${c.city ? ', à partir de son siège de ' + c.city : ''}. [Compléter : historique, effectif, principaux clients publics]`],
    ['2. Compréhension du projet et contraintes du site', `Le présent ${input.lotLabel ? 'lot' : 'marché'} porte sur « ${input.title} »${input.lotLabel ? ' (' + input.lotLabel + ')' : ''}${input.buyerName ? ' pour le compte de ' + input.buyerName : ''}${input.locationCity ? ', à ' + input.locationCity : ''}. [Compléter après lecture du CCTP et visite : état existant, occupation du bâtiment pendant les travaux, interfaces avec les autres lots, objectifs à atteindre]`],
    ['3. Moyens humains affectés', 'Le chantier sera placé sous la responsabilité de [nom, fonction], interlocuteur unique du maître d’œuvre. L’équipe affectée est détaillée en pièce 4. [Habilitations et qualifications du personnel]'],
    ['4. Méthodologie d’exécution', 'Les travaux seront conduits selon les phases suivantes : préparation et approvisionnements ; installation de chantier ; exécution des ouvrages ; essais et contrôles ; réception. [Détailler chaque phase en reprenant les prescriptions du CCTP]'],
    ['5. Planning prévisionnel', '[Planning détaillé en semaines, cohérent avec le délai d’exécution fixé par le CCAP et le calendrier des autres lots]'],
    ['6. Matériaux et équipements proposés', 'Les matériaux et équipements proposés sont conformes ou équivalents aux références du CCTP. Les fiches techniques sont jointes en annexe. [Lister : marque, modèle, performances]'],
    ['7. Hygiène, sécurité et environnement', 'Le candidat met en œuvre les mesures de prévention prévues par le plan général de coordination, le cas échéant. Les déchets de chantier sont triés et leur élimination est tracée. [Compléter : filières de traitement, mesures propres au site]'],
    ['8. Réception, garanties et maintenance', 'À l’achèvement, le candidat remet le dossier des ouvrages exécutés et assure, le cas échéant, la formation des utilisateurs. [Compléter : garanties, délai d’intervention pendant l’année de parfait achèvement]'],
  ];
  mem.forEach(([h, txt]) => { art(ly, h); ly.text(txt, { align: 'justify' }); });
  ly.space(14); ly.text('Fait à [lieu], le [date] — [nom, qualité et signature]');

  // --- Partie B
  ly.pageBreak(); (ly as any).noticeFrom = ly.doc.bufferedPageRange().count - 1;
  const { doc } = ly; const y0 = doc.y; doc.lineWidth(0.8).rect(ly.L, y0, CW, 44).stroke('#111111');
  doc.font(ly.F.b).fontSize(12.5).fillColor('#111111').text('PARTIE B — NOTICE DE PRÉPARATION', ly.L + 12, y0 + 9); doc.font(ly.F.i).fontSize(9.4).fillColor('#555555').text('Document interne au candidat. Ne pas joindre à l’offre.', ly.L + 12, y0 + 27);
  doc.y = y0 + 52; doc.x = ly.L;
  ly.h2('B.1 — Pièces du dossier de consultation à lire');
  ly.table(['Pièce', 'Points à vérifier'], [['Règlement de la consultation (RC)', 'Pièces exigées, critères et pondération, visite obligatoire, variantes, date et heure limites, date limite des questions.'], ['Acte d’engagement (AE)', 'Prix, délai d’exécution, coordonnées bancaires, signature.'],
    ['CCAP', 'Pénalités, avance, retenue de garantie, délai de paiement, révision des prix.'], ['CCTP', 'Ouvrages à réaliser, performances, références de produits, essais.'], ['DPGF ou bordereau des prix', 'À remplir sans modifier le cadre, les quantités ni les intitulés.'], ['Plans, diagnostics, PGC', 'Contraintes du site, repérage amiante, règles de sécurité du chantier.']], [160, CW - 160]);
  ly.h2('B.2 — Calendrier de préparation');
  ly.table(['Date', 'Étape', 'Fait'], plan(D, [[0, 'Téléchargement du DCE, lecture du RC'], [1, 'Lecture du CCTP, questions écrites à l’acheteur'], [1, 'Demande des attestations (URSSAF, fiscale, assurances)'], [4, 'Chiffrage de la DPGF'], [4, 'Rédaction du mémoire technique (pièce 6)'], [5, 'Relecture et contrôle des pièces'], [6, 'Dépôt sur le profil d’acheteur, au plus tard la veille']]).map(([d, w]) => [d, w, '□']), [140, CW - 185, 45]);
  ly.h2('B.3 — Contrôle avant dépôt');
  ly.table(null, [['□', 'Toutes les pièces du bordereau sont jointes, lisibles, au format PDF, nommées clairement.'], ['□', 'Les attestations sont en cours de validité à la date limite.'], ['□', 'La DPGF est complète et les totaux sont vérifiés.'],
    ['□', 'L’acte d’engagement est complété ; signature électronique si le RC l’exige au stade du dépôt.'], ['□', 'Dépôt effectué avant l’heure limite : une offre reçue hors délai est irrecevable.'], ['□', 'Accusé de réception horodaté téléchargé et conservé.']], [26, CW - 26]);
  ly.space(6);
  ly.small('Repère réglementaire : depuis le décret n° 2025-1386 du 29 décembre 2025, les marchés de travaux inférieurs à 100 000 € HT peuvent être conclus sans publicité ni mise en concurrence ; au-delà et jusqu’à 5 404 000 € HT (seuil européen 2026-2027), la procédure adaptée s’applique.');
  ly.space(4); ly.small(`Notice établie le ${fdate(D.now)} par Marchés Direct (www.marchesdirect.fr), dossier n° ${input.ref}, à partir de l’avis publié et des ${provenance(input)}. Document préparatoire : les pièces de la consultation font foi.`);
}

function plan(D: ReturnType<typeof dl>, steps: [number, string][]): [string, string][] {
  // Délai plus court que le plan type : on resserre les étapes proportionnellement (jamais d'étapes empilées le dernier jour).
  const maxOff = Math.max(...steps.map(x => x[0]), 1);
  const room = D.days !== null ? Math.max(0, D.days - 1) : maxOff;
  const k = room < maxOff ? room / maxOff : 1;
  return steps.map(([off0, what]) => {
    const off = Math.round(off0 * k);
    let d = new Date(D.now.getTime() + off * 86400000);
    while ([0, 6].includes(paris(d).getDay())) d = new Date(d.getTime() + 86400000);
    if (D.d && d > D.d) d = D.d;
    const s = fdate(d, true); return [s.charAt(0).toUpperCase() + s.slice(1), what];
  });
}

// ----------------------------------------------------------------------------------- PRIVÉ / SOUS-TRAITANCE (Marchés Direct)
function buildBranded(ly: Layout, input: DossierV2Input, _qr: Buffer) {
  const st = input.kind === 'st'; const CW = ly.CW; const D = dl(input); const c = input.company || {};
  ly.pageBreak();
  ly.section('0', 'Sommaire', 'Comment utiliser ce dossier', 'Ce dossier rassemble ce qu’il faut pour décider vite et répondre correctement : ce que nous avons déjà préparé, ce qu’il vous reste à fournir, et dans quel ordre. Chaque pièce porte un statut.');
  ly.h2('Légende des statuts');
  ly.table(null, [[{ pill: 'Prérempli' }, 'Nous l’avons déjà rempli avec vos données publiques : à relire.'], [{ pill: 'À fournir' }, 'Document que vous seul pouvez produire (attestation, chiffre d’affaires, références).'],
    [{ pill: 'À vérifier' }, 'Information à confirmer dans les pièces de la consultation.'], [{ pill: 'Pris en charge' }, 'Rédigé ou réalisé par notre équipe si vous choisissez l’accompagnement.']], [80, CW - 80], { zebra: false });
  ly.h2('Sommaire');
  const toc = ['Synthèse', 'Identité du marché', 'Questions à poser avant de chiffrer', st ? 'Documents à obtenir de l’entreprise principale' : 'Pièces de la consultation à lire', st ? 'Dossier d’agrément du sous-traitant' : 'Pièces de candidature',
    'Données préremplies de votre entreprise', st ? 'Trame de la proposition technique' : 'Trame de la note méthodologique', 'Rétroplanning jusqu’à la remise', st ? 'Contrat, paiement et démarrage' : 'Remise et signature', 'Votre accompagnement'];
  ly.table(null, toc.map((tt, i) => [{ bold: String(i + 1) }, tt]), [30, CW - 30], { zebra: false, size: 10 });
  ly.box(null, 'Important. Ce dossier vous fait gagner le travail de recherche et de mise en forme. Les pièces officielles de la consultation font foi : en cas de différence, ce sont elles qui s’appliquent.', { bg: '#F2F5F9', bar: '#142B4A' });

  // 1. Synthèse
  ly.pageBreak(); ly.section('1', 'Synthèse', 'Notre lecture en une page');
  const atouts: string[] = []; const vig: string[] = [];
  if (c.activity) atouts.push(`Votre activité : ${c.activity}.`);
  if (input.locationCity) atouts.push(`Lieu d’exécution : ${input.locationCity}.`);
  if (st) atouts.push('La loi du 31 décembre 1975 protège votre paiement : paiement direct si le marché principal est public, caution ou délégation de paiement s’il est privé.');
  else atouts.push('Consultation privée : le donneur d’ordre peut négocier, votre réactivité compte.');
  if (D.days !== null && D.days < 10) vig.push(`Délai court : ${D.days} jour${D.days > 1 ? 's' : ''} pour réunir les pièces et chiffrer.`);
  if (!input.estimatedValue) vig.push('Montant non communiqué : à obtenir avant de chiffrer.');
  vig.push(st ? 'Le maître d’ouvrage (acheteur public ou client privé) doit vous accepter et agréer vos conditions de paiement avant tout démarrage.' : 'En privé, le prix et les conditions de paiement pèsent lourd : préparez votre marge de négociation.');
  ly.text('Vos atouts', { font: ly.F.h, size: 10.5, color: '#15803D' }); ly.bullets(atouts, '#15803D'); ly.space(4);
  ly.text('Points de vigilance', { font: ly.F.h, size: 10.5, color: '#B45309' }); ly.bullets(vig, '#B45309'); ly.space(6);
  ly.box('Notre recommandation', st ? 'Se positionner, en exigeant avant le premier jour de chantier votre acceptation par le maître d’ouvrage (formulaire DC4 en marché public) et, en marché privé, la caution ou la délégation de paiement.' : 'Répondre, avec une visite du site avant chiffrage et des conditions de paiement écrites (acompte, échéancier, retenue de garantie).');

  // 2. Identité
  ly.pageBreak(); ly.section('2', 'Identité du marché', 'Les informations essentielles, au même endroit', 'Relevées dans l’annonce. Les lignes « à vérifier » doivent être confirmées avec le donneur d’ordre.');
  const rows: [string, string][] = [['Objet', input.title]]; if (input.lotLabel) rows.push(['Lot / périmètre', input.lotLabel]);
  rows.push([st ? 'Entreprise principale' : 'Donneur d’ordre', input.buyerName || 'Communiqué par Elena']); rows.push(['Cadre', st ? 'Sous-traitance (loi n° 75-1334 du 31 décembre 1975)' : 'Consultation privée, hors Code de la commande publique']);
  rows.push(['Lieu d’exécution', input.locationCity || 'À vérifier'], ['Montant', money(input.estimatedValue) || 'Non communiqué'], ['Date limite', D.txt]); if (input.reference) rows.push(['Référence', input.reference]);
  ly.kv(rows);
  ly.h2(st ? 'Ce qui change en sous-traitance' : 'Ce qui change en privé');
  ly.text(st ? 'Vous ne contractez pas avec le maître d’ouvrage mais avec l’entreprise principale. La loi du 31 décembre 1975 impose que le maître d’ouvrage vous accepte et agrée vos conditions de paiement. Si le marché principal est public, cette acceptation ouvre droit au paiement direct par l’acheteur lorsque votre prestation atteint 600 € TTC. S’il est privé, l’entreprise principale doit garantir votre paiement par une caution bancaire ou une délégation de paiement (article 14), et vous disposez d’une action directe contre le maître d’ouvrage si elle ne vous paie pas (article 12).'
    : 'Le Code de la commande publique ne s’applique pas : pas de formulaires DC1 ou DC2, pas de règlement de consultation imposé. Le donneur d’ordre choisit librement, peut négocier, et c’est le contrat signé qui fixe tout. Votre devis et vos conditions générales deviennent donc des pièces décisives.');

  // 3. Questions
  ly.pageBreak(); ly.section('3', 'Questions à poser', 'Les réponses à obtenir avant de chiffrer', 'Posez ces questions par écrit : les réponses sécurisent votre prix et vous évitent les mauvaises surprises en cours de chantier. Colonne de droite : notez la réponse obtenue.');
  const qs = st ? ['Quel est le montant de la prestation sous-traitée, et est-il ferme ou révisable ?', 'Le marché principal est-il public ou privé, et votre acceptation par le maître d’ouvrage (DC4 en public) sera-t-elle faite avant votre démarrage ?', 'Quelles pénalités et quelle retenue de garantie vous seront appliquées ?', 'Quelles sont vos dates d’intervention et les interfaces avec les autres corps d’état ?', 'Qui fournit quoi : matériel, levage, base vie, évacuation des déchets ?', 'Qui est le coordonnateur SPS, et un PPSPS est-il attendu ?', 'Quelle garantie de paiement : paiement direct (marché public), caution bancaire ou délégation de paiement (marché privé) ?']
    : ['Le budget des travaux a-t-il été validé, et pour quel montant ?', 'Qui est votre interlocuteur technique ?', 'Une étude, un diagnostic ou des plans existent-ils ?', 'Quelles contraintes d’occupation des lieux pendant les travaux ?', 'Des aides publiques sont-elles sollicitées ? Une mention RGE peut alors être exigée.', 'Quel acompte et quel échéancier de paiement sont prévus ?', 'Quelle date de démarrage est attendue, et à quelle date les travaux doivent-ils être terminés ?'];
  ly.table(null, qs.map((q, i) => [{ bold: String(i + 1) }, q, '']), [24, CW - 170, 146], { zebra: false, size: 9.6, minRow: 34 });

  // 4. Documents
  ly.pageBreak();
  if (st) {
    ly.section('4', 'Documents à obtenir', 'Ce que l’entreprise principale doit vous transmettre', 'Pour chiffrer juste et vous protéger, réclamez ces documents par écrit avant de remettre votre proposition.');
    ly.table(['Pièce', 'Ce qu’il faut y chercher', 'Statut'], [[{ bold: 'Extrait du CCTP du lot sous-traité' }, 'Le périmètre exact de votre prestation et les performances attendues.', { pill: 'À vérifier' }], [{ bold: 'Planning du marché principal' }, 'Vos dates d’intervention, les interfaces avec les autres corps d’état.', { pill: 'À vérifier' }],
      [{ bold: 'Extrait du CCAP' }, 'Pénalités et retenues : elles ne peuvent pas être plus lourdes pour vous que pour le titulaire.', { pill: 'À vérifier' }], [{ bold: 'Plans et carnet de détails' }, 'Réseaux, emplacements, réservations.', { pill: 'À vérifier' }],
      [{ bold: 'PGC et coordonnées du coordonnateur SPS' }, 'Nécessaires pour rédiger votre PPSPS.', { pill: 'Si exigé' }], [{ bold: 'Projet de contrat de sous-traitance' }, 'Prix, révision, délais, conditions de paiement, assurances.', { pill: 'À vérifier' }]], [150, CW - 230, 80]);
  } else {
    ly.section('4', 'Pièces de la consultation', 'Le dossier remis par le donneur d’ordre', 'En privé, la consultation tient souvent en quelques documents. Demandez-les tous par écrit avant de chiffrer.');
    ly.table(['Pièce', 'Ce qu’il faut y chercher', 'Statut'], [[{ bold: 'Lettre de consultation' }, 'Objet, date limite, forme attendue de la réponse, interlocuteur.', { pill: 'À vérifier' }], [{ bold: 'Cahier des charges' }, 'Prestations attendues, matériaux, performances, contraintes d’occupation des lieux.', { pill: 'À vérifier' }],
      [{ bold: 'Plans, études, diagnostics' }, 'Indispensables pour chiffrer juste.', { pill: 'À vérifier' }], [{ bold: 'Projet de contrat ou conditions d’achat' }, 'Pénalités, garanties, délais de paiement, retenue de garantie : à négocier avant de signer.', { pill: 'À vérifier' }],
      [{ bold: 'Pouvoir du signataire' }, 'Vérifiez que votre interlocuteur peut engager le donneur d’ordre (par exemple un syndic mandaté par l’assemblée générale).', { pill: 'À vérifier' }]], [150, CW - 230, 80]);
  }
  ly.box('Le conseil d’Elena', st ? 'Exigez que les pénalités qui vous sont appliquées ne dépassent pas celles du marché principal pour votre part de travaux.' : 'Demandez systématiquement une visite : elle évite les mauvaises surprises au chiffrage et montre votre sérieux au donneur d’ordre.');

  // 5. Pièces
  ly.pageBreak();
  const P5: [string, string, string, string][] = st ? [['Déclaration de sous-traitance', 'Formulaire DC4 en marché public, déclaration écrite au maître d’ouvrage en privé : prestation, montant, conditions de paiement.', 'Prérempli', '—'], ['Déclarations sur l’honneur', 'Absence d’interdiction de soumissionner (marché public).', 'Si exigé', '—'],
    ['Extrait Kbis', 'Preuve d’immatriculation.', 'À fournir', 'Moins de 3 mois'], ['Attestation de vigilance URSSAF', 'À renouveler tous les 6 mois pendant toute l’exécution.', 'À fournir', 'Moins de 6 mois'], ['Attestation de régularité fiscale', 'Espace professionnel impots.gouv.fr.', 'À fournir', 'En cours'],
    ['Assurances RC professionnelle et décennale', 'Couvrant les activités sous-traitées.', 'À fournir', 'Année en cours'], ['Capacités et références', 'Pour que le maître d’ouvrage vérifie que vous pouvez exécuter la prestation.', 'À fournir', '—'], ['RIB', 'Pour vos paiements (paiement direct en marché public).', 'À fournir', '—'],
    ['Cartes BTP des salariés', 'Chaque salarié présent sur le chantier doit détenir sa carte BTP.', 'À fournir', 'En cours'], ['PPSPS', 'Plan particulier de sécurité, si un coordonnateur SPS est désigné.', 'Si exigé', '—']]
    : [['Lettre de candidature', 'Une page : qui vous êtes, ce que vous proposez, pourquoi vous.', 'Pris en charge', '—'], ['Présentation de l’entreprise', 'Activité, effectif, zone, certifications.', 'Prérempli', '—'], ['Extrait Kbis', 'Preuve d’immatriculation.', 'À fournir', 'Moins de 3 mois'],
      ['Attestation de vigilance URSSAF', 'Le donneur d’ordre doit la demander au-delà de 5 000 € HT (Code du travail, art. L8222-1).', 'À fournir', 'Moins de 6 mois'], ['Assurance responsabilité civile professionnelle', 'Attestation de l’année en cours.', 'À fournir', 'Année en cours'],
      ['Assurance décennale', 'Obligatoire pour les travaux concernés ; elle doit figurer sur le devis.', 'À fournir', 'Année en cours'], ['Qualifications (RGE, Qualibat…)', 'RGE indispensable si des aides publiques sont sollicitées.', 'À vérifier', 'En cours'], ['Références', '3 chantiers comparables.', 'À fournir', '—'], ['Devis détaillé et conditions', 'Voir section 7.', 'Ensemble', '—']];
  ly.section('5', st ? 'Dossier d’agrément' : 'Pièces de candidature', st ? 'Ce que le maître d’ouvrage doit recevoir pour vous accepter' : `Votre dossier de présentation : ${P5.length} pièces`, st ? 'L’entreprise principale présente ce dossier au maître d’ouvrage (l’acheteur public ou le client privé). Tant qu’il n’a pas accepté et agréé vos conditions de paiement, vous ne devez pas démarrer.' : undefined);
  ly.table(['Pièce', 'À quoi elle sert', 'Statut', 'Validité'], P5.map(([a, b, s, v]) => [{ bold: a }, b, { pill: s }, v]), [140, CW - 295, 80, 75]);

  // 6. Données
  ly.pageBreak(); ly.section('6', 'Données préremplies', 'Votre entreprise, prête à reporter', `Ces informations proviennent des ${provenance(input)}. Vérifiez-les, complétez les cases vides : elles servent pour ${st ? 'la déclaration de sous-traitance et le contrat.' : 'votre lettre de candidature et votre devis.'}`);
  ly.h2('Identification');
  ly.kv([['Raison sociale', input.companyName], ['Forme juridique', c.legal || FILL], ['SIRET', fsiret(input.siret) || FILL], ['Code NAF', [c.ape, c.activity].filter(Boolean).join(' — ') || FILL],
    ['Adresse du siège', [c.address, [c.postal, c.city].filter(Boolean).join(' ')].filter(Boolean).join(', ') || FILL], ['Création', c.created || FILL], ['Effectif', c.employees || FILL], ['Dirigeant', c.director || FILL]]);
  ly.h2('Capacité économique');
  const yy = D.now.getFullYear() - 1;
  ly.table(['Exercice', 'Chiffre d’affaires global HT', 'Dont activité concernée HT'], [yy, yy - 1, yy - 2].map(e => [String(e), FILL, FILL]), [80, (CW - 80) / 2, (CW - 80) / 2]);
  if (st) { ly.h2('Prestation sous-traitée (pour la déclaration de sous-traitance)'); ly.kv([['Nature', input.lotLabel || input.title], ['Montant maximum HT', FILL], ['TVA', 'Autoliquidation : facture HT, la TVA est déclarée par l’entreprise principale (CGI, art. 283-2 nonies)'], ['Paiement', 'Marché public : direct par l’acheteur dès 600 € TTC. Marché privé : caution bancaire ou délégation de paiement']]); }

  // 7. Trame
  ly.pageBreak();
  const T7: [string, string, string, string][] = st ? [['1. Périmètre chiffré', 'Ce qui est inclus et exclu : évite les litiges en fin de chantier.', '1 page', 'Ensemble'], ['2. Équipe et encadrement', 'Chef d’équipe nommé, effectif mobilisable aux dates du planning.', '½ page', 'Ensemble'],
    ['3. Planning d’intervention', 'Calé sur le planning général, avec vos délais d’approvisionnement.', '½ page', 'Pris en charge'], ['4. Interfaces', 'Réservations, réseaux, autres corps d’état : qui fait quoi.', '½ page', 'Pris en charge'], ['5. Prix et révision', 'Prix ferme ou révisable, mêmes indices que le marché principal.', 'Annexe', 'Vous'], ['6. Conformité administrative', 'Pièces de la section 5 jointes d’emblée : c’est un argument commercial.', 'Annexe', 'Vous']]
    : [['1. Notre compréhension du besoin', 'Reformuler l’objectif et les contraintes du donneur d’ordre.', '½ page', 'Pris en charge'], ['2. Solution proposée', 'Matériaux, équipements, justification des choix.', '1 page', 'Ensemble'], ['3. Organisation du chantier', 'Occupation des lieux, information des occupants, sécurité.', '1 page', 'Pris en charge'],
      ['4. Planning', 'Dates de commande, de démarrage, de fin.', '½ page', 'Pris en charge'], ['5. Devis détaillé', 'Par poste, avec mentions obligatoires, assurance décennale et durée de validité.', 'Annexe', 'Vous'], ['6. Conditions de paiement', 'Acompte, échéancier, retenue de garantie limitée à 5 % (loi du 16 juillet 1971).', '½ page', 'Ensemble'], ['7. Garanties et entretien', 'Garanties, contrat d’entretien proposé.', '½ page', 'Ensemble']];
  ly.section('7', st ? 'Proposition technique' : 'Note méthodologique et offre', st ? 'Ce que l’entreprise principale veut lire' : 'Une réponse courte, claire, rassurante', st ? 'L’entreprise générale cherche un sous-traitant fiable, au bon prix, qui tient le planning et ne crée pas de risque administratif.' : 'En privé, le donneur d’ordre lit vite. Une note de 3 à 5 pages et un devis limpide font la différence.');
  ly.table(['Chapitre', 'Ce que le lecteur attend', 'Volume', 'Rédaction'], T7.map(([a, b, v, s]) => [{ bold: a }, b, v, { pill: s }]), [140, CW - 270, 50, 80]);
  ly.box('Ce qui fait la différence', st ? 'Un prix clair et un dossier administratif complet dès le premier envoi : l’entreprise principale gagne du temps, c’est souvent ce qui la décide.' : 'Un devis lisible par un non-spécialiste, des délais tenus par écrit, et des références vérifiables : la confiance compte autant que le prix.', { bg: '#E7F6EC', bar: '#15803D' });

  // 8. Rétroplanning
  ly.pageBreak(); ly.section('8', 'Rétroplanning', D.d ? `Du ${fdate(D.now)} au ${fdate(D.d)}` : 'Les étapes jusqu’à la remise', 'Un plan réaliste, à ajuster avec Elena pendant votre appel.');
  const steps: [number, string, string][] = st ? [[0, 'Appel avec Elena', 'Nous'], [1, 'Demande des documents à l’entreprise principale', 'Vous'], [4, 'Chiffrage', 'Vous'], [6, 'Proposition technique et pièces administratives', 'Nous'], [9, 'Négociation du contrat de sous-traitance', 'Ensemble'], [13, 'Remise de la proposition', 'Ensemble']]
    : [[0, 'Appel avec Elena', 'Nous'], [2, 'Visite du site', 'Vous'], [5, 'Consultation de vos fournisseurs', 'Vous'], [8, 'Chiffrage et devis', 'Vous'], [10, 'Rédaction de la note méthodologique', 'Nous'], [13, 'Relecture et envoi', 'Ensemble']];
  const pl = plan(D, steps.map(([o, w]) => [o, w]));
  ly.table(['Date', 'Étape', 'Qui'], pl.map(([d, w], i) => [{ bold: d }, w, { pill: steps[i][2] }]), [140, CW - 225, 85]);
  ly.small('Les attestations URSSAF et fiscale se téléchargent en quelques minutes dans vos espaces en ligne ; l’attestation d’assurance peut demander plusieurs jours à votre assureur : demandez-la dès aujourd’hui.');

  // 9. Contrat
  ly.pageBreak();
  ly.section('9', st ? 'Contrat et paiement' : 'Remise et signature', st ? 'Sécuriser votre paiement avant le premier jour' : 'Avant d’envoyer, et avant de signer', st ? 'La sous-traitance protège bien le sous-traitant, à condition de respecter ces étapes.' : 'En privé, tout se joue dans le contrat. Ces points vous protègent.');
  const chk = st ? ['Déclaration de sous-traitance transmise au maître d’ouvrage (DC4 signée par l’entreprise principale et par vous en marché public).', 'Acceptation et agrément des conditions de paiement notifiés avant votre démarrage.', 'Contrat de sous-traitance signé : prix, délais, pénalités, révision, assurances.', 'Facturation HT avec la mention « autoliquidation » (CGI, art. 283-2 nonies).', 'Marché public : demandes de paiement direct adressées au titulaire, qui dispose de 15 jours pour les accepter ou les refuser ; passé ce délai, l’acheteur peut payer.', 'Marché privé : caution bancaire ou délégation de paiement remise avant la signature du contrat (loi de 1975, art. 14).', 'Attestation URSSAF renouvelée tous les 6 mois pendant le chantier.', 'Cartes BTP de chaque salarié présentes sur le chantier.']
    : ['Devis daté, numéroté, avec durée de validité et mentions de l’assurance décennale.', 'Délai de paiement : 60 jours maximum après la date de la facture, ou 45 jours fin de mois (Code de commerce, art. L441-10).', 'Acompte à la commande prévu par écrit.', 'Retenue de garantie limitée à 5 %, remplaçable par une caution bancaire.', 'Pénalités de retard plafonnées et réciproques.', 'Bon pour accord signé avant toute commande de matériel.', 'Procès-verbal de réception signé à la fin des travaux.'];
  ly.table(null, chk.map(x => ['□', x]), [24, CW - 24], { zebra: false, size: 9.2 });
  ly.box(null, st ? 'Votre meilleure garantie : en marché public, l’acheteur vous paie lui-même ; en marché privé, la caution ou la délégation de paiement vous protège si l’entreprise principale rencontre des difficultés. Sans elle, le contrat de sous-traitance peut être annulé à votre demande.' : 'Conservez une trace écrite de chaque échange : en cas de désaccord, c’est votre meilleure protection.', { bg: '#F2F5F9', bar: '#142B4A' });

  // 10. Accompagnement
  ly.pageBreak(); ly.section('10', 'Votre accompagnement', 'Qui fait quoi, et la suite');
  ly.table(['Étape', 'Qui', 'Prestation'], [['Recherche et analyse du marché', { pill: 'Nous' }, 'Inclus'], ['Dossier de préparation (ce document)', { pill: 'Nous' }, 'Inclus'], ['Appel de 30 minutes avec Elena', { pill: 'Nous' }, 'Inclus'],
    ['Attestations, chiffre d’affaires, références', { pill: 'Vous' }, '—'], ['Chiffrage', { pill: 'Vous' }, '—'], [st ? 'Proposition technique et dossier d’agrément' : 'Note méthodologique et mise en forme de l’offre', { pill: 'Nous' }, 'Sur demande']], [CW - 200, 95, 105]);
  const { doc } = ly; ly.space(10); ly.ensure(120); const ey = doc.y;
  doc.rect(ly.L, ey, CW, 110).fill('#0A1628'); doc.rect(ly.L, ey, 4, 110).fill('#F97316');
  doc.font(ly.F.hm).fontSize(7.8).fillColor('#FB923C').text('VOTRE INTERLOCUTRICE', ly.L + 18, ey + 16);
  doc.font(ly.F.h).fontSize(15).fillColor('#FFFFFF').text('Elena Popescu', ly.L + 18, ey + 28);
  doc.font(ly.F.r).fontSize(9).fillColor('#B4C1D3').text('Chargée de relation, Marchés Direct', ly.L + 18, ey + 49);
  doc.font(ly.F.r).fontSize(9.6).fillColor('#E8EEF7').text('« J’ai ce dossier sous les yeux. Pendant notre appel, on regarde ensemble vos atouts, les pièces qui manquent et le planning, et vous décidez ensuite, sans engagement. »', ly.L + 18, ey + 64, { width: CW - 150, lineGap: 2 });
  doc.image(_qr, ly.L + CW - 108, ey + 14, { width: 80 }); doc.font(ly.F.r).fontSize(6.8).fillColor('#B4C1D3').text('Scannez pour retrouver votre dossier', ly.L + CW - 124, ey + 97, { width: 112, align: 'center' });
  doc.y = ey + 122; doc.x = ly.L;
  ly.h2('Mentions');
  ly.small(`Dossier n° ${input.ref} établi le ${fdate(D.now)} par Marchés Direct (www.marchesdirect.fr) pour ${input.companyName}. Document préparatoire et non contractuel, établi à partir de données publiques : annonce, ${provenance(input)}. Il ne constitue ni une candidature ni une offre, ne remplace pas les pièces de la consultation et ne garantit pas l’obtention du marché. Les références réglementaires citées sont à jour à sa date d’établissement. Vos données sont traitées de manière confidentielle et ne sont jamais revendues.`);
}
