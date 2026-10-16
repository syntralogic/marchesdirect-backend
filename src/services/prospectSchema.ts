// Part 6 - French company / artisan prospecting database.
// One row per establishment (SIRET), which is the natural dedup key: the same
// SIRET can never be inserted twice (UNIQUE + upsert). SIREN (legal unit) is
// indexed so all establishments of a company can be grouped.
//
// Every enrichable field has an entry in field_meta:
//   { "<field>": { "status": "confirmed" | "confirmed_missing" | "not_checked"
//                            | "unavailable" | "error",
//                  "source": "sirene" | "google_places" | "company_website" | ...,
//                  "at": ISO date, "note"?: string } }
// - confirmed          : value present, source gave it
// - confirmed_missing  : the source was queried successfully and has no such data
// - not_checked        : no source has been queried yet
// - unavailable        : no authorised source configured / provider needed
// - error              : source queried but failed (retry later)

export const PROSPECT_DDL: string[] = [
  `CREATE EXTENSION IF NOT EXISTS pg_trgm`,
  `CREATE EXTENSION IF NOT EXISTS unaccent`,
  `CREATE TABLE IF NOT EXISTS prospect_companies (
     id                     BIGSERIAL PRIMARY KEY,
     siret                  CHAR(14) NOT NULL UNIQUE CHECK (siret ~ '^[0-9]{14}$'),
     siren                  CHAR(9)  NOT NULL CHECK (siren ~ '^[0-9]{9}$'),
     is_head_office         BOOLEAN NOT NULL DEFAULT FALSE,
     company_name           TEXT NOT NULL,
     trading_name           TEXT,
     naf_code               TEXT,
     activity_label         TEXT,
     profession             TEXT NOT NULL DEFAULT 'autre',
     legal_form_code        TEXT,
     legal_form_label       TEXT,
     is_artisan             BOOLEAN,
     status                 TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed')),
     creation_date          DATE,
     closure_date           DATE,
     employee_range         TEXT,
     employee_range_code    TEXT,
     revenue_eur            NUMERIC(16,2),
     revenue_year           SMALLINT,
     net_result_eur         NUMERIC(16,2),
     address_line           TEXT,
     postal_code            TEXT,
     city                   TEXT,
     department             TEXT,
     region                 TEXT,
     latitude               DOUBLE PRECISION,
     longitude              DOUBLE PRECISION,
     directors              JSONB NOT NULL DEFAULT '[]'::jsonb,
     certifications         JSONB NOT NULL DEFAULT '[]'::jsonb,
     history                JSONB NOT NULL DEFAULT '[]'::jsonb,
     phone                  TEXT,
     email                  TEXT,
     website                TEXT,
     facebook_url           TEXT,
     instagram_url          TEXT,
     linkedin_url           TEXT,
     google_place_id        TEXT,
     google_maps_url        TEXT,
     google_rating          NUMERIC(2,1),
     google_review_count    INTEGER,
     google_positive_review_count INTEGER,
     google_positive_review_pct   NUMERIC(5,2),
     google_match_confidence NUMERIC(4,3),
     google_fetched_at      TIMESTAMPTZ,
     field_meta             JSONB NOT NULL DEFAULT '{}'::jsonb,
     source_updated_at      TIMESTAMPTZ,
     created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `CREATE INDEX IF NOT EXISTS ix_prospect_siren ON prospect_companies (siren)`,
  `CREATE INDEX IF NOT EXISTS ix_prospect_profession ON prospect_companies (profession)`,
  `CREATE INDEX IF NOT EXISTS ix_prospect_naf ON prospect_companies (naf_code)`,
  `CREATE INDEX IF NOT EXISTS ix_prospect_dept ON prospect_companies (department)`,
  `CREATE INDEX IF NOT EXISTS ix_prospect_region ON prospect_companies (region)`,
  `CREATE INDEX IF NOT EXISTS ix_prospect_postal ON prospect_companies (postal_code)`,
  `CREATE INDEX IF NOT EXISTS ix_prospect_city_lower ON prospect_companies (lower(city))`,
  `CREATE INDEX IF NOT EXISTS ix_prospect_name_trgm ON prospect_companies USING gin (company_name gin_trgm_ops)`,
  `CREATE INDEX IF NOT EXISTS ix_prospect_google_todo ON prospect_companies (google_fetched_at NULLS FIRST) WHERE status = 'active'`,
  `CREATE TABLE IF NOT EXISTS prospect_api_usage (
     provider   TEXT NOT NULL,
     day        DATE NOT NULL DEFAULT CURRENT_DATE,
     calls      INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (provider, day)
   )`,
  `CREATE TABLE IF NOT EXISTS prospect_import_runs (
     id          BIGSERIAL PRIMARY KEY,
     kind        TEXT NOT NULL,
     params      JSONB NOT NULL DEFAULT '{}'::jsonb,
     status      TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','success','partial','failed')),
     rows_read   INTEGER NOT NULL DEFAULT 0,
     rows_added  INTEGER NOT NULL DEFAULT 0,
     rows_updated INTEGER NOT NULL DEFAULT 0,
     message     TEXT,
     started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     finished_at TIMESTAMPTZ
   )`,
];
