-- Migration 002: Candidate facts evidence ledger
-- Version: 1.0.0
-- Author: Claude Code (Phase 2 Integration)
--
-- Adds the candidate_facts table plus its index. This is the evidence
-- ledger that powers resume bullet selection: every claim a candidate
-- makes about their experience is stored as a fact with an evidence
-- type, so tailoring can pick resume-eligible bullets per role.
--
-- Safe to re-run: all statements use IF NOT EXISTS / INSERT OR IGNORE.

-- Migration ledger. Created here (not in 001) because 001 predates the
-- ledger; every subsequent migration inserts its own row at the end.
CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS candidate_facts (
    id TEXT PRIMARY KEY,
    category TEXT NOT NULL,           -- experience, project, skill, education
    identifier TEXT NOT NULL,          -- unique within category
    value TEXT NOT NULL,
    evidence_type TEXT,                -- work_experience, project, certification, self-attested
    evidence_url TEXT,
    verified BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(category, identifier, value)
);

CREATE INDEX IF NOT EXISTS idx_candidate_facts_category
    ON candidate_facts(category);

CREATE INDEX IF NOT EXISTS idx_candidate_facts_verified
    ON candidate_facts(verified);

-- Seed the schema_migrations ledger so migrate.js can track which
-- migrations have been applied. Idempotent via INSERT OR IGNORE.
INSERT OR IGNORE INTO schema_migrations (version, name, applied_at)
VALUES ('002', 'candidate_facts', CURRENT_TIMESTAMP);
