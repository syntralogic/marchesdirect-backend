jest.mock('../../config/database',()=>({db:{query:jest.fn()}}));
jest.mock('../hubspotJourneySchema',()=>({journeySchemaReady:true,hubspotRequest:jest.fn()}));
import {db} from '../../config/database';
import {hubspotRequest} from '../hubspotJourneySchema';
import {projectJourney,isTestCompany,syncJourneyProjection} from '../journeyProjectionService';
import {describeOffer,distinctTimelineEvents} from '../journeyOfferPresentation';
import {buildCompanyProfile,buildCompanyScore} from '../companyProfileService';
const event=(event_type:string,at:string,extra:any={})=>({event_type,at,event_data:{},...extra});
it('counts distinct announcements, preserves attribution and orders scores among actions',()=>{
 const values=projectJourney([
  event('arrival','2026-11-01T09:00:00Z',{event_data:{utm_source:'SMS',utm_campaign:'électriciens 33'}}),
  event('offer_view','2026-11-01T09:01:00Z',{offer_id:'a',offer_title:'Clim Mérignac'}),
  event('offer_view','2026-11-01T09:02:00Z',{offer_id:'a',offer_title:'Clim Mérignac'}),
  event('retour_arriere','2026-11-01T09:04:00Z'),
  event('coordonnees_saisies','2026-11-01T09:05:00Z'),
  event('callback_requested','2026-11-01T09:06:00Z'),
 ],[{compatibility_score:82,score_computed_at:'2026-11-01T09:03:00Z',title:'Clim Mérignac'}],'2026-11-01T09:02:00Z',new Date('2026-11-01T10:00:00Z'));
 expect(values).toMatchObject({md_distinct_offers_count:1,md_source:'SMS',md_campaign:'électriciens 33',md_visitor_choice:'callback',md_abandonment_step:'',md_siret_entered_at:'2026-11-01T09:02:00.000Z'});
 const summary=values.md_journey_summary;expect(summary.indexOf('Score 82')).toBeLessThan(summary.indexOf('Retour arrière'));
 expect(summary).toContain('01/11 10h03');
});
it('marks abandonment at thirty minutes and clears it when the visitor returns',()=>{
 const events=[event('company_selected','2026-11-01T09:00:00Z')];
 expect(projectJourney(events,[],events[0].at,new Date('2026-11-01T09:29:59Z')).md_abandonment_step).toBe('');
 expect(projectJourney(events,[],events[0].at,new Date('2026-11-01T09:30:00Z')).md_abandonment_step).toBe('SIRET saisi');
 expect(projectJourney([...events,event('offer_view','2026-11-01T09:31:00Z')],[],events[0].at,new Date('2026-11-01T09:31:01Z')).md_abandonment_step).toBe('');
});
it('enriches only known registry data, including overseas and Corsican departments',()=>{
 expect(buildCompanyProfile({ape:'4321A',activity:'Électricité',address:'1 rue X',city:'Bordeaux',postal:'33000'})).toMatchObject({md_naf_code:'4321A',md_trade:'Électricité',md_department:'33'});
 expect(buildCompanyProfile({postal:'97100'}).md_department).toBe('971');
 expect(buildCompanyProfile({postal:'20100'}).md_department).toBe('2A');
 expect(buildCompanyProfile({postal:'20200'}).md_department).toBe('2B');
 expect(buildCompanyProfile({})).toEqual({});
 expect(buildCompanyScore({compatibility_score:82,score_computed_at:'2026-11-01T10:12:34.123Z'}).md_score_date).toBe('2026-11-01T10:12:34.123Z');
});
it('recognizes all approved test companies and does not mark an unrelated business',()=>{
 for(const name of ['ZIENT LABS','VERIFRANCE HABITAT','4060 INVEST'])expect(isTestCompany('00000000000000',name)).toBe(true);
 for(const siret of ['71202415700018','39112811300019','12345678900012'])expect(isTestCompany(siret)).toBe(true);
 expect(isTestCompany('83438617900024','AIS ELEC BORDEAUX')).toBe(false);
});
it('adds the same usable context to all offer fields and chooses the latest analyzed URL',()=>{
 const offer={offer_id:'abc-123',offer_title:'Extension de la déchetterie de Thônes',location_department:'74',source_reference:'26-98064',deadline:'2026-11-13T11:00:00Z'};
 const events=[event('offer_view','2026-11-01T16:36:00Z',offer)];
 const scores=[{...offer,opportunity_id:offer.offer_id,compatibility_score:82,score_computed_at:'2026-11-01T17:00:00Z'},{opportunity_id:'older',compatibility_score:42,score_computed_at:'2026-11-01T16:00:00Z'}];
 const values=projectJourney(events,scores,null,new Date('2026-11-01T18:00:00Z'));
 for(const field of ['md_viewed_offers','md_origin_offer','md_scores_by_offer','md_journey_summary']) {
  expect(values[field]).toContain('Extension de la déchetterie de Thônes (74) · réf. 26-98064 · J-12 (13/11/2026) · https://marchesdirect.fr/opportunites/abc-123');
 }
 expect(values.md_viewed_offers).toContain('01/11 17h36');
 expect(values.md_last_analyzed_offer_url).toBe('https://marchesdirect.fr/opportunites/abc-123');
 expect(projectJourney(events,[],null).md_last_analyzed_offer_url).toBeUndefined();
});
it('handles Paris calendar days, elapsed deadlines and unavailable metadata honestly',()=>{
 const offer={offer_id:'a/b',source_reference:'DEMO-seed',deadline:'2026-11-01T11:00:00Z'};
 expect(describeOffer(offer,new Date('2026-11-01T23:15:00Z'))).toContain('Échue depuis 1 j (01/11/2026)');
 expect(describeOffer(offer,new Date('2026-11-01T10:00:00Z'))).toContain('J-0');
 expect(describeOffer({...offer,deadline:'invalid'},new Date())).toBe('Annonce · réf. MD-AB · Échéance non renseignée · https://marchesdirect.fr/opportunites/a%2Fb');
});
it('coalesces matching display events under a minute across sessions without removing raw activity',()=>{
 const events=[event('company_selected','2026-10-31T20:19:15.858Z',{session_id:'first'}),event('company_selected','2026-10-31T20:19:21.338Z',{session_id:'second'})];
 const values=projectJourney(events,[],events[0].at,new Date('2026-10-31T20:49:16Z'));
 expect(values.md_journey_summary.match(/SIRET saisi/g)).toHaveLength(1);
 expect(values.md_abandonment_step).toBe(''); // last real activity is less than 30 minutes old
 expect(events).toHaveLength(2);
 expect(distinctTimelineEvents([...events,event('company_selected','2026-10-31T20:20:15.858Z')])).toHaveLength(2);
 expect(distinctTimelineEvents([event('offer_view',events[0].at,{offer_id:'one'}),event('offer_view',events[1].at,{offer_id:'two'})])).toHaveLength(2);
 expect(distinctTimelineEvents([event('arrival',events[0].at,{event_data:{utm_source:'SMS'}}),event('arrival',events[1].at,{event_data:{utm_source:'Google'}})])).toHaveLength(2);
});
it('never overwrites a manually approved test flag with false during projection',async()=>{
 (db.query as jest.Mock).mockResolvedValue({rows:[]});
 (hubspotRequest as jest.Mock).mockResolvedValue({});
 await syncJourneyProjection('company','83438617900024');
 expect((hubspotRequest as jest.Mock).mock.calls[0][0].data.properties).not.toHaveProperty('md_is_test');
});
