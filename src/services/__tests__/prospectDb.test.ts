import { mapSireneResult } from '../sireneClient';
import { nameSimilarity, matchConfidence, pickBest, haversineM } from '../googlePlacesService';
import { extractFromHtml, normalizeFrPhone, isSafePublicUrl } from '../websiteEnrichmentService';
import { buildWhere, planImportQueries } from '../prospectService';
import { csvField, csvLine, csvHeaderLine, EXPORT_COLUMNS, EXPORT_HEADERS, describeStatus } from '../prospectExport';
import { normalizeNaf, nafInfo, nafCodesForProfession } from '../../utils/prospectNaf';

// Shape follows the documented recherche-entreprises.api.gouv.fr response.
const sample = (over: any = {}) => ({
  siren: '123456789', nom_complet: 'ÉLECTRICITÉ MARTIN', nom_raison_sociale: 'ÉLECTRICITÉ MARTIN', sigle: null,
  nature_juridique: '5710', activite_principale: '43.21A', tranche_effectif_salarie: '11',
  date_creation: '2015-03-02', date_fermeture: null, etat_administratif: 'A', nombre_etablissements: 2,
  finances: { '2022': { ca: 800000, resultat_net: -12000 }, '2023': { ca: 950000, resultat_net: 42000 } },
  complements: { est_rge: true, est_qualiopi: false },
  dirigeants: [{ nom: 'MARTIN', prenoms: 'Hélène', qualite: 'Président', type_dirigeant: 'personne physique' }],
  siege: { siret: '12345678900011', adresse: '12 RUE DES LILAS 69003 LYON', code_postal: '69003', libelle_commune: 'LYON 3E ARRONDISSEMENT', departement: '69', latitude: '45.76', longitude: '4.85', date_creation: '2015-03-02', activite_principale: '43.21A', etat_administratif: 'A' },
  matching_etablissements: [{ siret: '12345678900029', adresse: '4 AVENUE X 73000 CHAMBERY', code_postal: '73000', libelle_commune: 'CHAMBERY', departement: '73', latitude: null, longitude: null, activite_principale: '43.21A', etat_administratif: 'A' }],
  ...over,
});

describe('SIRENE mapping', () => {
  const recs = mapSireneResult(sample());
  it('one record per distinct SIRET, siège flagged', () => {
    expect(recs.map(r => r.siret)).toEqual(['12345678900011', '12345678900029']);
    expect(recs[0].is_head_office).toBe(true); expect(recs[1].is_head_office).toBe(false);
  });
  it('maps identity, NAF, profession, legal form, employees, geography', () => {
    const r = recs[0];
    expect(r).toMatchObject({ siren: '123456789', naf_code: '43.21A', profession: 'electricite', legal_form_label: 'SAS', employee_range: '10 à 19 salariés', department: '69', region: 'Auvergne-Rhône-Alpes', status: 'active' });
    expect(recs[1].region).toBe('Auvergne-Rhône-Alpes'); expect(recs[1].department).toBe('73');
  });
  it('uses latest-year finances, directors on head office only, null coords stay null (not 0)', () => {
    expect(recs[0]).toMatchObject({ revenue_eur: 950000, revenue_year: 2023, net_result_eur: 42000 });
    expect(recs[0].directors).toEqual([{ name: 'Hélène MARTIN', role: 'Président', kind: 'personne' }]);
    expect(recs[1].directors).toEqual([]);
    expect(recs[1].latitude).toBeNull(); expect(recs[0].latitude).toBe(45.76);
  });
  it('certifications only from explicit true flags', () => { expect(recs[0].certifications).toEqual(['RGE (Reconnu Garant de l’Environnement)']); });
  it('missing data is recorded as confirmed_missing, never invented', () => {
    const r = mapSireneResult(sample({ finances: null, tranche_effectif_salarie: null, dirigeants: [], complements: {} }))[0];
    expect(r.revenue_eur).toBeNull(); expect(r.employee_range).toBeNull();
    expect(r.field_meta.revenue.status).toBe('confirmed_missing'); expect(r.field_meta.directors.status).toBe('confirmed_missing');
    expect(r.is_artisan).toBeNull();
  });
  it('skips non-diffusible and invalid SIREN', () => {
    expect(mapSireneResult(sample({ nom_complet: '[NON-DIFFUSIBLE]', nom_raison_sociale: null }))).toEqual([]);
    expect(mapSireneResult(sample({ siren: '12' }))).toEqual([]);
  });
  it('closed company -> closed status', () => {
    expect(mapSireneResult(sample({ etat_administratif: 'C', date_fermeture: '2024-01-31' }))[0]).toMatchObject({ status: 'closed', closure_date: '2024-01-31' });
  });
  it('Corsica and DOM departments', () => {
    const c = mapSireneResult(sample({ siege: { ...sample().siege, siret: '12345678900037', code_postal: '20090', departement: null }, matching_etablissements: [] }))[0];
    expect(c.department).toBe('2A'); expect(c.region).toBe('Corse');
  });
});

describe('NAF / professions', () => {
  it('normalises codes', () => { expect(normalizeNaf('4321a')).toBe('43.21A'); expect(normalizeNaf('43.21A')).toBe('43.21A'); expect(normalizeNaf('abc')).toBeNull(); });
  it('unknown NAF -> profession autre, label null', () => { expect(nafInfo('99.99Z')).toEqual({ label: null, profession: 'autre' }); });
  it('profession -> NAF list', () => { expect(nafCodesForProfession('electricite')).toEqual(['43.21A', '43.21B']); });
});

describe('import planning', () => {
  it('region fans out to its departments x NAF codes', () => {
    const plan = planImportQueries({ profession: 'electricite', region: 'Corse' });
    expect(plan).toHaveLength(4);
  });
  it('rejects empty / invalid', () => {
    expect(() => planImportQueries({})).toThrow();
    expect(() => planImportQueries({ profession: 'nope' })).toThrow();
    expect(() => planImportQueries({ naf: 'zz' })).toThrow();
  });
});

describe('search filters', () => {
  it('binds every placeholder (q is used 4x)', () => {
    const { where, params } = buildWhere({ q: 'martin', profession: 'electricite', city: 'Lyon', department: '69' });
    const max = Math.max(...[...where.matchAll(/\$(\d+)/g)].map(m => Number(m[1])));
    expect(max).toBe(params.length);
    expect(where).not.toContain('$#');
  });
});

describe('Google matching', () => {
  const t = { company_name: 'ÉLECTRICITÉ MARTIN SARL', trading_name: null, postal_code: '69003', latitude: 45.76, longitude: 4.85 };
  it('name similarity ignores accents, legal forms', () => { expect(nameSimilarity('Électricité Martin SARL', 'Electricite Martin')).toBe(1); });
  it('same name + nearby = accepted, other business nearby = rejected', () => {
    const good = { id: 'a', displayName: { text: 'Electricité Martin' }, location: { latitude: 45.7601, longitude: 4.8501 } };
    const bad = { id: 'b', displayName: { text: 'Boulangerie Dupont' }, location: { latitude: 45.7601, longitude: 4.8501 } };
    expect(matchConfidence(t, good)).toBeGreaterThanOrEqual(0.8);
    expect(matchConfidence(t, bad)).toBeLessThan(0.8);
    expect(pickBest(t, [bad, good])!.place.id).toBe('a');
  });
  it('same name but 5 km away is rejected', () => {
    expect(matchConfidence(t, { id: 'c', displayName: { text: 'Electricité Martin' }, location: { latitude: 45.80, longitude: 4.90 } })).toBeLessThan(0.8);
    expect(haversineM(45.76, 4.85, 45.76, 4.85)).toBe(0);
  });
});

describe('website extraction', () => {
  const html = `<a href="https://www.facebook.com/sharer/sharer.php?u=x">share</a>
    <a href="https://fr-fr.facebook.com/martin.electricite/?ref=x">fb</a>
    <a href="https://www.instagram.com/p/abc">post</a><a href="https://www.instagram.com/martin_elec/">ig</a>
    <a href="https://fr.linkedin.com/company/martin-elec?trk=1">li</a>
    <a href="tel:+33 4 72 00 11 22">tel</a><a href="mailto:Contact@Martin-Elec.fr?subject=hi">mail</a>`;
  it('keeps only what the company published; ignores share links', () => {
    expect(extractFromHtml(html)).toEqual({ facebook: 'https://www.facebook.com/martin.electricite', instagram: 'https://www.instagram.com/martin_elec/', linkedin: 'https://www.linkedin.com/company/martin-elec/', phone: '04 72 00 11 22', email: 'contact@martin-elec.fr' });
  });
  it('nothing found -> nulls', () => { expect(extractFromHtml('<p>hello</p>')).toEqual({ facebook: null, instagram: null, linkedin: null, phone: null, email: null }); });
  it('phone normalisation', () => { expect(normalizeFrPhone('0033 1 23 45 67 89')).toBe('01 23 45 67 89'); expect(normalizeFrPhone('123')).toBeNull(); });
  it('SSRF guard', async () => {
    expect(await isSafePublicUrl('http://127.0.0.1/')).toBe(false);
    expect(await isSafePublicUrl('http://10.0.0.5/x')).toBe(false);
    expect(await isSafePublicUrl('file:///etc/passwd')).toBe(false);
    expect(await isSafePublicUrl('http://[::1]/')).toBe(false);
  });
});

describe('export format', () => {
  it('has every client-requested field group', () => {
    for (const h of ['SIRET', 'SIREN', 'Dénomination', 'Activité (libellé NAF)', 'Adresse', 'Téléphone', 'E-mail professionnel', 'Dirigeants / représentants légaux', 'Date de création', 'Forme juridique', 'Site web', 'Page Facebook', 'Instagram', 'LinkedIn', 'Effectif (tranche)', 'Chiffre d’affaires (€)', 'Certifications', 'Historique', 'Lien Google Business Profile / Maps', 'Note Google (/5)', 'Nombre total d’avis Google', 'Avis Google positifs (nombre)', 'Avis Google positifs (%)', 'Sources des champs', 'Champs non renseignés (statut)', 'Département', 'Région', 'Ville'])
      expect(EXPORT_HEADERS).toContain(h);
    expect(new Set(EXPORT_HEADERS).size).toBe(EXPORT_HEADERS.length);
  });
  it('csv: numbers unquoted with decimal comma, negatives not neutralised, text injection neutralised, quotes doubled', () => {
    expect(csvField(-12000.5, 'money')).toBe('-12000,5');
    expect(csvField('=1+1', 'text')).toBe(`"'=1+1"`);
    expect(csvField('Société "Éclair"; Ltd', 'text')).toBe('"Société ""Éclair""; Ltd"');
    expect(csvField(null, 'text')).toBe(''); expect(csvField('', 'number')).toBe('');
    expect(csvField('a\nb', 'text')).toBe('"a b"');
  });
  it('csv line has as many cells as headers', () => {
    expect(csvLine({ siret: '1', field_meta: {} }).split(';').length).toBeGreaterThanOrEqual(EXPORT_COLUMNS.length);
    expect(csvHeaderLine().split(';')).toHaveLength(EXPORT_COLUMNS.length);
  });
  it('status wording', () => {
    expect(describeStatus(undefined)).toBe('non vérifié');
    expect(describeStatus({ status: 'confirmed_missing', source: 'google_places' })).toContain('absent, confirmé (Google Places)');
    expect(describeStatus({ status: 'unavailable', note: 'x' })).toContain('indisponible');
  });
});
