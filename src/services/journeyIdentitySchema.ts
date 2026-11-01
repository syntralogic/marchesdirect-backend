// Additive migration. Existing raw events are never rewritten or reattributed.
export const JOURNEY_IDENTITY_DDL = [
  `ALTER TABLE visitor_events ADD COLUMN IF NOT EXISTS attribution_siret VARCHAR(14)`,
  `ALTER TABLE visitor_events ADD COLUMN IF NOT EXISTS tracking_version SMALLINT NOT NULL DEFAULT 0`,
  `CREATE INDEX IF NOT EXISTS visitor_events_attribution ON visitor_events(attribution_siret, created_at)`,
  `CREATE TABLE IF NOT EXISTS journey_company_selections (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), session_id VARCHAR(100) NOT NULL,
    siret VARCHAR(14) NOT NULL, selected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), company_data JSONB,
    UNIQUE(session_id,siret,selected_at))`,
  `CREATE INDEX IF NOT EXISTS journey_selections_time ON journey_company_selections(session_id,selected_at)`,
  `CREATE TABLE IF NOT EXISTS crm_company_sync_queue (
    siret VARCHAR(14) PRIMARY KEY, version BIGINT NOT NULL DEFAULT 1,
    processed_version BIGINT NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
  // Seed only evidence with an actual time/SIRET, not whole browser histories.
  `INSERT INTO journey_company_selections(session_id,siret,selected_at)
   SELECT session_id,siret,COALESCE(occurred_at,created_at) AT TIME ZONE 'UTC' FROM visitor_events
   WHERE event_type='company_selected' AND siret ~ '^[0-9]{14}$' ON CONFLICT DO NOTHING`,
  `INSERT INTO journey_company_selections(session_id,siret,selected_at,company_data)
   SELECT session_id,siret,created_at AT TIME ZONE 'UTC',company_data FROM siret_lookups
   WHERE siret ~ '^[0-9]{14}$' ON CONFLICT DO NOTHING`,
  `ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS siret VARCHAR(14)`,
  // Freeze the selected company at request creation, never at a later CRM retry.
  `CREATE OR REPLACE FUNCTION md_snapshot_lead_siret() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
     IF NEW.siret IS NULL AND NEW.session_id IS NOT NULL THEN
       SELECT siret INTO NEW.siret FROM siret_lookups WHERE session_id=NEW.session_id;
     END IF;
     RETURN NEW;
   END $$`,
  `DROP TRIGGER IF EXISTS md_lead_siret_snapshot ON crm_leads`,
  `CREATE TRIGGER md_lead_siret_snapshot BEFORE INSERT ON crm_leads FOR EACH ROW EXECUTE FUNCTION md_snapshot_lead_siret()`,
];
