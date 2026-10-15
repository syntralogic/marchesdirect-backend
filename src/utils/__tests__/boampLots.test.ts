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

import { lotsFromDescription } from '../boampLots';
describe('lotsFromDescription', () => {
  it('splits the appended lots back into individual lots', () => {
    const d = withLotsText('Réhabilitation administrative', 'Lot 2 : Etanchéité ; Lot 4 : Electricité CFO-CFA');
    expect(lotsFromDescription(d)).toEqual(['Lot 2 : Etanchéité', 'Lot 4 : Electricité CFO-CFA']);
  });
  it('returns [] when there are no lots', () => {
    expect(lotsFromDescription('Simple objet')).toEqual([]);
    expect(lotsFromDescription(null)).toEqual([]);
  });
});

import { isJunkLot, scrubLotsInDescription } from '../boampLots';
describe('junk lots (15 Oct client report, Saint-Cyr-en-Val)', () => {
  it('flags code-list tokens, appeal boilerplate and cross-references', () => {
    expect(isJunkLot('non-restricted-document')).toBe(true);
    expect(isJunkLot("Cf. le greffe du Tribunal Administratif à l'adresse ci-dessus")).toBe(true);
    expect(isJunkLot('Lot 4 : Electricité CFO-CFA')).toBe(false);
    expect(isJunkLot('Plomberie, sanitaire, Chauffage et Climatisation (hors maintenance)')).toBe(false);
  });
  it('does not take organisation names / access rules found under lot-ish keys', () => {
    const t = extractBoampLotsText({ 'cac:ProcurementProjectLot': [{
      'cbc:ID': 'LOT-0001',
      'cac:ProcurementProject': { 'cbc:Name': 'Peinture, vitrerie, revêtements muraux' },
      'cac:TenderingTerms': { 'cbc:DocumentRestrictionCode': 'non-restricted-document' },
      'cac:AppealTerms': { 'cac:AppealReceiverParty': { 'cbc:Name': 'Cf. le greffe du Tribunal Administratif' } },
      'cac:ContractingParty': { 'cbc:Name': 'AW Solutions' },
    }] });
    expect(t).toBe('Peinture, vitrerie, revêtements muraux');
  });
  it('scrubs junk from an already stored Lots tail, idempotently', () => {
    const stored = 'Travaux d\'entretien\n\nLots : non-restricted-document ; Cf. le greffe du Tribunal Administratif ; Peinture, vitrerie';
    const once = scrubLotsInDescription(stored);
    expect(once).toBe('Travaux d\'entretien\n\nLots : Peinture, vitrerie');
    expect(scrubLotsInDescription(once)).toBe(once);
    expect(scrubLotsInDescription('Travaux\n\nLots : non-restricted-document')).toBe('Travaux');
  });
});
