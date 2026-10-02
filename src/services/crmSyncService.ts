import axios from 'axios';
import { db } from '../config/database';
import { logger } from '../utils/logger';

// ============================================================================
// CRM SYNC (Milestone 8 / Technical Requirements section 9: "Lead capture
// form... sent automatically to the CRM")
//
// This was entirely missing before: routes/crmPublic.ts inserted leads with
// crm_sync_status = 'pending' and nothing ever moved them past that. The
// funnel the spec describes (Google/ad -> landing page -> lead form -> CRM ->
// sales call -> subscription) dead-ended silently at "saved to our own
// database" - a salesperson relying on the CRM inbox would never see these
// leads at all.
//
// Implements the Pipedrive Leads API (CRM_SYSTEM=pipedrive is the .env.example
// default) since that's the configured default; the shape here is deliberately
// a thin adapter so swapping to HubSpot/Salesforce later means writing a
// second small function, not restructuring the caller.
//
// IMPORTANT: this has been written against Pipedrive's documented API v1
// (https://developers.pipedrive.com/docs/api/v1) but this sandbox has no
// network path to pipedrive.com, so it has not been exercised against a real
// Pipedrive account. Treat the first real lead capture after go-live as the
// actual test, and check `crm_leads.crm_sync_status` / `crm_last_sync` on it
// before assuming this works end-to-end.
// ============================================================================

type LeadRow = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string;
  phone: string | null;
  company_name: string | null;
  industry_trade: string | null;
  location_city: string | null;
  location_region: string | null;
  lead_source: string | null;
  message?: string | null;
  appointment_mode?: string | null;
  appointment_slot_at?: Date | string | null;
  opportunity_id?: string | null;
  opportunity_title?: string | null;
  crm_contact_id?: string | null;
};

async function syncToPipedrive(lead: LeadRow): Promise<{ contactId: string }> {
  const apiKey = process.env.CRM_API_KEY;
  const baseUrl = process.env.CRM_BASE_URL; // e.g. https://your-company.pipedrive.com/api/v1
  if (!apiKey || !baseUrl) {
    throw new Error('CRM_API_KEY / CRM_BASE_URL not configured');
  }

  const fullName = [lead.first_name, lead.last_name].filter(Boolean).join(' ') || lead.email;

  // 1. Reuse the Person when one already exists. 30 Sep CRM check: every retry
  //    (and every second form from the same visitor) created a NEW person, so
  //    the sales team saw duplicates. We first reuse the id we stored on a
  //    previous attempt, then look the person up by exact e-mail, and only
  //    then create it.
  let existingId: string | null = lead.crm_contact_id ? String(lead.crm_contact_id) : null;
  if (!existingId) {
    try {
      const found = await axios.get(`${baseUrl}/persons/search`, {
        params: { api_token: apiKey, term: lead.email, fields: 'email', exact_match: true, limit: 1 },
        timeout: 10000,
      });
      const item = found.data?.data?.items?.[0]?.item;
      if (item?.id) existingId = String(item.id);
    } catch (err) {
      logger.warn(`[CRM] Person lookup failed for ${lead.id}, creating a new person instead`);
    }
  }
  const personResp = existingId
    ? { data: { data: { id: existingId } } }
    : await axios.post(
        `${baseUrl}/persons`,
        {
          name: fullName,
          email: [{ value: lead.email, primary: true }],
          phone: lead.phone ? [{ value: lead.phone, primary: true }] : undefined,
          org_name: lead.company_name || undefined,
        },
        { params: { api_token: apiKey }, timeout: 10000 }
      );

  const personId = personResp.data?.data?.id;
  if (!personId) {
    throw new Error('Pipedrive did not return a person id');
  }
  // Persist it right away: if the next call fails, the retry reuses this person.
  await db.query('UPDATE crm_leads SET crm_contact_id = $1 WHERE id = $2', [String(personId), lead.id]);

  // 2. Create a Lead referencing that person, with our platform-specific
  //    fields folded into the lead's note since Pipedrive custom fields would
  //    need to be pre-configured per Pipedrive account (can't be assumed here).
  const noteParts = [
    lead.company_name ? `Entreprise: ${lead.company_name}` : null,
    lead.industry_trade ? `Metier: ${lead.industry_trade}` : null,
    lead.location_city ? `Ville: ${lead.location_city}` : null,
    lead.location_region ? `Region: ${lead.location_region}` : null,
    lead.lead_source ? `Source: ${lead.lead_source}` : null,
    // 30 Sep CRM check: none of this reached the CRM, so a salesperson saw a
    // name with no reason to call. The visitor's message, the requested
    // rendez-vous and the opportunity concerned are now part of the lead.
    lead.opportunity_title ? `Opportunité: ${lead.opportunity_title}` : null,
    lead.appointment_mode === 'slot' && lead.appointment_slot_at
      ? `Rendez-vous demandé: ${new Date(lead.appointment_slot_at).toLocaleString('fr-FR', { timeZone: 'Europe/Paris' })}`
      : lead.appointment_mode === 'callback' ? 'Demande: être rappelé' : null,
    lead.message ? `Message: ${lead.message}` : null,
  ].filter(Boolean);

  await axios.post(
    `${baseUrl}/leads`,
    {
      title: `${fullName} - ${lead.company_name || 'Prospect'}`,
      person_id: personId,
      note: noteParts.join('\n') || undefined,
    },
    { params: { api_token: apiKey }, timeout: 10000 }
  );

  return { contactId: String(personId) };
}

// Public entry point. Never throws - lead capture (the HTTP response to the
// visitor submitting the form) must succeed regardless of whether the CRM
// push works, so this always resolves and just records the outcome on the
// crm_leads row itself.
//
// "Not configured" is a distinct, deliberately-quiet case from a genuine
// sync failure: CRM_API_KEY/CRM_BASE_URL simply haven't been set on this
// deploy (Pipedrive push is optional - leads are already fully usable via
// this app's own admin panel/crm_leads table without it). Every lead
// capture calls this once in real time, plus retryPendingCrmSyncs below
// re-attempts every still-pending/failed row every 30 minutes - with no
// config, that's every single lead, every 30 minutes, forever, each
// logged as an [error] and flipped to crm_sync_status='failed' (which
// reads as "something's broken and needs attention" when actually
// nothing is - it's just not turned on). Logs once per process instead of
// once per lead per sweep, and leaves the row 'pending' rather than
// 'failed' so it picks back up on its own, with no manual re-triggering
// needed, whenever CRM_API_KEY/CRM_BASE_URL do get set.
let loggedNotConfiguredOnce = false;
function isCrmConfigured(): boolean {
  const configured = !!(process.env.CRM_API_KEY && process.env.CRM_BASE_URL);
  if (!configured && !loggedNotConfiguredOnce) {
    loggedNotConfiguredOnce = true;
    logger.warn('[CRM] CRM_API_KEY / CRM_BASE_URL not set - Pipedrive sync is disabled (leads still save normally and are visible in the admin panel). Set both to enable it; this message only logs once per process.');
  }
  return configured;
}

export const syncLeadToCrm = async (leadId: string): Promise<void> => {
  const system = (process.env.CRM_SYSTEM || 'pipedrive').toLowerCase();
  if (system === 'pipedrive' && !isCrmConfigured()) return;

  try {
    const result = await db.query(
      `SELECT l.*, o.title AS opportunity_title FROM crm_leads l
       LEFT JOIN opportunities o ON o.id = l.opportunity_id WHERE l.id = $1`,
      [leadId]
    );
    if (result.rows.length === 0) {
      logger.warn(`[CRM] Lead ${leadId} not found for sync`);
      return;
    }
    const lead: LeadRow = result.rows[0];

    if (system !== 'pipedrive') {
      logger.warn(`[CRM] CRM_SYSTEM=${system} has no adapter implemented yet (only 'pipedrive' is wired) - leaving lead ${leadId} as pending`);
      return;
    }

    const { contactId } = await syncToPipedrive(lead);

    await db.query(
      `UPDATE crm_leads SET crm_system = $1, crm_contact_id = $2, crm_sync_status = 'synced', crm_last_sync = NOW()
       WHERE id = $3`,
      [system, contactId, leadId]
    );
    logger.info(`[CRM] Lead ${leadId} synced to ${system} as contact ${contactId}`);
  } catch (err: any) {
    // Was passing err.message (a plain string) as the second arg here -
    // logger.ts's whole Error-sanitizing pipeline (toSafeMeta, see the
    // comment block at the top of that file) only kicks in for an actual
    // Error object; a bare string in that slot doesn't get merged into the
    // logged output the same way, so this line has been printing
    // "[CRM] Sync failed for lead <id>:" with nothing after it - exactly
    // the empty-looking log lines seen on Render. Every other catch block
    // in this codebase logs the raw `err`, not `err.message`; matching
    // that convention here is what actually gets the reason logged.
    logger.error(`[CRM] Sync failed for lead ${leadId}:`, err);
    try {
      await db.query(
        `UPDATE crm_leads SET crm_sync_status = 'failed', crm_last_sync = NOW() WHERE id = $1`,
        [leadId]
      );
    } catch (updateErr) {
      logger.error(`[CRM] Failed to record sync failure for lead ${leadId}:`, updateErr);
    }
  }
};

// Retries anything still 'pending' or 'failed' - covers leads captured while
// CRM_API_KEY wasn't configured yet, or a transient API outage. Safe to call
// repeatedly; each attempt just re-tries the same not-yet-synced rows.
export const retryPendingCrmSyncs = async (limit: number = 50): Promise<number> => {
  const system = (process.env.CRM_SYSTEM || 'pipedrive').toLowerCase();
  if (system === 'pipedrive' && !isCrmConfigured()) return 0;

  const result = await db.query(
    `SELECT id FROM crm_leads WHERE crm_sync_status IN ('pending', 'failed') ORDER BY crm_last_sync ASC NULLS FIRST, created_at ASC LIMIT $1`,
    [limit]
  );
  for (const row of result.rows) {
    await syncLeadToCrm(row.id);
  }
  return result.rows.length;
};
