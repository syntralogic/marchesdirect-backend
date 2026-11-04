import { db } from '../config/database';
import { logger } from '../utils/logger';
// No deletion policy: closed notices remain stored. Ingestion may stop adding
// closed notices at the configured cap, but existing rows are never pruned.
export const CLOSED_STATUSES=['awarded','expired','cancelled'];
export const getClosedLimit=():number=>{const n=Number(process.env.CLOSED_OPPORTUNITIES_LIMIT);return n>0?Math.floor(n):100000;};
export async function countClosedOpportunities():Promise<number>{const r=await db.query('SELECT COUNT(*)::int AS n FROM opportunities WHERE status=ANY($1::text[]) AND deleted_at IS NULL',[CLOSED_STATUSES]);return r.rows[0]?.n??0;}
export async function closedRoomLeft():Promise<number>{return Math.max(0,getClosedLimit()-await countClosedOpportunities());}
export async function pruneClosedOpportunities():Promise<number>{logger.info('[Retention] Automatic deletion disabled; all existing notices preserved');return 0;}
