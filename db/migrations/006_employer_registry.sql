-- Migration 006: Employer Registry Expansion (Milestone 2B)
-- Extends companies with domain normalization, lifecycle statuses, hierarchy, and aliases

ALTER TABLE companies ADD COLUMN website_url TEXT;
ALTER TABLE companies ADD COLUMN country TEXT;
ALTER TABLE companies ADD COLUMN industry TEXT;
ALTER TABLE companies ADD COLUMN size_band TEXT;
ALTER TABLE companies ADD COLUMN source_provenance TEXT DEFAULT 'manual';
ALTER TABLE companies ADD COLUMN lifecycle_status TEXT DEFAULT 'UNVERIFIED';
ALTER TABLE companies ADD COLUMN monitoring_status TEXT DEFAULT 'paused';
ALTER TABLE companies ADD COLUMN last_discovered_at TEXT;
ALTER TABLE companies ADD COLUMN last_verified_at TEXT;
ALTER TABLE companies ADD COLUMN parent_company_id TEXT REFERENCES companies(id);

-- Source Policy fine-grained permissions
ALTER TABLE source_policies ADD COLUMN discovery_permitted BOOLEAN DEFAULT 1;
ALTER TABLE source_policies ADD COLUMN public_nav_permitted BOOLEAN DEFAULT 1;
ALTER TABLE source_policies ADD COLUMN feed_access_permitted BOOLEAN DEFAULT 1;
ALTER TABLE source_policies ADD COLUMN authenticated_permitted BOOLEAN DEFAULT 0;
ALTER TABLE source_policies ADD COLUMN autofill_permitted BOOLEAN DEFAULT 0;
ALTER TABLE source_policies ADD COLUMN submission_permitted BOOLEAN DEFAULT 0;
ALTER TABLE source_policies ADD COLUMN notes TEXT;

-- Company Aliases table
CREATE TABLE IF NOT EXISTS company_aliases (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    alias TEXT NOT NULL,
    source TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(company_id, alias)
);

CREATE INDEX IF NOT EXISTS idx_company_aliases_alias ON company_aliases(alias);
CREATE INDEX IF NOT EXISTS idx_company_aliases_company ON company_aliases(company_id);
CREATE INDEX IF NOT EXISTS idx_companies_domain ON companies(domain);
CREATE INDEX IF NOT EXISTS idx_companies_lifecycle ON companies(lifecycle_status);
CREATE INDEX IF NOT EXISTS idx_companies_monitoring ON companies(monitoring_status);
CREATE INDEX IF NOT EXISTS idx_companies_parent ON companies(parent_company_id);

-- Backfill existing permitted companies with verified career URLs to APPROVED
UPDATE companies
SET lifecycle_status = 'APPROVED',
    monitoring_status = 'active',
    last_verified_at = CURRENT_TIMESTAMP
WHERE policy_status = 'permitted' AND career_url IS NOT NULL;

-- Backfill blocked companies to DISABLED
UPDATE companies
SET lifecycle_status = 'DISABLED',
    monitoring_status = 'disabled'
WHERE policy_status = 'blocked';

-- Backfill remaining companies
UPDATE companies
SET lifecycle_status = 'UNVERIFIED',
    monitoring_status = 'paused'
WHERE lifecycle_status IS NULL;

INSERT OR IGNORE INTO schema_migrations (version, name, applied_at)
VALUES ('006', 'employer_registry', CURRENT_TIMESTAMP);
