import { db } from '../config/database';
import { logger } from '../utils/logger';
import { cached } from '../utils/ttlCache';

// Texte de recherche normalisé (7 nov., recherche à 1-2 s après les premières corrections) : la base recalculait
// lower(immutable_unaccent(titre || description)) pour chaque annonce retenue par les index, à chaque recherche (la
// vérification après lecture d'index). Le texte normalisé est désormais stocké une fois (colonne search_text, tenue à
// jour par déclencheur), rempli par lots en arrière-plan, puis indexé (trigramme, CONCURRENTLY : aucun blocage).
// La recherche bascule d'elle-même sur la colonne quand elle est complète et indexée (searchTextReady), et revient à
// l'expression si ce n'est pas le cas : aucune annonce ne peut être manquée pendant la transition.
export const SEARCH_TEXT_EXPR = `lower(immutable_unaccent(COALESCE(title, '') || ' ' || COALESCE(description, '')))`;
const INDEX = 'opportunities_search_text_trgm';
let running = false;

export async function ensureSearchTextSchema(): Promise<void> {
  await db.query(`ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS search_text TEXT`);
  await db.query(`CREATE OR REPLACE FUNCTION opportunities_search_text_trg() RETURNS trigger AS $$
    BEGIN NEW.search_text := ${SEARCH_TEXT_EXPR.replace(/\btitle\b/g, 'NEW.title').replace(/\bdescription\b/g, 'NEW.description')}; RETURN NEW; END $$ LANGUAGE plpgsql`);
  await db.query(`DROP TRIGGER IF EXISTS opportunities_search_text ON opportunities`);
  await db.query(`CREATE TRIGGER opportunities_search_text BEFORE INSERT OR UPDATE OF title, description ON opportunities
    FOR EACH ROW EXECUTE FUNCTION opportunities_search_text_trg()`);
  // Index partiel pour trouver vite ce qui reste à remplir, sans relire la table à chaque lot.
  await db.query(`CREATE INDEX IF NOT EXISTS opportunities_search_text_todo ON opportunities (id) WHERE search_text IS NULL`);
}

export async function runSearchTextBatch(limit = 3000): Promise<number> {
  const r = await db.query(`UPDATE opportunities o SET search_text = ${SEARCH_TEXT_EXPR.replace(/\b(title|description)\b/g, 'o.$1')}
    WHERE o.id IN (SELECT id FROM opportunities WHERE search_text IS NULL LIMIT $1)`, [limit]);
  return r.rowCount || 0;
}

async function remaining(): Promise<number> {
  return Number((await db.query(`SELECT COUNT(*)::int AS n FROM opportunities WHERE search_text IS NULL`)).rows[0]?.n || 0);
}

async function indexValid(): Promise<boolean> {
  const r = await db.query(`SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = $1`, [INDEX]);
  return !!r.rows[0]?.indisvalid;
}

async function buildIndex(): Promise<void> {
  const r = await db.query(`SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = $1`, [INDEX]);
  if (r.rows[0]?.indisvalid) return;
  if (r.rows.length) await db.query(`DROP INDEX IF EXISTS ${INDEX}`);
  const client = await db.getClient();
  try {
    await client.query('SET statement_timeout = 0');
    logger.info(`[search_text] construction de ${INDEX} en arrière-plan…`);
    await client.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${INDEX} ON opportunities USING GIN (search_text gin_trgm_ops)`);
    logger.info(`[search_text] ${INDEX} prêt`);
  } finally { try { await client.query('RESET statement_timeout'); } catch { /* connexion rendue */ } client.release(); }
}

/** Vrai quand la colonne est complète et indexée : la recherche peut lire o.search_text. Vérifié toutes les 60 s. */
export const searchTextReady = () => cached('search_text:ready', 60_000, async () => (await remaining()) === 0 && (await indexValid())).catch(() => false);

export async function runSearchTextJob(): Promise<void> {
  if (running) return; running = true;
  try {
    await ensureSearchTextSchema();
    let left = await remaining(); let done = 0;
    while (left > 0) {
      done += await runSearchTextBatch();
      left = await remaining();
      if (done % 30000 < 3000) logger.info(`[search_text] ${done} annonces remplies, ${left} restantes`);
      await new Promise(r => setTimeout(r, 200)); // laisse respirer les requêtes des visiteurs
    }
    await buildIndex();
  } catch (err) { logger.error('[search_text] échec (reprise au prochain démarrage) :', err); }
  finally { running = false; }
}

export const startSearchTextJob = () => {
  setTimeout(() => { runSearchTextJob().catch(() => {}); }, 40_000);
  logger.info('✅ search_text : remplissage et index programmés (40 s après le démarrage)');
};
