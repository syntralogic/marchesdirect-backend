import { normalizeApprochRecord } from '../dataCollectionService';

describe('normalizeApprochRecord', () => {
  it('maps a typical project record', () => {
    const r: any = normalizeApprochRecord({
      identifiant: 'P-123',
      intitule: 'Achat de véhicules électriques',
      acheteur: 'Ville de Quimper',
      departement: '29',
      montant: '150 000,5',
    });
    expect(r.source_reference).toBe('P-123');
    expect(r.title).toBe('Achat de véhicules électriques');
    expect(r.buyer_name).toBe('Ville de Quimper');
    expect(r.location_department).toBe('29');
    expect(r.estimated_value).toBe(150000.5);
    expect(r.deadline).toBeNull();
    expect(r.status).toBe('active');
  });

  it('falls back to a stable hash reference when the dataset has no id', () => {
    const a: any = normalizeApprochRecord({ objet: 'Marché de nettoyage', organisme: 'CHU Lyon' });
    const b: any = normalizeApprochRecord({ objet: 'Marché de nettoyage', organisme: 'CHU Lyon' });
    expect(a.source_reference).toMatch(/^approch-/);
    expect(a.source_reference).toBe(b.source_reference);
  });

  it('drops records with no usable title or description', () => {
    expect(normalizeApprochRecord({ foo: 'bar' })).toBeNull();
  });
});
