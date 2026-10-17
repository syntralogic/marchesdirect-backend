// Appointment slots (guide v24 s.12): the SERVER owns the slot list, in Europe/Paris.
// The same weekday pattern the booking modal used to hard-code client-side.
export const APPOINTMENT_TZ = 'Europe/Paris';
const TIMES_BY_WEEKDAY: string[][] = [
  [], ['09:00', '10:00', '14:00', '15:00'], ['09:30', '11:00', '14:30', '16:00'], ['10:00', '11:30', '15:00'],
  ['09:00', '10:30', '14:00', '16:30'], ['09:00', '10:00', '11:00'], [],
];
const MIN_LEAD_MS = 2 * 3600 * 1000;

function parisParts(ms: number) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: APPOINTMENT_TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p: Record<string, number> = {};
  for (const x of f.formatToParts(new Date(ms))) if (x.type !== 'literal') p[x.type] = parseInt(x.value, 10);
  return p;
}
const offsetMs = (utcMs: number) => { const p = parisParts(utcMs); return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(utcMs / 1000) * 1000; };
/** Europe/Paris wall-clock time -> UTC instant (DST-safe). */
export function parisToUtc(y: number, m: number, d: number, hh: number, mm: number): Date {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let t = guess - offsetMs(guess);
  const o2 = offsetMs(t);
  t = guess - o2;
  return new Date(t);
}
export interface SlotDay { date: string; label: string; slots: { slotAt: string; time: string }[] }
export function generateSlots(now: Date = new Date(), businessDays = 5): SlotDay[] {
  const today = parisParts(now.getTime());
  const out: SlotDay[] = [];
  const cursor = new Date(Date.UTC(today.year, today.month - 1, today.day, 12));
  cursor.setUTCDate(cursor.getUTCDate() + 1); // from tomorrow
  while (out.length < businessDays) {
    const wd = cursor.getUTCDay();
    const times = TIMES_BY_WEEKDAY[wd];
    if (times.length) {
      const y = cursor.getUTCFullYear(), m = cursor.getUTCMonth() + 1, d = cursor.getUTCDate();
      const label = new Intl.DateTimeFormat('fr-FR', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' }).format(cursor);
      const slots = times.map((t) => { const [hh, mm] = t.split(':').map(Number); return { slotAt: parisToUtc(y, m, d, hh, mm).toISOString(), time: t }; })
        .filter((s) => new Date(s.slotAt).getTime() - now.getTime() >= MIN_LEAD_MS);
      if (slots.length) out.push({ date: `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`, label: label.charAt(0).toUpperCase() + label.slice(1), slots });
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}
export function isOfferedSlot(slotAtIso: string, now: Date = new Date()): boolean {
  const t = new Date(slotAtIso).getTime();
  if (!Number.isFinite(t)) return false;
  return generateSlots(now, 14).some((d) => d.slots.some((s) => new Date(s.slotAt).getTime() === t));
}
/** "jeudi 23 octobre 2026 à 10:00 (heure de Paris)" */
export function formatSlotFr(slotAt: Date | string): string {
  const d = new Date(slotAt);
  const date = new Intl.DateTimeFormat('fr-FR', { timeZone: APPOINTMENT_TZ, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(d);
  const time = new Intl.DateTimeFormat('fr-FR', { timeZone: APPOINTMENT_TZ, hour: '2-digit', minute: '2-digit' }).format(d);
  return `${date} à ${time} (heure de Paris)`;
}
export function freeSlotDays(days: SlotDay[], booked: Set<number>): SlotDay[] {
  return days.map((d) => ({ ...d, slots: d.slots.filter((s) => !booked.has(new Date(s.slotAt).getTime())) })).filter((d) => d.slots.length);
}
