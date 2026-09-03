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
const applyIncrementalMigrations = async (): Promise<void> => {
  await pool.query(`ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS message TEXT`);

  // "lead" gate (client's newest brief): phone + email captured after SIRET
  // recognition, before the full analysis breakdown - global per session,
  // same pattern as companyKnown. See POST /siret/lead + GET /siret/status.
  await pool.query(`ALTER TABLE siret_lookups ADD COLUMN IF NOT EXISTS phone VARCHAR(20)`);
  await pool.query(`ALTER TABLE siret_lookups ADD COLUMN IF NOT EXISTS email VARCHAR(255)`);
  await pool.query(`ALTER TABLE siret_lookups ADD COLUMN IF NOT EXISTS lead_captured_at TIMESTAMP`);

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
  await pool.query(`ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS plan_code VARCHAR(50) UNIQUE`);
  await pool.query(
    `UPDATE subscription_plans SET plan_code = 'decouverte'
     WHERE id = (SELECT id FROM subscription_plans WHERE plan_code IS NULL AND price = 0 ORDER BY id ASC LIMIT 1)
       AND NOT EXISTS (SELECT 1 FROM subscription_plans WHERE plan_code = 'decouverte')`
  );
  await pool.query(
    `UPDATE subscription_plans SET plan_code = 'pro'
     WHERE id = (SELECT id FROM subscription_plans WHERE plan_code IS NULL AND price > 0 AND price < 500 ORDER BY price ASC, id ASC LIMIT 1)
       AND NOT EXISTS (SELECT 1 FROM subscription_plans WHERE plan_code = 'pro')`
  );
  await pool.query(
    `UPDATE subscription_plans SET plan_code = 'entreprise'
     WHERE id = (SELECT id FROM subscription_plans WHERE plan_code IS NULL AND price >= 500 ORDER BY price ASC, id ASC LIMIT 1)
       AND NOT EXISTS (SELECT 1 FROM subscription_plans WHERE plan_code = 'entreprise')`
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS favorites (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      opportunity_id UUID NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(company_id, opportunity_id)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS favorites_company ON favorites(company_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS favorites_opportunity ON favorites(opportunity_id)`);

  // Backfill trial_ends_at for companies that signed up before this column
  // was actually populated at registration time (see authService.ts) -
  // without this they're stuck showing a "trial" with no end date forever.
  // Approximate their trial window as 14 days from when they actually
  // registered (created_at), matching the real signup logic.
  await pool.query(
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
  await pool.query(`
    INSERT INTO brands (code, name, domain)
    SELECT * FROM (VALUES
      ('brand_1', 'BOAMP Pro', 'boamp-pro.fr'),
      ('brand_2', 'Marchés Locaux', 'marches-locaux.fr')
    ) AS defaults(code, name, domain)
    WHERE NOT EXISTS (SELECT 1 FROM brands)
  `);

  // DCE document ingestion (attachment download/parsing) - see schema.sql's
  // tender_documents comment for why this is keyed on opportunity_id.
  await pool.query(
    `ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS dce_documents_status VARCHAR(50) DEFAULT 'pending'`
  );
  await pool.query(`
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
  await pool.query(`CREATE INDEX IF NOT EXISTS tender_documents_opportunity ON tender_documents(opportunity_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS tender_documents_status ON tender_documents(status)`);
  // Existing rows predate this feature entirely (no ingestion has ever run for
  // them) - mark them 'pending' explicitly rather than leaving old rows NULL,
  // so the ingestion job's WHERE clause (see jobs/documentIngestion.ts) picks
  // them up on its next pass instead of silently skipping every pre-existing
  // opportunity forever.
  await pool.query(
    `UPDATE opportunities SET dce_documents_status = 'pending' WHERE dce_documents_status IS NULL`
  );
  await pool.query(`ALTER TABLE tenders ADD COLUMN IF NOT EXISTS source_completeness VARCHAR(50)`);

  // Reusable company pricing catalog (Milestone 9.2) - see schema.sql comment.
  await pool.query(`
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
  await pool.query(`CREATE INDEX IF NOT EXISTS company_pricing_items_company ON company_pricing_items(company_id)`);
  await pool.query(`ALTER TABLE bid_responses ADD COLUMN IF NOT EXISTS pricing_schedule_source VARCHAR(50)`);

  // Notification preferences (Profile > Notifications tab) - previously
  // UI-only local state with nowhere to persist to, so every toggle reset on
  // reload. Defaults match what the frontend already showed.
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS notification_preferences JSONB
    DEFAULT '{"emailAlerts": true, "newOpps": true, "deadlineAlerts": true, "weeklyDigest": false, "mobileNotifs": true}'::jsonb
  `);
  await pool.query(`
    UPDATE users SET notification_preferences =
      '{"emailAlerts": true, "newOpps": true, "deadlineAlerts": true, "weeklyDigest": false, "mobileNotifs": true}'::jsonb
    WHERE notification_preferences IS NULL
  `);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url VARCHAR(500)`);

  // Buyer/requesting-company name (BOAMP's `nomacheteur` etc.) - previously
  // not stored at all, so the opportunity detail page and the sous-traitance
  // "mise en relation" flow had no real organization name to show and fell
  // back to placeholder/mock data. See dataCollectionService.ts for where
  // this gets populated on ingest.
  await pool.query(`ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS buyer_name VARCHAR(500)`);

  // Client reported long BOAMP buyer names / titles getting cut off (source
  // data can exceed 500 chars). Widening a VARCHAR is a metadata-only change
  // in Postgres - no table rewrite, no data loss - so this is safe/cheap to
  // re-run on every boot.
  await pool.query(`ALTER TABLE opportunities ALTER COLUMN buyer_name TYPE VARCHAR(1000)`);
  await pool.query(`ALTER TABLE opportunities ALTER COLUMN title TYPE VARCHAR(1000)`);

  // opportunity_search_index is a MATERIALIZED VIEW, so a plain ALTER can't
  // add a column to it (or widen a column already in it) the way it can for
  // a table - the view has to be dropped and recreated. Only do that when
  // actually needed (checked via information_schema) so a normal boot
  // doesn't pay for a full view rebuild every time.
  const viewNeedsRebuild = await pool.query(
    `SELECT
       NOT EXISTS (
         SELECT FROM information_schema.columns
         WHERE table_name = 'opportunity_search_index' AND column_name = 'buyer_name'
       ) AS missing_buyer_name,
       COALESCE((
         SELECT character_maximum_length FROM information_schema.columns
         WHERE table_name = 'opportunity_search_index' AND column_name = 'title'
       ), 0) < 1000 AS title_too_narrow`
  );
  if (viewNeedsRebuild.rows[0]?.missing_buyer_name || viewNeedsRebuild.rows[0]?.title_too_narrow) {
    await pool.query(`DROP MATERIALIZED VIEW IF EXISTS opportunity_search_index`);
    await pool.query(`
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
    await pool.query(`CREATE INDEX opportunity_search_index_search ON opportunity_search_index USING GIN(search_vector)`);
    await pool.query(`CREATE INDEX opportunity_search_index_deadline ON opportunity_search_index(deadline)`);
    await pool.query(`CREATE UNIQUE INDEX opportunity_search_index_id ON opportunity_search_index(id)`);
  }

  // Opportunity detail page graduated access (level1 teaser -> level2 after
  // lead capture -> level3 after a chargé d'affaires manually validates) +
  // self-published subcontracting needs ("Je cherche un sous-traitant").
  // See schema.sql's "12b" comment block for the full access-level model.
  await pool.query(`ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS opportunity_id UUID REFERENCES opportunities(id) ON DELETE SET NULL`);
  await pool.query(`ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS access_level VARCHAR(20)`);
  await pool.query(`ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS access_granted_at TIMESTAMP`);
  await pool.query(`ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS access_granted_by UUID REFERENCES users(id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS crm_leads_opportunity ON crm_leads(opportunity_id)`);

  await pool.query(`
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
  await pool.query(`CREATE INDEX IF NOT EXISTS subcontract_needs_company ON subcontract_needs(company_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS subcontract_needs_status ON subcontract_needs(status)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS subcontract_needs_expires ON subcontract_needs(expires_at)`);

  // Anonymous visitor journey tracking: lets a "chargé d'affaires" calling a
  // lead back see what that person actually searched for and looked at
  // (searches, opportunity fiches, SEO landing pages) instead of having to
  // ask "what were you looking for again?" from scratch. session_id is a
  // client-generated id persisted in localStorage - matched to a lead once
  // that visitor submits any contact form.
  await pool.query(`
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
  await pool.query(`CREATE INDEX IF NOT EXISTS visitor_events_session ON visitor_events(session_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS visitor_events_created ON visitor_events(created_at)`);
  await pool.query(`ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS session_id VARCHAR(100)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS crm_leads_session ON crm_leads(session_id)`);

  // Prototype V17 rule: on a private tender / sous-traitance fiche, only the
  // buyer's identity is ever locked (everything else - amount, tasks,
  // deadline, score - is open like a public-market fiche). That identity
  // unlocks ONLY when the visitor books a specific callback slot, never on
  // "call me back, no particular time" and never on merely leaving an
  // email. appointment_mode distinguishes the two; appointment_slot_at is
  // only set for the 'slot' case.
  await pool.query(`ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS appointment_mode VARCHAR(20)`);
  await pool.query(`ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS appointment_slot_at TIMESTAMP`);

  // Prototype V17 rule: `companyKnown` is a single global flag per browser
  // session, not per-opportunity - once a visitor identifies their company
  // via SIRET on any fiche, they're recognized everywhere without
  // re-entering it, and the compatibility score never displays anywhere
  // until this exists. Session-scoped (not user-scoped) because this
  // happens before an account exists.
  await pool.query(`
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
  await pool.query(`CREATE INDEX IF NOT EXISTS siret_lookups_session ON siret_lookups(session_id)`);

  // Client's explicit priority (WhatsApp): integrate the two public tender
  // databases (BOAMP + DECP) as real content before finalizing UX, because
  // testing against ~50 rows doesn't reflect real usage. BOAMP is already
  // active by default in schema.sql's seed, but 'decp' was only ever seeded
  // with active=false (schema.sql line ~1181) - meaning even though
  // collectDecpData() is fully implemented and wired into the scheduler's
  // dispatch switch, it could never actually run. Flipping both here
  // (idempotent - safe to run on every boot) rather than only in schema.sql
  // since that file doesn't re-run against an already-provisioned database.
  // DECP reactivation from the earlier commit is being reverted here: further
  // research (web search, since this sandbox can't reach data.economie.gouv.fr
  // directly) found that decp-2022-marches-valides is a frozen/deprecated
  // dataset - "[DEPRECIE]... ne sera plus maintenu à compter du 16 novembre
  // 2023". Since Jan 2024, DECP publication moved to per-buyer files on
  // data.gouv.fr, consolidated into a single ~234MB Parquet/CSV file updated
  // daily (decp.info / github.com/ColinMaudry/decp-processing) - there's no
  // small, query-able records API for it anymore, so collectDecpData() as
  // currently written can only ever return near-nothing from a filter like
  // "published in the last N days" against data that stopped growing in
  // 2023. Rather than leave it silently running and producing ~0 useful
  // rows, deactivating again until a real fix (streaming-download +
  // parse the live consolidated file, likely as a one-off backfill script
  // rather than this connector's incremental-run shape) is built.
  // BOAMP alone is unaffected and does the real work for "several thousand
  // public-market listings" now that its deadline-filter bug (see the
  // dataCollectionService.ts commit right before this one) is fixed.

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

  // Same no-shell-on-Render reasoning: force boamp back to active in code
  // rather than relying on someone running `psql ... UPDATE data_sources`
  // by hand. Harmless no-op once it's already true.
  await pool.query(`UPDATE data_sources SET active = true WHERE code = 'boamp'`);
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

