// Evidence model (guide v24 s.4): every usable fact has id, value, unit, source, dates, status, scope, precision.
// Statuses: verified | declared | inferred | missing | conflicting. An inference is never presented as verified.
export type FactStatus = 'verified' | 'declared' | 'inferred' | 'missing' | 'conflicting';
export interface Fact {
  id: string; label: string; value: string | number | null; unit?: string;
  source_id: string; source_url?: string | null; source_date?: string | null; retrieved_at?: string | null;
  status: FactStatus; scope: 'entreprise' | 'etablissement' | 'lot' | 'marche'; precision?: string;
}
const iso = (d: any) => (d ? new Date(d).toISOString() : null);
const has = (v: any) => v !== null && v !== undefined && String(v).trim() !== '';
const ext = (facts: any, k: string) => (facts?.[k]?.available && has(facts[k].value) ? facts[k].value : null);

export function buildFacts(p: { siret: string | null; company: any; companyLookedUpAt: any; opp: any; sourceName: string | null; answers: Record<string, string> }): Fact[] {
  const c = p.company || {}; const o = p.opp; const facts: Fact[] = [];
  const reg = { source_id: 'registre_entreprises', retrieved_at: iso(p.companyLookedUpAt) };
  const add = (f: Fact) => facts.push(f);
  const comp = (id: string, label: string, value: any, extra: Partial<Fact> = {}) =>
    add({ id, label, value: has(value) ? value : null, ...reg, status: has(value) ? 'verified' : 'missing', scope: 'entreprise', ...extra });

  comp('company.name', 'Raison sociale', c.name);
  add({ id: 'company.siret', label: 'SIRET de l\'établissement', value: p.siret, ...reg, status: p.siret ? 'verified' : 'missing', scope: 'etablissement' });
  comp('company.address', 'Adresse de l\'établissement', [c.address, c.postal, c.city].filter(has).join(' ') || null, { scope: 'etablissement' });
  comp('company.created', 'Date de création', c.created);
  comp('company.ape', 'Code APE', c.ape, { precision: 'Indice seulement : un code APE n\'établit pas la capacité à réaliser un lot.' });
  comp('company.activity', 'Activité décrite', c.activity);
  comp('company.employees', 'Effectif', c.employees, { precision: 'Tranche d\'effectif : ce n\'est pas un nombre de personnes disponibles.' });
  if (has(c.revenue)) {
    add({ id: 'company.revenue', label: 'Chiffre d\'affaires', value: c.revenue, unit: 'EUR', ...reg, scope: 'entreprise',
      status: c.revenueEstimated ? 'inferred' : 'verified', precision: c.revenueYear ? `Exercice ${c.revenueYear}${c.revenueEstimated ? ' (estimation)' : ''}` : (c.revenueEstimated ? 'Estimation' : undefined) });
  } else add({ id: 'company.revenue', label: 'Chiffre d\'affaires', value: null, ...reg, status: 'missing', scope: 'entreprise', precision: 'Absent : aucune pénalité liée à cette seule absence.' });
  if (Array.isArray(c.certifications) && c.certifications.length) comp('company.certifications', 'Qualifications / certifications', c.certifications.join(', '), { precision: 'Dates et portée non précisées par la source.' });

  const answerLabels: Record<string, string> = { experience: 'Références similaires', capacity: 'Moyens (équipe / capacité)', location: 'Zone d\'intervention', calendar: 'Disponibilité sur le calendrier' };
  for (const k of Object.keys(answerLabels)) {
    const v = p.answers?.[k];
    add({ id: `answer.${k}`, label: answerLabels[k], value: v && v !== 'a_confirmer' ? v : null, source_id: 'reponse_entreprise', status: v && v !== 'a_confirmer' ? 'declared' : 'missing', scope: 'lot', precision: 'Déclaration de l\'entreprise : ce n\'est pas une preuve.' });
  }

  const mk = { source_id: p.sourceName || 'source_marche', source_url: o.official_url || null, source_date: iso(o.publication_date), retrieved_at: iso(o.updated_at) };
  const mf = (id: string, label: string, value: any, extra: Partial<Fact> = {}) =>
    add({ id, label, value: has(value) ? value : null, ...mk, status: has(value) ? 'verified' : 'missing', scope: 'marche', ...extra });
  mf('market.title', 'Objet du marché', o.title);
  mf('market.buyer', 'Acheteur', o.buyer_name || ext(o.ai_extracted_facts, 'buyer_name'));
  mf('market.place', 'Lieu / zone', [o.location_city, o.location_department].filter(has).join(' ') || null);
  mf('market.deadline', 'Échéance', o.deadline ? new Date(o.deadline).toISOString() : null, { precision: 'Fuseau Europe/Paris' });
  // amount: conflicting when the structured value and the extracted one disagree by more than 10 %
  const extractedAmount = parseFloat(String(ext(o.ai_extracted_facts, 'estimated_value') ?? '').replace(/[^\d.,]/g, '').replace(',', '.'));
  const amount = has(o.estimated_value) ? Number(o.estimated_value) : null;
  const conflict = amount && Number.isFinite(extractedAmount) && extractedAmount > 0 && Math.abs(extractedAmount - amount) / amount > 0.1;
  add({ id: 'market.amount', label: 'Montant estimé', value: amount, unit: o.currency || 'EUR', ...mk, scope: 'lot', status: amount ? (conflict ? 'conflicting' : 'verified') : 'missing',
    precision: conflict ? `Deux montants différents dans les sources (${extractedAmount}). À vérifier.` : 'HT/TTC et périmètre à confirmer dans le dossier de consultation.' });
  const quals = ext(o.ai_extracted_facts, 'required_qualifications');
  add({ id: 'market.qualifications', label: 'Qualifications exigées', value: Array.isArray(quals) ? quals.join(', ') : quals, ...mk, scope: 'lot', status: quals ? 'inferred' : 'missing', precision: quals ? 'Extraites automatiquement du dossier : à vérifier dans la pièce citée.' : 'Non renseignées : voir le dossier de consultation.' });
  return facts;
}
