import { buildVisitNotes } from '../visitNotePresentation';
const now = new Date('2026-11-01T18:00:00Z');
const event = (type: string, seconds: number, extra: any = {}) => ({id: `${seconds}-${type}`, session_id:'visit', event_type:type, at:new Date(Date.UTC(2026,10,1,10,0,seconds)).toISOString(), ...extra});
const view = (id: string, seconds: number, extra: any = {}) => event('offer_view',seconds,{offer_id:id,offer_title:`Annonce ${id}`,location_department:'33',deadline:'2026-11-13T12:00:00Z',...extra});
const score = {session_id:'visit',opportunity_id:'a',compatibility_score:25,score_computed_at:event('',40).at};

it('creates no note for SIRET or analysis alone',()=>{
 expect(buildVisitNotes([view('a',1),event('company_selected',20),event('analysis_completed',41)], [score],now)).toEqual([]);
});
it('renders only this visit, five linked offers maximum and one compact journey',()=>{
 const events=[event('arrival',0,{event_data:{utm_source:'SMS',utm_campaign:'électriciens_33'}}),view('a',1),view('b',2),view('c',3),
 event('company_selected',20),event('analysis_started',30),event('analysis_completed',41,{offer_id:'a'}),event('retour_arriere',50),view('d',60),view('e',70),event('coordonnees_saisies',80),event('callback_requested',81)];
 const notes=buildVisitNotes([...events,view('old',1,{session_id:'older'})],[score,{...score,session_id:'older',compatibility_score:99}],now);
 expect(notes).toHaveLength(1);
 expect(notes[0].title).toBe('Rappel demandé · score 25 % · source SMS électriciens 33');
 expect(notes[0].text).toContain('SIRET saisi → analyse 25 % → retour arrière → 2 annonces → coordonnées → rappel');
 expect(notes[0].html.match(/<li>/g)).toHaveLength(5);
 expect(notes[0].html).toContain('https://marchesdirect.fr/opportunites/a');
 expect(notes[0].html).toContain('(33) · J-12');
 expect(notes[0].text).not.toContain('old'); expect(notes[0].text).not.toContain('99 %');
 const more=buildVisitNotes([...events,view('f',90)],[score],now)[0];
 expect(more.html.match(/<li>/g)).toHaveLength(5);expect(more.text).toContain('1 autre(s) annonce(s)');
});
it('starts a new visit at thirty minutes even with the same persistent browser id',()=>{
 const notes=buildVisitNotes([event('arrival',0,{event_data:{utm_source:'SMS'}}),view('first',1),event('callback_requested',20),
 view('second',1820),event('coordonnees_saisies',1821)],[],now);
 expect(notes).toHaveLength(2);expect(notes[1].text).toContain('second');
 expect(notes[1].text).not.toContain('first');expect(notes[1].title).not.toContain('SMS');
});
it('escapes HTML and omits untitled offers and missing scores',()=>{
 const note=buildVisitNotes([view('bad',1,{offer_title:null}),view('safe',2,{offer_title:'<script>alert(1)</script>',location_department:null}),event('coordonnees_saisies',3)],[],now)[0];
 expect(note.html).not.toContain('<script>');expect(note.html).toContain('&lt;script&gt;');
 expect(note.html).not.toContain('/bad');expect(note.title).toBe('Coordonnées laissées');
 expect(note.text).not.toContain('non renseigné');
});
it.each(['dossier_requested','appointment_booked','demande_info'])('starts a note on %s without requiring a separate coordinates event',type=>{
 expect(buildVisitNotes([event(type,10)],[],now)).toHaveLength(1);
});

it('writes the callback moment, the question and the requested slot in clear text (one note, no second note)',()=>{
 const callback=buildVisitNotes([view('a',1),event('coordonnees_saisies',10),event('callback_requested',11,{event_data:{callbackMoment:'demain_matin'}})],[],now);
 expect(callback).toHaveLength(1);
 expect(callback[0].text).toContain('Moment de rappel choisi : Demain matin');
 expect(callback[0].html).toContain('<p>Moment de rappel choisi : Demain matin</p>');
 const question=buildVisitNotes([view('a',1),event('coordonnees_saisies',10),event('demande_info',11,{event_data:{question:'Le lot 2 est-il   ouvert aux <sous-traitants> ?'}})],[],now);
 expect(question[0].text).toContain('Question : « Le lot 2 est-il ouvert aux <sous-traitants> ? »');
 expect(question[0].html).toContain('&lt;sous-traitants&gt;');
 const slot=buildVisitNotes([view('a',1),event('coordonnees_saisies',10),event('appointment_booked',11,{event_data:{slotAt:'2026-11-05T08:00:00Z'}})],[],now);
 expect(slot[0].text).toMatch(/Créneau souhaité : 05\/11 09h00 — à confirmer par téléphone/);
 const plain=buildVisitNotes([view('a',1),event('coordonnees_saisies',10),event('callback_requested',11)],[],now);
 expect(plain[0].text).not.toContain('Moment de rappel');
});
