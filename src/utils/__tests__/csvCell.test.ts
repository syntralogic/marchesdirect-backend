import { csvCell } from '../csvCell';

describe('csvCell', () => {
  it('quotes and doubles quotes', () => expect(csvCell('Dupont "SARL"')).toBe('"Dupont ""SARL"""'));
  it('flattens line breaks so a row stays on one line', () => expect(csvCell('a\nb\r\nc')).toBe('"a b c"'));
  it('neutralises formula injection', () => {
    for (const v of ['=SUM(A1)', '+33612345678x', '-1+1', '@cmd']) expect(csvCell(v).startsWith('"\'')).toBe(true);
  });
  it('handles null, numbers and dates', () => {
    expect(csvCell(null)).toBe('""');
    expect(csvCell(12)).toBe('"12"');
    expect(csvCell(new Date('2026-10-01T00:00:00Z'))).toBe('"2026-10-01T00:00:00.000Z"');
  });
});
