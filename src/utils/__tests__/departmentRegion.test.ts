import { extractDepartmentCodeFromFreeText, extractDepartmentCode } from '../departmentRegion';

// 25 Sep audit ("location jin pe nahi hai"): a slice of opportunities have
// no structured department field, but the notice text still names a place
// with a postal code. These lock in the fallback's match behaviour - most
// importantly, that it never fires on plain numeric noise (a year, a SIRET
// fragment, a budget) that only coincidentally looks like a 5-digit run.
describe('extractDepartmentCodeFromFreeText', () => {
  it('resolves a department from a "CP Ville" pattern in an address field', () => {
    expect(extractDepartmentCodeFromFreeText({ adresse_acheteur: '12 rue de la Mairie, 31000 Toulouse' })).toBe('31');
    expect(extractDepartmentCodeFromFreeText({ objet: "Rénovation de l'école Michelet, 75015 Paris" })).toBe('75');
  });

  it('resolves an overseas 3-digit department', () => {
    expect(extractDepartmentCodeFromFreeText({ objet: 'Maintenance des locaux, 97400 Saint-Denis' })).toBe('974');
  });

  it('prefers structured extractDepartmentCode over free text when both exist', () => {
    const raw = { departement: '33', objet: 'Travaux divers, 75015 Paris (siège social)' };
    expect(extractDepartmentCode(raw)).toBe('33');
  });

  it('does not match a bare digit run with no place name (years, amounts, SIRET fragments)', () => {
    expect(extractDepartmentCodeFromFreeText({ objet: 'Marché reconductible jusqu\'en 2026, budget 350000' })).toBeNull();
    expect(extractDepartmentCodeFromFreeText({ objet: 'Réf. dossier 44123 - lot unique' })).toBeNull();
  });

  it('returns null when there is nothing to scan', () => {
    expect(extractDepartmentCodeFromFreeText(null)).toBeNull();
    expect(extractDepartmentCodeFromFreeText({})).toBeNull();
  });

  it('falls through BOAMP fields nesting (record.fields) the same as extractDepartmentCode', () => {
    expect(extractDepartmentCodeFromFreeText({ fields: { objet: 'Nettoyage des locaux, 69003 Lyon' } })).toBe('69');
  });
});
