import { escapeHtml } from './leadNotificationService';
import bcrypt from 'bcryptjs';
import { v4 as uuid } from 'uuid';
import { db } from '../config/database';
import { logger } from '../utils/logger';
import QRCode from 'qrcode';
import { generateTokens, verifyRefreshToken, generateMFASecret, verifyMFAToken, signMfaChallenge, verifyMfaChallenge } from '../middleware/auth';
import { encryptSecret, decryptSecret, looksEncrypted } from '../utils/encryption';
import { sendEmail } from './emailService';
import { OAuth2Client } from 'google-auth-library';
import { refreshTokenDigest, isAccessTokenRevoked } from '../utils/tokenSecurity';

interface RegisterParams {
  companyName: string;
  firstName: string;
  lastName: string;
  email: string;
  // Client's newest brief (6 Sep, "parcours définitif" v2): "La création du
  // compte doit être invisible... Aucun mot de passe n'est demandé." -
  // password is now optional; a passwordless account gets password_hash =
  // NULL (column already nullable, see schema.sql) and logs in via magic
  // link instead (see requestMagicLink/verifyMagicLink below).
  password?: string;
  phone?: string;
  industry?: string;
  region?: string;
  // Client priority #12 ("synchroniser l'entreprise et le compte client"):
  // when registration follows an already-completed SIRET identification
  // (see the new completeSignup() below), the rich Pappers/INSEE data
  // gathered earlier in the funnel gets written straight into the new
  // company row instead of the user having to re-type any of it.
  siret?: string;
  legalForm?: string;
  addressStreet?: string;
  addressPostalCode?: string;
  websiteUrl?: string;
  annualRevenue?: number;
  foundingYear?: number;
}

// Client priority #10 ("Création de l'accès personnel") + #12
// ("synchroniser l'entreprise et le compte client"): the visitor has
// already been through SIRET identification (siret_lookups has their full
// Pappers/INSEE company_data) and lead capture (same row's phone/email)
// earlier in this same funnel by the time they reach this step - the only
// new thing they should ever have to type is a password. Re-asking for
// company name, address, sector etc. here (which the old generic
// /auth/register form did) is exactly the "vous devez ressaisir des
// informations déjà récupérées" complaint.
export const completeSignupFromSession = async (
  sessionId: string,
  password: string | undefined,
  brandId?: string | null
) => {
  const lookup = await db.query(
    'SELECT siret, company_data, phone, email, lead_captured_at FROM siret_lookups WHERE session_id = $1',
    [sessionId]
  );
  if (lookup.rows.length === 0 || !lookup.rows[0].company_data) {
    throw new Error('Identifiez d\'abord votre entreprise avant de créer votre accès.');
  }
  const row = lookup.rows[0];
  if (!row.lead_captured_at || !row.email) {
    throw new Error('Renseignez votre e-mail et votre téléphone avant de créer votre accès.');
  }
  const c = row.company_data || {};

  // The director's name is the closest thing to a personal name Pappers
  // gives us - the funnel itself never asks the visitor for one (client's
  // #8/#10 briefs only ever ask for email/phone/password). Falls back to
  // the email's local part rather than leaving first/last name blank,
  // since users.first_name has no NOT NULL constraint but an empty "Bonjour
  // ," greeting would be a worse experience than a best-effort guess.
  const directorParts = (c.director || '').trim().split(/\s+/).filter(Boolean);
  const firstName = directorParts[0] || row.email.split('@')[0];
  const lastName = directorParts.slice(1).join(' ') || '';

  // Pappers' capital string is "25 000 EUR" (see lookupViaPappers) - not
  // what belongs in annual_revenue, so this intentionally uses `revenue`
  // (the raw numeric chiffre_affaires) instead, only when it parses cleanly.
  const revenueNum = c.revenue != null ? Number(c.revenue) : NaN;
  const foundingYear = c.created ? new Date(c.created).getFullYear() : undefined;

  const result = await registerCompanyAndUser(
    {
      companyName: c.name || 'Mon entreprise',
      firstName,
      lastName,
      email: row.email,
      password,
      phone: row.phone || undefined,
      industry: c.activity || undefined,
      region: c.city || undefined,
      siret: c.siret || row.siret || undefined,
      legalForm: c.legal || undefined,
      addressStreet: c.address || undefined,
      addressPostalCode: c.postal || undefined,
      websiteUrl: c.website || undefined,
      annualRevenue: Number.isFinite(revenueNum) ? revenueNum : undefined,
      foundingYear: Number.isFinite(foundingYear as number) ? foundingYear : undefined,
    },
    brandId
  );

  // Client's newest brief: "En parallèle : Votre espace Marchés Direct est
  // prêt — confirmez votre e-mail." Fire-and-forget - the visitor already
  // has accessToken/refreshToken from registerCompanyAndUser above and goes
  // straight into their dossier; this is a courtesy confirmation link for
  // their records/future magic-link logins, never a gate on access.
  requestMagicLink(row.email, 'welcome').catch(err =>
    logger.error(`Failed to send welcome/confirmation email to ${row.email}:`, err)
  );

  return result;
};

// ============================================================================
// REGISTRATION (Milestone 1 & 8)
// ============================================================================

export const registerCompanyAndUser = async (data: RegisterParams, brandId?: string | null) => {
  const client = await db.getClient();

  try {
    await client.query('BEGIN');

    // Check if email already exists
    const emailCheck = await client.query(
      'SELECT id FROM users WHERE email = $1',
      [data.email.toLowerCase()]
    );

    if (emailCheck.rows.length > 0) {
      throw new Error('Email already registered');
    }

    // brandId is resolved by the route from the request's Host header (see
    // utils/brandResolution.ts) so a signup on brand_2's domain actually
    // creates the company under brand_2, not always the first brand in the
    // table - that resolution used to be entirely missing here, which meant
    // every company ended up on brand_1 regardless of which site they used,
    // defeating the point of the Milestone 10 second-brand duplication.
    // Falls back to the oldest brand if the caller didn't resolve one
    // (keeps old call sites / tests working).
    let resolvedBrandId = brandId;
    if (!resolvedBrandId) {
      const brandResult = await client.query('SELECT id FROM brands ORDER BY created_at ASC LIMIT 1');
      resolvedBrandId = brandResult.rows[0]?.id;
    }

    if (!resolvedBrandId) {
      throw new Error('No brands configured in system');
    }

    // Create company
    const companyId = uuid();
    const baseSlug = data.companyName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    // Two different real companies can easily share a display name (generic
    // names like "Bâtiment Pro" are common), which used to collide on
    // companies.slug and throw a raw, unhandled Postgres constraint error
    // straight through to the signup form ("duplicate key value violates
    // unique constraint..."). Suffixing with part of the company's own id
    // guarantees uniqueness with no extra query, since it's already unique
    // by definition.
    const companySlug = `${baseSlug || 'entreprise'}-${companyId.slice(0, 8)}`;

    await client.query(
      `INSERT INTO companies 
        (id, brand_id, name, slug, email, phone, industry_sector, 
         address_city, address_country, status, subscription_status, subscription_tier, trial_ends_at,
         siret, legal_form, address_street, address_postal_code, website_url, annual_revenue, founding_year)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW() + INTERVAL '14 days',
               $13, $14, $15, $16, $17, $18, $19)`,
      [
        companyId,
        resolvedBrandId,
        data.companyName,
        companySlug,
        data.email.toLowerCase(),
        data.phone || null,
        data.industry || null,
        data.region || null,
        'FR',
        'active',
        'trial', // 14-day trial by default - trial_ends_at below is what actually
                 // enforces that; it was previously never set at all (not in this
                 // INSERT's column list), so signups got an unlimited "trial" that
                 // never expired and had no end date to show the user.
        'free',
        data.siret || null,
        data.legalForm || null,
        data.addressStreet || null,
        data.addressPostalCode || null,
        data.websiteUrl || null,
        data.annualRevenue ?? null,
        data.foundingYear ?? null,
      ]
    );

    // Hash password (only if one was actually given - passwordless accounts
    // leave password_hash NULL and authenticate via magic link instead).
    const passwordHash = data.password
      ? await bcrypt.hash(data.password, await bcrypt.genSalt(parseInt(process.env.PASSWORD_SALT_ROUNDS || '10')))
      : null;

    // Create user
    const userId = uuid();
    await client.query(
      `INSERT INTO users 
        (id, company_id, email, password_hash, first_name, last_name, phone, role, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        userId,
        companyId,
        data.email.toLowerCase(),
        passwordHash,
        data.firstName,
        data.lastName,
        data.phone || null,
        // Self-service signups are ordinary users. The 'admin' / 'super_admin' roles
        // gate the platform-wide /api/admin/* and /api/crm/* routers, so they must
        // only ever be granted by an existing admin (never by signing up) - assigning
        // 'admin' here made every new registrant a full platform admin.
        'user',
        'active',
      ]
    );

    const { accessToken, refreshToken } = generateTokens(userId, data.email);
    await client.query(`INSERT INTO user_sessions (user_id, refresh_token_hash, expires_at)
      VALUES ($1, $2, NOW() + INTERVAL '30 days')`, [userId, refreshTokenDigest(refreshToken)]);
    await client.query('COMMIT');

    logger.info(`✅ Registered new company: ${data.companyName} (${companyId})`);

    return {
      userId,
      companyId,
      email: data.email,
      accessToken,
      refreshToken,
      mfaRequired: false, // For now, MFA is optional
    };
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Registration error:', err);
    throw err;
  } finally {
    client.release();
  }
};

// ============================================================================
// LOGIN (Milestone 8)
// ============================================================================

export const loginUser = async (email: string, password: string) => {
  try {
    // BUG (found live, 2026-09-07): this used to unconditionally INSERT a
    // success:false row here before the user/password checks even ran, then
    // a separate success:true row further down on actual success - meaning
    // every successful login also permanently logged one fake "failed
    // attempt". Those fake rows fed straight into the rate-limit COUNT()
    // below, so a real user (or, on this project, the same demo account
    // being logged into repeatedly across many test sessions) could get
    // hard-locked out of their own account with "Too many failed login
    // attempts" despite every single attempt having the correct password -
    // this is what was actually causing the reported "error at login".
    // Fixed by only logging a row in the branches that are an actual
    // failure (rate-limited / unknown email / wrong password), matching the
    // success:true insert that already only fires on the real success path.

    // Check rate limiting (max 5 failed attempts in 15 minutes)
    const recentAttempts = await db.query(
      `SELECT COUNT(*) as count FROM login_attempts 
       WHERE email = $1 AND attempted_at > NOW() - INTERVAL '15 minutes' AND success = false`,
      [email]
    );

    if (parseInt(recentAttempts.rows[0].count) > 5) {
      throw new Error('Too many failed login attempts. Please try again later.');
    }

    // Find user
    const userResult = await db.query(
      `SELECT u.*, c.id as company_id FROM users u
       LEFT JOIN companies c ON u.company_id = c.id
       WHERE LOWER(u.email) = LOWER($1) AND u.deleted_at IS NULL`,
      [email]
    );

    if (userResult.rows.length === 0) {
      await db.query('INSERT INTO login_attempts (email, ip_address, success) VALUES ($1, $2, $3)', [email, 'unknown', false]);
      throw new Error('Invalid email or password');
    }

    const user = userResult.rows[0];

    // Verify password
    const passwordMatch = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatch) {
      await db.query('INSERT INTO login_attempts (email, ip_address, success) VALUES ($1, $2, $3)', [email, 'unknown', false]);
      throw new Error('Invalid email or password');
    }

    // Check if MFA is enabled. The password step is proven by a short-lived
    // signed challenge token (see signMfaChallenge) that /mfa/verify-login
    // requires alongside the TOTP code - before, that endpoint accepted just a
    // userId + code and never looked at this step, so the password could be
    // skipped entirely.
    if (user.mfa_enabled) {
      return {
        mfaRequired: true,
        mfaToken: signMfaChallenge(user.id),
        userId: user.id,
      };
    }

    // Update last login
    await db.query(
      'UPDATE users SET last_login = NOW() WHERE id = $1',
      [user.id]
    );

    // Log successful attempt
    await db.query(
      'INSERT INTO login_attempts (email, success) VALUES ($1, $2)',
      [email, true]
    );

    // Generate tokens
    const { accessToken, refreshToken } = generateTokens(user.id, user.email);

    // Store refresh token
    const tokenHash = refreshTokenDigest(refreshToken);
    await db.query(
      `INSERT INTO user_sessions (user_id, refresh_token_hash, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '30 days')`,
      [user.id, tokenHash]
    );

    logger.info(`✅ User logged in: ${user.email}`);

    return {
      userId: user.id,
      companyId: user.company_id,
      email: user.email,
      firstName: user.first_name,
      role: user.role,
      accessToken,
      refreshToken,
      mfaRequired: false,
    };
  } catch (err) {
    logger.error('Login error:', err);
    throw err;
  }
};

// ============================================================================
// MFA (Multi-Factor Authentication - Milestone 8)
// ============================================================================

const readPlainSecret = (stored: string | null): string => {
  if (!stored) throw new Error("La double authentification n'est pas configurée pour ce compte.");
  return looksEncrypted(stored) ? decryptSecret(stored) : stored;
};

// Starts TOTP setup: stores a fresh secret with mfa_enabled still false (it is
// only switched on once verifyMFASetup sees a valid code from the user's app).
// Refuses when 2FA is already on - before, calling this silently overwrote the
// secret AND set mfa_enabled = false, so anyone holding a session could turn
// 2FA off without proving anything.
export const enableMFA = async (userId: string) => {
  try {
    const userResult = await db.query('SELECT email, mfa_enabled FROM users WHERE id = $1', [userId]);
    if (userResult.rows.length === 0) throw new Error('User not found');
    if (userResult.rows[0].mfa_enabled) {
      throw new Error('La double authentification est déjà activée.');
    }

    const secret = generateMFASecret(userResult.rows[0].email);
    const encryptedSecret = encryptSecret(secret.base32);

    await db.query(
      `UPDATE users SET mfa_enabled = false, mfa_type = $1, mfa_secret_encrypted = $2
       WHERE id = $3`,
      ['totp', encryptedSecret, userId]
    );

    logger.info(`MFA setup initiated for user ${userId}`);

    return {
      secret: secret.base32,
      // Data URL of the QR code, ready for <img src>.
      qrCode: await QRCode.toDataURL(secret.otpauthUrl, { margin: 1, width: 240 }),
      manualEntryKey: secret.base32,
    };
  } catch (err) {
    logger.error('MFA setup error:', err);
    throw err;
  }
};

export const verifyMFASetup = async (userId: string, mfaToken: string) => {
  try {
    const userResult = await db.query(
      'SELECT mfa_secret_encrypted FROM users WHERE id = $1',
      [userId]
    );

    if (userResult.rows.length === 0) {
      throw new Error('User not found');
    }

    const plainSecret = readPlainSecret(userResult.rows[0].mfa_secret_encrypted);

    if (!verifyMFAToken(plainSecret, String(mfaToken || '').trim())) {
      throw new Error('Code invalide.');
    }

    await db.query(
      'UPDATE users SET mfa_enabled = true WHERE id = $1',
      [userId]
    );

    logger.info(`✅ MFA enabled for user ${userId}`);

    return { success: true };
  } catch (err) {
    logger.error('MFA verification error:', err);
    throw err;
  }
};

// Second step of login: exchanges the challenge token from loginUser plus a
// valid TOTP code for a real session - same shape and side effects (last_login,
// login_attempts, stored refresh session) as a normal password login.
export const verifyMFALogin = async (challengeToken: string, code: string) => {
  try {
    let userId: string;
    try {
      userId = verifyMfaChallenge(challengeToken);
    } catch {
      throw new Error('Session de connexion expirée. Reconnectez-vous.');
    }

    const userResult = await db.query(
      `SELECT u.id, u.email, u.first_name, u.role, u.mfa_enabled, u.mfa_secret_encrypted, c.id AS company_id
       FROM users u LEFT JOIN companies c ON u.company_id = c.id
       WHERE u.id = $1 AND u.deleted_at IS NULL`,
      [userId]
    );

    if (userResult.rows.length === 0 || !userResult.rows[0].mfa_enabled) {
      throw new Error('Session de connexion expirée. Reconnectez-vous.');
    }
    const user = userResult.rows[0];

    const plainSecret = readPlainSecret(user.mfa_secret_encrypted);
    if (!verifyMFAToken(plainSecret, String(code || '').trim())) {
      await db.query('INSERT INTO login_attempts (email, success) VALUES ($1, $2)', [user.email, false]);
      throw new Error('Code invalide.');
    }

    await db.query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]);
    await db.query('INSERT INTO login_attempts (email, success) VALUES ($1, $2)', [user.email, true]);

    const { accessToken, refreshToken } = generateTokens(user.id, user.email);
    const tokenHash = refreshTokenDigest(refreshToken);
    await db.query(
      `INSERT INTO user_sessions (user_id, refresh_token_hash, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '30 days')`,
      [user.id, tokenHash]
    );

    logger.info(`✅ MFA login verified for user ${user.id}`);

    return {
      userId: user.id,
      companyId: user.company_id,
      email: user.email,
      firstName: user.first_name,
      role: user.role,
      accessToken,
      refreshToken,
      mfaRequired: false,
    };
  } catch (err) {
    logger.error('MFA login verification error:', err);
    throw err;
  }
};

// Turning 2FA off needs both the account password and a current TOTP code, so
// a stolen access token alone can't strip the protection.
export const disableMFA = async (userId: string, password: string, code: string) => {
  const userResult = await db.query(
    'SELECT password_hash, mfa_enabled, mfa_secret_encrypted FROM users WHERE id = $1',
    [userId]
  );
  if (userResult.rows.length === 0) throw new Error('Utilisateur introuvable.');

  const user = userResult.rows[0];
  if (!user.mfa_enabled) throw new Error("La double authentification n'est pas activée.");

  const passwordOk = user.password_hash && typeof password === 'string' && password
    ? await bcrypt.compare(password, user.password_hash)
    : false;
  if (!passwordOk) throw new Error('Mot de passe incorrect.');

  if (!verifyMFAToken(readPlainSecret(user.mfa_secret_encrypted), String(code || '').trim())) {
    throw new Error('Code invalide.');
  }

  await db.query(
    'UPDATE users SET mfa_enabled = false, mfa_type = NULL, mfa_secret_encrypted = NULL WHERE id = $1',
    [userId]
  );
  logger.info(`MFA disabled for user ${userId}`);
  return { success: true };
};

// ============================================================================
// REFRESH TOKEN
// ============================================================================

export const refreshAccessToken = async (refreshToken: string) => {
  try {
    const decoded = verifyRefreshToken(refreshToken);

    // A session for this user is insufficient: it must match this exact token.
    // Legacy bcrypt hashes truncated long JWTs and cannot prove that match.
    // Their holders reconnect once; no account or saved data is deleted.
    const sessionResult = await db.query(
      `SELECT u.email, u.auth_tokens_valid_after FROM user_sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.user_id = $1 AND s.refresh_token_hash = $2 AND s.expires_at > NOW()
         AND u.deleted_at IS NULL LIMIT 1`,
      [decoded.userId, refreshTokenDigest(refreshToken)]
    );

    if (sessionResult.rows.length === 0) {
      throw new Error('Session expired');
    }

    const user = sessionResult.rows[0];
    if (isAccessTokenRevoked(decoded.iat, user.auth_tokens_valid_after)) throw new Error('Session expired');
    // Keep the validated refresh token until expiry. Concurrent tabs can renew
    // safely, while deleting this row immediately prevents further renewals.
    const { accessToken } = generateTokens(
      decoded.userId,
      user.email
    );

    return { accessToken, refreshToken };
  } catch (err) {
    logger.error('Refresh token error:', err);
    throw err;
  }
};

// ============================================================================
// PASSWORD RESET
// ============================================================================

export const requestPasswordReset = async (email: string) => {
  try {
    const userResult = await db.query(
      'SELECT id FROM users WHERE LOWER(email) = LOWER($1)',
      [email]
    );

    if (userResult.rows.length === 0) {
      // Don't reveal if email exists (security best practice)
      logger.info(`Password reset requested for non-existent email: ${email}`);
      return { success: true };
    }

    const userId = userResult.rows[0].id;
    const resetToken = uuid();
    const resetTokenHash = await bcrypt.hash(resetToken, 5);

    // Store reset token (expires in 1 hour)
    await db.query(
      `INSERT INTO user_sessions (user_id, refresh_token_hash, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '1 hour')`,
      [userId, resetTokenHash]
    );

    // In production, send email with reset link
    logger.info(`Password reset token generated for ${email}`);

    return { success: true }; // Never expose a reset credential or account existence in the response.
  } catch (err) {
    logger.error('Password reset request error:', err);
    throw err;
  }
};

// changePassword — logged-in user changing their own password from the
// Sécurité tab (ProfilPage). Distinct from resetPassword above: resetPassword
// is reached via the forgot-password email link, where possession of the
// one-time reset token already proves account ownership, so no current
// password is needed there. This flow instead reuses a live session token,
// which a visitor could have without knowing the actual password (a leaked/
// stolen JWT, a shared device left logged in), so it has to independently
// verify the current password before accepting a new one - previously the
// frontend collected a "mot de passe actuel" field but silently never sent
// it, and the endpoint it called (password-reset/confirm) never checked one
// either, so anyone holding a valid access token could overwrite the
// password with no proof they knew the old one.
export const changePassword = async (userId: string, currentPassword: string, newPassword: string) => {
  const userResult = await db.query('SELECT password_hash FROM users WHERE id = $1', [userId]);
  if (userResult.rows.length === 0) {
    throw new Error('Utilisateur introuvable.');
  }

  const { password_hash } = userResult.rows[0];
  // A passwordless account (magic-link only, password_hash NULL - see
  // registerCompanyAndUser above) has no current password to verify against;
  // treat that the same as a wrong password rather than crashing bcrypt.compare
  // on a null hash or, worse, silently accepting any "current password" value.
  const currentMatches = password_hash ? await bcrypt.compare(currentPassword, password_hash) : false;
  if (!currentMatches) {
    throw new Error('Mot de passe actuel incorrect.');
  }

  return resetPassword(userId, newPassword);
};

export const resetPassword = async (userId: string, newPassword: string) => {
  try {
    const salt = await bcrypt.genSalt(parseInt(process.env.PASSWORD_SALT_ROUNDS || '10'));
    const passwordHash = await bcrypt.hash(newPassword, salt);

    await db.transaction(async client => {
      await client.query('UPDATE users SET password_hash = $1, auth_tokens_valid_after = NOW() WHERE id = $2', [passwordHash, userId]);
      await client.query('DELETE FROM user_sessions WHERE user_id = $1', [userId]);
    });

    logger.info(`✅ Password reset for user ${userId}`);

    return { success: true };
  } catch (err) {
    logger.error('Password reset error:', err);
    throw err;
  }
};

// ============================================================================
// PASSWORDLESS LOGIN (client's 6 Sep brief, "parcours définitif" v2)
// ============================================================================
//
// "Lorsqu'il souhaite revenir plus tard sur son compte : il saisit son
// adresse e-mail → il reçoit un lien de connexion sécurisé → il clique
// dessus → il accède directement à son espace." Same shape as
// requestPasswordReset above (uuid token, only its hash stored, short
// expiry) but its own table (magic_link_tokens) rather than overloading
// user_sessions, since a magic link isn't a session/refresh token - it's a
// one-time credential that gets exchanged FOR a session.

export type MagicLinkRequestResult = {
  success: true;
  // 4 Nov: the caller must know whether an e-mail really left. Before, this
  // always answered { success: true } - even with delivery paused - and the
  // login page then told visitors "un lien vient d'être envoyé" for a mail
  // that never existed. `sent` is the truth; `reason` says why when false.
  sent: boolean;
  reason?: 'delivery_paused' | 'delivery_failed';
};

export const requestMagicLink = async (
  email: string,
  purpose: 'login' | 'welcome' = 'login'
): Promise<MagicLinkRequestResult> => {
  const normalizedEmail = email.toLowerCase().trim();

  // Unknown address: the account is created when the link is validated (see
  // verifyMagicLink), so the token is issued either way. The response is
  // identical for known and unknown addresses - nothing is revealed.
  const userResult = await db.query('SELECT id, first_name FROM users WHERE LOWER(email) = LOWER($1) AND deleted_at IS NULL', [normalizedEmail]);
  const isNew = userResult.rows.length === 0;
  const tokenPurpose = isNew ? 'signup' : purpose;

  const token = uuid();
  const tokenHash = await bcrypt.hash(token, 5);

  const inserted = await db.query(
    `INSERT INTO magic_link_tokens (email, token_hash, purpose, expires_at)
     VALUES ($1, $2, $3, NOW() + INTERVAL '1 hour') RETURNING id`,
    [normalizedEmail, tokenHash, tokenPurpose]
  );
  const tokenId: string = inserted.rows[0].id;

  const appUrl = process.env.APP_URL || 'https://www.marchesdirect.fr';
  const link = `${appUrl}/connexion/lien?token=${encodeURIComponent(token)}&email=${encodeURIComponent(normalizedEmail)}`;
  const firstName = isNew ? '' : (userResult.rows[0].first_name || '');
  const greeting = firstName ? `Bonjour ${escapeHtml(firstName)},` : 'Bonjour,';

  const { subject, html } = purpose === 'welcome' && !isNew
    ? {
        subject: 'Votre espace Marchés Direct est prêt',
        html: `<p>${greeting}</p><p>Votre espace Marchés Direct est prêt. Confirmez votre adresse e-mail et retrouvez votre espace à tout moment avec ce lien :</p><p><a href="${link}">${link}</a></p><p>Ce lien est valable 1 heure.</p>`,
      }
    : {
        subject: 'Votre lien de connexion Marchés Direct',
        html: `<p>${greeting}</p><p>Cliquez sur ce lien pour accéder à votre espace Marchés Direct :</p><p><a href="${link}">${link}</a></p><p>Ce lien est valable 1 heure et ne peut servir qu'une fois. Si vous n'avez pas demandé cette connexion, ignorez cet e-mail.</p>`,
      };

  let sent = false;
  let reason: MagicLinkRequestResult['reason'];
  try {
    sent = await sendEmail({ to: normalizedEmail, subject, html });
    if (!sent) reason = 'delivery_paused';
  } catch {
    reason = 'delivery_failed';
  }
  if (!sent) {
    // No mail, no usable link: drop the token so nothing dangles.
    await db.query('DELETE FROM magic_link_tokens WHERE id = $1', [tokenId]).catch(() => undefined);
    logger.warn(`Magic link not sent (${reason}) for ${normalizedEmail}`);
    return { success: true, sent: false, reason };
  }
  return { success: true, sent: true };
};

export class MagicLinkError extends Error {
  constructor(public readonly code: 'invalid' | 'expired' | 'used', message: string) {
    super(message); this.name = 'MagicLinkError';
  }
}

const issueSession = async (userId: string, email: string) => {
  const { accessToken, refreshToken } = generateTokens(userId, email);
  const tokenHash = refreshTokenDigest(refreshToken);
  await db.query(
    `INSERT INTO user_sessions (user_id, refresh_token_hash, expires_at)
     VALUES ($1, $2, NOW() + INTERVAL '30 days')`,
    [userId, tokenHash]
  );
  await db.query('UPDATE users SET last_login = NOW() WHERE id = $1', [userId]);
  return { accessToken, refreshToken };
};

export const verifyMagicLink = async (token: string, email: string, brandId?: string | null) => {
  const normalizedEmail = email.toLowerCase().trim();

  // Recent tokens for this address, used/expired included, so the visitor
  // gets the right message ("déjà utilisé", "expiré") instead of one vague
  // "invalide ou expiré" for every case.
  const candidates = await db.query(
    `SELECT id, token_hash, used_at, (expires_at > NOW()) AS live FROM magic_link_tokens
     WHERE email = $1
     ORDER BY created_at DESC LIMIT 8`,
    [normalizedEmail]
  );

  let matched: { id: string; used_at: string | null; live: boolean } | null = null;
  for (const row of candidates.rows) {
    if (await bcrypt.compare(token, row.token_hash)) { matched = row; break; }
  }
  if (!matched) throw new MagicLinkError('invalid', 'Ce lien de connexion est invalide.');
  if (matched.used_at) throw new MagicLinkError('used', 'Ce lien a déjà été utilisé. Demandez-en un nouveau.');
  if (!matched.live) throw new MagicLinkError('expired', 'Ce lien a expiré (il est valable 1 heure). Demandez-en un nouveau.');

  // Single use: only the first verification wins the row.
  const claimed = await db.query('UPDATE magic_link_tokens SET used_at = NOW() WHERE id = $1 AND used_at IS NULL RETURNING id', [matched.id]);
  if (claimed.rows.length === 0) throw new MagicLinkError('used', 'Ce lien a déjà été utilisé. Demandez-en un nouveau.');

  let userResult = await db.query('SELECT id, email, mfa_enabled FROM users WHERE LOWER(email) = LOWER($1) AND deleted_at IS NULL', [normalizedEmail]);
  let isNewUser = false;
  if (userResult.rows.length === 0) {
    // The link proves the address: create the account now (no password, same
    // as the Google flow). "Email already registered" can only mean a
    // concurrent creation - re-read instead of duplicating.
    try {
      await registerCompanyAndUser(
        { companyName: 'Mon entreprise', firstName: '', lastName: '', email: normalizedEmail },
        brandId
      );
      isNewUser = true;
      logger.info(`✅ New account via magic link: ${normalizedEmail}`);
    } catch (err) {
      if (!(err instanceof Error && /already registered/i.test(err.message))) throw err;
    }
    userResult = await db.query('SELECT id, email, mfa_enabled FROM users WHERE LOWER(email) = LOWER($1) AND deleted_at IS NULL', [normalizedEmail]);
    if (userResult.rows.length === 0) throw new Error('La création du compte a échoué. Réessayez.');
  }

  const user = userResult.rows[0];
  // A magic link proves email ownership only - it must not skip 2FA.
  if (user.mfa_enabled) {
    return { mfaRequired: true, mfaToken: signMfaChallenge(user.id), userId: user.id };
  }
  const { accessToken, refreshToken } = await issueSession(user.id, user.email);
  await db.query('INSERT INTO login_attempts (email, success) VALUES ($1, $2)', [normalizedEmail, true]).catch(() => undefined);
  return { accessToken, refreshToken, userId: user.id, email: user.email, isNewUser };
};

// ============================================================================
// GOOGLE SIGN-IN ("Continue with Google")
// ============================================================================
// The frontend sends the Google Identity Services ID token (a signed JWT).
// It is verified here against GOOGLE_CLIENT_ID (signature, audience, expiry) -
// the email is never trusted from the request body, only from the verified
// token, and only when Google says email_verified is true.
let googleClient: OAuth2Client | null = null;

export const loginWithGoogle = async (idToken: string, brandId?: string | null) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    throw new Error("La connexion Google n'est pas configurée.");
  }
  googleClient = googleClient || new OAuth2Client(clientId);

  let payload;
  try {
    const ticket = await googleClient.verifyIdToken({ idToken, audience: clientId });
    payload = ticket.getPayload();
  } catch (err) {
    logger.warn('Google ID token verification failed:', err);
    throw new Error('Connexion Google invalide. Veuillez réessayer.');
  }

  if (!payload?.email || !payload.email_verified) {
    throw new Error("Votre adresse e-mail Google n'est pas vérifiée.");
  }

  const email = payload.email.toLowerCase().trim();
  const firstName = (payload.given_name || '').trim();
  const lastName = (payload.family_name || '').trim();

  const existing = await db.query(
    `SELECT u.*, c.id as company_id FROM users u
     LEFT JOIN companies c ON u.company_id = c.id
     WHERE LOWER(u.email) = $1 AND u.deleted_at IS NULL`,
    [email]
  );

  // New visitor -> create the account (passwordless, same as the magic-link flow).
  if (existing.rows.length === 0) {
    const displayName = (payload.name || `${firstName} ${lastName}` || email.split('@')[0]).trim();
    const created = await registerCompanyAndUser(
      {
        companyName: displayName || 'Mon entreprise',
        firstName,
        lastName,
        email,
      },
      brandId
    );
    await db.query('UPDATE users SET last_login = NOW() WHERE id = $1', [created.userId]);
    // registerCompanyAndUser already saved the exact refresh token.
    logger.info(`✅ New account via Google: ${email}`);
    return { ...created, firstName, role: 'user', isNewUser: true };
  }

  const user = existing.rows[0];

  // Existing account: keep 2FA enforced, Google must not bypass it.
  if (user.mfa_enabled) {
    return { mfaRequired: true, mfaToken: signMfaChallenge(user.id), userId: user.id };
  }

  await db.query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]);
  await db.query('INSERT INTO login_attempts (email, success) VALUES ($1, $2)', [email, true]);

  const { accessToken, refreshToken } = generateTokens(user.id, user.email);
  const tokenHash = refreshTokenDigest(refreshToken);
  await db.query(
    `INSERT INTO user_sessions (user_id, refresh_token_hash, expires_at)
     VALUES ($1, $2, NOW() + INTERVAL '30 days')`,
    [user.id, tokenHash]
  );

  logger.info(`✅ User logged in via Google: ${user.email}`);
  return {
    userId: user.id,
    companyId: user.company_id,
    email: user.email,
    firstName: user.first_name,
    role: user.role,
    accessToken,
    refreshToken,
    mfaRequired: false,
    isNewUser: false,
  };
};

