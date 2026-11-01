jest.mock('../../config/database',()=>({db:{query:jest.fn()}}));
import {projectJourney,isTestCompany} from '../journeyProjectionService';
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
 expect(isTestCompany('83438617900024','AIS ELEC BORDEAUX')).toBe(false);
});
