import { Pool, QueryResult, PoolClient } from 'pg';
import dotenv from 'dotenv';
import path from 'path';
import { logger } from '../utils/logger';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

// Prefer a single DATABASE_URL (e.g. Supabase's "Session pooler" connection
// string) when present — simplest to configure on Render (one env var).
// Falls back to split DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME if not set.
// SSL defaults ON when using DATABASE_URL since Supabase's pooler requires it;
// set DB_SSL=false to explicitly disable (e.g. local Postgres with no SSL).
const connectionString = process.env.DATABASE_URL;

const pool = connectionString
  ? new Pool({
      connectionString,
      ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false },
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    })
  : new Pool({
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      host: process.env.DB_HOST,
      port: parseInt(process.env.DB_PORT || '5432'),
      database: process.env.DB_NAME,
      ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });

pool.on('error', (err) => {
  logger.error('Unexpected error on idle client', err);
});

pool.on('connect', () => {
  logger.debug('New database connection established');
});

export const db = {
  // Execute query
  async query(text: string, params?: any[]): Promise<QueryResult> {
    const start = Date.now();
    try {
      const result = await pool.query(text, params);
      const duration = Date.now() - start;
      if (duration > 1000) {
        logger.warn(`Slow query (${duration}ms): ${text.substring(0, 100)}`);
      }
      return result;
    } catch (err) {
      logger.error(`Query error: ${text}`, err);
      throw err;
    }
  },

  // Get connection from pool
  async getClient(): Promise<PoolClient> {
    return pool.connect();
  },

  // Transaction support
  async transaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  // Close pool
  async end(): Promise<void> {
    await pool.end();
    logger.info('Database connection pool closed');
  },
};

// Test connection on startup
export const testConnection = async (): Promise<boolean> => {
  try {
    await db.query('SELECT NOW()');
    logger.info('✅ Database connection successful');
    return true;
  } catch (err) {
    logger.error('❌ Database connection failed:', err);
    return false;
  }
};

// Auto-migration: if the schema hasn't been loaded yet (fresh database, e.g.
// a brand new Supabase project), run schema.sql automatically on boot so
// nobody has to run `psql -f schema.sql` by hand. Safe to call on every
// startup — it's a no-op once the schema already exists.
export const ensureSchema = async (): Promise<void> => {
  try {
    const check = await db.query(
      `SELECT EXISTS (
         SELECT FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'opportunities'
       ) AS exists`
    );
    if (check.rows[0]?.exists) {
      logger.info('✅ Schema already present, skipping auto-migration');
      // A backfill/migration mistake must never take the whole server down -
      // it did exactly that on 2026-08-25 (a plan_code backfill matched more
      // than one row and hit its own UNIQUE constraint, crashing boot). Log
      // and continue instead of throwing past this point.
      try {
        await applyIncrementalMigrations();
      } catch (migrationErr) {
        logger.error('⚠️ Incremental migration step failed — server will still start. Check manually.', migrationErr);
      }
      return;
    }

    logger.info('⏳ No schema detected — loading schema.sql automatically...');
    const fs = await import('fs');
    const schemaPath = path.resolve(process.cwd(), 'schema.sql');
    const schemaSql = fs.readFileSync(schemaPath, 'utf-8');
    await pool.query(schemaSql);
    logger.info('✅ Schema loaded successfully from schema.sql');
  } catch (err) {
    logger.error('❌ Auto-migration failed — schema may be partially applied. Check manually.', err);
    throw err;
  }
};

// Small, idempotent column/table additions for databases that already have
// the full schema from before a given change was made. Each statement uses
// IF NOT EXISTS so this is safe to run on every boot alongside ensureSchema's
// early-return path above. Add new lines here (never edit old ones) when
// schema.sql gains a field that already-provisioned databases won't pick up
// automatically.
// BUG (found 2026-09-05): applyIncrementalMigrations() below used to run its
// ~50 statements as bare sequential `await pool.query(...)` calls with only
// ONE try/catch around the whole function (see ensureSchema() above). If any
// single statement threw - a stray syntax issue, a constraint hit on some
// production DB's particular leftover state, anything - every statement
// after it silently never ran, with no per-statement error, no crash: just
// "Incremental migration step failed" and whichever later fixes (including,
// this time, the DECP/TED `active = true` UPDATE near the bottom) quietly
// never took effect. step() isolates each statement so one failure can't
// swallow the rest - this is the fix, not a workaround around it.
const step = async (sql: string): Promise<void> => {
  try {
    await pool.query(sql);
  } catch (err) {
    logger.error(`⚠️ Migration step failed (continuing with the rest): ${sql.trim().slice(0, 120).replace(/\s+/g, ' ')}`, err);
  }
};

const applyIncrementalMigrations = async (): Promise<void> => {
  await step(`ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS message TEXT`);

  // BUG (found live on Render, 2026-09-03): documentExpiry.ts's daily sweep
  // reads/writes expiry_reminder_sent on both company_documents and
  // company_certifications, but that column only ever existed in schema.sql
  // (which only runs against a fresh/empty database - see ensureSchema()
  // below) and was never added here in the incremental-migration path that
  // actually runs against an already-provisioned production database. Every
  // run failed with "column 'expiry_reminder_sent' does not exist" until
  // these two lines existed.
  await step(`ALTER TABLE company_documents ADD COLUMN IF NOT EXISTS expiry_reminder_sent BOOLEAN DEFAULT false`);
  await step(`ALTER TABLE company_certifications ADD COLUMN IF NOT EXISTS expiry_reminder_sent BOOLEAN DEFAULT false`);

  // "lead" gate (client's newest brief): phone + email captured after SIRET
  // recognition, before the full analysis breakdown - global per session,
  // same pattern as companyKnown. See POST /siret/lead + GET /siret/status.
  await step(`ALTER TABLE siret_lookups ADD COLUMN IF NOT EXISTS phone VARCHAR(20)`);
  await step(`ALTER TABLE siret_lookups ADD COLUMN IF NOT EXISTS email VARCHAR(255)`);
  await step(`ALTER TABLE siret_lookups ADD COLUMN IF NOT EXISTS lead_captured_at TIMESTAMP`);

  // Stable identifier for the 3 pricing tiers (decouverte/pro/entreprise) so
  // the frontend Tarifs page and the checkout endpoint can agree on which
  // row is which without guessing from price - a `code` never changes even
  // if a plan's price does, unlike matching on `price`.
  //
  // Each backfill below updates AT MOST ONE row (via the id = subquery),
  // never a whole price-range in one statement. The original version used
  // a bare `WHERE price > 0 AND price < 500` etc., which on a database that
  // had more than one legacy plan in that bracket (real production did -
  // leftover pre-launch rows) tried to set the same plan_code on multiple
  // rows in one UPDATE and hit the UNIQUE constraint - crashed boot on
  // 2026-08-25. If a bucket has more than one candidate now, this picks
  // the cheapest and leaves the rest uncoded rather than failing.
  await step(`ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS plan_code VARCHAR(50) UNIQUE`);
  await step(
    `UPDATE subscription_plans SET plan_code = 'decouverte'
     WHERE id = (SELECT id FROM subscription_plans WHERE plan_code IS NULL AND price = 0 ORDER BY id ASC LIMIT 1)
       AND NOT EXISTS (SELECT 1 FROM subscription_plans WHERE plan_code = 'decouverte')`
  );
  await step(
    `UPDATE subscription_plans SET plan_code = 'pro'
     WHERE id = (SELECT id FROM subscription_plans WHERE plan_code IS NULL AND price > 0 AND price < 500 ORDER BY price ASC, id ASC LIMIT 1)
       AND NOT EXISTS (SELECT 1 FROM subscription_plans WHERE plan_code = 'pro')`
  );
  await step(
    `UPDATE subscription_plans SET plan_code = 'entreprise'
     WHERE id = (SELECT id FROM subscription_plans WHERE plan_code IS NULL AND price >= 500 ORDER BY price ASC, id ASC LIMIT 1)
       AND NOT EXISTS (SELECT 1 FROM subscription_plans WHERE plan_code = 'entreprise')`
  );

  await step(`
    CREATE TABLE IF NOT EXISTS favorites (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      opportunity_id UUID NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(company_id, opportunity_id)
    )
  `);
  await step(`CREATE INDEX IF NOT EXISTS favorites_company ON favorites(company_id)`);
  await step(`CREATE INDEX IF NOT EXISTS favorites_opportunity ON favorites(opportunity_id)`);

  // Backfill trial_ends_at for companies that signed up before this column
  // was actually populated at registration time (see authService.ts) -
  // without this they're stuck showing a "trial" with no end date forever.
  // Approximate their trial window as 14 days from when they actually
  // registered (created_at), matching the real signup logic.
  await step(
    `UPDATE companies SET trial_ends_at = created_at + INTERVAL '14 days'
     WHERE subscription_status = 'trial' AND trial_ends_at IS NULL`
  );

  // Signup was failing in production with "No brands configured in system"
  // (registerCompanyAndUser does SELECT id FROM brands LIMIT 1 and throws if
  // empty). ensureSchema() only ever runs schema.sql's "INSERT INTO brands"
  // seed once, the very first time it sees no `opportunities` table at all -
  // if brands was ever emptied afterwards (or schema.sql ran partially) on an
  // already-provisioned database, it stays empty forever since ensureSchema
  // skips re-running schema.sql once `opportunities` exists. This runs on
  // every boot and is a no-op once at least one brand exists.
  await step(`
    INSERT INTO brands (code, name, domain)
    SELECT * FROM (VALUES
      ('brand_1', 'BOAMP Pro', 'boamp-pro.fr'),
      ('brand_2', 'Marchés Locaux', 'marches-locaux.fr')
    ) AS defaults(code, name, domain)
    WHERE NOT EXISTS (SELECT 1 FROM brands)
  `);

  // DCE document ingestion (attachment download/parsing) - see schema.sql's
  // tender_documents comment for why this is keyed on opportunity_id.
  await step(
    `ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS dce_documents_status VARCHAR(50) DEFAULT 'pending'`
  );
  await step(`
    CREATE TABLE IF NOT EXISTS tender_documents (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      opportunity_id UUID NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
      document_label VARCHAR(100),
      source_url TEXT NOT NULL,
      file_url TEXT,
      file_hash VARCHAR(64),
      mime_type VARCHAR(100),
      file_size_bytes INTEGER,
      status VARCHAR(50) NOT NULL DEFAULT 'pending',
      extracted_text TEXT,
      error_message TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(opportunity_id, source_url)
    )
  `);
  await step(`CREATE INDEX IF NOT EXISTS tender_documents_opportunity ON tender_documents(opportunity_id)`);
  await step(`CREATE INDEX IF NOT EXISTS tender_documents_status ON tender_documents(status)`);
  // Existing rows predate this feature entirely (no ingestion has ever run for
  // them) - mark them 'pending' explicitly rather than leaving old rows NULL,
  // so the ingestion job's WHERE clause (see jobs/documentIngestion.ts) picks
  // them up on its next pass instead of silently skipping every pre-existing
  // opportunity forever.
  await step(
    `UPDATE opportunities SET dce_documents_status = 'pending' WHERE dce_documents_status IS NULL`
  );
  await step(`ALTER TABLE tenders ADD COLUMN IF NOT EXISTS source_completeness VARCHAR(50)`);

  // Reusable company pricing catalog (Milestone 9.2) - see schema.sql comment.
  await step(`
    CREATE TABLE IF NOT EXISTS company_pricing_items (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      label VARCHAR(255) NOT NULL,
      category VARCHAR(100),
      unit VARCHAR(50),
      default_unit_price DECIMAL(12, 2),
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await step(`CREATE INDEX IF NOT EXISTS company_pricing_items_company ON company_pricing_items(company_id)`);
  await step(`ALTER TABLE bid_responses ADD COLUMN IF NOT EXISTS pricing_schedule_source VARCHAR(50)`);

  // Notification preferences (Profile > Notifications tab) - previously
  // UI-only local state with nowhere to persist to, so every toggle reset on
  // reload. Defaults match what the frontend already showed.
  await step(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS notification_preferences JSONB
    DEFAULT '{"emailAlerts": true, "newOpps": true, "deadlineAlerts": true, "weeklyDigest": false, "mobileNotifs": true}'::jsonb
  `);
  await step(`
    UPDATE users SET notification_preferences =
      '{"emailAlerts": true, "newOpps": true, "deadlineAlerts": true, "weeklyDigest": false, "mobileNotifs": true}'::jsonb
    WHERE notification_preferences IS NULL
  `);
  await step(`ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url VARCHAR(500)`);

  // Buyer/requesting-company name (BOAMP's `nomacheteur` etc.) - previously
  // not stored at all, so the opportunity detail page and the sous-traitance
  // "mise en relation" flow had no real organization name to show and fell
  // back to placeholder/mock data. See dataCollectionService.ts for where
  // this gets populated on ingest.
  await step(`ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS buyer_name VARCHAR(500)`);

  // Client reported long BOAMP buyer names / titles getting cut off (source
  // data can exceed 500 chars). Widening a VARCHAR is a metadata-only change
  // in Postgres - no table rewrite, no data loss - so this is safe/cheap to
  // re-run on every boot.
  //
  // BUG #1 (found live on Render, 2026-09-03, first fix attempt): the view's
  // rule depends on both buyer_name and title, so Postgres refuses ALTER
  // COLUMN TYPE on either while the view exists ("cannot alter type of a
  // column used by a view or rule"). Fixed by dropping the view first.
  //
  // BUG #2 (found live on Render, 2026-09-03, immediately after deploying
  // the fix for BUG #1): title is ALSO referenced by a GENERATED column,
  // opportunities.search_vector ("cannot alter type of a column used by a
  // generated column" - a separate Postgres restriction from the view one
  // above). That exception was thrown *after* the view had already been
  // dropped, and since a thrown error aborts the rest of this async
  // function, the CREATE MATERIALIZED VIEW further down never ran either -
  // opportunity_search_index was left *missing entirely* on production
  // (confirmed by the next boot's "relation ... does not exist" errors),
  // which is what GET /api/opportunities reads from - hence tenders/
  // opportunities showing no data on the frontend.
  //
  // Fixed properly this time: everything below (dropping the view, dropping
  // + re-adding the generated column + its index around the title ALTER,
  // and recreating the view) runs inside one explicit transaction. Postgres
  // supports transactional DDL, so if any statement fails the whole thing
  // rolls back - the view can never again be left dropped-but-not-recreated
  // by a mid-migration exception. The `view_missing` check also means this
  // block self-heals the *current* broken production state (view already
  // gone) even once buyer_name/title report as already wide enough.
  try {
    const state = await pool.query(
      `SELECT
         COALESCE((SELECT character_maximum_length FROM information_schema.columns
           WHERE table_name = 'opportunities' AND column_name = 'buyer_name'), 0) < 1000 AS buyer_name_narrow,
         COALESCE((SELECT character_maximum_length FROM information_schema.columns
           WHERE table_name = 'opportunities' AND column_name = 'title'), 0) < 1000 AS title_narrow,
         (to_regclass('opportunity_search_index') IS NULL) AS view_missing`
    );
    const { buyer_name_narrow, title_narrow, view_missing } = state.rows[0] || {};

    if (buyer_name_narrow || title_narrow || view_missing) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        await client.query(`DROP MATERIALIZED VIEW IF EXISTS opportunity_search_index`);

        if (title_narrow) {
          // search_vector (GENERATED ALWAYS AS ... STORED) must be dropped
          // before title can be widened, then recreated identically after.
          await client.query(`DROP INDEX IF EXISTS opportunities_search`);
          await client.query(`ALTER TABLE opportunities DROP COLUMN IF EXISTS search_vector`);
        }

        if (buyer_name_narrow) {
          await client.query(`ALTER TABLE opportunities ALTER COLUMN buyer_name TYPE VARCHAR(1000)`);
        }

        if (title_narrow) {
          await client.query(`ALTER TABLE opportunities ALTER COLUMN title TYPE VARCHAR(1000)`);
          await client.query(`
            ALTER TABLE opportunities ADD COLUMN search_vector tsvector GENERATED ALWAYS AS (
              to_tsvector('french', COALESCE(title, '') || ' ' || COALESCE(description, ''))
            ) STORED
          `);
          await client.query(`CREATE INDEX opportunities_search ON opportunities USING GIN(search_vector)`);
        }

        // opportunity_search_index is a MATERIALIZED VIEW, so it always has to
        // be dropped+recreated (never ALTERed) for a column change on the
        // underlying table to show up in it. Recreated here, inside the same
        // transaction as the drop above, so it's never left missing.
        await client.query(`
          CREATE MATERIALIZED VIEW opportunity_search_index AS
          SELECT 
            o.id,
            o.title,
            o.description,
            o.deadline,
            o.publication_date,
            o.estimated_value,
            o.currency,
            o.location_city,
            o.location_region,
            o.location_department,
            o.estimated_start_date,
            o.estimated_end_date,
            o.ai_classification_status,
            o.ai_summary,
            o.ai_matched_trades,
            o.status,
            o.trade_id,
            o.buyer_name,
            ot.code as opportunity_type,
            t.name as trade_name,
            c.code as brand_code,
            ds.code as source_code,
            (
              to_tsvector('french', COALESCE(o.title, '')) ||
              to_tsvector('french', COALESCE(o.description, ''))
            ) as search_vector
          FROM opportunities o
          LEFT JOIN opportunity_types ot ON o.opportunity_type_id = ot.id
          LEFT JOIN trades t ON o.trade_id = t.id
          LEFT JOIN data_sources ds ON o.source_id = ds.id
          LEFT JOIN brands c ON ot.brand_id = c.id
          WHERE o.deleted_at IS NULL AND o.status NOT IN ('cancelled', 'expired', 'merged')
        `);
        await client.query(`CREATE INDEX opportunity_search_index_search ON opportunity_search_index USING GIN(search_vector)`);
        await client.query(`CREATE INDEX opportunity_search_index_deadline ON opportunity_search_index(deadline)`);
        await client.query(`CREATE UNIQUE INDEX opportunity_search_index_id ON opportunity_search_index(id)`);

        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    }
  } catch (err) {
    // Same step() reasoning as everywhere else in this function: this
    // transaction used to `throw` straight out of applyIncrementalMigrations()
    // on failure, which - since nothing here was wrapped per-statement before
    // this fix - silently skipped every remaining statement after it,
    // including the data_sources activation UPDATE much further down. Log
    // and move on instead; the view/column-width fix just retries next boot.
    logger.error('⚠️ Migration step failed (continuing with the rest): opportunity_search_index rebuild', err);
  }

  // Opportunity detail page graduated access (level1 teaser -> level2 after
  // lead capture -> level3 after a chargé d'affaires manually validates) +
  // self-published subcontracting needs ("Je cherche un sous-traitant").
  // See schema.sql's "12b" comment block for the full access-level model.
  await step(`ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS opportunity_id UUID REFERENCES opportunities(id) ON DELETE SET NULL`);
  await step(`ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS access_level VARCHAR(20)`);
  await step(`ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS access_granted_at TIMESTAMP`);
  await step(`ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS access_granted_by UUID REFERENCES users(id)`);
  await step(`CREATE INDEX IF NOT EXISTS crm_leads_opportunity ON crm_leads(opportunity_id)`);

  await step(`
    CREATE TABLE IF NOT EXISTS subcontract_needs (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      company_id UUID REFERENCES companies(id) ON DELETE SET NULL,
      created_by UUID REFERENCES users(id),
      trade VARCHAR(255) NOT NULL,
      lot VARCHAR(255),
      description TEXT,
      location_city VARCHAR(255),
      location_region VARCHAR(255),
      budget_min DECIMAL(15, 2),
      budget_max DECIMAL(15, 2),
      team_size VARCHAR(100),
      start_date DATE,
      duration VARCHAR(100),
      qualifications TEXT,
      contact_email VARCHAR(255),
      contact_phone VARCHAR(20),
      status VARCHAR(50) DEFAULT 'draft',
      validity_days INTEGER DEFAULT 42,
      published_at TIMESTAMP,
      expires_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await step(`CREATE INDEX IF NOT EXISTS subcontract_needs_company ON subcontract_needs(company_id)`);
  await step(`CREATE INDEX IF NOT EXISTS subcontract_needs_status ON subcontract_needs(status)`);
  await step(`CREATE INDEX IF NOT EXISTS subcontract_needs_expires ON subcontract_needs(expires_at)`);

  // Anonymous visitor journey tracking: lets a "chargé d'affaires" calling a
  // lead back see what that person actually searched for and looked at
  // (searches, opportunity fiches, SEO landing pages) instead of having to
  // ask "what were you looking for again?" from scratch. session_id is a
  // client-generated id persisted in localStorage - matched to a lead once
  // that visitor submits any contact form.
  await step(`
    CREATE TABLE IF NOT EXISTS visitor_events (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      session_id VARCHAR(100) NOT NULL,
      brand_id UUID REFERENCES brands(id),
      event_type VARCHAR(50) NOT NULL,   -- 'search', 'view_opportunity', 'view_seo_page'
      event_label VARCHAR(500),          -- human-readable summary shown to staff
      event_data JSONB,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await step(`CREATE INDEX IF NOT EXISTS visitor_events_session ON visitor_events(session_id)`);
  await step(`CREATE INDEX IF NOT EXISTS visitor_events_created ON visitor_events(created_at)`);
  await step(`ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS session_id VARCHAR(100)`);
  await step(`CREATE INDEX IF NOT EXISTS crm_leads_session ON crm_leads(session_id)`);

  // Prototype V17 rule: on a private tender / sous-traitance fiche, only the
  // buyer's identity is ever locked (everything else - amount, tasks,
  // deadline, score - is open like a public-market fiche). That identity
  // unlocks ONLY when the visitor books a specific callback slot, never on
  // "call me back, no particular time" and never on merely leaving an
  // email. appointment_mode distinguishes the two; appointment_slot_at is
  // only set for the 'slot' case.
  await step(`ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS appointment_mode VARCHAR(20)`);
  await step(`ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS appointment_slot_at TIMESTAMP`);

  // Prototype V17 rule: `companyKnown` is a single global flag per browser
  // session, not per-opportunity - once a visitor identifies their company
  // via SIRET on any fiche, they're recognized everywhere without
  // re-entering it, and the compatibility score never displays anywhere
  // until this exists. Session-scoped (not user-scoped) because this
  // happens before an account exists.
  await step(`
    CREATE TABLE IF NOT EXISTS siret_lookups (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      session_id VARCHAR(100) NOT NULL UNIQUE,
      siret VARCHAR(14) NOT NULL,
      company_data JSONB NOT NULL,   -- name, legal, created, capital, address, city, postal,
                                      -- director, employees, ape, activity + detected online
                                      -- presence (website/facebook/google) once that lookup exists
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await step(`CREATE INDEX IF NOT EXISTS siret_lookups_session ON siret_lookups(session_id)`);

  // Client's explicit priority (WhatsApp): integrate the public tender
  // databases as real content before finalizing UX, because testing against
  // ~50 rows doesn't reflect real usage - and later (WhatsApp, "1 lakh
  // plus"), that the total needs to reach 100,000+ opportunities. BOAMP
  // alone realistically tops out in the low thousands at a time; DECP
  // (aggregates BOAMP + every profil acheteur + PLACE, consolidated as a
  // single file) is the intended lever for six-figure volume - see
  // dataCollectionService.ts's DECP connector header for the full sourcing
  // rationale and DECP_MAX_RECORDS_PER_RUN for why its cap is much higher
  // than BOAMP's. TED (EU-wide, free RSS feed, no API key needed) adds a
  // smaller but free additional stream. Forcing all three `active` here
  // (idempotent - safe to run on every boot) rather than only in schema.sql,
  // since that file doesn't re-run against an already-provisioned database.
  //
  // Caveat carried over honestly: this sandbox cannot reach data.gouv.fr to
  // live-test DECP's 234MB Parquet download/parse against Render's actual
  // memory/time limits before this deploys - watch the first `decp` row in
  // connector_logs after this ships. PLACE stays inactive: its connector
  // needs a real PLACE_API_KEY from the client (a government platform
  // credential, not something that can be fabricated here).
  // BOAMP's deadline-filter bug (see the dataCollectionService.ts commit
  // right before this one) is already fixed.

  // Reverted (Sep 2026): the two lines that used to be here auto-disabled
  // boamp and auto-seeded ~75 demo opportunities on every single boot. That
  // was a deliberate temporary measure for one testing session and was
  // never meant to stay - but because this file runs unattended on every
  // Render deploy (free tier, no shell), it kept silently re-disabling
  // boamp and re-seeding demo rows after every redeploy even once real
  // BOAMP data collection was wanted again. Removed for good; see the
  // one-time cleanup below for undoing what those lines already left in
  // production databases.
  await removeDemoSeedData();

  // Same no-shell-on-Render reasoning: force these back to active in code
  // rather than relying on someone running `psql ... UPDATE data_sources`
  // by hand. Harmless no-op once already true.
  // Confirmed live on production (Supabase SQL editor, 2026-09-05): the
  // 'decp' row didn't exist in data_sources at all - only boamp/ted/place
  // did. schema.sql's INSERT for 'decp' only ever runs on a brand-new empty
  // database (see ensureSchema()'s fresh-load branch); an already-provisioned
  // DB like this one never got it, so the plain UPDATE below was a no-op for
  // decp every single boot - nothing to update. INSERT ... ON CONFLICT
  // creates the row if missing (matching schema.sql's seed values) and
  // activates it either way, for both this and any other already-provisioned
  // database missing the same row. 'ted' already existed here (confirmed
  // active=true), so the plain UPDATE for it was fine - kept as-is below.
  await step(`
    INSERT INTO data_sources (code, name, feed_type, frequency_hours, active)
    VALUES ('decp', 'DECP Consolidées (data.economie.gouv.fr) - per-buyer files consolidated by decp-processing/decp.info, live since Jan 2024', 'api', 24, true)
    ON CONFLICT (code) DO UPDATE SET active = true
  `);
  await step(`UPDATE data_sources SET active = true WHERE code IN ('boamp', 'ted')`);

  // Client's dix images (écran 10, "Documents de candidature"): DC1/DC2/DUME
  // each get their own "Générer" button and status, same as the existing
  // engagement_act_text pattern - a real template fill from the company's
  // own profile data, not an AI-authored document. Text stays NULL until
  // actually generated once (see POST /tenders/bid/:bidId/generate-forms).
  await step(`ALTER TABLE bid_responses ADD COLUMN IF NOT EXISTS dc1_text TEXT`);
  await step(`ALTER TABLE bid_responses ADD COLUMN IF NOT EXISTS dc2_text TEXT`);
  await step(`ALTER TABLE bid_responses ADD COLUMN IF NOT EXISTS dume_text TEXT`);

  // Client's dix images (écrans 12-15, "chargé d'affaires"): a rendez-vous
  // tied to a specific bid, distinct from the generic pre-identification
  // sales callback on the opportunity page (opportunities.access_requests).
  // Mirrors that table's mode/slot shape so the two stay easy to reason
  // about together, but scoped to bid_id since this is a post-payment,
  // per-candidature appointment, not a per-opportunity lead.
  await step(`
    CREATE TABLE IF NOT EXISTS bid_appointments (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      bid_id UUID NOT NULL REFERENCES bid_responses(id) ON DELETE CASCADE,
      company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      mode VARCHAR(20) NOT NULL, -- 'slot' or 'callback'
      slot_label VARCHAR(100),
      status VARCHAR(20) NOT NULL DEFAULT 'requested', -- 'requested', 'confirmed', 'done', 'cancelled'
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await step(`CREATE INDEX IF NOT EXISTS bid_appointments_bid ON bid_appointments(bid_id)`);
};

// One-time (but safe-to-repeat) cleanup of the demo data the old
// seedDemoOpportunities() call above used to insert on every boot - deletes
// the demo_seed source's opportunities plus the source row itself. Does
// NOT touch the separate, manually-run scripts/seed.js demo rows
// (source_reference LIKE 'DEMO-%' under the real 'boamp' source id) -
// those were an intentional one-off for browsing the app pre-launch and
// aren't inserted automatically, so removing them is a separate decision.
async function removeDemoSeedData(): Promise<void> {
  const source = await pool.query(`SELECT id FROM data_sources WHERE code = 'demo_seed'`);
  if (source.rows.length === 0) return; // nothing to clean up

  const sourceId = source.rows[0].id;
  const deleted = await pool.query(`DELETE FROM opportunities WHERE source_id = $1`, [sourceId]);
  await pool.query(`DELETE FROM data_sources WHERE id = $1`, [sourceId]);

  if (deleted.rowCount && deleted.rowCount > 0) {
    logger.info(`🧹 Removed ${deleted.rowCount} auto-seeded demo opportunities and the demo_seed source`);
  }
}

