# French Public Procurement Platform - Backend

**Version 1.0 | Node.js + Express + PostgreSQL**

Backend for a French public procurement opportunities platform with AI-powered
classification, intelligent matching, and multi-tenant architecture.

---

## ✅ Implementation status (honest, as of this pass)

| Area | Status |
| --- | --- |
| Schema, DB connection, JWT middleware | Written, `tsc --noEmit` clean |
| Auth (`authService.ts`), routes wired | Written, not yet exercised against a live DB |
| BOAMP/PLACE/TED connectors (M2), dedup (M3) | Written, no live run with the required 3 automatic executions demonstrated yet |
| AI classification/matching/summaries (M6-7) | Written (`aiService.ts`), no live-data test or chatbot accuracy benchmark run yet |
| DCE analysis - selection criteria/required docs/scoring (M6.1/M9) | Written (`aiService.analyzeTenderDocuments`, `POST /api/tenders/:id/analyze`); reads the connector's already-ingested title/description/raw_data, does NOT yet parse RC/CCAP/CCTP PDF files directly (connectors don't download those files today - separate task). No live run yet. |
| AI technical memo generator, 6-section (M6.4/M9) | Written (`aiService.generateTechnicalMemo`), pulls company_resources (staff/equipment) and all 3 policy types (quality/safety/environmental). **Fixed this pass:** the actual `POST /api/tenders/bid/:bidId/generate` route was never calling this function — it had its own separate, much weaker inline 2-section builder instead, so the real endpoint was silently producing a non-compliant memo despite the good generator existing elsewhere in the codebase. Now wired together. Falls back to a deterministic grounded template if the Claude API call fails. No live run yet. |
| Duplicate AI-processing schedules (M6/M7) | `jobs/dataCollection.ts` had its own hourly classification cron **and** `jobs/aiProcessing.ts` had an independent 15-min cron - both pulling from the same `not_analyzed` queue with no coordination, so a race could trigger the same Claude API call twice for one opportunity. Removed the duplicate cron from `dataCollection.ts`; `aiProcessing.ts` is now the single owner of classification/summarization scheduling (it also retries `failed` status, which the removed one didn't). |
| Dead duplicate scheduler (M2) | `dataCollectionService.ts` exported its own `startScheduledCollection()` (6h cron) that nothing ever called — `jobs/dataCollection.ts` has the actually-wired version (2h cron). Removed the dead one so a future change can't accidentally wire both up and cause the same double-run problem fixed above. |
| Per-source collection frequency ignored (M2) | `data_sources.frequency_hours` exists (BOAMP=6h, TED=12h per `.env.example`) but was never read — `scheduleDataCollection()` collected every active source unconditionally on every 2-hour tick, and `next_run` was always set to a hardcoded `+6 hours` regardless of the source's own configured frequency. Fixed: collection now only runs for sources where `next_run <= NOW()`, and `next_run` is set using that source's real `frequency_hours`. |
| Chatbot: journey-awareness, citation, prompt-injection hardening (M7) | Spec (section 5) requires the chatbot to be journey-aware, cite sources, distinguish facts from recommendations, and resist prompt injection from malicious listing content — none of these were implemented. Added: conversations can now carry a `journey` field that shapes tone; externally-sourced opportunity text is wrapped in an explicit `<untrusted_reference_data>` block with instructions telling the model to treat it as quotable data, never as instructions to obey; system prompt now requires citing facts, flagging missing info as "not available", and distinguishing stated facts from recommendations; `chatbot_messages.source_citations` (already in schema, never populated) is now written on each assistant reply. |
| Engagement act (M9/6.3) | Was missing the contract's purpose entirely (spec 6.3 requires it) — fixed to pull in the opportunity title. Still a direct template fill, not AI-drafted, per spec ("pre-filled form... reviewed and confirmed by company before signature"). |
| Tender-specific required-documents checklist (M9/6.1) | DCE analysis (`analyzeTenderDocuments`) extracts a per-tender `required_documents` list in the buyer's own wording; the generic internal checklist uses our own `document_type` codes. These were previously returned as two separate, unmerged lists. **Now merged:** `src/utils/documentMatching.ts` adds a deterministic keyword matcher (Kbis, DC1/DC2, DUME, assurance/decennale, attestation fiscale/sociale) that maps a DCE requirement's own wording to our internal type where the wording is unambiguous, and leaves it as `needs_manual_review` when it isn't - never a guessed match. `POST /api/tenders/bid/:bidId/generate` now returns a single `documentChecklist` (each item: requirement text, matched type or null, status `present`/`missing`/`needs_manual_review`, and whether it came from the tender-specific or generic list); `missingDocuments`/`tenderSpecificRequiredDocuments` are kept in the response too for anything still reading the old shape. The downloadable bid package (`GET /bid/:bidId/package`) now prints this merged, human-readable list instead of only the 7 generic codes, so a tender-specific requirement the DCE caught - even an unmatched one, flagged for manual review - actually shows up in the pack. Sanity-checked in isolation (matcher correctly identified Kbis/URSSAF/insurance wording and correctly left an unrecognized item like "memoire technique detaille" as manual-review rather than guessing); not yet tested against a real DCE-analyzed tender's actual extracted wording, since there's no live DB/Claude API access in this environment to run `analyzeTenderDocuments` for real. |
| Structured fact extraction with explicit "not available" (POC test spec) | Written (`aiService.extractOpportunityFacts`, `POST /api/opportunities/:id/extract-facts`); requires the `ai_extracted_facts` column added to `schema.sql` in this pass - re-run schema.sql (or the one new `ALTER TABLE` if the DB already exists) before using it. No live run yet. |
| Documents / S3 (M9) | Written, S3 not configured/tested |
| Stripe billing, CRM export (M8) | Routes exist (`subscriptions.ts`, `crm.ts`); Stripe/CRM API calls not wired to real accounts |
| `scripts/migrate.js`, `scripts/seed.js` | Both exist now. `npm run db:migrate` loads schema.sql standalone (server.ts also auto-loads it on boot via `ensureSchema()`, so this is mainly for CI/scripted use). `npm run db:seed` inserts demo opportunities across all 3 journeys + a demo login (`demo@marchesdirect.fr` / `DemoPass123!`) so milestones 4/5/8 are demoable before live connector data exists. Not a substitute for milestone 2/3 proof, which requires real connector runs. |
| GDPR delete endpoint (M8/M11) | Added: `DELETE /api/auth/account` - soft-deletes + anonymizes the user's PII, revokes sessions, audit-logged; also soft-deletes the company if that was its last active user. `tsc --noEmit` clean, not yet exercised against a live DB. |
| Backup/restore (M12) | `jobs/backupManagement.ts` existed but only supported split `DB_HOST`/`DB_USER` env vars - broken on Render/Supabase, which use a single `DATABASE_URL`. Fixed to support both. Added `POST /api/admin/backups/run` and `POST /api/admin/backups/restore-test` so the restore proof can be triggered on demand instead of waiting for the weekly cron. Still needs to actually be run once against a real deployed DB - `pg_dump`/`createdb`/`dropdb` need to exist on the host and the DB role needs `CREATE DATABASE` privilege, neither of which is verified yet. |
| Search materialized view (M5/M12) | `opportunity_search_index` existed in schema.sql but nothing ever refreshed it, and the search route queried the base `opportunities` table directly instead - the view was dead weight. `jobs/searchIndexRefresh.ts` refreshes it every 15 min via `REFRESH MATERIALIZED VIEW CONCURRENTLY`. **Now switched over:** added the missing columns (`currency`, `location_department`, `estimated_start_date`/`end_date`, `ai_classification_status`, `ai_summary`, `ai_matched_trades`, `status`, `trade_id`) to the view definition in `schema.sql` so it carries every column `GET /api/opportunities` returns, then pointed the route at the view instead of joining `opportunities` on every request. Response shape (field names) is unchanged, so this shouldn't require any frontend change. **Trade-off to be aware of:** listings can be up to ~15 min stale on the search/browse page now (new/updated rows wait for the next refresh) - the bid-response flow still reads `opportunities` directly, so nothing compliance-critical uses the stale view. Not yet run against a live/populated DB (no live Postgres in this environment) - `tsc --noEmit` is clean, but the actual query plan and the 1M-row load test (M12) still need to be run for real. |
| 1M-row load test (M12) | `scripts/generateSyntheticListings.js` (bulk-inserts clearly-marked `SYNTH-*` rows, `--clean` flag to remove them) and `scripts/loadTest.js` (autocannon against a running instance's `/api/opportunities`) now exist. Neither has been run — this environment has no network path to a live Postgres instance or a deployed API to test against. |
| Dependency audit (M12) | `npm audit --production`: 2 moderate advisories, both in `aws-sdk` v2 (already flagged elsewhere in this table as EOL, migration to v3 is a separate task) and its transitive `uuid` dependency. No criticals/highs. This is a dependency scan, **not** the independent security audit the milestone actually requires — see acceptance checklist below. |

This section exists so the README doesn't silently drift from reality again -
please update the table (not just the code) when a row's status changes.

> **Note on "no live run yet" above:** everything in this pass was written and
> type-checked (`tsc --noEmit` clean) in a sandboxed environment with no
> network access to BOAMP, a real Postgres instance, or the Anthropic API with
> a funded key - so none of it could be executed end-to-end from here. It
> needs to be run once against a real database and a real `ANTHROPIC_API_KEY`
> before treating any of these rows as done for milestone/proof purposes.

---

## 🚀 Quick Start

### Prerequisites
- Node.js 18+
- PostgreSQL 14+
- AWS S3 (only needed once document upload/generation - M9 - is wired to real storage;
  the API runs fine without it for everything else)

> Redis is **not** currently required — scheduled jobs (`src/jobs/`) run on
> `node-cron` in-process, not on a Redis-backed queue. `bull` is listed in
> `package.json` for a possible future job-queue upgrade but isn't imported
> anywhere in `src/` yet.

### Installation

```bash
# Clone and setup
git clone <repo>
cd marchesdirect-backend
npm install

# Setup environment
cp .env.example .env
# Edit .env - at minimum set DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD and JWT_SECRET.
# Stripe/AWS/CRM keys can stay blank until you're testing those specific features.

# Create the database, then load the schema
createdb procurement_platform          # or: psql -U postgres -c "CREATE DATABASE procurement_platform;"
npm run db:migrate
# Optional: seed demo data (opportunities across all 3 journeys + a demo login)
npm run db:seed

# Start development server (ts-node, no build step)
npm run dev

# Production build
npm run build
npm start
```

> `npm run db:migrate` and `npm run db:seed` are now available (see scripts/
> above). `db:migrate` loads schema.sql directly if you'd rather not boot the
> server to get its auto-migration.

---

## 📋 Project Structure

This reflects what's actually in `src/` today (last checked against the repo directly -
if you add/remove files, please keep this list in sync so it doesn't go stale again):

```
src/
├── config/
│   └── database.ts              # PostgreSQL connection pool (pg.Pool)
│
├── middleware/
│   ├── auth.ts                  # JWT authentication
│   └── errorHandler.ts          # Global error handling
│
├── services/                    # Business logic lives here directly (no separate
│   │                             # controllers/ layer - routes call services inline)
│   ├── authService.ts           # Login, registration (M8)
│   ├── dataCollectionService.ts # BOAMP/PLACE/TED connectors (M2)
│   ├── deduplicationService.ts  # Duplicate detection & merging (M3)
│   ├── aiService.ts             # Claude/OpenAI classification, matching, summaries (M6-7)
│   └── documentService.ts       # S3 file handling & document generation (M9)
│
├── routes/
│   ├── auth.ts
│   ├── opportunities.ts
│   ├── trades.ts
│   ├── subscriptions.ts
│   ├── companies.ts
│   ├── dashboard.ts
│   ├── tenders.ts
│   ├── alerts.ts
│   ├── chatbot.ts
│   ├── documents.ts
│   ├── crm.ts
│   └── admin.ts
│
├── jobs/                        # node-cron based, started from server.ts on boot
│   ├── dataCollection.ts        # Scheduled data collection (M2)
│   ├── documentExpiry.ts        # Document expiry alerts
│   ├── seoGeneration.ts         # SEO page generation (M11)
│   ├── backupManagement.ts      # Database backups (M12)
│   └── aiProcessing.ts          # Batch AI classification & summaries
│
├── utils/
│   └── logger.ts                # Winston logging
│
├── types/
│   └── express.d.ts             # Express Request augmentation (req.user, etc.)
│
└── server.ts                    # Main Express server, route + job registration
```

**Not built yet, referenced only in planning docs below:** a `stripeService.ts` (Stripe
is in `package.json` but not wired into any route yet), a dedicated `seoService.ts`
(SEO generation currently lives entirely in `jobs/seoGeneration.ts`), a `controllers/`
layer, and `utils/validators.ts` / `helpers.ts` / `constants.ts`. If you add these,
update this section.

---

## 🗄️ Database Schema

**Core tables** (see schema.sql for full definitions):

### Authentication & Multi-Tenancy
- `brands` - Two separate brands (BOAMP Pro, Marchés Locaux)
- `companies` - Companies/end-users
- `users` - User accounts within companies
- `user_sessions` - Active sessions & refresh tokens
- `login_attempts` - Login tracking for rate limiting

### Data & Classification
- `data_sources` - BOAMP, PLACE, TED, etc.
- `connector_logs` - Collection activity logs
- `opportunities` - Main listings from all sources
- `opportunity_duplicates` - Cross-source duplicate tracking (M3)
- `trades` - Business categories (construction, IT, etc.)
- `cpv_codes` - EU procurement classification

### Company Profile & Documents (M6, M9)
- `company_documents` - KBIS, insurance, certifications
- `company_certifications` - Professional qualifications
- `company_resources` - HR, equipment, facilities
- `company_references` - Past projects for proposal reuse
- `company_policies` - Quality, safety, environmental docs

### Tender Response Module (M9)
- `tenders` - Tender analysis (DCE extraction)
- `bid_responses` - Company responses to tenders
  - Auto-generated DC1/DC2/DUME
  - AI-generated technical memos
  - Pricing schedules

### Subscriptions & Payments (M8)
- `subscription_plans` - Free, Pro, Enterprise tiers
- `subscriptions` - Active company subscriptions
- `invoices` - Payment history

### AI & Matching (M6, M7)
- Opportunities table columns: `ai_classification_status`, `ai_matched_trades`, `ai_summary`
- `chatbot_conversations` - Chat history by topic
- `chatbot_messages` - Individual messages with source citations

### Alerts & Notifications (M8)
- `company_alerts` - New opportunities, deadlines, expirations
- `security_incidents` - Access attempts, auth failures

### System
- `audit_logs` - All data modifications (GDPR compliance)
- `backup_logs` - Backup & restoration history (M12)
- `system_health` - Health check logs
- `seo_pages` - Auto-generated SEO pages (M11)

---

## 🔐 Authentication & Security (Milestone 8)

### JWT Flow
```
1. User registers → Company + User created → 14-day trial
2. Login → Verify password (bcrypt) → Generate JWT + Refresh Token
3. Protected routes → Verify JWT → Check company access
4. Token expiry → Use refresh token → Generate new JWT
```

### MFA (Optional)
```
1. User enables MFA → Generate TOTP secret + QR code
2. Verify token → Enable on account
3. Next login → After password, request TOTP token
4. Complete authentication → Issue full JWT
```

### Company Isolation
Every route checks: `user.companyId === requestedCompanyId` 
- Prevents cross-company data access
- All queries filtered by `company_id`
- Audit logged if violation attempted

---

## 📊 Data Collection Pipeline (Milestones 2-3)

### Architecture
```
BOAMP API → Fetch raw data → Transform → Deduplicate → Store → Classify (AI)
PLACE API → ↓                ↓         ↓              ↓
TED Feed  → etc...
```

### Milestone 2: Automated Collection
- **BOAMP connector**: Polls every 6 hours, auto-retry on failure
- **PLACE connector**: EU government procurement platform
- **TED connector**: EU-wide tenders (RSS feed)
- Logs in `connector_logs` table showing 3+ successful runs with NO manual action

### Milestone 3: Deduplication
- **Problem**: Same tender on BOAMP + PLACE = duplicate records
- **Solution**: Compare title similarity (>85%) + deadline (<24h diff)
- **Proof**: 
  - Import same data twice → zero duplicates created
  - One ID maintained for merged records
  - `opportunity_duplicates` table tracks merges
- **Acceptance**: Run `verifyDeduplicationQuality()` → returns true

---

## 🤖 AI Integration (Milestones 6-7)

### Milestone 6: Classification & Matching

**Classification** (`classifyOpportunity`):
```
Input: Title, Description, Location, Value
↓
Claude API: Extract trade, CPV code, complexity level
↓
Output: Trades [{}], CPV codes [{}], Complexity (low/med/high)
↓
Update: ai_matched_trades, cpv_code_id, complexity_level
```

**Matching** (`matchOpportunitiesToCompany`):
```
Input: Company certified trades, location, working radius, budget
↓
Query: Find opportunities matching company profile
↓
Filter by: Trade (AI-matched), Distance, Value range
↓
Output: Sorted list of relevant opportunities
```

### Milestone 7: Summaries & Chatbot

**Summaries** (`generateOpportunitySummary`):
```
Input: Full opportunity data
↓
Claude: Highlight work, requirements, timeline, risks
↓
Output: 2-3 paragraph summary
↓
Save: ai_summary, ai_summary_status = 'generated'
```

**Chatbot** (`chatbot`):
```
Input: User question + conversation context
↓
Claude: Answer based on opportunity docs + company data
↓
Rules: Only cite sources, never invent facts
↓
Output: Answer with `source_citations` JSONB
↓
Test: 30-question benchmark at 90%+ accuracy
```

---

## 💳 Subscriptions & Payments (Milestone 8)

### Stripe Integration
```typescript
// Create subscription
const stripeCustomer = await stripe.customers.create({ email });
const subscription = await stripe.subscriptions.create({
  customer: stripeCustomer.id,
  items: [{ price: plan.stripe_price_id }],
  trial_period_days: 14,
});

// Save to DB
await db.query('INSERT INTO subscriptions ...', [stripeCustomer.id, subscription.id]);
```

### Lead Capture
Form on homepage → Email + Phone + Trade + Location → CRM
- Saved in `crm_leads` table
- Synced to CRM (HubSpot/Pipedrive) via API

---

## 📄 Tender Response Module (Milestone 9)

### DCE Analysis (Automatic)
```
1. Upload tender documents (DC, CCAP, CCTP)
2. Claude extracts: Selection criteria, Required docs, Deadlines, Complexity
3. Save to `tenders` table
4. Generate checklist vs. company profile
```

### Company Profile (One-Time Entry)
- KBIS, insurance, certifications
- HR, equipment, resources
- Past projects with photos
- Quality/safety/environmental policies
- Auto-stored in S3, indexed in DB

### Document Generation
```
INPUT: Company profile + Tender requirements
↓
GENERATE:
  - DC1/DC2/DUME (auto-prefilled)
  - Engagement Act (acte d'engagement)
  - Technical Memo (mémoire technique) - AI-drafted
  - Pricing Schedule (BPU/DPGF)
  - Appendices
↓
OUTPUT: Single ready-to-submit ZIP
```

### Acceptance Proof
Generate full bid package on real tender → all 8 docs produced → no invented data

---

## 📱 SEO & Content Generation (Milestone 11)

### Auto-Generated Pages
By Trade, Region, Department, City + Opportunity Type:
```
/trade/plomberie/region/ile-de-france/tenders
/trade/electricite/departement/75/public-procurement
/region/occitanie/subcontracting
```

> **Known gap:** `jobs/seoGeneration.ts` currently only generates trade x region
> pages. The department/city/opportunity-type granularity shown above (and
> asked for in Technical Requirements section 10) isn't implemented yet -
> expanding the combos generated is a reasonably contained change, but wasn't
> guessed at blind in this pass since page-count at that granularity needs a
> real sense of the data volume to size sensibly (could go from hundreds of
> pages to tens of thousands depending on how it's scoped).

Structure:
- Title & Meta: SEO-optimized
- Filter links to relevant opportunities
- Analytics tracking (page views, conversions)
- Refresh on new data collection

### Materialized View
```sql
opportunity_search_index
├── Full-text search (French)
├── Deadline for sorting
├── Indexed by trade, region, source
```

---

## 🔒 Security & Compliance (Milestone 12)

### Code Security
- No hardcoded secrets → .env file
- Encrypted API keys in DB (if stored)
- bcrypt password hashing (rounds: 10)
- JWT secret rotation recommended (monthly)

### Data Protection (GDPR)
- Personal data in Europe (EU data center)
- Audit logs for all modifications
- Delete user endpoint → GDPR compliance (`DELETE /api/auth/account` — soft-deletes + anonymizes PII, revokes sessions, audit-logged)
- Data retention: 365 days default

### Backup & Restoration
- Daily backups to S3 at 5am Paris time
- Restoration test required (not just scheduled)
- Proof: Full restoration from backup → verify data

### Audit Trail
Every change logged:
```sql
INSERT INTO audit_logs (user_id, action, entity_type, old_values, new_values)
```

---

## 🧪 Acceptance Testing Checklist

### Milestone 1: Foundations
- [ ] Repositories created under client control
- [ ] Database schema deployed
- [ ] Schema reviewable

### Milestone 2: First Connector (BOAMP)
- [ ] BOAMP runs automatically every 6 hours
- [ ] Screenshot/log showing 3 automated runs
- [ ] No manual button clicks

### Milestone 3: Deduplication
- [ ] Import same data twice → 0 duplicates
- [ ] Same ID maintained for merged record
- [ ] `opportunity_duplicates` table populated

### Milestone 4: Homepage
- [ ] 3-way entry point (Tenders / Public / Subcontracting)
- [ ] All paths working end-to-end

### Milestone 5: Search & Filters
- [ ] Full search-to-detail flow on all 3 journeys
- [ ] Filters working (trade, region, deadline, value)

### Milestone 6: AI Classification & Matching
- [ ] Real classification on live data (not "Not analyzed")
- [ ] Matching engine returns results
- [ ] Confidence scores visible

### Milestone 7: Summaries & Chatbot
- [ ] 30 test questions → 90%+ accuracy
- [ ] No hallucinated facts
- [ ] All info sourced

### Milestone 8: Auth & Subscriptions
- [ ] Cross-company access denied + logged
- [ ] Subscription flow end-to-end
- [ ] MFA working

### Milestone 9: Tender Response
- [ ] Full bid package on real tender
- [ ] All 8 docs generated
- [ ] No invented data

### Milestone 10: Second Brand
- [ ] Independent config
- [ ] No code duplication

### Milestone 11: SEO Generation
- [ ] 100+ pages generated
- [ ] Indexed by Google

### Milestone 12: Security & Backup
- [ ] Audit report from independent review — **cannot be self-certified**; needs
      a reviewer who isn't also the code's author (see Implementation status
      table above for what a code-level self-review already found: `.env`
      gitignored, no hardcoded secrets found, `helmet()` + `cors` configured,
      `npm audit` clean except 2 moderate advisories in `aws-sdk`/`uuid` v2 -
      both require breaking-change major upgrades, not yet done, see note below)
- [ ] Live backup restoration demonstrated — code now exists
      (`POST /api/admin/backups/run` then `POST /api/admin/backups/restore-test`,
      see `jobs/backupManagement.ts`) but has never actually been run against a
      real Postgres instance from this environment (no DB/network access here)
- [ ] Load test at 1M synthetic listings — `scripts/generateSyntheticListings.js`
      + `scripts/loadTest.js` now exist and are ready to run, but have not been
      executed against a live deployed instance yet

---

## 📚 API Routes (Summary)

### Public Routes
```
POST   /api/auth/register           # Company registration
POST   /api/auth/login              # User login
POST   /api/auth/refresh            # Refresh JWT
POST   /api/auth/forgot-password
POST   /api/auth/reset-password
POST   /api/auth/mfa/enable
DELETE /api/auth/account            # GDPR right-to-erasure
POST   /api/auth/mfa/verify
GET    /api/opportunities           # Search (paginated)
GET    /api/opportunities/:id       # Detail page
GET    /api/trades                  # All trades
POST   /api/crm/leads              # Lead capture
```

### Protected Routes (require JWT)
```
GET    /api/companies/:id           # Company profile
PUT    /api/companies/:id           # Update profile
GET    /api/dashboard               # Summary for user
GET    /api/alerts                  # Notifications
GET    /api/documents               # Uploaded documents
POST   /api/documents/upload        # Upload file to S3
POST   /api/chatbot/create          # Start conversation
POST   /api/chatbot/:id/message     # Send message
POST   /api/tenders/:id/analyze     # Analyze tender
POST   /api/tenders/:id/bid         # Create bid response
```

### Admin Routes (require admin role)
```
GET    /api/admin/sources           # Data sources
POST   /api/admin/sources           # Add source
GET    /api/admin/logs              # Connector logs
GET    /api/admin/audit             # Audit trail
GET    /api/admin/health            # System health
POST   /api/admin/backup            # Trigger backup
```

---

## 🚀 Deployment

### Environment Configuration
```bash
NODE_ENV=production
DB_SSL=true
LOG_LEVEL=info
# ... other vars from .env.example
```

### Database Migrations
```bash
npm run db:migrate
```

### Start Production
```bash
npm run build
npm start
```

### Process Manager
Use PM2 or systemd:
```bash
pm2 start dist/src/server.js --name procurement-api
pm2 save
```

---

## 📖 Key Services Reference

### Data Collection
```typescript
import { collectBoampData, startScheduledCollection } from './services/dataCollectionService';

// Trigger collection immediately
await collectBoampData(sourceId);

// Start automatic scheduling
startScheduledCollection(); // Runs every 6 hours
```

### AI Classification
```typescript
import { classifyOpportunity, matchOpportunitiesToCompany } from './services/aiService';

// Classify single opportunity
await classifyOpportunity(opportunityId);

// Find matches for company
const matches = await matchOpportunitiesToCompany(companyId);
```

### Authentication
```typescript
import { registerCompanyAndUser, loginUser } from './services/authService';

// Register
const result = await registerCompanyAndUser({
  companyName: 'Acme Corp',
  firstName: 'John',
  lastName: 'Doe',
  email: 'john@acme.fr',
  password: 'secure_password',
});

// Login
const session = await loginUser('john@acme.fr', 'secure_password');
```

---

## 🐛 Troubleshooting

### Database Connection Issues
```bash
# Check connection
psql -h localhost -U postgres -d procurement_platform -c "SELECT NOW();"

# Reset database
dropdb procurement_platform
createdb procurement_platform
psql -U postgres -d procurement_platform -f schema.sql
```

### Redis Connection
```bash
redis-cli ping
# Should return: PONG
```

### API Key Issues
- BOAMP_API_KEY, OPENAI_API_KEY, STRIPE_SECRET_KEY must be set in .env
- Never commit .env file

### Logs
```bash
tail -f logs/app.log
tail -f logs/error.log
```

---

## 📞 Support

For questions about:
- **Architecture**: Check project structure above
- **Milestones**: See Payment_Terms_v1_2_EN.docx
- **Database**: Review schema.sql for table definitions
- **AI Features**: Check aiService.ts for implementation

---

**Status**: Ready for Milestone 1 implementation  
**Last Updated**: August 2026  
**Built with**: Node.js 18+ | Express 4 | PostgreSQL 14 | Claude API
