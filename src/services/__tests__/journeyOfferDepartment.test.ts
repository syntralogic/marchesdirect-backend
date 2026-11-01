import { offerDepartment } from '../journeyOfferDepartment';
import { describeOffer } from '../journeyOfferPresentation';

const boamp = (form: any) => ({location_country: 'FR', raw_data: {donnees: JSON.stringify(form)}});

it('uses execution postal codes before the buyer and publication departments', () => {
  const offer = boamp({MAPA: {organisme: {adr: {cp: '75006'}}, initial: {description: {
    lieuExecutionLivraison: {voie: {nomvoie: 'rue Trinqué'}, cp: '09200', ville: 'Saint-Girons'},
  }}}});
  expect(offerDepartment(offer)).toBe('09');
  expect(offerDepartment({...offer, location_department: '74'})).toBe('74');
  expect(offerDepartment({raw_data: {code_departement: ['9', '31', '34', '64']}})).toBeUndefined();
});

it.each([
  ['Paris 75008', '75'], ['Rue du Closet, 74230 THONES', '74'], ['Chénérailles-23130', '23'],
  ['97400 Saint-Denis', '974'], ['20100 Sartène', '2A'], ['20200 Bastia', '2B'],
])('handles actual notice address form %s', (address, department) => {
  expect(offerDepartment(boamp({FNSimple: {initial: {lots: {lot: [
    {lieuExecutionLivraison: address}, {lieuExecutionLivraison: address},
  ]}}}}))).toBe(department);
});

it('falls back to the buyer address only if execution has no usable postal code', () => {
  expect(offerDepartment(boamp({MAPA: {organisme: {adr: {cp: '75195'}}, initial: {
    description: {lieuExecutionLivraison: {voie: {nomvoie: 'Ile de France'}}},
  }}}))).toBe('75');
  expect(offerDepartment({raw_data: {fields: {adresse_acheteur: '12 rue de la Mairie, 31000 Toulouse'}}})).toBe('31');
});

it('does not invent a department from unrelated numbers, malformed or foreign data', () => {
  for (const raw of [null, 'invalid', {objet: 'Réf. 44123 Paris', siret: '12345678900012'},
    {donnees: '{bad json'}, {organisme: {siret: '12345678900012', telephone: '75008', cp: 9200}},
    {lieuExecution: '99999 Ville'}, {lieuExecution: '00000 Ville'}]) {
    expect(offerDepartment({raw_data: raw})).toBeUndefined();
  }
  expect(offerDepartment({location_country: 'DE', raw_data: {lieuExecution: '10115 Berlin'}})).toBeUndefined();
});

it('omits conflicting execution departments instead of assigning the buyer location', () => {
  const offer = boamp({FNSimple: {organisme: {cp: '75006'}, initial: {lots: {lot: [
    {lieuExecutionLivraison: '33000 Bordeaux'}, {lieuExecutionLivraison: '69003 Lyon'},
  ]}}}});
  expect(offerDepartment(offer)).toBeUndefined();
  const line = describeOffer({...offer, title: 'Travaux'}, new Date());
  expect(line).toMatch(/^Travaux · /);
  expect(line).not.toContain('non renseigné)');
  expect(line).not.toContain('()');
});
