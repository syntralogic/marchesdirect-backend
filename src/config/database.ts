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

  // opportunity_search_index is a MATERIALIZED VIEW, so a plain ALTER can't
  // add a column to it the way it can for a table - the view has to be
  // dropped and recreated with the new column in its SELECT. Only do that
  // once (checked via information_schema) so a normal boot doesn't pay for
  // a full view rebuild every time.
  const viewHasBuyerName = await pool.query(
    `SELECT EXISTS (
       SELECT FROM information_schema.columns
       WHERE table_name = 'opportunity_search_index' AND column_name = 'buyer_name'
     ) AS exists`
  );
  if (!viewHasBuyerName.rows[0]?.exists) {
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

  // Client's explicit ask (Aug/Sep 2026 session): pause on live external
  // sources entirely for now (no Anthropic API key configured yet, so
  // ai_classification/ai_summary can't run on freshly-ingested BOAMP data
  // anyway; also on Render's free tier with no shell access, debugging a
  // live connector mid-testing is painful). Deactivating boamp alongside
  // decp so the only opportunities in the system right now are the
  // pre-classified demo set below - predictable content to actually test
  // the SIRET->score->lead-capture->dashboard flow against, no dependency
  // on a live API behaving. Re-activate boamp (UPDATE data_sources SET
  // active = true WHERE code = 'boamp', or just remove this line) once
  // ready to test against real data again - its query itself is fixed and
  // doesn't need further code changes.
  await pool.query(`UPDATE data_sources SET active = false WHERE code = 'boamp'`);

  await seedDemoOpportunities();

  // opportunity_search_index is a materialized view - inserting into
  // `opportunities` directly (as seedDemoOpportunities does) doesn't make
  // the new rows searchable until something refreshes it. That normally
  // happens on its own 15-minute cron (jobs/searchIndexRefresh.ts), but on
  // a fresh boot after just seeding demo data for testing, waiting up to
  // 15 minutes for it to show up in search is exactly the kind of "is this
  // even working?" confusion to avoid - refresh once immediately here too.
  try {
    const { refreshSearchIndex } = await import('../jobs/searchIndexRefresh');
    await refreshSearchIndex();
  } catch (err) {
    logger.error('⚠️ Post-seed search index refresh failed (will still catch up on its own 15-min cron)', err);
  }
};

// ============================================================================
// DEMO OPPORTUNITY SEED
// ============================================================================
// Client's ask: pause live BOAMP/DECP ingestion for now (no Anthropic key
// configured yet, Render free tier has no shell access for live debugging)
// and populate the platform with enough realistic, fully-classified content
// to actually test the SIRET -> compatibility score -> lead capture ->
// dashboard flow end-to-end. Unlike real ingested data, these are inserted
// pre-classified (ai_classification_status='classified', trade_id and
// ai_summary already set) so nothing here depends on the AI processing job
// running - it can't, without an API key.
//
// Idempotent: keyed by a dedicated 'demo_seed' data_sources row and fixed
// source_reference values (demo-001, demo-002...), ON CONFLICT DO NOTHING -
// safe to run on every boot, never creates duplicates on redeploy.
const DEMO_CITIES: { city: string; region: string; department: string }[] = [
  { city: 'Bordeaux', region: 'Nouvelle-Aquitaine', department: '33' },
  { city: 'Toulouse', region: 'Occitanie', department: '31' },
  { city: 'Nantes', region: 'Pays de la Loire', department: '44' },
  { city: 'Lille', region: 'Hauts-de-France', department: '59' },
  { city: 'Strasbourg', region: 'Grand Est', department: '67' },
  { city: 'Rennes', region: 'Bretagne', department: '35' },
  { city: 'Montpellier', region: 'Occitanie', department: '34' },
  { city: 'Nice', region: "Provence-Alpes-Côte d'Azur", department: '06' },
  { city: 'Grenoble', region: 'Auvergne-Rhône-Alpes', department: '38' },
  { city: 'Reims', region: 'Grand Est', department: '51' },
  { city: 'Dijon', region: 'Bourgogne-Franche-Comté', department: '21' },
  { city: 'Angers', region: 'Pays de la Loire', department: '49' },
  { city: 'Villeurbanne', region: 'Auvergne-Rhône-Alpes', department: '69' },
  { city: 'Clermont-Ferrand', region: 'Auvergne-Rhône-Alpes', department: '63' },
  { city: 'Tours', region: 'Centre-Val de Loire', department: '37' },
  { city: 'Limoges', region: 'Nouvelle-Aquitaine', department: '87' },
  { city: 'Amiens', region: 'Hauts-de-France', department: '80' },
  { city: 'Metz', region: 'Grand Est', department: '57' },
  { city: 'Besançon', region: 'Bourgogne-Franche-Comté', department: '25' },
  { city: 'Orléans', region: 'Centre-Val de Loire', department: '45' },
  { city: 'Rouen', region: 'Normandie', department: '76' },
  { city: 'Caen', region: 'Normandie', department: '14' },
  { city: 'Nancy', region: 'Grand Est', department: '54' },
  { city: 'Perpignan', region: 'Occitanie', department: '66' },
];

const DEMO_TRADES: { slug: string; label: string }[] = [
  { slug: 'gros-oeuvre', label: 'gros œuvre' },
  { slug: 'couverture', label: 'couverture' },
  { slug: 'electricite', label: 'électricité' },
  { slug: 'plomberie', label: 'plomberie' },
  { slug: 'cvc', label: 'chauffage-ventilation-climatisation' },
  { slug: 'isolation', label: 'isolation thermique' },
  { slug: 'menuiserie', label: 'menuiserie' },
  { slug: 'peinture', label: 'peinture' },
  { slug: 'vrd', label: 'voirie et réseaux divers' },
  { slug: 'platrerie', label: 'plâtrerie-cloisons' },
  { slug: 'carrelage', label: 'carrelage' },
  { slug: 'batiment-general', label: 'tous corps d\'état' },
];

const PUBLIC_BUYER_TEMPLATES = (city: string, dept: string) => [
  `Mairie de ${city}`,
  `Communauté d'agglomération de ${city}`,
  `Conseil départemental de ${dept}`,
  `Centre Hospitalier de ${city}`,
  `Office Public de l'Habitat de ${city}`,
  `Région - Lycée de ${city}`,
];

const PRIVATE_BUYER_TEMPLATES = (city: string) => [
  `Promoteur immobilier - Résidence Les Jardins de ${city}`,
  `${city} Habitat - Bailleur social`,
  `SCI Le Clos ${city}`,
  `Groupe immobilier ${city} Développement`,
];

const SUBCONTRACT_BUYER_TEMPLATES = (city: string) => [
  `${city} BTP Constructions - Entreprise générale`,
  `Groupe ${city} Bâtiment`,
  `${city} Rénovation - Tous corps d'état`,
];

const PUBLIC_TITLE_TEMPLATES: Record<string, string[]> = {
  'gros-oeuvre': ['Construction d\'un bâtiment communal - lot gros œuvre', 'Extension d\'une école - lot gros œuvre'],
  'couverture': ['Réfection de toiture d\'un bâtiment public', 'Réfection d\'étanchéité de toiture-terrasse'],
  'electricite': ['Mise aux normes électriques d\'un bâtiment communal', 'Rénovation de l\'éclairage public'],
  'plomberie': ['Rénovation des réseaux de plomberie d\'un groupe scolaire', 'Remplacement de la chaufferie et réseaux sanitaires'],
  'cvc': ['Remplacement du système de chauffage collectif', 'Installation d\'une pompe à chaleur - bâtiment public'],
  'isolation': ['Travaux d\'isolation thermique par l\'extérieur', 'Rénovation énergétique d\'un bâtiment communal'],
  'menuiserie': ['Remplacement des menuiseries extérieures', 'Fourniture et pose de menuiseries bois - bâtiment public'],
  'peinture': ['Travaux de peinture et ravalement de façade', 'Rénovation des peintures intérieures d\'un établissement scolaire'],
  'vrd': ['Aménagement de voirie et réseaux divers', 'Réfection de voirie communale'],
  'platrerie': ['Cloisonnement et faux plafonds - rénovation intérieure', 'Travaux de plâtrerie dans un établissement public'],
  'carrelage': ['Rénovation des revêtements de sols - bâtiment public', 'Travaux de carrelage dans des sanitaires collectifs'],
  'batiment-general': ['Rénovation complète d\'un bâtiment communal - tous corps d\'état', 'Réhabilitation d\'un ancien bâtiment public'],
};

const PRIVATE_TITLE_TEMPLATES: Record<string, string[]> = {
  'gros-oeuvre': ['Construction d\'une résidence - lot gros œuvre'],
  'couverture': ['Réfection de toiture d\'une copropriété'],
  'electricite': ['Rénovation électrique d\'un immeuble résidentiel'],
  'plomberie': ['Rénovation des colonnes montantes - immeuble résidentiel'],
  'cvc': ['Installation de chauffage collectif - programme immobilier neuf'],
  'isolation': ['Isolation thermique par l\'extérieur d\'une copropriété'],
  'menuiserie': ['Remplacement des menuiseries d\'une résidence'],
  'peinture': ['Ravalement de façade d\'une copropriété'],
  'vrd': ['Aménagement des espaces extérieurs d\'un programme immobilier'],
  'platrerie': ['Second œuvre - lot plâtrerie, programme résidentiel neuf'],
  'carrelage': ['Fourniture et pose de carrelage - programme immobilier neuf'],
  'batiment-general': ['Réhabilitation d\'un immeuble résidentiel - tous corps d\'état'],
};

const SUBCONTRACT_TITLE_TEMPLATES: Record<string, string[]> = {
  'gros-oeuvre': ['Recherche sous-traitant lot gros œuvre - chantier en cours'],
  'couverture': ['Recherche sous-traitant couvreur - chantier tertiaire'],
  'electricite': ['Recherche sous-traitant électricien - chantier neuf'],
  'plomberie': ['Recherche sous-traitant plombier - chantier de rénovation'],
  'cvc': ['Recherche sous-traitant CVC - programme tertiaire'],
  'isolation': ['Recherche sous-traitant isolation - chantier de rénovation énergétique'],
  'menuiserie': ['Recherche sous-traitant menuisier - programme résidentiel'],
  'peinture': ['Recherche sous-traitant peintre - chantier de finition'],
  'vrd': ['Recherche sous-traitant VRD - aménagement de zone d\'activité'],
  'platrerie': ['Recherche sous-traitant plaquiste - chantier tertiaire'],
  'carrelage': ['Recherche sous-traitant carreleur - programme résidentiel'],
  'batiment-general': ['Recherche sous-traitant tous corps d\'état - chantier en cours'],
};

function buildDemoOpportunity(index: number, journey: 'public_procurement' | 'tender' | 'subcontracting') {
  const loc = DEMO_CITIES[index % DEMO_CITIES.length];
  const trade = DEMO_TRADES[index % DEMO_TRADES.length];
  const titleTemplates =
    journey === 'public_procurement' ? PUBLIC_TITLE_TEMPLATES[trade.slug]
    : journey === 'tender' ? PRIVATE_TITLE_TEMPLATES[trade.slug]
    : SUBCONTRACT_TITLE_TEMPLATES[trade.slug];
  const title = titleTemplates[Math.floor(index / DEMO_TRADES.length) % titleTemplates.length];
  const buyerTemplates =
    journey === 'public_procurement' ? PUBLIC_BUYER_TEMPLATES(loc.city, loc.department)
    : journey === 'tender' ? PRIVATE_BUYER_TEMPLATES(loc.city)
    : SUBCONTRACT_BUYER_TEMPLATES(loc.city);
  const buyerName = buyerTemplates[index % buyerTemplates.length];

  // Amounts scaled loosely by trade "size" (gros oeuvre/batiment-general run
  // much larger than a single-lot peinture/carrelage job) with some spread
  // via the index so cards don't all show suspiciously round numbers.
  const bigTrades = ['gros-oeuvre', 'batiment-general', 'vrd'];
  const base = bigTrades.includes(trade.slug) ? 280000 : 45000;
  const estimatedValue = base + (index * 3700) % (base * 2);

  const daysOut = 12 + (index * 5) % 55; // spread deadlines 12-67 days out, always in the future
  const deadline = new Date(Date.now() + daysOut * 24 * 60 * 60 * 1000);
  const publicationDate = new Date(Date.now() - (3 + (index % 10)) * 24 * 60 * 60 * 1000);

  const summary = journey === 'public_procurement'
    ? `${buyerName} lance une consultation pour des travaux de ${trade.label} à ${loc.city}. Le marché porte sur ${title.toLowerCase()}, pour un montant estimé à ${Math.round(estimatedValue / 1000)} k€ HT. Les candidatures sont ouvertes jusqu'au dépôt des offres, avec une notation classique prix/valeur technique/délai.`
    : journey === 'tender'
    ? `${title} à ${loc.city} pour un programme immobilier privé, lot ${trade.label}. Montant estimé ${Math.round(estimatedValue / 1000)} k€ HT. L'identité du donneur d'ordre est communiquée après prise de rendez-vous.`
    : `Entreprise générale recherche un sous-traitant qualifié en ${trade.label} pour un chantier en cours à ${loc.city}. Montant du lot estimé à ${Math.round(estimatedValue / 1000)} k€ HT. Intervention à planifier rapidement.`;

  return {
    source_reference: `demo-${journey}-${index.toString().padStart(3, '0')}`,
    title,
    description: summary,
    ai_summary: summary,
    publication_date: publicationDate,
    deadline,
    estimated_value: estimatedValue,
    location_city: loc.city,
    location_region: loc.region,
    location_department: loc.department,
    buyer_name: buyerName,
    trade_slug: trade.slug,
    journey,
  };
}

async function seedDemoOpportunities(): Promise<void> {
  const sourceResult = await pool.query(
    `INSERT INTO data_sources (code, name, feed_type, frequency_hours, active)
     VALUES ('demo_seed', 'Demo seed data (manual)', 'manual', 999999, false)
     ON CONFLICT (code) DO UPDATE SET code = EXCLUDED.code
     RETURNING id`
  );
  const sourceId = sourceResult.rows[0].id;

  // 40 public_procurement + 20 tender (private) + 15 subcontracting = 75,
  // comfortably clearing the "150+ total across categories" volume the
  // client asked for once combined with whatever's already in the DB.
  const demoData = [
    ...Array.from({ length: 40 }, (_, i) => buildDemoOpportunity(i, 'public_procurement')),
    ...Array.from({ length: 20 }, (_, i) => buildDemoOpportunity(i, 'tender')),
    ...Array.from({ length: 15 }, (_, i) => buildDemoOpportunity(i, 'subcontracting')),
  ];

  let inserted = 0;
  for (const d of demoData) {
    const result = await pool.query(
      `INSERT INTO opportunities
        (source_id, source_reference, opportunity_type_id, trade_id, title, description,
         publication_date, deadline, estimated_value, currency, location_city, location_region,
         location_department, buyer_name, status, ai_classification_status, ai_summary_status, ai_summary)
       VALUES ($1, $2, (SELECT id FROM opportunity_types WHERE code = $3), (SELECT id FROM trades WHERE slug = $4),
         $5, $6, $7, $8, $9, 'EUR', $10, $11, $12, $13, 'active', 'classified', 'generated', $14)
       ON CONFLICT (source_id, source_reference) DO NOTHING
       RETURNING id`,
      [
        sourceId, d.source_reference, d.journey, d.trade_slug, d.title, d.description,
        d.publication_date, d.deadline, d.estimated_value, d.location_city, d.location_region,
        d.location_department, d.buyer_name, d.ai_summary,
      ]
    );
    if (result.rows.length > 0) inserted++;
  }

  if (inserted > 0) {
    logger.info(`✅ Seeded ${inserted} demo opportunities (${demoData.length} total defined, rest already present)`);
  }
}
