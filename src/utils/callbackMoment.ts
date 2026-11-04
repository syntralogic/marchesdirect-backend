// Refonte v26, écran 4 (formulaire "rappel"): when the visitor wants Elena to call.
export const CALLBACK_MOMENTS = ['maintenant', 'apres_midi', 'demain_matin'] as const;
export type CallbackMoment = (typeof CALLBACK_MOMENTS)[number];

export const CALLBACK_MOMENT_LABELS: Record<CallbackMoment, string> = {
  maintenant: 'Maintenant',
  apres_midi: 'Cet après-midi',
  demain_matin: 'Demain matin',
};

export function parseCallbackMoment(v: unknown): CallbackMoment | null {
  return typeof v === 'string' && (CALLBACK_MOMENTS as readonly string[]).includes(v) ? (v as CallbackMoment) : null;
}

// The line the team reads: it goes into `message`, which the team e-mail, the CRM note and the HubSpot note already carry.
export function withCallbackMoment(message: string | null | undefined, moment: CallbackMoment | null): string | null {
  const base = (message || '').trim();
  if (!moment) return base || null;
  const line = `Moment souhaité pour le rappel : ${CALLBACK_MOMENT_LABELS[moment]}`;
  return base ? `${line}\n${base}` : line;
}
