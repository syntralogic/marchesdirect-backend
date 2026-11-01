jest.mock('../../config/database', () => ({ db: { query: jest.fn() } }));
import { db } from '../../config/database';
import { dossierStatesFor } from '../dossierStateService';
const q=db.query as jest.Mock;
beforeEach(()=>q.mockReset());
it.each(['not_configured','failed','sent'])('a generated PDF remains generated when delivery is %s',async status=>{
  q.mockResolvedValueOnce({rows:[{id:'g1',status:'generated',created_at:'2026-11-01T10:00:00Z'}]})
   .mockResolvedValueOnce({rows:[{status,created_at:'2026-11-01T10:00:02Z'}]});
  const result=await dossierStatesFor({sessionId:'s1',opportunityId:'o1',siret:'83438617900024'});
  expect(result).toMatchObject({dossierStatus:'available',emailStatus:status});
  expect(result.errorAt).toBe(status==='sent'?undefined:'2026-11-01T10:00:02.000Z');
  expect(q.mock.calls[0][1][2]).toBe('83438617900024');
});
it('PDF failure records an alert but does not pretend email was attempted',async()=>{
  q.mockResolvedValueOnce({rows:[{id:'g1',status:'failed',created_at:'2026-11-01T10:00:00Z'}]}).mockResolvedValueOnce({rows:[]});
  expect(await dossierStatesFor({sessionId:'s1',opportunityId:'o1'})).toEqual({dossierStatus:'error',emailStatus:'not_attempted',errorAt:'2026-11-01T10:00:00.000Z',errorCode:'pdf_generation_failed'});
});
it('legacy failures never acquire a new alert date and this reader never writes or sends',async()=>{
  q.mockResolvedValueOnce({rows:[]}).mockResolvedValueOnce({rows:[{status:'not_configured',created_at:'2026-10-31T10:00:00Z'}]});
  expect(await dossierStatesFor({sessionId:'s1',opportunityId:'o1'})).toEqual({dossierStatus:'available',emailStatus:'not_configured'});
  expect(q.mock.calls.every(([sql])=>sql.trim().startsWith('SELECT'))).toBe(true);
});
