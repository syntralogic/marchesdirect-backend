// Registry fields only; no new Pappers/INSEE request and no inferred trade.
const text = (v: unknown): string | undefined => typeof v === 'string' && v.trim() ? v.trim().slice(0, 255) : undefined;
export function departmentFromPostal(postal: unknown): string | undefined {
  const p = text(postal);
  if (!p || !/^\d{5}$/.test(p)) return undefined;
  if (/^97[1-6]/.test(p)) return p.slice(0, 3);
  if (p.startsWith('20')) return p < '20200' ? '2A' : '2B';
  return p.slice(0, 2);
}
export function buildCompanyProfile(company: any, firstSelectedAt?: Date | string | null): Record<string, string> {
  const c = company || {};
  const values = {
    md_naf_code: text(c.ape), md_trade: text(c.activity),
    address: text(c.address), city: text(c.city), zip: text(c.postal),
    md_department: departmentFromPostal(c.postal),
    md_siret_entered_at: firstSelectedAt ? new Date(firstSelectedAt).toISOString() : undefined,
  };
  return Object.fromEntries(Object.entries(values).filter(([,v]) => v !== undefined)) as Record<string,string>;
}
export function buildCompanyScore(score: any): Record<string, string | number> {
  if (!score || typeof score.compatibility_score !== 'number' || !score.score_computed_at) return {};
  return {
    md_compatibility_score: score.compatibility_score,
    md_score_date: new Date(score.score_computed_at).toISOString(),
    ...(score.rules_version ? { md_score_version: score.rules_version } : {}),
  };
}
