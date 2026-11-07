import { Router, Request, Response } from 'express';
import { db } from '../config/database';
import { logger } from '../utils/logger';
import { optionalAuth, AuthRequest } from '../middleware/auth';
import { loadCompanyProfile } from '../services/matchScoreService';
import { priceRange, peersWhoWon, buyerAwards, CPV_BY_TRADE, CPV_LABEL, MONTHS_FR } from '../services/awardsService';
import { lotsFromDescription } from '../utils/boampLots';
import { extractTradeSlugs } from '../services/tradeResolver';

// Attributions publiques (7 nov.) : ce que les marchés déjà attribués apprennent sur une annonce ou un acheteur.
const router = Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Le code CPV de l'avis : stocké sur l'annonce, sinon lu dans l'avis BOAMP brut (classPrincipale / cbc:ItemClassificationCode).
function cpvOf(o: any): string | null {
  if (o.cpv_display && /^\d{8}/.test(o.cpv_display)) return o.cpv_display.slice(0, 8);
  const raw = typeof o.raw_data?.donnees === 'string' ? o.raw_data.donnees : JSON.stringify(o.raw_data?.donnees || o.raw_data || '');
  const m = /"classPrincipale"\s*:\s*"(\d{8})/.exec(raw) || /ItemClassificationCode[^}]*?"#text"\s*:\s*"(\d{8})/.exec(raw) || /"codeCPV"\s*:\s*"(\d{8})/.exec(raw);
  return m ? m[1] : null;
}
// Montants arrondis, lisibles d'un coup d'œil : 48 000 → « 48 000 € », 402 345 → « 400 000 € », 1 250 000 → « 1,3 M€ ».
const fmt = (n: number) => n >= 1e6 ? `${(Math.round(n / 1e5) / 10).toLocaleString('fr-FR')} M€` : `${(Math.round(n / (n >= 1e5 ? 1e4 : 1e3)) * (n >= 1e5 ? 1e4 : 1e3)).toLocaleString('fr-FR')} €`;

// GET /api/awards/opportunity/:id?sessionId= : fourchette de prix comparables + entreprises comme la vôtre.
router.get('/opportunity/:id', optionalAuth, async (req: AuthRequest, res: Response) => {
  try {
    if (!UUID.test(req.params.id)) return res.status(404).json({ error: 'not_found' });
    const o = (await db.query(`SELECT o.id, o.title, o.description, o.raw_data, o.buyer_name, o.nature_prestation, o.estimated_value, c.code AS cpv_display,
        ot.code AS journey, COALESCE(l.exec_departments[1], o.location_department) AS dept, t.slug AS trade_slug
      FROM opportunities o LEFT JOIN cpv_codes c ON o.cpv_code_id = c.id LEFT JOIN opportunity_types ot ON ot.id = o.opportunity_type_id
      LEFT JOIN opportunity_locations l ON l.opportunity_id = o.id LEFT JOIN trades t ON t.id = o.trade_id WHERE o.id = $1 AND o.deleted_at IS NULL`, [req.params.id])).rows[0];
    if (!o) return res.status(404).json({ error: 'not_found' });
    if (o.journey !== 'public_procurement') return res.json({ available: false, reason: 'private' });
    const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : '';
    let companyId: string | null = null;
    if (req.user?.email) companyId = (await db.query('SELECT company_id FROM users WHERE email = $1 AND deleted_at IS NULL', [req.user.email])).rows[0]?.company_id || null;
    const profile = companyId || sessionId ? await loadCompanyProfile(companyId, sessionId) : null;
    const companyTrades = profile?.tradeSlugs || [];
    // CPV : celui de l'avis ; sinon la famille du métier de l'entreprise (ou du lot qui la concerne), pour comparer ce qui est comparable.
    let cpv = cpvOf(o); let cpvFrom: 'avis' | 'metier' = 'avis';
    if (!cpv) {
      const lotTrades = lotsFromDescription(o.description).flatMap(l => extractTradeSlugs(l));
      const slug = companyTrades.find(s => lotTrades.includes(s)) || companyTrades[0] || o.trade_slug || lotTrades[0];
      const fam = slug ? CPV_BY_TRADE[slug]?.[0] : null; if (fam) { cpv = `${fam}0000`; cpvFrom = 'metier'; }
    }
    const type = o.nature_prestation === 'services' ? 'Services' : o.nature_prestation === 'travaux' ? 'Travaux' : null;
    const [range, peers] = await Promise.all([priceRange(cpv, type, o.dept || null), companyTrades.length ? peersWhoWon(companyTrades, cpv, o.dept || null, null) : Promise.resolve(null)]);
    const famLabel = cpv ? (CPV_LABEL[cpv.slice(0, 4)] || null) : null;
    res.set('Cache-Control', 'private, max-age=600');
    res.json({ available: !!(range || peers), cpv, cpvFrom, familyLabel: famLabel,
      // Court et donnant envie : une ligne de prix, une ligne de pairs. Le détail (nombre de marchés, périmètre) reste disponible mais discret.
      price: range ? { ...range, text: `Des marchés comme celui-ci se gagnent en général entre ${fmt(range.low)} et ${fmt(range.high)}.`, detail: `${range.count} marchés ${famLabel ? `(${famLabel}) ` : ''}attribués ${range.scope === 'departement' ? 'dans ce département' : 'en France'} ces ${range.years} ans · médiane ${fmt(range.median)}` } : null,
      peers: peers ? { ...peers, text: peers.sameDepartment ? `${peers.sameDepartment} entreprise${peers.sameDepartment > 1 ? 's' : ''} de votre métier ${peers.sameDepartment > 1 ? 'ont' : 'a'} déjà gagné ici. Pourquoi pas vous ?` : `${peers.count} entreprise${peers.count > 1 ? 's' : ''} de votre métier ${peers.count > 1 ? 'ont' : 'a'} déjà gagné ce type de marché. Pourquoi pas vous ?`, detail: `${peers.count} entreprises en France${peers.pme ? `, dont ${peers.pme} PME` : ''}, ces 3 ans` } : null,
      note: 'Montants attribués (HT) publiés par les acheteurs publics, comparés par famille de prestations. Ils situent un ordre de grandeur, pas le prix de votre offre.' });
  } catch (err) { logger.error('[attributions] fiche :', err); res.status(503).json({ error: 'unavailable' }); }
});

// GET /api/awards/buyer?name=…&siret=… : habitudes d'un acheteur (mois, familles, part de PME, offres reçues).
router.get('/buyer', async (req: Request, res: Response) => {
  try {
    const name = typeof req.query.name === 'string' ? req.query.name.trim().slice(0, 300) : null;
    const siret = typeof req.query.siret === 'string' && /^\d{14}$/.test(req.query.siret) ? req.query.siret : null;
    if (!name && !siret) return res.status(400).json({ error: 'name_or_siret' });
    const b = await buyerAwards(siret, name);
    res.set('Cache-Control', 'public, max-age=3600');
    if (!b) return res.json({ available: false });
    const peaks = b.peakMonths.map(m => MONTHS_FR[m - 1]);
    res.json({ available: true, ...b,
      seasonText: peaks.length ? `Cet acheteur attribue surtout en ${peaks.join(', ')} (${b.contracts} marchés sur ${b.years} an${b.years > 1 ? 's' : ''}).` : `${b.contracts} marchés attribués sur ${b.years} an${b.years > 1 ? 's' : ''}, sans saison marquée.`,
      pmeText: b.pmeShare != null ? `${b.pmeShare} % des titulaires sont des PME.` : null,
      offersText: b.avgOffers != null ? `${b.avgOffers} offres reçues en moyenne par marché.` : null });
  } catch (err) { logger.error('[attributions] acheteur :', err); res.status(503).json({ error: 'unavailable' }); }
});

export default router;
