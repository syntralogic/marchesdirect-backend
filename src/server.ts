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
app.use('/api/subscriptions', require('./routes/subscriptions').default);
// CRM lead capture must be public: it's submitted from anonymous marketing
// pages (pricing page, contact form) before someone has an account.
// Admin viewing/managing of captured leads stays behind authenticate below.
app.use('/api/crm/leads', require('./routes/crmPublic').default);

// Protected routes (require authentication)
app.use('/api/companies', authenticate, require('./routes/companies').default);
app.use('/api/uploads', authenticate, require('./routes/uploads').default);
// Serves files saved by the local-disk storage fallback (storageService.ts).
// No-op / unused when AWS_S3_BUCKET is configured, since files then live in S3.
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));
app.use('/api/dashboard', authenticate, require('./routes/dashboard').default);
app.use('/api/tenders', authenticate, require('./routes/tenders').default);
app.use('/api/alerts', authenticate, require('./routes/alerts').default);
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

    // Start background jobs
    require('./jobs/dataCollection').startScheduledJobs();
    require('./jobs/documentExpiry').startExpiryCheck();
    require('./jobs/seoGeneration').startSEOGeneration();
    require('./jobs/backupManagement').startBackupSchedule();
    require('./jobs/searchIndexRefresh').startSearchIndexRefresh();
    require('./jobs/aiProcessing').startAIProcessing();
    require('./jobs/opportunityAlerts').startOpportunityAlerts();
    require('./jobs/crmRetry').startCrmRetrySchedule();

    // Start server
    app.listen(PORT, () => {
      logger.info(`🚀 Server running on http://localhost:${PORT}`);
      logger.info(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
      logger.info(`🎨 Frontend URL: ${process.env.FRONTEND_URL}`);
    });
  } catch (err) {
    logger.error('❌ Failed to start server:', err);
    process.exit(1);
  }
};

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully...');
  await db.end();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down gracefully...');
  await db.end();
  process.exit(0);
});

// Start server
startServer();

export default app;
