// Run after npm run build. Uses a disposable WASM PostgreSQL database, never production.
const {PGlite}=require('@electric-sql/pglite');
const assert=require('node:assert/strict');
const path=require('node:path');
(async()=>{
 const pg=new PGlite();
 await pg.exec(`CREATE FUNCTION uuid_generate_v4() RETURNS uuid LANGUAGE SQL AS 'SELECT gen_random_uuid()';
 CREATE TABLE visitor_events(id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),session_id text,brand_id uuid,event_type text,event_label text,event_data jsonb,event_id text,occurred_at timestamp,siret varchar(14),opportunity_id text,lot_ref text,analysis_id text,created_at timestamp DEFAULT CURRENT_TIMESTAMP);
 CREATE UNIQUE INDEX visitor_events_session_event_id ON visitor_events(session_id,event_id) WHERE event_id IS NOT NULL;
 CREATE TABLE siret_lookups(session_id text PRIMARY KEY,siret varchar(14),company_data jsonb,created_at timestamp DEFAULT CURRENT_TIMESTAMP,email text,phone text,lead_captured_at timestamp);
 CREATE TABLE crm_leads(id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),session_id text,crm_sync_status text,created_at timestamp DEFAULT CURRENT_TIMESTAMP);`);
 const {JOURNEY_IDENTITY_DDL}=require('../dist/src/services/journeyIdentitySchema');
 for(const sql of JOURNEY_IDENTITY_DDL)await pg.exec(sql);
 for(const sql of JOURNEY_IDENTITY_DDL)await pg.exec(sql); // rerunnable migration
 const db={query:(...a)=>pg.query(...a),transaction:fn=>pg.transaction(tx=>fn({query:(...a)=>tx.query(...a)}))};
 const databaseFile=path.resolve(__dirname,'../dist/src/config/database.js');
 require.cache[databaseFile]={id:databaseFile,filename:databaseFile,loaded:true,exports:{db}};
 const {storeJourneyEvent,selectJourneyCompany}=require('../dist/src/services/journeyStorageService');
 const a='83438617900024',b='12345678901234',sessionId='same-browser';
 const base={sessionId,eventType:'offer_view',trackingVersion:1};
 await storeJourneyEvent({...base,eventId:'before-siret',siret:null,occurredAt:'2026-01-01T10:00:00Z'});
 await selectJourneyCompany(sessionId,a,{name:'A'});
 const frozen={...base,eventId:'on-a',siret:a,occurredAt:'2026-01-01T10:01:00Z'};
 assert.equal(await storeJourneyEvent(frozen),true);
 await pg.query("UPDATE siret_lookups SET email='test@example.com',phone='0600000000',lead_captured_at=NOW() WHERE session_id=$1",[sessionId]);
 const lead=await pg.query('INSERT INTO crm_leads(session_id) VALUES($1) RETURNING id,siret',[sessionId]);assert.equal(lead.rows[0].siret,a);
 const originalA=(await pg.query('SELECT created_at FROM siret_lookups WHERE session_id=$1',[sessionId])).rows[0].created_at;
 await selectJourneyCompany(sessionId,b,{name:'B'});
 assert.equal(await storeJourneyEvent(frozen),false); // delayed retry after B, no duplicate
 await storeJourneyEvent({...base,eventId:'on-b',siret:b});
 await storeJourneyEvent({...base,eventId:'delayed-anonymous',siret:null,occurredAt:'2026-01-01T09:59:00Z'});
 const current=(await pg.query('SELECT * FROM siret_lookups')).rows[0];assert.equal(current.siret,b);assert.equal(current.email,null);assert.equal(current.phone,null);
 const rows=(await pg.query('SELECT event_id,siret,attribution_siret FROM visitor_events WHERE event_type=$1',['offer_view'])).rows;
 assert.deepEqual(rows.find(r=>r.event_id==='on-a'),{event_id:'on-a',siret:a,attribution_siret:a});
 assert.equal(rows.find(r=>r.event_id==='on-b').attribution_siret,b);
 assert.equal(rows.find(r=>r.event_id==='before-siret').attribution_siret,a);
 assert.equal(rows.find(r=>r.event_id==='before-siret').siret,null);
 assert.equal(rows.find(r=>r.event_id==='delayed-anonymous').attribution_siret,a);
 assert.equal((await pg.query('SELECT siret FROM crm_leads WHERE id=$1',[lead.rows[0].id])).rows[0].siret,a);
 // A failed downstream write rolls back the event itself (HTTP route can honestly return 503).
 await pg.exec('ALTER TABLE crm_leads RENAME COLUMN crm_sync_status TO unavailable_column');
 await assert.rejects(storeJourneyEvent({...base,eventId:'rolled-back',siret:b}));
 assert.equal((await pg.query("SELECT count(*)::int n FROM visitor_events WHERE event_id='rolled-back'")).rows[0].n,0);
 await pg.exec('ALTER TABLE crm_leads RENAME COLUMN unavailable_column TO crm_sync_status');
 await selectJourneyCompany(sessionId,a,{name:'A'});
 assert.equal((await pg.query("SELECT attribution_siret FROM visitor_events WHERE event_id='on-b'")).rows[0].attribution_siret,b);
 assert.equal(new Date((await pg.query('SELECT created_at FROM siret_lookups WHERE session_id=$1',[sessionId])).rows[0].created_at).toISOString(),new Date(originalA).toISOString());
 const {JOURNEY_SCORE_DDL,recordComputedScore}=require('../dist/src/services/journeyScoreService');
 for(const sql of JOURNEY_SCORE_DDL)await pg.exec(sql);
 const score={sessionId,siret:a,opportunityId:'11111111-1111-4111-8111-111111111111',score:82};
 await recordComputedScore(score);const computed=(await pg.query('SELECT score_computed_at FROM journey_scores')).rows[0].score_computed_at;
 await recordComputedScore(score);assert.equal((await pg.query('SELECT count(*)::int n FROM journey_scores')).rows[0].n,1);
 assert.equal(new Date((await pg.query('SELECT score_computed_at FROM journey_scores')).rows[0].score_computed_at).toISOString(),new Date(computed).toISOString());
 await pg.close();console.log('PASS PostgreSQL: migration twice; pre-SIRET attribution; A → B → A; delayed retry; immutable lead; rollback; coordinates reset');
})().catch(e=>{console.error(e.message);process.exitCode=1});
