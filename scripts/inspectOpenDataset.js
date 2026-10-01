#!/usr/bin/env node
/*
 * Prints the real field names + 3 sample rows of an Opendatasoft dataset, so a
 * collector can be written against the actual schema instead of guesses.
 *
 *   node scripts/inspectOpenDataset.js                      # APProch (projets d'achats publics)
 *   node scripts/inspectOpenDataset.js <host> <dataset-id>  # any other Opendatasoft dataset
 *
 * Read-only. Needs outbound internet (run it from your machine or the Render shell).
 */
const host = process.argv[2] || 'data.economie.gouv.fr';
const dataset = process.argv[3] || 'projets-dachats-publics';
const base = `https://${host}/api/explore/v2.1/catalog/datasets/${dataset}`;
const j = async (u) => { const r = await fetch(u); if (!r.ok) throw new Error(`${r.status} ${u}`); return r.json(); };

(async () => {
  const meta = await j(base);
  console.log(`Dataset: ${meta.metas?.default?.title || dataset}`);
  console.log(`Records: ${meta.metas?.default?.records_count ?? '?'}\n`);
  console.log('FIELDS (name : type)');
  for (const f of meta.fields || []) console.log(`  ${String(f.name).padEnd(40)} ${f.type}`);
  const sample = await j(`${base}/records?limit=3`);
  console.log('\nSAMPLE ROWS');
  console.log(JSON.stringify(sample.results, null, 2));
})().catch((e) => { console.error(e); process.exit(2); });
