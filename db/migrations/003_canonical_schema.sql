-- Migration 003: Canonical schema restoration (Deliverable 10)
-- Version: 1.0.0
-- Author: Principal Architect (Phase 1 Canonical Database)
--
-- Restores all canonical tables required by the Master Engineering Decision Document:
-- companies, source_policies, source_scans, job_postings, job_snapshots,
-- evidence_records, resume_versions, candidate_answers, applications,
-- application_events, duplicate_suggestions, and job_evaluations.
--
-- Safe forward-only migration: uses IF NOT EXISTS throughout.

-- 1. Companies / Employer Registry
CREATE TABLE IF NOT EXISTS companies (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    domain TEXT,
    career_url TEXT,
    ats_type TEXT,
    board_identifier TEXT,
    last_scanned_at TEXT,
    policy_status TEXT NOT NULL DEFAULT 'pending' CHECK (policy_status IN ('pending', 'permitted', 'blocked')),
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_companies_name ON companies(name);
CREATE INDEX IF NOT EXISTS idx_companies_policy ON companies(policy_status);

-- 2. Source Policies
CREATE TABLE IF NOT EXISTS source_policies (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    source_type TEXT NOT NULL CHECK (source_type IN ('greenhouse', 'lever', 'ashby', 'workday', 'smartrecruiters', 'search', 'sitemap', 'crawler', 'custom')),
    endpoint TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT 1,
    policy_approved_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(company_id, source_type, endpoint)
);

CREATE INDEX IF NOT EXISTS idx_source_policies_company ON source_policies(company_id);
CREATE INDEX IF NOT EXISTS idx_source_policies_enabled ON source_policies(enabled);

-- 3. Source Scans
CREATE TABLE IF NOT EXISTS source_scans (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    source_type TEXT NOT NULL,
    started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TEXT,
    total_jobs INTEGER NOT NULL DEFAULT 0,
    new_jobs INTEGER NOT NULL DEFAULT 0,
    duplicate_jobs INTEGER NOT NULL DEFAULT 0,
    errors INTEGER NOT NULL DEFAULT 0,
    is_complete BOOLEAN NOT NULL DEFAULT 0,
    error_details TEXT
);

CREATE INDEX IF NOT EXISTS idx_source_scans_company ON source_scans(company_id);
CREATE INDEX IF NOT EXISTS idx_source_scans_started ON source_scans(started_at);

-- 4. Job Postings
CREATE TABLE IF NOT EXISTS job_postings (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    location TEXT,
    remote_type TEXT CHECK (remote_type IN ('remote', 'hybrid', 'onsite', NULL)),
    applicant_eligibility TEXT,
    job_url TEXT NOT NULL UNIQUE,
    description TEXT,
    source TEXT NOT NULL,
    source_job_id TEXT,
    source_updated_at TEXT,
    discovered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    status TEXT NOT NULL DEFAULT 'discovered',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_job_postings_company ON job_postings(company_id);
CREATE INDEX IF NOT EXISTS idx_job_postings_discovered ON job_postings(discovered_at);
CREATE INDEX IF NOT EXISTS idx_job_postings_status ON job_postings(status);
CREATE INDEX IF NOT EXISTS idx_job_postings_title ON job_postings(title);

-- 5. Job Snapshots
CREATE TABLE IF NOT EXISTS job_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL REFERENCES job_postings(id) ON DELETE CASCADE,
    raw_json TEXT,
    fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_job_snapshots_job_id ON job_snapshots(job_id);

-- 6. Evidence Records (linking candidate facts to concrete proof points)
CREATE TABLE IF NOT EXISTS evidence_records (
    id TEXT PRIMARY KEY,
    fact_id TEXT NOT NULL REFERENCES candidate_facts(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    source_type TEXT NOT NULL CHECK (source_type IN ('work_experience', 'project', 'education', 'certification', 'self-attested')),
    source_reference TEXT NOT NULL,
    verified BOOLEAN NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_evidence_records_fact ON evidence_records(fact_id);
CREATE INDEX IF NOT EXISTS idx_evidence_records_source_type ON evidence_records(source_type);

-- 7. Resume Versions
CREATE TABLE IF NOT EXISTS resume_versions (
    id TEXT PRIMARY KEY,
    job_id TEXT REFERENCES job_postings(id) ON DELETE SET NULL,
    format TEXT NOT NULL CHECK (format IN ('html', 'pdf', 'tex')),
    file_path TEXT NOT NULL,
    page_count INTEGER,
    bullet_selection_json TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_resume_versions_job ON resume_versions(job_id);

-- 8. Candidate Answers / Answer Bank
CREATE TABLE IF NOT EXISTS candidate_answers (
    id TEXT PRIMARY KEY,
    question_key TEXT NOT NULL UNIQUE,
    question_text TEXT NOT NULL,
    answer_value TEXT NOT NULL,
    context TEXT,
    source TEXT NOT NULL DEFAULT 'verified_profile',
    confidence REAL NOT NULL DEFAULT 1.0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_candidate_answers_key ON candidate_answers(question_key);

-- 9. Applications
CREATE TABLE IF NOT EXISTS applications (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL UNIQUE REFERENCES job_postings(id) ON DELETE CASCADE,
    company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    resume_version_id TEXT REFERENCES resume_versions(id) ON DELETE SET NULL,
    state TEXT NOT NULL DEFAULT 'DISCOVERED',
    score REAL,
    score_details_json TEXT,
    notes TEXT,
    report_path TEXT,
    started_at TEXT,
    submitted_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_applications_job ON applications(job_id);
CREATE INDEX IF NOT EXISTS idx_applications_company ON applications(company_id);
CREATE INDEX IF NOT EXISTS idx_applications_state ON applications(state);

-- 10. Application Events (Audit log for state transitions & recovery)
CREATE TABLE IF NOT EXISTS application_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    previous_state TEXT,
    new_state TEXT NOT NULL,
    event_type TEXT NOT NULL,
    message TEXT,
    payload_json TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_application_events_app ON application_events(application_id);
CREATE INDEX IF NOT EXISTS idx_application_events_created ON application_events(created_at);

-- 11. Duplicate Suggestions
CREATE TABLE IF NOT EXISTS duplicate_suggestions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    original_job_id TEXT NOT NULL REFERENCES job_postings(id) ON DELETE CASCADE,
    duplicate_job_id TEXT NOT NULL REFERENCES job_postings(id) ON DELETE CASCADE,
    confidence REAL NOT NULL,
    reasons TEXT,
    resolved BOOLEAN NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(original_job_id, duplicate_job_id)
);

CREATE INDEX IF NOT EXISTS idx_duplicate_suggestions_orig ON duplicate_suggestions(original_job_id);

-- 12. Job Evaluations
CREATE TABLE IF NOT EXISTS job_evaluations (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL UNIQUE REFERENCES job_postings(id) ON DELETE CASCADE,
    archetype TEXT,
    match_score REAL,
    recommendation TEXT CHECK (recommendation IN ('APPLY', 'CONSIDER', 'DO_NOT_APPLY')),
    eval_details_json TEXT,
    evaluated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_job_evaluations_job ON job_evaluations(job_id);
CREATE INDEX IF NOT EXISTS idx_job_evaluations_score ON job_evaluations(match_score);

-- Record migration in schema_migrations ledger
INSERT OR IGNORE INTO schema_migrations (version, name, applied_at)
VALUES ('003', 'canonical_schema', CURRENT_TIMESTAMP);
