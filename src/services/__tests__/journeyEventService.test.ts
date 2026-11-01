jest.mock('../journeyStorageService', () => ({ storeJourneyEvent: jest.fn() }));
jest.mock('../../config/database', () => ({ db: { query: jest.fn() } }));
jest.mock('../crmSyncService', () => ({ syncLeadToCrm: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../hubspotSyncService', () => ({ syncCompanyJourneyForSession: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../crmSystem', () => ({ activeCrmSystem: () => 'hubspot' }));
jest.mock('../../utils/logger', () => ({ logger: { error: jest.fn() } }));
import { storeJourneyEvent } from '../journeyStorageService';
import { db } from '../../config/database';
import { syncLeadToCrm } from '../crmSyncService';
import { syncCompanyJourneyForSession } from '../hubspotSyncService';
import { recordJourneyEvent, refreshJourneyForSession } from '../journeyEventService';
const q = db.query as jest.Mock;
beforeEach(() => { jest.clearAllMocks(); jest.useFakeTimers(); });
afterEach(() => { jest.useRealTimers(); });

it('stores server evidence with a stable conflict key, not fabricated phone or search facts', async () => {
  q.mockResolvedValue({ rows: [] });
  await recordJourneyEvent({ sessionId: 'session-123', eventType: 'analysis_completed', eventId: 'analysis-1', opportunityId: 'market-1' });
  expect(storeJourneyEvent).toHaveBeenCalledWith(expect.objectContaining({ sessionId:'session-123', eventType:'analysis_completed', eventId:'analysis-1', trackingVersion:1, eventData:{source:'server',opportunityId:'market-1'} }));
});

it('keeps capture non-fatal when the journal is unavailable', async () => {
  (storeJourneyEvent as jest.Mock).mockRejectedValueOnce(new Error('database unavailable'));
  await expect(recordJourneyEvent({ sessionId: 'session-123', eventType: 'dossier_requested', eventId: 'lead-1' })).resolves.toBeUndefined();
});

it('marks leads pending durably and coalesces a burst into one refresh', async () => {
  q.mockResolvedValue({ rows: [{ id: 'lead-1' }] });
  await refreshJourneyForSession('session-123');
  await refreshJourneyForSession('session-123');
  expect(q.mock.calls[0][0]).toContain("crm_sync_status = 'pending'");
  expect(syncLeadToCrm).not.toHaveBeenCalled();
  await jest.advanceTimersByTimeAsync(2000);
  expect(syncLeadToCrm).toHaveBeenCalledTimes(1);
  expect(syncLeadToCrm).toHaveBeenCalledWith('lead-1');
});

it('refreshes a selected company without creating a fictitious contact or request', async () => {
  q.mockResolvedValue({ rows: [] });
  await refreshJourneyForSession('anonymous-123');
  await jest.advanceTimersByTimeAsync(2000);
  expect(syncLeadToCrm).not.toHaveBeenCalled();
  expect(syncCompanyJourneyForSession).toHaveBeenCalledWith('anonymous-123');
});
