// Scénarios de recette (mandat qualité, point 16) exécutés sur le vrai code compilé et le vrai SQL (Postgres local,
// 100 avis BOAMP réels de Gironde + 6 cas TEST). Sortie : tableau Markdown entrée / attendu / obtenu / conclusion.
const search = require('./search.js');
const rows = [];
const ids = b => b.results.map(x => x.source_reference || x.title);
const refOf = async () => { const { run } = require('./boot.js'); return Object.fromEntries(run('SELECT id::text, source_reference FROM opportunities').rows.map(r => [r.id, r.source_reference])); };
(async () => {
  const REF = await refOf();
  const S = async q => { const o = await search({ loc: '2', limit: '100', ...q }); if (o.status !== 200) throw new Error(JSON.stringify(o.body).slice(0, 300)); o.body.results.forEach(x => x.ref = REF[x.id]); return o.body; };
  const T = (name, input, expected, obtained, ok) => rows.push({ name, input, expected, obtained, ok });
  let b;
  b = await S({ city: 'Bordeaux', q: 'travaux' });
  T('Recherche exacte métier + ville', 'q=travaux, city=Bordeaux', 'Annonces exécutées à Bordeaux d’abord (niveau 0), puis acheteur seul (niveau 1) ; aucune annonce exécutée ailleurs',
    `${b.pagination.total} résultats ; niveaux ${[...new Set(b.results.map(x => x.location_level))].join(',')} ; exécution ailleurs : ${b.results.filter(x => (x.exec_communes || []).length && !(x.exec_communes || []).some(c => c.slug === 'bordeaux')).length}`,
    b.results.every((x, k, a) => k === 0 || (a[k - 1].state_rank < x.state_rank) || (a[k - 1].state_rank === x.state_rank && a[k - 1].location_level <= x.location_level)) && !b.results.some(x => (x.exec_communes || []).length && !(x.exec_communes || []).some(c => c.slug === 'bordeaux')));
  const r1 = await S({ city: 'Rochefort' }), r2 = await S({ city: 'Rochefort', department: '17' });
  T('Commune homonyme', 'city=Rochefort, puis + department=17', 'Sans département : les deux Rochefort, chacun avec son département ; avec 17 : seulement Rochefort (17)',
    `sans : ${r1.results.map(x => x.ref + '→' + (x.exec_departments || []).join('')).join(', ')} ; avec 17 : ${r2.results.map(x => x.ref).join(', ')}`, r1.pagination.total === 2 && r2.pagination.total === 1 && r2.results[0].ref === 'TEST-ROCH17');
  const a1 = await S({ city: 'Bordeaux' }), a2 = await S({ city: 'Laruns' });
  T('Acheteur dans une autre ville que le chantier', '26-105970 (Bordeaux Métropole, chantier à Laruns 64) : city=Bordeaux, city=Laruns', 'Absent de Bordeaux, présent à Laruns (niveau 0)',
    `Bordeaux : ${a1.results.some(x => x.ref === '26-105970') ? 'présent' : 'absent'} ; Laruns : ${a2.results.filter(x => x.ref === '26-105970').map(x => 'présent niveau ' + x.location_level).join('') || 'absent'}`,
    !a1.results.some(x => x.ref === '26-105970') && a2.results.some(x => x.ref === '26-105970' && x.location_level === 0));
  const p33 = await S({ department: '33' }), p90 = await S({ department: '90' });
  T('Publié dans un département, exécuté dans un autre', '26-102762 (publié en 33, chantier à Lepuix 90) : department=33, department=90', 'Absent de la Gironde, présent dans le 90',
    `33 : ${p33.results.some(x => x.ref === '26-102762') ? 'présent' : 'absent'} ; 90 : ${p90.results.some(x => x.ref === '26-102762') ? 'présent' : 'absent'}`, !p33.results.some(x => x.ref === '26-102762') && p90.results.some(x => x.ref === '26-102762'));
  const m1 = await S({ city: 'Biganos' }), m2 = await S({ city: 'Arcachon' });
  const dup = p33.results.length - new Set(p33.results.map(x => x.id)).size;
  T('Marché multisite', '26-100506 (Arcachon + Biganos) : city=Biganos, city=Arcachon, department=33', 'Présent dans les deux communes, compté une seule fois dans le département',
    `Biganos : ${m1.results.some(x => x.ref === '26-100506') ? 'oui' : 'non'} ; Arcachon : ${m2.results.some(x => x.ref === '26-100506') ? 'oui' : 'non'} ; doublons dans le 33 : ${dup}`, m1.results.some(x => x.ref === '26-100506') && m2.results.some(x => x.ref === '26-100506') && dup === 0);
  const d1 = await S({ city: 'Saint-Médard-en-Jalles' });
  const x98922 = d1.results.find(x => x.ref === '26-98922'); const x98922d = p33.results.find(x => x.ref === '26-98922');
  T('Lieu connu seulement au niveau du département', '26-98922 (« (33) Gironde », acheteur à Saint-Médard-en-Jalles)', 'Ville de l’acheteur : niveau 1 (acheteur seul, signalé) ; département 33 : niveau 0',
    `ville : ${x98922 ? 'niveau ' + x98922.location_level : 'absent'} ; 33 : ${x98922d ? 'niveau ' + x98922d.location_level : 'absent'}`, x98922?.location_level === 1 && x98922d?.location_level === 0);
  const u = p33.results.find(x => x.ref === 'TEST-INCONNU');
  T('Lieu inconnu', 'TEST-INCONNU (« Plusieurs lieux », acheteur à Bordeaux 33) : department=33', 'Inclus comme « acheteur seul » (niveau 1), lieu d’exécution affiché « non précisé », jamais en tête des résultats exacts',
    u ? `niveau ${u.location_level}, exec ${u.exec_status}, rang ${p33.results.indexOf(u) + 1}/${p33.results.length}` : 'absent', !!u && u.location_level === 1 && u.exec_status === 'inconnu');
  const v = p33.results.find(x => x.ref === 'TEST-SANSDATE') || (await S({ city: 'Bordeaux' })).results.find(x => x.ref === 'TEST-SANSDATE');
  const firstVerify = p33.results.findIndex(x => x.state_rank === 1), lastOpen = p33.results.map(x => x.state_rank).lastIndexOf(0);
  T('Annonce sans échéance', 'TEST-SANSDATE (Bordeaux, pas de date limite)', 'État « à vérifier », classée après toutes les annonces ouvertes', `${v ? v.open_state : 'absent'} ; dernière ouverte au rang ${lastOpen + 1}, première à vérifier au rang ${firstVerify + 1}`, v?.open_state === 'verify' && (firstVerify === -1 || firstVerify > lastOpen));
  const all = await S({ city: 'Bordeaux' }); const act = await S({ city: 'Bordeaux', status: 'active' });
  const c1 = all.results.find(x => x.ref === 'TEST-CLOS'), c2 = all.results.find(x => x.ref === 'TEST-ANNUL');
  T('Annonce clôturée ou annulée', 'TEST-CLOS, TEST-ANNUL (Bordeaux) : sans filtre, puis status=active', 'Sans filtre : marquées « clôturée » / « annulée » et classées en dernier ; avec status=active : exclues',
    `sans filtre : ${c1?.open_state}, ${c2?.open_state} ; status=active : ${act.results.some(x => ['TEST-CLOS', 'TEST-ANNUL'].includes(x.ref)) ? 'encore présentes' : 'exclues'}`, c1?.open_state === 'closed' && c2?.open_state === 'cancelled' && !act.results.some(x => ['TEST-CLOS', 'TEST-ANNUL'].includes(x.ref)));
  const z = await S({ q: 'zqxwvj' });
  T('Recherche sans résultat', 'q=zqxwvj', '0 résultat, liste vide (aucun remplissage)', `${z.pagination.total} / ${z.results.length}`, z.pagination.total === 0 && z.results.length === 0);
  for (const sort of ['deadline', 'amount', 'recent']) {
    const s2 = await S({ department: '33', sort });
    const grp = s2.results.filter(x => x.state_rank === 0 && x.location_level === 0);
    const key = x => sort === 'deadline' ? Date.parse(x.deadline_checked) : sort === 'amount' ? -(x.estimated_value == null ? -1 : Number(x.estimated_value)) : -Date.parse(x.publication_date || 0);
    const mono = grp.every((x, k) => k === 0 || key(grp[k - 1]) <= key(x));
    T(`Tri « ${sort} » avec filtre département`, `department=33, sort=${sort}`, 'Dans le groupe exact et ouvert, ordre conforme à l’intitulé ; montants absents en dernier', `${grp.length} annonces du groupe exact ; ordre ${mono ? 'conforme' : 'NON conforme'}`, mono);
  }
  const pages = []; let tot = 0;
  for (let p = 1; p <= 10; p++) { const o = await S({ department: '33', limit: '10', page: String(p) }); tot = o.pagination.total; pages.push(...o.results.map(x => x.id)); if (o.results.length < 10) break; }
  T('Pagination', 'department=33, 10 par page, pages 1 → fin', 'Union des pages = total, aucun doublon ni absent', `total ${tot}, vus ${pages.length}, distincts ${new Set(pages).size}`, pages.length === tot && new Set(pages).size === tot);
  const bd = p33.pagination.breakdown;
  T('Concordance des compteurs', 'department=33 : total vs décompte', 'ouvertes + à vérifier + clôturées = total = exécution + acheteur seul + non relues', `${bd.open}+${bd.verify}+${bd.closed} = ${bd.open + bd.verify + bd.closed} ; ${bd.execution}+${bd.buyerOnly}+${bd.notYetRead} ; total ${p33.pagination.total}`,
    bd.open + bd.verify + bd.closed === p33.pagination.total && bd.execution + bd.buyerOnly + bd.notYetRead === p33.pagination.total);
  const fs = require('fs');
  const md = ['| Scénario | Entrée | Attendu | Obtenu | Conclusion |', '| --- | --- | --- | --- | --- |', ...rows.map(r => `| ${r.name} | ${r.input} | ${r.expected} | ${r.obtained} | ${r.ok ? 'Conforme' : 'ÉCART'} |`)].join('\n');
  fs.writeFileSync('scenarios.md', md); console.log(md);
})().catch(e => console.log('ERREUR', e.message));
