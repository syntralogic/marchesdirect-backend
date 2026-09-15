import { decodeHtmlEntities } from '../textSanitize';

describe('decodeHtmlEntities', () => {
  it('decodes the exact case from the client contre-audit (15 Sep, R07)', () => {
    expect(decodeHtmlEntities('Plâtrerie &#8211; cloisons')).toBe('Plâtrerie – cloisons');
  });

  it('decodes hex numeric references', () => {
    expect(decodeHtmlEntities('Plâtrerie &#x2013; cloisons')).toBe('Plâtrerie – cloisons');
  });

  it('decodes the common named entities', () => {
    expect(decodeHtmlEntities('Travaux &amp; fournitures')).toBe('Travaux & fournitures');
    expect(decodeHtmlEntities('&lt;lot 3&gt;')).toBe('<lot 3>');
    expect(decodeHtmlEntities('&quot;lot 3&quot;')).toBe('"lot 3"');
    expect(decodeHtmlEntities('L&apos;école')).toBe("L'école");
  });

  it('leaves plain text untouched', () => {
    expect(decodeHtmlEntities('Rénovation de la toiture')).toBe('Rénovation de la toiture');
  });

  it('passes through null/undefined/empty unchanged', () => {
    expect(decodeHtmlEntities(null)).toBeNull();
    expect(decodeHtmlEntities(undefined)).toBeUndefined();
    expect(decodeHtmlEntities('')).toBe('');
  });

  it('leaves an unrecognized entity-like sequence alone rather than guessing', () => {
    expect(decodeHtmlEntities('A &notreal; B')).toBe('A &notreal; B');
  });
});
