import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { db } from '../config/database';
import { findCompanyLogo } from '../services/companyLogoService';

const router = Router();
router.use(rateLimit({ windowMs: 60000, max: 20, standardHeaders: true, legacyHeaders: false }));
router.get('/:siret', async (req, res) => {
  if (!/^\d{14}$/.test(req.params.siret)) return res.status(400).json({ logo: null });
  try {
    const siren = req.params.siret.slice(0,9);
    // Existing registry cache only: never buy data or fetch a caller-supplied URL.
    const r = await db.query('SELECT company_data, source FROM company_lookup_cache WHERE siren = $1', [siren]);
    const row = r.rows[0];
    const logo = row ? await findCompanyLogo(siren, { ...row.company_data, source: row.source }) : null;
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.json({ logo });
  } catch { return res.json({ logo: null }); }
});
export default router;
