import axios from 'axios';
import { db } from '../config/database';
import { logger } from '../utils/logger';
export let journeySchemaReady=false;
export const JOURNEY_PROJECTION_DDL=[
 `CREATE TABLE IF NOT EXISTS journey_note_outbox(event_id UUID NOT NULL,company_id TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',hubspot_note_id TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),PRIMARY KEY(event_id,company_id))`,
 `CREATE TABLE IF NOT EXISTS crm_setup_log(key TEXT PRIMARY KEY,status TEXT NOT NULL,details JSONB,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
 `CREATE TABLE IF NOT EXISTS journey_visit_notes(id UUID PRIMARY KEY,company_id TEXT NOT NULL,session_id TEXT NOT NULL,
   started_at TIMESTAMPTZ NOT NULL,last_event_at TIMESTAMPTZ NOT NULL,hubspot_note_id TEXT UNIQUE,
   status TEXT NOT NULL DEFAULT 'pending',body_hash TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
 `CREATE INDEX IF NOT EXISTS journey_visit_notes_session ON journey_visit_notes(company_id,session_id,started_at)`,
 `ALTER TABLE journey_visit_notes ENABLE ROW LEVEL SECURITY`,
 `INSERT INTO crm_setup_log(key,status) VALUES('visit_notes_policy','ready') ON CONFLICT(key) DO NOTHING`,
];
export async function hubspotRequest(cfg:any):Promise<any>{
 return (await axios.request({baseURL:'https://api.hubapi.com',timeout:15000,...cfg,
  headers:{Authorization:`Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,'Content-Type':'application/json'}})).data;
}
const fields:any[]=[
 ['md_naf_code','Code NAF','string','text'],['md_trade','Métier','string','text'],['md_department','Département','string','text'],
 ['md_compatibility_score','Dernier indice de correspondance','number','number'],['md_score_date','Date et heure du calcul','datetime','date'],
 ['md_last_analyzed_offer_url','Lien de la dernière annonce analysée','string','text'],
 ['md_score_version','Version du calcul','string','text'],['md_siret_entered_at','Première saisie du SIRET','datetime','date'],
 ['md_viewed_offers','Annonces consultées (titre et date)','string','textarea'],['md_origin_offer','Annonce d’origine','string','text'],
 ['md_distinct_offers_count','Nombre d’annonces distinctes','number','number'],['md_scores_by_offer','Scores par annonce','string','textarea'],
 ['md_source','Source d’arrivée','string','text'],['md_campaign','Campagne d’arrivée','string','text'],
 ['md_visitor_choice','Choix du visiteur','enumeration','select'],['md_appointment_date','Date et heure du rendez-vous','datetime','date'],
 ['md_abandonment_step','Étape d’abandon','string','text'],['md_journey_summary','Résumé du parcours','string','textarea'],
 ['md_is_test','Donnée de test','bool','booleancheckbox'],
];
export async function ensureJourneySchema():Promise<void>{
 if(!process.env.HUBSPOT_ACCESS_TOKEN)return;
 try{
  for(const objectType of ['companies','deals']){
   const groups=await hubspotRequest({method:'GET',url:`/crm/v3/properties/${objectType}/groups`});
   let group=groups.results?.find((g:any)=>g.name==='marches_direct'||/march.s direct/i.test(g.label));
   if(!group)group=await hubspotRequest({method:'POST',url:`/crm/v3/properties/${objectType}/groups`,data:{name:'marches_direct',label:'Marchés Direct',displayOrder:0}});
   const definitions=objectType==='companies'?fields:fields.filter(f=>['md_journey_summary'].includes(f[0]));
   for(const [name,label,type,fieldType] of definitions){
    const options=name==='md_visitor_choice'?[['dossier','Dossier'],['callback','Rappel'],['appointment','Rendez-vous'],['info','Simple renseignement'],['none','Aucun']].map(([value,label],displayOrder)=>({value,label,displayOrder})):undefined;
    let found:any;try{found=await hubspotRequest({method:'GET',url:`/crm/v3/properties/${objectType}/${name}`});}catch(e:any){if(e.response?.status!==404)throw e;}
    if(!found)await hubspotRequest({method:'POST',url:`/crm/v3/properties/${objectType}`,data:{name,label:`MD — ${label}`,type,fieldType,groupName:group.name,...(options?{options}:{})}});
   }
  }
  for(const objectType of ['companies','deals']){
   try{await hubspotRequest({method:'PATCH',url:`/crm/v3/properties/${objectType}/md_is_test`,data:{label:'MD — Donnée de test',options:[{value:'true',label:'Oui',displayOrder:0,hidden:false},{value:'false',label:'Non',displayOrder:1,hidden:false}]}});}catch(e:any){logger.warn('HubSpot test labels could not be localized',{status:e.response?.status});}
  }
  const pipeline=await hubspotRequest({method:'GET',url:'/crm/v3/pipelines/deals/4280487115'});
  for(const [label,env,order] of [['Dossier demandé','HUBSPOT_DOSSIER_STAGE_ID',0],['Appel réalisé','HUBSPOT_CALLED_STAGE_ID',3]] as const){
   let stage=pipeline.stages?.find((s:any)=>s.label===label);
   if(!stage)stage=await hubspotRequest({method:'POST',url:'/crm/v3/pipelines/deals/4280487115/stages',data:{label,displayOrder:order,metadata:{isClosed:'false',probability:'0.1'}}});
   process.env[env]=stage.id;
  }
  journeySchemaReady=true;
  await db.query(`INSERT INTO crm_setup_log(key,status,details) VALUES('journey_schema','ready',$1::jsonb)
   ON CONFLICT(key) DO UPDATE SET status='ready',details=EXCLUDED.details,updated_at=NOW()`,[JSON.stringify({dossierStage:process.env.HUBSPOT_DOSSIER_STAGE_ID,calledStage:process.env.HUBSPOT_CALLED_STAGE_ID})]);
 }catch(e:any){
  await db.query(`INSERT INTO crm_setup_log(key,status,details) VALUES('journey_schema','failed',$1::jsonb)
   ON CONFLICT(key) DO UPDATE SET status='failed',details=EXCLUDED.details,updated_at=NOW()`,[JSON.stringify({status:e.response?.status,code:e.response?.data?.category||'setup_failed'})]);
  logger.error('HubSpot journey setup incomplete; existing sync remains active',{status:e.response?.status});
 }
}
