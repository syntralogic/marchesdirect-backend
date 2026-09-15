/**
 * scripts/backfillTitleEntities.js
 *
 * Contre-audit 15 Sep 2026, ticket R07: opportunity titles carry raw,
 * undecoded HTML character references - client's example was literally
 * "&#8211;" showing up as text instead of "–". src/utils/textSanitize.ts
 * (decodeHtmlEntities) now decodes these on every newly-ingested row, but
 * that only helps going forward - this backfills every already-ingested
 * row so titles already live get fixed too, same pattern as
 * backfillRegionNames.js.
 *
 * Mirrors src/utils/textSanitize.ts's decodeHtmlEntities exactly (plain
 * node, not ts-node, same reasoning as the other scripts/*.js files - keep
 * the two in sync if that file ever changes).
 *
 * Safe to re-run - only rows where decoding actually changes the text get
 * written; already-clean rows are untouched.
 *
 * Usage:
 *   node scripts/backfillTitleEntities.js          # apply
 *   node scripts/backfillTitleEntities.js --dry-run # report counts only, no writes
 */

require("dotenv").config();
const { Pool } = require("pg");

const DRY_RUN = process.argv.includes("--dry-run");

const connectionString = process.env.DATABASE_URL;
const pool = connectionString
  ? new Pool({ connectionString, ssl: process.env.DB_SSL === "false" ? false : { rejectUnauthorized: false } })
  : new Pool({
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      host: process.env.DB_HOST,
      port: parseInt(process.env.DB_PORT || "5432", 10),
      database: process.env.DB_NAME,
      ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : false,
    });

const NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeHtmlEntities(text) {
  if (!text || typeof text !== "string" || text.indexOf("&") === -1) return text;
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, ref) => {
    if (ref[0] === "#") {
      const isHex = ref[1] === "x" || ref[1] === "X";
      const codePoint = parseInt(ref.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      if (Number.isNaN(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return match;
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return match;
      }
    }
    return NAMED_ENTITIES[ref] !== undefined ? NAMED_ENTITIES[ref] : match;
  });
}

async function main() {
  await pool.query("SELECT NOW()");
  console.log("Connected to database.");

  // Only pull rows that could possibly need work - cheap pre-filter before
  // the JS decode runs on each candidate.
  const { rows } = await pool.query(
    `SELECT id, title, description FROM opportunities WHERE title LIKE '%&%' OR description LIKE '%&%'`
  );
  console.log(`Checked ${rows.length} candidate rows.`);

  let changed = 0;
  for (const row of rows) {
    const newTitle = decodeHtmlEntities(row.title);
    const newDescription = decodeHtmlEntities(row.description);
    if (newTitle === row.title && newDescription === row.description) continue;

    changed++;
    if (DRY_RUN) {
      if (newTitle !== row.title) console.log(`[dry-run] ${row.id}: "${row.title}" -> "${newTitle}"`);
      continue;
    }
    await pool.query(`UPDATE opportunities SET title = $1, description = $2 WHERE id = $3`, [
      newTitle,
      newDescription,
      row.id,
    ]);
  }

  console.log(DRY_RUN ? `Would update ${changed} row(s).` : `Updated ${changed} row(s).`);
  await pool.end();
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exitCode = 1;
});
