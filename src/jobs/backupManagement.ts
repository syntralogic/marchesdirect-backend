import cron from 'node-cron';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import { db } from '../config/database';
import { logger } from '../utils/logger';

const execAsync = promisify(exec);

// ============================================================================
// BACKUP MANAGEMENT (Milestone 12)
// Requires pg_dump / pg_restore / createdb / dropdb available on the host
// (standard on most Postgres-capable servers, including Render).
// Works with either connection style config/database.ts supports:
//   - DATABASE_URL (single connection string - Render/Supabase default), or
//   - split DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME
// Set BACKUP_DIR to control where dumps are written (defaults to /tmp/backups).
// Optionally set BACKUP_S3_BUCKET + AWS credentials to also push to S3 via aws-sdk.
// ============================================================================

const BACKUP_DIR = process.env.BACKUP_DIR || '/tmp/backups';

const ensureBackupDir = () => {
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }
};

// Builds the pg_dump/psql/createdb/dropdb connection args for whichever
// connection style is configured, and optionally targets a different
// database name than the one connected to (used for the restore test's
// throwaway database). Returns a connection string when DATABASE_URL is set
// (so SSL/pooler params in the URL are preserved), or a flag string otherwise.
function connectionArgs(overrideDbName?: string): { conn: string; env: NodeJS.ProcessEnv } {
  const env = { ...process.env, PGPASSWORD: process.env.DB_PASSWORD || '' };

  if (process.env.DATABASE_URL) {
    if (!overrideDbName) {
      return { conn: `"${process.env.DATABASE_URL}"`, env };
    }
    const url = new URL(process.env.DATABASE_URL);
    url.pathname = `/${overrideDbName}`;
    return { conn: `"${url.toString()}"`, env };
  }

  const dbHost = process.env.DB_HOST;
  const dbPort = process.env.DB_PORT || '5432';
  const dbUser = process.env.DB_USER;
  const dbName = overrideDbName || process.env.DB_NAME;

  if (!dbHost || !dbUser || !dbName) {
    throw new Error(
      'Set DATABASE_URL, or DB_HOST/DB_USER/DB_NAME, before running backups (see config/database.ts).'
    );
  }

  return { conn: `-h ${dbHost} -p ${dbPort} -U ${dbUser} -d ${dbName}`, env };
}

export const runBackup = async (type: 'full' | 'incremental' = 'full') => {
  ensureBackupDir();
  const startedAt = new Date();
  const filename = `backup-${type}-${startedAt.toISOString().replace(/[:.]/g, '-')}.sql`;
  const filepath = path.join(BACKUP_DIR, filename);

  const logResult = await db.query(
    `INSERT INTO backup_logs (backup_type, backup_location, status, started_at)
     VALUES ($1, $2, 'running', $3) RETURNING id`,
    [type, filepath, startedAt]
  );
  const backupLogId = logResult.rows[0].id;

  try {
    const { conn, env } = connectionArgs();
    await execAsync(`pg_dump ${conn} -F p -f "${filepath}"`, { env });

    const stats = fs.statSync(filepath);
    const recordCountResult = await db.query('SELECT COUNT(*) as count FROM opportunities');

    await db.query(
      `UPDATE backup_logs SET status = 'success', size_bytes = $1, records_backed_up = $2, completed_at = NOW()
       WHERE id = $3`,
      [stats.size, parseInt(recordCountResult.rows[0].count), backupLogId]
    );

    logger.info(`[Job] Backup complete: ${filepath} (${stats.size} bytes)`);
    return { success: true, filepath, sizeBytes: stats.size };
  } catch (err: any) {
    logger.error('[Job] Backup failed:', err);
    await db.query(
      `UPDATE backup_logs SET status = 'failed', completed_at = NOW() WHERE id = $1`,
      [backupLogId]
    );
    return { success: false, error: err.message };
  }
};

// Restore test: restores the latest successful backup into a throwaway test database
// to prove the backup is actually usable (Milestone 12 proof requirement).
//
// Note: on a managed Postgres host where the connecting role can't run
// CREATE DATABASE (e.g. some restricted Supabase/RDS setups), this will fail
// with a permissions error - that's a real infra constraint to resolve with
// the DB provider, not something this script can work around. It needs to be
// run once against the real production-equivalent host to know which case
// applies.
export const testRestore = async () => {
  const latestResult = await db.query(
    `SELECT * FROM backup_logs WHERE status = 'success' ORDER BY completed_at DESC LIMIT 1`
  );

  if (latestResult.rows.length === 0) {
    return { success: false, error: 'No successful backup available to restore' };
  }

  const backup = latestResult.rows[0];
  const testDbName = `restore_test_${Date.now()}`;

  try {
    const admin = connectionArgs(); // connects to the default configured DB to issue CREATE/DROP DATABASE
    const adminDbNameFlag = process.env.DATABASE_URL ? '' : `-d ${process.env.DB_NAME ?? ''}`;

    if (process.env.DATABASE_URL) {
      // createdb/dropdb don't take a full connection URL the way psql/pg_dump do -
      // derive host/port/user from the URL for those two commands specifically.
      const url = new URL(process.env.DATABASE_URL);
      const hostArgs = `-h ${url.hostname} -p ${url.port || '5432'} -U ${decodeURIComponent(url.username)}`;
      await execAsync(`createdb ${hostArgs} ${testDbName}`, { env: admin.env });
      const restoreConn = connectionArgs(testDbName);
      await execAsync(`psql ${restoreConn.conn} -f "${backup.backup_location}"`, { env: admin.env });
      await execAsync(`psql ${restoreConn.conn} -c "SELECT COUNT(*) FROM opportunities;"`, { env: admin.env });
      await execAsync(`dropdb ${hostArgs} ${testDbName}`, { env: admin.env });
    } else {
      const dbHost = process.env.DB_HOST;
      const dbPort = process.env.DB_PORT || '5432';
      const dbUser = process.env.DB_USER;
      const hostArgs = `-h ${dbHost} -p ${dbPort} -U ${dbUser}`;
      await execAsync(`createdb ${hostArgs} ${testDbName}`, { env: admin.env });
      await execAsync(`psql ${hostArgs} -d ${testDbName} -f "${backup.backup_location}"`, { env: admin.env });
      await execAsync(`psql ${hostArgs} -d ${testDbName} -c "SELECT COUNT(*) FROM opportunities;"`, { env: admin.env });
      await execAsync(`dropdb ${hostArgs} ${testDbName}`, { env: admin.env });
    }
    void adminDbNameFlag;

    await db.query(
      `UPDATE backup_logs SET restoration_tested = true, restoration_date = NOW() WHERE id = $1`,
      [backup.id]
    );

    logger.info(`[Job] Restore test passed for backup ${backup.id}`);
    return { success: true, backupId: backup.id };
  } catch (err: any) {
    logger.error('[Job] Restore test failed:', err);
    return { success: false, error: err.message };
  }
};

export const startBackupSchedule = () => {
  // Full backup daily at 02:00
  cron.schedule('0 2 * * *', () => {
    logger.info('[Job] Running scheduled daily backup...');
    runBackup('full');
  });

  // Restore test weekly (Sunday 05:00) to keep proving backups are restorable
  cron.schedule('0 5 * * 0', () => {
    logger.info('[Job] Running weekly backup restore test...');
    testRestore();
  });

  logger.info('✅ Backup jobs scheduled (daily backup, weekly restore test)');
};
