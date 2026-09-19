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
import { drainActiveJobs } from './utils/jobTracker';
import { authenticate, optionalAuth } from './middleware/auth';
import { isVerificationRequired } from './services/phoneVerificationService';
import { isSmsConfigured } from './services/smsService';

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

// CORS - was a single hardcoded origin (FRONTEND_URL), which only ever
// allowed one domain. That was already wrong the moment the second brand
// (Milestone 10 - multi-brand duplication, see brandResolution.ts) went
// live on its own domain: any browser request from that second domain
// would fail CORS before ever reaching the app, breaking the whole site
// for that brand while the primary brand's domain kept working fine (so
// this would not have shown up testing against the main domain alone).
// Now allowed origins are FRONTEND_URL + every domain configured in the
// brands table (same table brandResolution.ts already treats as the
// single source of truth for "which domains this backend serves"), so a
// new brand's domain, once added via the admin CRUD, is automatically
// allowed here too - no separate env var to remember to update.
// Cached for 5 minutes rather than querying brands on every single
// request/preflight; a newly-added domain becomes valid within that window.
let cachedBrandDomains: string[] = [];
let brandDomainsCacheExpiresAt = 0;
const BRAND_DOMAINS_CACHE_TTL_MS = 5 * 60 * 1000;

const getAllowedBrandDomains = async (): Promise<string[]> => {
  if (Date.now() < brandDomainsCacheExpiresAt) return cachedBrandDomains;
  try {
    const result = await db.query('SELECT domain FROM brands WHERE domain IS NOT NULL');
    cachedBrandDomains = result.rows.map((r: { domain: string }) => r.domain).filter(Boolean);
  } catch (err) {
    // DB hiccup: keep serving the last known-good list rather than an
    // empty one, which would lock every brand out of CORS at once.
    logger.error('Failed to refresh CORS-allowed brand domains, keeping previous list:', err);
  }
  brandDomainsCacheExpiresAt = Date.now() + BRAND_DOMAINS_CACHE_TTL_MS;
  return cachedBrandDomains;
};

app.use(cors({
  origin: async (origin, callback) => {
    // No Origin header at all = same-origin navigation, curl, server-to-
    // server calls, or the mobile app - never a cross-origin browser
    // request, so there's nothing to check against.
    if (!origin) return callback(null, true);

    const brandDomains = await getAllowedBrandDomains();
    const allowed = new Set<string>([process.env.FRONTEND_URL || 'http://localhost:3000']);
    for (const domain of brandDomains) {
      allowed.add(`https://${domain}`);
      allowed.add(`https://www.${domain}`);
    }

    if (allowed.has(origin)) return callback(null, true);
    logger.warn(`CORS rejected origin: ${origin}`);
    callback(null, false);
  },
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

// FIX: password-reset/request and magic-link were put under authLimiter
// below, but both always return 200/{success:true} even for a non-existent
// email (correct, deliberate email-enumeration protection - see
// requestPasswordReset/requestMagicLink in authService.ts) - there is no
// "failed attempt" for either endpoint the way a wrong password is a
// failed login. authLimiter's skipSuccessfulRequests: true means a 200
// never counts against the limit, so those two were effectively
// unlimited despite being "rate-limited" - the opposite of what putting
// them under authLimiter was for (spam/abuse: unlimited real emails sent
// to any address someone types in). Every call has to count here, success
// included, so this is its own limiter rather than reusing authLimiter.
const emailSendLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
});

app.use('/api/', limiter);
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);
// Same secret-guessing shape as /login (a code or password checked against
// a stored value) - these were only covered by the general 100/15min '/api/'
// limiter above, which is nowhere near tight enough for something an
// attacker can script attempts against:
// - change-password / password-reset/confirm: guessing the current
//   password (change-password) or brute-forcing while holding a stolen
//   reset/access token.
// - mfa/verify-login / mfa/confirm: a 6-digit TOTP code has only 1,000,000
//   possible values - far too small a space to leave at 100 attempts/15min.
app.use('/api/auth/change-password', authLimiter);
app.use('/api/auth/password-reset/confirm', authLimiter);
app.use('/api/auth/mfa/verify-login', authLimiter);
app.use('/api/auth/mfa/confirm', authLimiter);
// password-reset/request and magic-link don't guess a secret, but each
// call sends a real email to whatever address is given - unlimited calls
// is a spam/abuse vector. Both always return 200 (enumeration protection -
// see the FIX note above), so this has to be emailSendLimiter, not
// authLimiter: authLimiter's skipSuccessfulRequests would exempt every
// single one of these calls.
app.use('/api/auth/password-reset/request', emailSendLimiter);
app.use('/api/auth/magic-link', emailSendLimiter);

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
app.use('/api/siret', optionalAuth, require('./routes/siret').default);

// Protected routes (require authentication)
app.use('/api/companies', authenticate, require('./routes/companies').default);
app.use('/api/dossiers', authenticate, require('./routes/dossiers').default);
app.use('/api/uploads', authenticate, require('./routes/uploads').default);
// Serves files saved by the local-disk storage fallback (storageService.ts).
// No-op / unused when AWS_S3_BUCKET is configured, since files then live in S3.
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));
app.use('/api/dashboard', authenticate, require('./routes/dashboard').default);
app.use('/api/tenders', authenticate, require('./routes/tenders').default);
app.use('/api/alerts', authenticate, require('./routes/alerts').default);
app.use('/api/favorites', optionalAuth, require('./routes/favorites').default);
app.use('/api/chatbot', optionalAuth, require('./routes/chatbot').default);
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

    // Same "no shell on Render's free tier" reasoning as the demo seed above -
    // client can't run `node scripts/backfillRegionNames.js` by hand, so it
    // has to happen on boot too. Fixes the region-name bug (pre-2016 région
    // names + accent mismatches - see utils/departmentRegion.ts) on rows
    // that were already ingested before this fix shipped; new imports are
    // already correct without this. Fully idempotent (every row is
    // independently re-derived from its own current value each run, nothing
    // accumulates), so running it again on every restart is harmless - same
    // as the seed script. Set SKIP_REGION_BACKFILL=true once this has run
    // successfully in production a first time, to skip the full-table pass
    // on every subsequent restart.
    if (process.env.SKIP_REGION_BACKFILL !== 'true') {
      const { execFile } = require('child_process');
      const backfillScriptPath = require('path').resolve(process.cwd(), 'scripts', 'backfillRegionNames.js');
      execFile('node', [backfillScriptPath], (err: any, stdout: string, stderr: string) => {
        if (stdout) logger.info(`[region backfill] ${stdout.trim()}`);
        if (err) {
          logger.error('[region backfill] failed (non-fatal):', stderr || err.message);
        }
      });
    }

    // Client's 12 Sep report: fiche text showed a raw English/GMT date
    // ("Wed Sep 23 2026 08:27:02 GMT+0000") instead of a plain French one -
    // fixed at the prompt source (deadline is formatted before reaching any
    // prompt now), but rows that already generated content with the bug
    // baked in are status='generated', not 'failed', so the normal
    // on-demand-regenerate-on-failure path never revisits them. Same
    // "no shell on Render free tier" boot-time pattern as the region
    // backfill above - finds and clears any row whose stored content still
    // contains "GMT", which then regenerates cleanly next time it's
    // opened. Naturally a no-op after the first successful run (nothing
    // left to find), so no separate skip flag needed.
    if (process.env.SKIP_GMT_CONTENT_RESET !== 'true') {
      const { execFile } = require('child_process');
      const gmtResetScriptPath = require('path').resolve(process.cwd(), 'scripts', 'resetGmtDateContent.js');
      execFile('node', [gmtResetScriptPath], (err: any, stdout: string, stderr: string) => {
        if (stdout) logger.info(`[gmt content reset] ${stdout.trim()}`);
        if (err) {
          logger.error('[gmt content reset] failed (non-fatal):', stderr || err.message);
        }
      });
    }

    // Client's brief (15 Sep): "Appels d'offres privés"/"Sous-traitance" had
    // no real content source at all - scripts/seedEditorialListings.js
    // seeds a first templated batch. Same "no shell on Render's free tier"
    // boot-time pattern as the demo seed/region backfill above (own
    // process, own Pool, own exit - can't call pool.end() on the main
    // app's connection pool). Fully idempotent (ON CONFLICT DO NOTHING
    // keyed on source_reference), and it no-ops safely by itself if the
    // trades/data_sources migration above hasn't landed on this DB yet
    // (rather than throwing) - so running this right after ensureSchema/
    // migrations just needs to be "eventually after", not exact-order.
    // Set SKIP_EDITORIAL_SEED=true to turn this off later once a real
    // private-listings feed replaces it.
    if (process.env.SKIP_EDITORIAL_SEED !== 'true') {
      const { execFile } = require('child_process');
      const editorialSeedPath = require('path').resolve(process.cwd(), 'scripts', 'seedEditorialListings.js');
      execFile('node', [editorialSeedPath], (err: any, stdout: string, stderr: string) => {
        if (stdout) logger.info(`[editorial seed] ${stdout.trim()}`);
        if (err) {
          logger.error('[editorial seed] failed (non-fatal):', stderr || err.message);
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
    require('./jobs/locationRegionBackfillJob').startLocationRegionBackfillJob();
    require('./jobs/staleSummaryBackfillJob').startStaleSummaryBackfillJob();
    require('./jobs/analysisSectionsBackfillJob').startAnalysisSectionsBackfillJob();
    require('./jobs/opportunityStatusJob').startOpportunityStatusJob();
    require('./jobs/aiProcessing').startAIProcessing();
    require('./jobs/opportunityAlerts').startOpportunityAlerts();
    require('./jobs/crmRetry').startCrmRetrySchedule();

    // Start server
    const server = app.listen(PORT, () => {
      logger.info(`🚀 Server running on http://localhost:${PORT}`);
      logger.info(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
      logger.info(`🎨 Frontend URL: ${process.env.FRONTEND_URL}`);

      // C08 (contre-audit 15 Sep, correction partielle): the OTP gate on
      // POST /siret/lead (phoneVerificationService.ts) is fully built, but
      // isVerificationRequired() quietly defaults to *off* whenever no SMS
      // provider is configured - by design, so staging/local dev isn't
      // blocked. The failure mode the audit actually hit was this same
      // silent default reaching a real deployment: nothing crashes, nothing
      // errors, leads just go through unverified with no signal anywhere
      // that the gate is bypassed. A code fix can't supply Twilio/SMS
      // credentials this environment doesn't have - only surface the gap
      // loudly enough that whoever deploys this notices it before a client
      // audit does. Doesn't touch behavior; PHONE_VERIFICATION_REQUIRED
      // still overrides in either direction exactly as before.
      if (process.env.NODE_ENV === 'production' && !isVerificationRequired()) {
        logger.warn(
          '⚠️  Phone verification (C08) is NOT enforced in production: no SMS provider is configured ' +
            '(TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN/TWILIO_FROM_NUMBER or SMS_WEBHOOK_URL) and ' +
            'PHONE_VERIFICATION_REQUIRED is not set to "true". Leads are being accepted with unverified ' +
            'phone numbers. Set SMS credentials (or PHONE_VERIFICATION_REQUIRED=true once a provider is ' +
            'in place) to close this.'
        );
      } else if (process.env.NODE_ENV === 'production' && !isSmsConfigured() && process.env.PHONE_VERIFICATION_REQUIRED === 'true') {
        logger.warn(
          '⚠️  PHONE_VERIFICATION_REQUIRED=true but no SMS provider is configured - every phone ' +
            'verification request will fail to send, blocking every visitor at the lead gate.'
        );
      }
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
          // Background cron jobs (SEO generation, search index refresh, CRM
          // retry, etc.) run on their own timers, entirely outside the HTTP
          // request lifecycle server.close() just waited on above - one of
          // them being mid-query at this exact moment is what caused
          // "Cannot use a pool after calling end on the pool" on every
          // redeploy (confirmed live, 2026-09-05). Give any in-flight job a
          // chance to finish first; budgeted well inside the 10s forceExit
          // timer above so a stuck job still can't hang the shutdown
          // forever.
          await drainActiveJobs(7_000);
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
