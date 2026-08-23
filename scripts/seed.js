/**
 * scripts/seed.js
 *
 * Inserts a small set of demo data so the app is browsable end-to-end
 * (homepage 3-way entry -> search -> detail, plus a login) before the live
 * BOAMP/PLACE/TED connectors have produced real data. This is NOT a
 * substitute for milestone 2/3 proof (real connector runs, real dedup at
 * scale) - it only unblocks demoing the milestone 4/5/8 UI flows.
 *
 * Safe to run multiple times: every insert is keyed on a fixed
 * source_reference / email so re-running just updates the same rows instead
 * of duplicating them (ON CONFLICT ... DO UPDATE).
 *
 * Usage:
 *   node scripts/seed.js
 *   npm run db:seed
 */

require("dotenv").config();
const bcrypt = require("bcryptjs");
const { Pool } = require("pg");

const connectionString = process.env.DATABASE_URL;

const pool = connectionString
  ? new Pool({
      connectionString,
      ssl: process.env.DB_SSL === "false" ? false : { rejectUnauthorized: false },
    })
  : new Pool({
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      host: process.env.DB_HOST,
      port: parseInt(process.env.DB_PORT || "5432", 10),
      database: process.env.DB_NAME,
      ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : false,
    });

// One demo listing per journey type, loosely modeled on the kind of records
// the real BOAMP/PLACE connectors will eventually produce (same columns,
// same opportunity_type_id lookup by code) - not fictionalized as "real"
// tenders, source_reference is clearly marked DEMO-*.
const demoOpportunities = [
  {
    sourceRef: "DEMO-PUB-1",
    typeCode: "public_procurement",
    tradeSlug: "vrd",
    title: "Entretien des espaces verts departementaux",
    description:
      "Entretien regulier des espaces verts, debroussaillement, taille, tonte et evacuation des dechets verts sur plusieurs sites departementaux.",
    city: "Nimes",
    department: "30",
    region: "Occitanie",
    value: 180000,
    contractType: "service",
  },
  {
    sourceRef: "DEMO-PUB-2",
    typeCode: "public_procurement",
    tradeSlug: "batiment-general",
    title: "Renovation energetique d'une ecole",
    description: "Renovation energetique complete d'un groupe scolaire : isolation, menuiseries, chauffage.",
    city: "Montpellier",
    department: "34",
    region: "Occitanie",
    value: 420000,
    contractType: "work",
  },
  {
    sourceRef: "DEMO-PUB-3",
    typeCode: "public_procurement",
    tradeSlug: "electricite",
    title: "Maintenance des installations electriques",
    description: "Maintenance preventive et curative des installations electriques de plusieurs batiments publics.",
    city: "Avignon",
    department: "84",
    region: "Provence-Alpes-Cote d'Azur",
    value: 95000,
    contractType: "service",
  },
  {
    sourceRef: "DEMO-TEN-1",
    typeCode: "tender",
    tradeSlug: "batiment-general",
    title: "Renovation complete de 18 logements",
    description: "Coordination de la renovation interieure de 18 logements : peinture, sols, plomberie, electricite et finitions.",
    city: "Lyon",
    department: "69",
    region: "Auvergne-Rhone-Alpes",
    value: 680000,
    contractType: "work",
  },
  {
    sourceRef: "DEMO-TEN-2",
    typeCode: "tender",
    tradeSlug: "gros-oeuvre",
    title: "Construction d'une plateforme logistique",
    description: "Gros oeuvre pour la construction d'une plateforme logistique neuve.",
    city: "Valence",
    department: "26",
    region: "Auvergne-Rhone-Alpes",
    value: 1250000,
    contractType: "work",
  },
  {
    sourceRef: "DEMO-TEN-3",
    typeCode: "tender",
    tradeSlug: "platrerie",
    title: "Remise en etat de bureaux tertiaires",
    description: "Second oeuvre pour la remise en etat de plateaux de bureaux avant relocation.",
    city: "Grenoble",
    department: "38",
    region: "Auvergne-Rhone-Alpes",
    value: 210000,
    contractType: "work",
  },
  {
    sourceRef: "DEMO-SUB-1",
    typeCode: "subcontracting",
    tradeSlug: "peinture",
    title: "Peinture interieure - chantier de 18 logements",
    description: "Lot peinture a sous-traiter sur un chantier de renovation de logements collectifs.",
    city: "Lyon",
    department: "69",
    region: "Auvergne-Rhone-Alpes",
    value: 45000,
    contractType: "work",
  },
];

async function main() {
  await pool.query("SELECT NOW()");
  console.log("Connected to database.");

  const brand = await pool.query(`SELECT id FROM brands WHERE code = 'brand_1' LIMIT 1`);
  if (brand.rows.length === 0) {
    throw new Error("No brand found - run schema.sql / npm run db:migrate first.");
  }
  const brandId = brand.rows[0].id;

  const source = await pool.query(`SELECT id FROM data_sources WHERE code = 'boamp' LIMIT 1`);
  const sourceId = source.rows[0].id;

  console.log(`Seeding ${demoOpportunities.length} demo opportunities...`);
  for (const o of demoOpportunities) {
    await pool.query(
      `INSERT INTO opportunities (
         source_id, source_reference, opportunity_type_id, trade_id,
         title, description, publication_date, deadline,
         estimated_value, currency, contract_type,
         location_city, location_department, location_region,
         status, ai_classification_status, ai_summary_status
       ) VALUES (
         $1, $2,
         (SELECT id FROM opportunity_types WHERE code = $3),
         (SELECT id FROM trades WHERE slug = $4),
         $5, $6, NOW(), NOW() + INTERVAL '21 days',
         $7, 'EUR', $8,
         $9, $10, $11,
         'active', 'not_analyzed', 'not_generated'
       )
       ON CONFLICT (source_id, source_reference) DO UPDATE SET
         title = EXCLUDED.title,
         description = EXCLUDED.description,
         updated_at = CURRENT_TIMESTAMP`,
      [
        sourceId,
        o.sourceRef,
        o.typeCode,
        o.tradeSlug,
        o.title,
        o.description,
        o.value,
        o.contractType,
        o.city,
        o.department,
        o.region,
      ]
    );
  }

  console.log("Seeding demo company + user (demo@marchesdirect.fr / DemoPass123!)...");
  const passwordHash = await bcrypt.hash("DemoPass123!", 10);

  const companyResult = await pool.query(
    `INSERT INTO companies (
       brand_id, name, slug, email, legal_form, industry_sector,
       employee_count, subscription_status, subscription_tier,
       working_radius_km, status, verified, is_test_account
     ) VALUES (
       $1, 'Entreprise Demo', 'entreprise-demo', 'demo@marchesdirect.fr', 'SARL', 'construction',
       8, 'trial', 'free',
       50, 'active', true, true
     )
     ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [brandId]
  );
  const companyId = companyResult.rows[0].id;

  await pool.query(
    `INSERT INTO users (company_id, email, password_hash, first_name, last_name, role, email_verified, status)
     VALUES ($1, 'demo@marchesdirect.fr', $2, 'Demo', 'Utilisateur', 'user', true, 'active')
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
    [companyId, passwordHash]
  );

  console.log("Seed complete.");
}

main()
  .catch((err) => {
    console.error("Seed failed:", err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
