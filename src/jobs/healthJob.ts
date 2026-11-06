import { logger } from '../utils/logger';
import { snapshotHealth } from '../services/healthService';

// Contrôle de toute la chaîne chaque matin à 7 h 10 (heure de Paris) et toutes les 6 heures, plus une fois au démarrage.
// Lecture seule : il mesure et garde un instantané par jour ; il n'envoie rien (le canal d'alerte reste à choisir).
export function startHealthJob(): void {
  const cron = require('node-cron');
  const run = () => snapshotHealth().catch(e => logger.warn('[Santé] contrôle impossible:', e?.message));
  cron.schedule('10 7 * * *', run, { timezone: 'Europe/Paris' });
  cron.schedule('40 */6 * * *', run);
  setTimeout(run, 120000).unref?.();
}
