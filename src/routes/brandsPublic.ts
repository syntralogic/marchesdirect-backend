import { Router, Request, Response } from 'express';
import { logger } from '../utils/logger';
import { resolveBrand } from '../utils/brandResolution';

const router = Router();

// GET /api/brands/current - public, no auth. The CRM lead-capture endpoint
// (POST /api/crm/leads) requires a brandId, but nothing on the frontend had any
// way to get one - there was no public brand lookup at all, so the contact/
// callback forms could never actually submit successfully.
//
// Resolves by matching the request's Host header against brands.domain (for
// the Milestone 10 second-brand duplication, now live - each brand carries
// its own domain, logo and color scheme) with a fallback to the first
// configured brand, which is correct for local dev and for a single-brand
// deployment.
router.get('/current', async (req: Request, res: Response) => {
  try {
    const brand = await resolveBrand(req);

    if (!brand) {
      return res.status(404).json({ error: 'No brand configured' });
    }

    res.json(brand);
  } catch (err: any) {
    logger.error('Brand resolution error:', err);
    res.status(500).json({ error: 'Failed to resolve brand' });
  }
});

export default router;
