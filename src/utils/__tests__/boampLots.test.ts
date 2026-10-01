import { extractBoampLotsText, withLotsText } from '../boampLots';

describe('extractBoampLotsText (30 Sep audit: lot Électricité inside a global works title)', () => {
  it('reads legacy LOTS blocks', () => {
    const donnees = JSON.stringify({
      OBJET: { TITRE_MARCHE: 'Travaux pour un micro-tomographe', LOTS: { LOT: [
        { NUM: '1', INTITULE: 'Lot 1 - Gros oeuvre' },
        { NUM: '4', INTITULE: 'Lot 4 - Électricité CFO-CFA', DESCRIPTION: 'Courants forts et faibles' },
      ] } },
    });
    const t = extractBoampLotsText(donnees);
    expect(t).toMatch(/Électricité CFO-CFA/);
    expect(t).toMatch(/Courants forts et faibles/);
    expect(t).not.toMatch(/micro-tomographe/); // global title is not a lot
  });

  it('reads eForms-style lot names and ignores ids/urls/amounts', () => {
    const t = extractBoampLotsText({ 'cac:ProcurementProjectLot': [
      { 'cbc:ID': 'LOT-0004', 'cac:ProcurementProject': { 'cbc:Name': 'Lot 4 : Electricité', 'cbc:Description': 'Installation électrique complète' } },
    ] });
    expect(t).toMatch(/Electricité/);
    expect(t).toMatch(/Installation électrique complète/);
    expect(t).not.toMatch(/LOT-0004/);
  });

  it('is safe on garbage, empty and non-JSON input', () => {
    expect(extractBoampLotsText(null)).toBe('');
    expect(extractBoampLotsText('')).toBe('');
    expect(extractBoampLotsText('not json')).toBe('');
    expect(extractBoampLotsText({ a: 1 })).toBe('');
  });

  it('caps the size', () => {
    const lots = Array.from({ length: 500 }, (_, i) => ({ INTITULE: `Lot ${i} - prestation numéro ${i} très détaillée` }));
    expect(extractBoampLotsText({ LOTS: lots }).length).toBeLessThanOrEqual(3000);
  });
});

describe('withLotsText', () => {
  it('appends once and never duplicates', () => {
    const d = withLotsText('Travaux', 'Lot 4 - Électricité');
    expect(d).toBe('Travaux\n\nLots : Lot 4 - Électricité');
    expect(withLotsText(d, 'Lot 4 - Électricité')).toBe(d);
    expect(withLotsText('Travaux', '')).toBe('Travaux');
  });
});
