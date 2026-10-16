// Profession (métier) <-> NAF rev.2 mapping for the prospect database (Part 6).
// Static INSEE reference data - the NAF code on each company comes from SIRENE;
// this only decides which human label / métier a code belongs to, so searches
// "par profession" are exact (code-based), never guessed from free text.

export interface NafEntry { naf: string; label: string; profession: string }

export const PROFESSIONS: Record<string, string> = {
  maconnerie: 'Maçonnerie / gros œuvre',
  charpente: 'Charpente / couverture / zinguerie',
  plomberie_chauffage: 'Plomberie / chauffage / climatisation',
  electricite: 'Électricité',
  menuiserie: 'Menuiserie / serrurerie',
  isolation: 'Isolation / étanchéité',
  platrerie_peinture: 'Plâtrerie / peinture / revêtements',
  carrelage: 'Carrelage / sols',
  terrassement_vrd: 'Terrassement / VRD / démolition',
  paysage: 'Paysagiste / espaces verts',
  renovation_batiment: 'Rénovation / bâtiment tous corps',
  nettoyage: 'Nettoyage / propreté',
  alimentaire_artisanal: 'Boulangerie / pâtisserie / boucherie',
  restauration: 'Restauration',
  coiffure_beaute: 'Coiffure / beauté',
  automobile: 'Garage / réparation automobile',
  transport: 'Transport / déménagement',
  numerique_services: 'Informatique / services aux entreprises',
  autre: 'Autre activité',
};

export const NAF_TABLE: NafEntry[] = [
  { naf: '41.20A', label: 'Construction de maisons individuelles', profession: 'renovation_batiment' },
  { naf: '41.20B', label: 'Construction d\u2019autres bâtiments', profession: 'renovation_batiment' },
  { naf: '43.11Z', label: 'Travaux de démolition', profession: 'terrassement_vrd' },
  { naf: '43.12A', label: 'Travaux de terrassement courants et travaux préparatoires', profession: 'terrassement_vrd' },
  { naf: '43.12B', label: 'Travaux de terrassement spécialisés ou de grande masse', profession: 'terrassement_vrd' },
  { naf: '42.11Z', label: 'Construction de routes et autoroutes', profession: 'terrassement_vrd' },
  { naf: '42.21Z', label: 'Construction de réseaux pour fluides', profession: 'terrassement_vrd' },
  { naf: '43.21A', label: 'Travaux d\u2019installation électrique dans tous locaux', profession: 'electricite' },
  { naf: '43.21B', label: 'Travaux d\u2019installation électrique sur la voie publique', profession: 'electricite' },
  { naf: '43.22A', label: 'Travaux d\u2019installation d\u2019eau et de gaz en tous locaux', profession: 'plomberie_chauffage' },
  { naf: '43.22B', label: 'Travaux d\u2019installation d\u2019équipements thermiques et de climatisation', profession: 'plomberie_chauffage' },
  { naf: '43.29A', label: 'Travaux d\u2019isolation', profession: 'isolation' },
  { naf: '43.29B', label: 'Autres travaux d\u2019installation n.c.a.', profession: 'renovation_batiment' },
  { naf: '43.31Z', label: 'Travaux de plâtrerie', profession: 'platrerie_peinture' },
  { naf: '43.32A', label: 'Travaux de menuiserie bois et PVC', profession: 'menuiserie' },
  { naf: '43.32B', label: 'Travaux de menuiserie métallique et serrurerie', profession: 'menuiserie' },
  { naf: '43.32C', label: 'Agencement de lieux de vente', profession: 'menuiserie' },
  { naf: '43.33Z', label: 'Travaux de revêtement des sols et des murs', profession: 'carrelage' },
  { naf: '43.34Z', label: 'Travaux de peinture et vitrerie', profession: 'platrerie_peinture' },
  { naf: '43.39Z', label: 'Autres travaux de finition', profession: 'platrerie_peinture' },
  { naf: '43.91A', label: 'Travaux de charpente', profession: 'charpente' },
  { naf: '43.91B', label: 'Travaux de couverture par éléments', profession: 'charpente' },
  { naf: '43.99A', label: 'Travaux d\u2019étanchéification', profession: 'isolation' },
  { naf: '43.99B', label: 'Travaux de montage de structures métalliques', profession: 'charpente' },
  { naf: '43.99C', label: 'Travaux de maçonnerie générale et gros œuvre de bâtiment', profession: 'maconnerie' },
  { naf: '43.99D', label: 'Autres travaux spécialisés de construction', profession: 'renovation_batiment' },
  { naf: '43.99E', label: 'Location avec opérateur de matériel de construction', profession: 'terrassement_vrd' },
  { naf: '81.30Z', label: 'Services d\u2019aménagement paysager', profession: 'paysage' },
  { naf: '81.21Z', label: 'Nettoyage courant des bâtiments', profession: 'nettoyage' },
  { naf: '81.22Z', label: 'Autres activités de nettoyage des bâtiments et nettoyage industriel', profession: 'nettoyage' },
  { naf: '10.71C', label: 'Boulangerie et boulangerie-pâtisserie', profession: 'alimentaire_artisanal' },
  { naf: '10.71D', label: 'Pâtisserie', profession: 'alimentaire_artisanal' },
  { naf: '10.13B', label: 'Charcuterie', profession: 'alimentaire_artisanal' },
  { naf: '47.22Z', label: 'Commerce de détail de viandes et produits à base de viande', profession: 'alimentaire_artisanal' },
  { naf: '56.10A', label: 'Restauration traditionnelle', profession: 'restauration' },
  { naf: '56.10C', label: 'Restauration de type rapide', profession: 'restauration' },
  { naf: '96.02A', label: 'Coiffure', profession: 'coiffure_beaute' },
  { naf: '96.02B', label: 'Soins de beauté', profession: 'coiffure_beaute' },
  { naf: '45.20A', label: 'Entretien et réparation de véhicules automobiles légers', profession: 'automobile' },
  { naf: '45.20B', label: 'Entretien et réparation d\u2019autres véhicules automobiles', profession: 'automobile' },
  { naf: '49.41A', label: 'Transports routiers de fret interurbains', profession: 'transport' },
  { naf: '49.42Z', label: 'Services de déménagement', profession: 'transport' },
  { naf: '62.01Z', label: 'Programmation informatique', profession: 'numerique_services' },
  { naf: '62.02A', label: 'Conseil en systèmes et logiciels informatiques', profession: 'numerique_services' },
];

const BY_NAF = new Map(NAF_TABLE.map(e => [e.naf, e]));

/** Normalise "4321a", "43.21A" or "4321A" -> "43.21A"; null if not a NAF code. */
export function normalizeNaf(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = String(raw).trim().toUpperCase().replace('.', '');
  const m = /^(\d{2})(\d{2})([A-Z])$/.exec(s);
  return m ? `${m[1]}.${m[2]}${m[3]}` : null;
}

export function nafInfo(naf: string | null | undefined): { label: string | null; profession: string } {
  const code = normalizeNaf(naf);
  const hit = code ? BY_NAF.get(code) : undefined;
  return hit ? { label: hit.label, profession: hit.profession } : { label: null, profession: 'autre' };
}

export function nafCodesForProfession(profession: string): string[] {
  return NAF_TABLE.filter(e => e.profession === profession).map(e => e.naf);
}

export function isKnownProfession(p: string): boolean {
  return Object.prototype.hasOwnProperty.call(PROFESSIONS, p);
}
