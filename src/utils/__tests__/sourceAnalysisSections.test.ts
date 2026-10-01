import { buildSourceAnalysisSections } from '../sourceAnalysisSections';

describe('buildSourceAnalysisSections (30 Sep audit, point 1)', () => {
  const opp = {
    title: 'Réhabilitation administrative',
    description: 'Réhabilitation du bâtiment.\n\nLots : Lot 2 : Etanchéité ; Lot 4 : Electricité CFO-CFA',
    location_city: 'Châlons-en-Champagne', location_department: '51', location_region: 'Grand Est',
    deadline: '2026-10-28T12:00:00Z', estimated_value: null, trade_name: 'Électricité',
  };
  it('fills the 3 accordions from the source only', () => {
    const s = buildSourceAnalysisSections(opp);
    expect(s.presentation).toContain('Lot 4 : Electricité CFO-CFA');
    expect(s.presentation).toContain('Châlons-en-Champagne');
    expect(s.conditions).toContain('28 octobre 2026');
    expect(s.entreprises).toContain('Électricité');
  });
  it('says clearly what is missing instead of inventing it', () => {
    const s = buildSourceAnalysisSections({ title: 'Nettoyage des locaux' });
    expect(s.conditions).toContain('non communiquée');
    expect(s.conditions).toContain('Montant estimé : non communiqué');
    expect(s.presentation).toContain('non précisé');
    expect(s.entreprises).toContain('pas précisé');
  });
  it('never uses the buyer name', () => {
    const s = buildSourceAnalysisSections({ title: 'X', buyer_name: 'Ville de Secret' });
    expect(JSON.stringify(s)).not.toContain('Secret');
  });
});
