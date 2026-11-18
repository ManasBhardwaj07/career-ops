-- Migration 010: Application Execution State & Submission Authorization
-- Version: 1.0.0
-- Adds execution state tracking, portal detection, review packets, and explicit submission authorizations

-- 1. Extend applications table with execution lifecycle attributes
ALTER TABLE applications ADD COLUMN portal_type TEXT;
ALTER TABLE applications ADD COLUMN portal_url TEXT;
ALTER TABLE applications ADD COLUMN submission_policy TEXT DEFAULT 'MANUAL_REVIEW';
ALTER TABLE applications ADD COLUMN submission_authorization_id TEXT;
ALTER TABLE applications ADD COLUMN submission_authorized_at TEXT;
ALTER TABLE applications ADD COLUMN submission_authorized_by TEXT;
ALTER TABLE applications ADD COLUMN execution_metadata_json TEXT;
ALTER TABLE applications ADD COLUMN review_packet_path TEXT;
ALTER TABLE applications ADD COLUMN confirmation_reference TEXT;
ALTER TABLE applications ADD COLUMN error_details TEXT;
ALTER TABLE applications ADD COLUMN last_active_at TEXT;

-- 2. Extend application_events table with actor tracking
ALTER TABLE application_events ADD COLUMN actor TEXT DEFAULT 'system';

-- 3. Extend candidate_answers with human confirmation tracking
ALTER TABLE candidate_answers ADD COLUMN confirmed_by_user BOOLEAN DEFAULT 0;
ALTER TABLE candidate_answers ADD COLUMN confirmed_at TEXT;

-- 4. Create submission_authorizations table for auditable explicit authorization
CREATE TABLE IF NOT EXISTS submission_authorizations (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL CHECK (scope IN ('single', 'bounded_batch')),
    application_id TEXT REFERENCES applications(id),
    max_applications INTEGER DEFAULT 1,
    used_count INTEGER DEFAULT 0,
    allowed_company_ids_json TEXT,
    expires_at TEXT,
    authorized_by TEXT DEFAULT 'user',
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'used', 'expired', 'revoked')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 5. Helpful indexes for lifecycle queries
CREATE INDEX IF NOT EXISTS idx_applications_state ON applications(state);
CREATE INDEX IF NOT EXISTS idx_applications_job ON applications(job_id);
CREATE INDEX IF NOT EXISTS idx_applications_company ON applications(company_id);
CREATE INDEX IF NOT EXISTS idx_application_events_app ON application_events(application_id);
CREATE INDEX IF NOT EXISTS idx_submission_auth_app ON submission_authorizations(application_id);
CREATE INDEX IF NOT EXISTS idx_submission_auth_status ON submission_authorizations(status);

-- 6. Record migration
INSERT OR IGNORE INTO schema_migrations (version, name, applied_at)
VALUES ('010', 'application_execution_state', CURRENT_TIMESTAMP);
