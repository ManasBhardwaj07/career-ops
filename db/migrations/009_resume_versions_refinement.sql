-- Migration 009: Resume versions refinement
-- Version: 1.0.0
-- Adds html_path, tailored flag, tailoring facts, variant label, and ATS parse results

ALTER TABLE resume_versions ADD COLUMN html_path TEXT;
ALTER TABLE resume_versions ADD COLUMN tailored BOOLEAN DEFAULT 0;
ALTER TABLE resume_versions ADD COLUMN tailoring_facts_json TEXT;
ALTER TABLE resume_versions ADD COLUMN variant_label TEXT;
ALTER TABLE resume_versions ADD COLUMN ats_parse_score REAL;
ALTER TABLE resume_versions ADD COLUMN ats_parse_result_json TEXT;

CREATE INDEX IF NOT EXISTS idx_resume_versions_job_id ON resume_versions(job_id);
CREATE INDEX IF NOT EXISTS idx_resume_versions_variant ON resume_versions(variant_label);

INSERT OR IGNORE INTO schema_migrations (version, name, applied_at)
VALUES ('009', 'resume_versions_refinement', CURRENT_TIMESTAMP);
