import { logger } from '../utils/logger';
import { refreshOpenFollowups } from '../services/dossierFollowupService';

// Relit toutes les 10 minutes l'étape HubSpot des dossiers confiés (pipeline « Dossiers en cours »).
// Le serveur peut dormir (Render) : la page client relit aussi à la demande (routes/suivi.ts).
export function startDossierFollowupJob(): void {
  const cron = require('node-cron');
  const run = () => refreshOpenFollowups()
    .then(n => { if (n) logger.info(`[Suivi] ${n} étape(s) de dossier mise(s) à jour depuis HubSpot`); })
    .catch(e => logger.warn('[Suivi] relecture périodique impossible:', e?.message));
  cron.schedule('*/10 * * * *', run);
  setTimeout(run, 30000).unref?.();
}
