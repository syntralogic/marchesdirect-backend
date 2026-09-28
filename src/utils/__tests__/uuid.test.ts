import { isUuid } from '../uuid';

describe('isUuid', () => {
  it('accepts canonical uuids in any case', () => {
    expect(isUuid('4d0b96d6-23e6-476c-8276-488944f8f255')).toBe(true);
    expect(isUuid('4D0B96D6-23E6-476C-8276-488944F8F255')).toBe(true);
    expect(isUuid('00000000-0000-0000-0000-000000000000')).toBe(true);
  });

  it('rejects values Postgres would refuse for a uuid column', () => {
    for (const bad of ['not-a-uuid', '123', '', ' ', '4d0b96d6-23e6-476c-8276-488944f8f25', '4d0b96d6-23e6-476c-8276-488944f8f255x', "1' OR '1'='1", undefined, null, 42]) {
      expect(isUuid(bad)).toBe(false);
    }
  });
});
