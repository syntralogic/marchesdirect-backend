import { db } from '../config/database';
import { buildCompanyProfile,buildCompanyScore } from './companyProfileService';
import { hubspotRequest,journeySchemaReady } from './hubspotJourneySchema';
export const STEP_LABELS:Record<string,string>={arrival:'Arrivée',search:'Recherche',offer_view:'Annonce consultée',view_opportunity:'Annonce consultée',company_selected:'SIRET saisi',company_identified:'Entreprise identifiée',analysis_started:'Analyse commencée',analysis_completed:'Analyse réalisée',retour_arriere:'Retour arrière',coordonnees_saisies:'Coordonnées laissées',contact_details:'Coordonnées laissées',demande_info:'Simple renseignement demandé',dossier_preview:'Aperçu du dossier',dossier_requested:'Dossier demandé',callback_requested:'Rappel demandé',appointment_booked:'Rendez-vous réservé'};
export const isTestCompany=(siret:string,name?:string|null)=>['10945324100019','92939307200012'].includes(siret)||['ZIENTLABS','VERIFRANCEHABITAT','4060INVEST'].includes(String(name||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().replace(/[^A-Z0-9]/g,''));
const stamp=(d:any)=>new Date(d).toLocaleString('fr-FR',{timeZone:'Europe/Paris',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}).replace(',','').replace(':','h');
const clean=(v:any,max=250)=>typeof v==='string'?v.trim().slice(0,max):'';
const escape=(s:string)=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
export function projectJourney(events:any[],scores:any[],firstSelectedAt:any,now=new Date()) {
 const offers=new Map<string,{title:string;at:any}>();
 for(const e of events)if(['offer_view','view_opportunity'].includes(e.event_type)&&e.offer_id&&!offers.has(e.offer_id))offers.set(e.offer_id,{title:e.offer_title||'Annonce',at:e.at});
 const arrival=events.find(e=>e.event_data?.utm_source||e.event_data?.utm_campaign);
 const source=clean(arrival?.event_data?.utm_source),campaign=clean(arrival?.event_data?.utm_campaign);
 const choices:Record<string,string>={dossier_requested:'dossier',callback_requested:'callback',appointment_booked:'appointment',demande_info:'info'};
 const lastRequest=[...events].reverse().find(e=>choices[e.event_type]);
 const last=events[events.length-1];
 const abandoned=!!last&&now.getTime()-new Date(last.at).getTime()>=30*60*1000&&(!lastRequest||new Date(last.at).getTime()>new Date(lastRequest.at).getTime());
 const timeline=events.slice(-100).map(e=>{
  const title=e.offer_title?` : ${clean(e.offer_title,110)}`:'';
  const attribution=e.event_type==='arrival'?(source?` via ${source}${campaign?' · '+campaign:''}`:' (source non renseignée)'):'';
  return {at:e.at,text:`${stamp(e.at)} – ${STEP_LABELS[e.event_type]||'Étape enregistrée'}${['offer_view','view_opportunity'].includes(e.event_type)?title:''}${attribution}.`};
 });
 for(const s of scores.slice(-20))if(typeof s.compatibility_score==='number'&&s.score_computed_at)timeline.push({at:s.score_computed_at,text:`${stamp(s.score_computed_at)} – Score ${s.compatibility_score} % sur ${clean(s.title||'l’annonce',110)}.`});
 const lines=timeline.sort((a,b)=>new Date(a.at).getTime()-new Date(b.at).getTime()).map(x=>x.text);
 if(abandoned)lines.push(`Inactif depuis le ${stamp(last.at)} ; dernière étape : ${STEP_LABELS[last.event_type]||'étape enregistrée'}.`);
 const values:Record<string,any>={
  md_viewed_offers:[...offers.values()].map(o=>`${stamp(o.at)} — ${o.title}`).join('\n').slice(0,60000),
  md_origin_offer:[...offers.values()][0]?.title,
  md_distinct_offers_count:offers.size,
  md_scores_by_offer:scores.filter(s=>s.score_computed_at&&typeof s.compatibility_score==='number').map(s=>`${stamp(s.score_computed_at)} — ${s.title||s.opportunity_id} : ${s.compatibility_score} %`).join('\n').slice(0,60000),
  md_siret_entered_at:firstSelectedAt?new Date(firstSelectedAt).toISOString():undefined,
  md_source:source||undefined,md_campaign:campaign||undefined,
  md_visitor_choice:lastRequest?choices[lastRequest.event_type]:'none',
  md_abandonment_step:abandoned?(STEP_LABELS[last.event_type]||'Étape enregistrée'):'',
  md_journey_summary:[`${offers.size} annonce(s) distincte(s) consultée(s).`,...lines].join('\n').slice(0,60000),
 };
 return Object.fromEntries(Object.entries(values).filter(([,v])=>v!==undefined));
}
export async function syncJourneyProjection(companyId:string,siret:string):Promise<void>{
 if(!journeySchemaReady)return;
 const [ev,selected,score,bookings]=await Promise.all([
  db.query(`SELECT e.id,e.event_type,e.event_data,COALESCE(e.occurred_at,e.created_at) AS at,
    COALESCE(e.opportunity_id,e.event_data->>'opportunityId') AS offer_id,o.title AS offer_title
    FROM visitor_events e LEFT JOIN opportunities o ON o.id::text=COALESCE(e.opportunity_id,e.event_data->>'opportunityId')
    WHERE COALESCE(e.attribution_siret,e.siret)=$1 ORDER BY COALESCE(e.occurred_at,e.created_at),e.created_at,e.id`,[siret]),
  db.query('SELECT company_data,selected_at FROM journey_company_selections WHERE siret=$1 ORDER BY selected_at',[siret]),
  db.query(`SELECT a.*,o.title FROM journey_scores a JOIN opportunities o ON o.id=a.opportunity_id
    WHERE a.siret=$1 ORDER BY a.score_computed_at`,[siret]),
  db.query(`SELECT b.slot_at FROM appointment_bookings b JOIN crm_leads l ON l.id=b.lead_id WHERE l.siret=$1 AND b.status='booked'
    AND b.slot_at>=NOW() ORDER BY b.slot_at LIMIT 1`,[siret]),
 ]);
 const company=[...selected.rows].reverse().find(s=>s.company_data)?.company_data;
 const properties:Record<string,any>={...buildCompanyProfile(company,selected.rows[0]?.selected_at),...buildCompanyScore(score.rows[score.rows.length-1]),
  ...projectJourney(ev.rows,score.rows,selected.rows[0]?.selected_at),md_is_test:isTestCompany(siret,company?.name)?'true':'false',
  ...(bookings.rows[0]?{md_appointment_date:new Date(bookings.rows[0].slot_at).toISOString()}:{})};
 await hubspotRequest({method:'PATCH',url:`/crm/v3/objects/companies/${companyId}`,data:{properties}});
 const deals=await db.query(`SELECT DISTINCT d.hubspot_deal_id FROM crm_deals d JOIN crm_leads l ON l.id=d.lead_id
  WHERE COALESCE(l.siret,(SELECT s.siret FROM journey_company_selections s WHERE s.session_id=l.session_id AND s.selected_at<=l.created_at ORDER BY s.selected_at DESC LIMIT 1))=$1`,[siret]);
 for(const d of deals.rows)await hubspotRequest({method:'PATCH',url:`/crm/v3/objects/deals/${d.hubspot_deal_id}`,data:{properties:{md_journey_summary:properties.md_journey_summary,...(isTestCompany(siret,company?.name)?{md_is_test:'true'}:{})}}});
 const keyEvents=ev.rows.filter(e=>['company_selected','coordonnees_saisies','callback_requested','appointment_booked','dossier_requested','demande_info'].includes(e.event_type));
 if(!keyEvents.length)return;
 const labels=await hubspotRequest({method:'GET',url:'/crm/v4/associations/notes/companies/labels'});
 const association=labels.results?.find((l:any)=>l.label===null)||labels.results?.[0];
 if(!association)return;
 for(const e of keyEvents){
  const claim=await db.query(`INSERT INTO journey_note_outbox(event_id,company_id,status) VALUES($1,$2,'posting') ON CONFLICT DO NOTHING RETURNING event_id`,[e.id,companyId]);
  if(!claim.rows.length)continue;
  try{
   const note=await hubspotRequest({method:'POST',url:'/crm/v3/objects/notes',data:{properties:{hs_timestamp:new Date(e.at).toISOString(),hs_note_body:`<p>${escape(stamp(e.at)+' – '+(STEP_LABELS[e.event_type]||'Étape enregistrée'))}</p><p>${escape(properties.md_journey_summary).replace(/\n/g,'<br>')}</p>`},associations:[{to:{id:companyId},types:[{associationCategory:association.category,associationTypeId:association.typeId}]}]}});
   await db.query("UPDATE journey_note_outbox SET status='created',hubspot_note_id=$3 WHERE event_id=$1 AND company_id=$2",[e.id,companyId,note.id]);
  }catch{await db.query("UPDATE journey_note_outbox SET status='needs_review' WHERE event_id=$1 AND company_id=$2",[e.id,companyId]);}
 }
}
