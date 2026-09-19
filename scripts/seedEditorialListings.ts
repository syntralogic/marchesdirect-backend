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
 * Explicitly a FIRST BATCH for review, not the full national catalog the
 * client described - safe to re-run (idempotent on source_reference) and
 * safe to extend once the trade/scenario/city lists below are validated.
 *
 * Content design (client's specific SEO warning: no "same ad, city
 * swapped" duplication):
 *   - Each trade has 2-3 distinct SCENARIOS (a real different kind of job,
 *     not a reworded synonym of the same one) with their own title
 *     pattern, description paragraph, budget range and typical timeline.
 *   - Each (trade, scenario, city) combination additionally picks from 2
 *     phrasing variants (deterministically, by hashing the combination) so
 *     even the same scenario in two different cities isn't the same
 *     sentence with one word changed.
 *   - Budget and start-date-in-N-days are varied deterministically per row
 *     within the scenario's realistic range, not fixed constants.
 * This is templated, not hand-written-per-city prose - a genuine step up
 * from name-swapping, but the client should still review this first batch
 * before it's scaled to the full "couverture nationale" they described.
 *
 * Usage:
 *   npm run seed:editorial-listings                  # insert the batch
 *   npm run seed:editorial-listings -- --clean        # delete all editorial rows
 *   npm run seed:editorial-listings -- --dry-run      # print without writing
 */
import { db } from '../src/config/database';
import { logger } from '../src/utils/logger';

const DRY_RUN = process.argv.includes('--dry-run');
const CLEAN = process.argv.includes('--clean');

// ---------------------------------------------------------------------------
// Cities: a first spread across regions, including every city the client
// has specifically tested by name in prior audits (Bordeaux, Angoulême,
// Périgueux, Bergerac, Marmande, Strasbourg) plus other major/mid cities.
// ---------------------------------------------------------------------------
const CITIES: { name: string; department: string; region: string }[] = [
  { name: 'Bordeaux', department: '33', region: 'Nouvelle-Aquitaine' },
  { name: 'Angoulême', department: '16', region: 'Nouvelle-Aquitaine' },
  { name: 'Périgueux', department: '24', region: 'Nouvelle-Aquitaine' },
  { name: 'Bergerac', department: '24', region: 'Nouvelle-Aquitaine' },
  { name: 'Marmande', department: '47', region: 'Nouvelle-Aquitaine' },
  { name: 'La Rochelle', department: '17', region: 'Nouvelle-Aquitaine' },
  { name: 'Strasbourg', department: '67', region: 'Grand Est' },
  { name: 'Metz', department: '57', region: 'Grand Est' },
  { name: 'Reims', department: '51', region: 'Grand Est' },
  { name: 'Paris', department: '75', region: 'Île-de-France' },
  { name: 'Versailles', department: '78', region: 'Île-de-France' },
  { name: 'Lyon', department: '69', region: 'Auvergne-Rhône-Alpes' },
  { name: 'Grenoble', department: '38', region: 'Auvergne-Rhône-Alpes' },
  { name: 'Clermont-Ferrand', department: '63', region: 'Auvergne-Rhône-Alpes' },
  { name: 'Marseille', department: '13', region: "Provence-Alpes-Côte d'Azur" },
  { name: 'Toulon', department: '83', region: "Provence-Alpes-Côte d'Azur" },
  { name: 'Nice', department: '06', region: "Provence-Alpes-Côte d'Azur" },
  { name: 'Toulouse', department: '31', region: 'Occitanie' },
  { name: 'Montpellier', department: '34', region: 'Occitanie' },
  { name: 'Nîmes', department: '30', region: 'Occitanie' },
  { name: 'Nantes', department: '44', region: 'Pays de la Loire' },
  { name: 'Le Mans', department: '72', region: 'Pays de la Loire' },
  { name: 'Rennes', department: '35', region: 'Bretagne' },
  { name: 'Brest', department: '29', region: 'Bretagne' },
  { name: 'Lille', department: '59', region: 'Hauts-de-France' },
  { name: 'Amiens', department: '80', region: 'Hauts-de-France' },
  { name: 'Rouen', department: '76', region: 'Normandie' },
  { name: 'Caen', department: '14', region: 'Normandie' },
  { name: 'Dijon', department: '21', region: 'Bourgogne-Franche-Comté' },
  { name: 'Orléans', department: '45', region: 'Centre-Val de Loire' },
];

// ---------------------------------------------------------------------------
// Trades × scenarios. trade_slug must exist in the `trades` table - the
// three non-construction ones (espaces-verts, nettoyage, maintenance) are
// added by src/config/database.ts's applyIncrementalMigrations, run this
// after deploying that change (or after `npm run db:migrate` in dev).
// ---------------------------------------------------------------------------
type Scenario = {
  tradeSlug: string;
  journey: 'tender' | 'subcontracting';
  titlePattern: (city: string) => string;
  paragraphs: [string, string]; // two phrasing variants
  valueRange: [number, number];
  deadlineDaysRange: [number, number]; // response deadline, days from now
};

const SCENARIOS: Scenario[] = [
  // --- Climatisation / chauffage (trade: cvc) ---
  {
    tradeSlug: 'cvc', journey: 'tender',
    titlePattern: (city) => `Installation climatisation multi-split - copropriété à ${city}`,
    paragraphs: [
      `Copropriété privée à ${city} recherchant une entreprise pour l'installation de climatisation réversible multi-split sur l'ensemble des parties communes et un lot de logements pilotes avant généralisation. Le syndic souhaite comparer plusieurs devis avant lancement.`,
      `Consultation privée lancée par une copropriété de ${city} pour équiper en climatisation réversible multi-split un premier lot de logements et les parties communes, avant extension au reste de l'immeuble selon le retour d'expérience.`,
    ],
    valueRange: [18000, 65000], deadlineDaysRange: [18, 35],
  },
  {
    tradeSlug: 'cvc', journey: 'subcontracting',
    titlePattern: (city) => `Sous-traitance chaufferie collective - résidence ${city}`,
    paragraphs: [
      `Entreprise générale intervenant sur la rénovation d'une chaufferie collective à ${city} recherche un sous-traitant CVC qualifié pour la dépose de l'ancienne installation et la pose d'une chaudière collective à condensation.`,
      `Lot chauffage à sous-traiter dans le cadre d'une rénovation de résidence à ${city} : remplacement d'une chaufferie collective par une chaudière à condensation, dépose comprise. Recherche d'un sous-traitant disponible sous délai court.`,
    ],
    valueRange: [25000, 90000], deadlineDaysRange: [14, 30],
  },
  // --- Électricité ---
  {
    tradeSlug: 'electricite', journey: 'tender',
    titlePattern: (city) => `Mise aux normes électriques - immeuble tertiaire à ${city}`,
    paragraphs: [
      `Propriétaire d'un immeuble de bureaux à ${city} lance une consultation privée pour la mise aux normes du tableau électrique général et le remplacement du câblage vétuste sur trois étages.`,
      `Immeuble tertiaire à ${city} : consultation restreinte pour une mise en conformité électrique complète (tableau général, câblage) sur plusieurs niveaux, hors intervention sur les parties déjà rénovées.`,
    ],
    valueRange: [12000, 48000], deadlineDaysRange: [15, 30],
  },
  {
    tradeSlug: 'electricite', journey: 'subcontracting',
    titlePattern: (city) => `Sous-traitance IRVE - parking résidentiel ${city}`,
    paragraphs: [
      `Entreprise générale recherche un sous-traitant électricien qualifié IRVE pour l'installation de bornes de recharge sur un parking résidentiel à ${city}, raccordement compris.`,
      `Chantier de résidence à ${city} : lot bornes de recharge véhicules électriques (IRVE) à sous-traiter, raccordement au tableau général et mise en service comprises.`,
    ],
    valueRange: [8000, 30000], deadlineDaysRange: [10, 25],
  },
  // --- Plomberie ---
  {
    tradeSlug: 'plomberie', journey: 'tender',
    titlePattern: (city) => `Rénovation colonnes montantes - immeuble ancien à ${city}`,
    paragraphs: [
      `Syndic de copropriété à ${city} lance une consultation pour la rénovation des colonnes montantes eau froide/eau chaude d'un immeuble ancien, travaux à réaliser en site occupé.`,
      `Immeuble ancien à ${city} : appel à devis privé pour le remplacement des colonnes montantes, intervention en site occupé avec coordination des accès logements requise.`,
    ],
    valueRange: [15000, 55000], deadlineDaysRange: [20, 35],
  },
  // --- Isolation ---
  {
    tradeSlug: 'isolation', journey: 'tender',
    titlePattern: (city) => `Isolation thermique par l'extérieur - résidence à ${city}`,
    paragraphs: [
      `Bailleur privé à ${city} recherche une entreprise pour l'isolation thermique par l'extérieur (ITE) d'une résidence, dans le cadre d'un programme de rénovation énergétique financé en partie par des aides.`,
      `Résidence privée à ${city} : consultation pour travaux d'isolation thermique par l'extérieur (façades), dans le cadre d'une rénovation énergétique globale du bâtiment.`,
    ],
    valueRange: [40000, 150000], deadlineDaysRange: [25, 40],
  },
  {
    tradeSlug: 'isolation', journey: 'subcontracting',
    titlePattern: (city) => `Sous-traitance combles perdus - lotissement ${city}`,
    paragraphs: [
      `Entreprise générale de construction recherche un sous-traitant pour l'isolation des combles perdus (soufflage) sur un lotissement de maisons individuelles à ${city}.`,
      `Lotissement en cours de construction à ${city} : lot isolation combles perdus par soufflage à sous-traiter sur plusieurs maisons livrées par phases.`,
    ],
    valueRange: [6000, 22000], deadlineDaysRange: [10, 25],
  },
  // --- Menuiserie / fenêtres ---
  {
    tradeSlug: 'menuiserie', journey: 'tender',
    titlePattern: (city) => `Remplacement menuiseries extérieures - copropriété à ${city}`,
    paragraphs: [
      `Copropriété à ${city} lance une consultation privée pour le remplacement des fenêtres et portes-fenêtres en simple vitrage par du double vitrage, sur l'ensemble de la façade.`,
      `Consultation privée à ${city} pour le remplacement de menuiseries extérieures vétustes (fenêtres, portes-fenêtres) par du double vitrage, façade complète.`,
    ],
    valueRange: [20000, 80000], deadlineDaysRange: [20, 35],
  },
  // --- Maçonnerie ---
  {
    tradeSlug: 'maconnerie', journey: 'tender',
    titlePattern: (city) => `Reprise de fissures et façade - bâtiment privé à ${city}`,
    paragraphs: [
      `Propriétaire d'un bâtiment ancien à ${city} recherche une entreprise de maçonnerie pour la reprise de fissures structurelles et la réfection d'un pan de façade.`,
      `Bâtiment privé à ${city} : consultation pour travaux de maçonnerie (reprise de fissures, réfection de façade) suite à un diagnostic structurel.`,
    ],
    valueRange: [10000, 45000], deadlineDaysRange: [18, 30],
  },
  // --- Peinture ---
  {
    tradeSlug: 'peinture', journey: 'tender',
    titlePattern: (city) => `Peinture intérieure - résidence de ${city}`,
    paragraphs: [
      `Bailleur privé à ${city} recherche une entreprise de peinture pour la remise en état des parties communes (cages d'escalier, halls) d'une résidence de plusieurs logements.`,
      `Résidence à ${city} : consultation pour travaux de peinture intérieure des parties communes, incluant préparation des supports et finitions.`,
    ],
    valueRange: [8000, 30000], deadlineDaysRange: [12, 25],
  },
  {
    tradeSlug: 'peinture', journey: 'subcontracting',
    titlePattern: (city) => `Sous-traitance peinture - programme neuf à ${city}`,
    paragraphs: [
      `Entreprise générale sur un programme de logements neufs à ${city} recherche un sous-traitant peintre pour les finitions intérieures sur plusieurs lots livrés par tranches.`,
      `Programme immobilier neuf à ${city} : lot peinture/finitions à sous-traiter sur plusieurs logements, livraison par tranches successives.`,
    ],
    valueRange: [12000, 40000], deadlineDaysRange: [10, 25],
  },
  // --- Couverture ---
  {
    tradeSlug: 'couverture', journey: 'tender',
    titlePattern: (city) => `Réfection de toiture - bâtiment privé à ${city}`,
    paragraphs: [
      `Propriétaire privé à ${city} recherche une entreprise de couverture pour la réfection complète d'une toiture endommagée, avec reprise de la zinguerie.`,
      `Bâtiment privé à ${city} : consultation pour réfection de toiture (couverture et zinguerie) suite à un constat de dégradation.`,
    ],
    valueRange: [15000, 60000], deadlineDaysRange: [15, 30],
  },
  // --- Rénovation générale (batiment-general) ---
  {
    tradeSlug: 'batiment-general', journey: 'tender',
    titlePattern: (city) => `Rénovation complète de logements - ${city}`,
    paragraphs: [
      `Bailleur privé à ${city} lance une consultation pour la rénovation complète (tous corps d'état) d'un ensemble de logements avant relocation.`,
      `Ensemble de logements à ${city} : consultation privée tous corps d'état pour une rénovation complète avant remise en location.`,
    ],
    valueRange: [60000, 250000], deadlineDaysRange: [25, 45],
  },
  // --- Espaces verts ---
  {
    tradeSlug: 'espaces-verts', journey: 'tender',
    titlePattern: (city) => `Entretien espaces verts - résidence privée à ${city}`,
    paragraphs: [
      `Copropriété à ${city} recherche une entreprise de paysagisme pour un contrat annuel d'entretien des espaces verts (tonte, taille, entretien des massifs).`,
      `Résidence privée à ${city} : consultation pour un marché annuel d'entretien paysager des espaces verts communs.`,
    ],
    valueRange: [6000, 25000], deadlineDaysRange: [15, 30],
  },
  // --- Nettoyage ---
  {
    tradeSlug: 'nettoyage', journey: 'tender',
    titlePattern: (city) => `Contrat de nettoyage - immeuble de bureaux à ${city}`,
    paragraphs: [
      `Gestionnaire d'un immeuble de bureaux à ${city} recherche une société de nettoyage pour un contrat annuel d'entretien des parties communes et des bureaux.`,
      `Immeuble tertiaire à ${city} : consultation privée pour un marché annuel de nettoyage des locaux et parties communes.`,
    ],
    valueRange: [10000, 40000], deadlineDaysRange: [12, 25],
  },
  // --- Maintenance ---
  {
    tradeSlug: 'maintenance', journey: 'tender',
    titlePattern: (city) => `Contrat de maintenance multi-technique - résidence à ${city}`,
    paragraphs: [
      `Syndic à ${city} recherche un prestataire pour un contrat de maintenance multi-technique (ascenseurs, VMC, portails) sur une résidence privée.`,
      `Résidence privée à ${city} : consultation pour un marché de maintenance multi-technique annuel (équipements communs, VMC, portails automatiques).`,
    ],
    valueRange: [8000, 35000], deadlineDaysRange: [15, 30],
  },
];

// Small deterministic hash so the same (scenario,city) combination always
// gets the same phrasing/value/deadline on a re-run (needed for the
// ON CONFLICT DO NOTHING idempotency to make sense - re-running shouldn't
// look like it's "trying" different content for the same row).
function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) >>> 0; }
  return h;
}

function slugify(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

async function run() {
  const sourceRes = await db.query(`SELECT id FROM data_sources WHERE code = 'editorial_catalog'`);
  if (sourceRes.rows.length === 0) {
    throw new Error("data_sources row 'editorial_catalog' not found - deploy the database.ts migration first (or run npm run db:migrate).");
  }
  const sourceId = sourceRes.rows[0].id;

  if (CLEAN) {
    if (DRY_RUN) { logger.info('[SeedEditorialListings] --dry-run + --clean: would delete all rows for source_id=' + sourceId); return; }
    const result = await db.query(`DELETE FROM opportunities WHERE source_id = $1`, [sourceId]);
    logger.info(`[SeedEditorialListings] Deleted ${result.rowCount} editorial rows.`);
    return;
  }

  const tradeRes = await db.query(`SELECT id, slug FROM trades`);
  const tradeIdBySlug = new Map<string, number>(tradeRes.rows.map((r: any) => [r.slug, r.id]));
  const typeRes = await db.query(`SELECT id, code FROM opportunity_types`);
  const typeIdByCode = new Map<string, number>(typeRes.rows.map((r: any) => [r.code, r.id]));

  const missingTrades = [...new Set(SCENARIOS.map(s => s.tradeSlug))].filter(slug => !tradeIdBySlug.has(slug));
  if (missingTrades.length > 0) {
    throw new Error(`Missing trades in DB: ${missingTrades.join(', ')} - run the applyIncrementalMigrations step (deploy or npm run db:migrate) first.`);
  }

  // First-batch spread: 3 cities per scenario, picked deterministically per
  // scenario (not the same 3 every time) so coverage spreads across the
  // city list rather than clustering on Paris/Bordeaux for every trade.
  const CITIES_PER_SCENARIO = 3;

  let rows: any[] = [];
  for (const scenario of SCENARIOS) {
    const offset = hash(scenario.tradeSlug + scenario.journey + scenario.titlePattern('x')) % CITIES.length;
    for (let i = 0; i < CITIES_PER_SCENARIO; i++) {
      const city = CITIES[(offset + i * 7) % CITIES.length]; // step 7: spreads picks instead of walking sequentially
      const key = `${scenario.tradeSlug}-${scenario.journey}-${slugify(city.name)}`;
      const h = hash(key);
      const variant = scenario.paragraphs[h % 2];
      const [vMin, vMax] = scenario.valueRange;
      const value = vMin + (h % (vMax - vMin));
      const [dMin, dMax] = scenario.deadlineDaysRange;
      const deadlineDays = dMin + (h % (dMax - dMin));
      const title = scenario.titlePattern(city.name);

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
      });
    }
  }

  logger.info(`[SeedEditorialListings] Prepared ${rows.length} rows across ${SCENARIOS.length} scenarios.`);

  if (DRY_RUN) {
    for (const r of rows.slice(0, 10)) {
      logger.info(`  [DRY RUN] ${r.sourceRef} :: ${r.title} — ${r.value}€, échéance ~${r.deadlineDays}j`);
    }
    logger.info(`[SeedEditorialListings] --dry-run: ${rows.length} rows prepared, nothing written. (showing first 10 above)`);
    return;
  }

  const values: any[] = [];
  rows.forEach((r) => {
    values.push(
      sourceId, r.sourceRef, r.typeId, r.tradeId,
      r.title, r.description, r.deadlineDays, r.value, 'EUR',
      r.city, r.department, r.region,
      'active', 'classified',
      JSON.stringify([{ trade_id: r.tradeId, confidence: 1.0, reasoning: 'Assignation éditoriale directe (catalogue interne, pas de classification IA).' }]),
      'not_generated', 'no_documents_found',
    );
  });
  // 17 bound params per row (18 columns total; publication_date is a bare
  // NOW() with no param of its own, deadline's one param is deadlineDays):
  //  1 source_id, 2 source_reference, 3 opportunity_type_id, 4 trade_id,
  //  5 title, 6 description, 7 deadlineDays (used inside the deadline
  //  interval expression below), 8 estimated_value, 9 currency,
  //  10 location_city, 11 location_department, 12 location_region,
  //  13 status, 14 ai_classification_status, 15 ai_matched_trades,
  //  16 ai_summary_status, 17 dce_documents_status.
  const PARAMS_PER_ROW = 17;
  const placeholders = rows.map((_r, idx) => {
    const base = idx * PARAMS_PER_ROW;
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, NOW(), NOW() + ($${base + 7}::int * interval '1 day'), $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11}, $${base + 12}, $${base + 13}, $${base + 14}, $${base + 15}, $${base + 16}, $${base + 17})`;
  }).join(',\n');

  const result = await db.query(
    `INSERT INTO opportunities (
       source_id, source_reference, opportunity_type_id, trade_id,
       title, description, publication_date, deadline,
       estimated_value, currency, location_city, location_department, location_region,
       status, ai_classification_status, ai_matched_trades, ai_summary_status, dce_documents_status
     ) VALUES ${placeholders}
     ON CONFLICT (source_id, source_reference) DO NOTHING`,
    values
  );

  logger.info(`[SeedEditorialListings] Inserted ${result.rowCount} new rows (${rows.length - (result.rowCount || 0)} already existed - safe re-run).`);
  logger.info('[SeedEditorialListings] This is a first batch for review, not the full national catalog - see the header comment for scaling once validated.');
}

run()
  .then(() => process.exit(0))
  .catch(err => {
    logger.error('[SeedEditorialListings] Failed:', err);
    process.exit(1);
  });
