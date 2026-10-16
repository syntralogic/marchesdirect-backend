import { classifyPrivateNotice, cleanNoticeText } from '../privateNoticeFilter';

describe('classifyPrivateNotice', () => {
  it('keeps a real call for tenders', () => {
    expect(classifyPrivateNotice("Appel d'offres : rénovation d'un groupe scolaire", 'Remise des offres avant le 12 novembre.')).toBe('tender');
  });
  it('routes sous-traitance requests to the subcontracting journey', () => {
    expect(classifyPrivateNotice('Entreprise générale recherche sous-traitant plâtrerie', 'Chantier à Lyon, consultation ouverte.')).toBe('subcontracting');
  });
  it('skips market commentary that merely contains "marché"', () => {
    expect(classifyPrivateNotice("Le marché de l'immobilier neuf repart", 'Analyse des ventes du trimestre.')).toBe('skip');
  });
  it('skips contract-award news (not open to bids)', () => {
    expect(classifyPrivateNotice("Le marché de la rénovation attribué à Eiffage", "Suite à l'appel d'offres, le groupe remporte le chantier.")).toBe('skip');
  });
  it('skips general product news', () => {
    expect(classifyPrivateNotice('Nouvelle gamme de fenêtres PVC', 'Un fabricant présente sa collection.')).toBe('skip');
  });
});

describe('cleanNoticeText', () => {
  it('strips tags and keeps paragraph breaks', () => {
    expect(cleanNoticeText('<p>Ligne 1</p><p>Ligne&nbsp;2 <b>gras</b></p>')).toBe('Ligne 1\nLigne 2 gras');
  });
  it('handles null', () => expect(cleanNoticeText(null)).toBe(''));
});
