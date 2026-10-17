import { db } from '../config/database';
import { generateSlots, freeSlotDays, isOfferedSlot, formatSlotFr, APPOINTMENT_TZ } from '../utils/appointmentSlots';

export type Reservation =
  | { ok: true; bookingId: string; slotDate: Date }
  | { ok: false; status: number; body: Record<string, unknown> };

export async function freeAlternatives() {
  const booked = await db.query(`SELECT slot_at FROM appointment_bookings WHERE status = 'booked' AND slot_at > NOW()`);
  const taken = new Set<number>(booked.rows.map((r: any) => new Date(r.slot_at).getTime()));
  return freeSlotDays(generateSlots(new Date(), 5), taken);
}

/** Atomically reserves a slot: the partial unique index lets exactly one request win. */
export async function reserveSlot(slotAtIso: string, opportunityId: string | null): Promise<Reservation> {
  if (!slotAtIso || !isOfferedSlot(slotAtIso)) {
    return { ok: false, status: 400, body: { error: "Ce créneau n'est pas proposé. Choisissez un autre créneau.", code: 'slot_invalid' } };
  }
  const slotDate = new Date(slotAtIso);
  try {
    const r = await db.query(`INSERT INTO appointment_bookings (slot_at, opportunity_id) VALUES ($1, $2) RETURNING id`, [slotDate.toISOString(), opportunityId]);
    return { ok: true, bookingId: r.rows[0].id, slotDate };
  } catch (e: any) {
    if (e?.code === '23505') {
      return { ok: false, status: 409, body: { error: "Ce créneau vient d'être pris. Vos informations sont conservées : choisissez un autre créneau.", code: 'slot_taken', timezone: APPOINTMENT_TZ, alternatives: await freeAlternatives() } };
    }
    throw e;
  }
}
export const releaseBooking = (id: string) => db.query(`DELETE FROM appointment_bookings WHERE id = $1`, [id]).catch(() => {});
export const attachBooking = (id: string, leadId: string) => db.query(`UPDATE appointment_bookings SET lead_id = $1 WHERE id = $2`, [leadId, id]);
export async function upcomingBookingFor(email: string) {
  const r = await db.query(
    `SELECT b.slot_at, l.id AS lead_id FROM appointment_bookings b JOIN crm_leads l ON l.id = b.lead_id
     WHERE LOWER(l.email) = LOWER($1) AND b.status = 'booked' AND b.slot_at > NOW() ORDER BY b.slot_at LIMIT 1`, [email]);
  return r.rows[0] || null;
}
export const slotInfo = (d: Date | string) => ({ slotAt: new Date(d).toISOString(), slotLabel: formatSlotFr(d), timezone: APPOINTMENT_TZ });
