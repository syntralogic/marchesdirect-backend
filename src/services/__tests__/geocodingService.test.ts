import axios from 'axios';
import { departmentFromGeocodeProps, geocodeCityDetailed, geocodeCity } from '../geocodingService';

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
