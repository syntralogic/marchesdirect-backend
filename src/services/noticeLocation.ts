// Localisation d'un avis (6 nov., demande de Hedi : « sépare lieu d'exécution, adresse de l'acheteur et département de
// publication ; une information manquante doit rester explicitement inconnue »).
//
// Trois informations distinctes, lues dans l'avis BOAMP tel que publié (raw_data) :
//   1. exécution  : où la prestation a lieu. eForms (marchés européens) : cac:RealizedLocation (commune, code postal,
//                   code NUTS). Formulaires nationaux FNSimple : natureMarche.lieuExecution (texte libre, ex.
//                   « FRI12 - Gironde », « Bouliac 33270 », « Plusieurs lieux »). MAPA : description.lieuExecutionLivraison.
//   2. acheteur   : adresse de l'organisme (eForms : organisation désignée par ContractingParty ; national : organisme).
//   3. publication: départements où l'avis est diffusé (code_departement). Ce n'est PAS un lieu : un avis peut être
//                   publié en Gironde pour un chantier dans le Territoire de Belfort (ex. 26-102762).
// Rien n'est deviné : sans source, l'exécution vaut « inconnue ». Aucun appel externe, aucune IA : lecture pure du texte.
import { DEPARTMENTS, slugify, isCommuneName, displayCity } from './seoV2Service';

export const LOCATION_EXTRACTOR_VERSION = 3; // 3 : date limite avec son vrai fuseau horaire // 2 : entités HTML décodées, lieu lu dans le titre « (17) ROCHEFORT - … »

export type ExecCommune = { name: string; slug: string; postalCode: string | null; department: string | null };
export type NoticeLocation = {
  execution: {
    status: 'commune' | 'departement' | 'texte' | 'etranger' | 'inconnu';
    communes: ExecCommune[];
    departments: string[];
    /** Texte d'origine quand l'avis décrit le lieu en clair (« Plusieurs lieux », adresse…). */
    text: string | null;
    source: 'eforms' | 'fnsimple' | 'mapa' | 'titre' | 'aucune';
  };
  buyer: { city: string | null; postalCode: string | null; department: string | null };
  publicationDepartments: string[];
};

// Codes NUTS 3 (2021) → département. Source : nomenclature NUTS de la France (Eurostat), 101 départements.
const NUTS3: Record<string, string> = Object.fromEntries((
  'FR101:75 FR102:77 FR103:78 FR104:91 FR105:92 FR106:93 FR107:94 FR108:95 FRB01:18 FRB02:28 FRB03:36 FRB04:37 FRB05:41 FRB06:45 ' +
  'FRC11:21 FRC12:58 FRC13:71 FRC14:89 FRC21:25 FRC22:39 FRC23:70 FRC24:90 FRD11:14 FRD12:50 FRD13:61 FRD21:27 FRD22:76 FRE11:59 ' +
  'FRE12:62 FRE21:02 FRE22:60 FRE23:80 FRF11:67 FRF12:68 FRF21:08 FRF22:10 FRF23:51 FRF24:52 FRF31:54 FRF32:55 FRF33:57 FRF34:88 ' +
  'FRG01:44 FRG02:49 FRG03:53 FRG04:72 FRG05:85 FRH01:22 FRH02:29 FRH03:35 FRH04:56 FRI11:24 FRI12:33 FRI13:40 FRI14:47 FRI15:64 ' +
  'FRI21:19 FRI22:23 FRI23:87 FRI31:16 FRI32:17 FRI33:79 FRI34:86 FRJ11:11 FRJ12:30 FRJ13:34 FRJ14:48 FRJ15:66 FRJ21:09 FRJ22:12 ' +
  'FRJ23:31 FRJ24:32 FRJ25:46 FRJ26:65 FRJ27:81 FRJ28:82 FRK11:03 FRK12:15 FRK13:43 FRK14:63 FRK21:01 FRK22:07 FRK23:26 FRK24:38 ' +
  'FRK25:42 FRK26:69 FRK27:73 FRK28:74 FRL01:04 FRL02:05 FRL03:06 FRL04:13 FRL05:83 FRL06:84 FRM01:2A FRM02:2B FRY10:971 FRY20:972 ' +
  'FRY30:973 FRY40:974 FRY50:976').split(' ').map(p => p.split(':') as [string, string]));

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[’`]/g, "'");
const DEPT_BY_NAME = new Map(Object.entries(DEPARTMENTS).map(([code, name]) => [fold(name).replace(/[\s-]+/g, '-'), code]));
const deptByName = (s: string): string | null => DEPT_BY_NAME.get(fold(s).trim().replace(/[\s-]+/g, '-')) || null;

export function deptFromPostal(cp: string | null | undefined): string | null {
  const c = String(cp || '').trim(); if (!/^\d{5}$/.test(c)) return null;
  if (c.startsWith('97')) return DEPARTMENTS[c.slice(0, 3)] ? c.slice(0, 3) : null;
  if (c.startsWith('20')) return Number(c) < 20200 ? '2A' : '2B';
  return DEPARTMENTS[c.slice(0, 2)] ? c.slice(0, 2) : null;
}
export function normDeptCode(v: unknown): string | null {
  const s = String(v ?? '').trim().toUpperCase(); if (!s) return null;
  const d = /^\d$/.test(s) ? `0${s}` : s;
  return DEPARTMENTS[d] ? d : null;
}
const decodeEntities = (v: string) => v.replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const uniq = <T>(a: T[]) => [...new Set(a)];

/** Débuts d'adresse (voie, zone, bâtiment) : jamais une commune. */
const STREET = /^(\d+\s*(bis|ter)?\s+)?(rue|avenue|av\.?|bd|boulevard|route|rte|chemin|place|pl\.?|all[ée]e|impasse|quai|cours|square|za|zi|zac|zae|parc|lieu-dit|lieu dit|r[ée]sidence|station|ville d[ue]|b\.?p\.?|cs|immeuble|b[âa]timent|site|usine|pôle|pole|si[eè]ge|direction|service|centre|campus|h[ôo]tel)\b/i;
/** « Toulon Cedex 9 » → « Toulon » ; « SAINT MEDARD EN JALLES » → « Saint Medard en Jalles ». Null si ce n'est pas une commune. */
function cleanCommune(raw: unknown): string | null {
  let s = String(raw ?? '').replace(/\s+/g, ' ').trim();
  s = s.replace(/\s+cedex(\s*\d+)?$/i, '').replace(/^(commune|ville|mairie)\s+(de\s+|d['’]\s*)/i, '').replace(/[.,;]+$/, '').trim();
  // « PARIS 12 », « Lyon 3e arrondissement », « Marseille 13ème » → la commune (les arrondissements ne sont pas des communes)
  s = s.replace(/^(paris|lyon|marseille)\s*\d{1,2}\s*(e|er|ème|eme)?(\s*arr(ondissement|\.)?)?$/i, '$1');
  if (!s || s.length < 2 || deptByName(s)) return null;
  if (!isCommuneName(s)) return null;
  if (/\b(plusieurs|lieux|divers|sites?|ensemble|territoire|france|m[ée]tropolitaine?|ultramarin|outre|national|r[ée]gion|départements?|voir|selon|cf|batiments?|bâtiments?)\b/i.test(s)) return null;
  if (STREET.test(s)) return null;
  const d = displayCity(s);
  return d.charAt(0).toUpperCase() + d.slice(1);
}
function commune(name: string, cp: string | null): ExecCommune {
  return { name, slug: slugify(name), postalCode: cp, department: deptFromPostal(cp) };
}
const text = (v: any): string | null => {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && typeof v['#text'] === 'string') return v['#text'];
  return null;
};
function walk(o: any, key: string, out: any[] = []): any[] {
  if (Array.isArray(o)) { for (const v of o) walk(v, key, out); return out; }
  if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { if (k === key) out.push(v); walk(v, key, out); }
  return out;
}
const flat = (v: any): any[] => (Array.isArray(v) ? v.flatMap(flat) : v == null ? [] : [v]);

/** Lecture d'un lieu d'exécution écrit en texte libre (formulaires nationaux). */
export function parseExecutionText(raw: string): { communes: ExecCommune[]; departments: string[] } {
  const communes: ExecCommune[] = []; const departments: string[] = [];
  const t = raw.replace(/\r/g, '');
  for (const m of t.matchAll(/\bFR[A-Z0-9]\d{2}\b/g)) { const d = NUTS3[m[0]]; if (d) departments.push(d); }
  for (const m of t.matchAll(/\((\d{2,3}|2[AB])\)\s*([A-Za-zÀ-ÿ'’ -]{3,40})/g)) { const d = normDeptCode(m[1]); if (d) departments.push(d); }
  // « 33270 Bouliac », « 33400\nTalence », « Bouliac 33270 », « LE PASSAGE D'AGEN (47520) »
  for (const m of t.matchAll(/\b(\d{5})\b[ \t]*\n?[ \t]*([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’ -]{1,40})/g)) {
    const c = cleanCommune(m[2].split(/\n/)[0]); if (c) communes.push(commune(c, m[1]));
  }
  for (const m of t.matchAll(/([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’ -]{1,40}?)\s*\(?\b(\d{5})\b\)?/g)) {
    if (communes.some(x => x.postalCode === m[2])) continue;
    const seg = (m[1].split(/[,;\n]| - /).pop() || '').trim();
    const c = cleanCommune(seg); if (c && !communes.some(x => x.slug === slugify(c))) communes.push(commune(c, m[2]));
  }
  // « Pessac (33) »
  for (const m of t.matchAll(/([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’ -]{1,40}?)\s*\((\d{2}|2[AB])\)/g)) {
    const c = cleanCommune(m[1].split(/[,;\n]| - /).pop()); const d = normDeptCode(m[2]);
    if (c && d && !communes.some(x => x.slug === slugify(c))) communes.push({ ...commune(c, null), department: d });
  }
  // « commune de TONNAY-CHARENTE »
  for (const m of t.matchAll(/commune\s+(?:de\s+|d['’])([A-Za-zÀ-ÿ'’ -]{2,40})/gi)) {
    const c = cleanCommune(m[1].split(/[,;(\n]/)[0]); if (c && !communes.some(x => x.slug === slugify(c))) communes.push(commune(c, null));
  }
  // Texte court sans code : « Bordeaux », « Libourne/ Coutras/ Saint-Denis-de-Pile », « Pyrénées-orientales »
  if (!communes.length && !/\d/.test(t) && t.length <= 120) {
    for (const part of t.split(/[\/,;\n]| et /)) {
      const p = part.trim(); if (!p) continue;
      const d = deptByName(p); if (d) { departments.push(d); continue; }
      const c = cleanCommune(p); if (c) communes.push(commune(c, null));
    }
  }
  for (const c of communes) if (c.department) departments.push(c.department);
  const seen = new Set<string>();
  return { communes: communes.filter(c => (seen.has(c.slug) ? false : (seen.add(c.slug), true))), departments: uniq(departments) };
}

function parseDonnees(raw: any): any | null {
  const d = raw?.donnees ?? raw?.fields?.donnees;
  if (!d) return null;
  if (typeof d === 'object') return d;
  try { return JSON.parse(String(d)); } catch { return null; }
}

/** Point d'entrée : un avis BOAMP (raw_data) → les trois localisations. Les autres sources rendent « inconnu ». */
export function extractNoticeLocation(raw: any): NoticeLocation {
  const rec = raw?.fields ? raw.fields : raw || {};
  const publicationDepartments = uniq(flat(rec.code_departement).map(normDeptCode).filter(Boolean) as string[]);
  const out: NoticeLocation = {
    execution: { status: 'inconnu', communes: [], departments: [], text: null, source: 'aucune' },
    buyer: { city: null, postalCode: null, department: null },
    publicationDepartments,
  };
  const prest = uniq(flat(rec.code_departement_prestation).map(normDeptCode).filter(Boolean) as string[]);
  const dn = parseDonnees(rec);
  const form = dn ? Object.keys(dn)[0] : null;

  if (form === 'EFORMS') {
    const notice = Object.values(dn.EFORMS || {})[0] as any;
    const orgs = flat(walk(notice, 'efac:Organization'));
    const buyerId = text(walk(notice?.['cac:ContractingParty'], 'cbc:ID')[0]);
    const org = orgs.find(o => text(walk(o, 'cbc:ID')[0]) === buyerId) || orgs[0];
    const addr = org ? walk(org, 'cac:PostalAddress')[0] : null;
    if (addr) {
      const cp = text(addr['cbc:PostalZone']);
      out.buyer = { city: cleanCommune(text(addr['cbc:CityName'])), postalCode: cp, department: deptFromPostal(cp) || NUTS3[text(addr['cbc:CountrySubentityCode']) || ''] || null };
    }
    const locs = flat(walk(notice, 'cac:RealizedLocation')).map(l => l?.['cac:Address']).filter(Boolean);
    const communes: ExecCommune[] = []; const depts: string[] = []; let abroad = false;
    for (const a of locs) {
      const country = text(walk(a, 'cbc:IdentificationCode')[0]);
      if (country && country !== 'FRA') { abroad = true; continue; }
      const nutsDept = NUTS3[text(a['cbc:CountrySubentityCode']) || ''] || null;
      const cp = text(a['cbc:PostalZone']);
      const cityRaw = text(a['cbc:CityName']);
      const asDept = cityRaw ? deptByName(cityRaw) : null;
      const c = cityRaw && !asDept ? cleanCommune(cityRaw) : null;
      if (c) communes.push({ ...commune(c, cp), department: deptFromPostal(cp) || nutsDept });
      const d = deptFromPostal(cp) || nutsDept || asDept; if (d) depts.push(d);
    }
    const seen = new Set<string>();
    out.execution = {
      status: communes.length ? 'commune' : depts.length ? 'departement' : abroad ? 'etranger' : 'inconnu',
      communes: communes.filter(c => (seen.has(c.slug) ? false : (seen.add(c.slug), true))),
      departments: uniq([...depts, ...prest]), text: null, source: 'eforms',
    };
    return out;
  }

  if (form === 'FNSimple' || form === 'MAPA' || (dn && dn[form as string]?.organisme)) {
    const root = dn[form as string];
    const o = root?.organisme || {};
    const city = o.ville ?? o.adr?.ville; const cp = o.cp ?? o.adr?.cp;
    out.buyer = { city: cleanCommune(city), postalCode: cp ? String(cp) : null, department: deptFromPostal(cp) };
    let execText: string | null = null; const communes: ExecCommune[] = []; const depts: string[] = [];
    const le = walk(root, 'lieuExecution')[0];
    const lel = walk(root, 'lieuExecutionLivraison')[0];
    if (typeof le === 'string') execText = decodeEntities(le).trim() || null;
    else if (le && typeof le === 'object') execText = [le.nom, le.libelle, le.code].filter(Boolean).join(' ') || null;
    if (lel && typeof lel === 'object') {
      const lcp = lel.cp ? String(lel.cp) : null; const lv = lel.ville;
      const vd = lv ? deptByName(String(lv)) : null;
      const c = lv && !vd ? cleanCommune(lv) : null;
      if (c) communes.push(commune(c, lcp));
      const d = deptFromPostal(lcp) || vd; if (d) depts.push(d);
      const voie = lel.voie?.nomvoie; if (!c && typeof voie === 'string') execText = voie;
    }
    if (execText) { const p = parseExecutionText(execText); communes.push(...p.communes.filter(x => !communes.some(y => y.slug === x.slug))); depts.push(...p.departments); }
    depts.push(...prest);
    // Une commune trouvée sans département, et un seul département de publication : on le reprend, la commune
    // reste marquée « texte » (déduite d'un texte libre).
    if (communes.some(c => !c.department) && publicationDepartments.length === 1 && !depts.length) depts.push(publicationDepartments[0]);
    const fromStructured = !!(lel && communes.length && lel.ville);
    out.execution = {
      status: communes.length ? (fromStructured || communes.every(c => c.postalCode) ? 'commune' : 'texte') : uniq(depts).length ? 'departement' : 'inconnu',
      communes, departments: uniq(depts), text: execText, source: form === 'MAPA' ? 'mapa' : 'fnsimple',
    };
    return out;
  }
  if (prest.length) out.execution = { status: 'departement', communes: [], departments: prest, text: null, source: 'aucune' };
  return out;
}

/** Dates lues dans l'avis : date limite de réponse et fin de diffusion. Null quand l'avis ne les donne pas. */
/** Heure murale (AAAA-MM-JJ, HH:MM:SS) interprétée dans le fuseau donné (Europe/Paris par défaut), heure d'été comprise. */
export function wallClockToIso(day: string, time: string, tz = 'Europe/Paris'): string | null {
  const m = `${day}T${time}`.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/); if (!m) return null;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(guess)).reduce((o: any, p) => { o[p.type] = p.value; return o; }, {});
  const asTz = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return new Date(guess - (asTz - guess)).toISOString();
}
// Outre-mer : un décalage déclaré propre à ces territoires est respecté (Antilles −04:00, Guyane −03:00, Mayotte +03:00, Réunion +04:00).
const OVERSEAS_TZ: Record<string, string> = { '-04:00': 'America/Guadeloupe', '-03:00': 'America/Cayenne', '+03:00': 'Indian/Mayotte', '+04:00': 'Indian/Reunion' };

export function extractNoticeDates(raw: any): { deadline: string | null; diffusionEnd: string | null; deadlineSource: string | null } {
  // Date limite = heure murale écrite dans l'avis, interprétée à l'heure de Paris (ou du territoire d'outre-mer
  // déclaré). Les décalages écrits dans les données sont souvent faux : l'API BOAMP met « 12:00+00:00 » pour un avis
  // « 12:00+01:00 » (26-92640), certaines plateformes écrivent « +02:00 » en décembre (26-90736). Prendre ces décalages
  // au pied de la lettre décale l'échéance d'une à deux heures. Ordre des sources : gestion.INDEXATION, eForms,
  // formulaire national, puis datelimitereponse.
  const rec = raw?.fields ? raw.fields : raw || {};
  const split = (v: unknown): { day: string; time: string; off: string | null } | null => {
    const m = String(v || '').match(/^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}(?::\d{2})?))?(?:\.\d+)?([+-]\d{2}:\d{2}|Z)?/);
    return m ? { day: m[1], time: m[2] || '', off: m[3] || null } : null;
  };
  const toIso = (x: { day: string; time: string; off: string | null } | null) => {
    if (!x) return null;
    const tz = (x.off && OVERSEAS_TZ[x.off]) || 'Europe/Paris';
    return wallClockToIso(x.day, x.time || '23:59:59', tz);
  };
  let deadline: string | null = null; let source: string | null = null;
  let g: any = rec.gestion; if (typeof g === 'string') { try { g = JSON.parse(g); } catch { g = null; } }
  const gd = split(g?.INDEXATION?.DATE_LIMITE_REPONSE);
  if (gd?.time) { deadline = toIso(gd); source = 'avis (gestion)'; }
  const dn = !deadline ? parseDonnees(rec) : null;
  if (!deadline && dn) {
    const p = walk(dn, 'cac:TenderSubmissionDeadlinePeriod')[0];
    const d = p ? split(text(p['cbc:EndDate'])) : null; const tm = p ? split(`2000-01-01T${String(text(p['cbc:EndTime']) || '')}`) : null;
    if (d) { deadline = toIso({ day: d.day, time: tm?.time || '', off: tm?.off || d.off }); source = 'avis (eForms)'; }
    if (!deadline) { const f = split(walk(dn, 'dateReceptionOffres')[0]); if (f?.time) { deadline = toIso(f); source = 'avis (formulaire)'; } }
  }
  if (!deadline && rec.datelimitereponse) { deadline = toIso(split(rec.datelimitereponse)); source = 'champ BOAMP datelimitereponse (heure lue à Paris)'; }
  const fin = rec.datefindiffusion ? String(rec.datefindiffusion).slice(0, 10) : null;
  return { deadline, deadlineSource: source, diffusionEnd: fin && /^\d{4}-\d{2}-\d{2}$/.test(fin) ? fin : null };
}

/** Dernier recours, quand l'avis ne donne aucun lieu : titre au format des acheteurs de l'État
 *  « (17) ROCHEFORT - BA 721 - … » ou « (40) - MONT DE MARSAN - … ». Rien d'autre n'est tiré du titre. */
export function locationFromTitle(title: string | null | undefined): { communes: ExecCommune[]; departments: string[] } | null {
  const m = String(title || '').match(/^\s*\((\d{2,3}|2[AB])\)\s*-?\s*([A-Za-zÀ-ÿ'’ -]{2,40}?)\s+-\s+/);
  if (!m) return null;
  const d = normDeptCode(m[1]); if (!d) return null;
  const c = cleanCommune(m[2]);
  return { communes: c ? [{ ...commune(c, null), department: d }] : [], departments: [d] };
}
