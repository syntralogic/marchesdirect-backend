require('./boot.js');
const r = require(process.env.RECETTE_OUT || './out/routes/opportunities.js'); const router = r.default || r;
const route = router.routes.find(x => x.m === 'get' && x.p === '/'); const h = route.h[route.h.length - 1];
module.exports = (query) => new Promise((resolve) => {
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, set() { return this; }, setHeader() {}, json(b) { resolve({ status: this.statusCode, body: b }); }, send(b) { resolve({ status: this.statusCode, body: b }); } };
  h({ query, headers: {}, user: null, ip: '1.1.1.1', get() { return ''; } }, res).catch(e => resolve({ status: 'THROW', body: String(e) }));
});
if (require.main === module) (async () => {
  const q = JSON.parse(process.argv[2] || '{}');
  const out = await module.exports(q);
  if (out.status !== 200) { console.log(out.status, JSON.stringify(out.body).slice(0, 800)); return; }
  const b = out.body; console.log('total', b.pagination.total, 'breakdown', JSON.stringify(b.pagination.breakdown || null), 'rules', b.rules || 'v1');
  for (const x of b.results.slice(0, +(process.argv[3] || 8))) console.log(' ', (x.open_state || x.status).padEnd(9), 'lvl', x.location_level ?? '-', '|', String(x.title).slice(0, 50).padEnd(50), '| exec', x.exec_status || '-', JSON.stringify((x.exec_communes || []).map(c => c.name)), (x.exec_departments || []).join(','), '| achet', x.buyer_city || x.location_city, '| dl', x.deadline_checked ? new Date(x.deadline_checked).toISOString().slice(0, 16) : x.deadline);
})();
