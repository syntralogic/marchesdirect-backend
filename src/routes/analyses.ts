import { Router, Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
import crypto from 'crypto';
import { db } from '../config/database';
import { logger } from '../utils/logger';
import { computeMatchScore } from '../services/matchScoreService';
import { RULES_VERSION } from '../services/matchEngine';
import { buildFacts } from '../services/analysisFacts';

// Server-side analysis snapshot (guide v24 s.4): ONE record binds company + establishment +
// market + lot + versions + answers, so homepage, fiche, animation, concordance and dossier all
// read the same data instead of a stale client-side global.
const router = Router();
const ANSWER_KEYS = ['experience', 'capacity', 'location', 'calendar'];
const ANSWER_VALUES = ['oui', 'non', 'a_confirmer'];
const cleanAnswers = (raw: any) => {
  const out: Record<string, string> = {};
  if (raw && typeof raw === 'object') for (const k of ANSWER_KEYS) if (ANSWER_VALUES.includes(raw[k])) out[k] = raw[k];
  return out;
};
const publicShape = (r: any) => ({
  analysis_id: r.id, company_id: r.company_id, company_name: r.company_name, siret: r.siret, establishment_siret: r.establishment_siret,
  market_id: r.opportunity_id, lot_id: r.lot_id, market_version: r.market_version, answers: r.answers, answers_version: r.answers_version,
  rules_version: r.rules_version, created_at: r.created_at, updated_at: r.updated_at,
});

// PUT /api/analyses - create or update the snapshot for (session, market, lot)
router.put('/', [
  body('sessionId').isString().trim().isLength({ min: 8, max: 100 }),
  body('opportunityId').isUUID(),
  body('lotId').optional({ checkFalsy: true }).isString().isLength({ max: 100 }),
], async (req: Request, res: Response) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Requête invalide.' });
  try {
    const { sessionId, opportunityId } = req.body;
    const lotId: string = req.body.lotId || '';
    const siretRow = await db.query('SELECT siret, company_data FROM siret_lookups WHERE session_id = $1', [sessionId]);
    if (!siretRow.rows.length) return res.status(403).json({ error: 'company_not_identified', message: 'Identifiez votre entreprise (SIRET) pour lancer l\'analyse.' });
    const opp = await db.query('SELECT id, updated_at FROM opportunities WHERE id = $1 AND deleted_at IS NULL', [opportunityId]);
    if (!opp.rows.length) return res.status(404).json({ error: 'Marché introuvable.' });
    const marketVersion = crypto.createHash('sha1').update(new Date(opp.rows[0].updated_at).toISOString()).digest('hex').slice(0, 12);
    const siret: string = siretRow.rows[0].siret;
    const companyName: string | null = siretRow.rows[0].company_data?.name || siretRow.rows[0].company_data?.company_name || null;
    const answers = cleanAnswers(req.body.answers);
    const prior = await db.query('SELECT id, answers, answers_version FROM analysis_snapshots WHERE session_id = $1 AND opportunity_id = $2 AND lot_id = $3', [sessionId, opportunityId, lotId]);
    let row;
    if (prior.rows.length) {
      const changed = req.body.answers !== undefined && JSON.stringify(prior.rows[0].answers) !== JSON.stringify(answers);
      row = (await db.query(
        `UPDATE analysis_snapshots SET siret = $1, establishment_siret = $1, company_name = $2, market_version = $3, rules_version = $4,
           answers = CASE WHEN $5 THEN $6::jsonb ELSE answers END, answers_version = answers_version + CASE WHEN $5 THEN 1 ELSE 0 END, updated_at = NOW()
         WHERE id = $7 RETURNING *`, [siret, companyName, marketVersion, RULES_VERSION, changed, JSON.stringify(answers), prior.rows[0].id])).rows[0];
    } else {
      row = (await db.query(
        `INSERT INTO analysis_snapshots (session_id, siret, establishment_siret, company_name, opportunity_id, lot_id, market_version, answers, answers_version, rules_version)
         VALUES ($1, $2, $2, $3, $4, $5, $6, $7::jsonb, 1, $8) RETURNING *`,
        [sessionId, siret, companyName, opportunityId, lotId, marketVersion, JSON.stringify(answers), RULES_VERSION])).rows[0];
    }
    res.json(publicShape(row));
  } catch (err: any) {
    logger.error('analysis snapshot upsert error:', err);
    res.status(500).json({ error: 'Impossible d\'enregistrer l\'analyse.' });
  }
});

// GET /api/analyses/:id?sessionId=... - the snapshot AND its concordance, from the stored answers
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const sessionId = String(req.query.sessionId || '');
    const r = await db.query('SELECT * FROM analysis_snapshots WHERE id = $1', [req.params.id]).catch(() => ({ rows: [] as any[] }));
    if (!r.rows.length || r.rows[0].session_id !== sessionId) return res.status(404).json({ error: 'Analyse introuvable.' });
    const s = r.rows[0];
    const match = await computeMatchScore(s.opportunity_id, null, { sessionId, answers: s.answers });
    const [lk, op] = await Promise.all([
      db.query('SELECT company_data, created_at FROM siret_lookups WHERE session_id = $1', [sessionId]),
      db.query(`SELECT o.title, o.buyer_name, o.official_url, o.publication_date, o.updated_at, o.location_city, o.location_department, o.deadline,
                       o.estimated_value, o.currency, o.ai_extracted_facts, ds.name AS source_name
                FROM opportunities o LEFT JOIN data_sources ds ON ds.id = o.source_id WHERE o.id = $1`, [s.opportunity_id]),
    ]);
    const facts = op.rows[0] ? buildFacts({ siret: s.siret, company: lk.rows[0]?.company_data, companyLookedUpAt: lk.rows[0]?.created_at, opp: op.rows[0], sourceName: op.rows[0].source_name, answers: s.answers }) : [];
    res.json({ ...publicShape(s), match, facts });
  } catch (err: any) {
    logger.error('analysis snapshot read error:', err);
    res.status(500).json({ error: "Impossible de charger l'analyse." });
  }
});

export default router;
