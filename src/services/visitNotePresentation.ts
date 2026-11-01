import { distinctTimelineEvents, hasOfferTitle, offerDeadline, offerUrl } from './journeyOfferPresentation';
import { offerDepartment } from './journeyOfferDepartment';

const IDLE_MS = 30 * 60 * 1000;
const views = new Set(['offer_view', 'view_opportunity']);
const choices: Record<string, string> = {callback_requested: 'Rappel demandé', dossier_requested: 'Dossier demandé', appointment_booked: 'Rendez-vous demandé', demande_info: 'Simple renseignement demandé'};
const coordinates = new Set(['coordonnees_saisies', 'contact_details']);
const clean = (value: any) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const millis = (value: any) => new Date(value).getTime();
const stamp = (value: any) => new Date(value).toLocaleString('fr-FR', {timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'}).replace(',', '').replace(':', 'h');
const shortTitle = (value: string) => {
  const title = value.replace(/^L['’]accord-cadre a pour objet l['’]acquisition de fourniture de\s+/i, 'Fourniture de ');
  return title.length <= 80 ? title : title.slice(0, 77).replace(/\s+\S*$/, '').trimEnd() + '…';
};

export type VisitNote = {sessionId: string; startedAt: string; lastAt: string; triggerAt: string; title: string; html: string; text: string};

// Browser ids are persistent. A new visit starts after 30 minutes without an
// event. Only company-attributed events supplied by the caller are considered.
export function buildVisitNotes(events: any[], scores: any[], now = new Date()): VisitNote[] {
  const sessions = new Map<string, any[]>();
  for (const event of events) if (event.session_id && Number.isFinite(millis(event.at))) {
    const list = sessions.get(event.session_id) || []; list.push(event); sessions.set(event.session_id, list);
  }
  const notes: VisitNote[] = [];
  for (const [sessionId, all] of sessions) {
    const visits: any[][] = [];
    for (const event of [...all].sort((a, b) => millis(a.at) - millis(b.at))) {
      const current = visits[visits.length - 1];
      if (!current || millis(event.at) - millis(current[current.length - 1].at) >= IDLE_MS) visits.push([event]);
      else current.push(event);
    }
    for (const visit of visits) {
      const triggers = visit.filter(e => coordinates.has(e.event_type) || choices[e.event_type]);
      if (!triggers.length) continue; // SIRET/analysis alone never creates a note.
      const startedAt = new Date(visit[0].at).toISOString();
      const lastAt = new Date(visit[visit.length - 1].at).toISOString();
      const visitScores = scores.filter(s => s.session_id === sessionId && typeof s.compatibility_score === 'number'
        && millis(s.score_computed_at) >= millis(startedAt) && millis(s.score_computed_at) <= millis(lastAt))
        .sort((a, b) => millis(a.score_computed_at) - millis(b.score_computed_at));
      const latestScore = visitScores[visitScores.length - 1];
      const lastChoice = [...triggers].reverse().find(e => choices[e.event_type]);
      const arrival = visit.find(e => e.event_data?.utm_source || e.event_data?.utm_campaign);
      const source = [clean(arrival?.event_data?.utm_source), clean(arrival?.event_data?.utm_campaign).replace(/_/g, ' ')].filter(Boolean).join(' ');
      const title = [lastChoice ? choices[lastChoice.event_type] : 'Coordonnées laissées',
        latestScore ? `score ${latestScore.compatibility_score} %` : '', source ? `source ${source.slice(0, 100)}` : ''].filter(Boolean).join(' · ');
      const offers = new Map<string, any>();
      for (const event of visit) if (views.has(event.event_type) && event.offer_id && hasOfferTitle(event)) offers.set(event.offer_id, event);
      const offerLines = [...offers.values()].slice(0, 5).map(offer => {
        const department = offerDepartment(offer);
        const label = [shortTitle(clean(offer.offer_title || offer.title)) + (department ? ` (${department})` : ''), offerDeadline(offer.deadline, now)].filter(Boolean).join(' · ');
        return {label, url: offerUrl(offer.offer_id)!};
      });
      const timeline = distinctTimelineEvents(visit).filter(e => !['analysis_started', 'analysis_completed'].includes(e.event_type)
        || (e.event_type === 'analysis_completed' && !visitScores.some(s => s.opportunity_id === e.offer_id)))
        .concat(visitScores.map(s => ({at: s.score_computed_at, event_type: 'computed_score', score: s.compatibility_score})))
        .sort((a, b) => millis(a.at) - millis(b.at));
      const steps: string[] = []; let viewIds = new Set<string>();
      const push = (label: string) => { if (steps[steps.length - 1] !== label) steps.push(label); };
      const flush = () => { if (viewIds.size) push(`${viewIds.size} annonce${viewIds.size > 1 ? 's' : ''}`); viewIds = new Set(); };
      for (const event of timeline) {
        if (views.has(event.event_type)) {
          // Initial views are already listed above; subsequent views show the loop.
          if (steps.length && event.offer_id && hasOfferTitle(event)) viewIds.add(event.offer_id);
          continue;
        }
        const label = event.event_type === 'computed_score' ? `analyse ${event.score} %`
          : ['company_selected', 'company_identified'].includes(event.event_type) ? 'SIRET saisi'
          : coordinates.has(event.event_type) ? 'coordonnées'
          : ({retour_arriere: 'retour arrière', analysis_completed: 'analyse réalisée', callback_requested: 'rappel', dossier_requested: 'dossier', appointment_booked: 'rendez-vous', demande_info: 'simple renseignement'} as Record<string, string>)[event.event_type];
        if (label) { flush(); push(label); }
      }
      flush();
      const journey = (steps.length > 14 ? [...steps.slice(0, 3), '…', ...steps.slice(-9)] : steps).join(' → ');
      const period = `Visite du ${stamp(startedAt)} — ${stamp(lastAt)}`;
      const more = offers.size > 5 ? `${offers.size - 5} autre(s) annonce(s) consultée(s).` : '';
      notes.push({sessionId, startedAt, lastAt, triggerAt: new Date(triggers[triggers.length - 1].at).toISOString(), title,
        text: [title, period, ...offerLines.map(o => `${o.label} · ${o.url}`), more, journey].filter(Boolean).join('\n'),
        html: `<p><strong>${escape(title)}</strong></p><p>${escape(period)}</p>`
          + (offerLines.length ? `<ul>${offerLines.map(o => `<li><a href="${escape(o.url)}">${escape(o.label)}</a></li>`).join('')}</ul>` : '')
          + (more ? `<p>${escape(more)}</p>` : '') + `<p>${escape(journey)}</p>`,
      });
    }
  }
  return notes;
}
