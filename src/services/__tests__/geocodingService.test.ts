import axios from 'axios';
import { departmentFromGeocodeProps, geocodeCityDetailed, geocodeCity, cleanCityForGeocoding, cityNameMatches } from '../geocodingService';

jest.mock('axios');
const mockedGet = axios.get as jest.Mock;

describe('departmentFromGeocodeProps', () => {
  it('reads the department from context', () => {
    expect(departmentFromGeocodeProps({ context: '69, Rhône, Auvergne-Rhône-Alpes' })).toBe('69');
    expect(departmentFromGeocodeProps({ context: '2A, Corse-du-Sud, Corse' })).toBe('2A');
    expect(departmentFromGeocodeProps({ context: '971, Guadeloupe, Guadeloupe' })).toBe('971');
  });
  it('falls back to the INSEE citycode prefix', () => {
    expect(departmentFromGeocodeProps({ citycode: '33063' })).toBe('33');
    expect(departmentFromGeocodeProps({ citycode: '97105' })).toBe('971');
    expect(departmentFromGeocodeProps({ citycode: '2B033' })).toBe('2B');
  });
  it('returns null when nothing usable', () => {
    expect(departmentFromGeocodeProps({})).toBeNull();
    expect(departmentFromGeocodeProps(null)).toBeNull();
  });
});

describe('geocodeCityDetailed', () => {
  beforeEach(() => mockedGet.mockReset());

  it('ok: returns lat/lng (swapped from GeoJSON), department and score', async () => {
    mockedGet.mockResolvedValue({ data: { features: [{ geometry: { coordinates: [4.83, 45.76] }, properties: { score: 0.9, context: '69, Rhône, Auvergne-Rhône-Alpes' } }] } });
    const out = await geocodeCityDetailed('Lyon');
    expect(out).toEqual({ status: 'ok', result: { lat: 45.76, lng: 4.83, department: '69', score: 0.9 } });
  });

  it('nomatch: low confidence and empty results', async () => {
    mockedGet.mockResolvedValueOnce({ data: { features: [{ geometry: { coordinates: [1, 2] }, properties: { score: 0.2 } }] } });
    expect((await geocodeCityDetailed('Xyzzy')).status).toBe('nomatch');
    mockedGet.mockResolvedValueOnce({ data: { features: [] } });
    expect((await geocodeCityDetailed('Nowhere')).status).toBe('nomatch');
  });

  it('error: a network failure is NOT reported as nomatch (so it is retried, not stamped 0,0)', async () => {
    mockedGet.mockRejectedValue(new Error('timeout'));
    expect((await geocodeCityDetailed('Lyon')).status).toBe('error');
    expect(await geocodeCity('Lyon')).toBeNull();
  });
});

describe('buyer-style city labels (30 Sep audit: Saint-Étienne (42) came out as 47 / Nouvelle-Aquitaine)', () => {
  beforeEach(() => mockedGet.mockReset());

  it('reduces "Ville de X" to the commune and refuses institutions', () => {
    expect(cleanCityForGeocoding('Ville de Saint Etienne')).toBe('Saint Etienne');
    expect(cleanCityForGeocoding("Commune d'Angoulême")).toBe('Angoulême');
    expect(cleanCityForGeocoding('Bordeaux')).toBe('Bordeaux');
    expect(cleanCityForGeocoding('Saint-Étienne Métropole')).toBeNull();
    expect(cleanCityForGeocoding('Département de la Gironde')).toBeNull();
    expect(cleanCityForGeocoding('')).toBeNull();
  });

  it('compares commune names ignoring accents, hyphens and Saint/St', () => {
    expect(cityNameMatches('Saint Etienne', 'Saint-Étienne')).toBe(true);
    expect(cityNameMatches('St Etienne', 'Saint-Étienne')).toBe(true);
    expect(cityNameMatches('Saint Etienne', 'Saint-Étienne-de-Fougères')).toBe(false);
    expect(cityNameMatches('Lyon', undefined)).toBe(true);
  });

  it('does not call the API at all for an institution label', async () => {
    const out = await geocodeCityDetailed('Saint-Étienne Métropole');
    expect(out.status).toBe('nomatch');
    expect(mockedGet).not.toHaveBeenCalled();
  });

  it('rejects a fuzzy hit on a differently-named commune instead of storing its department', async () => {
    mockedGet.mockResolvedValue({ data: { features: [{ geometry: { coordinates: [0.5, 44.3] }, properties: { score: 0.7, city: 'Saint-Étienne-de-Fougères', context: '47, Lot-et-Garonne, Nouvelle-Aquitaine' } }] } });
    expect((await geocodeCityDetailed('Ville de Saint Etienne')).status).toBe('nomatch');
  });

  it('accepts the right Saint-Étienne', async () => {
    mockedGet.mockResolvedValue({ data: { features: [{ geometry: { coordinates: [4.39, 45.43] }, properties: { score: 0.9, city: 'Saint-Étienne', context: '42, Loire, Auvergne-Rhône-Alpes' } }] } });
    const out = await geocodeCityDetailed('Ville de Saint Etienne');
    expect(out.status).toBe('ok');
    if (out.status === 'ok') expect(out.result.department).toBe('42');
  });
});
