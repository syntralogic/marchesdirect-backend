jest.mock('../../config/database',()=>({db:{query:jest.fn()}}));
import {db} from '../../config/database';
import {pruneClosedOpportunities} from '../opportunityRetention';
it('never queries or deletes retained notices even when the old cap is exceeded',async()=>{process.env.CLOSED_OPPORTUNITIES_LIMIT='1';expect(await pruneClosedOpportunities()).toBe(0);expect(db.query).not.toHaveBeenCalled();});
