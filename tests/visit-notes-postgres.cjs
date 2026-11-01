// Disposable PostgreSQL only; all HubSpot requests are stubbed.
const {PGlite}=require('@electric-sql/pglite');
const assert=require('node:assert/strict');
const path=require('node:path');
(async()=>{
 const pg=new PGlite();
 await pg.exec('CREATE TABLE visitor_events(id uuid PRIMARY KEY,session_id text,occurred_at timestamp,created_at timestamp);');
 const db={query:(...a)=>pg.query(...a),transaction:fn=>pg.transaction(tx=>fn({query:(...a)=>tx.query(...a)}))};
 const databaseFile=path.resolve(__dirname,'../dist/src/config/database.js');
 require.cache[databaseFile]={id:databaseFile,filename:databaseFile,loaded:true,exports:{db}};
 const schema=require('../dist/src/services/hubspotJourneySchema');
 for(let i=0;i<2;i++)for(const sql of schema.JOURNEY_PROJECTION_DDL)await pg.exec(sql);
 assert.equal((await pg.query("SELECT relrowsecurity FROM pg_class WHERE oid='journey_visit_notes'::regclass")).rows[0].relrowsecurity,true);
 await pg.exec("UPDATE crm_setup_log SET updated_at='2026-01-01T00:00:00Z' WHERE key='visit_notes_policy'");
 const calls=[];
 schema.hubspotRequest=async cfg=>{
  calls.push(cfg);
  if(cfg.url.includes('/companies/company'))return {properties:{md_is_test:'false'}};
  if(cfg.url.includes('/labels'))return {results:[{label:null,category:'HUBSPOT_DEFINED',typeId:190}]};
  if(cfg.method==='POST')return {id:`note-${calls.filter(c=>c.method==='POST').length}`};
  return {};
 };
 const {syncVisitNotes}=require('../dist/src/services/visitNoteService');
 const event=(type,time,session='visitor')=>({session_id:session,event_type:type,at:`2026-11-01T${time}Z`});
 const first=[event('company_selected','10:00:00'),event('coordonnees_saisies','10:01:00')];
 const continued=[...first,event('callback_requested','10:02:00')];
 const run=events=>syncVisitNotes('company','83438617900024','Client',events,[]);
 await run(first);await run(continued);await run(continued);
 assert.equal(calls.filter(c=>c.method==='POST').length,1);
 assert.equal(calls.filter(c=>c.method==='PATCH').length,1);
 assert.equal((await pg.query('SELECT status FROM journey_visit_notes')).rows[0].status,'created');
 // Exactly thirty minutes later is a separate visit, even for a persistent browser id.
 const second=[...continued,event('company_selected','10:32:00'),event('dossier_requested','10:33:00')];
 await run(second);
 assert.equal(calls.filter(c=>c.method==='POST').length,2);
 assert.equal((await pg.query('SELECT count(*)::int n FROM journey_visit_notes')).rows[0].n,2);
 // Legacy notes are preserved; their visit does not gain a new replacement note.
 await pg.exec("INSERT INTO visitor_events VALUES('11111111-1111-4111-8111-111111111111','legacy','2026-11-01T11:01:00','2026-11-01T11:01:00'); INSERT INTO journey_note_outbox(event_id,company_id,status,hubspot_note_id) VALUES('11111111-1111-4111-8111-111111111111','company','created','old-note');");
 await run([event('company_selected','11:00:00','legacy'),event('callback_requested','11:01:00','legacy')]);
 assert.equal(calls.filter(c=>c.method==='POST').length,2);
 assert.equal((await pg.query('SELECT hubspot_note_id FROM journey_note_outbox')).rows[0].hubspot_note_id,'old-note');
 await pg.close();
 console.log('PASS PostgreSQL: migration twice; create/update/retry; visit boundary; legacy notes preserved');
})().catch(e=>{console.error(e);process.exitCode=1});
