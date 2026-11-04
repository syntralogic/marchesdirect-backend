// Home page, "Par entreprise" search (client brief v26, 1.2): the métier and the zone are DEDUCED from the recognised
// company (APE/NAF code + postal code of its head office), never asked. Static mapping, no network.
import { nafInfo, PROFESSIONS } from './prospectNaf';

// Keyword the existing search understands (free text, like the "Votre métier" field), per profession key.
const PROFESSION_QUERY: Record<string, string> = {
  maconnerie: 'maçonnerie',
  charpente: 'charpente',
  plomberie_chauffage: 'plomberie',
  electricite: 'électricité',
  menuiserie: 'menuiserie',
  isolation: 'isolation',
  platrerie_peinture: 'peinture',
  carrelage: 'carrelage',
  terrassement_vrd: 'terrassement',
  paysage: 'espaces verts',
  renovation_batiment: 'rénovation',
  nettoyage: 'nettoyage',
  numerique_services: 'informatique',
};

/** Postal code -> department code ("69003" -> "69", "20090" -> "2A", "97400" -> "974"); null if not a French postal code. */
export function departmentFromPostal(postal: string | null | undefined): string | null {
  const p = String(postal || '').replace(/\s/g, '');
  if (!/^\d{5}$/.test(p)) return null;
  if (p.startsWith('20')) return Number(p) < 20200 ? '2A' : '2B';
  if (p.startsWith('97') || p.startsWith('98')) return p.slice(0, 3);
  return p.slice(0, 2);
}

export interface CompanySearchParams {
  profession: string;
  professionLabel: string;
  /** Keyword for the search, or null when the activity has no usable keyword (then the zone alone is used). */
  query: string | null;
  department: string | null;
}

export function searchParamsForCompany(ape: string | null | undefined, postal: string | null | undefined): CompanySearchParams {
  const { profession } = nafInfo(ape);
  return {
    profession,
    professionLabel: PROFESSIONS[profession] || PROFESSIONS.autre,
    query: PROFESSION_QUERY[profession] || null,
    department: departmentFromPostal(postal),
  };
}

// "Marchés ouverts aujourd'hui" counter: refreshed once each morning. The day rolls over at 06:00 Paris time, so the
// line says "mis à jour chaque matin" truthfully and the 24 h cache has a stable key.
export function openCountDayKey(now: Date = new Date()): string {
  const paris = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
  paris.setHours(paris.getHours() - 6);
  const y = paris.getFullYear(); const m = String(paris.getMonth() + 1).padStart(2, '0'); const d = String(paris.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
