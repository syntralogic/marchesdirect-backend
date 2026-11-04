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

export function buildCandidatesQuery(opts: { tradeSlugs: string[]; department: string | null; limit?: number }) {
  const limit = Math.min(Math.max(Math.floor(opts.limit || 40), 1), MAX_CANDIDATES);
  const params: unknown[] = [opts.tradeSlugs];
  const where = [
    `o.deleted_at IS NULL`,
    `o.status = 'active'`,
    `(o.deadline IS NULL OR o.deadline >= NOW())`,
    `t.slug = ANY($1::text[])`,
  ];
  if (opts.department) {
    params.push(opts.department);
    where.push(`${DEPT_SQL} = $${params.length}`);
  }
  const base = `FROM opportunities o
     LEFT JOIN opportunity_types ot ON o.opportunity_type_id = ot.id
     JOIN trades t ON o.trade_id = t.id
     WHERE ${where.join(' AND ')}`;
  return {
    listSql: `SELECT o.id, o.title, ot.code AS journey, o.buyer_name, o.location_city, o.location_department, o.deadline
      ${base} ORDER BY o.deadline ASC NULLS LAST, o.publication_date DESC NULLS LAST LIMIT ${limit}`,
    countSql: `SELECT COUNT(*)::int AS n ${base}`,
    params,
  };
}
