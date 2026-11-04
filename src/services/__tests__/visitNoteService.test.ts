jest.mock('../../config/database',()=>({db:{query:jest.fn(),transaction:jest.fn()}}));
jest.mock('../hubspotJourneySchema',()=>({hubspotRequest:jest.fn()}));
import {db} from '../../config/database';
import {hubspotRequest} from '../hubspotJourneySchema';
import {syncVisitNotes} from '../visitNoteService';

const request=hubspotRequest as jest.Mock;
const query=db.query as jest.Mock;
const transaction=db.transaction as jest.Mock;
const event=(type:string,seconds:number,extra:any={})=>({session_id:'session',id:`e-${seconds}`,event_type:type,at:new Date(Date.UTC(2026,10,1,10,0,seconds)).toISOString(),...extra});
const first=[event('company_selected',0),event('coordonnees_saisies',10)];
const continued=[...first,event('offer_view',20,{offer_id:'offer',offer_title:'Travaux',location_department:'33'}),event('callback_requested',21)];
let row:any; let allowed:boolean; let testFlag:boolean; let txQuery:jest.Mock;

beforeEach(()=>{
 jest.resetAllMocks(); row=null;allowed=true;testFlag=false;
 txQuery=jest.fn(async(sql:string,p:any[])=>{
  if(sql.includes('SELECT * FROM journey_visit_notes'))return {rows:row?[{...row}]:[]};
  if(sql.includes('SELECT 1 FROM crm_setup_log'))return {rows:allowed?[{}]:[]};
  if(sql.includes('INSERT INTO journey_visit_notes'))row={id:p[0],company_id:p[1],session_id:p[2],started_at:p[3],last_event_at:p[4],status:'posting'};
  if(sql.includes('UPDATE journey_visit_notes SET status'))Object.assign(row,{status:'posting',started_at:p[1],last_event_at:p[2]});
  return {rows:[]};
 });
 transaction.mockImplementation(fn=>fn({query:txQuery}));
 query.mockImplementation(async(sql:string,p:any[])=>{
  if(sql.includes('body_hash=$3'))Object.assign(row,{hubspot_note_id:p[1],body_hash:p[2],status:'created'});
  else if(sql.includes('status=$3'))Object.assign(row,{hubspot_note_id:p[1],status:p[2]});
  return {rows:[]};
 });
 request.mockImplementation(async cfg=>{
  if(cfg.url.startsWith('/crm/v3/objects/companies/'))return {properties:{md_is_test:String(testFlag)}};
  if(cfg.url.includes('/labels'))return {results:[{label:null,category:'HUBSPOT_DEFINED',typeId:190}]};
  if(cfg.method==='POST')return {id:'note-1'};
  return {};
 });
});
const run=(events=first,siret='83438617900024')=>syncVisitNotes('company',siret,'Client',events,[]);
const posts=()=>request.mock.calls.filter(([c])=>c.method==='POST');
const patches=()=>request.mock.calls.filter(([c])=>c.method==='PATCH');

it('creates at coordinates, patches the same note on a choice, and skips identical retries',async()=>{
 await run(); expect(posts()).toHaveLength(1);expect(row.hubspot_note_id).toBe('note-1');
 await run(continued);expect(posts()).toHaveLength(1);expect(patches()).toHaveLength(1);
 expect(patches()[0][0].url).toBe('/crm/v3/objects/notes/note-1');
 expect(patches()[0][0].data.properties.hs_note_body).toContain('Rappel demandé');
 expect(patches()[0][0].data.properties).not.toHaveProperty('hs_timestamp');
 await run(continued);expect(posts()).toHaveLength(1);expect(patches()).toHaveLength(1);
});
it('serializes concurrent retries and does not regress to an older snapshot',async()=>{
 await Promise.all([run(),run(continued)]);
 expect(posts()).toHaveLength(1);expect(patches()).toHaveLength(1);
 const body=row.body_hash;await run();expect(row.body_hash).toBe(body);expect(patches()).toHaveLength(1);
});
it('creates neither notes nor durable claims for known or manually flagged tests',async()=>{
 await run(first,'10945324100019');expect(request).not.toHaveBeenCalled();expect(transaction).not.toHaveBeenCalled();
 testFlag=true;await run();expect(posts()).toHaveLength(0);expect(transaction).not.toHaveBeenCalled();
});
it('does not create on SIRET alone or backfill a legacy visit',async()=>{
 await run([event('company_selected',0)]);expect(request).not.toHaveBeenCalled();
 allowed=false;await run();expect(posts()).toHaveLength(0);expect(row).toBeNull();
});
it('fails closed when the company test flag cannot be read',async()=>{
 request.mockRejectedValueOnce(new Error('unavailable'));
 await expect(run()).rejects.toThrow('unavailable');expect(transaction).not.toHaveBeenCalled();
});
it('does not create a duplicate after an ambiguous HubSpot creation error',async()=>{
 request.mockImplementation(async cfg=>{
  if(cfg.url.includes('/companies/company'))return {properties:{md_is_test:'false'}};
  if(cfg.url.includes('/labels'))return {results:[{label:null,category:'HUBSPOT_DEFINED',typeId:190}]};
  throw new Error('connection lost after sending');
 });
 await expect(run()).rejects.toThrow('connection lost');expect(row.status).toBe('needs_review');
 await expect(run()).rejects.toThrow('needs_review');expect(posts()).toHaveLength(1);
});
it('retries updates safely using the saved note id',async()=>{
 await run();const normal=request.getMockImplementation()!;
 request.mockImplementation(async cfg=>{if(cfg.method==='PATCH')throw new Error('timeout');return normal(cfg);});
 await expect(run(continued)).rejects.toThrow('timeout');expect(row.status).toBe('pending');
 request.mockImplementation(normal);await run(continued);
 expect(posts()).toHaveLength(1);expect(patches()).toHaveLength(2);expect(row.status).toBe('created');
});
it('keeps the returned note id when saving the successful creation initially fails',async()=>{
 const normal=query.getMockImplementation()!;let fail=true;
 query.mockImplementation(async(sql,p)=>{if(fail&&sql.includes('body_hash=$3')){fail=false;throw new Error('database unavailable');}return normal(sql,p);});
 await expect(run()).rejects.toThrow('database unavailable');expect(row.hubspot_note_id).toBe('note-1');
 await run();expect(posts()).toHaveLength(1);expect(patches()).toHaveLength(1);
});
it('does not steal another worker’s durable creation claim',async()=>{
 row={id:'claimed',status:'posting',started_at:first[0].at,last_event_at:first[1].at};
 await expect(run()).rejects.toThrow('sync_in_progress');expect(posts()).toHaveLength(0);
});
