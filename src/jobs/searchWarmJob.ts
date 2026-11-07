import { logger } from '../utils/logger';
import { warmSearch } from '../routes/opportunities';

// Préchauffage des recherches courantes (7 nov., avant la campagne pub). Toutes les 15 minutes, le serveur exécute
// lui-même, une par une et sans se presser, les recherches que les visiteurs font le plus (un métier sur toute la
// France, avec les totaux par type que la page demande), exactement avec les paramètres du site : les caches de
// routes/opportunities.ts (20 min) sont donc toujours chauds et une rafale de visiteurs ne sollicite pas la base.
const KEYWORDS = ['plomberie', 'electricite', 'climatisation', 'chauffage', 'couverture', 'menuiserie', 'peinture', 'maconnerie', 'carrelage',
  'isolation', 'platrerie', 'nettoyage', 'espaces verts', 'vrd', 'demolition', 'charpente', 'gros oeuvre', 'serrurerie', 'etancheite', 'ravalement', 'terrassement'];
const JOURNEYS = ['public_procurement', 'tender', 'subcontracting'];
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
let running = false;

export async function runSearchWarm(): Promise<void> {
  if (running) return; running = true;
  const t0 = Date.now(); let n = 0, ko = 0;
  try {
    for (const q of KEYWORDS) {
      const base = { q, status: 'active', loc: '2' };
      if (!(await warmSearch({ ...base, limit: '40' }))) ko++; n++;
      for (const j of JOURNEYS) { if (!(await warmSearch({ ...base, journey: j, limit: '1' }))) ko++; n++; await pause(150); }
      await pause(300);
    }
    logger.info(`[préchauffage] ${n} recherches en ${Math.round((Date.now() - t0) / 1000)} s${ko ? `, ${ko} en échec` : ''}`);
  } catch (err) { logger.error('[préchauffage] échec :', err); }
  finally { running = false; }
}

export const startSearchWarmJob = () => {
  setTimeout(() => { runSearchWarm().catch(() => {}); }, 60_000);
  setInterval(() => { runSearchWarm().catch(() => {}); }, 15 * 60_000);
  logger.info('✅ Préchauffage des recherches programmé (1 min après le démarrage, puis toutes les 15 min)');
};
