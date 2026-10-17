import rateLimit from 'express-rate-limit';
import { Router, Response } from 'express';
import { body, validationResult } from 'express-validator';
import { logger } from '../utils/logger';
import { AuthRequest } from '../middleware/auth';
import { getAdvisorAdvice } from '../services/advisorAdviceService';
import type { RefineAnswers } from '../services/matchEngine';

const router = Router();

// Anonymous callers could otherwise burn AI credits: cap per IP (identical facts are also cached).
const adviceLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

const KEYS = ['experience', 'capacity', 'location', 'calendar'] as const;
const VALUES = ['oui', 'non', 'a_confirmer'];
const cleanAnswers = (raw: any): RefineAnswers => {
  const out: RefineAnswers = {};
  if (raw && typeof raw === 'object') for (const k of KEYS) if (VALUES.includes(raw[k])) (out as any)[k] = raw[k];
  return out;
};

// POST /api/advisor/advice - the AI-written "regard du chargé d'affaires".
// The browser sends only identifiers + the visitor's answers; every fact given to the AI is read server-side.
// { advice: null } means "use your deterministic text" (AI down, output rejected, closed market...).
router.post('/advice', adviceLimiter, [
  body('kind').isIn(['opportunity', 'compatibility']),
  body('opportunityId').isUUID(),
  body('sessionId').optional({ checkFalsy: true }).isString().isLength({ min: 8, max: 100 }),
], async (req: AuthRequest, res: Response) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Requête invalide.' });
  try {
    const advice = await getAdvisorAdvice({
      kind: req.body.kind,
      opportunityId: req.body.opportunityId,
      sessionId: req.body.sessionId || null,
      email: req.user?.email || null,
      answers: cleanAnswers(req.body.answers),
    });
    res.json({ advice });
  } catch (err) {
    logger.error('advisor advice error:', err);
    res.json({ advice: null });
  }
});

export default router;
