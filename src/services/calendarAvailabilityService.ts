import ical from 'node-ical';
import { db } from '../config/database';
import { logger } from '../utils/logger';
import type { SlotDay } from '../utils/appointmentSlots';

// ============================================================================
// REAL CALENDAR AVAILABILITY (client brief 31 Oct, part D: "Agenda et disponibilités réelles")
//
// The weekday pattern in utils/appointmentSlots.ts only says WHEN the team normally takes calls. A slot is
// offered only if it is also free in the team's real calendar:
//   1. APPOINTMENT_BUSY_ICS_URL  - the secret iCal address of the advisors' calendar (Google "Adresse secrète au
//      format iCal", Outlook "ICS publié"). Read-only; recurring events are expanded; events marked "libre"
//      (TRANSP:TRANSPARENT) do not block.
//   2. availability_blocks       - manual blocks (holidays, training) added by staff through the admin endpoint.
// Booked slots stay in appointment_bookings (atomic unique index) - that part is unchanged.
//
// If the calendar feed is configured but cannot be read and no recent copy exists, NO slot is offered (the
// visitor is invited to ask for a callback instead) rather than risk double-booking an advisor.
// APPOINTMENT_CALENDAR_FAIL_OPEN=true flips that to "offer the weekday pattern anyway".
// ============================================================================

export type Busy = { start: number; end: number };
const FRESH_MS = 5 * 60 * 1000;          // re-read the feed at most every 5 minutes
const STALE_OK_MS = 6 * 3600 * 1000;     // a copy up to 6 h old is still trusted when the feed is down
const HORIZON_DAYS = 21;

export const slotMinutes = () => Math.max(10, parseInt(process.env.APPOINTMENT_SLOT_MINUTES || '30', 10) || 30);

let cache: { at: number; busy: Busy[] } | null = null;
let lastFeedError: string | null = null;
export const resetCalendarCache = () => { cache = null; lastFeedError = null; };
export const calendarStatus = () => ({ feedConfigured: Boolean(process.env.APPOINTMENT_BUSY_ICS_URL), lastFeedError, cachedAt: cache ? new Date(cache.at).toISOString() : null });

export function busyFromIcs(text: string, from: Date, to: Date): Busy[] {
  const out: Busy[] = [];
  const parsed = ical.sync.parseICS(text);
  for (const ev of Object.values(parsed) as any[]) {
    if (!ev || ev.type !== 'VEVENT' || !ev.start) continue;
    if (String(ev.transparency || '').toUpperCase() === 'TRANSPARENT') continue;       // shown as "libre"
    if (String(ev.status || '').toUpperCase() === 'CANCELLED') continue;
    const instances = ev.rrule
      ? (ical as any).expandRecurringEvent(ev, { from, to, includeOverrides: true, excludeExdates: true })
      : [{ start: ev.start, end: ev.end || ev.start }];
    for (const i of instances) {
      const s = new Date(i.start).getTime();
      let e = new Date(i.end || i.start).getTime();
      if (!Number.isFinite(s)) continue;
      if (!Number.isFinite(e) || e <= s) e = s + 30 * 60 * 1000;
      if (e > from.getTime() && s < to.getTime()) out.push({ start: s, end: e });
    }
  }
  return out;
}

async function feedBusy(now: Date): Promise<{ ok: boolean; busy: Busy[] }> {
  const url = process.env.APPOINTMENT_BUSY_ICS_URL;
  if (!url) return { ok: true, busy: [] };
  if (cache && now.getTime() - cache.at < FRESH_MS) return { ok: true, busy: cache.busy };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(timer));
    if (!res.ok) throw new Error(`calendar feed HTTP ${res.status}`);
    const busy = busyFromIcs(await res.text(), new Date(now.getTime() - 24 * 3600 * 1000), new Date(now.getTime() + HORIZON_DAYS * 24 * 3600 * 1000));
    cache = { at: now.getTime(), busy };
    lastFeedError = null;
    return { ok: true, busy };
  } catch (err: any) {
    lastFeedError = String(err?.message || err).replace(url, '[feed]').slice(0, 300);
    logger.error(`Calendar feed unreadable: ${lastFeedError}`);
    if (cache && now.getTime() - cache.at < STALE_OK_MS) return { ok: true, busy: cache.busy };
    return { ok: process.env.APPOINTMENT_CALENDAR_FAIL_OPEN === 'true', busy: [] };
  }
}

export async function getBusy(now: Date = new Date()): Promise<{ available: boolean; busy: Busy[] }> {
  const feed = await feedBusy(now);
  let blocks: Busy[] = [];
  try {
    const r = await db.query(`SELECT starts_at, ends_at FROM availability_blocks WHERE ends_at > NOW() - INTERVAL '1 day'`);
    blocks = r.rows.map((x: any) => ({ start: new Date(x.starts_at).getTime(), end: new Date(x.ends_at).getTime() }));
  } catch (err) {
    logger.error('availability_blocks unreadable:', err);
  }
  return { available: feed.ok, busy: [...feed.busy, ...blocks] };
}

export const overlapsBusy = (slotAtMs: number, busy: Busy[], minutes = slotMinutes()) =>
  busy.some((b) => slotAtMs < b.end && slotAtMs + minutes * 60 * 1000 > b.start);

export function removeBusySlots(days: SlotDay[], cal: { available: boolean; busy: Busy[] }): SlotDay[] {
  if (!cal.available) return [];
  return days
    .map((d) => ({ ...d, slots: d.slots.filter((s) => !overlapsBusy(new Date(s.slotAt).getTime(), cal.busy)) }))
    .filter((d) => d.slots.length);
}

/** True when this exact slot is free in the real calendar right now (used again at reservation time). */
export async function isSlotCalendarFree(slotAtIso: string): Promise<boolean> {
  const cal = await getBusy();
  if (!cal.available) return false;
  return !overlapsBusy(new Date(slotAtIso).getTime(), cal.busy);
}
