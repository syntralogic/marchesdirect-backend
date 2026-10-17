import { generateSlots, isOfferedSlot, formatSlotFr, parisToUtc, freeSlotDays } from '../appointmentSlots';

describe('appointmentSlots', () => {
  const now = new Date('2026-10-17T10:00:00Z'); // Saturday
  it('starts on the next business day, Europe/Paris, 5 days', () => {
    const days = generateSlots(now);
    expect(days).toHaveLength(5);
    expect(days[0].date).toBe('2026-10-19'); // Monday
    expect(days[0].slots[0].slotAt).toBe('2026-10-19T07:00:00.000Z'); // 09:00 CEST = 07:00Z
  });
  it('handles the winter-time switch (DST ends Sun 25 Oct 2026)', () => {
    expect(parisToUtc(2026, 10, 23, 9, 0).toISOString()).toBe('2026-10-23T07:00:00.000Z'); // CEST
    expect(parisToUtc(2026, 10, 26, 9, 0).toISOString()).toBe('2026-10-26T08:00:00.000Z'); // CET
  });
  it('only accepts offered slots', () => {
    expect(isOfferedSlot('2026-10-19T07:00:00.000Z', now)).toBe(true);
    expect(isOfferedSlot('2026-10-19T07:05:00.000Z', now)).toBe(false);
    expect(isOfferedSlot('2026-10-17T12:00:00.000Z', now)).toBe(false);
    expect(isOfferedSlot('garbage', now)).toBe(false);
  });
  it('formats with date, time and Paris timezone', () => {
    expect(formatSlotFr('2026-10-19T07:00:00.000Z')).toBe('lundi 19 octobre 2026 à 09:00 (heure de Paris)');
  });
  it('removes booked slots', () => {
    const days = generateSlots(now);
    const taken = new Set([new Date(days[0].slots[0].slotAt).getTime()]);
    expect(freeSlotDays(days, taken)[0].slots).toHaveLength(days[0].slots.length - 1);
  });
});
