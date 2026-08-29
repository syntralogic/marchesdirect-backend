import { Router, Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
import { db } from '../config/database';
import { logger } from '../utils/logger';
import { authenticate, optionalAuth, AuthRequest } from '../middleware/auth';
import { computeSubcontractNeedMatchScore } from '../services/matchScoreService';

const router = Router();

// Self-published subcontracting needs ("Je cherche un sous-traitant" in the
// /parcours journey and the Sous-traitance opportunity detail buyer flow).
// Mounted publicly in server.ts (browsing needs doesn't require an account,
// same as browsing opportunities) - only creation requires being logged in,
// enforced per-route below with `authenticate` rather than on the whole router.

// GET /api/subcontract-needs - browse published, non-expired needs (public)
router.get('/', async (req: Request, res: Response) => {
  try {
    const { trade, city, region, page = '1', limit = '20' } = req.query as Record<string, string>;
    const conditions: string[] = [`status = 'published'`, `(expires_at IS NULL OR expires_at > NOW())`];
    const params: any[] = [];
    let idx = 1;

    if (trade) {
      conditions.push(`(trade ILIKE $${idx} OR lot ILIKE $${idx})`);
      params.push(`%${trade}%`);
      idx++;
    }
    if (city) {
      conditions.push(`location_city ILIKE $${idx++}`);
      params.push(`%${city}%`);
    }
    if (region) {
      conditions.push(`location_region ILIKE $${idx++}`);
      params.push(`%${region}%`);
    }

    const pageNum = Math.max(parseInt(page) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit) || 20, 1), 100);
    const offset = (pageNum - 1) * limitNum;
    const whereClause = conditions.join(' AND ');

    const listResult = await db.query(
      `SELECT id, trade, lot, description, location_city, location_region, budget_min, budget_max,
              team_size, start_date, duration, qualifications, published_at, expires_at, created_at
       FROM subcontract_needs WHERE ${whereClause}
       ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, limitNum, offset]
    );
    const countResult = await db.query(`SELECT COUNT(*) as total FROM subcontract_needs WHERE ${whereClause}`, params);

    res.json({
      results: listResult.rows,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: parseInt(countResult.rows[0].total),
        totalPages: Math.ceil(parseInt(countResult.rows[0].total) / limitNum),
      },
    });
  } catch (err: any) {
    logger.error('Subcontract needs list error:', err);
    res.status(500).json({ error: 'Failed to fetch subcontracting needs' });
  }
});

// GET /api/subcontract-needs/mine - the logged-in company's own needs
// (drafts + published), for the "Sous-traitance" buyer dashboard.
router.get('/mine', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const result = await db.query(
      `SELECT * FROM subcontract_needs WHERE company_id = $1 ORDER BY created_at DESC`,
      [req.user!.companyId]
    );
    res.json({ results: result.rows });
  } catch (err: any) {
    logger.error('Subcontract needs mine error:', err);
    res.status(500).json({ error: 'Failed to fetch your needs' });
  }
});

// GET /api/subcontract-needs/:id - detail (public) + a match-score breakdown
// for the same "Analyse stratégique" style tab used on regular opportunities.
router.get('/:id', optionalAuth, async (req: Request, res: Response) => {
  try {
    const result = await db.query('SELECT * FROM subcontract_needs WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Need not found' });
    }
    const need = result.rows[0];
    res.json({ ...need, matchScore: computeSubcontractNeedMatchScore(need) });
  } catch (err: any) {
    logger.error('Subcontract need detail error:', err);
    res.status(500).json({ error: 'Failed to fetch need' });
  }
});

const needValidators = [
  body('trade').isString().trim().notEmpty(),
  body('lot').optional({ checkFalsy: true }).isString().trim(),
  body('description').optional({ checkFalsy: true }).isString().trim(),
  body('locationCity').optional({ checkFalsy: true }).isString().trim(),
  body('locationRegion').optional({ checkFalsy: true }).isString().trim(),
  body('budgetMin').optional({ checkFalsy: true }).isNumeric(),
  body('budgetMax').optional({ checkFalsy: true }).isNumeric(),
  body('teamSize').optional({ checkFalsy: true }).isString().trim(),
  body('startDate').optional({ checkFalsy: true }).isISO8601(),
  body('duration').optional({ checkFalsy: true }).isString().trim(),
  body('qualifications').optional({ checkFalsy: true }).isString().trim(),
  body('contactEmail').optional({ checkFalsy: true }).isEmail().normalizeEmail(),
  body('contactPhone').optional({ checkFalsy: true }).isString().trim(),
  // Publish immediately by default: the design's "Je cherche un sous-traitant"
  // flow submits the form and the need goes live right away (draft-saving is
  // still available for the "Mes besoins" dashboard to iterate before that).
  body('publish').optional().isBoolean(),
  body('validityDays').optional({ checkFalsy: true }).isInt({ min: 1, max: 180 }),
];

// POST /api/subcontract-needs - create a need (requires an account: it's
// tied to the poster's company, unlike opportunity/lead capture forms which
// stay anonymous).
router.post('/', authenticate, needValidators, async (req: AuthRequest, res: Response) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'Validation failed', details: errors.array() });
  }
  try {
    const {
      trade, lot, description, locationCity, locationRegion, budgetMin, budgetMax,
      teamSize, startDate, duration, qualifications, contactEmail, contactPhone,
      publish, validityDays,
    } = req.body;

    const days = validityDays || 42;
    const isPublished = publish !== false; // default: publish immediately
    const publishedAt = isPublished ? new Date() : null;
    const expiresAt = isPublished ? new Date(Date.now() + days * 24 * 60 * 60 * 1000) : null;

    const result = await db.query(
      `INSERT INTO subcontract_needs
        (company_id, created_by, trade, lot, description, location_city, location_region,
         budget_min, budget_max, team_size, start_date, duration, qualifications,
         contact_email, contact_phone, status, validity_days, published_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       RETURNING *`,
      [
        req.user!.companyId, req.user!.id, trade, lot, description, locationCity, locationRegion,
        budgetMin || null, budgetMax || null, teamSize, startDate || null, duration, qualifications,
        contactEmail, contactPhone, isPublished ? 'published' : 'draft', days, publishedAt, expiresAt,
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (err: any) {
    logger.error('Subcontract need create error:', err);
    res.status(500).json({ error: 'Failed to create your subcontracting need' });
  }
});

// PUT /api/subcontract-needs/:id/publish - publish a draft
router.put('/:id/publish', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const existing = await db.query('SELECT * FROM subcontract_needs WHERE id = $1 AND company_id = $2', [
      req.params.id,
      req.user!.companyId,
    ]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Need not found' });
    }
    const days = existing.rows[0].validity_days || 42;
    const result = await db.query(
      `UPDATE subcontract_needs SET status = 'published', published_at = NOW(),
         expires_at = NOW() + ($1 || ' days')::interval, updated_at = NOW()
       WHERE id = $2 RETURNING *`,
      [days, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err: any) {
    logger.error('Subcontract need publish error:', err);
    res.status(500).json({ error: 'Failed to publish' });
  }
});

// DELETE /api/subcontract-needs/:id - withdraw a need
router.delete('/:id', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const result = await db.query(
      `UPDATE subcontract_needs SET status = 'fulfilled', updated_at = NOW() WHERE id = $1 AND company_id = $2 RETURNING id`,
      [req.params.id, req.user!.companyId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Need not found' });
    }
    res.json({ success: true });
  } catch (err: any) {
    logger.error('Subcontract need withdraw error:', err);
    res.status(500).json({ error: 'Failed to withdraw need' });
  }
});

export default router;
