// Facts of a visitor request that must reach the team in clear text (client brief v26, section 4-5):
// the callback moment the visitor chose, the question they wrote, the appointment slot they asked for.
// Pure functions, no I/O: the HubSpot note, the team e-mail and the tests all use the same wording.

export const CALLBACK_MOMENTS = ['maintenant', 'apres_midi', 'demain_matin'] as const;
export type CallbackMoment = typeof CALLBACK_MOMENTS[number];

const MOMENT_LABEL: Record<CallbackMoment, string> = {
  maintenant: 'Maintenant (dans l’heure, de 9 h à 18 h)',
  apres_midi: 'Cet après-midi',
  demain_matin: 'Demain matin',
};

export function parseCallbackMoment(v: unknown): CallbackMoment | null {
  return typeof v === 'string' && (CALLBACK_MOMENTS as readonly string[]).includes(v) ? (v as CallbackMoment) : null;
}
export const callbackMomentLabel = (m: CallbackMoment | string | null | undefined): string | null =>
  m && m in MOMENT_LABEL ? MOMENT_LABEL[m as CallbackMoment] : null;

// A request is test data when the caller says so (preview deployments) or the whole server is a test environment.
export function isTestRequest(bodyFlag: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
  return bodyFlag === true || bodyFlag === 'true' || env.MARK_LEADS_AS_TEST === '1';
}

const frDateTime = (d: Date | string | null | undefined) =>
  d ? new Date(d).toLocaleString('fr-FR', { timeZone: 'Europe/Paris', dateStyle: 'full', timeStyle: 'short' }) : null;

export interface VisitRequest {
  type: 'dossier' | 'callback' | 'appointment' | 'question' | 'alert' | 'other';
  at: Date | string | null;
  marketTitle?: string | null;
  lot?: string | null;
  callbackMoment?: string | null;
  slotAt?: Date | string | null;
  message?: string | null;
  phone?: string | null;
}

const TYPE_LABEL: Record<VisitRequest['type'], string> = {
  dossier: 'Dossier prérempli demandé', callback: 'Demande de rappel', appointment: 'Demande de rendez-vous (30 minutes)',
  question: 'Question', alert: 'Alerte nouveaux marchés', other: 'Demande',
};

export function requestTypeOfLead(l: { lead_source?: string | null; appointment_mode?: string | null; message?: string | null }): VisitRequest['type'] {
  if (l.lead_source === 'alert_request') return 'alert';
  if (l.appointment_mode === 'slot' || l.lead_source === 'appointment_modal') return 'appointment';
  if (l.appointment_mode === 'callback' || l.lead_source === 'callback_modal') return 'callback';
  if (l.lead_source === 'analysis_gate') return 'dossier';
  if (l.lead_source === 'contact_form' && l.message) return 'question';
  return 'other';
}

// ONE note per visit (session): the text is rebuilt from every request of the visit and the same HubSpot note is updated.
export function buildVisitNote(args: {
  visitDate: Date | string | null; company?: string | null; siret?: string | null;
  source?: string | null; campaign?: string | null; isTest?: boolean; requests: VisitRequest[];
}): string {
  const lines: string[] = [];
  lines.push(`Visite du ${frDateTime(args.visitDate) || 'jour inconnu'}${args.isTest ? ' [DONNÉES DE TEST]' : ''}`);
  if (args.company) lines.push(`Entreprise : ${args.company}${args.siret ? ` (SIRET ${args.siret})` : ''}`);
  if (args.source || args.campaign) lines.push(`Origine : ${[args.source, args.campaign].filter(Boolean).join(' / ')}`);
  for (const r of args.requests) {
    lines.push('');
    lines.push(`${TYPE_LABEL[r.type]} — ${frDateTime(r.at) || ''}`.trim());
    if (r.marketTitle) lines.push(`Marché : ${r.marketTitle}${r.lot ? ` (lot : ${r.lot})` : ''}`);
    const moment = callbackMomentLabel(r.callbackMoment);
    if (moment) lines.push(`Moment de rappel choisi : ${moment}`);
    if (r.type === 'appointment' && r.slotAt) lines.push(`Créneau souhaité : ${frDateTime(r.slotAt)} — à confirmer par téléphone`);
    if (r.type === 'question' && r.message) lines.push(`Question : « ${r.message.replace(/\s+/g, ' ').trim()} »`);
    if (r.phone) lines.push(`Téléphone : ${r.phone}`);
  }
  return lines.join('\n');
}

// Filename of the prefilled dossier: "dossier-<company>.pdf", ASCII only, never empty.
export function dossierPdfFilename(companyName: string | null | undefined): string {
  const slug = String(companyName || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return slug ? `dossier-${slug}.pdf` : 'dossier-pre-rempli.pdf';
}
