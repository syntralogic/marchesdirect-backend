import { departmentFromPostal, searchParamsForCompany, openCountDayKey } from '../companySearchParams';

describe('companySearchParams', () => {
  it('derives the department from the head-office postal code', () => {
    expect(departmentFromPostal('69003')).toBe('69');
    expect(departmentFromPostal('92200')).toBe('92');
    expect(departmentFromPostal('20090')).toBe('2A');
    expect(departmentFromPostal('20600')).toBe('2B');
    expect(departmentFromPostal('97400')).toBe('974');
    expect(departmentFromPostal('7500')).toBeNull();
    expect(departmentFromPostal(null)).toBeNull();
  });
  it('derives the métier keyword from the APE code and never invents one', () => {
    expect(searchParamsForCompany('43.21A', '69003')).toMatchObject({ profession: 'electricite', query: 'électricité', department: '69' });
    expect(searchParamsForCompany('4321A', null)).toMatchObject({ query: 'électricité', department: null });
    expect(searchParamsForCompany('99.99Z', '75001')).toMatchObject({ profession: 'autre', query: null, department: '75' });
  });
  it('rolls the daily counter key over at 06:00 Paris time', () => {
    expect(openCountDayKey(new Date('2026-11-04T04:59:00Z'))).toBe('2026-11-03'); // 05:59 Paris
    expect(openCountDayKey(new Date('2026-11-04T05:01:00Z'))).toBe('2026-11-04'); // 06:01 Paris
  });
});
