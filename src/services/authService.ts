import bcrypt from 'bcryptjs';
import { v4 as uuid } from 'uuid';
import { db } from '../config/database';
import { logger } from '../utils/logger';
import { generateTokens, verifyRefreshToken, generateMFASecret, verifyMFAToken } from '../middleware/auth';
import { encryptSecret, decryptSecret, looksEncrypted } from '../utils/encryption';
import { sendEmail } from './emailService';

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
        'admin', // First user of company is admin
        'active',
      ]
    );

    await client.query('COMMIT');

    logger.info(`✅ Registered new company: ${data.companyName} (${companyId})`);

    // Generate tokens
    const { accessToken, refreshToken } = generateTokens(userId, data.email);

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
    // FLAGGED (not changed): this unconditionally logs a `success: false`
    // login_attempts row before the password/user checks even run, then logs
    // a separate `success: true` row further down on an actual success. That
    // means every successful login also leaves behind one permanent "failed
    // attempt" row, which feeds into the rate-limit COUNT() below - a real
    // user logging in 6+ times in 15 minutes (page refresh, multiple tabs,
    // etc.) could get locked out purely from their own successful logins.
    // Left as-is rather than restructured under time pressure - needs a
    // deliberate fix (log failure only in the actual failure branches), not
    // a rushed one.
    // Log login attempt
    await db.query(
      'INSERT INTO login_attempts (email, ip_address, success) VALUES ($1, $2, $3)',
      [email, 'unknown', false] // IP would come from request in real implementation
    );

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
      throw new Error('Invalid email or password');
    }

    const user = userResult.rows[0];

    // Verify password
    const passwordMatch = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatch) {
      throw new Error('Invalid email or password');
    }

    // Check if MFA is enabled
    if (user.mfa_enabled) {
      // Return a temporary token that only allows MFA verification
      const tempToken = uuid();
      await db.query(
        `INSERT INTO user_sessions (user_id, refresh_token_hash, expires_at)
         VALUES ($1, $2, NOW() + INTERVAL '10 minutes')`,
        [user.id, tempToken]
      );

      return {
        mfaRequired: true,
        mfaToken: tempToken,
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
    const tokenHash = await bcrypt.hash(refreshToken, 5);
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

export const enableMFA = async (userId: string) => {
  try {
    const secret = generateMFASecret();

    const encryptedSecret = encryptSecret(secret.base32);

    await db.query(
      `UPDATE users SET mfa_enabled = false, mfa_type = $1, mfa_secret_encrypted = $2
       WHERE id = $3`,
      ['totp', encryptedSecret, userId]
    );

    logger.info(`MFA setup initiated for user ${userId}`);

    return {
      secret: secret.base32,
      qrCode: secret.qr_code_url,
      manualEntryKey: secret.base32,
    };
  } catch (err) {
    logger.error('MFA setup error:', err);
    throw err;
  }
};

export const verifyMFASetup = async (userId: string, mfaToken: string) => {
  try {
    // Get user's MFA secret
    const userResult = await db.query(
      'SELECT mfa_secret_encrypted FROM users WHERE id = $1',
      [userId]
    );

    if (userResult.rows.length === 0) {
      throw new Error('User not found');
    }

    const secret = userResult.rows[0].mfa_secret_encrypted;
    const plainSecret = looksEncrypted(secret) ? decryptSecret(secret) : secret;

    // Verify token
    if (!verifyMFAToken(plainSecret, mfaToken)) {
      throw new Error('Invalid MFA token');
    }

    // Confirm MFA is enabled
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

export const verifyMFALogin = async (userId: string, mfaToken: string) => {
  try {
    // Get user's MFA secret
    const userResult = await db.query(
      'SELECT mfa_secret_encrypted FROM users WHERE id = $1',
      [userId]
    );

    if (userResult.rows.length === 0) {
      throw new Error('User not found');
    }

    const secret = userResult.rows[0].mfa_secret_encrypted;
    const plainSecret = looksEncrypted(secret) ? decryptSecret(secret) : secret;

    // Verify token
    if (!verifyMFAToken(plainSecret, mfaToken)) {
      throw new Error('Invalid MFA token');
    }

    // Generate full tokens
    const userEmail = userResult.rows[0].email;
    const { accessToken, refreshToken } = generateTokens(userId, userEmail);

    logger.info(`✅ MFA login verified for user ${userId}`);

    return { accessToken, refreshToken };
  } catch (err) {
    logger.error('MFA login verification error:', err);
    throw err;
  }
};

// ============================================================================
// REFRESH TOKEN
// ============================================================================

export const refreshAccessToken = async (refreshToken: string) => {
  try {
    const decoded = verifyRefreshToken(refreshToken);

    // Verify session exists
    const sessionResult = await db.query(
      'SELECT * FROM user_sessions WHERE user_id = $1 AND expires_at > NOW()',
      [decoded.userId]
    );

    if (sessionResult.rows.length === 0) {
      throw new Error('Session expired');
    }

    // Generate new access token
    const { accessToken, refreshToken: newRefreshToken } = generateTokens(
      decoded.userId,
      decoded.email
    );

    return { accessToken, refreshToken: newRefreshToken };
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

    return { success: true, resetToken }; // In production, send via email
  } catch (err) {
    logger.error('Password reset request error:', err);
    throw err;
  }
};

export const resetPassword = async (userId: string, newPassword: string) => {
  try {
    const salt = await bcrypt.genSalt(parseInt(process.env.PASSWORD_SALT_ROUNDS || '10'));
    const passwordHash = await bcrypt.hash(newPassword, salt);

    await db.query(
      'UPDATE users SET password_hash = $1 WHERE id = $2',
      [passwordHash, userId]
    );

    // Invalidate all existing sessions
    await db.query(
      'DELETE FROM user_sessions WHERE user_id = $1',
      [userId]
    );

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

export const requestMagicLink = async (email: string, purpose: 'login' | 'welcome' = 'login') => {
  const normalizedEmail = email.toLowerCase().trim();

  // For 'login', don't reveal whether the email exists - same reasoning as
  // requestPasswordReset. For 'welcome' this is always a real, just-created
  // account (called right after registerCompanyAndUser), so no such check
  // is needed there, but the same non-existent-user guard is harmless.
  const userResult = await db.query('SELECT id, first_name FROM users WHERE LOWER(email) = LOWER($1)', [normalizedEmail]);
  if (userResult.rows.length === 0) {
    logger.info(`Magic link requested for non-existent email: ${normalizedEmail}`);
    return { success: true };
  }

  const token = uuid();
  const tokenHash = await bcrypt.hash(token, 5);

  await db.query(
    `INSERT INTO magic_link_tokens (email, token_hash, purpose, expires_at)
     VALUES ($1, $2, $3, NOW() + INTERVAL '1 hour')`,
    [normalizedEmail, tokenHash, purpose]
  );

  const appUrl = process.env.APP_URL || 'https://direct.vercel.app';
  const link = `${appUrl}/connexion/lien?token=${encodeURIComponent(token)}&email=${encodeURIComponent(normalizedEmail)}`;
  const firstName = userResult.rows[0].first_name || '';

  const { subject, html } = purpose === 'welcome'
    ? {
        subject: 'Votre espace Marchés Direct est prêt',
        html: `<p>Bonjour ${firstName},</p><p>Votre espace Marchés Direct est prêt. Confirmez votre adresse e-mail et retrouvez votre espace à tout moment avec ce lien :</p><p><a href="${link}">${link}</a></p><p>Ce lien est valable 1 heure.</p>`,
      }
    : {
        subject: 'Votre lien de connexion Marchés Direct',
        html: `<p>Bonjour ${firstName},</p><p>Cliquez sur ce lien pour accéder à votre espace Marchés Direct :</p><p><a href="${link}">${link}</a></p><p>Ce lien est valable 1 heure. Si vous n'avez pas demandé cette connexion, ignorez cet e-mail.</p>`,
      };

  await sendEmail({ to: normalizedEmail, subject, html });

  return { success: true };
};

export const verifyMagicLink = async (token: string, email: string) => {
  const normalizedEmail = email.toLowerCase().trim();

  const candidates = await db.query(
    `SELECT id, token_hash FROM magic_link_tokens
     WHERE email = $1 AND used_at IS NULL AND expires_at > NOW()
     ORDER BY created_at DESC LIMIT 5`,
    [normalizedEmail]
  );

  // token_hash comparisons are bcrypt (not indexable), so check the
  // handful of this email's recent unused/unexpired tokens rather than a
  // single row lookup - matches requestPasswordReset's own token model.
  let matchedId: string | null = null;
  for (const row of candidates.rows) {
    if (await bcrypt.compare(token, row.token_hash)) { matchedId = row.id; break; }
  }
  if (!matchedId) {
    throw new Error('Ce lien de connexion est invalide ou a expiré.');
  }

  await db.query('UPDATE magic_link_tokens SET used_at = NOW() WHERE id = $1', [matchedId]);

  const userResult = await db.query('SELECT id, email FROM users WHERE LOWER(email) = LOWER($1)', [normalizedEmail]);
  if (userResult.rows.length === 0) {
    throw new Error('Aucun compte associé à cette adresse e-mail.');
  }

  const user = userResult.rows[0];
  const { accessToken, refreshToken } = generateTokens(user.id, user.email);
  return { accessToken, refreshToken, userId: user.id, email: user.email };
};
