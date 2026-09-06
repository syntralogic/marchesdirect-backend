import { Router, Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
import {
  registerCompanyAndUser,
  completeSignupFromSession,
  loginUser,
  refreshAccessToken,
  requestPasswordReset,
  resetPassword,
  enableMFA,
  verifyMFASetup,
  verifyMFALogin,
} from '../services/authService';
import { authenticate, AuthRequest } from '../middleware/auth';
import { db } from '../config/database';
import { logger } from '../utils/logger';
import { resolveBrandId } from '../utils/brandResolution';

const router = Router();

// POST /api/auth/register
router.post(
  '/register',
  [
    body('companyName').notEmpty().trim(),
    body('firstName').notEmpty().trim(),
    body('lastName').notEmpty().trim(),
    body('email').isEmail().normalizeEmail(),
    body('password').isLength({ min: 8 }),
  ],
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Validation failed', details: errors.array() });
    }

    try {
      // Resolve which brand this signup belongs to from the Host header the
      // request actually arrived on (Milestone 10) - without this every
      // signup silently landed on the first brand regardless of which
      // brand's domain the person was actually using.
      const brandId = await resolveBrandId(req);
      const result = await registerCompanyAndUser(req.body, brandId);
      res.status(201).json(result);
    } catch (err: any) {
      logger.error('Register route error:', err);
      // Never leak a raw Postgres error (e.g. "duplicate key value violates
      // unique constraint...") straight to the signup form. err.code is only
      // ever set on a raw pg driver error, never on the plain Error objects
      // this service throws itself (like "Email already registered"), so it
      // reliably tells apart "expected, safe to show" from "unexpected,
      // translate to something generic".
      if (err.code === '23505') {
        return res.status(409).json({ error: 'Un compte existe déjà avec ces informations.' });
      }
      if (err.code) {
        return res.status(500).json({ error: 'Une erreur est survenue. Veuillez réessayer.' });
      }
      res.status(400).json({ error: err.message || 'Registration failed' });
    }
  }
);

// POST /api/auth/complete-signup - client priority #10: "Créer mon accès"
// step at the end of the opportunity funnel. Only a password is new here -
// email/phone/company all come from this session's already-completed SIRET
// identification + lead capture (see completeSignupFromSession). Returns
// the same shape as /register (accessToken/refreshToken included) so the
// frontend can log the visitor straight in and redirect to their dashboard
// per the client's exact ask, with no separate login step.
router.post(
  '/complete-signup',
  [
    body('sessionId').isString().trim().isLength({ min: 8, max: 100 }),
    body('password').isLength({ min: 8 }).withMessage('Le mot de passe doit contenir au moins 8 caractères.'),
  ],
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }

    try {
      const brandId = await resolveBrandId(req);
      const result = await completeSignupFromSession(req.body.sessionId, req.body.password, brandId);
      res.status(201).json(result);
    } catch (err: any) {
      logger.error('Complete-signup route error:', err);
      if (err.code === '23505') {
        return res.status(409).json({ error: 'Un compte existe déjà avec cette adresse e-mail.' });
      }
      if (err.code) {
        return res.status(500).json({ error: 'Une erreur est survenue. Veuillez réessayer.' });
      }
      res.status(400).json({ error: err.message || 'La création de votre accès a échoué.' });
    }
  }
);

// POST /api/auth/login
router.post(
  '/login',
  [body('email').isEmail().normalizeEmail(), body('password').notEmpty()],
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Validation failed', details: errors.array() });
    }

    try {
      const result = await loginUser(req.body.email, req.body.password);
      res.json(result);
    } catch (err: any) {
      logger.error('Login route error:', err);
      res.status(401).json({ error: err.message || 'Login failed' });
    }
  }
);

// POST /api/auth/mfa/verify-login
router.post('/mfa/verify-login', async (req: Request, res: Response) => {
  try {
    const { userId, mfaToken } = req.body;
    const result = await verifyMFALogin(userId, mfaToken);
    res.json(result);
  } catch (err: any) {
    res.status(401).json({ error: err.message || 'MFA verification failed' });
  }
});

// POST /api/auth/mfa/enable (requires auth)
router.post('/mfa/enable', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const result = await enableMFA(req.user!.id);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'MFA setup failed' });
  }
});

// POST /api/auth/mfa/confirm (requires auth)
router.post('/mfa/confirm', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const result = await verifyMFASetup(req.user!.id, req.body.mfaToken);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'MFA confirmation failed' });
  }
});

// POST /api/auth/refresh
router.post('/refresh', async (req: Request, res: Response) => {
  try {
    const result = await refreshAccessToken(req.body.refreshToken);
    res.json(result);
  } catch (err: any) {
    res.status(401).json({ error: err.message || 'Token refresh failed' });
  }
});

// POST /api/auth/password-reset/request
router.post('/password-reset/request', [body('email').isEmail()], async (req: Request, res: Response) => {
  try {
    const result = await requestPasswordReset(req.body.email);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Password reset request failed' });
  }
});

// POST /api/auth/password-reset/confirm (requires auth after reset link click flow)
router.post('/password-reset/confirm', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const result = await resetPassword(req.user!.id, req.body.newPassword);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Password reset failed' });
  }
});

// GET /api/auth/me
router.get('/me', authenticate, async (req: AuthRequest, res: Response) => {
  res.json({ user: req.user, company: req.company });
});

// PUT /api/auth/me/notification-preferences
//
// Backs the Profile > Notifications toggles, which previously had no table
// to persist to at all (local-only React state that reset on every reload).
// Whitelisted keys only - never trust the request body wholesale into a
// JSONB column, or any junk key the client sends gets stored forever.
const NOTIFICATION_PREFERENCE_KEYS = ['emailAlerts', 'newOpps', 'deadlineAlerts', 'weeklyDigest', 'mobileNotifs'];

router.put('/me/notification-preferences', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const incoming = req.body || {};
    const sanitized: Record<string, boolean> = { ...req.user!.notificationPreferences };

    for (const key of NOTIFICATION_PREFERENCE_KEYS) {
      if (typeof incoming[key] === 'boolean') {
        sanitized[key] = incoming[key];
      }
    }

    const result = await db.query(
      `UPDATE users SET notification_preferences = $1, updated_at = NOW() WHERE id = $2
       RETURNING notification_preferences`,
      [JSON.stringify(sanitized), req.user!.id]
    );

    res.json({ notificationPreferences: result.rows[0].notification_preferences });
  } catch (err: any) {
    logger.error('Notification preferences update error:', err);
    res.status(500).json({ error: 'Failed to update notification preferences' });
  }
});

// DELETE /api/auth/account
//
// GDPR right-to-erasure endpoint (Technical Requirements section 8/11:
// "Delete user endpoint -> GDPR compliance", "access and deletion rights").
// Soft-deletes the requesting user (deleted_at + PII anonymized), revokes all
// of their sessions, and writes an audit_logs entry. If they were the last
// active user on the company, the company record is soft-deleted and its PII
// anonymized too - company-owned records (opportunities, subscriptions, etc.)
// are intentionally left in place since they aren't personal data and other
// tables reference them by foreign key.
router.delete('/account', authenticate, async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const companyId = req.user!.companyId;

  try {
    await db.transaction(async (client) => {
      const before = await client.query('SELECT email, first_name, last_name, phone FROM users WHERE id = $1', [userId]);

      await client.query(
        `UPDATE users
         SET deleted_at = NOW(), status = 'deleted',
             email = 'deleted-user-' || id || '@anonymized.local',
             first_name = 'Deleted', last_name = 'User', phone = NULL,
             mfa_secret_encrypted = NULL, password_hash = NULL
         WHERE id = $1`,
        [userId]
      );

      await client.query('DELETE FROM user_sessions WHERE user_id = $1', [userId]);

      const remainingUsers = await client.query(
        `SELECT COUNT(*)::int AS count FROM users WHERE company_id = $1 AND deleted_at IS NULL`,
        [companyId]
      );

      if (remainingUsers.rows[0].count === 0) {
        await client.query(
          `UPDATE companies
           SET deleted_at = NOW(), status = 'deleted',
               email = 'deleted-company-' || id || '@anonymized.local',
               phone = NULL, address_street = NULL,
               stripe_customer_id = NULL
           WHERE id = $1`,
          [companyId]
        );
      }

      await client.query(
        `INSERT INTO audit_logs (user_id, company_id, action, entity_type, entity_id, old_values, ip_address, user_agent)
         VALUES ($1, $2, 'delete', 'user', $1, $3, $4, $5)`,
        [userId, companyId, JSON.stringify(before.rows[0] || {}), req.ip, req.get('user-agent') || null]
      );
    });

    res.json({ message: 'Account deleted.' });
  } catch (err: any) {
    logger.error('Account deletion failed:', err);
    res.status(500).json({ error: 'Account deletion failed' });
  }
});

export default router;
