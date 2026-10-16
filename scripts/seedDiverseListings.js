/**
 * scripts/seedDiverseListings.js
 * Diversified DEMO listings for "Sous-traitance" and "Appels d'offres privés".
 *
 * Client brief (16 Oct): ~15-20k listings per journey, no "same ad, city swapped"
 * look. For every métier, each listing differs by prestation, type de chantier,
 * maître d'ouvrage, contrainte, calendrier, budget and city.
 * Every row is clearly marked as a demo: source_reference starts with "demo-",
 * the description ends with a demo notice and ai_extracted_facts.is_demo_listing = true.
 *
 *   node scripts/seedDiverseListings.js --dry-run
 *   node scripts/seedDiverseListings.js                      # 18 000 per journey
 *   node scripts/seedDiverseListings.js --target=20000
 *   node scripts/seedDiverseListings.js --metiers=metiers.csv  # client's 600-métier list
 *   node scripts/seedDiverseListings.js --clean               # delete all demo- rows
 * CSV: one métier per line, "métier" or "métier;trade_slug" (slug optional, guessed otherwise).
 */
require("dotenv").config();
const fs = require("fs");
const { Pool } = require("pg");
const { CITIES } = require("./seedEditorialListings");

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, "").split("="); return [k, v ?? true]; }));
const DRY = Boolean(args["dry-run"]);
const TARGET = parseInt(args.target || "18000", 10);
const pool = new Pool(process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL, ssl: process.env.DB_SSL === "false" ? false : { rejectUnauthorized: false } }
  : { user: process.env.DB_USER, password: process.env.DB_PASSWORD, host: process.env.DB_HOST, port: parseInt(process.env.DB_PORT || "5432", 10), database: process.env.DB_NAME, ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : false });

// slug -> { métier: [prestations] }   (built-in catalog, replaced/extended by --metiers CSV)
const CATALOG = {
  electricite: {
    "Électricité bâtiment": ["mise aux normes du tableau électrique", "création de réseau courants forts et faibles", "remplacement de colonnes montantes", "installation d'éclairage de sécurité", "câblage de plateaux de bureaux", "raccordement de locaux commerciaux"],
    "Électricien industriel": ["armoires de commande et automatismes", "alimentation de lignes de production", "passage de chemins de câbles", "mise en conformité d'un atelier", "maintenance préventive de TGBT"],
    "Domotique et courants faibles": ["installation de gestion technique du bâtiment", "pose de contrôle d'accès et vidéophonie", "câblage VDI et baies de brassage", "déploiement de bornes de recharge"],
  },
  plomberie: {
    "Plomberie sanitaire": ["remplacement de colonnes d'eau", "création de salles d'eau en rénovation", "réfection de réseaux d'évacuation", "installation de production d'eau chaude collective", "recherche et réparation de fuites"],
    "Plomberie chauffage": ["remplacement de radiateurs et réseaux", "création de plancher chauffant", "désembouage et équilibrage de réseau", "pose de pompe à chaleur eau-eau"],
  },
  cvc: {
    "Chauffagiste": ["remplacement de chaudière collective", "installation de pompe à chaleur air-eau", "raccordement à un réseau de chaleur", "modernisation de sous-station"],
    "Climatisation": ["installation de climatisation multi-split", "pose de cassettes en plateau de bureaux", "maintenance de groupes froids", "création de salle technique refroidie"],
    "Ventilation": ["installation de VMC double flux", "désenfumage de parking", "réfection de réseaux aérauliques", "ventilation de cuisine professionnelle"],
  },
  maconnerie: {
    "Maçonnerie générale": ["construction d'extension en parpaings", "reprise de murs porteurs", "création d'ouvertures en structure", "réalisation de dallage industriel", "construction de mur de clôture"],
    "Maçonnerie pierre": ["restauration de façade en pierre de taille", "rejointoiement de murs anciens", "reconstruction de mur de soutènement"],
  },
  "gros-oeuvre": {
    "Gros œuvre béton armé": ["réalisation de fondations et longrines", "coulage de voiles et planchers", "construction de cage d'escalier béton", "reprise en sous-œuvre"],
    "Terrassement et fondations": ["terrassement de plateforme", "fondations spéciales sur pieux", "création de rampe d'accès"],
  },
  charpente: {
    "Charpentier": ["rénovation de charpente traditionnelle", "création de charpente en lamellé-collé", "traitement et remplacement de pièces de bois", "construction d'ossature bois"],
  },
  couverture: {
    "Couvreur": ["réfection de toiture en tuiles", "pose de couverture zinc", "remplacement d'ardoises", "création de lanterneaux et fenêtres de toit"],
    "Étanchéité toiture-terrasse": ["étanchéité bicouche de toiture-terrasse", "végétalisation de toiture", "reprise de relevés et acrotères", "pose de membrane synthétique"],
  },
  isolation: {
    "Isolation thermique par l'extérieur": ["ITE sur façade de logements collectifs", "isolation de pignons", "isolation sous enduit mince"],
    "Isolation combles et planchers": ["soufflage de combles perdus", "isolation de planchers bas", "isolation de toiture en sous-face"],
  },
  platrerie: {
    "Plaquiste": ["cloisonnement de plateaux tertiaires", "doublages thermiques", "faux-plafonds acoustiques", "création de gaines techniques"],
    "Enduiseur façadier": ["ravalement de façade", "enduit monocouche", "réparation de fissures de façade"],
  },
  menuiserie: {
    "Menuiserie extérieure": ["remplacement de fenêtres PVC", "pose de menuiseries aluminium", "pose de volets roulants", "installation de portes d'entrée"],
    "Menuiserie intérieure": ["pose de blocs-portes", "agencement de placards et dressings", "fabrication d'escalier bois", "pose de parquet"],
    "Agencement commerce": ["agencement de boutique", "aménagement de comptoirs d'accueil", "mobilier sur mesure de restaurant"],
  },
  carrelage: {
    "Carreleur": ["carrelage de halls et circulations", "faïence de salles d'eau", "carrelage extérieur sur plots", "sols collés en grand format"],
    "Revêtements de sols souples": ["pose de sols PVC en établissement de santé", "sols souples de bureaux", "ragréage et sols coulés"],
  },
  peinture: {
    "Peintre en bâtiment": ["peinture de parties communes", "remise en peinture de logements", "peinture de façade et boiseries", "revêtements muraux et toile de verre"],
    "Peinture industrielle": ["peinture anticorrosion de charpente métallique", "marquage au sol d'entrepôt", "peinture époxy de sols"],
  },
  vitrerie: {
    "Vitrerie miroiterie": ["remplacement de vitrages isolants", "façade vitrée et murs-rideaux", "garde-corps verre", "miroirs et cloisons vitrées"],
  },
  vrd: {
    "Voirie et réseaux divers": ["création de voirie de lotissement", "reprise de trottoirs et bordures", "réseaux d'assainissement", "création de parkings enrobés"],
    "Canalisateur": ["renouvellement de réseau d'eau potable", "pose de collecteurs d'eaux pluviales", "raccordements de branchements"],
    "Aménagements extérieurs": ["pavage et dallage extérieurs", "clôtures et portails", "mobilier urbain et aires de jeux"],
  },
  "batiment-general": {
    "Entreprise générale du bâtiment": ["rénovation lourde de logements", "réhabilitation de bureaux", "construction de bâtiment tertiaire", "mise en accessibilité d'un ERP"],
    "Rénovation énergétique": ["rénovation globale en copropriété", "bouquet de travaux de performance énergétique", "rénovation d'une maison individuelle"],
    "Démolition et désamiantage": ["curage et démolition intérieure", "retrait de matériaux amiantés", "démolition de bâtiment"],
  },
  "espaces-verts": {
    "Paysagiste": ["création de jardin paysager", "entretien annuel d'espaces verts de résidence", "plantation d'arbres et haies", "arrosage automatique"],
    "Élagage": ["élagage et abattage d'arbres", "taille de haies de grande hauteur"],
  },
  nettoyage: {
    "Nettoyage de locaux": ["nettoyage de bureaux", "remise en état après travaux", "nettoyage de vitrerie en hauteur", "entretien de parties communes"],
  },
  maintenance: {
    "Maintenance multitechnique": ["contrat de maintenance multitechnique", "dépannage et petits travaux", "maintenance d'ascenseurs et portes automatiques", "entretien d'installations de sécurité incendie"],
    "Serrurerie métallerie": ["fabrication de garde-corps et escaliers métalliques", "portes coupe-feu", "fermetures de commerces", "structures métalliques légères"],
  },
};
const GENERIC = ["travaux de rénovation", "intervention de mise en conformité", "pose et installation neuve", "remplacement d'équipements existants", "dépannage et maintenance", "réalisation de travaux d'aménagement"];
const SLUG_HINTS = [[/électr|domotique|courant/i, "electricite"], [/plomb|sanitaire/i, "plomberie"], [/chauff|climat|ventil|frigor|cvc/i, "cvc"], [/ma[cç]on|pierre/i, "maconnerie"], [/charpent|bois/i, "charpente"], [/couvr|toit|étanch|etanch|zing/i, "couverture"], [/isol/i, "isolation"], [/pl[aâ]tr|enduit|fa[cç]ad/i, "platrerie"], [/menuis|agenc|parquet|serrur|métall/i, "menuiserie"], [/carrel|sol/i, "carrelage"], [/peint/i, "peinture"], [/vitr|miroit/i, "vitrerie"], [/voirie|vrd|canalis|terrass|assain/i, "vrd"], [/paysag|jardin|élag|elag|vert/i, "espaces-verts"], [/nettoy/i, "nettoyage"], [/maintenance|dépann|depann/i, "maintenance"], [/démol|demol|amiante/i, "demolition"], [/béton|beton|gros/i, "gros-oeuvre"]];

const CLIENTS = ["une copropriété", "un syndic de copropriété", "un bailleur privé", "une société civile immobilière", "un promoteur immobilier", "un exploitant de commerces", "un groupe hôtelier", "une clinique privée", "une PME industrielle", "un gestionnaire de bureaux", "une association gestionnaire", "un particulier", "une agence immobilière", "une enseigne de restauration", "un exploitant agricole", "une résidence-services"];
const SITES = ["un immeuble de 24 logements", "une résidence des années 70", "un entrepôt de 1 800 m²", "un local commercial en pied d'immeuble", "une maison individuelle de 120 m²", "un plateau de bureaux de 400 m²", "un hôtel de 35 chambres", "une école privée", "un bâtiment industriel", "une copropriété de 3 bâtiments", "un restaurant de 80 couverts", "un ensemble de maisons de ville", "un centre médical", "un immeuble ancien classé en centre-ville", "un site occupé en activité"];
const CONSTRAINTS = ["intervention en site occupé", "accès difficile et stationnement limité", "travaux phasés par bâtiment", "coordination avec les autres corps d'état", "travaux de nuit ou le week-end", "assurance décennale exigée", "qualification RGE souhaitée", "visite préalable du site obligatoire", "matériaux imposés par le maître d'ouvrage", "livraison avant une date d'ouverture", "respect d'un cahier des charges acoustique", "évacuation des déchets à la charge du prestataire"];
const CALENDARS = ["démarrage sous 2 semaines", "démarrage le mois prochain", "intervention avant l'hiver", "intervention pendant l'été", "chantier de 3 semaines", "chantier de 2 à 3 mois", "intervention en plusieurs tranches", "planning à définir avec le titulaire", "mission récurrente sur 12 mois", "démarrage immédiat, délai court"];
const TENDER_T = [(p, c, s) => `${cap(p)} - ${s} à ${c}`, (p, c) => `${c} : consultation pour ${p}`, (p, c, s, k) => `Appel d'offres privé : ${p} (${k.replace(/^une? /, "")}) - ${c}`, (p, c) => `Recherche entreprise pour ${p} à ${c}`, (p, c, s) => `${cap(p)} pour ${s}, ${c}`];
const SUB_T = [(p, c) => `Sous-traitance : ${p} - ${c}`, (p, c, s) => `${c} : sous-traitant recherché pour ${p} (${s})`, (p, c) => `Lot ${p} à sous-traiter à ${c}`, (p, c, s, k, m) => `${m} - renfort en sous-traitance, ${p}, ${c}`, (p, c) => `Entreprise générale cherche sous-traitant : ${p} (${c})`];
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; }
function rng(seed) { let a = hash(seed); return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const slugify = (s) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function loadMetiers() {
  const list = [];
  if (args.metiers && args.metiers !== true) {
    for (const line of fs.readFileSync(args.metiers, "utf8").split(/\r?\n/)) {
      const [name, slugRaw] = line.split(/[;\t]/).map((x) => x && x.trim());
      if (!name || /^m[ée]tier$/i.test(name)) continue;
      let slug = slugRaw; let prest = null;
      for (const [s, ms] of Object.entries(CATALOG)) if (ms[name]) { slug = slug || s; prest = ms[name]; }
      if (!slug) slug = (SLUG_HINTS.find(([re]) => re.test(name)) || [0, "batiment-general"])[1];
      list.push({ name, slug, prestations: prest || GENERIC.map((g) => `${g} - ${name.toLowerCase()}`) });
    }
  } else {
    for (const [slug, ms] of Object.entries(CATALOG)) for (const [name, prestations] of Object.entries(ms)) list.push({ name, slug, prestations });
  }
  return list;
}

function build(metiers, journey, perMetier) {
  const rows = [];
  const titles = journey === "tender" ? TENDER_T : SUB_T;
  for (const m of metiers) {
    const r = rng(`${journey}-${m.name}`);
    const seen = new Set();
    let guard = 0;
    while (seen.size < perMetier && guard++ < perMetier * 20) {
      const p = m.prestations[Math.floor(r() * m.prestations.length)];
      const city = CITIES[Math.floor(r() * CITIES.length)];
      const client = CLIENTS[Math.floor(r() * CLIENTS.length)];
      const site = SITES[Math.floor(r() * SITES.length)];
      const cons = CONSTRAINTS[Math.floor(r() * CONSTRAINTS.length)];
      const cons2 = CONSTRAINTS[Math.floor(r() * CONSTRAINTS.length)];
      const cal = CALENDARS[Math.floor(r() * CALENDARS.length)];
      const key = `${p}|${city.name}|${site}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const title = titles[Math.floor(r() * titles.length)](p, city.name, site, client, m.name);
      const base = journey === "tender" ? 4000 : 2500;
      const value = Math.round((base + r() * r() * (journey === "tender" ? 120000 : 70000)) / 100) * 100;
      const intro = journey === "tender"
        ? `${cap(client)} à ${city.name} consulte des entreprises spécialisées en ${m.name.toLowerCase()} pour ${p}, sur ${site}.`
        : `Une entreprise titulaire d'un chantier à ${city.name} (${site}) cherche un sous-traitant spécialisé en ${m.name.toLowerCase()} pour ${p}.`;
      const description = `${intro} Contraintes : ${cons}${cons2 !== cons ? `, ${cons2}` : ""}. Calendrier : ${cal}. Annonce de démonstration - exemple fictif non réel.`;
      rows.push({ ref: `demo-${journey}-${slugify(m.name)}-${slugify(city.name)}-${hash(key).toString(36)}`, journey, slug: m.slug, metier: m.name, title, description, value, city, days: 10 + Math.floor(r() * 40),
        scope: `Prestation : ${p}, ${site} à ${city.name}. Quantités à préciser après visite.`, calendar: cal.charAt(0).toUpperCase() + cal.slice(1) + ".", constraints: `${cap(cons)}${cons2 !== cons ? `. ${cap(cons2)}` : ""}.` });
    }
  }
  return rows;
}

async function run() {
  if (DRY && !args.clean) {
    const metiers = loadMetiers();
    const per = Math.ceil(TARGET / metiers.length);
    const rows = [...build(metiers, "tender", per), ...build(metiers, "subcontracting", per)];
    console.log(`[seedDiverse] ${metiers.length} métiers x ${per} per journey = ${rows.length} rows (dry-run)`);
    console.log(`distinct titles: ${new Set(rows.map((r) => r.title)).size}, distinct refs: ${new Set(rows.map((r) => r.ref)).size}`);
    rows.filter((_, i) => i % Math.ceil(rows.length / 8) === 0).forEach((r) => console.log(`  ${r.journey} | ${r.title} | ${r.value}€\n    ${r.description}`));
    return;
  }
  const src = await pool.query(`SELECT id FROM data_sources WHERE code = 'editorial_catalog'`);
  if (!src.rows.length) { console.log("[seedDiverse] data_sources 'editorial_catalog' missing - run migrations first."); return; }
  const sourceId = src.rows[0].id;
  if (args.clean) {
    if (DRY) return console.log("[seedDiverse] dry-run: would delete demo- rows");
    const res = await pool.query(`DELETE FROM opportunities WHERE source_id = $1 AND source_reference LIKE 'demo-%'`, [sourceId]);
    return console.log(`[seedDiverse] deleted ${res.rowCount}`);
  }
  const metiers = loadMetiers();
  const per = Math.ceil(TARGET / metiers.length);
  const rows = [...build(metiers, "tender", per), ...build(metiers, "subcontracting", per)];
  console.log(`[seedDiverse] ${metiers.length} métiers x ${per} per journey = ${rows.length} rows`);
  if (DRY) { rows.filter((_, i) => i % Math.ceil(rows.length / 8) === 0).forEach((r) => console.log(`  ${r.journey} | ${r.title} | ${r.value}€\n    ${r.description}`)); return; }
  const trades = new Map((await pool.query(`SELECT id, slug FROM trades`)).rows.map((t) => [t.slug, t.id]));
  const types = new Map((await pool.query(`SELECT id, code FROM opportunity_types`)).rows.map((t) => [t.code, t.id]));
  let done = 0;
  for (let i = 0; i < rows.length; i += 400) {
    const chunk = rows.slice(i, i + 400).filter((r) => trades.has(r.slug) && types.has(r.journey));
    const values = []; const ph = chunk.map((r, k) => {
      const na = { value: "not available", available: false };
      const facts = { scope_details: { value: r.scope, available: true }, intervention_calendar: { value: r.calendar, available: true }, constraints_expectations: { value: r.constraints, available: true }, buyer_name: na, contact_email: na, contract_object: na, procedure_type: na, submission_deadline: na, estimated_value: na, required_qualifications: na, team_size_estimate: na, key_risks: { value: [], available: false }, contract_duration: na, submission_method: na, allotment: na, technical_visit: na, selection_criteria: { value: [], available: false }, attribution_winner: na, attribution_amount: na, attribution_date: na, buyer_phone: na, buyer_website: na, requirements_detected: { value: 0, available: false }, is_demo_listing: true, metier: r.metier };
      values.push(sourceId, r.ref, types.get(r.journey), trades.get(r.slug), r.title, r.description, r.days, r.value, "EUR", r.city.name, r.city.department, r.city.region, "active", "classified",
        JSON.stringify([{ trade_id: trades.get(r.slug), confidence: 1.0, reasoning: "Annonce de démonstration (catalogue interne)." }]), "not_generated", "no_documents_found", JSON.stringify(facts));
      const b = k * 18;
      return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},NOW(),NOW()+($${b + 7}::int*interval '1 day'),$${b + 8},$${b + 9},$${b + 10},$${b + 11},$${b + 12},$${b + 13},$${b + 14},$${b + 15},$${b + 16},$${b + 17},$${b + 18}::jsonb)`;
    });
    if (!chunk.length) continue;
    const res = await pool.query(`INSERT INTO opportunities (source_id, source_reference, opportunity_type_id, trade_id, title, description, publication_date, deadline, estimated_value, currency, location_city, location_department, location_region, status, ai_classification_status, ai_matched_trades, ai_summary_status, dce_documents_status, ai_extracted_facts) VALUES ${ph.join(",")} ON CONFLICT (source_id, source_reference) DO NOTHING`, values);
    done += res.rowCount;
  }
  console.log(`[seedDiverse] inserted ${done} new rows`);
}
module.exports = { run };
if (require.main === module) run().catch((e) => { console.error("[seedDiverse] failed:", e.message); process.exitCode = 1; }).finally(() => pool.end());
