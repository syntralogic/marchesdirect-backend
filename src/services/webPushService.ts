import crypto from 'crypto';
import axios from 'axios';
import { db } from '../config/database';
import { logger } from '../utils/logger';

// ============================================================================
// NOTIFICATIONS SUR LE TÉLÉPHONE (Web Push, 5 nov.)
// Sans dépendance externe : notification SANS contenu chiffré (le service worker affiche un message générique
// « Votre dossier a avancé » et ouvre Mon espace). Seule la signature VAPID (ES256) est nécessaire.
// Les clés VAPID sont créées une fois et gardées en base (app_settings), donc rien à configurer sur Render.
// Aucune donnée personnelle ne transite par le service de notification du navigateur.
// ============================================================================

const b64u = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64u = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
type Jwk = Record<string, any>;
type Vapid = { publicKey: string; privateJwk: Jwk };
let vapid: Promise<Vapid> | null = null;

export async function ensurePushSchema(): Promise<void> {
  await db.query(`CREATE TABLE IF NOT EXISTS push_subscriptions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    endpoint TEXT NOT NULL UNIQUE,
    session_id VARCHAR(100),
    email VARCHAR(255),
    user_agent VARCHAR(300),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_sent_at TIMESTAMPTZ,
    last_error TEXT
  )`);
  await db.query('CREATE INDEX IF NOT EXISTS push_subscriptions_session ON push_subscriptions(session_id)');
  await db.query('CREATE INDEX IF NOT EXISTS push_subscriptions_email ON push_subscriptions(lower(email))');
}
let schema: Promise<void> | null = null;
export const pushSchema = () => (schema ??= ensurePushSchema().catch(e => { schema = null; throw e; }));

export function getVapid(): Promise<Vapid> {
  return (vapid ??= (async () => {
    const r = await db.query(`SELECT value FROM app_settings WHERE key = 'webPushVapid'`);
    if (r.rows[0]?.value?.publicKey) return r.rows[0].value as Vapid;
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const pub = publicKey.export({ format: 'jwk' }) as Jwk;
    const raw = Buffer.concat([Buffer.from([4]), fromB64u(pub.x!), fromB64u(pub.y!)]);
    const v: Vapid = { publicKey: b64u(raw), privateJwk: privateKey.export({ format: 'jwk' }) as Jwk };
    // ON CONFLICT : deux instances au démarrage gardent la même paire (la première écrite).
    await db.query(`INSERT INTO app_settings (key, value) VALUES ('webPushVapid', $1) ON CONFLICT (key) DO NOTHING`, [JSON.stringify(v)]);
    const again = await db.query(`SELECT value FROM app_settings WHERE key = 'webPushVapid'`);
    return again.rows[0].value as Vapid;
  })().catch(e => { vapid = null; throw e; }));
}

function vapidJwt(audience: string, v: Vapid): string {
  const head = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64u(Buffer.from(JSON.stringify({ aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: 'https://www.marchesdirect.fr' })));
  const key = crypto.createPrivateKey({ key: v.privateJwk as any, format: 'jwk' });
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${body}`), { key, dsaEncoding: 'ieee-p1363' });
  return `${head}.${body}.${b64u(sig)}`;
}

const ALLOWED_PUSH_HOSTS = /(^|\.)(googleapis\.com|mozilla\.com|mozaws\.net|push\.apple\.com|notify\.windows\.com|windows\.com)$/i;
export function isValidEndpoint(endpoint: string): boolean {
  try { const u = new URL(endpoint); return u.protocol === 'https:' && ALLOWED_PUSH_HOSTS.test(u.hostname); } catch { return false; }
}

export async function saveSubscription(endpoint: string, sessionId: string | null, email: string | null, ua: string | null) {
  await pushSchema();
  await db.query(`INSERT INTO push_subscriptions (endpoint, session_id, email, user_agent) VALUES ($1, $2, $3, $4)
    ON CONFLICT (endpoint) DO UPDATE SET session_id = COALESCE(EXCLUDED.session_id, push_subscriptions.session_id), email = COALESCE(EXCLUDED.email, push_subscriptions.email), last_error = NULL`,
    [endpoint, sessionId, email, ua ? ua.slice(0, 300) : null]);
}

async function sendOne(endpoint: string, v: Vapid): Promise<'ok' | 'gone' | 'error'> {
  const aud = new URL(endpoint).origin;
  try {
    await axios.post(endpoint, null, { timeout: 10000, headers: { Authorization: `vapid t=${vapidJwt(aud, v)}, k=${v.publicKey}`, TTL: '86400', Urgency: 'high', 'Content-Length': '0' }, validateStatus: s => s < 400 });
    return 'ok';
  } catch (e: any) {
    const st = e?.response?.status;
    if (st === 404 || st === 410) return 'gone';
    logger.warn(`[Push] envoi refusé (${st || e?.message})`);
    return 'error';
  }
}

/** Prévient les téléphones abonnés de cette session ou de cet e-mail. Jamais bloquant. */
export async function notifyDossierUpdate(target: { sessionId?: string | null; email?: string | null }): Promise<number> {
  try {
    await pushSchema();
    const r = await db.query(`SELECT id, endpoint FROM push_subscriptions WHERE ($1::text IS NOT NULL AND session_id = $1) OR ($2::text IS NOT NULL AND lower(email) = lower($2)) LIMIT 10`,
      [target.sessionId || null, target.email || null]);
    if (!r.rows.length) return 0;
    const v = await getVapid(); let n = 0;
    for (const s of r.rows) {
      const out = await sendOne(s.endpoint, v);
      if (out === 'gone') await db.query('DELETE FROM push_subscriptions WHERE id = $1', [s.id]);
      else await db.query('UPDATE push_subscriptions SET last_sent_at = NOW(), last_error = $2 WHERE id = $1', [s.id, out === 'ok' ? null : 'send_failed']);
      if (out === 'ok') n++;
    }
    return n;
  } catch (e: any) { logger.warn('[Push] notification impossible:', e?.message); return 0; }
}
