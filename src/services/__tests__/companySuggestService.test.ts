import { classifySuggestQuery, toSuggestions, suggestCompanies } from '../companySuggestService';
import * as sirene from '../sireneClient';

jest.mock('../sireneClient', () => {
  const actual = jest.requireActual('../sireneClient');
  return { ...actual, fetchSirenePage: jest.fn() };
});

const fetchSirenePage = sirene.fetchSirenePage as jest.Mock;

// A raw "result" as returned by recherche-entreprises.api.gouv.fr, mapped by the real mapper.
const apiResult = (over: Record<string, unknown> = {}) => ({
  siren: '123456789',
  nom_complet: 'VERIFRANCE HABITAT',
  nom_raison_sociale: 'VERIFRANCE HABITAT',
  etat_administratif: 'A',
  siege: {
    siret: '12345678900011', activite_principale: '43.22B', code_postal: '92200',
    libelle_commune: 'NEUILLY-SUR-SEINE', departement: '92', etat_administratif: 'A',
  },
  ...over,
});

describe('classifySuggestQuery', () => {
  it('needs 3 characters', () => {
    expect(classifySuggestQuery('ve')).toEqual({ kind: 'too_short' });
    expect(classifySuggestQuery('  ab ')).toEqual({ kind: 'too_short' });
    expect(classifySuggestQuery(undefined)).toEqual({ kind: 'too_short' });
    expect(classifySuggestQuery('ver')).toEqual({ kind: 'text', q: 'ver' });
  });

  it('accepts a SIREN or a SIRET, with spaces', () => {
    expect(classifySuggestQuery('123 456 789')).toEqual({ kind: 'number', q: '123456789' });
    expect(classifySuggestQuery('123 456 789 00011')).toEqual({ kind: 'number', q: '12345678900011' });
  });

  it('does not search a partial number', () => {
    expect(classifySuggestQuery('1234')).toEqual({ kind: 'incomplete_number', q: '1234' });
    expect(classifySuggestQuery('1234567890123')).toEqual({ kind: 'incomplete_number', q: '1234567890123' });
  });

  it('keeps names that contain digits as text', () => {
    expect(classifySuggestQuery('Garage 33')).toEqual({ kind: 'text', q: 'Garage 33' });
  });
});

describe('toSuggestions', () => {
  it('returns one company once, prefers the head office, caps at 3, drops closed ones', () => {
    const records = [
      ...sirene.mapSireneResult(apiResult({
        matching_etablissements: [{ siret: '12345678900029', activite_principale: '43.22B', code_postal: '69001', libelle_commune: 'LYON', departement: '69' }],
      })),
      ...sirene.mapSireneResult(apiResult({ siren: '222222222', nom_complet: 'B', nom_raison_sociale: 'B', siege: { siret: '22222222200011', activite_principale: '56.10A', code_postal: '75001', libelle_commune: 'PARIS', departement: '75' } })),
      ...sirene.mapSireneResult(apiResult({ siren: '333333333', nom_complet: 'C', nom_raison_sociale: 'C', siege: { siret: '33333333300011', activite_principale: '43.21A', code_postal: '33000', libelle_commune: 'BORDEAUX', departement: '33' } })),
      ...sirene.mapSireneResult(apiResult({ siren: '444444444', nom_complet: 'D', nom_raison_sociale: 'D', siege: { siret: '44444444400011', activite_principale: '43.21A', code_postal: '13001', libelle_commune: 'MARSEILLE', departement: '13' } })),
      ...sirene.mapSireneResult(apiResult({ siren: '555555555', nom_complet: 'CLOSED', nom_raison_sociale: 'CLOSED', etat_administratif: 'C', siege: { siret: '55555555500011', activite_principale: '43.21A', code_postal: '13001', libelle_commune: 'MARSEILLE', departement: '13', etat_administratif: 'F' } })),
    ];
    const out = toSuggestions(records);
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({
      siret: '12345678900011', name: 'VERIFRANCE HABITAT', city: 'NEUILLY-SUR-SEINE', department: '92', postal: '92200',
    });
    expect(out[0].activity).toContain('climatisation');
    expect(out[0].naf).toBe('43.22B');
    expect(out.map(s => s.siren)).toEqual(['123456789', '222222222', '333333333']);
  });

  it('keeps the establishment whose SIRET was typed', () => {
    const records = sirene.mapSireneResult(apiResult({
      matching_etablissements: [{ siret: '12345678900029', activite_principale: '43.22B', code_postal: '69001', libelle_commune: 'LYON', departement: '69' }],
    }));
    const out = toSuggestions(records, '12345678900029');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ siret: '12345678900029', city: 'LYON', department: '69' });
  });

  it('never invents an activity for an unknown NAF code', () => {
    const records = sirene.mapSireneResult(apiResult({ siege: { siret: '12345678900011', activite_principale: '99.99Z', code_postal: '75001', libelle_commune: 'PARIS', departement: '75' } }));
    const [s] = toSuggestions(records);
    expect(s.activity).toBeNull();
  });
});

describe('suggestCompanies', () => {
  beforeEach(() => fetchSirenePage.mockReset());

  it('does not call the API below 3 characters or for a partial number', async () => {
    expect(await suggestCompanies('ab')).toEqual({ suggestions: [], hint: 'too_short' });
    expect(await suggestCompanies('12345')).toEqual({ suggestions: [], hint: 'incomplete_number' });
    expect(fetchSirenePage).not.toHaveBeenCalled();
  });

  it('queries once and serves the repeated query from cache', async () => {
    fetchSirenePage.mockResolvedValue({ records: sirene.mapSireneResult(apiResult()), rawCount: 1, skippedNonDiffusible: 0, totalResults: 1, totalPages: 1 });
    const a = await suggestCompanies('verifrance');
    const b = await suggestCompanies('VERIFRANCE');
    expect(a.suggestions).toHaveLength(1);
    expect(b).toEqual(a);
    expect(fetchSirenePage).toHaveBeenCalledTimes(1);
    expect(fetchSirenePage).toHaveBeenCalledWith({ q: 'verifrance', perPage: 8 });
  });

  it('propagates an API failure (the route turns it into a 502)', async () => {
    fetchSirenePage.mockRejectedValue(new Error('down'));
    await expect(suggestCompanies('failing name')).rejects.toThrow('down');
  });
});
