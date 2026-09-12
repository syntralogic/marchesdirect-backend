/**
 * scripts/resetGmtDateContent.js
 *
 * Client's 12 Sep report: "Date limite" text on fiches showed an English
 * weekday + GMT offset instead of a plain French date. Root cause (see
 * services/aiService.ts): several prompts interpolated the raw pg Date
 * object for `deadline` directly into the prompt text, which JS implicitly
 * stringifies as e.g. "Wed Sep 23 2026 08:27:02 GMT+0000" - the model then
 * faithfully echoed that into the generated fiche content, per the "only
 * use what's literally in the source" rule.
 *
 * That's fixed at the source now (deadline is formatted before it ever
 * reaches a prompt), but it only prevents the bug on *future* generations.
 * Rows that already generated content with the bug baked in are
 * status='generated' (not 'failed'), so the existing on-demand-regenerate-
 * on-failure path never touches them. This finds any row whose stored
 * ai_summary or ai_analysis_sections text still contains "GMT" and clears
 * it back to not-generated, so the normal on-demand path (GET /:id) or the
 * backfill job regenerates it cleanly on next visit - no separate
 * generation logic here, just clearing the bad cache.
 *
 * Usage:
 *   node scripts/resetGmtDateContent.js          # apply
 *   node scripts/resetGmtDateContent.js --dry-run
 */

require("dotenv").config();
const { Pool } = require("pg");

const DRY_RUN = process.argv.includes("--dry-run");
const connectionString = process.env.DATABASE_URL;
const pool = connectionString
  ? new Pool({ connectionString, ssl: process.env.DB_SSL === "false" ? false : { rejectUnauthorized: false } })
  : new Pool({
      user: process.env.DB_USER, password: process.env.DB_PASSWORD, host: process.env.DB_HOST,
      port: parseInt(process.env.DB_PORT || "5432", 10), database: process.env.DB_NAME,
      ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : false,
    });

async function main() {
  console.log(`[resetGmtDateContent] Starting${DRY_RUN ? " (dry run)" : ""}...`);

  const { rows } = await pool.query(`
    SELECT id, ai_summary IS NOT NULL AND ai_summary LIKE '%GMT%' AS summary_hit,
           ai_analysis_sections IS NOT NULL AND ai_analysis_sections::text LIKE '%GMT%' AS sections_hit
    FROM opportunities
    WHERE (ai_summary LIKE '%GMT%') OR (ai_analysis_sections::text LIKE '%GMT%')
  `);

  console.log(`[resetGmtDateContent] ${rows.length} rows have GMT-tainted content`);
  if (rows.length === 0 || DRY_RUN) {
    if (DRY_RUN) console.table(rows.slice(0, 20));
    await pool.end();
    return;
  }

  const summaryIds = rows.filter(r => r.summary_hit).map(r => r.id);
  const sectionsIds = rows.filter(r => r.sections_hit).map(r => r.id);

  if (summaryIds.length > 0) {
    await pool.query(`UPDATE opportunities SET ai_summary = NULL, ai_classification_status = 'not_analyzed' WHERE id = ANY($1::uuid[])`, [summaryIds]);
    console.log(`[resetGmtDateContent] Cleared ai_summary on ${summaryIds.length} rows`);
  }
  if (sectionsIds.length > 0) {
    await pool.query(`UPDATE opportunities SET ai_analysis_sections = NULL, ai_analysis_sections_status = 'not_generated' WHERE id = ANY($1::uuid[])`, [sectionsIds]);
    console.log(`[resetGmtDateContent] Cleared ai_analysis_sections on ${sectionsIds.length} rows`);
  }

  console.log("[resetGmtDateContent] Done - affected fiches regenerate next time they're opened (or via the analysis-sections backfill job).");
  await pool.end();
}

main().catch((err) => {
  console.error("[resetGmtDateContent] Failed:", err);
  process.exit(1);
});
