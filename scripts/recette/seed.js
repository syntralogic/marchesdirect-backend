const { run } = require('./boot.js');
const dc = require(process.env.RECETTE_OUT || './out/services/dataCollectionService.js');
const recs = require(process.env.RECETTE_AVIS || './avis-gironde.json');
require("./out/jobs/noticeLocationJob.js").ensureLocationSchema().then(()=>{}); try{run(`DELETE FROM opportunity_locations`)}catch(e){}; try { run(`DELETE FROM opportunities`); } catch (e) { console.log(e.message.slice(0, 200)); }
let n = 0;
for (const r of recs) {
  const raw = { ...r, donnees: JSON.stringify(r._d) }; delete raw._d;
  const W = (o, k, out = []) => { if (Array.isArray(o)) o.forEach(v => W(v, k, out)); else if (o && typeof o === 'object') for (const [kk, v] of Object.entries(o)) { if (kk === k) out.push(v); W(v, k, out); } return out; };
  const t = (v) => (v && typeof v === 'object' ? v['#text'] : v);
  const pp = W(r._d, 'cac:ProcurementProject')[0];
  raw.objet = t(pp && pp['cbc:Name']) || W(r._d, 'intitule')[0] || W(r._d, 'objet').map(t).find(x => typeof x === 'string') || 'Sans titre';
  const f = dc.normalizeBoampRecord(raw);
  const cut = v => (v == null ? v : String(v).slice(0, 250)); f.title = cut(f.title); f.location_city = cut(f.location_city); f.buyer_name = cut(f.buyer_name);
  run(`INSERT INTO opportunities (source_id, source_reference, title, description, publication_date, deadline, estimated_value, location_city, location_region, location_department, location_country, buyer_name, opportunity_type_id, raw_data, status)
       VALUES (1,$1,$2,$3,NOW() - INTERVAL '5 days',$4,$5,$6,$7,$8,'FR',$9,2,$10,'active')`,
    [f.source_reference, f.title, f.description, f.deadline, f.estimated_value, f.location_city, f.location_region, f.location_department, f.buyer_name, raw]);
  n++;
}
// Cas synthétiques (marqués TEST) : homonymes, annulée, sans échéance, clôturée
const fut = d => new Date(Date.now() + d * 864e5).toISOString();
const add = (ref, title, dl, extra = {}) => run(`INSERT INTO opportunities (source_id, source_reference, title, description, publication_date, deadline, location_city, location_department, location_country, buyer_name, opportunity_type_id, raw_data, status, is_cancelled, created_at)
  VALUES (1,$1,$2,$2,NOW() - INTERVAL '3 days',$3,$4,$5,'FR',$6,2,$7,$8,$9,NOW() - INTERVAL '3 days')`,
  [ref, title, dl, extra.city || null, extra.dept || null, extra.buyer || 'TEST acheteur', extra.raw || {}, extra.status || 'active', !!extra.cancelled]);
const mapa = (ville, cp) => ({ code_departement: [cp.slice(0, 2)], donnees: JSON.stringify({ MAPA: { organisme: { adr: { ville: 'TEST-ACHETEUR', cp: '75001' } }, initial: { description: { lieuExecutionLivraison: { ville, cp } } } } }) });
add('TEST-ROCH17', 'TEST Travaux de plomberie école (17)', fut(12), { raw: mapa('Rochefort', '17300') });
add('TEST-ROCH21', 'TEST Travaux de plomberie salle (21)', fut(12), { raw: mapa('Rochefort', '21510') });
add('TEST-ANNUL', 'TEST Travaux électricité annulés Bordeaux', fut(9), { cancelled: true, raw: mapa('Bordeaux', '33000') });
add('TEST-SANSDATE', 'TEST Maintenance chauffage Bordeaux sans date', null, { raw: mapa('Bordeaux', '33000') });
add('TEST-CLOS', 'TEST Peinture gymnase Bordeaux clôturé', fut(-3), { raw: mapa('Bordeaux', '33000') });
add('TEST-INCONNU', 'TEST Nettoyage locaux lieu inconnu', fut(20), { raw: { code_departement: ['33'], donnees: JSON.stringify({ FNSimple: { organisme: { ville: 'Bordeaux', cp: '33000' }, initial: { natureMarche: { lieuExecution: 'Plusieurs lieux' } } } }) } });
console.log('insérés', n + 6);
