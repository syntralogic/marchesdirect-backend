#!/usr/bin/env node
/*
 * How many genuinely open notices does BOAMP hold today, versus what our site
 * shows as open?   API_URL=https://<backend>.onrender.com node scripts/compareOpenWithBoamp.js
 * Read-only; nothing is changed anywhere.
 */
const API = (process.env.API_URL || 'http://localhost:5000').replace(/\/$/, '') + '/api';
const BOAMP = 'https://boamp-datadila.opendatasoft.com/api/explore/v2.1/catalog/datasets/boamp/records';
const today = new Date().toISOString().slice(0, 10);
const j = async (u) => { const r = await fetch(u); if (!r.ok) throw new Error(`${r.status} ${u}`); return r.json(); };

(async () => {
  const open = await j(`${BOAMP}?limit=1&where=${encodeURIComponent(`datelimitereponse >= date'${today}'`)}`);
  console.log(`BOAMP: notices with a deadline from ${today} on ............ ${open.total_count}`);
  try {
    const g = await j(`${BOAMP}?limit=20&select=count(*)%20as%20n&group_by=nature_categorise_libelle&where=${encodeURIComponent(`datelimitereponse >= date'${today}'`)}`);
    for (const r of g.results) console.log(`   ${String(r.nature_categorise_libelle ?? '(none)').padEnd(34)} ${r.n}`);
  } catch { console.log('   (breakdown by nature not available)'); }

  const mine = await j(`${API}/opportunities/stats/counts?status=active`);
  const all = await j(`${API}/opportunities/stats/counts`);
  console.log(`\nOur site, status active: public ${mine.public_procurement} | private ${mine.tender} | subcontracting ${mine.subcontracting}`);
  console.log(`Our site, whole catalogue (archives): ${all.total}`);
  console.log(`\nGap BOAMP-open vs our public-open: ${open.total_count - mine.public_procurement}`);
  console.log('A gap of a few hundred is normal (rectificatifs/duplicates merged, notices that are not tenders).');
  console.log('A gap of thousands means ingestion is not completing: check the Render logs for [BOAMP] lines.');
})().catch((e) => { console.error(e); process.exit(2); });
