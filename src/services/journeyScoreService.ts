import { createHash } from 'crypto';
import { db } from '../config/database';
import { RULES_VERSION } from './matchEngine';
export const JOURNEY_SCORE_DDL=[`CREATE TABLE IF NOT EXISTS journey_scores (
 id TEXT PRIMARY KEY,session_id TEXT NOT NULL,siret VARCHAR(14) NOT NULL,opportunity_id UUID NOT NULL,
 compatibility_score INTEGER NOT NULL,score_computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),rules_version TEXT NOT NULL,
 answers JSONB NOT NULL DEFAULT '{}',lot_ref TEXT NOT NULL DEFAULT '')`,
 `CREATE INDEX IF NOT EXISTS journey_scores_company_time ON journey_scores(siret,score_computed_at)`];
export async function recordComputedScore(input:{sessionId:string;siret?:string|null;opportunityId:string;score:number|null;answers?:any;lot?:string|null}):Promise<void>{
 if(typeof input.score!=='number')return;
 const siret=input.siret||(await db.query('SELECT siret FROM siret_lookups WHERE session_id=$1',[input.sessionId])).rows[0]?.siret;
 if(!siret||!/^\d{14}$/.test(siret))return;
 const answers=input.answers||{};
 const id=createHash('sha256').update(JSON.stringify([input.sessionId,siret,input.opportunityId,input.lot||'',RULES_VERSION,answers,input.score])).digest('hex');
 await db.query(`INSERT INTO journey_scores(id,session_id,siret,opportunity_id,compatibility_score,rules_version,answers,lot_ref)
  VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8) ON CONFLICT DO NOTHING`,[id,input.sessionId,siret,input.opportunityId,input.score,RULES_VERSION,JSON.stringify(answers),input.lot||'']);
}
