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
      await applyIncrementalMigrations();
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
};
