import { db } from '../config/database';
import {describeOffer,distinctTimelineEvents,hasOfferTitle,offerUrl} from './journeyOfferPresentation';
import { syncVisitNotes } from './visitNoteService';
import { buildCompanyProfile,buildCompanyScore,isTestCompany } from './companyProfileService';
import { hubspotRequest,journeySchemaReady } from './hubspotJourneySchema';
export const STEP_LABELS:Record<string,string>={arrival:'Arrivée',search:'Recherche',offer_view:'Annonce consultée',view_opportunity:'Annonce consultée',company_selected:'SIRET saisi',company_identified:'Entreprise identifiée',analysis_started:'Analyse commencée',analysis_completed:'Analyse réalisée',retour_arriere:'Retour arrière',coordonnees_saisies:'Coordonnées laissées',contact_details:'Coordonnées laissées',demande_info:'Simple renseignement demandé',dossier_preview:'Aperçu du dossier',dossier_requested:'Dossier demandé',callback_requested:'Rappel demandé',appointment_booked:'Rendez-vous demandé',
 // 5 Nov (poste de travail HubSpot) : codes v26 jusque-là affichés « Étape enregistrée ».
 ranked_list_shown:'Liste de marchés affichée',concordance_shown:'Pourcentage affiché',alert_requested:'Alerte nouveaux marchés demandée',invitation_30min_clicked:'Invitation 30 minutes acceptée',view_seo_page:'Page consultée',view_guide:'Guide consulté',view_buyer_page:'Page acheteur consultée',
 // 5 nov. (suivi complet) : nouvelles actions, toutes rattachées à l'annonce concernée.
 dossier_downloaded:'Dossier PDF téléchargé',favorite_added:'Mis en favori',dossier_entrusted:'Dossier confié à Elena',message_sent:'Message envoyé à Elena'};
// Actions qui portent sur une annonce : la ligne du résumé donne toujours le titre, la référence et le lien.
const OFFER_ACTIONS=new Set(['offer_view','view_opportunity','dossier_requested','callback_requested','appointment_booked','demande_info','coordonnees_saisies','dossier_preview','dossier_downloaded','favorite_added','dossier_entrusted','message_sent','concordance_shown','invitation_30min_clicked','alert_requested']);
const OFFER_TAG:Record<string,string>={offer_view:'consultée',view_opportunity:'consultée',dossier_requested:'dossier demandé',callback_requested:'rappel demandé',appointment_booked:'rendez-vous demandé',demande_info:'question posée',dossier_downloaded:'dossier téléchargé',favorite_added:'favori',dossier_entrusted:'confiée à Elena',message_sent:'message à Elena'};
// Événements techniques sans valeur pour Elena : jamais dans le résumé (ils restent dans la base du site).
const HIDDEN_FROM_TIMELINE=new Set(['invitation_30min_shown','invitation_30min_closed','request_submitted','form_started']);
const searchLabel=(e:any)=>{const d=e.event_data||{};const q=clean(d.q||d.query||d.trade,80);const z=clean(d.location||d.department||d.zone,40);return q||z?` : ${[q,z].filter(Boolean).join(' · ')}`:'';};
export {isTestCompany} from './companyProfileService';
const stamp=(d:any)=>new Date(d).toLocaleString('fr-FR',{timeZone:'Europe/Paris',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}).replace(',','').replace(':','h');
const clean=(v:any,max=250)=>typeof v==='string'?v.trim().slice(0,max):'';
export function projectJourney(events:any[],scores:any[],firstSelectedAt:any,now=new Date()) {
 const offers=new Map<string,any>();
 for(const e of events)if(['offer_view','view_opportunity'].includes(e.event_type)&&e.offer_id&&!offers.has(e.offer_id))offers.set(e.offer_id,e);
 const arrival=events.find(e=>e.event_data?.utm_source||e.event_data?.utm_campaign);
 const source=clean(arrival?.event_data?.utm_source),campaign=clean(arrival?.event_data?.utm_campaign);
 const choices:Record<string,string>={dossier_requested:'dossier',callback_requested:'callback',appointment_booked:'appointment',demande_info:'info'};
 const lastRequest=[...events].reverse().find(e=>choices[e.event_type]);
 const last=events[events.length-1];
 const abandoned=!!last&&now.getTime()-new Date(last.at).getTime()>=30*60*1000&&(!lastRequest||new Date(last.at).getTime()>new Date(lastRequest.at).getTime());
 // Scores : ceux calculés en rafale (liste classée) deviennent UNE ligne avec les 3 meilleurs ; une analyse isolée
 // (fiche de l'annonce) garde sa ligne. Seuil : 3 scores ou plus dans la même fenêtre de 2 minutes.
 const sc=scores.filter(x=>typeof x.compatibility_score==='number'&&x.score_computed_at&&hasOfferTitle(x)).sort((a,b)=>new Date(a.score_computed_at).getTime()-new Date(b.score_computed_at).getTime());
 const bursts:any[][]=[];for(const x of sc){const b=bursts[bursts.length-1];if(b&&new Date(x.score_computed_at).getTime()-new Date(b[b.length-1].score_computed_at).getTime()<=120000)b.push(x);else bursts.push([x]);}
 const listBursts=bursts.filter(b=>b.length>=3),single=bursts.filter(b=>b.length<3).flat();
 const analysed=new Map<string,any>();for(const x of single)analysed.set(x.opportunity_id,x); // dernier score par annonce analysée
 const timeline=distinctTimelineEvents(events).filter(e=>!HIDDEN_FROM_TIMELINE.has(e.event_type)&&(!['offer_view','view_opportunity'].includes(e.event_type)||hasOfferTitle(e))
   // « Analyse réalisée » sans annonce nommée = doublon du score de la même minute : on ne le répète pas.
   &&!(['analysis_started','analysis_completed'].includes(e.event_type))).slice(-150).map(e=>{
  const withOffer=OFFER_ACTIONS.has(e.event_type)&&e.offer_id&&hasOfferTitle(e)?` : ${describeOffer(e,now)}`:'';
  const attribution=e.event_type==='arrival'?(source?` via ${source}${campaign?' · '+campaign:''}`:' (source non renseignée)'):'';
  return {at:e.at,key:`${e.event_type}|${e.event_type==='search'?searchLabel(e):e.offer_id||''}`,text:`${STEP_LABELS[e.event_type]||`Étape ${e.event_type}`}${withOffer||(e.event_type==='search'?searchLabel(e):'')}${attribution}`};
 });
 for(const x of single.slice(-40))timeline.push({at:x.score_computed_at,key:`score|${x.opportunity_id}|${x.compatibility_score}`,text:`Analyse de l'annonce : ${x.compatibility_score} % sur ${describeOffer(x,now)}`});
 for(const b of listBursts.slice(-10)){const top=[...b].sort((p,q)=>q.compatibility_score-p.compatibility_score).filter((x,k,arr)=>arr.findIndex(y=>y.opportunity_id===x.opportunity_id)===k).slice(0,3);
  timeline.push({at:b[0].score_computed_at,key:`list|${b[0].score_computed_at}`,text:`Liste classée : ${b.length} marchés notés · meilleurs : ${top.map(x=>`${x.compatibility_score} % ${describeOffer(x,now)}`).join(' ; ')}`});}
 // Lignes identiques et consécutives à moins de 10 minutes : une seule ligne « (×N) ».
 const sorted=timeline.sort((a,b)=>new Date(a.at).getTime()-new Date(b.at).getTime());
 const merged:{at:any;key:string;text:string;n:number}[]=[];
 // Événements de navigation répétés (liste affichée, pourcentage affiché, SIRET saisi, recherche) : regroupés même si
 // une autre ligne s'intercale ; les actions (demandes, analyses) restent toujours sur leur propre ligne.
 const NOISY=/^(ranked_list_shown|concordance_shown|company_selected|company_identified|search|offer_view|view_opportunity)\|/;
 for(const t of sorted){const tt=new Date(t.at).getTime();
  const p=NOISY.test(t.key)?[...merged].reverse().find(m=>m.key===t.key&&tt-new Date(m.at).getTime()<10*60000):(merged[merged.length-1]?.key===t.key&&tt-new Date(merged[merged.length-1].at).getTime()<10*60000?merged[merged.length-1]:undefined);
  if(p)p.n++;else merged.push({...t,n:1});}
 const lines=merged.map(x=>`${stamp(x.at)} – ${x.text}${x.n>1?` (×${x.n})`:''}`);
 if(abandoned)lines.push(`Inactif depuis le ${stamp(last.at)} ; dernière étape : ${STEP_LABELS[last.event_type]||'étape enregistrée'}.`);
 // Annonces concernées (pour Elena et pour un résumé automatique) : chaque annonce une fois, avec ce que le visiteur
 // en a fait. Les consultations n'y figurent que si le visiteur a accepté la mesure d'audience (règle CNIL).
 const touched=new Map<string,{first:any;o:any;tags:Set<string>}>();
 const touch=(id:string|undefined,at:any,o:any,tag:string)=>{if(!id||!hasOfferTitle(o))return;const t=touched.get(id)||{first:at,o,tags:new Set<string>()};t.tags.add(tag);if(new Date(at).getTime()<new Date(t.first).getTime())t.first=at;touched.set(id,t);};
 for(const e of events)if(OFFER_TAG[e.event_type])touch(e.offer_id,e.at,e,OFFER_TAG[e.event_type]);
 for(const x of analysed.values())touch(x.opportunity_id,x.score_computed_at,x,`analysée ${x.compatibility_score} %`);
 const touchedLines=[...touched.values()].sort((a,b)=>new Date(a.first).getTime()-new Date(b.first).getTime()).map(t=>`${stamp(t.first)} — [${[...t.tags].join(', ')}] ${describeOffer(t.o,now)}`);
 const values:Record<string,any>={
  md_viewed_offers:touchedLines.join('\n').slice(0,60000),
  md_origin_offer:offers.size?`${stamp([...offers.values()][0].at)} — ${describeOffer([...offers.values()][0],now)}`:undefined,
  md_distinct_offers_count:touched.size,
  md_scores_by_offer:sc.map(x=>`${stamp(x.score_computed_at)} — Score ${x.compatibility_score} % : ${describeOffer(x,now)}`).join('\n').slice(0,60000),
  md_last_analyzed_offer_url:offerUrl([...sc].reverse()[0]?.opportunity_id),
  md_siret_entered_at:firstSelectedAt?new Date(firstSelectedAt).toISOString():undefined,
  md_source:source||undefined,md_campaign:campaign||undefined,
  md_visitor_choice:lastRequest?choices[lastRequest.event_type]:'none',
  md_abandonment_step:abandoned?(STEP_LABELS[last.event_type]||'Étape enregistrée'):'',
  md_journey_summary:[`${touched.size} annonce(s) concernée(s) : consultées, analysées ou demandées (détail : MD — Annonces consultées).`,...lines].join('\n').slice(0,60000),
 };
 return Object.fromEntries(Object.entries(values).filter(([,v])=>v!==undefined));
}
export async function syncJourneyProjection(companyId:string,siret:string):Promise<void>{
 if(!journeySchemaReady)return;
 const [ev,selected,score,bookings]=await Promise.all([
  db.query(`SELECT e.id,e.session_id,e.event_type,e.event_data,COALESCE(e.occurred_at,e.created_at) AS at,
    COALESCE(e.opportunity_id,e.event_data->>'opportunityId') AS offer_id,o.title AS offer_title,o.location_department,o.location_country,o.raw_data,o.source_reference,o.deadline,
    l.message AS request_message,l.appointment_slot_at AS request_slot_at
    FROM visitor_events e LEFT JOIN opportunities o ON o.id::text=COALESCE(e.opportunity_id,e.event_data->>'opportunityId')
    LEFT JOIN crm_leads l ON l.id::text=split_part(e.event_id,':',2) AND l.session_id=e.session_id AND l.siret=$1
    WHERE COALESCE(e.attribution_siret,e.siret)=$1 ORDER BY COALESCE(e.occurred_at,e.created_at),e.created_at,e.id`,[siret]),
  db.query('SELECT company_data,selected_at FROM journey_company_selections WHERE siret=$1 ORDER BY selected_at',[siret]),
  db.query(`SELECT a.*,o.title,o.location_department,o.location_country,o.raw_data,o.source_reference,o.deadline FROM journey_scores a JOIN opportunities o ON o.id=a.opportunity_id
    WHERE a.siret=$1 ORDER BY a.score_computed_at`,[siret]),
  db.query(`SELECT b.slot_at FROM appointment_bookings b JOIN crm_leads l ON l.id=b.lead_id WHERE l.siret=$1 AND b.status='booked'
    AND b.slot_at>=NOW() ORDER BY b.slot_at LIMIT 1`,[siret]),
 ]);
 const company=[...selected.rows].reverse().find(s=>s.company_data)?.company_data;
 const properties:Record<string,any>={...buildCompanyProfile(company,selected.rows[0]?.selected_at),...buildCompanyScore(score.rows[score.rows.length-1]),
  ...projectJourney(ev.rows,score.rows,selected.rows[0]?.selected_at),...(isTestCompany(siret,company?.name)?{md_is_test:'true'}:{}),
  ...(bookings.rows[0]?{md_appointment_date:new Date(bookings.rows[0].slot_at).toISOString()}:{})};
 await hubspotRequest({method:'PATCH',url:`/crm/v3/objects/companies/${companyId}`,data:{properties}});
 const deals=await db.query(`SELECT DISTINCT d.hubspot_deal_id FROM crm_deals d JOIN crm_leads l ON l.id=d.lead_id
  WHERE COALESCE(l.siret,(SELECT s.siret FROM journey_company_selections s WHERE s.session_id=l.session_id AND s.selected_at<=l.created_at ORDER BY s.selected_at DESC LIMIT 1))=$1`,[siret]);
 for(const d of deals.rows)await hubspotRequest({method:'PATCH',url:`/crm/v3/objects/deals/${d.hubspot_deal_id}`,data:{properties:{md_journey_summary:properties.md_journey_summary,...(isTestCompany(siret,company?.name)?{md_is_test:'true'}:{})}}});
 await syncVisitNotes(companyId,siret,company?.name,ev.rows,score.rows);
}
