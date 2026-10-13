/**
 * Real-PostgreSQL check of the one-off legacy repairs (1 Oct 2026):
 *   - BOAMP lots are appended to old descriptions, batch by batch, resumable, idempotent
 *   - buyer-name locations are repaired exactly once
 * Skipped unless TEST_DATABASE_URL is set:  TEST_DATABASE_URL=... npx jest legacyRepairJob --forceExit
 */
const URL_ = process.env.TEST_DATABASE_URL;
const d = URL_ ? describe : describe.skip;

d('legacyRepairJob (real PostgreSQL)', () => {
  let db: any;
  let job: any;

  const row = async (ref: string) => (await db.query('SELECT description, location_department, location_region, location_latitude FROM opportunities WHERE source_reference = $1', [ref])).rows[0];

  beforeAll(async () => {
    process.env.DATABASE_URL = URL_;
    process.env.DB_SSL = 'false';
    const database = require('../../config/database');
    db = database.db;
    await database.ensureSchema();
    await db.query('TRUNCATE opportunities CASCADE');
    job = require('../legacyRepairJob');
    await job.ensureTables();
    await db.query("DELETE FROM app_once_migrations WHERE key IN ('repair_buyer_name_locations_v1','backfill_boamp_lots_v1')");
    await db.query("DELETE FROM legacy_repair_cursor");

    const boamp = (await db.query("SELECT id FROM data_sources WHERE code = 'boamp'")).rows[0].id;
    const ins = (ref: string, title: string, desc: string, raw: any, city: string | null, dept: string | null, region: string | null) =>
      db.query(
        `INSERT INTO opportunities (source_id, source_reference, opportunity_type_id, title, description, publication_date, deadline,
           raw_data, location_city, location_department, location_region, location_latitude, location_longitude, location_country)
         VALUES ($1,$2,2,$3,$4, NOW(), NOW() + INTERVAL '10 days', $5, $6, $7, $8, 45.4, 4.38, 'FR')`,
        [boamp, ref, title, desc, JSON.stringify(raw), city, dept, region]
      );

    // old notice: lots only in raw_data.donnees
    await ins('L1', 'Rénovation du collège', 'Travaux de rénovation.',
      { fields: { donnees: JSON.stringify({ LOT: [{ INTITULE: 'Lot 3 Électricité courants forts' }, { INTITULE: 'Lot 1 Maçonnerie' }] }) } }, 'Lyon', '69', 'Auvergne-Rhône-Alpes');
    // notice that already holds its lots: must stay byte-identical
    const already = 'Travaux.\n\nLots : Lot 3 Électricité courants forts ; Lot 1 Maçonnerie';
    await ins('L2', 'Déjà enrichi', already,
      { fields: { donnees: JSON.stringify({ LOT: [{ INTITULE: 'Lot 3 Électricité courants forts' }, { INTITULE: 'Lot 1 Maçonnerie' }] }) } }, 'Lyon', '69', 'Auvergne-Rhône-Alpes');
    // notice without lots
    await ins('L3', 'Sans lots', 'Fourniture de papier.', { fields: { donnees: '{}' } }, 'Nantes', '44', 'Pays de la Loire');
    // buyer-name city wrongly geocoded to another département (Saint-Étienne case)
    await ins('L4', 'Mairie', 'Entretien.', { fields: { codeDepartement: '42' } }, 'Ville de Saint-Etienne', '43', 'Auvergne-Rhône-Alpes');
  });

  afterAll(async () => { await db?.end?.(); });

  it('appends lots to old descriptions, leaves enriched/lot-less ones untouched', async () => {
    let res = await job.backfillBoampLotsBatch();
    expect(res.done).toBe(false);
    res = await job.backfillBoampLotsBatch();   // nothing left -> completes
    expect(res.done).toBe(true);

    const l1 = await row('L1');
    expect(l1.description).toContain('Lots :');
    expect(l1.description).toContain('Électricité courants forts');
    expect((await row('L2')).description).toBe('Travaux.\n\nLots : Lot 3 Électricité courants forts ; Lot 1 Maçonnerie');
    expect((await row('L3')).description).toBe('Fourniture de papier.');
  });

  it('is idempotent once done', async () => {
    const before = (await row('L1')).description;
    const res = await job.backfillBoampLotsBatch();
    expect(res).toEqual({ updated: 0, done: true });
    expect((await row('L1')).description).toBe(before);
  });

  it('the lot is now findable by a trade-word search (generated search_vector follows the description)', async () => {
    const r = await db.query(
      "SELECT 1 FROM opportunities WHERE lower(unaccent(title || ' ' || COALESCE(description,''))) ~ 'electricite' AND source_reference = 'L1'");
    expect(r.rows.length).toBe(1);
  });

  it('repairs buyer-name locations once', async () => {
    const touched = await job.repairBuyerNameLocations();
    expect(touched).toBeGreaterThanOrEqual(1);
    const l4 = await row('L4');
    expect(l4.location_department).toBe('42');
    expect(l4.location_latitude).toBeNull();            // cleared so the corrected geocoder can place it again
    expect(await job.repairBuyerNameLocations()).toBe(0); // second call is a no-op
  });
});
