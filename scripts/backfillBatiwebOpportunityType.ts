/**
 * BACKFILL — Batiweb opportunity_type_id (client report, appels d'offres
 * privés quasi vides)
 * ============================================================================
 * Context: client reported the "Opportunités" journey's appels d'offres
 * privés (tender) and sous-traitance sections have almost no data.
 * Investigation: BOAMP/PLACE/TED/DECP are all public-procurement-only
 * sources - Batiweb is the only connector meant to feed the "tender"
 * (private-tender) opportunity_type. But insertOpportunity() hardcoded
 * opportunity_type_id to 'public_procurement' for every single source it
 * inserts through, Batiweb included, regardless of what the source's own
 * opportunity object said - so every Batiweb row ever ingested, however
 * many that scraper actually found, landed under public_procurement
 * instead of tender. The "tender" opportunity_type was therefore
 * structurally guaranteed to be near-empty no matter how well the
 * Batiweb feed itself was working.
 *
 * Code fix: insertOpportunity now reads data.opportunity_type (Batiweb's
 * collector sets it to 'tender'), defaulting to 'public_procurement' for
 * the other four sources which don't set it. That only fixes rows
 * inserted AFTER this deploys - this script corrects whatever Batiweb
 * rows already exist in the database with the wrong type.
 *
 * This does NOT touch sous-traitance: that's a separate, self-published
 * table (subcontract_needs, see routes/subcontractNeeds.ts, "Je cherche
 * un sous-traitant") with no ingestion source at all - it's empty because
 * no company has posted a need yet, not because of a data bug. Nothing
 * in this codebase can backfill that; it needs real companies using the
 * feature.
 *
 * HONESTY NOTE: never run against a live database from this sandbox (no
 * DATABASE_URL here, and batiweb.com itself isn't reachable from this
 * sandbox's network egress allowlist either - see dataCollectionService.ts's
 * Batiweb section header for that). Typechecked and logic-reviewed only -
 * run for real on Render/wherever DATABASE_URL points to production, and
 * check the printed count looks like a real Batiweb backlog (not 0, not
 * suspiciously huge) before confirming.
 *
 * HOW TO RUN:
 *   npx ts-node scripts/backfillBatiwebOpportunityType.ts           # dry count + confirm prompt
 *   npx ts-node scripts/backfillBatiwebOpportunityType.ts --yes     # no prompt (e.g. cron/CI)
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
     JOIN data_sources ds ON ds.id = o.source_id
     JOIN opportunity_types ot ON ot.id = o.opportunity_type_id
     WHERE ds.code = 'batiweb' AND ot.code = 'public_procurement' AND o.deleted_at IS NULL`
  );
  const total = countResult.rows[0].count;
  console.log(`Found ${total} Batiweb-sourced opportunities mislabeled as public_procurement.`);

  if (total === 0) {
    console.log('Nothing to do (either no Batiweb rows exist yet, or this backfill already ran).');
    process.exit(0);
  }

  const proceed = await confirm(
    `Move ${total} Batiweb row(s) from public_procurement to tender? This only corrects the ` +
    `opportunity_type_id (a metadata fix) - no AI calls, no other field changes.`
  );
  if (!proceed) {
    console.log('Aborted.');
    process.exit(0);
  }

  const result = await db.query(
    `UPDATE opportunities SET opportunity_type_id = (SELECT id FROM opportunity_types WHERE code = 'tender')
     WHERE id IN (
       SELECT o.id FROM opportunities o
       JOIN data_sources ds ON ds.id = o.source_id
       JOIN opportunity_types ot ON ot.id = o.opportunity_type_id
       WHERE ds.code = 'batiweb' AND ot.code = 'public_procurement' AND o.deleted_at IS NULL
     )`
  );

  console.log(`\nMoved ${result.rowCount} row(s) to the tender opportunity_type.`);
  console.log('They should now show up under Appels d\'offres privés (/appels-doffres, journey=tender).');
  console.log('If the count above was 0 or very small, check whether the Batiweb connector has actually');
  console.log('been running successfully - see connector_logs WHERE source_id = (SELECT id FROM data_sources WHERE code = \'batiweb\').');

  process.exit(0);
}

main().catch(err => {
  console.error('Backfill script crashed:', err);
  process.exit(1);
});
