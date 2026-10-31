import { reserveSlot, releaseBooking, attachBooking, upcomingBookingFor, slotInfo } from '../services/appointmentService';
import { createHash } from 'crypto';
import { Router, Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
import { db } from '../config/database';
import { logger } from '../utils/logger';
import { syncLeadToCrm } from '../services/crmSyncService';
import { sendAppointmentConfirmation } from '../services/appointmentConfirmationService';
import { scheduleFollowUps, stopFollowUpsForEmail } from '../services/followUpService';
import { applyContactChoice, parseContactMode } from '../services/contactPreferenceService';
import { toE164French } from '../services/smsService';
import { notifyTeamOfNewLead } from '../services/leadNotificationService';
import { isValidLeadPhone } from '../utils/leadValidation';

// Contre-audit follow-up: crm_leads.phone was stored exactly as typed
// ("06 00 00 00 00", "0033600000000", "+33 6 00 00 00 00", ...), so the
// same visitor's number rendered differently everywhere it was displayed
// (AdminContacts/AdminLeads) and a chargé d'affaires calling it back had to
// re-read/re-type it. Normalize to E.164 (+33XXXXXXXXX) for storage, but
// only when it actually looks like a French number - anything else (a
// foreign number, a typo, stray text) is kept as the visitor typed it,
// same as before, since this field is informational and not hard-validated
// (see the phone validator comment above).
const FR_E164_RE = /^\+33[1-9]\d{8}$/;
function normalizeLeadPhone(phone: string | undefined | null): string | undefined | null {
  if (!phone) return phone;
  const normalized = toE164French(phone);
  return FR_E164_RE.test(normalized) ? normalized : phone;
}

const router = Router();

// What the visitor is told when a request is saved: the server's own save time
// (never the browser clock) and the timezone it should be read in.
function recordedInfo(createdAt: unknown): { recordedAt?: string; timezone: string } {
  const d = createdAt ? new Date(createdAt as any) : null;
  return { ...(d && !Number.isNaN(d.getTime()) ? { recordedAt: d.toISOString() } : {}), timezone: 'Europe/Paris' };
}

// Mounted at /api/crm/leads in server.ts, BEFORE the authenticated /api/crm
// router, so this specific path is reachable without a session - matches how
// a real pricing/contact page lead form works (submitted by a visitor who
// doesn't have an account yet).

// POST /api/crm/leads - capture a new lead (public)
//
// email is intentionally optional here: the callback-request flow only
// collects a phone number by design (no email field in that form), so
// requiring email would force the frontend to fabricate one just to pass
// validation - which would pollute crm_leads.email and get forwarded to the
// real CRM on sync. Instead we validate email's *format* when present, and
// separately require that at least one contact method (email or phone) was
// actually provided.
router.post(
  '/',
  [
    body('brandId').notEmpty().withMessage('brandId manquant'),
    // DEV-08: server-side validation of the same fields the forms mark as required.
    body('firstName').isString().trim().notEmpty().withMessage('Le nom est requis.').bail()
      .isLength({ max: 100 }).withMessage('Le nom est trop long (100 caractères maximum).'),
    body('message').optional({ checkFalsy: true }).isString().isLength({ max: 5000 }).withMessage('Le message est trop long (5000 caractères maximum).'),
    body('email').optional({ checkFalsy: true }).trim().isEmail().withMessage("L'adresse e-mail n'est pas valide.").normalizeEmail(),
    // DEV-08: a phone, when given, must be a complete dialable number (the old
    // "informational, never reject" stance let truncated/garbage numbers reach
    // the team). Still optional here - email OR phone is required below.
    body('phone').optional({ checkFalsy: true }).isString().trim()
      .custom((v) => isValidLeadPhone(v)).withMessage('Le numéro de téléphone n\'est pas valide.'),
    body('sessionId').optional({ checkFalsy: true }).isString().trim().isLength({ max: 100 }),
    body('slotAt').optional({ checkFalsy: true }).isISO8601().withMessage('Créneau invalide.'),
    body('idempotencyKey').optional({ checkFalsy: true }).isString().trim().isLength({ min: 8, max: 100 }).withMessage('Clé de requête invalide.'),
  ],
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      // Was always the literal string 'Validation failed' with no detail -
      // getApiErrorMessage() on the frontend reads exactly that and only
      // that, so every rejection here (whatever the actual field/reason)
      // showed the same unhelpful message with nothing to act on. Surface
      // the first concrete validator message instead.
      return res.status(400).json({ error: errors.array()[0].msg || 'Validation failed', details: errors.array() });
    }
    if (!req.body.email && !req.body.phone) {
      return res.status(400).json({ error: 'Un email ou un téléphone est requis' });
    }

    try {
      const {
        brandId, firstName, lastName, email, companyName,
        industryTrade, locationCity, locationRegion, leadSource, message, sessionId,
      } = req.body;
      const phone = normalizeLeadPhone(req.body.phone);
      // Idempotency (guide v24 s.12): the same key = the same request. A retry after a
      // timeout / double-click returns the request that was already recorded.
      const idemRaw = req.body.idempotencyKey || req.get('Idempotency-Key') || '';
      const idempotencyKey = typeof idemRaw === 'string' && idemRaw.trim().length >= 8 ? idemRaw.trim().slice(0, 100) : null;
      // Two identical clicks that arrive at the same instant both pass the "last 20 seconds" check below before either
      // row exists. Without a client key, a derived key (same visitor, same content, same 20 s window) lets the
      // unique index decide atomically which one is recorded.
      const insertKey = idempotencyKey || (sessionId
        ? 'auto:' + createHash('sha1').update([brandId, sessionId, leadSource || 'website_form', email || '', phone || '', message || '', req.body.slotAt || '', Math.floor(Date.now() / 20000)].join('|')).digest('hex')
        : null);
      if (idempotencyKey) {
        const prior = await db.query('SELECT id, created_at, appointment_slot_at FROM crm_leads WHERE brand_id = $1 AND idempotency_key = $2 LIMIT 1', [brandId, idempotencyKey]);
        if (prior.rows.length > 0) {
          return res.status(200).json({ success: true, id: prior.rows[0].id, duplicate: true, ...recordedInfo(prior.rows[0].created_at), ...(prior.rows[0].appointment_slot_at ? slotInfo(prior.rows[0].appointment_slot_at) : {}) });
        }
      }

      // DEV-08: "prévenir les demandes en double lors d'un double-clic ou
      // d'une relance réseau". A double-click (button re-enabled between
      // renders) or an axios retry on a timed-out-but-actually-succeeded
      // request used to insert a second crm_leads row - which meant a second
      // CRM sync and a second "nouvelle demande" email to the team for one
      // visitor action. ContactPage/CallbackModal/AppointmentModal all send
      // the same stable per-visit sessionId (getSessionId()), so a same
      // brand+session submission in the last 20s is almost certainly a
      // retry, not a second genuine request - return the existing lead's id
      // instead of inserting again. Scoped tight (20s, same session) so a
      // visitor who legitimately submits twice later in the same visit
      // (e.g. callback now, contact form later) is never blocked.
      // Same-session AND same content: the earlier version matched on session
      // alone, so a visitor who sent a callback and then, within 20 s, a contact
      // message got the second one silently dropped while being told it had
      // succeeded - a success must only be confirmed for a request that was
      // really recorded. A retry/double-click repeats the exact same payload.
      if (sessionId) {
        const dup = await db.query(
          `SELECT id, created_at FROM crm_leads
           WHERE brand_id = $1 AND session_id = $2 AND created_at > NOW() - INTERVAL '20 seconds'
             AND lead_source = $3
             AND COALESCE(email, '') = $4
             AND COALESCE(phone, '') = $5
             AND COALESCE(message, '') = $6
           ORDER BY created_at DESC LIMIT 1`,
          [brandId, sessionId, leadSource || 'website_form', email || '', phone || '', message || '']
        );
        if (dup.rows.length > 0) {
          logger.info(`Duplicate lead submission suppressed (session ${sessionId}, existing id ${dup.rows[0].id})`);
          return res.status(200).json({ success: true, id: dup.rows[0].id, duplicate: true, ...recordedInfo(dup.rows[0].created_at) });
        }
      }

      // RDV (guide v24 s.12): a slot is confirmed only after an atomic reservation.
      let bookingId: string | null = null;
      let slotDate: Date | null = null;
      if (req.body.slotAt) {
        if (email) {
          const mine = await upcomingBookingFor(email);
          if (mine) return res.status(200).json({ success: true, id: mine.lead_id, alreadyBooked: true, ...slotInfo(mine.slot_at) });
        }
        const r = await reserveSlot(req.body.slotAt, null);
        if (!r.ok) return res.status(r.status).json(r.body);
        bookingId = r.bookingId; slotDate = r.slotDate;
      }
      const slotNote = slotDate ? `Rendez-vous confirmé : ${slotInfo(slotDate).slotLabel}` : null;
      const finalMessage = slotNote ? [message, slotNote].filter(Boolean).join('\n') : message;
      let result: any;
      try {
      result = await db.query(
        `INSERT INTO crm_leads
          (brand_id, first_name, last_name, email, phone, company_name, industry_trade,
           location_city, location_region, lead_source, message, session_id, idempotency_key, appointment_mode, appointment_slot_at, crm_sync_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 'pending')
         RETURNING id, created_at`,
        [
          brandId, firstName, lastName, email, phone, companyName,
          industryTrade, locationCity, locationRegion, leadSource || 'website_form', finalMessage, sessionId || null, insertKey,
          slotDate ? 'slot' : null, slotDate ? slotDate.toISOString() : null,
        ]
      ).catch(async (e: any) => {
        // Two concurrent requests with the same key: the unique index lets one win; the other gets that row.
        if (e?.code === '23505' && insertKey) {
          const won = await db.query('SELECT id, created_at FROM crm_leads WHERE brand_id = $1 AND idempotency_key = $2 LIMIT 1', [brandId, insertKey]);
          if (won.rows.length > 0) return { rows: won.rows, duplicate: true } as any;
        }
        throw e;
      });
      } catch (insertErr) {
        if (bookingId) await releaseBooking(bookingId); // never keep a slot without a saved request
        throw insertErr;
      }
      if ((result as any).duplicate) {
        if (bookingId) await releaseBooking(bookingId);
        return res.status(200).json({ success: true, id: result.rows[0].id, duplicate: true, ...recordedInfo(result.rows[0].created_at) });
      }
      if (bookingId) await attachBooking(bookingId, result.rows[0].id);

      // Intentionally return only id/created_at, not the full row - this is a
      // public endpoint, no need to echo back internal CRM sync fields.
      res.status(201).json({ success: true, id: result.rows[0].id, ...recordedInfo(result.rows[0].created_at), ...(slotDate ? slotInfo(slotDate) : {}) });

      // Fire-and-forget: the visitor's form submission must not wait on (or
      // fail because of) an external CRM API call. Sync status/errors land on
      // the crm_leads row itself (crm_sync_status/crm_last_sync), visible via
      // GET /api/crm/leads for staff, and jobs/crmRetry.ts sweeps up anything
      // that didn't sync on the first attempt.
      syncLeadToCrm(result.rows[0].id).catch((err) => {
        logger.error('Unexpected error firing CRM sync:', err);
      });
      if (bookingId) sendAppointmentConfirmation(result.rows[0].id).catch((err) => logger.error('Appointment confirmation error:', err));
      // Reminders: an appointment ends them, a plain dossier/callback request starts them (still inert until enabled).
      if (bookingId) { if (email) stopFollowUpsForEmail(email, 'appointment_booked').catch(() => {}); }
      else scheduleFollowUps(result.rows[0].id).catch(() => {});
      { const cm = parseContactMode((req.body as any).contactMode); if (cm && email) applyContactChoice(email, cm).catch((err) => logger.error('contact choice error:', err)); }

      // Tell the team right away (email) - also fire-and-forget, never
      // affects the visitor's response.
      notifyTeamOfNewLead({
        id: result.rows[0].id,
        firstName, lastName, email, phone, companyName,
        industryTrade, locationCity, locationRegion,
        leadSource: leadSource || 'website_form',
        message,
      }).catch((err) => {
        logger.error('Unexpected error firing lead notification:', err);
      });
    } catch (err: any) {
      logger.error('Public CRM lead capture error:', err);
      res.status(500).json({ error: 'Failed to submit — please try again' });
    }
  }
);

export default router;
