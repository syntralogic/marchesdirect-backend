import { createHash, randomUUID } from 'crypto';
import { db } from '../config/database';
import { hubspotRequest } from './hubspotJourneySchema';
import { isTestCrmCompany } from './hubspotTestPolicy';
import { buildVisitNotes, VisitNote } from './visitNotePresentation';

async function syncNote(companyId: string, note: VisitNote): Promise<void> {
  const hash = createHash('sha256').update(note.html).digest('hex');
  // A durable claim is committed BEFORE calling HubSpot. Concurrent workers
  // cannot POST twice; an ambiguous creation failure requires reconciliation.
  const claim = await db.transaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`md-note:${companyId}:${note.sessionId}`]);
    const found = await client.query(`SELECT * FROM journey_visit_notes WHERE company_id=$1 AND session_id=$2
      AND started_at < $4::timestamptz + INTERVAL '30 minutes'
      AND last_event_at > $3::timestamptz - INTERVAL '30 minutes' ORDER BY started_at`, [companyId, note.sessionId, note.startedAt, note.lastAt]);
    if (found.rows.length > 1) throw new Error('visit_note_overlapping_visits_need_review');
    const row = found.rows[0];
    if (row?.status === 'needs_review') throw new Error('visit_note_creation_needs_review');
    if (row?.status === 'posting') throw new Error('visit_note_sync_in_progress_or_needs_review');
    if (row && new Date(row.last_event_at).getTime() > new Date(note.lastAt).getTime()) return null;
    if (row?.body_hash === hash && row.status === 'created') return null;
    if (!row) {
      const allowed = await client.query(`SELECT 1 FROM crm_setup_log WHERE key='visit_notes_policy'
        AND updated_at <= $4::timestamptz AND NOT EXISTS (
          SELECT 1 FROM journey_note_outbox n JOIN visitor_events e ON e.id=n.event_id
          WHERE n.company_id=$1 AND e.session_id=$2 AND COALESCE(e.occurred_at,e.created_at)
          BETWEEN ($3::timestamptz AT TIME ZONE 'UTC') AND ($5::timestamptz AT TIME ZONE 'UTC'))`,
        [companyId, note.sessionId, note.startedAt, note.triggerAt, note.lastAt]);
      if (!allowed.rows.length) return null; // Preserve legacy notes; no historical backfill.
    }
    const id = row?.id || randomUUID();
    if (row) await client.query(`UPDATE journey_visit_notes SET status='posting',started_at=$2,last_event_at=$3,updated_at=NOW() WHERE id=$1`, [id, note.startedAt, note.lastAt]);
    else await client.query(`INSERT INTO journey_visit_notes(id,company_id,session_id,started_at,last_event_at,status)
      VALUES($1,$2,$3,$4,$5,'posting')`, [id, companyId, note.sessionId, note.startedAt, note.lastAt]);
    return {id, noteId: row?.hubspot_note_id as string | undefined};
  });
  if (!claim) return;
  let noteId = claim.noteId;
  let creationAttempted = false;
  try {
    if (noteId) await hubspotRequest({method: 'PATCH', url: `/crm/v3/objects/notes/${noteId}`, data: {properties: {hs_note_body: note.html}}});
    else {
      const labels = await hubspotRequest({method: 'GET', url: '/crm/v4/associations/notes/companies/labels'});
      const association = labels.results?.find((label: any) => label.label === null);
      if (!association) throw new Error('visit_note_association_missing');
      creationAttempted = true;
      const created = await hubspotRequest({method: 'POST', url: '/crm/v3/objects/notes', data: {
        properties: {hs_timestamp: note.triggerAt, hs_note_body: note.html},
        associations: [{to: {id: companyId}, types: [{associationCategory: association.category, associationTypeId: association.typeId}]}],
      }});
      if (!created.id) throw new Error('visit_note_id_missing');
      noteId = String(created.id);
    }
    await db.query(`UPDATE journey_visit_notes SET hubspot_note_id=$2,body_hash=$3,status='created',updated_at=NOW() WHERE id=$1`, [claim.id, noteId, hash]);
  } catch (error) {
    await db.query(`UPDATE journey_visit_notes SET hubspot_note_id=$2,status=$3,updated_at=NOW() WHERE id=$1`,
      [claim.id, noteId || null, creationAttempted && !noteId ? 'needs_review' : 'pending']);
    throw error;
  }
}

const pending = new Map<string, Promise<void>>();
export async function syncVisitNotes(companyId: string, siret: string, name: string | null | undefined, events: any[], scores: any[]): Promise<void> {
  const notes = buildVisitNotes(events, scores);
  if (!notes.length || await isTestCrmCompany(companyId, siret, name)) return;
  const previous = pending.get(companyId) || Promise.resolve();
  const work = previous.catch(() => undefined).then(async () => { for (const note of notes) await syncNote(companyId, note); });
  pending.set(companyId, work);
  try { await work; } finally { if (pending.get(companyId) === work) pending.delete(companyId); }
}
