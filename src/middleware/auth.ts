import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { db } from '../config/database';
import { logger } from '../utils/logger';
import { resolveAvatarUrl } from '../services/storageService';

// Fail fast rather than silently signing/verifying tokens with a known,
// hardcoded string if these are ever left unset (e.g. a forgotten env var
// on a fresh deploy). A guessable default here would let anyone forge a
// valid auth token, so there is no fallback - the process refuses to start.
const JWT_SECRET = process.env.JWT_SECRET;
const REFRESH_TOKEN_SECRET = process.env.REFRESH_TOKEN_SECRET;
if (!JWT_SECRET || !REFRESH_TOKEN_SECRET) {
  throw new Error(
    'JWT_SECRET and REFRESH_TOKEN_SECRET must both be set in the environment. ' +
    'Refusing to start with an insecure default - see .env.example / DEPLOY.md.'
  );
}

export interface AuthRequest extends Request {
  user?: {
    id: string;
    email: string;
    companyId: string;
    role: string;
    firstName: string;
    lastName: string;
    mfaEnabled: boolean;
    notificationPreferences: Record<string, boolean>;
    avatarUrl: string | null;
  };
  company?: any;
}

const DEFAULT_NOTIFICATION_PREFERENCES: Record<string, boolean> = {
  emailAlerts: true,
  newOpps: true,
  deadlineAlerts: true,
  weeklyDigest: false,
  mobileNotifs: true,
};

// Verify JWT token
export const authenticate = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];

    if (!token) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const decoded = jwt.verify(token, JWT_SECRET) as any;

    // Fetch user from database
    const result = await db.query(
      'SELECT u.*, c.id as company_id FROM users u LEFT JOIN companies c ON u.company_id = c.id WHERE u.id = $1 AND u.deleted_at IS NULL',
      [decoded.userId]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'User not found' });
    }

    const user = result.rows[0];

    // Attach user to request - first/last name were previously dropped here even
    // though the DB row has them, so GET /api/auth/me (which returns req.user
    // as-is) could never surface the user's actual name to the frontend.
    // mfaEnabled is included so the Security settings page can show real
    // enabled/disabled 2FA state instead of guessing.
    req.user = {
      id: user.id,
      email: user.email,
      companyId: user.company_id,
      role: user.role,
      firstName: user.first_name,
      lastName: user.last_name,
      mfaEnabled: !!user.mfa_enabled,
      notificationPreferences: user.notification_preferences || DEFAULT_NOTIFICATION_PREFERENCES,
      avatarUrl: user.avatar_url ? resolveAvatarUrl(user.avatar_url) : null,
    };

    // Attach company to request
    const companyResult = await db.query(
      'SELECT * FROM companies WHERE id = $1 AND deleted_at IS NULL',
      [user.company_id]
    );

    if (companyResult.rows.length > 0) {
      req.company = companyResult.rows[0];
    }

    next();
  } catch (err) {
    logger.error('Auth error:', err);
    res.status(401).json({ error: 'Invalid token' });
  }
};

// Check for specific role
export const requireRole = (roles: string[]) => {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
};

// Prevent cross-company access
export const checkCompanyAccess = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const requestedCompanyId = req.params.companyId || req.body.companyId;

    if (requestedCompanyId && requestedCompanyId !== req.user?.companyId && req.user?.role !== 'super_admin') {
      logger.warn(`Unauthorized access attempt: User ${req.user?.id} tried to access company ${requestedCompanyId}`);
      
      // Log security incident
      await db.query(
        `INSERT INTO security_incidents (incident_type, severity, user_id, ip_address, description)
         VALUES ($1, $2, $3, $4, $5)`,
        ['unauthorized_access', 'high', req.user?.id, req.ip, `Cross-company access attempt: ${requestedCompanyId}`]
      );

      return res.status(403).json({ error: 'Access denied' });
    }

    next();
  } catch (err) {
    logger.error('Company access check failed:', err);
    res.status(500).json({ error: 'Access control error' });
  }
};

// Optional authentication (for public routes that can be enhanced if logged in)
export const optionalAuth = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];

    if (token) {
      const decoded = jwt.verify(token, JWT_SECRET) as any;
      // Previously just did `req.user = decoded`, which is only the JWT
      // payload ({userId, email}) - any route reading req.user.companyId
      // (or firstName/role/etc.) under optionalAuth got undefined for a
      // logged-in user, silently falling through to anonymous-visitor
      // behavior. Mirrors authenticate()'s DB enrichment, just without
      // rejecting the request on failure - a bad/expired token or deleted
      // user simply falls back to anonymous, same as no token at all.
      const result = await db.query(
        'SELECT u.*, c.id as company_id FROM users u LEFT JOIN companies c ON u.company_id = c.id WHERE u.id = $1 AND u.deleted_at IS NULL',
        [decoded.userId]
      );
      if (result.rows.length > 0) {
        const user = result.rows[0];
        req.user = {
          id: user.id,
          email: user.email,
          companyId: user.company_id,
          role: user.role,
          firstName: user.first_name,
          lastName: user.last_name,
          mfaEnabled: !!user.mfa_enabled,
          notificationPreferences: user.notification_preferences || DEFAULT_NOTIFICATION_PREFERENCES,
          avatarUrl: user.avatar_url ? resolveAvatarUrl(user.avatar_url) : null,
        };
        const companyResult = await db.query('SELECT * FROM companies WHERE id = $1 AND deleted_at IS NULL', [user.company_id]);
        if (companyResult.rows.length > 0) req.company = companyResult.rows[0];
      }
    }
  } catch (err) {
    // Silent fail for optional auth
  }

  next();
};

// ============================================================================
// TOKEN GENERATION
// ============================================================================

export const generateTokens = (userId: string, email: string) => {
  const accessToken = jwt.sign(
    { userId, email },
    JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' } as jwt.SignOptions
  );

  const refreshToken = jwt.sign(
    { userId, email },
    REFRESH_TOKEN_SECRET,
    { expiresIn: process.env.REFRESH_TOKEN_EXPIRES_IN || '30d' } as jwt.SignOptions
  );

  return { accessToken, refreshToken };
};

// Verify refresh token
export const verifyRefreshToken = (token: string) => {
  try {
    return jwt.verify(token, REFRESH_TOKEN_SECRET) as any;
  } catch (err) {
    throw new Error('Invalid refresh token');
  }
};

// ============================================================================
// MFA HELPERS
// ============================================================================

// Gate for the paid-tier-only actions on a listing "fiche" (DCE analysis,
// bid document generation): free/anonymous/trial companies can still browse
// and read opportunities, but the AI-assisted candidature tools require an
// active subscription. Runs after `authenticate`, which already attaches
// req.company from a fresh DB read.
export const requireActiveSubscription = (req: AuthRequest, res: Response, next: NextFunction) => {
  if (req.company?.subscription_status !== 'active') {
    return res.status(403).json({
      error: 'active_subscription_required',
      message: 'Cette action nécessite un abonnement actif.',
    });
  }
  next();
};

export const generateMFASecret = () => {
  const speakeasy = require('speakeasy');
  return speakeasy.generateSecret({
    name: `${process.env.MFA_ISSUER || 'Procurement Platform'}`,
    issuer: process.env.MFA_ISSUER || 'Procurement Platform',
  });
};

export const verifyMFAToken = (secret: string, token: string) => {
  const speakeasy = require('speakeasy');
  const window = parseInt(process.env.MFA_WINDOW || '2');
  
  return speakeasy.totp.verify({
    secret: secret,
    encoding: 'base32',
    token: token,
    window: window,
  });
};
