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
};
