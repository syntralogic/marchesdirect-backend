/**
 * scripts/migrate.js
 *
 * Loads schema.sql against the configured database. Safe to run repeatedly -
 * every statement in schema.sql uses CREATE TABLE IF NOT EXISTS / ON CONFLICT
 * DO NOTHING, so re-running just no-ops on an already-migrated database.
 *
 * This does the same thing server.ts's ensureSchema() does automatically on
 * boot - it exists as a separate script so a migration can be run (or scripted
 * in CI/CD) without starting the HTTP server, matching what the README's
 * Quick Start already documents.
 *
 * Usage:
 *   node scripts/migrate.js
 *   npm run db:migrate
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

async function main() {
  const connectionString = process.env.DATABASE_URL;

  const pool = connectionString
    ? new Pool({
        connectionString,
        ssl: process.env.DB_SSL === "false" ? false : { rejectUnauthorized: false },
      })
    : new Pool({
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        host: process.env.DB_HOST,
        port: parseInt(process.env.DB_PORT || "5432", 10),
        database: process.env.DB_NAME,
        ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : false,
      });

  try {
    await pool.query("SELECT NOW()");
    console.log("Connected to database.");

    const schemaPath = path.resolve(__dirname, "..", "schema.sql");
    const schemaSql = fs.readFileSync(schemaPath, "utf-8");

    console.log("Applying schema.sql ...");
    await pool.query(schemaSql);
    console.log("Schema applied successfully.");
  } catch (err) {
    console.error("Migration failed:", err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();
