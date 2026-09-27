/**
 * BACKFILL — location_country
 * ============================================================================
 * Context: 27 Sep client report, point 5 ("la zone géographique laisse
 * passer des annonces hors secteur") - a "France entière" search surfaced
 * notices actually located in Roumanie, Espagne, Italie. Root cause: TED
 * (EU-wide tenders) is the one connector that isn't France-only by
 * construction, but nothing in the schema or the search query ever
 * excluded a non-French TED row - there was no location_country column at
 * all until the 27 Sep fix (see schema.sql), and the search route now only
 * shows a TED row when location_country is confirmed 'FR'/'FRA'
 * (opportunities.ts).
 *
 * BOAMP/PLACE/DECP/Batiweb are exclusively French sources - every row from
 * them is safe to mark 'FR' immediately, no re-fetch needed. TED is a
 * different story: buyer-country WAS being fetched from its API all along
 * but never stored anywhere (not even in raw_data - see the TED
 * normalizer's own comment on why), so there is nothing left to recover
 * for EXISTING TED rows from data already in this database. Those rows
 * will only get a real location_country once TED's own scheduled run
 * re-fetches and re-upserts them (its `raw`/location_country fixes are
 * already in place going forward - see dataCollectionService.ts) - and
 * only for rows still inside its 30-day publication-date query window;
 * older ones won't self-heal and would need a dedicated re-fetch this
 * script deliberately does not attempt (no TED network access from this
 * environment, and guessing a country would be exactly the kind of
 * invented data this codebase avoids elsewhere). Leaving them NULL is the
 * safe choice: the search route already treats an unconfirmed
 * location_country on a TED row as "exclude", so this script's only job is
 * to make sure that guard doesn't also catch the 96% of rows that were
 * never the actual problem.
 *
 * HONESTY NOTE: never run against a live database from this sandbox (no
 * DATABASE_URL here). Typechecked and logic-reviewed only - run for real on
 * Render/wherever DATABASE_URL points to production.
 *
 * HOW TO RUN:
 *   npx ts-node scripts/backfillLocationCountry.ts             # dry count + confirm prompt
 *   npx ts-node scripts/backfillLocationCountry.ts --yes        # no prompt (e.g. cron/CI)
 */
import { db } from '../src/config/database';
import readline from 'readline';

const args = process.argv.slice(2);
const autoConfirm = args.includes('--yes');

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
    `SELECT COUNT(*)::int AS count
     FROM opportunities o
     JOIN data_sources ds ON o.source_id = ds.id
     WHERE ds.code <> 'ted' AND o.location_country IS NULL`
  );
  const total = countResult.rows[0].count;
  console.log(`Found ${total} opportunities from domestic-only sources (BOAMP/PLACE/DECP/Batiweb) with no location_country set.`);

  const tedCountResult = await db.query(
    `SELECT COUNT(*)::int AS count
     FROM opportunities o
     JOIN data_sources ds ON o.source_id = ds.id
     WHERE ds.code = 'ted' AND o.location_country IS NULL`
  );
  console.log(`(For reference: ${tedCountResult.rows[0].count} TED opportunities also have no location_country - these are NOT touched by this script, see the file header for why. They stay excluded from search until TED's own next in-window refresh sets a real value.)`);

  if (total === 0) {
    console.log('Nothing to do for domestic sources.');
    process.exit(0);
  }

  const proceed = await confirm(`Mark all ${total} of them 'FR'?`);
  if (!proceed) {
    console.log('Aborted.');
    process.exit(0);
  }

  const updateResult = await db.query(
    `UPDATE opportunities o
     SET location_country = 'FR', updated_at = NOW()
     FROM data_sources ds
     WHERE o.source_id = ds.id AND ds.code <> 'ted' AND o.location_country IS NULL`
  );

  console.log('\n--- Backfill summary ---');
  console.log(`Marked 'FR': ${updateResult.rowCount ?? 0}`);

  process.exit(0);
}

main().catch(err => {
  console.error('Backfill script crashed:', err);
  process.exit(1);
});
