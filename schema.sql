-- ============================================================================
-- PUBLIC PROCUREMENT OPPORTUNITIES PLATFORM - PostgreSQL SCHEMA
-- Version 1.2 | Two brands, shared backend
-- ============================================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- ============================================================================
-- 1. BRANDING & CONFIGURATION
-- ============================================================================

CREATE TABLE brands (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  code VARCHAR(50) UNIQUE NOT NULL,          -- 'brand_1', 'brand_2'
  name VARCHAR(255) NOT NULL,                -- "BOAMP.fr", "Marchés Pro"
  domain VARCHAR(255) UNIQUE NOT NULL,       -- domain.com
  logo_url VARCHAR(500),
  color_primary VARCHAR(7),
  color_secondary VARCHAR(7),
  language VARCHAR(10) DEFAULT 'fr',
  region_focus VARCHAR(100),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================================
-- 2. OPPORTUNITY TYPES & CLASSIFICATION
-- ============================================================================

CREATE TABLE opportunity_types (
  id SERIAL PRIMARY KEY,
  code VARCHAR(50) UNIQUE NOT NULL,         -- 'tender', 'public_procurement', 'subcontracting'
  name VARCHAR(255) NOT NULL,
  icon VARCHAR(255),
  description TEXT,
  brand_id UUID REFERENCES brands(id),      -- Can be NULL for all brands
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE cpv_codes (
  id SERIAL PRIMARY KEY,
  code VARCHAR(20) UNIQUE NOT NULL,         -- EU CPV classification
  name VARCHAR(500),
  description TEXT,
  sector VARCHAR(100),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE trades (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) UNIQUE NOT NULL,
  slug VARCHAR(255) UNIQUE,
  description TEXT,
  cpv_code_id INTEGER REFERENCES cpv_codes(id),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================================
-- 3. DATA SOURCES & COLLECTORS
-- ============================================================================

CREATE TABLE data_sources (
  id SERIAL PRIMARY KEY,
  code VARCHAR(50) UNIQUE NOT NULL,         -- 'boamp', 'place', 'ted', 'private_portal_x'
  name VARCHAR(255) NOT NULL,
  feed_type VARCHAR(50),                    -- 'api', 'rss', 'web_scrape', 'direct_feed'
  endpoint_url TEXT,
  api_key_encrypted VARCHAR(500),           -- encrypted in secrets
  frequency_hours INTEGER DEFAULT 6,
  active BOOLEAN DEFAULT true,
  requires_auth BOOLEAN DEFAULT false,
  legal_approval BOOLEAN,                   -- flagged before integration
  description TEXT,
  last_run TIMESTAMP,
  next_run TIMESTAMP,
  total_imports BIGINT DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE connector_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  source_id INTEGER REFERENCES data_sources(id) ON DELETE CASCADE,
  status VARCHAR(50),                       -- 'running', 'success', 'failed', 'partial'
  records_fetched INTEGER,
  records_processed INTEGER,
  records_failed INTEGER,
  raw_import_url TEXT,                      -- S3 path to raw data
  error_message TEXT,
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================================
-- 4. OPPORTUNITIES / LISTINGS (CORE DATA)
-- ============================================================================

CREATE TABLE opportunities (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  
  -- Identity
  source_id INTEGER NOT NULL REFERENCES data_sources(id),
  source_reference VARCHAR(500) NOT NULL,   -- Original ID from source (BOAMP ref, etc.)
  UNIQUE(source_id, source_reference),
  
  -- Classification
  opportunity_type_id INTEGER NOT NULL REFERENCES opportunity_types(id),
  trade_id INTEGER REFERENCES trades(id),
  cpv_code_id INTEGER REFERENCES cpv_codes(id),
  
  -- Core fields
  title VARCHAR(500) NOT NULL,
  description TEXT,
  raw_data JSONB,                           -- Full original record from source
  
  -- Dates
  publication_date TIMESTAMP NOT NULL,
  deadline TIMESTAMP,
  estimated_start_date TIMESTAMP,
  estimated_end_date TIMESTAMP,
  
  -- Contract details
  estimated_value DECIMAL(15, 2),
  currency VARCHAR(3) DEFAULT 'EUR',
  contract_type VARCHAR(100),               -- 'service', 'supply', 'work', etc.
  complexity_level VARCHAR(50),             -- 'low', 'medium', 'high'
  
  -- Location (for matching)
  location_city VARCHAR(255),
  location_region VARCHAR(255),
  location_department VARCHAR(100),         -- French department code
  location_latitude DECIMAL(10, 8),
  location_longitude DECIMAL(11, 8),
  
  -- Status
  status VARCHAR(50) DEFAULT 'active',      -- 'active', 'updated', 'expired', 'cancelled', 'awarded'
  is_cancelled BOOLEAN DEFAULT false,
  cancellation_date TIMESTAMP,
  
  -- AI Classification (Milestone 6)
  ai_classification_status VARCHAR(50),     -- 'not_analyzed', 'processing', 'classified', 'failed'
  ai_matched_trades JSONB,                  -- [{trade_id, confidence, reasoning}]
  
  -- Matching & Recommendations (Milestone 6)
  ai_summary_status VARCHAR(50),            -- 'not_generated', 'processing', 'generated', 'failed'
  ai_summary TEXT,                          -- Auto-generated summary
  ai_extracted_facts JSONB,                 -- Structured fact extraction (POC test): each field
                                             -- {"value": "...", "available": bool} - "not available"
                                             -- when the source record doesn't actually contain it.
  
  -- Audit
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP,
  
  -- Full-text search index
  search_vector tsvector GENERATED ALWAYS AS (
    to_tsvector('french', COALESCE(title, '') || ' ' || COALESCE(description, ''))
  ) STORED
);

CREATE INDEX opportunities_search ON opportunities USING GIN(search_vector);
CREATE INDEX opportunities_status ON opportunities(status);
CREATE INDEX opportunities_type ON opportunities(opportunity_type_id);
CREATE INDEX opportunities_source ON opportunities(source_id, source_reference);
CREATE INDEX opportunities_location ON opportunities(location_city, location_region);
CREATE INDEX opportunities_deadline ON opportunities(deadline);
CREATE INDEX opportunities_created ON opportunities(created_at DESC);

-- Deduplication tracking (Milestone 3)
CREATE TABLE opportunity_duplicates (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  primary_opportunity_id UUID NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  duplicate_opportunity_id UUID NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  similarity_score DECIMAL(3, 2),           -- 0.0 to 1.0
  matching_fields JSONB,                    -- which fields matched
  detected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(primary_opportunity_id, duplicate_opportunity_id)
);

-- ============================================================================
-- 5. COMPANIES / USERS (MULTI-TENANT)
-- ============================================================================

CREATE TABLE companies (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  
  -- Basic info
  brand_id UUID NOT NULL REFERENCES brands(id),
  name VARCHAR(500) NOT NULL,
  slug VARCHAR(500) UNIQUE,
  
  -- Legal/Registration
  kbis_number VARCHAR(50),                  -- French business registration
  legal_form VARCHAR(100),                  -- SARL, SAS, etc.
  registration_country VARCHAR(2),
  siret VARCHAR(14) UNIQUE,                 -- French SIRET code
  
  -- Contact
  email VARCHAR(255) NOT NULL UNIQUE,
  phone VARCHAR(20),
  website_url VARCHAR(500),
  
  -- Address
  address_street VARCHAR(500),
  address_city VARCHAR(255),
  address_postal_code VARCHAR(10),
  address_country VARCHAR(2) DEFAULT 'FR',
  
  -- Business details
  industry_sector VARCHAR(100),
  employee_count INTEGER,
  annual_revenue DECIMAL(15, 2),
  founding_year INTEGER,
  
  -- Subscriptions (Milestone 8)
  subscription_status VARCHAR(50),          -- 'active', 'trial', 'expired', 'cancelled'
  subscription_tier VARCHAR(50),            -- 'free', 'starter', 'pro', 'enterprise'
  stripe_customer_id VARCHAR(255),
  trial_ends_at TIMESTAMP,
  subscription_ends_at TIMESTAMP,
  
  -- Preferred journeys (Milestone 3)
  preferred_opportunity_types JSONB,        -- [opportunity_type_id, ...]
  
  -- Geographic focus (for matching)
  working_radius_km INTEGER,                -- How far they travel
  location_latitude DECIMAL(10, 8),
  location_longitude DECIMAL(11, 8),
  
  -- Status
  status VARCHAR(50) DEFAULT 'active',
  verified BOOLEAN DEFAULT false,
  verification_date TIMESTAMP,
  is_test_account BOOLEAN DEFAULT false,
  
  -- Audit
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP
);

CREATE INDEX companies_brand ON companies(brand_id);
CREATE INDEX companies_email ON companies(email);
CREATE INDEX companies_siret ON companies(siret);
CREATE INDEX companies_status ON companies(status);

-- ============================================================================
-- 6. USER ACCOUNTS & AUTHENTICATION (Milestone 8)
-- ============================================================================

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  
  email VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255),               -- bcrypt hash
  
  first_name VARCHAR(255),
  last_name VARCHAR(255),
  phone VARCHAR(20),
  job_title VARCHAR(255),
  
  -- Authentication
  email_verified BOOLEAN DEFAULT false,
  email_verified_at TIMESTAMP,
  last_login TIMESTAMP,
  
  -- MFA (Milestone 8)
  mfa_enabled BOOLEAN DEFAULT false,
  mfa_type VARCHAR(50),                     -- 'totp', 'sms', etc.
  mfa_secret_encrypted VARCHAR(500),
  
  -- Role & Permissions
  role VARCHAR(50) DEFAULT 'user',          -- 'user', 'admin', 'super_admin'
  permissions JSONB,                        -- flexible permission model
  
  -- Status
  status VARCHAR(50) DEFAULT 'active',
  
  -- Audit
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP
);

CREATE INDEX users_company ON users(company_id);
CREATE INDEX users_email ON users(email);
CREATE INDEX users_role ON users(role);

-- Session management
CREATE TABLE user_sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token_hash VARCHAR(255),
  ip_address VARCHAR(50),
  user_agent TEXT,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Login attempt tracking (for rate limiting & security)
CREATE TABLE login_attempts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email VARCHAR(255),
  ip_address VARCHAR(50),
  success BOOLEAN,
  attempted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX login_attempts_email ON login_attempts(email, attempted_at DESC);
CREATE INDEX login_attempts_ip ON login_attempts(ip_address, attempted_at DESC);

-- ============================================================================
-- 7. COMPANY PROFILE & DOCUMENT VAULT (Milestone 6 & 9)
-- ============================================================================

CREATE TABLE company_documents (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  
  document_type VARCHAR(100) NOT NULL,      -- 'kbis', 'insurance', 'certificate', 'reference', etc.
  document_name VARCHAR(500),
  description TEXT,
  
  -- File storage
  file_url VARCHAR(500) NOT NULL,           -- S3 URL
  file_size_bytes BIGINT,
  file_mime_type VARCHAR(50),
  file_uploaded_at TIMESTAMP,
  
  -- Validity tracking
  issued_date DATE,
  expiry_date DATE,
  is_expired BOOLEAN DEFAULT false,
  expiry_reminder_sent BOOLEAN DEFAULT false,
  
  -- Audit
  uploaded_by_user_id UUID REFERENCES users(id),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP
);

CREATE INDEX company_documents_company ON company_documents(company_id);
CREATE INDEX company_documents_type ON company_documents(document_type);
CREATE INDEX company_documents_expiry ON company_documents(expiry_date);

-- Company certifications & qualifications
CREATE TABLE company_certifications (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  
  certification_name VARCHAR(255),          -- 'Qualibat', 'RGE', 'ISO 9001', etc.
  certification_code VARCHAR(100),
  issued_by VARCHAR(255),
  
  issued_date DATE,
  expiry_date DATE,
  is_expired BOOLEAN DEFAULT false,
  expiry_reminder_sent BOOLEAN DEFAULT false,
  
  document_url VARCHAR(500),                -- S3
  
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Safe to re-run: covers anyone who already loaded schema.sql once before this
-- column was added to the CREATE TABLE above (which only applies on first create).
ALTER TABLE company_certifications ADD COLUMN IF NOT EXISTS expiry_reminder_sent BOOLEAN DEFAULT false;

-- Company HR & Resources (for proposal generation)
CREATE TABLE company_resources (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  
  resource_type VARCHAR(50),                -- 'staff', 'equipment', 'facility'
  name VARCHAR(255) NOT NULL,
  category VARCHAR(100),
  quantity INTEGER,
  description TEXT,
  skills_or_specs JSONB,                    -- flexible field for details
  
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Company past projects/references (for tech memo reuse)
CREATE TABLE company_references (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  
  project_name VARCHAR(500) NOT NULL,
  description TEXT,
  client_name VARCHAR(255),
  contract_value DECIMAL(15, 2),
  contract_type VARCHAR(100),
  completion_date DATE,
  
  skills_demonstrated JSONB,                -- [trade_id, ...]
  photos_urls JSONB,                        -- [S3 URLs]
  
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Company quality/safety policies (reusable text)
CREATE TABLE company_policies (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  
  policy_type VARCHAR(100),                 -- 'quality', 'safety', 'environmental', 'hr'
  policy_text TEXT NOT NULL,
  version_number INTEGER DEFAULT 1,
  effective_date DATE,
  
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================================
-- 8. TENDER RESPONSE MODULE (Milestone 9)
-- ============================================================================

CREATE TABLE tenders (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  opportunity_id UUID NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  
  -- DCE analysis (AI extraction from tender docs)
  dce_analysis_status VARCHAR(50),          -- 'not_analyzed', 'processing', 'analyzed'
  selection_criteria JSONB,                 -- Extracted requirements
  required_documents JSONB,                 -- Checklist
  scoring_weights JSONB,                    -- How winner is chosen
  complexity_assessment VARCHAR(100),
  estimated_effort_hours INTEGER,
  
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX tenders_opportunity ON tenders(opportunity_id);

-- Bid responses (one tender, many companies submitting)
CREATE TABLE bid_responses (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tender_id UUID NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  
  status VARCHAR(50) DEFAULT 'draft',       -- 'draft', 'in_progress', 'submitted', 'awarded', 'lost'
  
  -- Generated documents
  technical_memo_text TEXT,                 -- AI-generated first draft
  technical_memo_version INTEGER DEFAULT 0,
  is_technical_memo_approved BOOLEAN DEFAULT false,
  
  engagement_act_text TEXT,                 -- Pre-filled form
  is_engagement_act_signed BOOLEAN DEFAULT false,
  
  pricing_schedule_json JSONB,              -- Unit price breakdown
  total_bid_amount DECIMAL(15, 2),
  
  -- Document checks
  missing_documents JSONB,                  -- ["doc_type", ...]
  compliance_issues JSONB,                  -- Format, etc.
  
  submission_deadline TIMESTAMP,
  submitted_at TIMESTAMP,
  
  -- Audit
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX bid_responses_tender ON bid_responses(tender_id);
CREATE INDEX bid_responses_company ON bid_responses(company_id);
CREATE INDEX bid_responses_status ON bid_responses(status);

-- ============================================================================
-- 9. ALERTS & NOTIFICATIONS (Milestone 8)
-- ============================================================================

CREATE TABLE company_alerts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  
  alert_type VARCHAR(50),                   -- 'new_opportunity', 'deadline_reminder', 'document_expiry', etc.
  
  opportunity_id UUID REFERENCES opportunities(id),
  bid_response_id UUID REFERENCES bid_responses(id),
  
  title VARCHAR(500),
  message TEXT,
  
  is_read BOOLEAN DEFAULT false,
  read_at TIMESTAMP,
  
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX company_alerts_company ON company_alerts(company_id);
CREATE INDEX company_alerts_read ON company_alerts(is_read);

-- ============================================================================
-- 10. CHATBOT CONVERSATIONS (Milestone 7)
-- ============================================================================

CREATE TABLE chatbot_conversations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  
  topic VARCHAR(255),                       -- opportunity ID, bid ID, general
  context JSONB,                            -- Topic-specific data
  
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE chatbot_messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversation_id UUID NOT NULL REFERENCES chatbot_conversations(id) ON DELETE CASCADE,
  
  role VARCHAR(20),                         -- 'user', 'assistant'
  content TEXT,
  
  source_citations JSONB,                   -- [{opportunity_id, excerpt}] for sourcing
  
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================================
-- 11. SUBSCRIPTIONS & PAYMENTS (Milestone 8)
-- ============================================================================

CREATE TABLE subscription_plans (
  id SERIAL PRIMARY KEY,
  brand_id UUID REFERENCES brands(id),      -- Can be NULL for all
  
  stripe_product_id VARCHAR(255),
  stripe_price_id VARCHAR(255),
  
  name VARCHAR(255),
  description TEXT,
  price DECIMAL(10, 2),
  currency VARCHAR(3) DEFAULT 'EUR',
  billing_period VARCHAR(50),               -- 'monthly', 'annual'
  
  features JSONB,                           -- List of included features
  max_opportunities INTEGER,                -- -1 for unlimited
  max_bid_responses INTEGER,
  
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE subscriptions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id UUID NOT NULL UNIQUE REFERENCES companies(id) ON DELETE CASCADE,
  plan_id INTEGER NOT NULL REFERENCES subscription_plans(id),
  
  stripe_subscription_id VARCHAR(255) UNIQUE,
  stripe_customer_id VARCHAR(255),
  
  status VARCHAR(50),                       -- 'active', 'past_due', 'canceled', 'trialing'
  current_period_start TIMESTAMP,
  current_period_end TIMESTAMP,
  
  trial_start TIMESTAMP,
  trial_end TIMESTAMP,
  
  cancel_at_period_end BOOLEAN DEFAULT false,
  canceled_at TIMESTAMP,
  
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE invoices (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  subscription_id UUID REFERENCES subscriptions(id) ON DELETE CASCADE,
  company_id UUID REFERENCES companies(id),
  
  stripe_invoice_id VARCHAR(255),
  
  amount DECIMAL(10, 2),
  currency VARCHAR(3) DEFAULT 'EUR',
  status VARCHAR(50),                       -- 'draft', 'open', 'paid', 'void', 'uncollectible'
  
  issued_date TIMESTAMP,
  due_date TIMESTAMP,
  paid_date TIMESTAMP,
  
  description TEXT,
  invoice_url VARCHAR(500),                 -- PDF
  
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================================
-- 12. LEAD CAPTURE & CRM INTEGRATION (Milestone 8)
-- ============================================================================

CREATE TABLE crm_leads (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  brand_id UUID NOT NULL REFERENCES brands(id),
  
  first_name VARCHAR(255),
  last_name VARCHAR(255),
  email VARCHAR(255),
  phone VARCHAR(20),
  company_name VARCHAR(500),
  
  industry_trade VARCHAR(100),
  location_city VARCHAR(255),
  location_region VARCHAR(255),
  
  lead_source VARCHAR(100),                 -- 'organic_search', 'ad', 'landing_page', 'signup'
  
  crm_system VARCHAR(50),                   -- 'hubspot', 'pipedrive', etc.
  crm_contact_id VARCHAR(255),              -- Remote ID in CRM
  crm_sync_status VARCHAR(50),              -- 'pending', 'synced', 'failed'
  crm_last_sync TIMESTAMP,
  
  status VARCHAR(50) DEFAULT 'new',         -- 'new', 'contacted', 'qualified', 'converted', 'lost'
  
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX crm_leads_email ON crm_leads(email);
CREATE INDEX crm_leads_status ON crm_leads(status);
CREATE INDEX crm_leads_crm ON crm_leads(crm_sync_status);

-- ============================================================================
-- 13. SEO PAGE GENERATION (Milestone 11)
-- ============================================================================

CREATE TABLE seo_pages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  brand_id UUID NOT NULL REFERENCES brands(id),
  
  -- Page identity
  page_type VARCHAR(100),                   -- 'trade', 'region', 'city', 'department', etc.
  page_slug VARCHAR(500) UNIQUE NOT NULL,
  page_title VARCHAR(500),
  page_meta_description VARCHAR(500),
  page_keywords TEXT,
  
  -- Content
  page_content TEXT,                        -- Generated body
  
  -- Filters applied
  filter_trade_id INTEGER REFERENCES trades(id),
  filter_region VARCHAR(255),
  filter_city VARCHAR(255),
  filter_department VARCHAR(100),
  filter_opportunity_type_id INTEGER REFERENCES opportunity_types(id),
  
  -- Indexation
  is_published BOOLEAN DEFAULT true,
  google_indexed BOOLEAN DEFAULT false,
  last_indexed_at TIMESTAMP,
  
  -- Performance
  page_views BIGINT DEFAULT 0,
  conversion_count INTEGER DEFAULT 0,
  
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX seo_pages_slug ON seo_pages(page_slug);
CREATE INDEX seo_pages_brand ON seo_pages(brand_id);

-- ============================================================================
-- 14. AUDIT & SECURITY LOGS (Milestone 12)
-- ============================================================================

CREATE TABLE audit_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  
  user_id UUID REFERENCES users(id),
  company_id UUID REFERENCES companies(id),
  
  action VARCHAR(100),                      -- 'create', 'update', 'delete', 'access', etc.
  entity_type VARCHAR(100),                 -- 'opportunity', 'company', 'user', etc.
  entity_id VARCHAR(500),
  
  old_values JSONB,
  new_values JSONB,
  
  ip_address VARCHAR(50),
  user_agent TEXT,
  
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX audit_logs_user ON audit_logs(user_id);
CREATE INDEX audit_logs_company ON audit_logs(company_id);
CREATE INDEX audit_logs_action ON audit_logs(action, created_at DESC);

-- Cross-company access attempts (denied)
CREATE TABLE security_incidents (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  
  incident_type VARCHAR(100),               -- 'unauthorized_access', 'failed_auth', 'sql_injection_attempt', etc.
  severity VARCHAR(50),                     -- 'low', 'medium', 'high', 'critical'
  
  user_id UUID REFERENCES users(id),
  ip_address VARCHAR(50),
  user_agent TEXT,
  
  description TEXT,
  details JSONB,
  
  is_resolved BOOLEAN DEFAULT false,
  resolved_at TIMESTAMP,
  
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================================
-- 15. BACKUPS & SYSTEM HEALTH (Milestone 12)
-- ============================================================================

CREATE TABLE backup_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  
  backup_type VARCHAR(50),                  -- 'full', 'incremental'
  backup_location VARCHAR(500),             -- S3 path
  
  status VARCHAR(50),                       -- 'pending', 'running', 'success', 'failed'
  
  size_bytes BIGINT,
  records_backed_up BIGINT,
  
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  
  restoration_tested BOOLEAN DEFAULT false,
  restoration_date TIMESTAMP,
  
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE system_health (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  
  check_type VARCHAR(100),                  -- 'database', 'api', 'connectors', 'search', etc.
  status VARCHAR(50),                       -- 'healthy', 'degraded', 'failed'
  
  details JSONB,
  response_time_ms INTEGER,
  
  checked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================================
-- 16. FULL-TEXT SEARCH & INDEXING
-- ============================================================================

CREATE INDEX opportunities_title ON opportunities USING BTREE(title);
CREATE INDEX opportunities_description_trgm ON opportunities USING GIN(description gin_trgm_ops);

-- Materialized view for fast search (refresh periodically)
CREATE MATERIALIZED VIEW opportunity_search_index AS
SELECT 
  o.id,
  o.title,
  o.description,
  o.location_city,
  o.location_region,
  o.deadline,
  o.estimated_value,
  ot.code as opportunity_type,
  t.name as trade_name,
  c.code as brand_code,
  ds.code as source_code,
  (
    to_tsvector('french', COALESCE(o.title, '')) ||
    to_tsvector('french', COALESCE(o.description, ''))
  ) as search_vector
FROM opportunities o
LEFT JOIN opportunity_types ot ON o.opportunity_type_id = ot.id
LEFT JOIN trades t ON o.trade_id = t.id
LEFT JOIN data_sources ds ON o.source_id = ds.id
LEFT JOIN brands c ON ot.brand_id = c.id
WHERE o.deleted_at IS NULL AND o.status NOT IN ('cancelled', 'expired');

CREATE INDEX opportunity_search_index_search ON opportunity_search_index USING GIN(search_vector);
CREATE INDEX opportunity_search_index_deadline ON opportunity_search_index(deadline);
-- Required for REFRESH MATERIALIZED VIEW CONCURRENTLY (see jobs/searchIndexRefresh.ts) -
-- without a unique index, a concurrent refresh isn't possible and every refresh
-- would briefly lock the view against reads while it rebuilds.
CREATE UNIQUE INDEX opportunity_search_index_id ON opportunity_search_index(id);

-- ============================================================================
-- 17. CONSTRAINTS & TRIGGERS
-- ============================================================================

-- Prevent a company's private records from being silently reassigned to another
-- company via a buggy/malicious UPDATE. This was previously attached to the
-- `opportunities` table (which has no company_id column at all - global tender
-- listings, not per-company data) and called a function that was never defined,
-- so it silently failed to create and enforced nothing. Fixed to define the
-- function and attach it to the tables that actually hold per-company data.
-- Note: this covers UPDATE/INSERT only, not SELECT - the application layer
-- (WHERE company_id = $1 on every company-scoped query, already the pattern
-- used in routes/tenders.ts etc.) remains the primary defense; this trigger is
-- a DB-level backstop against company_id ever being changed after the fact,
-- not a replacement for row-level security.
CREATE OR REPLACE FUNCTION prevent_cross_company_access()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.company_id IS DISTINCT FROM NEW.company_id THEN
    RAISE EXCEPTION 'company_id cannot be changed once a record is created (attempted % -> %)',
      OLD.company_id, NEW.company_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER check_company_isolation_bid_responses
BEFORE UPDATE ON bid_responses
FOR EACH ROW
EXECUTE FUNCTION prevent_cross_company_access();

CREATE TRIGGER check_company_isolation_company_documents
BEFORE UPDATE ON company_documents
FOR EACH ROW
EXECUTE FUNCTION prevent_cross_company_access();

-- Auto-update timestamps
CREATE OR REPLACE FUNCTION update_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER opportunities_timestamp BEFORE UPDATE ON opportunities
FOR EACH ROW EXECUTE FUNCTION update_timestamp();

CREATE TRIGGER companies_timestamp BEFORE UPDATE ON companies
FOR EACH ROW EXECUTE FUNCTION update_timestamp();

CREATE TRIGGER users_timestamp BEFORE UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION update_timestamp();

-- Auto-mark opportunities as expired
CREATE OR REPLACE FUNCTION check_opportunity_expiry()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.deadline < CURRENT_TIMESTAMP AND NEW.status = 'active' THEN
    NEW.status = 'expired';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER opportunity_expiry BEFORE UPDATE ON opportunities
FOR EACH ROW EXECUTE FUNCTION check_opportunity_expiry();

-- Auto-mark documents as expired
CREATE OR REPLACE FUNCTION check_document_expiry()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.expiry_date < CURRENT_DATE AND NEW.is_expired = false THEN
    NEW.is_expired = true;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER document_expiry BEFORE UPDATE ON company_documents
FOR EACH ROW EXECUTE FUNCTION check_document_expiry();

-- ============================================================================
-- INITIAL DATA
-- ============================================================================

INSERT INTO brands (code, name, domain) VALUES
('brand_1', 'BOAMP Pro', 'boamp-pro.fr'),
('brand_2', 'Marchés Locaux', 'marches-locaux.fr');

INSERT INTO opportunity_types (code, name) VALUES
('tender', 'Tenders - Private Contracts'),
('public_procurement', 'Public Procurement'),
('subcontracting', 'Subcontracting');

INSERT INTO subscription_plans (name, price, billing_period, features) VALUES
('Starter', 29.00, 'monthly', '{"opportunities": 50, "bids": 5, "support": "email"}'),
('Pro', 99.00, 'monthly', '{"opportunities": 500, "bids": 50, "support": "priority"}'),
('Enterprise', 299.00, 'monthly', '{"opportunities": -1, "bids": -1, "support": "dedicated"}');

-- Create initial data sources
INSERT INTO data_sources (code, name, feed_type, frequency_hours, active) VALUES
('boamp', 'BOAMP Official Feed', 'api', 6, true),
('place', 'PLACE Government Platform', 'api', 6, false),
('ted', 'TED EU Tenders', 'api', 12, false);

-- BTP/construction CPV codes (real EU Common Procurement Vocabulary, division 45xxxxxx)
-- and the trades that map to them. Without this, classification and matching have
-- nothing to link opportunities/companies to - both would silently return empty
-- results even with a working AI classification call.
INSERT INTO cpv_codes (code, name, sector) VALUES
('45000000', 'Construction work', 'construction'),
('45111000', 'Demolition, site clearance and site preparation work', 'construction'),
('45210000', 'Building construction work', 'construction'),
('45223000', 'Structural works', 'construction'),
('45261000', 'Roof works and other special trade construction works', 'construction'),
('45262500', 'Masonry and bricklaying work', 'construction'),
('45310000', 'Electrical installation work', 'construction'),
('45330000', 'Plumbing and sanitary works', 'construction'),
('45331000', 'Heating, ventilation and air-conditioning installation work', 'construction'),
('45320000', 'Insulation work', 'construction'),
('45410000', 'Plastering work', 'construction'),
('45420000', 'Joinery and carpentry installation work', 'construction'),
('45430000', 'Floor and wall covering work', 'construction'),
('45440000', 'Painting and glazing work', 'construction'),
('45233000', 'Road construction work', 'construction'),
('45232000', 'Ancillary works for pipelines and cables', 'construction')
ON CONFLICT (code) DO NOTHING;

INSERT INTO trades (name, slug, description, cpv_code_id) VALUES
('Gros oeuvre', 'gros-oeuvre', 'Structural work, foundations, load-bearing walls', (SELECT id FROM cpv_codes WHERE code = '45223000')),
('Demolition', 'demolition', 'Demolition, site clearance and preparation', (SELECT id FROM cpv_codes WHERE code = '45111000')),
('Maconnerie', 'maconnerie', 'Masonry and bricklaying', (SELECT id FROM cpv_codes WHERE code = '45262500')),
('Charpente', 'charpente', 'Roof framing and structural carpentry', (SELECT id FROM cpv_codes WHERE code = '45261000')),
('Couverture', 'couverture', 'Roofing and roof waterproofing', (SELECT id FROM cpv_codes WHERE code = '45261000')),
('Electricite', 'electricite', 'Electrical installation work', (SELECT id FROM cpv_codes WHERE code = '45310000')),
('Plomberie', 'plomberie', 'Plumbing and sanitary installation', (SELECT id FROM cpv_codes WHERE code = '45330000')),
('CVC', 'cvc', 'Heating, ventilation and air conditioning', (SELECT id FROM cpv_codes WHERE code = '45331000')),
('Isolation', 'isolation', 'Thermal and acoustic insulation', (SELECT id FROM cpv_codes WHERE code = '45320000')),
('Platrerie', 'platrerie', 'Plastering and drywall', (SELECT id FROM cpv_codes WHERE code = '45410000')),
('Menuiserie', 'menuiserie', 'Joinery, windows and doors', (SELECT id FROM cpv_codes WHERE code = '45420000')),
('Carrelage', 'carrelage', 'Floor and wall tiling', (SELECT id FROM cpv_codes WHERE code = '45430000')),
('Peinture', 'peinture', 'Painting and surface finishing', (SELECT id FROM cpv_codes WHERE code = '45440000')),
('Vitrerie', 'vitrerie', 'Glazing work', (SELECT id FROM cpv_codes WHERE code = '45440000')),
('Voirie et reseaux (VRD)', 'vrd', 'Road works and utility networks', (SELECT id FROM cpv_codes WHERE code = '45233000')),
('Batiment general', 'batiment-general', 'General building construction', (SELECT id FROM cpv_codes WHERE code = '45210000'))
ON CONFLICT (name) DO NOTHING;
