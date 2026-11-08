import { db } from '../config/database';
import { cached } from '../utils/ttlCache';
import { loadCompanyProfile } from './matchScoreService';

// 8 nov. (Hedi) : le tableau de bord doit « pousser à l'action » sans rien inventer.
//  - Visites : la date de la visite précédente (« depuis votre dernière visite, mardi ») et la base des relances.
//  - Pouls du marché : à partir des marchés réellement attribués (public_awards, données DECP), le rythme moyen
//    auquel des entreprises de la MÊME activité (code NAF exact) décrochent un marché dans sa zone, sur 12 mois,
//    présenté comme une moyenne. Si une attribution réellement datée des 7 derniers jours existe, elle est citée.
//    Jamais « hier, 3 entreprises… » quand ce n'est qu'une moyenne.

let visitsReady: Promise<void> | null = null;
export const visitsSchema = () => (visitsReady ??= db.query(`CREATE TABLE IF NOT EXISTS espace_visits (
    owner_key VARCHAR(140) PRIMARY KEY, session_id VARCHAR(100), email_lower VARCHAR(255),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), prev_seen_at TIMESTAMPTZ, visit_days INT NOT NULL DEFAULT 1,
    nudges JSONB NOT NULL DEFAULT '[]')`).then(() => undefined).catch(e => { visitsReady = null; throw e; }));

/** Enregistre la visite ; renvoie la visite précédente (une nouvelle « visite » = plus de 30 min après la dernière). */
export async function recordVisit(ownerKey: string, sessionId: string | null, email: string | null): Promise<{ prevSeenAt: string | null; visitDays: number }> {
  await visitsSchema();
  const r = await db.query(`INSERT INTO espace_visits (owner_key, session_id, email_lower) VALUES ($1, $2, $3)
    ON CONFLICT (owner_key) DO UPDATE SET
      prev_seen_at = CASE WHEN espace_visits.last_seen_at < NOW() - INTERVAL '30 minutes' THEN espace_visits.last_seen_at ELSE espace_visits.prev_seen_at END,
      visit_days = espace_visits.visit_days + CASE WHEN (espace_visits.last_seen_at AT TIME ZONE 'Europe/Paris')::date < (NOW() AT TIME ZONE 'Europe/Paris')::date THEN 1 ELSE 0 END,
      last_seen_at = NOW(), session_id = COALESCE(EXCLUDED.session_id, espace_visits.session_id), email_lower = COALESCE(EXCLUDED.email_lower, espace_visits.email_lower)
    RETURNING prev_seen_at, visit_days`, [ownerKey, sessionId, email ? email.toLowerCase() : null]);
  return { prevSeenAt: r.rows[0]?.prev_seen_at ? new Date(r.rows[0].prev_seen_at).toISOString() : null, visitDays: r.rows[0]?.visit_days || 1 };
}

let regions: Record<string, string> = {};
try { regions = require('../../scripts/_departmentToRegion.json'); } catch { try { regions = require('../../../scripts/_departmentToRegion.json'); } catch { regions = {}; } }
const DEPT_NAME: Record<string, string> = { '33': 'Gironde', '75': 'Paris', '13': 'Bouches-du-Rhône', '69': 'Rhône', '59': 'Nord', '31': 'Haute-Garonne', '44': 'Loire-Atlantique', '06': 'Alpes-Maritimes', '34': 'Hérault', '67': 'Bas-Rhin' };
const nafOf = (ape: string | null | undefined) => { const a = String(ape || '').replace(/[^0-9A-Za-z]/g, '').toUpperCase(); return /^\d{4}[A-Z]$/.test(a) ? `${a.slice(0, 2)}.${a.slice(2)}` : null; };
const DAYS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];

async function companyApe(o: { userId: string | null; companyId: string | null; sessionId: string | null }): Promise<string | null> {
  if (o.companyId) {
    const r = await db.query(`SELECT c.company_data->>'ape' AS ape FROM companies co JOIN company_lookup_cache c ON c.siren = left(regexp_replace(co.siret, '\\D', '', 'g'), 9) WHERE co.id = $1`, [o.companyId]).catch(() => ({ rows: [] as any[] }));
    if (r.rows[0]?.ape) return r.rows[0].ape;
  }
  if (o.sessionId) {
    const r = await db.query(`SELECT company_data->>'ape' AS ape FROM siret_lookups WHERE session_id = $1`, [o.sessionId]).catch(() => ({ rows: [] as any[] }));
    if (r.rows[0]?.ape) return r.rows[0].ape;
  }
  return null;
}

export type Pouls = {
  rate: number; per: 'jour ouvré' | 'semaine' | 'mois'; yearCount: number; zoneLabel: string; activity: string;
  recent: { day: string; buyer: string | null; objet: string; pme: boolean; dept: string | null } | null;
};

export async function marketPulse(o: { userId: string | null; companyId: string | null; sessionId: string | null }): Promise<Pouls | null> {
  const [ape, profile] = await Promise.all([companyApe(o), loadCompanyProfile(o.companyId, o.sessionId).catch(() => null)]);
  const naf = nafOf(ape); const dept = profile?.department || null;
  if (!naf) return null;
  const has = await db.query(`SELECT to_regclass('public.public_awards') IS NOT NULL AS ok`).catch(() => ({ rows: [{ ok: false }] }));
  if (!has.rows[0]?.ok) return null;
  return cached(`espace:pulse:${naf}:${dept}`, 6 * 3600_000, async () => {
    const tradeNames = profile?.tradeSlugs?.length
      ? (await db.query(`SELECT name FROM trades WHERE slug = ANY($1::text[]) ORDER BY name`, [profile.tradeSlugs])).rows.map((x: any) => String(x.name))
      : [];
    const activity = tradeNames.slice(0, 2).join('-') || 'votre activité';
    // Zone : le département ; s'il y a trop peu d'attributions pour une moyenne parlante, la région ; sinon la France.
    const zones: { label: string; depts: string[] | null }[] = [];
    if (dept) zones.push({ label: DEPT_NAME[dept] || `département ${dept}`, depts: [dept] });
    const region = dept ? regions[dept] : null;
    if (region) zones.push({ label: region, depts: Object.entries(regions).filter(([, r]) => r === region).map(([d]) => d) });
    zones.push({ label: 'France', depts: null });
    for (const z of zones) {
      const p: any[] = [naf]; let cond = '';
      if (z.depts) { p.push(z.depts); cond = `AND lieu_departement = ANY($2::text[])`; }
      const r = await db.query(`SELECT COUNT(DISTINCT uid)::int AS n FROM public_awards WHERE titulaire_naf = $1 ${cond}
        AND date_notification BETWEEN CURRENT_DATE - INTERVAL '12 months' AND CURRENT_DATE`, p);
      const n = r.rows[0]?.n || 0;
      if (n < 24 && z.depts) continue; // moins de 2 par mois : on élargit pour une moyenne qui a du sens
      if (!n) return null;
      const perDay = n / 252; const perWeek = n / 52;
      const rate = perDay >= 1 ? Math.round(perDay) : perWeek >= 1 ? Math.round(perWeek) : Math.max(1, Math.round(n / 12));
      const per: Pouls['per'] = perDay >= 1 ? 'jour ouvré' : perWeek >= 1 ? 'semaine' : 'mois';
      const rec = await db.query(`SELECT acheteur_nom, objet, titulaire_categorie, lieu_departement, date_notification FROM public_awards
        WHERE titulaire_naf = $1 ${cond} AND date_notification BETWEEN CURRENT_DATE - 7 AND CURRENT_DATE AND objet IS NOT NULL
        ORDER BY date_notification DESC LIMIT 1`, p);
      const x = rec.rows[0];
      return { rate, per, yearCount: n, zoneLabel: z.label, activity,
        recent: x ? { day: DAYS[new Date(x.date_notification).getDay()], buyer: x.acheteur_nom || null, objet: String(x.objet).slice(0, 120),
          pme: x.titulaire_categorie === 'PME', dept: x.lieu_departement || null } : null };
    }
    return null;
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Relances (8 nov., Hedi : « il faut pas que ça arrive tous les jours, sinon ça devient lassant »).
// Règles, toutes cumulatives :
//   - seulement entre 18 h et 20 h (heure de Paris), du lundi au vendredi ;
//   - seulement si la personne n'est pas venue depuis au moins 48 h ;
//   - au plus 1 relance tous les 3 jours, et 2 par période de 7 jours ;
//   - seulement s'il y a au moins 5 nouvelles annonces réelles dans ses suivis (sinon on ne dérange pas).
// Téléphone : notification avec le vrai nombre. E-mail : seulement si les envois d'alertes sont activés.
// ---------------------------------------------------------------------------------------------------------------
import { newItemsFor as freshFor } from './savedSearchAlertService';
import { notifyWithMessage } from './webPushService';
import { alertEmailsEnabled } from './alertSubscriptionService';
import { deliverEmail } from './deliveryLogService';
import { isSuppressed } from './contactPreferenceService';
import { logger } from '../utils/logger';

const MIN_FRESH = 5;
export async function sendReengagementNudges(now = new Date()): Promise<{ checked: number; sent: number }> {
  const paris = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
  const h = paris.getHours(); const dow = paris.getDay();
  if (h < 18 || h >= 20 || dow === 0 || dow === 6) return { checked: 0, sent: 0 };
  await visitsSchema();
  const owners = await db.query(`SELECT owner_key, session_id, email_lower, last_seen_at, nudges FROM espace_visits
    WHERE last_seen_at < NOW() - INTERVAL '48 hours' AND last_seen_at > NOW() - INTERVAL '60 days' LIMIT 500`);
  let sent = 0;
  for (const o of owners.rows) {
    const nudges: string[] = Array.isArray(o.nudges) ? o.nudges : [];
    const recent = nudges.map(x => new Date(x).getTime()).filter(t => now.getTime() - t < 7 * 86400000);
    if (recent.length >= 2 || recent.some(t => now.getTime() - t < 3 * 86400000)) continue;
    try {
      const userId = o.owner_key.startsWith('u:') ? o.owner_key.slice(2) : null;
      const ss = await db.query(`SELECT id, label, query, created_at, last_viewed_at FROM saved_searches WHERE deleted_at IS NULL
        AND ((user_id IS NOT NULL AND user_id = $1) OR (session_id IS NOT NULL AND session_id = $2)) ORDER BY created_at DESC LIMIT 10`, [userId, o.session_id]);
      if (!ss.rows.length) continue;
      const per: { label: string; n: number }[] = [];
      for (const s of ss.rows) {
        const f = await freshFor({ id: s.id, query: s.query, alert_baseline_at: s.last_viewed_at || s.created_at }, 50).catch(() => []);
        if (f.length) per.push({ label: s.label, n: f.length });
      }
      const total = per.reduce((a, b) => a + b.n, 0);
      if (total < MIN_FRESH) continue;
      per.sort((a, b) => b.n - a.n);
      const title = `${total >= 50 * per.length ? `${total}+` : total} nouvelles annonces pour vous`;
      const body = `Dans vos suivis : ${per.slice(0, 2).map(p => `${p.label} (${p.n >= 50 ? '50+' : p.n})`).join(', ')}${per.length > 2 ? '…' : ''}`;
      const pushed = await notifyWithMessage({ sessionIds: o.session_id ? [o.session_id] : [], email: o.email_lower }, { title, body, url: '/mon-espace', tag: 'md-nouveautes' });
      let mailed = false;
      if (o.email_lower && alertEmailsEnabled() && !(await isSuppressed(o.email_lower))) {
        const site = (process.env.FRONTEND_URL || 'https://www.marchesdirect.fr').replace(/\/$/, '');
        const r = await deliverEmail({ kind: 'alert', to: o.email_lower, subject: title,
          html: `<p>Bonjour,</p><p><b>${title}</b> depuis votre dernière visite.</p><ul>${per.slice(0, 5).map(p => `<li>${p.label.replace(/[<>&]/g, '')} : ${p.n >= 50 ? '50+' : p.n}</li>`).join('')}</ul><p><a href="${site}/mon-espace">Ouvrir mon espace</a></p><p style="font-size:12px;color:#666">Au plus deux messages par semaine, seulement quand vous n'êtes pas venu depuis deux jours.</p>`,
          ctx: { dedupeKey: null } }).catch(() => ({ sent: false }));
        mailed = !!(r as any).sent;
      }
      if (pushed || mailed) {
        await db.query(`UPDATE espace_visits SET nudges = (SELECT COALESCE(jsonb_agg(x), '[]'::jsonb) FROM (SELECT x FROM jsonb_array_elements(nudges || to_jsonb($2::text)) x ORDER BY x DESC LIMIT 6) t) WHERE owner_key = $1`, [o.owner_key, now.toISOString()]);
        sent++;
      }
    } catch (e: any) { logger.warn(`[Espace] relance ${o.owner_key} :`, e?.message); }
  }
  return { checked: owners.rows.length, sent };
}
