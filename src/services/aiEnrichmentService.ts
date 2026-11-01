import { createHash } from 'crypto';
import { db } from '../config/database';
import { paidClaudeRequest } from './aiBudgetService';
import { logger } from '../utils/logger';

const VERSION='notice-bundle-v2';
const SYSTEM=`Tu analyses un avis réel de marché. Utilise uniquement les données fournies, sans inventer d'entreprise, de montant, de date, de qualification ni d'effectif.
Réponds en JSON strict : {"summary":"résumé français en 2 à 4 phrases, 120 mots maximum", "sections":{"presentation":"objet et prestations","conditions":"conditions et points à vérifier","entreprises":"métiers concernés sans promettre l'éligibilité"},"facts":{}}.
Les facts ont chacun la forme {"value":"valeur source ou not available","available":true/false} : buyer_name, contract_object, procedure_type, submission_deadline, estimated_value, required_qualifications, team_size_estimate, contract_duration, submission_method, allotment, technical_visit, scope_details, intervention_calendar, constraints_expectations, order_caps, attribution_winner, attribution_amount, attribution_date, buyer_phone, buyer_website, contact_email.
key_risks a la forme {"value":[{"label":"...","severity":"obligatoire ou recommandee"}],"available":true/false} ; selection_criteria : {"value":[{"label":"...","weight_percent":null,"not_specified":true}],"available":true/false}. Ne compte pas d'exigences si aucun DCE n'est fourni. N'utilise jamais un plafond de commande comme un montant garanti. Signale clairement les données absentes. Aucun markdown.`;
function sourceOf(o:any) {
  return {title:o.title,description:String(o.description||'').slice(0,10000),buyer:o.buyer_name,deadline:o.deadline,
    estimated_value:o.estimated_value,location:o.location_city,department:o.location_department,
    source_reference:o.source_reference};
}
export function bundleKey(o:any):string {
  return `${VERSION}:${o.id}:${createHash('sha256').update(JSON.stringify(sourceOf(o))).digest('hex')}`;
}
export async function generateNoticeBundle(o:any, model:string, task:string):Promise<any> {
  const response=await paidClaudeRequest({model,max_tokens:6000,cache_control:{type:'ephemeral'},
    system:SYSTEM+' Les dates et heures doivent être en heure de Paris, avec le fuseau indiqué. Ne reproduis pas une heure UTC comme heure locale.',
    tools:[{name:'notice_bundle',description:'Résumé et extraction fidèle de l’avis source',input_schema:{type:'object',required:['summary','sections','facts'],properties:{summary:{type:'string'},sections:{type:'object',required:['presentation','conditions','entreprises'],properties:{presentation:{type:'string'},conditions:{type:'string'},entreprises:{type:'string'}}},facts:{type:'object'}}}}],
    tool_choice:{type:'tool',name:'notice_bundle'},messages:[{role:'user',content:JSON.stringify(sourceOf(o))}]},task);
  if(response.data.stop_reason==='max_tokens')throw new Error('ai_bundle_incomplete');
  const result=response.data.content?.find((b:any)=>b.type==='tool_use'&&b.name==='notice_bundle')?.input;
  if(!result)throw new Error('ai_bundle_tool_missing');
  if(typeof result.summary!=='string'||!result.summary.trim()||!result.facts||!result.sections) throw new Error('ai_bundle_invalid');
  if(!Array.isArray(result.facts.key_risks?.value)) result.facts.key_risks={value:[],available:false};
  if(!Array.isArray(result.facts.selection_criteria?.value)) result.facts.selection_criteria={value:[],available:false};
  result.facts.requirements_detected={value:0,available:false};
  return result;
}
export async function enrichSelectedNotice(opportunityId:string):Promise<void> {
  // Model switch is conditional on the explicit benchmark review.
  if(process.env.AI_HAIKU_VALIDATED!=='true') return;
  const o=(await db.query('SELECT * FROM opportunities WHERE id=$1 AND deleted_at IS NULL',[opportunityId])).rows[0];
  if(!o)return;
  const key=bundleKey(o);
  // A durable claim also prevents repeated calls after a failure or restart.
  const claim=await db.query(`INSERT INTO ai_result_cache(cache_key,function_name,model,result)
    VALUES($1,'notice_bundle','claude-haiku-5-5','{"status":"claimed"}') ON CONFLICT DO NOTHING RETURNING cache_key`,[key]);
  if(!claim.rows.length)return;
  try {
    const result=await generateNoticeBundle(o,'claude-haiku-5-5','notice_bundle');
    await db.transaction(async c=>{
      await c.query('UPDATE ai_result_cache SET result=$2::jsonb WHERE cache_key=$1',[key,JSON.stringify({status:'completed',...result})]);
      await c.query(`UPDATE opportunities SET ai_summary=$2,ai_summary_status='generated',ai_extracted_facts=$3::jsonb,
        ai_analysis_sections=$4::jsonb,ai_analysis_sections_status='generated' WHERE id=$1`,[o.id,result.summary,JSON.stringify(result.facts),JSON.stringify(result.sections)]);
    });
  } catch(err) {
    await db.query('UPDATE ai_result_cache SET result=$2::jsonb WHERE cache_key=$1',[key,JSON.stringify({status:'failed',code:'generation_failed'})]);
    logger.warn('AI notice bundle unavailable; stored source remains available');
  }
}
export async function runApprovedHaikuBenchmark():Promise<void> {
  const run='haiku-validation-20261101';
  const admitted=await db.query(`INSERT INTO ai_result_cache(cache_key,function_name,model,result)
    VALUES($1,'benchmark','mixed','{"status":"started"}') ON CONFLICT DO NOTHING RETURNING cache_key`,[run]);
  if(!admitted.rows.length)return;
  const rows=await db.query(`SELECT DISTINCT ON (o.trade_id) o.* FROM opportunities o JOIN data_sources ds ON ds.id=o.source_id
    WHERE o.deleted_at IS NULL AND ds.code!='editorial_catalog' AND COALESCE(o.source_reference,'') NOT LIKE 'DEMO-%'
    AND length(o.description)>250 ORDER BY o.trade_id,o.created_at DESC LIMIT 10`);
  if(rows.rows.length!==10) {
    await db.query('UPDATE ai_result_cache SET result=$2::jsonb WHERE cache_key=$1',[run,JSON.stringify({status:'insufficient_real_notices',count:rows.rows.length})]);return;
  }
  for(const [i,o] of rows.rows.entries()) {
    for(const model of i<3?['claude-haiku-5-5','claude-sonnet-5']:['claude-haiku-5-5']) {
      let result:any;
      try{result={status:'completed',...await generateNoticeBundle(o,model,'benchmark_notice_bundle')};}
      catch(err){result={status:'failed',code:err instanceof Error?err.message.slice(0,120):'failed'};}
      await db.query(`INSERT INTO ai_benchmark_results(run_id,opportunity_id,model,title,result) VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT DO NOTHING`,[run,o.id,model,o.title,JSON.stringify(result)]);
    }
  }
  await db.query('UPDATE ai_result_cache SET result=$2::jsonb WHERE cache_key=$1',[run,JSON.stringify({status:'completed',notices:10,references:3})]);
  logger.info('Approved AI benchmark completed; automatic enrichment remains paused');
}

// Only the failed item from the approved ten-notice benchmark is retried.
// The original result is retained, with an independent durable claim.
export async function retryApprovedHaikuFailure():Promise<void>{
 const run='haiku-validation-retry-20261101';
 const claim=await db.query(`INSERT INTO ai_result_cache(cache_key,function_name,model,result) VALUES($1,'benchmark','claude-haiku-5-5','{"status":"started"}') ON CONFLICT DO NOTHING RETURNING cache_key`,[run]);
 if(!claim.rows.length)return;
 const failed=await db.query(`SELECT o.* FROM ai_benchmark_results b JOIN opportunities o ON o.id=b.opportunity_id WHERE b.run_id='haiku-validation-20261101' AND b.model='claude-haiku-5-5' AND b.result->>'status'='failed'`);
 for(const o of failed.rows){
  let result:any;try{result={status:'completed',...await generateNoticeBundle(o,'claude-haiku-5-5','benchmark_retry')};}catch{result={status:'failed',code:'structured_generation_failed'};}
  await db.query(`INSERT INTO ai_benchmark_results(run_id,opportunity_id,model,title,result) VALUES($1,$2,'claude-haiku-5-5',$3,$4::jsonb) ON CONFLICT DO NOTHING`,[run,o.id,o.title,JSON.stringify(result)]);
 }
 await db.query('UPDATE ai_result_cache SET result=$2::jsonb WHERE cache_key=$1',[run,JSON.stringify({status:'completed',count:failed.rows.length})]);
}
