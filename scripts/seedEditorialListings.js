/**
 * SEED — editorial catalog for "Appels d'offres privés" / "Sous-traitance"
 * ============================================================================
 * Client's brief (15 Sep 2026): those two journeys have no real scraped
 * source at all (unlike public procurement, which comes from BOAMP/DECP).
 * Buyer identity/contact stays locked behind the existing access-gate
 * mechanism (OpportunityDetailPage's "identityUnlocked" block) exactly like
 * a real private listing - this script only ever leaves buyer_name NULL,
 * it never invents a company name to reveal later.
 *
 * Scaled progressively per client review: 48 rows (16 scenarios × 3
 * cities) -> 207 rows (23 scenarios × 9 cities) -> now 24 scenarios ×
 * every one of the 67 cities (~1,600 rows), covering every mainland
 * region, per the client's explicit 19 Sep instruction for "une
 * couverture géographique nationale... une couverture nationale
 * importante". Safe to re-run (idempotent on source_reference) and safe
 * to extend further (more cities, more scenarios per trade) the same way
 * this round extended the previous one.
 *
 * Content design (client's specific SEO warning: no "same ad, city
 * swapped" duplication):
 *   - Each trade has 2-3 distinct SCENARIOS (a real different kind of job,
 *     not a reworded synonym of the same one) with their own title
 *     patterns, description paragraphs, budget range and typical timeline.
 *   - Each (trade, scenario, city) combination independently picks from 2
 *     title phrasings AND 2 description phrasings (deterministically, by
 *     hashing the combination, with the two picks decorrelated from each
 *     other) - up to 4 distinct title/paragraph combinations per scenario,
 *     not just the paragraph varying while every page for that scenario
 *     shares one identical <title>. Fixed until 19 Sep: the title itself
 *     was a single pattern with only the city name substituted, which is
 *     exactly the "same ad, city swapped" pattern this section warns
 *     against - a duplicate-<title>-tag pattern search engines flag
 *     specifically, arguably a bigger SEO problem than duplicate body text.
 *   - Budget and response-deadline-in-N-days are varied deterministically
 *     per row within the scenario's realistic range, not fixed constants.
 * This is templated, not hand-written-per-city prose - a genuine step up
 * from name-swapping, but the client should still review this batch -
 * templated content at ~1,600 rows, not hand-written per city - and say
 * whether more scenario variety per trade (currently 2 each, one trade
 * had only 1 until this pass) is worth the extra writing effort next.
 *
 * Plain JS (not TypeScript) and its own Pool, same as
 * scripts/generateSyntheticListings.js and scripts/seed.js - on Render's
 * free tier there's no shell to run `npm run seed:editorial-listings` by
 * hand, so this is also wired into server.ts's boot sequence the same way
 * seed.js/backfillRegionNames.js already are (see startServer() there).
 * Fully idempotent (ON CONFLICT DO NOTHING keyed on a fixed
 * source_reference), so running it again on every restart is harmless.
 *
 * Manual usage (if a shell IS available, e.g. local dev):
 *   node scripts/seedEditorialListings.js                 # insert the batch
 *   node scripts/seedEditorialListings.js --clean          # delete all editorial rows
 *   node scripts/seedEditorialListings.js --dry-run        # print without writing
 */
require("dotenv").config();
const { Pool } = require("pg");

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  })
);
const DRY_RUN = Boolean(args["dry-run"]);
const CLEAN = Boolean(args.clean);

const connectionString = process.env.DATABASE_URL;
const pool = connectionString
  ? new Pool({ connectionString, ssl: process.env.DB_SSL === "false" ? false : { rejectUnauthorized: false } })
  : new Pool({
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      host: process.env.DB_HOST,
      port: parseInt(process.env.DB_PORT || "5432", 10),
      database: process.env.DB_NAME,
      ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : false,
    });

// ---------------------------------------------------------------------------
// Cities: a first spread across regions, including every city the client
// has specifically tested by name in prior audits (Bordeaux, Angoulême,
// Périgueux, Bergerac, Marmande, Strasbourg) plus other major/mid cities.
// ---------------------------------------------------------------------------
const CITIES = [
  { name: "Bordeaux", department: "33", region: "Nouvelle-Aquitaine" },
  { name: "Angoulême", department: "16", region: "Nouvelle-Aquitaine" },
  { name: "Périgueux", department: "24", region: "Nouvelle-Aquitaine" },
  { name: "Bergerac", department: "24", region: "Nouvelle-Aquitaine" },
  { name: "Marmande", department: "47", region: "Nouvelle-Aquitaine" },
  { name: "La Rochelle", department: "17", region: "Nouvelle-Aquitaine" },
  { name: "Poitiers", department: "86", region: "Nouvelle-Aquitaine" },
  { name: "Limoges", department: "87", region: "Nouvelle-Aquitaine" },
  { name: "Pau", department: "64", region: "Nouvelle-Aquitaine" },
  { name: "Agen", department: "47", region: "Nouvelle-Aquitaine" },
  { name: "Strasbourg", department: "67", region: "Grand Est" },
  { name: "Metz", department: "57", region: "Grand Est" },
  { name: "Reims", department: "51", region: "Grand Est" },
  { name: "Nancy", department: "54", region: "Grand Est" },
  { name: "Mulhouse", department: "68", region: "Grand Est" },
  { name: "Troyes", department: "10", region: "Grand Est" },
  { name: "Paris", department: "75", region: "Île-de-France" },
  { name: "Versailles", department: "78", region: "Île-de-France" },
  { name: "Boulogne-Billancourt", department: "92", region: "Île-de-France" },
  { name: "Créteil", department: "94", region: "Île-de-France" },
  { name: "Saint-Denis", department: "93", region: "Île-de-France" },
  { name: "Évry-Courcouronnes", department: "91", region: "Île-de-France" },
  { name: "Lyon", department: "69", region: "Auvergne-Rhône-Alpes" },
  { name: "Grenoble", department: "38", region: "Auvergne-Rhône-Alpes" },
  { name: "Clermont-Ferrand", department: "63", region: "Auvergne-Rhône-Alpes" },
  { name: "Saint-Étienne", department: "42", region: "Auvergne-Rhône-Alpes" },
  { name: "Annecy", department: "74", region: "Auvergne-Rhône-Alpes" },
  { name: "Valence", department: "26", region: "Auvergne-Rhône-Alpes" },
  { name: "Chambéry", department: "73", region: "Auvergne-Rhône-Alpes" },
  { name: "Marseille", department: "13", region: "Provence-Alpes-Côte d'Azur" },
  { name: "Toulon", department: "83", region: "Provence-Alpes-Côte d'Azur" },
  { name: "Nice", department: "06", region: "Provence-Alpes-Côte d'Azur" },
  { name: "Aix-en-Provence", department: "13", region: "Provence-Alpes-Côte d'Azur" },
  { name: "Avignon", department: "84", region: "Provence-Alpes-Côte d'Azur" },
  { name: "Cannes", department: "06", region: "Provence-Alpes-Côte d'Azur" },
  { name: "Toulouse", department: "31", region: "Occitanie" },
  { name: "Montpellier", department: "34", region: "Occitanie" },
  { name: "Nîmes", department: "30", region: "Occitanie" },
  { name: "Perpignan", department: "66", region: "Occitanie" },
  { name: "Béziers", department: "34", region: "Occitanie" },
  { name: "Albi", department: "81", region: "Occitanie" },
  { name: "Nantes", department: "44", region: "Pays de la Loire" },
  { name: "Le Mans", department: "72", region: "Pays de la Loire" },
  { name: "Angers", department: "49", region: "Pays de la Loire" },
  { name: "Saint-Nazaire", department: "44", region: "Pays de la Loire" },
  { name: "Laval", department: "53", region: "Pays de la Loire" },
  { name: "Rennes", department: "35", region: "Bretagne" },
  { name: "Brest", department: "29", region: "Bretagne" },
  { name: "Quimper", department: "29", region: "Bretagne" },
  { name: "Vannes", department: "56", region: "Bretagne" },
  { name: "Saint-Malo", department: "35", region: "Bretagne" },
  { name: "Lille", department: "59", region: "Hauts-de-France" },
  { name: "Amiens", department: "80", region: "Hauts-de-France" },
  { name: "Roubaix", department: "59", region: "Hauts-de-France" },
  { name: "Dunkerque", department: "59", region: "Hauts-de-France" },
  { name: "Saint-Quentin", department: "02", region: "Hauts-de-France" },
  { name: "Rouen", department: "76", region: "Normandie" },
  { name: "Caen", department: "14", region: "Normandie" },
  { name: "Le Havre", department: "76", region: "Normandie" },
  { name: "Cherbourg-en-Cotentin", department: "50", region: "Normandie" },
  { name: "Dijon", department: "21", region: "Bourgogne-Franche-Comté" },
  { name: "Besançon", department: "25", region: "Bourgogne-Franche-Comté" },
  { name: "Chalon-sur-Saône", department: "71", region: "Bourgogne-Franche-Comté" },
  { name: "Orléans", department: "45", region: "Centre-Val de Loire" },
  { name: "Tours", department: "37", region: "Centre-Val de Loire" },
  { name: "Bourges", department: "18", region: "Centre-Val de Loire" },
  { name: "Ajaccio", department: "2A", region: "Corse" },
];

// ---------------------------------------------------------------------------
// Trades x scenarios. tradeSlug must exist in the `trades` table - the three
// non-construction ones (espaces-verts, nettoyage, maintenance) are added by
// src/config/database.ts's applyIncrementalMigrations, which already runs
// automatically on every boot before this script does (see server.ts).
// ---------------------------------------------------------------------------
const SCENARIOS = [
  // --- Climatisation / chauffage (trade: cvc) ---
  {
    tradeSlug: "cvc", journey: "tender",
    titlePattern: (city) => [
      `Installation climatisation multi-split - copropriété à ${city}`,
      `${city} : devis climatisation réversible pour une copropriété`,
    ],
    paragraphs: (city) => [
      `Copropriété privée à ${city} recherchant une entreprise pour l'installation de climatisation réversible multi-split sur l'ensemble des parties communes et un lot de logements pilotes avant généralisation. Le syndic souhaite comparer plusieurs devis avant lancement.`,
      `Consultation privée lancée par une copropriété de ${city} pour équiper en climatisation réversible multi-split un premier lot de logements et les parties communes, avant extension au reste de l'immeuble selon le retour d'expérience.`,
    ],
    valueRange: [18000, 65000], deadlineDaysRange: [18, 35],
    details: (city) => ({
      scope: `Périmètre : parties communes de l'immeuble et un premier lot de logements pilotes à ${city} (l'étendue des lots restants sera précisée après retour d'expérience). Quantités estimées : plusieurs unités intérieures multi-split par logement pilote, à confirmer selon relevé sur site.`,
      calendar: `Intervention souhaitée hors période de chauffe, démarrage envisagé sous quelques semaines après sélection du prestataire.`,
      constraints: `Intervention en site occupé (copropriété habitée) : coordination des accès avec les résidents attendue. Garantie et SAV sur les équipements posés demandés.`,
    }),
  },
  {
    tradeSlug: "cvc", journey: "subcontracting",
    titlePattern: (city) => [
      `Sous-traitance chaufferie collective - résidence ${city}`,
      `${city} : lot chaufferie collective à sous-traiter`,
    ],
    paragraphs: (city) => [
      `Entreprise générale intervenant sur la rénovation d'une chaufferie collective à ${city} recherche un sous-traitant CVC qualifié pour la dépose de l'ancienne installation et la pose d'une chaudière collective à condensation.`,
      `Lot chauffage à sous-traiter dans le cadre d'une rénovation de résidence à ${city} : remplacement d'une chaufferie collective par une chaudière à condensation, dépose comprise. Recherche d'un sous-traitant disponible sous délai court.`,
    ],
    valueRange: [25000, 90000], deadlineDaysRange: [14, 30],
    details: (city) => ({
      scope: `Périmètre : dépose de l'ancienne chaufferie collective et pose d'une chaudière collective à condensation, sur la résidence concernée à ${city}. Quantités précises (puissance, nombre de logements desservis) à confirmer au sous-traitant retenu.`,
      calendar: `Intervention à délai court, dans la continuité du planning de l'entreprise générale déjà engagée sur le chantier.`,
      constraints: `Coordination obligatoire avec l'entreprise générale pilote et les autres corps d'état déjà sur site. Qualification RGE/PG souhaitée pour l'installation de chaudières collectives.`,
    }),
  },
  // --- Électricité ---
  {
    tradeSlug: "electricite", journey: "tender",
    titlePattern: (city) => [
      `Mise aux normes électriques - immeuble tertiaire à ${city}`,
      `${city} : consultation privée pour une mise en conformité électrique`,
    ],
    paragraphs: (city) => [
      `Propriétaire d'un immeuble de bureaux à ${city} lance une consultation privée pour la mise aux normes du tableau électrique général et le remplacement du câblage vétuste sur trois étages.`,
      `Immeuble tertiaire à ${city} : consultation restreinte pour une mise en conformité électrique complète (tableau général, câblage) sur plusieurs niveaux, hors intervention sur les parties déjà rénovées.`,
    ],
    valueRange: [12000, 48000], deadlineDaysRange: [15, 30],
    details: (city) => ({
      scope: `Périmètre : tableau électrique général et câblage sur trois étages de l'immeuble tertiaire à ${city}, hors parties déjà rénovées. Quantités (nombre de circuits, longueur de câblage) à établir lors de la visite.`,
      calendar: `Travaux envisagés par tranches d'étage pour limiter la gêne à l'activité des occupants du bâtiment.`,
      constraints: `Mise en conformité avec la réglementation électrique en vigueur attendue ; intervention en horaires décalés possible selon l'occupation des locaux.`,
    }),
  },
  {
    tradeSlug: "electricite", journey: "subcontracting",
    titlePattern: (city) => [
      `Sous-traitance IRVE - parking résidentiel ${city}`,
      `${city} : lot bornes de recharge à sous-traiter`,
    ],
    paragraphs: (city) => [
      `Entreprise générale recherche un sous-traitant électricien qualifié IRVE pour l'installation de bornes de recharge sur un parking résidentiel à ${city}, raccordement compris.`,
      `Chantier de résidence à ${city} : lot bornes de recharge véhicules électriques (IRVE) à sous-traiter, raccordement au tableau général et mise en service comprises.`,
    ],
    valueRange: [8000, 30000], deadlineDaysRange: [10, 25],
    details: (city) => ({
      scope: `Périmètre : installation de bornes de recharge véhicules électriques sur le parking résidentiel à ${city}, raccordement au tableau général compris. Nombre de bornes à confirmer selon la demande des résidents.`,
      calendar: `Intervention à délai court demandée par l'entreprise générale, dans le cadre du planning global du chantier de résidence.`,
      constraints: `Qualification IRVE (Qualifelec ou équivalent) attendue. Coordination avec les autres corps d'état du chantier de résidence.`,
    }),
  },
  // --- Plomberie ---
  {
    tradeSlug: "plomberie", journey: "tender",
    titlePattern: (city) => [
      `Rénovation colonnes montantes - immeuble ancien à ${city}`,
      `${city} : appel à devis pour le remplacement de colonnes montantes`,
    ],
    paragraphs: (city) => [
      `Syndic de copropriété à ${city} lance une consultation pour la rénovation des colonnes montantes eau froide/eau chaude d'un immeuble ancien, travaux à réaliser en site occupé.`,
      `Immeuble ancien à ${city} : appel à devis privé pour le remplacement des colonnes montantes, intervention en site occupé avec coordination des accès logements requise.`,
    ],
    valueRange: [15000, 55000], deadlineDaysRange: [20, 35],
    details: (city) => ({
      scope: `Périmètre : remplacement des colonnes montantes eau froide/eau chaude de l'immeuble ancien à ${city}. Quantités (nombre de colonnes, de logements traversés) à établir lors du diagnostic sur site.`,
      calendar: `Travaux en site occupé, à planifier logement par logement selon la disponibilité des résidents.`,
      constraints: `Coordination des accès aux logements requise avec le syndic. Remise en état des parties traversées (murs, gaines techniques) attendue après intervention.`,
    }),
  },
  {
    tradeSlug: "plomberie", journey: "subcontracting",
    titlePattern: (city) => [
      `Sous-traitance sanitaire - programme neuf à ${city}`,
      `${city} : lot plomberie/sanitaire à sous-traiter`,
    ],
    paragraphs: (city) => [
      `Entreprise générale sur un programme de logements neufs à ${city} recherche un sous-traitant plombier pour la pose des réseaux sanitaires et le raccordement des équipements sur plusieurs lots livrés par tranches.`,
      `Programme immobilier neuf à ${city} : lot plomberie/sanitaire (réseaux, raccordements) à sous-traiter sur plusieurs logements, livraison par tranches successives.`,
    ],
    valueRange: [10000, 35000], deadlineDaysRange: [10, 25],
    details: (city) => ({
      scope: `Périmètre : pose des réseaux sanitaires et raccordement des équipements sur plusieurs lots d'un programme de logements neufs à ${city}, livrés par tranches. Quantités précises (nombre de logements par tranche) à confirmer avec l'entreprise générale.`,
      calendar: `Intervention par tranches de livraison, calendrier calé sur l'avancement global du programme immobilier.`,
      constraints: `Respect du planning de livraison par tranches de l'entreprise générale. Qualification et assurance décennale attendues pour les réseaux sanitaires.`,
    }),
  },
  // --- Isolation ---
  {
    tradeSlug: "isolation", journey: "tender",
    titlePattern: (city) => [
      `Isolation thermique par l'extérieur - résidence à ${city}`,
      `${city} : consultation ITE dans le cadre d'une rénovation énergétique`,
    ],
    paragraphs: (city) => [
      `Bailleur privé à ${city} recherche une entreprise pour l'isolation thermique par l'extérieur (ITE) d'une résidence, dans le cadre d'un programme de rénovation énergétique financé en partie par des aides.`,
      `Résidence privée à ${city} : consultation pour travaux d'isolation thermique par l'extérieur (façades), dans le cadre d'une rénovation énergétique globale du bâtiment.`,
    ],
    valueRange: [40000, 150000], deadlineDaysRange: [25, 40],
    details: (city) => ({
      scope: `Périmètre : isolation thermique par l'extérieur des façades de la résidence à ${city}, dans le cadre d'une rénovation énergétique globale. Quantités (surface de façade à traiter) à confirmer après relevé sur site.`,
      calendar: `Travaux envisagés hors période hivernale, calendrier lié au déblocage des aides à la rénovation énergétique.`,
      constraints: `Qualification RGE requise pour l'éligibilité aux aides. Intervention en site occupé avec échafaudage : sécurisation des abords attendue.`,
    }),
  },
  {
    tradeSlug: "isolation", journey: "subcontracting",
    titlePattern: (city) => [
      `Sous-traitance combles perdus - lotissement ${city}`,
      `${city} : lot isolation par soufflage à sous-traiter`,
    ],
    paragraphs: (city) => [
      `Entreprise générale de construction recherche un sous-traitant pour l'isolation des combles perdus (soufflage) sur un lotissement de maisons individuelles à ${city}.`,
      `Lotissement en cours de construction à ${city} : lot isolation combles perdus par soufflage à sous-traiter sur plusieurs maisons livrées par phases.`,
    ],
    valueRange: [6000, 22000], deadlineDaysRange: [10, 25],
    details: (city) => ({
      scope: `Périmètre : isolation par soufflage des combles perdus sur un lotissement de maisons individuelles à ${city}, plusieurs maisons livrées par phases. Quantités (surface de combles par maison) à confirmer selon l'avancement du lotissement.`,
      calendar: `Intervention par phases, au fur et à mesure de la livraison des maisons du lotissement.`,
      constraints: `Coordination avec le calendrier de livraison de l'entreprise générale. Matériau et épaisseur d'isolation à respecter selon le cahier des charges du constructeur.`,
    }),
  },
  // --- Menuiserie / fenêtres ---
  {
    tradeSlug: "menuiserie", journey: "tender",
    titlePattern: (city) => [
      `Remplacement menuiseries extérieures - copropriété à ${city}`,
      `${city} : consultation privée pour un passage en double vitrage`,
    ],
    paragraphs: (city) => [
      `Copropriété à ${city} lance une consultation privée pour le remplacement des fenêtres et portes-fenêtres en simple vitrage par du double vitrage, sur l'ensemble de la façade.`,
      `Consultation privée à ${city} pour le remplacement de menuiseries extérieures vétustes (fenêtres, portes-fenêtres) par du double vitrage, façade complète.`,
    ],
    valueRange: [20000, 80000], deadlineDaysRange: [20, 35],
    details: (city) => ({
      scope: `Périmètre : remplacement des fenêtres et portes-fenêtres en simple vitrage sur l'ensemble de la façade de la copropriété à ${city}. Quantités (nombre d'ouvertures) à établir lors du relevé sur site.`,
      calendar: `Travaux envisagés par étage ou par cage d'escalier, calendrier à définir avec le syndic.`,
      constraints: `Intervention en site occupé : accès aux logements à coordonner avec les résidents. Respect de l'aspect extérieur harmonisé de la façade demandé.`,
    }),
  },
  {
    tradeSlug: "menuiserie", journey: "subcontracting",
    titlePattern: (city) => [
      `Sous-traitance pose de menuiseries - programme neuf ${city}`,
      `${city} : lot menuiseries extérieures à sous-traiter`,
    ],
    paragraphs: (city) => [
      `Entreprise générale sur un programme de maisons individuelles à ${city} recherche un sous-traitant menuisier pour la pose de fenêtres et volets sur plusieurs lots livrés par tranches.`,
      `Programme de maisons neuves à ${city} : lot menuiseries extérieures (fenêtres, volets) à sous-traiter, pose sur plusieurs lots selon calendrier de livraison.`,
    ],
    valueRange: [10000, 38000], deadlineDaysRange: [12, 28],
    details: (city) => ({
      scope: `Périmètre : pose de fenêtres et volets sur plusieurs lots d'un programme de maisons individuelles neuves à ${city}, livrées par tranches. Quantités (nombre de maisons par tranche) à confirmer avec l'entreprise générale.`,
      calendar: `Pose calée sur le calendrier de livraison par tranches du programme.`,
      constraints: `Respect du planning de livraison de l'entreprise générale. Qualité de pose engageant la garantie décennale attendue.`,
    }),
  },
  // --- Maçonnerie ---
  {
    tradeSlug: "maconnerie", journey: "tender",
    titlePattern: (city) => [
      `Reprise de fissures et façade - bâtiment privé à ${city}`,
      `${city} : consultation maçonnerie suite à un diagnostic structurel`,
    ],
    paragraphs: (city) => [
      `Propriétaire d'un bâtiment ancien à ${city} recherche une entreprise de maçonnerie pour la reprise de fissures structurelles et la réfection d'un pan de façade.`,
      `Bâtiment privé à ${city} : consultation pour travaux de maçonnerie (reprise de fissures, réfection de façade) suite à un diagnostic structurel.`,
    ],
    valueRange: [10000, 45000], deadlineDaysRange: [18, 30],
    details: (city) => ({
      scope: `Périmètre : reprise de fissures structurelles et réfection d'un pan de façade à ${city}, suite à un diagnostic structurel. Quantités (surface de façade concernée) à confirmer après visite.`,
      calendar: `Intervention envisagée dès validation du diagnostic structurel, avant aggravation des désordres constatés.`,
      constraints: `Suivi des préconisations du diagnostic structurel attendu. Sécurisation des abords pendant les travaux de façade.`,
    }),
  },
  {
    tradeSlug: "maconnerie", journey: "subcontracting",
    titlePattern: (city) => [
      `Sous-traitance gros oeuvre - extension à ${city}`,
      `${city} : lot fondations et élévation à sous-traiter`,
    ],
    paragraphs: (city) => [
      `Entreprise générale recherche un sous-traitant maçon pour la réalisation du gros oeuvre d'une extension de maison individuelle à ${city} (fondations, élévation).`,
      `Chantier d'extension à ${city} : lot gros oeuvre (fondations, élévation des murs) à sous-traiter, dans le cadre d'un agrandissement de maison individuelle.`,
    ],
    valueRange: [18000, 55000], deadlineDaysRange: [15, 30],
    details: (city) => ({
      scope: `Périmètre : réalisation des fondations et de l'élévation d'une extension de maison individuelle à ${city}. Quantités (surface au sol de l'extension) à confirmer avec l'entreprise générale.`,
      calendar: `Intervention en début de chantier, avant les autres corps d'état de l'extension.`,
      constraints: `Coordination avec le planning global de l'entreprise générale. Respect des plans structurels validés par le bureau d'études.`,
    }),
  },
  // --- Peinture ---
  {
    tradeSlug: "peinture", journey: "tender",
    titlePattern: (city) => [
      `Peinture intérieure - résidence de ${city}`,
      `${city} : consultation peinture pour des parties communes`,
    ],
    paragraphs: (city) => [
      `Bailleur privé à ${city} recherche une entreprise de peinture pour la remise en état des parties communes (cages d'escalier, halls) d'une résidence de plusieurs logements.`,
      `Résidence à ${city} : consultation pour travaux de peinture intérieure des parties communes, incluant préparation des supports et finitions.`,
    ],
    valueRange: [8000, 30000], deadlineDaysRange: [12, 25],
    details: (city) => ({
      scope: `Périmètre : remise en état des parties communes (cages d'escalier, halls) d'une résidence de plusieurs logements à ${city}, préparation des supports comprise. Quantités (surfaces à traiter) à confirmer sur site.`,
      calendar: `Travaux envisagés en horaires de journée, hors passages fréquents des résidents si possible.`,
      constraints: `Intervention en site occupé : sécurisation et signalisation des zones en travaux attendues. Nuisances sonores et olfactives à limiter.`,
    }),
  },
  {
    tradeSlug: "peinture", journey: "subcontracting",
    titlePattern: (city) => [
      `Sous-traitance peinture - programme neuf à ${city}`,
      `${city} : lot peinture/finitions à sous-traiter`,
    ],
    paragraphs: (city) => [
      `Entreprise générale sur un programme de logements neufs à ${city} recherche un sous-traitant peintre pour les finitions intérieures sur plusieurs lots livrés par tranches.`,
      `Programme immobilier neuf à ${city} : lot peinture/finitions à sous-traiter sur plusieurs logements, livraison par tranches successives.`,
    ],
    valueRange: [12000, 40000], deadlineDaysRange: [10, 25],
    details: (city) => ({
      scope: `Périmètre : finitions peinture intérieure sur plusieurs lots d'un programme de logements neufs à ${city}, livrés par tranches. Quantités (nombre de logements par tranche) à confirmer avec l'entreprise générale.`,
      calendar: `Intervention en fin de chantier, juste avant la livraison de chaque tranche de logements.`,
      constraints: `Respect du planning de livraison par tranches. Finitions engageant la réception des logements par les acquéreurs.`,
    }),
  },
  // --- Couverture ---
  {
    tradeSlug: "couverture", journey: "tender",
    titlePattern: (city) => [
      `Réfection de toiture - bâtiment privé à ${city}`,
      `${city} : consultation privée pour une toiture endommagée`,
    ],
    paragraphs: (city) => [
      `Propriétaire privé à ${city} recherche une entreprise de couverture pour la réfection complète d'une toiture endommagée, avec reprise de la zinguerie.`,
      `Bâtiment privé à ${city} : consultation pour réfection de toiture (couverture et zinguerie) suite à un constat de dégradation.`,
    ],
    valueRange: [15000, 60000], deadlineDaysRange: [15, 30],
    details: (city) => ({
      scope: `Périmètre : réfection complète d'une toiture endommagée avec reprise de la zinguerie à ${city}. Quantités (surface de toiture) à confirmer après constat sur site.`,
      calendar: `Intervention envisagée rapidement compte tenu de la dégradation constatée, sous réserve de conditions météo favorables.`,
      constraints: `Sécurisation du chantier en hauteur attendue. Protection des éléments en dessous de la toiture pendant les travaux.`,
    }),
  },
  {
    tradeSlug: "couverture", journey: "subcontracting",
    titlePattern: (city) => [
      `Sous-traitance charpente-couverture - maisons neuves ${city}`,
      `${city} : lot charpente-couverture à sous-traiter`,
    ],
    paragraphs: (city) => [
      `Constructeur de maisons individuelles à ${city} recherche un sous-traitant charpentier-couvreur pour la pose de charpente et couverture sur un lot de plusieurs maisons.`,
      `Programme de maisons individuelles à ${city} : lot charpente-couverture à sous-traiter sur plusieurs constructions, livraison échelonnée.`,
    ],
    valueRange: [20000, 65000], deadlineDaysRange: [15, 30],
    details: (city) => ({
      scope: `Périmètre : pose de charpente et couverture sur un lot de plusieurs maisons individuelles neuves à ${city}, livraison échelonnée. Quantités (nombre de maisons du lot) à confirmer avec le constructeur.`,
      calendar: `Pose calée sur l'avancement du gros oeuvre de chaque maison, livraison échelonnée.`,
      constraints: `Coordination avec le planning du constructeur. Respect des matériaux et pentes de toiture définis au permis de construire.`,
    }),
  },
  // --- Rénovation générale (batiment-general) ---
  {
    tradeSlug: "batiment-general", journey: "tender",
    titlePattern: (city) => [
      `Rénovation complète de logements - ${city}`,
      `${city} : consultation tous corps d'état avant remise en location`,
    ],
    paragraphs: (city) => [
      `Bailleur privé à ${city} lance une consultation pour la rénovation complète (tous corps d'état) d'un ensemble de logements avant relocation.`,
      `Ensemble de logements à ${city} : consultation privée tous corps d'état pour une rénovation complète avant remise en location.`,
    ],
    valueRange: [60000, 250000], deadlineDaysRange: [25, 45],
    details: (city) => ({
      scope: `Périmètre : rénovation tous corps d'état d'un ensemble de logements à ${city} avant remise en location. Quantités (nombre de logements concernés) à confirmer avec le bailleur.`,
      calendar: `Travaux envisagés logement par logement, calendrier à coordonner avec les dates de relocation prévues.`,
      constraints: `Coordination de l'ensemble des corps d'état à assurer. Délai de remise en location à respecter selon la programmation du bailleur.`,
    }),
  },
  {
    tradeSlug: "batiment-general", journey: "subcontracting",
    titlePattern: (city) => [
      `Sous-traitance tous corps d'état - réhabilitation ${city}`,
      `${city} : plusieurs lots second oeuvre à sous-traiter`,
    ],
    paragraphs: (city) => [
      `Entreprise générale pilotant une réhabilitation d'immeuble à ${city} recherche des sous-traitants tous corps d'état pour plusieurs lots (cloisons, second oeuvre, finitions).`,
      `Chantier de réhabilitation à ${city} : plusieurs lots second oeuvre et finitions à sous-traiter, dans le cadre d'une rénovation d'immeuble pilotée en entreprise générale.`,
    ],
    valueRange: [40000, 180000], deadlineDaysRange: [20, 40],
    details: (city) => ({
      scope: `Périmètre : plusieurs lots second oeuvre (cloisons, finitions) d'une réhabilitation d'immeuble à ${city}, pilotée en entreprise générale. Quantités (nombre de logements ou surface par lot) à confirmer avec l'entreprise générale.`,
      calendar: `Intervention par lots, selon le planning de réhabilitation piloté par l'entreprise générale.`,
      constraints: `Coordination avec les autres sous-traitants déjà engagés sur le chantier. Respect du planning global de réhabilitation.`,
    }),
  },
  // --- Espaces verts ---
  {
    tradeSlug: "espaces-verts", journey: "tender",
    titlePattern: (city) => [
      `Entretien espaces verts - résidence privée à ${city}`,
      `${city} : marché annuel d'entretien paysager`,
    ],
    paragraphs: (city) => [
      `Copropriété à ${city} recherche une entreprise de paysagisme pour un contrat annuel d'entretien des espaces verts (tonte, taille, entretien des massifs).`,
      `Résidence privée à ${city} : consultation pour un marché annuel d'entretien paysager des espaces verts communs.`,
    ],
    valueRange: [6000, 25000], deadlineDaysRange: [15, 30],
    details: (city) => ({
      scope: `Périmètre : entretien des espaces verts communs de la copropriété à ${city} (tonte, taille, entretien des massifs), contrat annuel. Quantités (surface d'espaces verts, fréquence de passage) à confirmer avec le syndic.`,
      calendar: `Contrat annuel avec passages réguliers selon la saison, fréquence à définir avec la copropriété.`,
      constraints: `Respect du calendrier de passage attendu par les résidents. Produits et méthodes d'entretien respectueux de l'environnement souhaités.`,
    }),
  },
  {
    tradeSlug: "espaces-verts", journey: "tender",
    titlePattern: (city) => [
      `Aménagement paysager - lotissement neuf à ${city}`,
      `${city} : consultation paysagère avant livraison d'un lotissement`,
    ],
    paragraphs: (city) => [
      `Promoteur d'un lotissement neuf à ${city} recherche une entreprise de paysagisme pour l'aménagement des espaces verts communs (plantations, engazonnement) avant livraison.`,
      `Lotissement en fin de construction à ${city} : consultation pour l'aménagement paysager des espaces communs (plantations, engazonnement) avant remise aux acquéreurs.`,
    ],
    valueRange: [12000, 45000], deadlineDaysRange: [15, 30],
    details: (city) => ({
      scope: `Périmètre : aménagement des espaces verts communs d'un lotissement neuf à ${city} (plantations, engazonnement) avant livraison. Quantités (surface à aménager) à confirmer avec le promoteur.`,
      calendar: `Intervention avant la livraison du lotissement aux acquéreurs, calendrier calé sur l'avancement global du programme.`,
      constraints: `Respect du délai de livraison du promoteur. Choix des végétaux à valider selon le cahier des charges paysager du lotissement.`,
    }),
  },
  // --- Nettoyage ---
  {
    tradeSlug: "nettoyage", journey: "tender",
    titlePattern: (city) => [
      `Contrat de nettoyage - immeuble de bureaux à ${city}`,
      `${city} : marché annuel de nettoyage de locaux tertiaires`,
    ],
    paragraphs: (city) => [
      `Gestionnaire d'un immeuble de bureaux à ${city} recherche une société de nettoyage pour un contrat annuel d'entretien des parties communes et des bureaux.`,
      `Immeuble tertiaire à ${city} : consultation privée pour un marché annuel de nettoyage des locaux et parties communes.`,
    ],
    valueRange: [10000, 40000], deadlineDaysRange: [12, 25],
    details: (city) => ({
      scope: `Périmètre : entretien des parties communes et des bureaux d'un immeuble tertiaire à ${city}, contrat annuel. Quantités (surface à nettoyer, fréquence de passage) à confirmer avec le gestionnaire.`,
      calendar: `Contrat annuel avec passages réguliers, fréquence hebdomadaire ou quotidienne à définir avec le gestionnaire.`,
      constraints: `Intervention en horaires compatibles avec l'activité des occupants de l'immeuble. Produits et matériel professionnels attendus.`,
    }),
  },
  {
    tradeSlug: "nettoyage", journey: "tender",
    titlePattern: (city) => [
      `Nettoyage de fin de chantier - programme neuf à ${city}`,
      `${city} : consultation nettoyage avant livraison de logements`,
    ],
    paragraphs: (city) => [
      `Promoteur immobilier à ${city} recherche une société de nettoyage pour le nettoyage de fin de chantier d'un programme de logements neufs, avant remise aux acquéreurs.`,
      `Programme de logements neufs à ${city} : consultation pour le nettoyage de fin de chantier de l'ensemble des lots avant livraison.`,
    ],
    valueRange: [5000, 20000], deadlineDaysRange: [8, 20],
    details: (city) => ({
      scope: `Périmètre : nettoyage de fin de chantier de l'ensemble des lots d'un programme de logements neufs à ${city}, avant remise aux acquéreurs. Quantités (nombre de logements) à confirmer avec le promoteur.`,
      calendar: `Intervention juste avant la livraison de chaque tranche du programme, calendrier calé sur l'avancement du chantier.`,
      constraints: `Respect du planning de livraison du promoteur. Nettoyage engageant la réception des logements par les acquéreurs.`,
    }),
  },
  // --- Maintenance ---
  {
    tradeSlug: "maintenance", journey: "tender",
    titlePattern: (city) => [
      `Contrat de maintenance multi-technique - résidence à ${city}`,
      `${city} : marché de maintenance annuel pour une résidence privée`,
    ],
    paragraphs: (city) => [
      `Syndic à ${city} recherche un prestataire pour un contrat de maintenance multi-technique (ascenseurs, VMC, portails) sur une résidence privée.`,
      `Résidence privée à ${city} : consultation pour un marché de maintenance multi-technique annuel (équipements communs, VMC, portails automatiques).`,
    ],
    valueRange: [8000, 35000], deadlineDaysRange: [15, 30],
    details: (city) => ({
      scope: `Périmètre : maintenance des équipements communs (ascenseurs, VMC, portails) d'une résidence privée à ${city}, contrat annuel. Quantités (nombre d'équipements) à confirmer avec le syndic.`,
      calendar: `Contrat annuel avec passages de maintenance préventive réguliers, fréquence à définir avec la résidence.`,
      constraints: `Qualifications spécifiques attendues selon les équipements (ascenseurs notamment). Astreinte ou intervention d'urgence possible selon le contrat.`,
    }),
  },
  {
    tradeSlug: "maintenance", journey: "subcontracting",
    titlePattern: (city) => [
      `Sous-traitance maintenance VMC/désenfumage - tertiaire ${city}`,
      `${city} : lot maintenance VMC/désenfumage à sous-traiter`,
    ],
    paragraphs: (city) => [
      `Prestataire multi-technique en charge d'un immeuble de bureaux à ${city} recherche un sous-traitant spécialisé pour la maintenance des systèmes de VMC et de désenfumage.`,
      `Immeuble tertiaire à ${city} : lot maintenance VMC/désenfumage à sous-traiter dans le cadre d'un contrat multi-technique existant.`,
    ],
    valueRange: [6000, 22000], deadlineDaysRange: [12, 25],
    details: (city) => ({
      scope: `Périmètre : maintenance des systèmes de VMC et de désenfumage d'un immeuble de bureaux à ${city}, dans le cadre d'un contrat multi-technique existant. Quantités (nombre de systèmes) à confirmer avec le prestataire principal.`,
      calendar: `Interventions de maintenance périodiques, calendrier calé sur le contrat multi-technique existant.`,
      constraints: `Qualification spécifique désenfumage/VMC attendue. Coordination avec le prestataire multi-technique principal déjà en place.`,
    }),
  },
];

// Small deterministic hash so the same (scenario,city) combination always
// gets the same phrasing/value/deadline on a re-run (needed for the
// ON CONFLICT DO NOTHING idempotency to make sense - re-running shouldn't
// look like it's "trying" different content for the same row).
function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) >>> 0; }
  return h;
}

function slugify(s) {
  return s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

async function run() {
  const sourceRes = await pool.query(`SELECT id FROM data_sources WHERE code = 'editorial_catalog'`);
  if (sourceRes.rows.length === 0) {
    console.log("[seedEditorialListings] data_sources row 'editorial_catalog' not found yet (migration hasn't run on this DB) - skipping, will retry on next boot.");
    return;
  }
  const sourceId = sourceRes.rows[0].id;

  if (CLEAN) {
    if (DRY_RUN) { console.log("[seedEditorialListings] --dry-run + --clean: would delete all rows for source_id=" + sourceId); return; }
    const result = await pool.query(`DELETE FROM opportunities WHERE source_id = $1`, [sourceId]);
    console.log(`[seedEditorialListings] Deleted ${result.rowCount} editorial rows.`);
    return;
  }

  const tradeRes = await pool.query(`SELECT id, slug FROM trades`);
  const tradeIdBySlug = new Map(tradeRes.rows.map((r) => [r.slug, r.id]));
  const typeRes = await pool.query(`SELECT id, code FROM opportunity_types`);
  const typeIdByCode = new Map(typeRes.rows.map((r) => [r.code, r.id]));

  const missingTrades = [...new Set(SCENARIOS.map((s) => s.tradeSlug))].filter((slug) => !tradeIdBySlug.has(slug));
  if (missingTrades.length > 0) {
    console.log(`[seedEditorialListings] Missing trades in DB: ${missingTrades.join(", ")} - skipping, will retry on next boot once the migration has added them.`);
    return;
  }

  // Spread: N cities per scenario, picked deterministically per scenario
  // (not the same N every time) so coverage spreads across the city list
  // rather than clustering on Paris/Bordeaux for every trade. Step 7 below
  // and CITIES.length=67 are coprime (67 is prime), so stepping through the
  // list visits all 67 cities exactly once before it would ever repeat -
  // CITIES_PER_SCENARIO can safely go all the way to CITIES.length with no
  // collisions. Bumped 3 -> 9 -> now the full city list per client
  // instruction (19 Sep: "on n'a pas encore de fichiers exploitables...
  // il faudra assurer une couverture géographique nationale... l'objectif
  // est une couverture nationale importante") - 24 scenarios x 67 cities
  // covering every mainland region, each row still tracing back to one of
  // the real, distinct title/paragraph variants above (never a bare
  // find/replace of a single template - see the file header for why that
  // matters for SEO).
  const CITIES_PER_SCENARIO = CITIES.length;

  const rows = [];
  // Two trades (espaces-verts, nettoyage) have 2 scenarios that are both
  // "tender" (no subcontracting split for those) - same (tradeSlug,journey)
  // pair. With CITIES_PER_SCENARIO now covering every city, both scenarios
  // in each pair select the exact same 67 cities, which would make their
  // `key`/source_reference identical city-for-city - the second scenario's
  // rows would silently vanish via ON CONFLICT DO NOTHING below, with
  // nothing logging that it happened. Suffix every repeat occurrence of a
  // (tradeSlug,journey) pair with its 1-based index among that pair so keys
  // stay unique; the *first* occurrence keeps its original, unsuffixed key
  // so it still matches whatever's already live under that source_reference
  // (this pattern existed at smaller CITIES_PER_SCENARIO too, just as a
  // partial-overlap risk instead of a guaranteed one - worth having this
  // safety net regardless of the current constant).
  const scenarioOccurrence = new Map();
  for (const scenario of SCENARIOS) {
    const pairKey = `${scenario.tradeSlug}-${scenario.journey}`;
    const occurrence = (scenarioOccurrence.get(pairKey) || 0) + 1;
    scenarioOccurrence.set(pairKey, occurrence);
    const scenarioSuffix = occurrence > 1 ? `-v${occurrence}` : '';

    const offset = hash(scenario.tradeSlug + scenario.journey + scenario.titlePattern("x")[0]) % CITIES.length;
    for (let i = 0; i < CITIES_PER_SCENARIO; i++) {
      const city = CITIES[(offset + i * 7) % CITIES.length]; // step 7: spreads picks instead of walking sequentially
      const key = `${scenario.tradeSlug}-${scenario.journey}${scenarioSuffix}-${slugify(city.name)}`;
      const h = hash(key);
      // Title variant picked from its own hash (salted differently from h),
      // deliberately decorrelated from the paragraph variant below - so a
      // city doesn't always land on "title v1 + paragraph v1" together,
      // which would still just be 2 fixed combinations repeated across the
      // 9 cities. Independent selection gives up to 4 distinct
      // title/paragraph combinations per scenario instead of 2.
      const titleVariantIdx = hash(key + "-title") % 2;
      const variant = scenario.paragraphs(city.name)[h % 2];
      const [vMin, vMax] = scenario.valueRange;
      const value = vMin + (h % (vMax - vMin));
      const [dMin, dMax] = scenario.deadlineDaysRange;
      const deadlineDays = dMin + (h % (dMax - dMin));
      const title = scenario.titlePattern(city.name)[titleVariantIdx];
      const details = scenario.details(city.name);

      rows.push({
        sourceRef: `editorial-${key}`,
        typeId: typeIdByCode.get(scenario.journey),
        tradeId: tradeIdBySlug.get(scenario.tradeSlug),
        title,
        description: variant,
        value,
        city: city.name,
        department: city.department,
        region: city.region,
        deadlineDays,
        details,
      });
    }
  }

  console.log(`[seedEditorialListings] Prepared ${rows.length} rows across ${SCENARIOS.length} scenarios.`);

  if (DRY_RUN) {
    for (const r of rows.slice(0, 10)) {
      console.log(`  [DRY RUN] ${r.sourceRef} :: ${r.title} — ${r.value}€, échéance ~${r.deadlineDays}j`);
    }
    console.log(`[seedEditorialListings] --dry-run: ${rows.length} rows prepared, nothing written.`);
    return;
  }

  // 18 bound params per row (19 columns total; publication_date is a bare
  // NOW() with no param of its own, deadline's one param is deadlineDays):
  //  1 source_id, 2 source_reference, 3 opportunity_type_id, 4 trade_id,
  //  5 title, 6 description, 7 deadlineDays (used inside the deadline
  //  interval expression below), 8 estimated_value, 9 currency,
  //  10 location_city, 11 location_department, 12 location_region,
  //  13 status, 14 ai_classification_status, 15 ai_matched_trades,
  //  16 ai_summary_status, 17 dce_documents_status, 18 ai_extracted_facts.
  //
  // ai_extracted_facts (added 25 Sep audit, point 10): these rows never go
  // through extractOpportunityFacts (no real notice/DCE text to extract
  // from, and the account's Anthropic API credits are exhausted anyway -
  // see marchesdirect.md), so the fiche's "Détails du dossier" block used
  // to fall back to just lieu/montant/échéance/référence for every private
  // tender and sous-traitance listing - exactly the "quelques lignes
  // génériques" thinness the client flagged. Populated here instead,
  // directly from each scenario's own scope/calendar/constraints text (see
  // SCENARIOS[].details above) - deterministic, not AI-dependent, and
  // varies per trade+journey same as the title/paragraph do. buyer_name/
  // contact_email are deliberately left "not available" (never set) so the
  // existing identity-redaction gate still fully governs those - this only
  // adds facts about the job itself. team_size_estimate/key_risks/
  // contract_duration/selection_criteria are included as explicit
  // "not available" only so routes/opportunities.ts's factsNeedExtraction()
  // sees a complete-shaped object and doesn't queue these rows for a real
  // (currently-failing) AI extraction on every visit.
  const values = [];
  rows.forEach((r) => {
    const facts = {
      scope_details: { value: r.details.scope, available: true },
      intervention_calendar: { value: r.details.calendar, available: true },
      constraints_expectations: { value: r.details.constraints, available: true },
      buyer_name: { value: "not available", available: false },
      contact_email: { value: "not available", available: false },
      contract_object: { value: "not available", available: false },
      procedure_type: { value: "not available", available: false },
      submission_deadline: { value: "not available", available: false },
      estimated_value: { value: "not available", available: false },
      required_qualifications: { value: "not available", available: false },
      team_size_estimate: { value: "not available", available: false },
      key_risks: { value: [], available: false },
      contract_duration: { value: "not available", available: false },
      submission_method: { value: "not available", available: false },
      allotment: { value: "not available", available: false },
      technical_visit: { value: "not available", available: false },
      selection_criteria: { value: [], available: false },
      attribution_winner: { value: "not available", available: false },
      attribution_amount: { value: "not available", available: false },
      attribution_date: { value: "not available", available: false },
      buyer_phone: { value: "not available", available: false },
      buyer_website: { value: "not available", available: false },
      requirements_detected: { value: 0, available: false },
    };
    values.push(
      sourceId, r.sourceRef, r.typeId, r.tradeId,
      r.title, r.description, r.deadlineDays, r.value, "EUR",
      r.city, r.department, r.region,
      "active", "classified",
      JSON.stringify([{ trade_id: r.tradeId, confidence: 1.0, reasoning: "Assignation éditoriale directe (catalogue interne, pas de classification IA)." }]),
      "not_generated", "no_documents_found",
      JSON.stringify(facts)
    );
  });
  const PARAMS_PER_ROW = 18;
  const placeholders = rows
    .map((_r, idx) => {
      const base = idx * PARAMS_PER_ROW;
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, NOW(), NOW() + ($${base + 7}::int * interval '1 day'), $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11}, $${base + 12}, $${base + 13}, $${base + 14}, $${base + 15}, $${base + 16}, $${base + 17}, $${base + 18}::jsonb)`;
    })
    .join(",\n");

  // ON CONFLICT ... DO UPDATE (not DO NOTHING) specifically so this batch
  // can backfill ai_extracted_facts onto the ~1,600 editorial rows already
  // inserted by earlier runs of this script - a plain DO NOTHING would
  // silently skip every one of them since their source_reference already
  // exists. Only ai_extracted_facts is touched on conflict, only when it's
  // still NULL, so a row that somehow did get a real AI extraction later
  // is left alone rather than being overwritten with this fallback data.
  const result = await pool.query(
    `INSERT INTO opportunities (
       source_id, source_reference, opportunity_type_id, trade_id,
       title, description, publication_date, deadline,
       estimated_value, currency, location_city, location_department, location_region,
       status, ai_classification_status, ai_matched_trades, ai_summary_status, dce_documents_status,
       ai_extracted_facts
     ) VALUES ${placeholders}
     ON CONFLICT (source_id, source_reference) DO UPDATE
       SET ai_extracted_facts = EXCLUDED.ai_extracted_facts
       WHERE opportunities.ai_extracted_facts IS NULL`,
    values
  );

  console.log(`[seedEditorialListings] Inserted/backfilled ${result.rowCount} rows (new inserts + ai_extracted_facts backfill on existing rows - safe re-run).`);
  console.log("[seedEditorialListings] Curated national-spread batch, not a literal every-city catalog - see the header comment for how to extend it further.");
}

module.exports = { run };

// Only auto-run + exit the process when invoked directly (`node
// scripts/seedEditorialListings.js`) - server.ts instead requires this
// module and calls run() itself inside its own try/catch, without wanting
// the whole app process to exit afterwards.
if (require.main === module) {
  run()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[seedEditorialListings] Failed:", err.message);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
