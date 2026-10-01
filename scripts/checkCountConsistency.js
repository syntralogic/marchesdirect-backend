#!/usr/bin/env node
/*
 * Consistency check between counts and the lists they lead to.
 *   API_URL=https://your-api.example.com node scripts/checkCountConsistency.js
 *
 * 1. Every métier: typing its name in the search box (q) must return the same
 *    total as selecting it (trade_id).
 * 2. Every region: the map badge (/stats/regions) must equal the list total.
 * 3. Every département: same with /stats/departments.
 * Exit code 1 when a mismatch is found.
 */
const API = (process.env.API_URL || 'http://localhost:5000').replace(/\/$/, '') + '/api';
const get = async (path) => {
  const r = await fetch(API + path);
  if (!r.ok) throw new Error(`${r.status} ${path}`);
  return r.json();
};
const total = async (qs) => (await get('/opportunities?limit=1&' + new URLSearchParams(qs))).pagination.total;
const status = process.env.STATUS || ''; // e.g. STATUS=active to compare open markets only
const base = status ? { status } : {};

(async () => {
  let bad = 0;
  const report = (kind, label, a, b) => {
    const ok = a === b;
    if (!ok) bad++;
    console.log(`${ok ? 'OK  ' : 'DIFF'} ${kind.padEnd(11)} ${label.padEnd(34)} ${a} vs ${b}`);
  };

  const tradesRes = await get('/trades');
  const trades = Array.isArray(tradesRes) ? tradesRes : (tradesRes.trades || []);
  for (const t of trades) {
    const byText = await total({ ...base, q: t.name });
    const byTrade = await total({ ...base, trade_id: String(t.id) });
    report('métier', `${t.name} (q / trade_id)`, byText, byTrade);
  }

  const { regions } = await get('/opportunities/stats/regions');
  for (const r of regions) report('région', r.region + ' (badge / liste)', r.count, await total({ region: r.region }));

  const { departments } = await get('/opportunities/stats/departments');
  for (const d of departments) report('département', d.department + ' (badge / liste)', d.count, await total({ department: d.department }));

  console.log(bad === 0 ? '\nAll consistent.' : `\n${bad} mismatch(es).`);
  process.exit(bad === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
