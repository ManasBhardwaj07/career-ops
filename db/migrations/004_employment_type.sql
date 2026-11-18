-- Migration 004: Add employment_type column to job_postings
-- Version: 1.0.0
-- Author: Principal Architect (Milestone 2A ATS Discovery)
--
-- Enables standardized storage of employment type (full-time, part-time, contract, internship)
-- extracted from ATS APIs and career portals.

ALTER TABLE job_postings ADD COLUMN employment_type TEXT;

INSERT OR IGNORE INTO schema_migrations (version, name, applied_at)
VALUES ('004', 'employment_type', CURRENT_TIMESTAMP);
