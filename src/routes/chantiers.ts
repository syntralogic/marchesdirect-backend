import { Router, Request, Response } from 'express';
import { db } from '../config/database';
import { logger } from '../utils/logger';
import { cached } from '../utils/ttlCache';
import { DEPARTMENTS } from '../services/seoV2Service';

// « Chantiers à venir » (7 nov.) : permis de construire et déclarations préalables autorisés, base Sitadel du SDES
// (scripts/importSitadel.js). Réponses publiques SANS données personnelles : ni adresse du terrain, ni parcelles, ni
// nom du demandeur (seulement « société » ou « particulier »). La dénomination d'une société n'est donnée qu'à
// l'équipe, pour la mise en relation.
const router = Router();
const SOURCE = { label: 'SDES, base Sitadel (permis de construire et autres autorisations d’urbanisme), Licence Ouverte',
  url: 'https://www.data.gouv.fr/datasets/689c42fa521ccf80ce954f83/' };

// Destinations : fichier « logements » (1 = logements) et fichier « locaux » (codes du dictionnaire SDES).
const LOCAL_DEST: Record<number, string> = { 1: 'Habitation', 2: 'Hébergement hôtelier', 3: 'Bureaux', 4: 'Commerce', 5: 'Artisanat', 6: 'Industrie',
  7: 'Exploitation agricole ou forestière', 8: 'Entrepôt', 9: 'Service public ou d’intérêt collectif' };
export const CATEGORIES: Record<string, { label: string; where: string }> = {
  maison: { label: 'Maison individuelle', where: `kind = 'logements' AND COALESCE(dwellings, 1) <= 1` },
  logements: { label: 'Logements collectifs ou groupés', where: `kind = 'logements' AND dwellings >= 2` },
  bureaux_commerces: { label: 'Bureaux et commerces', where: `kind = 'locaux' AND destination IN (3, 4, 2)` },
  industrie: { label: 'Industrie, artisanat et entrepôts', where: `kind = 'locaux' AND destination IN (5, 6, 8)` },
  agricole: { label: 'Bâtiments agricoles', where: `kind = 'locaux' AND destination = 7` },
  public: { label: 'Équipements publics', where: `kind = 'locaux' AND destination = 9` },
};

function categoryOf(r: any): string {
  if (r.kind === 'logements') return Number(r.dwellings) >= 2 ? 'logements' : 'maison';
  const d = Number(r.destination);
  return [3, 4, 2].includes(d) ? 'bureaux_commerces' : [5, 6, 8].includes(d) ? 'industrie' : d === 7 ? 'agricole' : d === 9 ? 'public' : 'autres';
}
function publicView(r: any) {
  const cat = categoryOf(r);
  const what = r.kind === 'logements'
    ? (Number(r.dwellings) >= 2 ? `${r.dwellings} logements` : 'Maison individuelle')
    : (LOCAL_DEST[Number(r.destination)] || 'Local d’activité');
  const nature = r.nature === 'neuf' ? 'Construction neuve' : r.nature === 'existant' ? 'Travaux sur un bâtiment existant' : null;
  return {
    id: r.id, path: `/chantiers-a-venir/${encodeURIComponent(r.id)}`, category: cat, categoryLabel: CATEGORIES[cat]?.label || 'Autres projets',
    title: `${nature === 'Construction neuve' ? 'Construction' : 'Travaux'} : ${what.toLowerCase().startsWith('maison') ? 'maison individuelle' : what.toLowerCase()} à ${r.commune || 'commune non précisée'}`,
    what, nature, permit: r.type_dau === 'PC' ? 'Permis de construire' : r.type_dau === 'DP' ? 'Déclaration préalable' : 'Autorisation d’urbanisme',
    state: r.started_at ? 'started' : Number(r.etat) === 4 ? 'cancelled' : 'authorized',
    authorizedAt: r.authorized_at, startedAt: r.started_at, commune: r.commune, postalCode: r.postal_code, department: r.department,
    departmentName: DEPARTMENTS[r.department] || null, floorArea: r.floor_area != null ? Number(r.floor_area) : null,
    dwellings: r.dwellings != null ? Number(r.dwellings) : null, landArea: r.land_area != null ? Number(r.land_area) : null, pool: !!r.pool,
    applicant: r.applicant_siren || r.applicant_name ? 'Société' : 'Particulier ou demandeur non identifié',
  };
}

const hasTable = () => cached('chantiers:table', 600_000, async () =>
  (await db.query(`SELECT 1 FROM information_schema.tables WHERE table_name = 'construction_projects'`)).rows.length > 0).catch(() => false);

// GET /api/chantiers?department=33&category=maison&nature=neuf&page=1
router.get('/', async (req: Request, res: Response) => {
  try {
    if (!(await hasTable())) return res.json({ results: [], total: 0, page: 1, pages: 0, source: SOURCE });
    const dep = String(req.query.department || '').toUpperCase();
    const cat = String(req.query.category || '');
    const nature = String(req.query.nature || '');
    const page = Math.max(1, Math.min(200, Number(req.query.page) || 1)); const size = 30;
    const where: string[] = [`COALESCE(etat, 2) <> 4`]; const params: any[] = [];
    if (dep && DEPARTMENTS[dep]) { params.push(dep); where.push(`department = $${params.length}`); }
    if (CATEGORIES[cat]) where.push(`(${CATEGORIES[cat].where})`);
    if (nature === 'neuf' || nature === 'existant') { params.push(nature); where.push(`nature = $${params.length}`); }
    const w = where.join(' AND ');
    const key = `chantiers:${w}:${params.join('|')}:${page}`;
    const out = await cached(key, 600_000, async () => {
      const [rows, count] = await Promise.all([
        db.query(`SELECT * FROM construction_projects WHERE ${w} ORDER BY authorized_at DESC, id LIMIT ${size} OFFSET ${(page - 1) * size}`, params),
        db.query(`SELECT COUNT(*)::int AS n FROM construction_projects WHERE ${w}`, params),
      ]);
      const total = count.rows[0]?.n || 0;
      return { results: rows.rows.map(publicView), total, page, pages: Math.ceil(total / size) };
    });
    res.set('Cache-Control', 'public, max-age=300');
    res.json({ ...out, source: SOURCE });
  } catch (err) { logger.error('[chantiers] liste :', err); res.status(503).json({ error: 'unavailable' }); }
});

// GET /api/chantiers/stats : nombre de chantiers par département et par catégorie, dernière mise à jour.
router.get('/stats', async (_req: Request, res: Response) => {
  try {
    if (!(await hasTable())) return res.json({ total: 0, departments: [], categories: [], lastImport: null, source: SOURCE });
    const out = await cached('chantiers:stats', 300_000, async () => {
      const [d, c, t, l] = await Promise.all([
        db.query(`SELECT department, COUNT(*)::int AS n FROM construction_projects WHERE COALESCE(etat, 2) <> 4 GROUP BY 1 ORDER BY 2 DESC`),
        db.query(`SELECT kind, destination, (COALESCE(dwellings, 1) >= 2) AS multi, COUNT(*)::int AS n FROM construction_projects WHERE COALESCE(etat, 2) <> 4 GROUP BY 1, 2, 3`),
        db.query(`SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE authorized_at >= CURRENT_DATE - 30)::int AS last30, MAX(authorized_at) AS latest FROM construction_projects WHERE COALESCE(etat, 2) <> 4`),
        db.query(`SELECT finished_at FROM construction_imports WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1`).catch(() => ({ rows: [] as any[] })),
      ]);
      // Avancement de l'import en cours (couples fichier × département traités, erreurs) : sans donnée personnelle.
      const parts = await db.query(`SELECT COUNT(*) FILTER (WHERE error IS NULL)::int AS done, COUNT(*) FILTER (WHERE error IS NOT NULL)::int AS failed,
          COALESCE(json_agg(json_build_object('part', kind || ' ' || department, 'error', error)) FILTER (WHERE error IS NOT NULL), '[]') AS errors
        FROM construction_import_parts WHERE done_at > NOW() - INTERVAL '72 hours'`).catch(() => ({ rows: [] as any[] }));
      const p = parts.rows[0];
      const cats: Record<string, number> = {};
      for (const r of c.rows) { const k = categoryOf({ kind: r.kind, destination: r.destination, dwellings: r.multi ? 2 : 1 }); cats[k] = (cats[k] || 0) + r.n; }
      return {
        importProgress: p ? { partsDone: p.done, partsFailed: p.failed, partsTotal: 2 * 101, errors: (p.errors || []).slice(0, 10) } : null,
        total: t.rows[0]?.n || 0, last30: t.rows[0]?.last30 || 0, latestAuthorization: t.rows[0]?.latest || null, lastImport: l.rows[0]?.finished_at || null,
        departments: d.rows.filter((r: any) => DEPARTMENTS[r.department]).map((r: any) => ({ code: r.department, name: DEPARTMENTS[r.department], count: r.n })),
        categories: Object.entries(cats).map(([k, n]) => ({ slug: k, label: CATEGORIES[k]?.label || 'Autres projets', count: n })).sort((a, b) => b.count - a.count),
      };
    });
    res.set('Cache-Control', 'public, max-age=900');
    res.json({ ...out, source: SOURCE });
  } catch (err) { logger.error('[chantiers] stats :', err); res.status(503).json({ error: 'unavailable' }); }
});

// GET /api/chantiers/:id : fiche publique (sans données personnelles) + chantiers proches.
router.get('/:id', async (req: Request, res: Response) => {
  try {
    if (!(await hasTable())) return res.status(404).json({ error: 'not_found' });
    const r = (await db.query(`SELECT * FROM construction_projects WHERE id = $1`, [String(req.params.id)])).rows[0];
    if (!r) return res.status(404).json({ error: 'not_found' });
    const near = await db.query(`SELECT * FROM construction_projects WHERE department = $1 AND id <> $2 AND COALESCE(etat, 2) <> 4
      ORDER BY (commune_insee = $3) DESC, authorized_at DESC LIMIT 6`, [r.department, r.id, r.commune_insee]);
    res.set('Cache-Control', 'public, max-age=3600');
    res.json({ ...publicView(r), nearby: near.rows.map(publicView), source: SOURCE });
  } catch (err) { logger.error('[chantiers] fiche :', err); res.status(503).json({ error: 'unavailable' }); }
});

export default router;
