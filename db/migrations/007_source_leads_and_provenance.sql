-- Migration 007: Relational Search Leads, Provenance, and Submission Policy Gate (Milestone 3A)
-- Creates canonical search lead identity and multi-observation provenance tables

-- 1. Canonical Lead Identity Table
CREATE TABLE IF NOT EXISTS source_leads (
    id TEXT PRIMARY KEY,
    canonical_url TEXT NOT NULL UNIQUE,
    normalized_title TEXT,
    normalized_company_name TEXT,
    company_id TEXT REFERENCES companies(id) ON DELETE SET NULL,
    first_discovered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_observed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    observation_count INTEGER NOT NULL DEFAULT 1,
    resolved_job_id TEXT REFERENCES job_postings(id) ON DELETE SET NULL,
    resolution_status TEXT DEFAULT 'pending'
      CHECK (resolution_status IN ('pending', 'resolved_job', 'duplicate', 'unresolvable', 'rejected_unverified')),
    resolved_at TEXT,
    resolution_notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_source_leads_canonical ON source_leads(canonical_url);
CREATE INDEX IF NOT EXISTS idx_source_leads_status ON source_leads(resolution_status);
CREATE INDEX IF NOT EXISTS idx_source_leads_company ON source_leads(company_id);
CREATE INDEX IF NOT EXISTS idx_source_leads_job ON source_leads(resolved_job_id);

-- 2. Multi-Observation Provenance Table
CREATE TABLE IF NOT EXISTS source_lead_observations (
    id TEXT PRIMARY KEY,
    lead_id TEXT NOT NULL REFERENCES source_leads(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    query TEXT,
    raw_url TEXT NOT NULL,
    result_rank INTEGER,
    snippet TEXT,
    observed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    provider_payload_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_lead_obs_lead ON source_lead_observations(lead_id);
CREATE INDEX IF NOT EXISTS idx_lead_obs_provider ON source_lead_observations(provider);

-- 3. Company Submission Policy (Default: MANUAL_REVIEW)
ALTER TABLE companies ADD COLUMN submission_policy TEXT NOT NULL DEFAULT 'MANUAL_REVIEW'
  CHECK (submission_policy IN ('NEVER', 'MANUAL_REVIEW', 'AUTO_SUBMIT_ENABLED'));

INSERT OR IGNORE INTO schema_migrations (version, name, applied_at)
VALUES ('007', 'source_leads_and_provenance', CURRENT_TIMESTAMP);
