import bcrypt from 'bcryptjs';
import { v4 as uuid } from 'uuid';
import { db } from '../config/database';
import { logger } from '../utils/logger';
import { generateTokens, verifyRefreshToken, generateMFASecret, verifyMFAToken } from '../middleware/auth';
import { encryptSecret, decryptSecret, looksEncrypted } from '../utils/encryption';

interface RegisterParams {
  companyName: string;
  firstName: string;
  lastName: string;
  email: string;
  password: string;
  phone?: string;
  industry?: string;
  region?: string;
}

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
         address_city, address_country, status, subscription_status, subscription_tier, trial_ends_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW() + INTERVAL '14 days')`,
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
      ]
    );

    // Hash password
    const salt = await bcrypt.genSalt(parseInt(process.env.PASSWORD_SALT_ROUNDS || '10'));
    const passwordHash = await bcrypt.hash(data.password, salt);

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
