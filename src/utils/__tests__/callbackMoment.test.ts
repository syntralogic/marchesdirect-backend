import { parseCallbackMoment, withCallbackMoment } from '../callbackMoment';

describe('callback moment', () => {
  it('accepts only the three moments', () => {
    expect(parseCallbackMoment('maintenant')).toBe('maintenant');
    expect(parseCallbackMoment('apres_midi')).toBe('apres_midi');
    expect(parseCallbackMoment('demain_matin')).toBe('demain_matin');
    expect(parseCallbackMoment('soir')).toBeNull();
    expect(parseCallbackMoment(undefined)).toBeNull();
    expect(parseCallbackMoment(3)).toBeNull();
  });
  it('puts the moment first in the message the team reads', () => {
    expect(withCallbackMoment(null, 'apres_midi')).toBe('Moment souhaité pour le rappel : Cet après-midi');
    expect(withCallbackMoment('Bonjour', 'demain_matin')).toBe('Moment souhaité pour le rappel : Demain matin\nBonjour');
  });
  it('leaves the message alone without a moment', () => {
    expect(withCallbackMoment('  Bonjour ', null)).toBe('Bonjour');
    expect(withCallbackMoment('', null)).toBeNull();
  });
});
