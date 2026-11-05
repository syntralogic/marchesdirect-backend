// Refonte v26, écran 2 « Vos marchés »: the open markets of the visitor's trade and zone, WITHOUT their percentage.
// The cards must appear at once; each percentage is then computed by the existing match-score endpoint (rules only, no AI)
// and the page fills them in as they arrive. A market outside the trade is never added "to make up the numbers".
export const MAX_CANDIDATES = 60;

// Same normalisation the department statistics use: "5" and "05" are the same department.
const DEPT_SQL = `(CASE WHEN TRIM(o.location_department) ~ '^[0-9]+$' THEN LPAD(TRIM(o.location_department), 2, '0') ELSE UPPER(TRIM(o.location_department)) END)`;

export function normaliseZone(zone: unknown): string | null {
  if (typeof zone !== 'string') return null;
  const z = zone.trim().toUpperCase();
  if (z === '' || z === 'FRANCE') return null;
  return /^(\d{1,3}|2A|2B)$/.test(z) ? (/^\d{1,2}$/.test(z) ? z.padStart(2, '0') : z) : null;
}

export function buildCandidatesQuery(opts: { tradeSlugs: string[]; department: string | null; limit?: number; v2?: boolean }) {
  const limit = Math.min(Math.max(Math.floor(opts.limit || 40), 1), MAX_CANDIDATES);
  const params: unknown[] = [opts.tradeSlugs];
  const where = [
    `o.deleted_at IS NULL`,
    `o.status = 'active'`,
    `(o.deadline IS NULL OR o.deadline >= NOW())`,
    `t.slug = ANY($1::text[])`,
    // 4 Nov (mandat client : « aucun faux résultat ») : pas d'annonce de démonstration dans la liste classée.
    `COALESCE(ds.code, '') <> 'editorial_catalog'`,
  ];
  // v2 (aperçu seulement, ?loc=2) : date limite relue dans l'avis, annulées exclues, lieu d'exécution prioritaire,
  // acheteur seul quand l'avis ne donne aucun lieu ; un avis seulement publié dans le département n'y entre pas.
  const DL = opts.v2 ? 'COALESCE(l.notice_deadline, o.deadline)' : 'o.deadline';
  if (opts.v2) { where[2] = `(${DL} IS NULL OR ${DL} >= NOW())`; where.push('NOT COALESCE(o.is_cancelled, false)'); }
  if (opts.department) {
    params.push(opts.department);
    where.push(opts.v2
      ? `((l.opportunity_id IS NOT NULL AND ($${params.length} = ANY(l.exec_departments) OR (cardinality(l.exec_departments) = 0 AND l.buyer_department = $${params.length}))) OR (l.opportunity_id IS NULL AND ${DEPT_SQL} = $${params.length}))`
      : `${DEPT_SQL} = $${params.length}`);
  }
  const base = `FROM opportunities o
     LEFT JOIN opportunity_types ot ON o.opportunity_type_id = ot.id
     JOIN trades t ON o.trade_id = t.id
     LEFT JOIN data_sources ds ON o.source_id = ds.id${opts.v2 ? '\n     LEFT JOIN opportunity_locations l ON l.opportunity_id = o.id' : ''}
     WHERE ${where.join(' AND ')}`;
  const lvl = opts.v2 && opts.department ? `(CASE WHEN $${params.length} = ANY(l.exec_departments) THEN 0 WHEN l.opportunity_id IS NOT NULL THEN 1 ELSE 2 END)` : '0';
  const v2Cols = opts.v2 ? `, ${DL} AS deadline_checked, CASE WHEN ${DL} IS NULL THEN 'verify' ELSE 'open' END AS open_state, ${lvl} AS location_level,
      l.exec_status, l.exec_communes, l.exec_departments, l.exec_text, l.buyer_city, l.buyer_department, l.publication_departments` : '';
  return {
    listSql: `SELECT o.id, o.title, ot.code AS journey, o.buyer_name, o.location_city, o.location_department, o.deadline${v2Cols}
      ${base} ORDER BY ${opts.v2 ? `(${DL} IS NULL) ASC, ${lvl} ASC, ` : ''}${DL} ASC NULLS LAST, o.publication_date DESC NULLS LAST${opts.v2 ? ', o.id ASC' : ''} LIMIT ${limit}`,
    countSql: `SELECT COUNT(*)::int AS n ${base}`,
    params,
  };
}
