/**
 * BACKFILL — ai_extracted_facts (team_size_estimate, key_risks, etc.)
 * ============================================================================
 * Context: extractOpportunityFacts() (src/services/aiService.ts) gained two
 * new fields - team_size_estimate and key_risks - to close the last 2 gaps
 * against the client's prototype V17 spec ("équipe attendue" / "points de
 * vigilance"). New opportunities get this automatically the first time
 * extraction runs on them. Opportunities that were already extracted BEFORE
 * this change have an ai_extracted_facts blob missing those two keys, and
 * opportunities that were never extracted at all have no blob whatsoever.
 * This script re-runs extraction on both groups so the fiche shows real data
 * instead of nothing, retroactively.
 *
 * COST NOTE: this calls the LLM once per opportunity that needs it. Sized to
 * your DB, that can be non-trivial - the script prints a count and asks for
 * confirmation before spending anything (skippable with --yes for cron use).
 *
 * IDEMPOTENT / RESUMABLE: only touches opportunities where
 * ai_extracted_facts IS NULL or is missing team_size_estimate/key_risks. Ctrl-C
 * and rerun any time - already-processed rows are skipped automatically, they
 * are not re-billed on a second run.
 *
 * RATE LIMIT: sequential with a delay between calls (--delay-ms, default 500)
 * rather than parallel, so this doesn't hammer the Anthropic API or the DB
 * under load from real traffic at the same time.
 *
 * HOW TO RUN:
 *   npx ts-node scripts/backfillOpportunityFacts.ts                # dry count + confirm prompt
 *   npx ts-node scripts/backfillOpportunityFacts.ts --yes           # no prompt (e.g. cron)
 *   npx ts-node scripts/backfillOpportunityFacts.ts --yes --limit 50   # cap for a test run
 *   npx ts-node scripts/backfillOpportunityFacts.ts --yes --delay-ms 1000
 *
 * HONESTY NOTE: this has not been run against a live database from this
 * sandbox - there is no DATABASE_URL / ANTHROPIC_API_KEY wired up here. This
 * is the tool, not proof it's been executed. Run it against the real DB and
 * check the summary counts it prints before considering the backfill done.
 */

import { db } from '../src/config/database';
import { extractOpportunityFacts } from '../src/services/aiService';

function parseArgs() {
  const args = process.argv.slice(2);
  const has = (flag: string) => args.includes(flag);
  const valueOf = (flag: string, fallback: string) => {
    const i = args.indexOf(flag);
    return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
  };
  return {
    yes: has('--yes'),
    limit: parseInt(valueOf('--limit', '0'), 10) || undefined,
    delayMs: parseInt(valueOf('--delay-ms', '500'), 10),
  };
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function confirm(question: string): Promise<boolean> {
  process.stdout.write(`${question} (y/N) `);
  return new Promise(resolve => {
    process.stdin.resume();
    process.stdin.once('data', d => {
      process.stdin.pause();
      resolve(d.toString().trim().toLowerCase() === 'y');
    });
  });
}

async function main() {
  const { yes, limit, delayMs } = parseArgs();

  const needsBackfillQuery = `
    SELECT id, title FROM opportunities
    WHERE deleted_at IS NULL
      AND (
        ai_extracted_facts IS NULL
        OR ai_extracted_facts->'team_size_estimate' IS NULL
        OR ai_extracted_facts->'key_risks' IS NULL
      )
    ORDER BY created_at DESC
    ${limit ? `LIMIT ${limit}` : ''}
  `;

  const { rows } = await db.query(needsBackfillQuery);

  if (rows.length === 0) {
    console.log('Nothing to backfill - every non-deleted opportunity already has team_size_estimate and key_risks.');
    process.exit(0);
  }

  console.log(`${rows.length} opportunit${rows.length === 1 ? 'y' : 'ies'} need extraction (missing or pre-dating the new fields).`);
  console.log(`Estimated cost: ${rows.length} LLM call(s), ~${((rows.length * delayMs) / 1000 / 60).toFixed(1)} min at ${delayMs}ms between calls.`);

  if (!yes) {
    const ok = await confirm('Proceed?');
    if (!ok) {
      console.log('Aborted, nothing was changed.');
      process.exit(0);
    }
  }

  let succeeded = 0;
  let failed = 0;
  const failures: { id: string; title: string; error: string }[] = [];

  for (let i = 0; i < rows.length; i++) {
    const { id, title } = rows[i];
    process.stdout.write(`[${i + 1}/${rows.length}] ${id} - ${String(title).slice(0, 60)} ... `);
    try {
      await extractOpportunityFacts(id);
      succeeded++;
      console.log('ok');
    } catch (err: any) {
      failed++;
      failures.push({ id, title, error: err?.message || String(err) });
      console.log(`FAILED: ${err?.message || err}`);
    }
    if (i < rows.length - 1) await sleep(delayMs);
  }

  console.log('\n--- Backfill summary ---');
  console.log(`Succeeded: ${succeeded}`);
  console.log(`Failed:    ${failed}`);
  if (failures.length > 0) {
    console.log('\nFailed opportunities (rerun the script to retry these - it is idempotent):');
    for (const f of failures) console.log(`  ${f.id} - ${f.title.slice(0, 60)} - ${f.error}`);
  }

  // db.query() wraps a pg Pool internally with no exposed close() method, so
  // open connections would otherwise keep the Node process alive - force-exit
  // instead, which is safe here since we're done issuing queries.
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Backfill script crashed:', err);
  process.exit(1);
});
