-- Migration 005: Discovery Refinements, Telemetry, and Content Hashing
-- Adds content hashing, last_seen_at, content_updated_at, and granular scan telemetry

ALTER TABLE job_postings ADD COLUMN last_seen_at TEXT;
ALTER TABLE job_postings ADD COLUMN content_hash TEXT;
ALTER TABLE job_postings ADD COLUMN content_updated_at TEXT;

ALTER TABLE job_snapshots ADD COLUMN content_hash TEXT;

ALTER TABLE source_scans ADD COLUMN fetched_count INTEGER DEFAULT 0;
ALTER TABLE source_scans ADD COLUMN normalized_count INTEGER DEFAULT 0;
ALTER TABLE source_scans ADD COLUMN inserted_count INTEGER DEFAULT 0;
ALTER TABLE source_scans ADD COLUMN updated_count INTEGER DEFAULT 0;
ALTER TABLE source_scans ADD COLUMN unchanged_count INTEGER DEFAULT 0;
ALTER TABLE source_scans ADD COLUMN invalid_count INTEGER DEFAULT 0;
ALTER TABLE source_scans ADD COLUMN duplicate_in_source_count INTEGER DEFAULT 0;
ALTER TABLE source_scans ADD COLUMN eligible_count INTEGER DEFAULT 0;

-- Backfill last_seen_at and content_updated_at for existing jobs
UPDATE job_postings
SET last_seen_at = COALESCE(updated_at, created_at, CURRENT_TIMESTAMP),
    content_updated_at = COALESCE(updated_at, created_at, CURRENT_TIMESTAMP)
WHERE last_seen_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_job_postings_content_hash ON job_postings(content_hash);
CREATE INDEX IF NOT EXISTS idx_job_postings_last_seen ON job_postings(last_seen_at);
CREATE INDEX IF NOT EXISTS idx_job_snapshots_content_hash ON job_snapshots(content_hash);

INSERT OR IGNORE INTO schema_migrations (version, name, applied_at)
VALUES ('005', 'discovery_refinements', CURRENT_TIMESTAMP);
