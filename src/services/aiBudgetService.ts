import axios from 'axios';
import { randomUUID } from 'crypto';
import { db } from '../config/database';

export const AI_BUDGET_DDL = [
  `CREATE TABLE IF NOT EXISTS ai_daily_spend(day DATE PRIMARY KEY, reserved_microusd BIGINT NOT NULL DEFAULT 0, spent_microusd BIGINT NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS ai_usage(id UUID PRIMARY KEY, budget_day DATE NOT NULL, function_name TEXT NOT NULL, model TEXT NOT NULL, status TEXT NOT NULL, reserved_microusd BIGINT NOT NULL, cost_microusd BIGINT, input_tokens INTEGER, output_tokens INTEGER, cache_write_tokens INTEGER, cache_read_tokens INTEGER, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
  `CREATE TABLE IF NOT EXISTS ai_result_cache(cache_key TEXT PRIMARY KEY, function_name TEXT NOT NULL, model TEXT NOT NULL, result JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
  `CREATE TABLE IF NOT EXISTS ai_benchmark_results(run_id TEXT NOT NULL, opportunity_id UUID NOT NULL, model TEXT NOT NULL, title TEXT NOT NULL, result JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(run_id,opportunity_id,model))`,
];
const PRICES: Record<string,[number,number]> = {
  'claude-sonnet-5':[2,10], 'claude-haiku-5-5':[0.1,0.5],
  'claude-haiku-4-5-20251001':[1,5], 'claude-sonnet-4-5-20250929':[3,15],
};
export function usageCostMicrousd(model: string, usage: any): number {
  const p=PRICES[model]; if(!p) throw new Error('ai_model_price_unknown');
  return Math.ceil((usage.input_tokens||0)*p[0]+(usage.output_tokens||0)*p[1]
    +(usage.cache_creation_input_tokens||0)*p[0]*1.25+(usage.cache_read_input_tokens||0)*p[0]*0.1);
}
export function reservationMicrousd(model: string, payload: any): number {
  const p=PRICES[model]; if(!p) throw new Error('ai_model_price_unknown');
  // UTF-8 bytes bound token count conservatively; include protocol overhead
  // and a 2x input margin (also covers prompt-cache writes).
  return Math.ceil((Buffer.byteLength(JSON.stringify(payload),'utf8')+4096)*p[0]*2+payload.max_tokens*p[1]);
}
export async function paidClaudeRequest(payload: any, functionName: string): Promise<any> {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ai_not_configured');
  const model=String(payload.model), reserve=reservationMicrousd(model,payload), id=randomUUID();
  const day=await db.transaction(async client=>{
    const d=(await client.query("SELECT (NOW() AT TIME ZONE 'Europe/Paris')::date::text AS day")).rows[0].day;
    await client.query('INSERT INTO ai_daily_spend(day) VALUES($1) ON CONFLICT DO NOTHING',[d]);
    const admitted=await client.query(`UPDATE ai_daily_spend SET reserved_microusd=reserved_microusd+$2
      WHERE day=$1 AND spent_microusd+reserved_microusd+$2<=1000000 RETURNING day`,[d,reserve]);
    if(!admitted.rows.length) throw new Error('ai_daily_budget_reached');
    await client.query(`INSERT INTO ai_usage(id,budget_day,function_name,model,status,reserved_microusd)
      VALUES($1,$2,$3,$4,'reserved',$5)`,[id,d,functionName,model,reserve]);
    return d;
  });
  let response: any;
  try {
    response=await axios.post('https://api.anthropic.com/v1/messages',payload,{
      headers:{'Content-Type':'application/json','x-api-key':process.env.ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01'},timeout:30000,
    });
  } catch(err) {
    // An ambiguous transport failure may have been billed. Keep the full
    // reservation charged conservatively; never retry automatically.
    await db.transaction(async c=>{
      await c.query('UPDATE ai_daily_spend SET reserved_microusd=reserved_microusd-$2,spent_microusd=spent_microusd+$2 WHERE day=$1',[day,reserve]);
      await c.query("UPDATE ai_usage SET status='failed_cost_reserved',cost_microusd=$2 WHERE id=$1",[id,reserve]);
    });
    throw err;
  }
  const usage=response.data?.usage;
  const cost=usage ? usageCostMicrousd(model,usage) : reserve;
  await db.transaction(async c=>{
    await c.query('UPDATE ai_daily_spend SET reserved_microusd=reserved_microusd-$2,spent_microusd=spent_microusd+$3 WHERE day=$1',[day,reserve,cost]);
    await c.query(`UPDATE ai_usage SET status=$2,cost_microusd=$3,input_tokens=$4,output_tokens=$5,cache_write_tokens=$6,cache_read_tokens=$7 WHERE id=$1`,
      [id,usage?'completed':'completed_usage_missing',cost,usage?.input_tokens||0,usage?.output_tokens||0,usage?.cache_creation_input_tokens||0,usage?.cache_read_input_tokens||0]);
  });
  return response;
}
