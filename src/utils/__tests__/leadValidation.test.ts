import { isValidLeadPhone } from '../leadValidation';

describe('isValidLeadPhone (DEV-08)', () => {
  it.each([
    '06 00 00 00 00', '0600000000', '+33 6 00 00 00 00', '0033600000000', '01.23.45.67.89',
    '+44 7911 123456', '0044 7911 123456',
  ])('accepts %s', (v) => expect(isValidLeadPhone(v)).toBe(true));

  it.each([
    '', '   ', 'abc', '06 00 00', '060000000', '06000000000', '+33 6 00 00 00', '+33 0 00 00 00 00',
    '0600000000x', '+1', '12345',
  ])('rejects %j', (v) => expect(isValidLeadPhone(v)).toBe(false));

  it('rejects non-strings', () => {
    expect(isValidLeadPhone(undefined)).toBe(false);
    expect(isValidLeadPhone(612345678)).toBe(false);
  });
});
