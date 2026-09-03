import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import path from 'path';

import { db, ensureSchema } from './config/database';
import { logger } from './utils/logger';
import { errorHandler } from './middleware/errorHandler';
import { authenticate } from './middleware/auth';

// Load environment variables
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

// Initialize Express app
const app: Express = express();
const PORT = process.env.PORT || 5000;

// Render (and most PaaS hosts) sit behind a reverse proxy, so the real
// client IP arrives in the X-Forwarded-For header rather than the raw
// socket address. Without this, Express doesn't trust that header, which
// makes express-rate-limit unable to tell requests apart by IP - it logs
// an ERR_ERL_UNEXPECTED_X_FORWARDED_FOR warning and, depending on version,
// can fall back to lumping every visitor behind the proxy into the same
// rate-limit bucket. That's a plausible reason signup ("too many
// requests") could fail even for a person's very first attempt: someone
// else's earlier attempts already used up the shared bucket.
// "1" = trust exactly one hop of proxy, which matches Render's setup.
app.set('trust proxy', 1);

// ============================================================================
// MIDDLEWARE SETUP
// ============================================================================

// Security
app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true,
  optionsSuccessStatus: 200,
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.',
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5, // limit login attempts
  skipSuccessfulRequests: true,
});

app.use('/api/', limiter);
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);

// Logging
app.use(morgan('combined', { stream: { write: msg => logger.info(msg.trim()) } }));

// Body parsing
// IMPORTANT: the Stripe webhook route needs the raw, unparsed request body to
// verify the webhook signature (stripe.webhooks.constructEvent). It must get
// express.raw() BEFORE the global express.json() below runs, or Stripe's
// signature check will always fail (a JSON-reparsed body has different bytes
// than what Stripe originally signed) - this previously broke the whole
// webhook silently, since every webhook call would 400 with "Webhook error".
app.use('/api/subscriptions/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// Request ID tracking
app.use((req: Request, res: Response, next: NextFunction) => {
  req.id = require('uuid').v4();
  res.setHeader('X-Request-ID', req.id as string);
  next();
});

// ============================================================================
// ROUTES
// ============================================================================

// Health check
app.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date() });
});

// Public routes
app.use('/api/auth', require('./routes/auth').default);
app.use('/api/opportunities', require('./routes/opportunities').default);
app.use('/api/trades', require('./routes/trades').default);
app.use('/api/brands', require('./routes/brandsPublic').default);
app.use('/api/seo-pages', require('./routes/seoPagesPublic').default);
app.use('/api/subscriptions', require('./routes/subscriptions').default);
// Browsing subcontracting needs is public (mirrors opportunities); creating
// one requires an account, enforced per-route inside the router itself.
app.use('/api/subcontract-needs', require('./routes/subcontractNeeds').default);
// CRM lead capture must be public: it's submitted from anonymous marketing
// pages (pricing page, contact form) before someone has an account.
// Admin viewing/managing of captured leads stays behind authenticate below.
app.use('/api/crm/leads', require('./routes/crmPublic').default);
app.use('/api/visitor-events', require('./routes/visitorEvents').default);
app.use('/api/siret', require('./routes/siret').default);

// Protected routes (require authentication)
app.use('/api/companies', authenticate, require('./routes/companies').default);
app.use('/api/uploads', authenticate, require('./routes/uploads').default);
// Serves files saved by the local-disk storage fallback (storageService.ts).
// No-op / unused when AWS_S3_BUCKET is configured, since files then live in S3.
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));
app.use('/api/dashboard', authenticate, require('./routes/dashboard').default);
app.use('/api/tenders', authenticate, require('./routes/tenders').default);
app.use('/api/alerts', authenticate, require('./routes/alerts').default);
app.use('/api/favorites', authenticate, require('./routes/favorites').default);
app.use('/api/chatbot', authenticate, require('./routes/chatbot').default);
app.use('/api/documents', authenticate, require('./routes/documents').default);
app.use('/api/crm', authenticate, require('./routes/crm').default);

// Admin routes
app.use('/api/admin', authenticate, require('./routes/admin').default);

// ============================================================================
// ERROR HANDLING
// ============================================================================

// 404 handler
app.use((req: Request, res: Response) => {
  res.status(404).json({
    error: 'Not found',
    path: req.path,
    method: req.method,
  });
});

// Global error handler (must be last)
app.use(errorHandler);

// ============================================================================
// DATABASE & SERVER STARTUP
// ============================================================================

const startServer = async () => {
  try {
    // Test database connection
    await db.query('SELECT NOW()');
    logger.info('✅ Database connected successfully');

    // Auto-load schema.sql if this is a fresh/empty database (e.g. brand new
    // Supabase project) — no manual psql step required.
    await ensureSchema();

    // Auto-run the demo-data seed script (scripts/seed.js) on every boot,
    // same reasoning as ensureSchema() above: on Render's free tier there's
    // no shell to run `npm run db:seed` by hand, so it has to happen as
    // part of the normal deploy/restart. Fully idempotent (every insert is
    // ON CONFLICT ... DO UPDATE keyed on a fixed source_reference/email),
    // so running it again on every restart just re-confirms the same rows
    // rather than duplicating them - safe to leave on by default. Spawned
    // as a child process (own Pool, own exit) rather than require()'d
    // in-process, so it can't call pool.end() on the main app's connection
    // pool. Set SKIP_DEMO_SEED=true to turn this off later (e.g. closer to
    // a real launch, once DEMO-* listings shouldn't appear next to live
    // BOAMP/DECP data for real visitors).
    if (process.env.SKIP_DEMO_SEED !== 'true') {
      const { execFile } = require('child_process');
      const seedScriptPath = require('path').resolve(process.cwd(), 'scripts', 'seed.js');
      execFile('node', [seedScriptPath], (err: any, stdout: string, stderr: string) => {
        if (stdout) logger.info(`[demo seed] ${stdout.trim()}`);
        if (err) {
          // Non-fatal: the server must still come up even if seeding fails
          // (e.g. a transient DB hiccup) - this is demo convenience data,
          // never a requirement for the app to function.
          logger.error('[demo seed] failed (non-fatal):', stderr || err.message);
        }
      });
    }

    // Start background jobs
    require('./jobs/dataCollection').startScheduledJobs();
    require('./jobs/documentIngestion').startDocumentIngestion();
    require('./jobs/documentExpiry').startExpiryCheck();
    require('./jobs/seoGeneration').startSEOGeneration();
    require('./jobs/backupManagement').startBackupSchedule();
    require('./jobs/searchIndexRefresh').startSearchIndexRefresh();
    require('./jobs/factsBackfillJob').startFactsBackfillJob();
    require('./jobs/aiProcessing').startAIProcessing();
    require('./jobs/opportunityAlerts').startOpportunityAlerts();
    require('./jobs/crmRetry').startCrmRetrySchedule();

    // Start server
    const server = app.listen(PORT, () => {
      logger.info(`🚀 Server running on http://localhost:${PORT}`);
      logger.info(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
      logger.info(`🎨 Frontend URL: ${process.env.FRONTEND_URL}`);
    });

    // Graceful shutdown - was previously registered outside startServer()
    // and called db.end() (closing the pg pool) immediately on SIGTERM,
    // with no server.close() first. Render sends SIGTERM on every deploy
    // and every free-tier spin-down, so any request still in flight at that
    // exact instant (auth middleware's user lookup, a cron job's query,
    // etc.) hit the DB *after* the pool was already ended - "Cannot use a
    // pool after calling end on the pool", visible as request failures on
    // every single redeploy. Now: stop accepting new connections, let
    // in-flight ones finish, only then close the pool - with a hard-exit
    // fallback in case something never finishes, so a deploy can't hang
    // forever either.
    const shutdown = (signal: string) => {
      logger.info(`${signal} received, shutting down gracefully...`);
      const forceExit = setTimeout(() => {
        logger.warn('Graceful shutdown timed out after 10s, forcing exit.');
        process.exit(1);
      }, 10_000);
      forceExit.unref();

      server.close(async (err) => {
        if (err) logger.error('Error while closing HTTP server:', err);
        try {
          await db.end();
        } catch (dbErr) {
          logger.error('Error while closing DB pool:', dbErr);
        }
        clearTimeout(forceExit);
        process.exit(0);
      });
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (err) {
    logger.error('❌ Failed to start server:', err);
    process.exit(1);
  }
};

// Start server
startServer();

export default app;
