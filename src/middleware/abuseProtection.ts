import { Express, Request, Response, NextFunction, json, urlencoded } from 'express';
import rateLimit from 'express-rate-limit';
import { verifyPrivateFilePath } from '../utils/privateFileLinks';

const write = (req: Request) => !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
const message = { error: 'too_many_requests', message: 'Trop de demandes rapprochées. Réessayez dans quelques instants.' };

export function installAbuseProtection(app: Express): void {
  const forms = ['/api/crm/leads', '/api/needs', '/api/members', '/api/listing-reports',
    '/api/alert-subscriptions', '/api/siret/lead', '/api/siret/alert', '/api/subcontract-needs'];
  app.use(forms, rateLimit({ windowMs: 15 * 60 * 1000, max: 20, skip: req => !write(req),
    standardHeaders: 'draft-7', legacyHeaders: false, message }));
  // Parse small public forms before the more permissive admin JSON parser.
  app.use(forms, json({ limit: '64kb' }), urlencoded({ limit: '64kb', extended: false, parameterLimit: 100 }));
  app.use(['/api/siret/phone/verification/request', '/api/siret/phone/verification/confirm', '/api/auth/complete-signup'],
    rateLimit({ windowMs: 15 * 60 * 1000, max: 15, skip: req => !write(req),
      standardHeaders: 'draft-7', legacyHeaders: false, message }));
  app.use('/api/uploads', rateLimit({ windowMs: 15 * 60 * 1000, max: 30, skip: req => !write(req),
    standardHeaders: 'draft-7', legacyHeaders: false, message }));
  app.use(['/api/siret/lookup', '/api/siret/confirm'], rateLimit({ windowMs: 15 * 60 * 1000, max: 30,
    skip: req => !write(req), standardHeaders: 'draft-7', legacyHeaders: false, message }));
  app.use('/api/opportunities', rateLimit({ windowMs: 60_000, max: 90,
    skip: req => req.method !== 'GET' || !['/', '/ranked/candidates'].includes(req.path),
    standardHeaders: 'draft-7', legacyHeaders: false, message }));
}

// Diagnostic requests may bypass ordinary caches and expose query plans.
// Authenticate before reaching the search handler, not after executing SQL.
export function requireDiagnosticAccess(req: Request, res: Response, next: NextFunction): void {
  if (req.query.q !== undefined && (typeof req.query.q !== 'string' || req.query.q.length > 256)) {
    res.status(400).json({ error: 'invalid_search', message: 'Limitez votre recherche à 256 caractères.' });
    return;
  }
  if (req.query.explain !== undefined) { res.status(404).json({ error: 'not_found' }); return; } // diagnostic retiré (7 nov.)
  next();
}

export function protectLocalFiles(req: Request, res: Response, next: NextFunction): void {
  if (/^\/avatars\/[a-zA-Z0-9_-]+\/avatar\.(jpg|png|webp)$/.test(req.path)) return next();
  if (!verifyPrivateFilePath(`/uploads${req.path}`, req.query.expires, req.query.signature)) {
    res.status(403).json({ error: 'file_link_invalid', message: 'Ce lien a expiré. Rouvrez le document depuis votre espace.' });
    return;
  }
  res.set('Cache-Control', 'private, no-store');
  res.set('Content-Disposition', 'attachment');
  next();
}
