import axios from 'axios';
import { logger } from '../utils/logger';
import { nafInfo, normalizeNaf } from '../utils/prospectNaf';
import { DEPARTMENT_TO_REGION, regionForDepartmentCode } from '../utils/departmentRegion';

// Free, key-less official API (DINUM / INSEE data): https://recherche-entreprises.api.gouv.fr
// Documented limit: 7 requests/second; we stay well under it. 25 results/page max,
// 400 pages max per query (=10,000 results), so large areas are split by
// département x NAF code by the import job.
const BASE = process.env.RECHERCHE_ENTREPRISES_URL || 'https://recherche-entreprises.api.gouv.fr/search';
const MIN_GAP_MS = parseInt(process.env.SIRENE_MIN_GAP_MS || '250', 10);
const MAX_RETRIES = 4;
let lastCall = 0;

export class SireneError extends Error {
  constructor(message: string, public status?: number) { super(message); }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export interface SireneQuery {
  q?: string;
  naf?: string;            // activite_principale
  departement?: string;
  codePostal?: string;
  commune?: string;        // INSEE commune code (not name)
  page?: number;
  perPage?: number;
}

export interface FieldMetaEntry { status: 'confirmed' | 'confirmed_missing' | 'not_checked' | 'unavailable' | 'error'; source?: string; at?: string; note?: string }

export interface ProspectRecord {
  siret: string; siren: string; is_head_office: boolean;
  company_name: string; trading_name: string | null;
  naf_code: string | null; activity_label: string | null; profession: string;
  legal_form_code: string | null; legal_form_label: string | null;
  is_artisan: boolean | null; status: 'active' | 'closed';
  creation_date: string | null; closure_date: string | null;
  employee_range: string | null; employee_range_code: string | null;
  revenue_eur: number | null; revenue_year: number | null; net_result_eur: number | null;
  address_line: string | null; postal_code: string | null; city: string | null;
  department: string | null; region: string | null;
  latitude: number | null; longitude: number | null;
  directors: Array<{ name: string; role: string | null; kind: 'personne' | 'entreprise' }>;
  certifications: string[];
  history: Array<{ date: string | null; event: string; source: string }>;
  field_meta: Record<string, FieldMetaEntry>;
}

export const EMPLOYEE_RANGES: Record<string, string> = {
  '00': '0 salarié', '01': '1 ou 2 salariés', '02': '3 à 5 salariés', '03': '6 à 9 salariés',
  '11': '10 à 19 salariés', '12': '20 à 49 salariés', '21': '50 à 99 salariés', '22': '100 à 199 salariés',
  '31': '200 à 249 salariés', '32': '250 à 499 salariés', '41': '500 à 999 salariés', '42': '1 000 à 1 999 salariés',
  '51': '2 000 à 4 999 salariés', '52': '5 000 à 9 999 salariés', '53': '10 000 salariés et plus',
};

// Most common INSEE "catégories juridiques" (niveau III). Unknown codes keep the code
// and a null label - never a guessed label.
export const LEGAL_FORMS: Record<string, string> = {
  '1000': 'Entrepreneur individuel', '5202': 'Société en nom collectif', '5306': 'Société en commandite simple',
  '5410': 'SARL', '5415': 'SARL d\u2019économie mixte', '5422': 'SARL (associé unique)', '5432': 'SARL',
  '5442': 'SARL', '5451': 'SARL', '5453': 'SARL', '5454': 'SARL', '5455': 'SARL',
  '5458': 'SARL', '5460': 'SARL', '5498': 'EURL', '5499': 'Société à responsabilité limitée',
  '5505': 'SA à conseil d\u2019administration', '5510': 'SA', '5599': 'SA',
  '5699': 'SA à directoire', '5710': 'SAS', '5720': 'SASU', '5800': 'Société coopérative',
  '6540': 'Société civile immobilière', '6599': 'Société civile', '9220': 'Association déclarée',
  '9221': 'Association déclarée d\u2019insertion', '9222': 'Association intermédiaire',
};

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const coord = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const dateOnly = (v: unknown): string | null => {
  const s = str(v);
  return s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
};

export function departmentOf(codePostal: string | null, deptField: string | null): string | null {
  if (deptField) return deptField.toUpperCase();
  if (!codePostal || codePostal.length < 5) return null;
  if (codePostal.startsWith('20')) return Number(codePostal) < 20200 ? '2A' : '2B';
  if (/^9[78]/.test(codePostal)) return codePostal.slice(0, 3);
  return codePostal.slice(0, 2);
}

/** Map one API "result" (a company with its siège / matching establishments) to 0..n ProspectRecord. */
export function mapSireneResult(r: any, nowIso = new Date().toISOString()): ProspectRecord[] {
  const siren = str(r?.siren);
  if (!siren || !/^\d{9}$/.test(siren)) return [];
  const name = str(r.nom_raison_sociale) || str(r.nom_complet);
  if (!name || /NON-DIFFUSIBLE/i.test(name)) return []; // non-diffusible: never exposed

  const estabs: any[] = [];
  const seen = new Set<string>();
  for (const e of [r.siege, ...(Array.isArray(r.matching_etablissements) ? r.matching_etablissements : [])]) {
    const s = str(e?.siret);
    if (s && /^\d{14}$/.test(s) && !seen.has(s)) { seen.add(s); estabs.push(e); }
  }

  const finances = r.finances && typeof r.finances === 'object' ? r.finances : null;
  const years = finances ? Object.keys(finances).filter(y => /^\d{4}$/.test(y)).sort() : [];
  const lastYear = years.length ? years[years.length - 1] : null;
  const fin = lastYear ? finances[lastYear] : null;

  const comp = r.complements && typeof r.complements === 'object' ? r.complements : {};
  const certifs: string[] = [];
  if (comp.est_rge === true) certifs.push('RGE (Reconnu Garant de l\u2019Environnement)');
  if (comp.est_qualiopi === true) certifs.push('Qualiopi');
  if (comp.est_bio === true) certifs.push('Agriculture biologique');
  if (comp.est_ess === true) certifs.push('ESS (Économie sociale et solidaire)');
  if (comp.est_organisme_formation === true) certifs.push('Organisme de formation');
  if (comp.est_entrepreneur_spectacle === true) certifs.push('Entrepreneur de spectacles vivants');

  const directors = (Array.isArray(r.dirigeants) ? r.dirigeants : [])
    .map((d: any) => {
      const person = [str(d?.prenoms), str(d?.nom)].filter(Boolean).join(' ');
      const nm = person || str(d?.denomination);
      return nm ? { name: nm, role: str(d?.qualite), kind: (d?.type_dirigeant === 'personne morale' ? 'entreprise' : 'personne') as 'personne' | 'entreprise' } : null;
    })
    .filter(Boolean) as ProspectRecord['directors'];

  const legalCode = str(r.nature_juridique);
  const closedCompany = r.etat_administratif === 'C';

  return estabs.map(e => {
    const isHead = e === r.siege || str(e.siret) === str(r.siege?.siret);
    const naf = normalizeNaf(str(e.activite_principale) || str(r.activite_principale));
    const info = nafInfo(naf);
    const postal = str(e.code_postal);
    const dept = departmentOf(postal, str(e.departement));
    const region = dept ? (regionForDepartmentCode(dept) || DEPARTMENT_TO_REGION[dept] || null) : null;
    const effCode = str(e.tranche_effectif_salarie) || (isHead ? str(r.tranche_effectif_salarie) : null);
    const closed = closedCompany || e.etat_administratif === 'F' || e.etat_administratif === 'C';
    const creation = dateOnly(e.date_creation) || (isHead ? dateOnly(r.date_creation) : null);
    const meta = (ok: boolean, note?: string): FieldMetaEntry => ok
      ? { status: 'confirmed', source: 'sirene', at: nowIso }
      : { status: 'confirmed_missing', source: 'sirene', at: nowIso, ...(note ? { note } : {}) };

    const history: ProspectRecord['history'] = [];
    if (creation) history.push({ date: creation, event: isHead ? 'Création de l\u2019entreprise' : 'Ouverture de l\u2019établissement', source: 'sirene' });
    if (closed) history.push({ date: dateOnly(r.date_fermeture), event: 'Cessation d\u2019activité', source: 'sirene' });
    const nbEstab = num(r.nombre_etablissements);
    if (isHead && nbEstab && nbEstab > 1) history.push({ date: null, event: `${nbEstab} établissements enregistrés`, source: 'sirene' });

    return {
      siret: String(e.siret), siren, is_head_office: isHead,
      company_name: name, trading_name: str(r.sigle) || str(e.nom_commercial) || str(e.enseigne_1),
      naf_code: naf, activity_label: info.label, profession: info.profession,
      legal_form_code: legalCode, legal_form_label: legalCode ? LEGAL_FORMS[legalCode] || null : null,
      is_artisan: typeof comp.est_artisan === 'boolean' ? comp.est_artisan : null,
      status: closed ? 'closed' : 'active',
      creation_date: creation, closure_date: closed ? dateOnly(r.date_fermeture) : null,
      employee_range: effCode ? EMPLOYEE_RANGES[effCode] || null : null, employee_range_code: effCode,
      revenue_eur: fin ? num(fin.ca) : null, revenue_year: fin && lastYear ? Number(lastYear) : null,
      net_result_eur: fin ? num(fin.resultat_net) : null,
      address_line: str(e.adresse) || str(e.geo_adresse), postal_code: postal,
      city: str(e.libelle_commune), department: dept, region,
      latitude: coord(e.latitude), longitude: coord(e.longitude),
      directors: isHead ? directors : [],
      certifications: certifs, history,
      field_meta: {
        company_name: meta(true), address: meta(!!(e.adresse || e.geo_adresse)),
        naf_code: meta(!!naf), creation_date: meta(!!creation),
        legal_form: meta(!!legalCode), employee_range: meta(!!effCode, 'tranche non renseignée ou non diffusée par l\u2019INSEE'),
        revenue: meta(!!fin && num(fin.ca) !== null, 'chiffre d\u2019affaires non publié (comptes non déposés ou confidentiels)'),
        directors: isHead ? meta(directors.length > 0, 'aucun dirigeant publié au registre') : { status: 'not_checked', source: 'sirene', at: nowIso, note: 'dirigeants rattachés au siège' },
        certifications: meta(certifs.length > 0, 'aucune certification publique connue dans cette source (RGE, Qualiopi, bio, ESS)'),
        history: { status: 'confirmed', source: 'sirene', at: nowIso, note: 'événements du registre uniquement (création, cessation); BODACC/INPI non intégrés' },
        coordinates: meta(coord(e.latitude) !== null && coord(e.longitude) !== null),
      },
    };
  });
}

export interface SirenePage { records: ProspectRecord[]; totalResults: number; totalPages: number; skippedNonDiffusible: number; rawCount: number }

export async function fetchSirenePage(q: SireneQuery): Promise<SirenePage> {
  const params: Record<string, string | number> = {
    per_page: Math.min(25, q.perPage || 25), page: q.page || 1, etat_administratif: 'A',
  };
  if (q.q) params.q = q.q;
  if (q.naf) params.activite_principale = q.naf;
  if (q.departement) params.departement = q.departement;
  if (q.codePostal) params.code_postal = q.codePostal;
  if (q.commune) params.commune = q.commune;

  for (let attempt = 0; ; attempt++) {
    const wait = lastCall + MIN_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    try {
      const { data } = await axios.get(BASE, { params, timeout: 20000 });
      const results: any[] = Array.isArray(data?.results) ? data.results : [];
      const records = results.flatMap(r => mapSireneResult(r));
      const skipped = results.filter(r => /NON-DIFFUSIBLE/i.test(String(r?.nom_complet || ''))).length;
      return {
        records, rawCount: results.length, skippedNonDiffusible: skipped,
        totalResults: num(data?.total_results) ?? 0, totalPages: num(data?.total_pages) ?? 0,
      };
    } catch (err: any) {
      const status = err?.response?.status as number | undefined;
      const retryable = !status || status === 429 || status >= 500;
      if (retryable && attempt < MAX_RETRIES) {
        const delay = status === 429 ? 2000 * (attempt + 1) : 800 * 2 ** attempt;
        logger.warn(`SIRENE API ${status || err?.code || 'error'} - retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms`);
        await sleep(delay);
        continue;
      }
      throw new SireneError(`recherche-entreprises API failed${status ? ` (HTTP ${status})` : `: ${err?.message}`}`, status);
    }
  }
}
