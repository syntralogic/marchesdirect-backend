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
  // Even ADD COLUMN IF NOT EXISTS takes a strong table lock. On restart,
  // inspect first so an already installed migration never queues that lock.
  const state = (await db.query(`SELECT
    EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='opportunities' AND column_name='search_text') AS col,
    EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.opportunities'::regclass AND tgname='opportunities_search_text') AS trg,
    to_regclass('public.opportunities_search_text_todo') IS NOT NULL AS todo`)).rows[0];
  if (state?.col && state?.trg && state?.todo) return;
  const client = await db.getClient();
  try {
    await client.query(`SET lock_timeout = '2s'`);
    if (!state?.col) await client.query(`ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS search_text TEXT`);
    if (!state?.trg) {
      await client.query(`CREATE OR REPLACE FUNCTION opportunities_search_text_trg() RETURNS trigger AS $$
        BEGIN NEW.search_text := ${SEARCH_TEXT_EXPR.replace(/\btitle\b/g, 'NEW.title').replace(/\bdescription\b/g, 'NEW.description')}; RETURN NEW; END $$ LANGUAGE plpgsql SET search_path = public, pg_temp`);
      await client.query(`CREATE TRIGGER opportunities_search_text BEFORE INSERT OR UPDATE OF title, description ON opportunities
        FOR EACH ROW EXECUTE FUNCTION opportunities_search_text_trg()`);
    }
    if (!state?.todo) await client.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS opportunities_search_text_todo ON opportunities (id) WHERE search_text IS NULL`);
  } finally {
    try { await client.query('RESET lock_timeout'); } finally { client.release(); }
  }
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
export const searchTextReady = () => cached('search_text:ready', 60_000, async () => {
  try {
    const r = await db.query(`SELECT EXISTS(SELECT 1 FROM opportunities WHERE search_text IS NULL LIMIT 1) AS pending`);
    return !r.rows[0]?.pending && await indexValid();
  } catch { return false; } // Cache the fallback too while a migration is starting.
});

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
    // Statistiques de la nouvelle colonne pour le planificateur (sans ANALYZE, il n'a aucune estimation et peut
    // préférer une lecture complète à l'index). Rapide, non bloquant.
    await db.query('ANALYZE opportunities');
    logger.info('[search_text] prêt : colonne complète, index valide, statistiques à jour');
  } catch (err) { logger.error('[search_text] échec (reprise au prochain démarrage) :', err); }
  finally { running = false; }
}

export const startSearchTextJob = () => {
  setTimeout(() => { runSearchTextJob().catch(() => {}); }, 40_000);
  logger.info('✅ search_text : remplissage et index programmés (40 s après le démarrage)');
};

