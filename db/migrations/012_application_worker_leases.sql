-- db/migrations/012_application_worker_leases.sql
-- Concurrency leases and claim recovery for background application workers

CREATE TABLE IF NOT EXISTS application_leases (
    application_id TEXT PRIMARY KEY,
    worker_id TEXT NOT NULL,
    claimed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    lease_expires_at TEXT NOT NULL,
    attempt_count INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'CLAIMED', -- 'CLAIMED', 'PROCESSING', 'RELEASED', 'EXPIRED', 'COMPLETED', 'UNCERTAIN', 'FAILED'
    last_heartbeat_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    error_message TEXT,
    FOREIGN KEY (application_id) REFERENCES applications(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_leases_status_expiry
ON application_leases(status, lease_expires_at);

INSERT OR IGNORE INTO schema_migrations (version, name, applied_at)
VALUES ('012', 'application_worker_leases', CURRENT_TIMESTAMP);
