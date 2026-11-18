-- Migration 013: Autofill Profile Fields & Answer Bank Ledger
-- Version: 1.0.0
-- Implements Deliverable 5 Phase 0 (P0.3)
-- Adds answer_bank (multi-length variants with fact grounding) and autofill_profile_fields

-- 1. Answer Bank Table
CREATE TABLE IF NOT EXISTS answer_bank (
    id TEXT PRIMARY KEY,
    intent_key TEXT NOT NULL,
    variant_length TEXT NOT NULL CHECK (variant_length IN ('short', 'medium', 'long')),
    char_limit INTEGER NOT NULL,
    content TEXT NOT NULL,
    sensitive INTEGER NOT NULL DEFAULT 0,
    source_fact_refs TEXT, -- JSON array of fact_ids and evidence_ids
    confirmed_by_user INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(intent_key, variant_length)
);

CREATE INDEX IF NOT EXISTS idx_answer_bank_intent ON answer_bank(intent_key);
CREATE INDEX IF NOT EXISTS idx_answer_bank_confirmed ON answer_bank(confirmed_by_user);

-- 2. Autofill Profile Fields Table
CREATE TABLE IF NOT EXISTS autofill_profile_fields (
    id TEXT PRIMARY KEY,
    category TEXT NOT NULL,
    field_key TEXT UNIQUE NOT NULL,
    field_value TEXT,
    field_type TEXT NOT NULL DEFAULT 'text',
    is_sensitive INTEGER NOT NULL DEFAULT 0,
    confirmed_by_user INTEGER NOT NULL DEFAULT 0,
    source_of_truth TEXT,
    notes TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_autofill_fields_category ON autofill_profile_fields(category);
CREATE INDEX IF NOT EXISTS idx_autofill_fields_key ON autofill_profile_fields(field_key);

-- 3. Record Migration in Ledger
INSERT OR IGNORE INTO schema_migrations (version, name, applied_at)
VALUES ('013', 'autofill_and_answer_bank', CURRENT_TIMESTAMP);
