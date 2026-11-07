import { Router, Request, Response } from 'express';
import { db } from '../config/database';
import { logger } from '../utils/logger';
import { notifyTeamOfNewLead } from '../services/leadNotificationService';
import { clearCache } from '../utils/ttlCache';
import { authenticate, requireRole } from '../middleware/auth';
import { DEPARTMENTS } from '../services/seoV2Service';

// « Publier un besoin » (7 nov., décisions de Hedi) : gratuit pour le donneur d'ordre ; un formulaire ; chaque besoin est
// RELU par l'équipe avant publication ; les candidatures arrivent chez Marchés Direct (Elena), qui fait le tri selon les
// critères donnés par le donneur d'ordre. Les coordonnées du donneur d'ordre restent dans client_needs : elles ne sont
// jamais copiées dans l'annonce publique (le nom de la société est masqué comme pour toute annonce privée).
const router = Router();
const SOURCE_CODE = 'donneurs_ordre';
let regions: Record<string, string> = {};
try { regions = require('../../scripts/_departmentToRegion.json'); } catch { /* région facultative */ }

let ready: Promise<void> | null = null;
const ensure = () => ready ||= (async () => {
  await db.query(`CREATE TABLE IF NOT EXISTS client_needs (
      id SERIAL PRIMARY KEY, reference TEXT UNIQUE, status TEXT NOT NULL DEFAULT 'pending', journey TEXT NOT NULL,
      company_name TEXT NOT NULL, siret TEXT, contact_name TEXT NOT NULL, email TEXT, phone TEXT, client_kind TEXT,
      title TEXT NOT NULL, description TEXT NOT NULL, trades TEXT[] NOT NULL DEFAULT '{}', lots TEXT[] NOT NULL DEFAULT '{}',
      city TEXT, postal_code TEXT, department TEXT NOT NULL, budget_min NUMERIC, budget_max NUMERIC, deadline DATE, start_date DATE,
      duration TEXT, criteria TEXT, recurring BOOLEAN NOT NULL DEFAULT false, session_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), reviewed_at TIMESTAMPTZ, reject_reason TEXT, opportunity_id UUID, closed_at TIMESTAMPTZ)`);
  await db.query(`INSERT INTO data_sources (code, name, feed_type, frequency_hours, active)
      VALUES ($1, 'Besoins publiés par les donneurs d''ordre', 'manual', 24, false) ON CONFLICT (code) DO NOTHING`, [SOURCE_CODE]);
})().catch(e => { ready = null; throw e; });

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, max) : '');
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const money = (v: unknown) => { const n = Number(String(v ?? '').replace(/[\s€]/g, '').replace(',', '.')); return Number.isFinite(n) && n > 0 && n < 1e10 ? Math.round(n) : null; };
const day = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);

// POST /api/needs : dépôt public d'un besoin (en attente de relecture).
router.post('/', async (req: Request, res: Response) => {
  try {
    const b = req.body || {};
    if (str(b.website, 50)) return res.json({ ok: true }); // champ piège anti-robot : on ne dit rien, on n'enregistre rien
    const journey = b.journey === 'subcontracting' ? 'subcontracting' : 'tender';
    const need = {
      company: str(b.companyName, 200), siret: /^\d{14}$/.test(str(b.siret, 20).replace(/\s/g, '')) ? str(b.siret, 20).replace(/\s/g, '') : null,
      contact: str(b.contactName, 120), email: str(b.email, 200).toLowerCase(), phone: str(b.phone, 30).replace(/[^\d+]/g, ''),
      kind: str(b.clientKind, 60) || null, title: str(b.title, 200), description: text(b.description, 5000),
      trades: (Array.isArray(b.trades) ? b.trades : []).map((t: unknown) => str(t, 40)).filter(Boolean).slice(0, 8),
      lots: (Array.isArray(b.lots) ? b.lots : []).map((t: unknown) => str(t, 200)).filter(Boolean).slice(0, 30),
      city: str(b.city, 120) || null, postal: /^\d{5}$/.test(str(b.postalCode, 5)) ? str(b.postalCode, 5) : null,
      dept: str(b.department, 3).toUpperCase(), min: money(b.budgetMin), max: money(b.budgetMax), deadline: day(b.deadline), start: day(b.startDate),
      duration: str(b.duration, 120) || null, criteria: text(b.criteria, 2000) || null, recurring: b.recurring === true,
      session: str(b.sessionId, 100) || null,
    };
    const errors: Record<string, string> = {};
    if (need.company.length < 2) errors.companyName = 'Indiquez le nom de votre société ou organisme.';
    if (need.contact.length < 2) errors.contactName = 'Indiquez votre nom.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(need.email)) errors.email = 'Indiquez une adresse e-mail valide.';
    if (need.phone.replace(/\D/g, '').length < 9) errors.phone = 'Indiquez un numéro de téléphone.';
    if (need.title.length < 10) errors.title = 'Décrivez le besoin en une phrase (10 caractères au moins).';
    if (need.description.length < 30) errors.description = 'Précisez les prestations attendues (30 caractères au moins).';
    if (!DEPARTMENTS[need.dept]) errors.department = 'Choisissez le département des travaux.';
    if (need.min && need.max && need.min > need.max) errors.budgetMax = 'Le budget maximum doit être supérieur au minimum.';
    if (need.deadline && need.deadline < new Date().toISOString().slice(0, 10)) errors.deadline = 'La date de réponse est déjà passée.';
    if (Object.keys(errors).length) return res.status(400).json({ error: 'invalid', fields: errors });
    await ensure();
    const recent = await db.query(`SELECT COUNT(*)::int AS n FROM client_needs WHERE email = $1 AND created_at > NOW() - INTERVAL '24 hours'`, [need.email]);
    if ((recent.rows[0]?.n || 0) >= 10) return res.status(429).json({ error: 'too_many', message: 'Vous avez déjà déposé plusieurs besoins aujourd’hui : notre équipe vous contacte.' });
    const r = await db.query(`INSERT INTO client_needs (journey, company_name, siret, contact_name, email, phone, client_kind, title, description, trades, lots,
        city, postal_code, department, budget_min, budget_max, deadline, start_date, duration, criteria, recurring, session_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) RETURNING id`,
      [journey, need.company, need.siret, need.contact, need.email, need.phone, need.kind, need.title, need.description, need.trades, need.lots,
        need.city, need.postal, need.dept, need.min, need.max, need.deadline, need.start, need.duration, need.criteria, need.recurring, need.session]);
    const id = r.rows[0].id; const reference = `DO-${String(id).padStart(5, '0')}`;
    await db.query(`UPDATE client_needs SET reference = $2 WHERE id = $1`, [id, reference]);
    logger.info(`[besoins] nouveau besoin ${reference} (${journey}, ${need.dept}) en attente de relecture`);
    res.json({ ok: true, reference });
    // 7 nov. : l'équipe est prévenue comme pour tout contact (fiche dans Leads / Contacts, synchronisation CRM,
    // e-mail LEAD_NOTIFICATION_EMAILS si configuré). Un besoin déposé ne doit pas dormir dans les journaux.
    void (async () => {
      try {
        const brandId = (await db.query('SELECT id FROM brands ORDER BY created_at ASC LIMIT 1')).rows[0]?.id;
        if (!brandId) return;
        const msg = [`Besoin ${reference} déposé (${journey === 'subcontracting' ? 'sous-traitance' : 'appel d’offres privé'}) — à relire dans Besoins.`,
          `Objet : ${need.title}`, need.trades.length ? `Métiers : ${need.trades.join(', ')}` : null, `Département : ${need.dept}${need.city ? ` · ${need.city}` : ''}`,
          need.min || need.max ? `Budget : ${[need.min, need.max].filter(Boolean).join(' – ')} €` : null, need.deadline ? `Réponse attendue : ${need.deadline}` : null,
          need.kind ? `Type : ${need.kind}` : null].filter(Boolean).join('\n');
        const l = await db.query(`INSERT INTO crm_leads (brand_id, first_name, email, phone, company_name, location_city, lead_source, message, session_id, crm_sync_status)
          VALUES ($1,$2,$3,$4,$5,$6,'client_need',$7,$8,'pending') RETURNING id`, [brandId, need.contact, need.email, need.phone, need.company, need.city, msg, need.session]);
        await notifyTeamOfNewLead({ id: l.rows[0].id, firstName: need.contact, email: need.email, phone: need.phone, companyName: need.company, locationCity: need.city, leadSource: 'client_need', message: msg });
      } catch (e) { logger.error(`[besoins] notification équipe ${reference} :`, e); }
    })();
  } catch (err) { logger.error('[besoins] dépôt :', err); res.status(503).json({ error: 'unavailable' }); }
});

// ----------------------------------------------------------------------------------- équipe
const team = [authenticate, requireRole(['admin', 'super_admin']), (req: Request, res: Response, next: () => void) => {
  if (req.params.id !== undefined && !/^\d{1,9}$/.test(String(req.params.id))) { res.status(404).json({ error: 'not_found' }); return; }
  next();
}];

router.get('/', ...team, async (req: Request, res: Response) => {
  try {
    await ensure();
    const status = ['pending', 'published', 'rejected', 'closed'].includes(String(req.query.status)) ? String(req.query.status) : null;
    const r = await db.query(`SELECT * FROM client_needs ${status ? 'WHERE status = $1' : ''} ORDER BY (status = 'pending') DESC, created_at DESC LIMIT 300`, status ? [status] : []);
    const c = await db.query(`SELECT status, COUNT(*)::int AS n FROM client_needs GROUP BY 1`);
    res.json({ items: r.rows, counts: Object.fromEntries(c.rows.map((x: any) => [x.status, x.n])) });
  } catch (err) { logger.error('[besoins] liste :', err); res.status(503).json({ error: 'unavailable' }); }
});

function descriptionOf(n: any): string {
  const euro = (x: any) => `${Number(x).toLocaleString('fr-FR')} € HT`;
  const parts = [n.description];
  if (n.lots?.length) parts.push(`Prestations et lots :\n${n.lots.map((l: string) => `• ${l}`).join('\n')}`);
  const facts = [
    n.client_kind ? `Donneur d’ordre : ${n.client_kind}` : null,
    n.budget_min || n.budget_max ? `Budget indicatif : ${n.budget_min && n.budget_max ? `${euro(n.budget_min)} à ${euro(n.budget_max)}` : n.budget_max ? `jusqu’à ${euro(n.budget_max)}` : `à partir de ${euro(n.budget_min)}`}` : null,
    n.start_date ? `Démarrage souhaité : ${new Date(n.start_date).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })}` : null,
    n.duration ? `Durée : ${n.duration}` : null, n.recurring ? 'Contrat récurrent' : null,
  ].filter(Boolean);
  if (facts.length) parts.push(facts.join('\n'));
  if (n.criteria) parts.push(`Critères du donneur d’ordre :\n${n.criteria}`);
  parts.push('Besoin déposé directement auprès de Marchés Direct et relu par notre équipe. Les candidatures sont reçues par Marchés Direct, qui présente au donneur d’ordre les entreprises correspondant à ses critères.');
  return parts.join('\n\n');
}

// POST /api/needs/:id/publish : l'équipe a relu (et éventuellement corrigé) le besoin ; il devient une annonce.
router.post('/:id/publish', ...team, async (req: Request, res: Response) => {
  try {
    await ensure();
    const id = Number(req.params.id);
    const edits = req.body || {};
    // Corrections de l'équipe avant publication (titre, texte, critères) : enregistrées sur le besoin.
    await db.query(`UPDATE client_needs SET title = COALESCE(NULLIF($2, ''), title), description = COALESCE(NULLIF($3, ''), description),
        criteria = COALESCE($4, criteria) WHERE id = $1`, [id, str(edits.title, 200), text(edits.description, 5000), typeof edits.criteria === 'string' ? text(edits.criteria, 2000) : null]);
    const n = (await db.query(`SELECT * FROM client_needs WHERE id = $1`, [id])).rows[0];
    if (!n) return res.status(404).json({ error: 'not_found' });
    const sourceId = (await db.query(`SELECT id FROM data_sources WHERE code = $1`, [SOURCE_CODE])).rows[0]?.id;
    const typeId = (await db.query(`SELECT id FROM opportunity_types WHERE code = $1`, [n.journey])).rows[0]?.id;
    const tradeId = n.trades?.length ? (await db.query(`SELECT id FROM trades WHERE slug = $1`, [n.trades[0]])).rows[0]?.id || null : null;
    const opp = await db.query(`
      INSERT INTO opportunities (source_id, source_reference, opportunity_type_id, trade_id, title, description, publication_date, deadline,
        estimated_value, currency, location_city, location_department, location_region, status, buyer_name, ai_classification_status, ai_summary_status,
        dce_documents_status, raw_data)
      VALUES ($1, $2, $3, $4, $5, $6, CURRENT_DATE, $7::date + TIME '23:59', $8, 'EUR', $9, $10, $11, 'active', $12, 'classified', 'not_generated', 'no_documents_found', $13)
      ON CONFLICT (source_id, source_reference) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, deadline = EXCLUDED.deadline,
        estimated_value = EXCLUDED.estimated_value, status = 'active', deleted_at = NULL, updated_at = NOW()
      RETURNING id`,
      [sourceId, n.reference, typeId, tradeId, n.title, descriptionOf(n), n.deadline, n.budget_max || null, n.city, n.department, regions[n.department] || null,
        n.company_name, JSON.stringify({ client_need: n.reference, trades: n.trades, lots: n.lots, criteria: n.criteria, recurring: n.recurring })]);
    const oppId = opp.rows[0].id;
    await db.query(`
      INSERT INTO opportunity_locations (opportunity_id, extractor_version, exec_status, exec_source, exec_communes, exec_departments, exec_text,
        publication_departments, notice_deadline, deadline_source, supersedes, computed_at)
      VALUES ($1, 5, $2, 'donneur_ordre', $3::jsonb, ARRAY[$4]::text[], $5, ARRAY[$4]::text[], $6::date + TIME '23:59', $7, '{}', NOW() + INTERVAL '1 second')
      ON CONFLICT (opportunity_id) DO UPDATE SET exec_status = EXCLUDED.exec_status, exec_communes = EXCLUDED.exec_communes, exec_departments = EXCLUDED.exec_departments,
        exec_text = EXCLUDED.exec_text, notice_deadline = EXCLUDED.notice_deadline, deadline_source = EXCLUDED.deadline_source, computed_at = EXCLUDED.computed_at`,
      [oppId, n.city ? 'commune' : 'departement', JSON.stringify(n.city ? [{ name: n.city, slug: n.city.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-'), department: n.department, postalCode: n.postal_code }] : []),
        n.department, [n.city, n.postal_code].filter(Boolean).join(' ') || null, n.deadline, n.deadline ? 'donneur d’ordre' : null]);
    await db.query(`UPDATE client_needs SET status = 'published', reviewed_at = NOW(), opportunity_id = $2, reject_reason = NULL WHERE id = $1`, [id, oppId]);
    clearCache();
    res.json({ ok: true, opportunityId: oppId });
  } catch (err) { logger.error('[besoins] publication :', err); res.status(503).json({ error: 'unavailable' }); }
});

router.post('/:id/reject', ...team, async (req: Request, res: Response) => {
  try {
    await ensure();
    await db.query(`UPDATE client_needs SET status = 'rejected', reviewed_at = NOW(), reject_reason = $2 WHERE id = $1 AND status = 'pending'`, [Number(req.params.id), str(req.body?.reason, 300) || null]);
    res.json({ ok: true });
  } catch (err) { logger.error('[besoins] refus :', err); res.status(503).json({ error: 'unavailable' }); }
});

// POST /api/needs/:id/close : le donneur d'ordre a trouvé son entreprise ; l'annonce n'accepte plus de candidatures.
router.post('/:id/close', ...team, async (req: Request, res: Response) => {
  try {
    await ensure();
    const n = (await db.query(`UPDATE client_needs SET status = 'closed', closed_at = NOW() WHERE id = $1 RETURNING opportunity_id`, [Number(req.params.id)])).rows[0];
    if (n?.opportunity_id) await db.query(`UPDATE opportunities SET status = 'expired', updated_at = NOW() WHERE id = $1`, [n.opportunity_id]);
    clearCache();
    res.json({ ok: true });
  } catch (err) { logger.error('[besoins] clôture :', err); res.status(503).json({ error: 'unavailable' }); }
});

export default router;
