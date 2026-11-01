import {shortOfferTitle,visitAction,visitSource} from '../visitNoteCopy';
import {buildVisitNotes} from '../visitNotePresentation';

it('uses a readable source without modifying raw campaign values',()=>{
 expect(visitSource('SMS','recette_electriciens_33')).toBe('SMS électriciens 33');
 expect(visitSource('Google','plombiers_bordeaux')).toBe('Google plombiers bordeaux');
});
it('limits every title to six complete words without ellipses',()=>{
 for(const title of ['Restauration – conservation sur les œuvres d’art du Musée Jacquemart André','Extension De La Déchetterie De Thones Et Construction D’un Bâtiment','Fourniture de produits chimiques divers de laboratoire','Sensibilisation au risque inondation par la mise en place de repères']){
  expect(shortOfferTitle(title).split(/\s+/).length).toBeLessThanOrEqual(6);
  expect(shortOfferTitle(title)).not.toMatch(/…|\.{3}$/);
 }
 expect(shortOfferTitle('Restauration – conservation sur les œuvres d’art du Musée Jacquemart André')).toBe('Musée Jacquemart-André');
});
it('shows the analyzed offer first even when it was the sixth offer viewed, with an explicit link',()=>{
 const events=Array.from({length:6},(_,i)=>({session_id:'v',at:`2026-11-01T10:0${i}:00Z`,event_type:'offer_view',offer_id:`o${i}`,offer_title:`Travaux ${i}`}));
 const note=buildVisitNotes([...events,{session_id:'v',at:'2026-11-01T10:07:00Z',event_type:'callback_requested'}],
 [{session_id:'v',opportunity_id:'o5',compatibility_score:25,score_computed_at:'2026-11-01T10:06:00Z'}])[0];
 expect(note.html).toMatch(/<ul><li>Analysée 25 % — Travaux 5 · <a href="https:\/\/marchesdirect.fr\/opportunites\/o5">lien<\/a>/);
 expect(note.html.match(/>lien<\/a>/g)).toHaveLength(5);
 expect(note.text.endsWith('À faire : rappeler · préférence : non précisée')).toBe(true);
});
it('uses only the chosen callback preference, not arbitrary message content',()=>{
 expect(visitAction({event_type:'callback_requested',request_message:'Créneau souhaité : Après-midi (14h–17h)\nAutre texte privé'})).toBe('À faire : rappeler · préférence : Après-midi (14h–17h)');
 expect(visitAction({event_type:'callback_requested',request_message:'TEST technique'})).toBe('À faire : rappeler · préférence : non précisée');
});
it('adapts the action for dossier, appointment in Paris time, info and unknown dates',()=>{
 expect(visitAction({event_type:'dossier_requested'})).toBe('À faire : envoyer le dossier');
 expect(visitAction({event_type:'appointment_booked',request_slot_at:'2026-11-03T13:30:00Z'})).toBe('À faire : rendez-vous le 03/11/2026 à 14h30 (heure de Paris)');
 expect(visitAction({event_type:'appointment_booked'})).toBe('À faire : confirmer la date du rendez-vous');
 expect(visitAction({event_type:'demande_info'})).toContain('répondre');
});
