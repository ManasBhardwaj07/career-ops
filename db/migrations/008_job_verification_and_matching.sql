-- Migration 008: Job Verification Metadata and Multi-Tier Evaluation Runs (Milestone 3B)
-- Adds orthogonal verification metadata to job_postings and creates job_evaluation_runs ledger

-- 1. Add verification metadata to job_postings (status remains single authoritative lifecycle status)
ALTER TABLE job_postings ADD COLUMN last_verified_at TEXT;
ALTER TABLE job_postings ADD COLUMN verification_method TEXT;

-- 2. Create job_evaluation_runs ledger
CREATE TABLE IF NOT EXISTS job_evaluation_runs (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES job_postings(id) ON DELETE CASCADE,
    run_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    eval_version TEXT NOT NULL,
    input_hash TEXT,
    tier1_passed INTEGER NOT NULL,            -- 0 or 1
    tier1_matched_titles TEXT,                -- JSON string array
    tier2_eligibility TEXT NOT NULL CHECK (tier2_eligibility IN ('PASS', 'FAIL', 'UNKNOWN')),
    tier2_gates_json TEXT NOT NULL,           -- JSON array of gate decisions
    tier3_match_score REAL,                   -- 0.0 to 1.0 (NULL if tier1 or tier2 failed)
    tier3_breakdown_json TEXT,                -- JSON array of requirement matches
    matched_fact_ids TEXT,                    -- JSON array of candidate_facts IDs
    evidence_ids TEXT,                        -- JSON array of evidence_records IDs
    missing_evidence_facts TEXT,              -- JSON array of requirements lacking evidence
    recommendation TEXT NOT NULL CHECK (recommendation IN ('APPLY', 'CONSIDER', 'DO_NOT_APPLY', 'UNKNOWN')),
    notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_job_eval_runs_job ON job_evaluation_runs(job_id);
CREATE INDEX IF NOT EXISTS idx_job_eval_runs_rec ON job_evaluation_runs(recommendation);
CREATE INDEX IF NOT EXISTS idx_job_eval_runs_hash ON job_evaluation_runs(input_hash);

INSERT OR IGNORE INTO schema_migrations (version, name, applied_at)
VALUES ('008', 'job_verification_and_matching', CURRENT_TIMESTAMP);
