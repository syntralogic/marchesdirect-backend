import { STAGES } from './hubspotDealService';

export type CockpitFacts = {
  events: string[];
  hasCoordinates: boolean;
  requestType?: 'dossier' | 'callback' | 'appointment' | null;
  dealStage?: string | null;
  booking?: { status: string; outcome: string | null; slot_at: Date | string } | null;
};

// Progress is historical; urgency concerns the latest commercial request and
// respects the team's disposition in HubSpot. Neither means an email was sent.
export function buildCompanyCockpit(f: CockpitFacts, now = new Date()): Record<string, string> {
  const seen = new Set(f.events);
  let stage = 'company_selected';
  if (seen.has('analysis_completed')) stage = 'analysis_completed';
  if (f.hasCoordinates) stage = 'contact_details';
  if (seen.has('dossier_requested') || f.requestType === 'dossier') stage = 'dossier_requested';
  if (seen.has('callback_requested') || f.requestType === 'callback') stage = 'callback_requested';
  if (seen.has('appointment_booked') || f.booking?.status === 'booked') stage = 'appointment_booked';
  let priority = 'monitor';
  let action = 'Consulter le parcours ; aucune nouvelle demande commerciale à traiter.';
  if (f.dealStage === STAGES.lost || f.dealStage === STAGES.signed) {
    action = 'Dernière demande clôturée ; consulter son historique.';
  } else if (f.booking) {
    const b = f.booking;
    if (b.outcome === 'attended') action = 'Rendez-vous réalisé ; consulter la prochaine étape commerciale.';
    else if (b.status !== 'booked' || ['cancelled', 'no_show', 'reschedule'].includes(b.outcome || '')) {
      priority = 'high'; action = 'Vérifier le rendez-vous et décider de sa replanification.';
    } else if (new Date(b.slot_at).getTime() <= now.getTime()) {
      priority = 'high'; action = 'Renseigner le résultat du rendez-vous passé (réalisé, absent ou reporté).';
    } else {
      priority = 'scheduled';
      action = `Préparer le rendez-vous du ${new Date(b.slot_at).toLocaleString('fr-FR', { timeZone: 'Europe/Paris' })}.`;
    }
  } else if (f.dealStage && f.dealStage !== STAGES.callback) {
    action = 'Demande déjà prise en charge ; consulter la prochaine étape commerciale.';
  } else if (f.requestType === 'callback') {
    priority = 'urgent'; action = 'Traiter la demande explicite de rappel et consigner le résultat.';
  } else if (f.requestType) {
    priority = 'high'; action = f.requestType === 'dossier'
      ? 'Prendre en charge la demande de dossier ; vérifier séparément sa livraison.'
      : 'Vérifier la demande de rendez-vous : aucune réservation confirmée connue.';
  }
  return { md_progress_stage: stage, md_followup_priority: priority, md_next_action: action };
}
