/**
 * scripts/generateSyntheticListings.js
 *
 * Generates synthetic opportunities for load testing (Technical Requirements
 * section 12: "Search performance must be measured against a test dataset of
 * at least one million synthetic listings").
 *
 * These are clearly-marked fake records (source_reference starts with
 * SYNTH-), never real tender data, and safe to bulk-delete afterwards.
 *
 * Usage:
 *   node scripts/generateSyntheticListings.js                 # 1,000,000 rows
 *   node scripts/generateSyntheticListings.js --count=50000    # smaller test run
 *   node scripts/generateSyntheticListings.js --clean          # delete all SYNTH- rows
 *
 * This only writes rows - it does not run or interpret the load test itself.
 * Run scripts/loadTest.js (or k6/autocannon directly) against a real deployed
 * API afterwards to actually measure search performance; generating the
 * dataset and measuring performance against it are two separate steps and
 * both need to be run against a real environment, not just written as code.
 */

require("dotenv").config();
const { Pool } = require("pg");

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  })
);

const TOTAL = parseInt(args.count || "1000000", 10);
const BATCH_SIZE = 2000;
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

const CITIES = [
  ["Paris", "75", "Ile-de-France"],
  ["Lyon", "69", "Auvergne-Rhone-Alpes"],
  ["Marseille", "13", "Provence-Alpes-Cote d'Azur"],
  ["Toulouse", "31", "Occitanie"],
  ["Nantes", "44", "Pays de la Loire"],
  ["Lille", "59", "Hauts-de-France"],
  ["Bordeaux", "33", "Nouvelle-Aquitaine"],
  ["Strasbourg", "67", "Grand Est"],
  ["Rennes", "35", "Bretagne"],
  ["Nimes", "30", "Occitanie"],
];

const CONTRACT_TYPES = ["service", "supply", "work"];
const TITLE_SUBJECTS = [
  "Renovation de batiment",
  "Entretien des espaces verts",
  "Travaux de voirie",
  "Maintenance electrique",
  "Construction d'ecole",
  "Refection de toiture",
  "Amenagement de bureaux",
  "Installation de chauffage",
  "Travaux de plomberie",
  "Peinture et finitions",
];

async function clean() {
  console.log("Deleting all synthetic (SYNTH-) opportunities...");
  const result = await pool.query(
    `DELETE FROM opportunities WHERE source_reference LIKE 'SYNTH-%'`
  );
  console.log(`Deleted ${result.rowCount} synthetic rows.`);
}

async function generate() {
  const source = await pool.query(`SELECT id FROM data_sources WHERE code = 'boamp' LIMIT 1`);
  if (source.rows.length === 0) {
    throw new Error("No 'boamp' data source found - run npm run db:migrate first.");
  }
  const sourceId = source.rows[0].id;

  const types = await pool.query(`SELECT id, code FROM opportunity_types`);
  const trades = await pool.query(`SELECT id FROM trades`);
  if (types.rows.length === 0 || trades.rows.length === 0) {
    throw new Error("No opportunity_types/trades found - run npm run db:migrate first.");
  }

  console.log(`Generating ${TOTAL} synthetic opportunities in batches of ${BATCH_SIZE}...`);
  const startedAt = Date.now();

  for (let offset = 0; offset < TOTAL; offset += BATCH_SIZE) {
    const rows = [];
    const batchCount = Math.min(BATCH_SIZE, TOTAL - offset);

    for (let i = 0; i < batchCount; i++) {
      const n = offset + i;
      const [city, dept, region] = CITIES[n % CITIES.length];
      const subject = TITLE_SUBJECTS[n % TITLE_SUBJECTS.length];
      const typeId = types.rows[n % types.rows.length].id;
      const tradeId = trades.rows[n % trades.rows.length].id;
      const contractType = CONTRACT_TYPES[n % CONTRACT_TYPES.length];
      const value = 5000 + (n % 500000);

      rows.push({
        sourceRef: `SYNTH-${n}`,
        typeId,
        tradeId,
        title: `${subject} - ${city} (lot synthetique ${n})`,
        description: `Enregistrement synthetique genere pour test de charge. Ville: ${city}. Objet: ${subject}.`,
        value,
        contractType,
        city,
        dept,
        region,
      });
    }

    // Multi-row INSERT built with numbered placeholders - far fewer round trips
    // than one INSERT per row, which is what makes generating a million rows
    // practical in a reasonable time.
    const cols = [
      "source_id", "source_reference", "opportunity_type_id", "trade_id",
      "title", "description", "publication_date", "deadline",
      "estimated_value", "currency", "contract_type",
      "location_city", "location_department", "location_region",
      "status", "ai_classification_status", "ai_summary_status",
    ];
    const values = [];
    const placeholders = rows
      .map((r, idx) => {
        const base = idx * (cols.length - 2); // publication_date/deadline use NOW()-based SQL, not params
        values.push(
          sourceId, r.sourceRef, r.typeId, r.tradeId,
          r.title, r.description,
          r.value, "EUR", r.contractType,
          r.city, r.dept, r.region,
          "active", "not_analyzed", "not_generated"
        );
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, NOW() - (random() * interval '60 days'), NOW() + (random() * interval '45 days'), $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11}, $${base + 12}, $${base + 13}, $${base + 14}, $${base + 15})`;
      })
      .join(",\n");

    await pool.query(
      `INSERT INTO opportunities (${cols.join(", ")}) VALUES ${placeholders}
       ON CONFLICT (source_id, source_reference) DO NOTHING`,
      values
    );

    if (offset % (BATCH_SIZE * 25) === 0) {
      const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
      console.log(`  ${offset + batchCount} / ${TOTAL} rows (${elapsedSec}s elapsed)`);
    }
  }

  const totalSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`Done: ${TOTAL} synthetic opportunities generated in ${totalSec}s.`);
  console.log(`Next: REFRESH MATERIALIZED VIEW opportunity_search_index (if in use), then run scripts/loadTest.js.`);
}

async function main() {
  await pool.query("SELECT NOW()");
  if (CLEAN) {
    await clean();
  } else {
    await generate();
  }
}

main()
  .catch((err) => {
    console.error("Failed:", err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
