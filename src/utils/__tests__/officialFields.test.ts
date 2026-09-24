import { parseAmountEuro, isGenericBuyer, reconcileOfficialFields } from '../officialFields';

// 25 Sep client audit (école Michelet): header said "Montant non communiqué"
// and "Acheteur public" while the details block showed 350 000 € and the real
// buyer. One resolved value must feed every block.

describe('parseAmountEuro', () => {
  it('reads amounts stated in euros', () => {
    expect(parseAmountEuro('350 000 € HT')).toBe(350000);
    expect(parseAmountEuro('350\u00a0000 EUR')).toBe(350000);
    expect(parseAmountEuro('1 250 000,50 euros')).toBe(1250000.5);
    expect(parseAmountEuro('350000 €')).toBe(350000);
  });
  it('refuses ambiguous or unitless figures rather than guessing', () => {
    expect(parseAmountEuro('350 000')).toBeNull();
    expect(parseAmountEuro('Lot 1 : 100 000 €, lot 2 : 250 000 €')).toBeNull();
    expect(parseAmountEuro('1,2 million d’euros')).toBeNull();
    expect(parseAmountEuro('not available')).toBeNull();
    expect(parseAmountEuro(undefined)).toBeNull();
  });
});

describe('isGenericBuyer', () => {
  it('flags placeholders and accepts real names', () => {
    expect(isGenericBuyer('Acheteur public')).toBe(true);
    expect(isGenericBuyer('not available')).toBe(true);
    expect(isGenericBuyer(null)).toBe(true);
    expect(isGenericBuyer('Ville d’Hénin-Beaumont')).toBe(false);
  });
});

describe('reconcileOfficialFields', () => {
  it('fills an empty amount and buyer from the notice facts', () => {
    const opp: any = {
      estimated_value: null,
      buyer_name: null,
      ai_extracted_facts: {
        estimated_value: { value: '350 000 € HT', available: true },
        buyer_name: { value: 'Ville d’Hénin-Beaumont', available: true },
      },
    };
    reconcileOfficialFields(opp);
    expect(opp.estimated_value).toBe(350000);
    expect(opp.buyer_name).toBe('Ville d’Hénin-Beaumont');
    expect(opp.ai_extracted_facts.estimated_value.value).toBe('350 000 € HT');
  });
  it('lets the column win and rewrites a disagreeing fact', () => {
    const opp: any = {
      estimated_value: '120000',
      buyer_name: 'Mairie de Lyon',
      ai_extracted_facts: { estimated_value: { value: '999 000 EUR', available: true }, buyer_name: { value: 'Autre', available: true } },
    };
    reconcileOfficialFields(opp);
    expect(opp.estimated_value).toBe('120000');
    expect(opp.buyer_name).toBe('Mairie de Lyon');
    expect(opp.ai_extracted_facts.estimated_value.value).toMatch(/120\s000 €/);
  });
  it('leaves everything empty when the notice states nothing', () => {
    const opp: any = { estimated_value: null, buyer_name: null, ai_extracted_facts: { estimated_value: { value: 'not available', available: false } } };
    reconcileOfficialFields(opp);
    expect(opp.estimated_value).toBeNull();
    expect(opp.buyer_name).toBeNull();
  });
  it('does nothing without facts', () => {
    const opp: any = { estimated_value: null, buyer_name: null, ai_extracted_facts: null };
    expect(() => reconcileOfficialFields(opp)).not.toThrow();
  });
});
