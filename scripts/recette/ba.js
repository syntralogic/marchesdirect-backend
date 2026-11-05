const search = require('./search.js'); const { run } = require('./boot.js');
(async () => {
  const L = Object.fromEntries(run(`SELECT o.id::text, o.source_reference, l.exec_status, l.exec_communes, l.exec_departments FROM opportunities o LEFT JOIN opportunity_locations l ON l.opportunity_id=o.id`).rows.map(r => [r.id, r]));
  const v1 = (await search({ city: 'Bordeaux', limit: '100' })).body, v2 = (await search({ city: 'Bordeaux', loc: '2', limit: '100' })).body;
  const ex = id => { const r = L[id]; return `${r.source_reference} exec=${r.exec_status}:${(r.exec_communes || []).map(c => c.name).join('/') || (r.exec_departments || []).join(',')}`; };
  console.log('AVANT (production) city=Bordeaux :', v1.pagination.total);
  const wrong = v1.results.filter(x => { const r = L[x.id]; return (r.exec_communes || []).length && !(r.exec_communes || []).some(c => c.slug === 'bordeaux'); });
  console.log('  dont exécutées dans une autre commune :', wrong.length, wrong.slice(0, 6).map(x => ex(x.id)));
  const v2ids = new Set(v2.results.map(x => x.id)); const added = v2.results.filter(x => !v1.results.some(y => y.id === x.id));
  console.log('APRÈS (v2) :', v2.pagination.total, JSON.stringify(v2.pagination.breakdown), ' ajoutées :', added.map(x => ex(x.id)).slice(0, 6));
})();
