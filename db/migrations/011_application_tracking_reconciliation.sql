-- Migration 011: Application Tracking, Historical Ledger & State Reconciliation
-- Version: 1.0.0
-- Establishes SQLite as authoritative application tracking store, supports post-submission
-- recruitment outcomes, event idempotency, and durable historical provenance ledger.

-- 1. Extend applications table with recruitment outcome and provenance attributes
ALTER TABLE applications ADD COLUMN recruitment_outcome TEXT CHECK (
    recruitment_outcome IN ('APPLIED', 'RESPONDED', 'INTERVIEW', 'OFFER', 'REJECTED', 'WITHDRAWN', 'DISCARDED', 'SKIP', NULL)
);
ALTER TABLE applications ADD COLUMN recruitment_outcome_at TEXT;
ALTER TABLE applications ADD COLUMN source_origin TEXT DEFAULT 'manual';
ALTER TABLE applications ADD COLUMN source_row_id TEXT;
ALTER TABLE applications ADD COLUMN external_reference TEXT;

-- 2. Extend application_events table with idempotency key and source origin
ALTER TABLE application_events ADD COLUMN idempotency_key TEXT;
ALTER TABLE application_events ADD COLUMN source_origin TEXT DEFAULT 'runtime';

-- 3. Create historical_tracker_ledger table for durable reconciliation
CREATE TABLE IF NOT EXISTS historical_tracker_ledger (
    id TEXT PRIMARY KEY,
    source_file TEXT NOT NULL,
    row_identifier TEXT,
    original_company TEXT,
    original_role TEXT,
    original_status TEXT,
    original_score TEXT,
    original_date TEXT,
    original_url TEXT,
    original_report TEXT,
    original_notes TEXT,
    classification TEXT NOT NULL CHECK (classification IN (
        'ACTUAL_APPLICATION_SUBMITTED',
        'APPLICATION_STARTED',
        'INTERVIEW_OR_RECRUITER_INTERACTION',
        'OFFER_OR_REJECTION',
        'EVALUATED_OPPORTUNITY',
        'DISCARDED_OPPORTUNITY',
        'DUPLICATE_HISTORICAL_RECORD',
        'UNRESOLVED_RECORD'
    )),
    resolved_company_id TEXT REFERENCES companies(id),
    resolved_job_id TEXT REFERENCES job_postings(id),
    resolved_application_id TEXT REFERENCES applications(id),
    resolution_status TEXT NOT NULL CHECK (resolution_status IN ('RESOLVED', 'PARTIAL', 'UNRESOLVED', 'DUPLICATE', 'DISCARDED_EVALUATION')),
    resolution_notes TEXT,
    raw_content TEXT,
    imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 4. Indexes for fast lookup, idempotency and provenance integrity
CREATE INDEX IF NOT EXISTS idx_applications_recruitment_outcome ON applications(recruitment_outcome);
CREATE UNIQUE INDEX IF NOT EXISTS idx_application_events_idempotency ON application_events(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ledger_source ON historical_tracker_ledger(source_file);
CREATE INDEX IF NOT EXISTS idx_ledger_status ON historical_tracker_ledger(resolution_status);
CREATE INDEX IF NOT EXISTS idx_ledger_app ON historical_tracker_ledger(resolved_application_id);

-- 5. Record migration
INSERT OR IGNORE INTO schema_migrations (version, name, applied_at)
VALUES ('011', 'application_tracking_reconciliation', CURRENT_TIMESTAMP);
