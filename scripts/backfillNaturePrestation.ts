/**
 * BACKFILL — nature_prestation (R04)
 * ============================================================================
 * Context: contre-audit 15 Sep 2026, R04 ("travaux, fournitures et études
 * mélangés") - see 1651837 (R03/R04 ranking boost) and the nature_prestation
 * column/prompt extension in database.ts / aiService.ts. classifyOpportunity
 * now asks the model for nature_prestation on every NEW classification call,
 * and the normal cron (src/jobs/aiProcessing.ts) will pick that up for any
 * row currently sitting at ai_classification_status IN ('not_analyzed',
 * 'failed'). It will NOT touch the ~47k rows already sitting at 'classified'
 * from before this change - those need to be explicitly reclassified to gain
 * a nature_prestation value, which is this script.
 *
 * COST NOTE: this is NOT free. Every row processed here is a real, billed
 * Claude API call (same call classifyOpportunity always makes - Haiku,
 * trimmed context, per aiService.ts) - re-running it against the full
 * backlog re-does the trade/CPV/complexity classification too, not just
 * nature_prestation, since it's the same call. That's the deliberate
 * decision this script does NOT make on your behalf: it only resets
 * ai_classification_status back to 'not_analyzed' for rows missing
 * nature_prestation, then lets the existing throttled cron
 * (processUnclassifiedOpportunities, 40 rows/500ms - see aiProcessing.ts)
 * pick them up at the normal steady-state pace, rather than hammering the
 * API in a tight loop here. Confirm prompt (or --limit) is there so you can
 * run a small batch first and check nature_prestation values look sane
 * before resetting the whole backlog.
 *
 * HONESTY NOTE: never run against a live database from this sandbox (no
 * DATABASE_URL here). Typechecked and logic-reviewed only - run for real on
 * Render/wherever DATABASE_URL points to production.
 *
 * HOW TO RUN:
 *   npx ts-node scripts/backfillNaturePrestation.ts              # dry count + confirm prompt
 *   npx ts-node scripts/backfillNaturePrestation.ts --yes         # no prompt (e.g. cron/CI)
 *   npx ts-node scripts/backfillNaturePrestation.ts --yes --limit 2000   # small batch first
 */
import { db } from '../src/config/database';
import readline from 'readline';

const args = process.argv.slice(2);
const autoConfirm = args.includes('--yes');
const limitArg = args.find(a => a.startsWith('--limit'));
const limit = limitArg ? parseInt(limitArg.split('=')[1] || args[args.indexOf(limitArg) + 1], 10) : undefined;

const confirm = (question: string): Promise<boolean> => {
  if (autoConfirm) return Promise.resolve(true);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(`${question} (y/N) `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
};

async function main() {
  const countResult = await db.query(
    `SELECT COUNT(*)::int AS count FROM opportunities
     WHERE ai_classification_status = 'classified' AND nature_prestation IS NULL AND deleted_at IS NULL`
  );
  const total = countResult.rows[0].count;
  console.log(`Found ${total} already-classified opportunities with no nature_prestation set.`);

  if (total === 0) {
    console.log('Nothing to do.');
    process.exit(0);
  }

  const toReset = limit ? Math.min(limit, total) : total;
  const proceed = await confirm(
    `Reset ${toReset} of them to 'not_analyzed' so the normal classification cron re-processes them ` +
    `(real, billed Claude API calls, ~${toReset} of them, at the existing 40/500ms steady-state pace)?`
  );
  if (!proceed) {
    console.log('Aborted.');
    process.exit(0);
  }

  const result = await db.query(
    `UPDATE opportunities SET ai_classification_status = 'not_analyzed'
     WHERE id IN (
       SELECT id FROM opportunities
       WHERE ai_classification_status = 'classified' AND nature_prestation IS NULL AND deleted_at IS NULL
       ORDER BY created_at ASC
       ${limit ? 'LIMIT $1' : ''}
     )`,
    limit ? [limit] : []
  );

  console.log(`\nReset ${result.rowCount} rows to 'not_analyzed'.`);
  console.log('The existing classification cron (processUnclassifiedOpportunities) will pick these up automatically.');
  console.log('Re-run this script with no --limit later to check how many are still unresolved, or query:');
  console.log(`  SELECT COUNT(*) FROM opportunities WHERE ai_classification_status = 'classified' AND nature_prestation IS NULL;`);

  process.exit(0);
}

main().catch(err => {
  console.error('Backfill script crashed:', err);
  process.exit(1);
});
