/**
 * discovery/source-quarantine.mjs — Rule R20 Operational Source Quarantine Manager
 *
 * Implements Rule R20 & Forensic Audit Corrections:
 *   - Strictly distinguishes operational failures (HTTP error, timeout, 403/CAPTCHA, parse crash)
 *     from healthy zero-vacancy responses (HTTP 200 with 0 matching jobs).
 *   - Auto-quarantines a source ONLY when repeated operational failures reach threshold (default: 3).
 *   - Healthy empty responses confirm endpoint liveness and reset operational failure counts.
 *   - Successful non-zero runs lift quarantine and restore full polling.
 */

import fs from 'fs';
import path from 'path';

const DEFAULT_STATE_FILE = path.resolve('data/source_quarantine_state.json');

export class SourceQuarantineManager {
    constructor({ stateFile = DEFAULT_STATE_FILE, threshold = 3 } = {}) {
        this.stateFile = stateFile;
        this.threshold = threshold;
        this.state = this._loadState();
    }

    _loadState() {
        try {
            if (fs.existsSync(this.stateFile)) {
                return JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
            }
        } catch {
            // Ignore parse errors, fallback to clean state
        }
        return { sources: {} };
    }

    _saveState() {
        try {
            const dir = path.dirname(this.stateFile);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2), 'utf8');
        } catch {
            // Non-fatal if state cannot be saved in read-only environment
        }
    }

    /**
     * Records a scan run for a given source key.
     * Distinguishes operational errors from healthy empty responses.
     *
     * @param {string} sourceKey - e.g. 'internshala', 'hirist', 'remoteok'
     * @param {object} result - { jobsFound: number, error: Error|string|null }
     * @returns {object} updated source quarantine state
     */
    recordSourceRun(sourceKey, { jobsFound = 0, error = null } = {}) {
        if (!sourceKey) throw new Error('sourceKey is required');

        const key = sourceKey.toLowerCase().trim();
        const existing = this.state.sources[key] || {
            consecutiveOperationalFailures: 0,
            consecutiveEmptyRuns: 0,
            totalRuns: 0,
            quarantined: false,
            quarantineReason: null,
            quarantinedAt: null,
            lastRunAt: null,
            lastJobsFound: 0,
            lastError: null,
            lastErrorType: null,
            retryAfterMs: 0,
            retired: false,
            retirementReason: null
        };

        existing.totalRuns += 1;
        existing.lastRunAt = new Date().toISOString();
        existing.lastJobsFound = jobsFound;
        existing.lastError = error ? (typeof error === 'string' ? error : error.message) : null;

        if (error) {
            const errStr = (existing.lastError || '').toLowerCase();
            let errType = 'UNKNOWN';
            if (errStr.includes('403') || errStr.includes('forbidden') || errStr.includes('challenge')) errType = 'HTTP_403';
            else if (errStr.includes('429') || errStr.includes('too many') || errStr.includes('rate limit')) errType = 'HTTP_429';
            else if (errStr.includes('500') || errStr.includes('502') || errStr.includes('503') || errStr.includes('504')) errType = 'HTTP_5XX';
            else if (errStr.includes('timeout') || errStr.includes('aborted')) errType = 'TIMEOUT';
            else if (errStr.includes('auth') || errStr.includes('unauthorized') || errStr.includes('401')) errType = 'AUTH_REQUIRED';
            else if (errStr.includes('json') || errStr.includes('syntax') || errStr.includes('parse')) errType = 'PARSER_FAILURE';

            existing.lastErrorType = errType;
            existing.consecutiveOperationalFailures += 1;

            // Exponential backoff calculation (base: 1 minute, doubling per failure, max: 24 hours)
            const backoffMinutes = Math.min(1440, Math.pow(2, existing.consecutiveOperationalFailures));
            existing.retryAfterMs = Date.now() + (backoffMinutes * 60 * 1000);

            if (existing.consecutiveOperationalFailures >= this.threshold && !existing.quarantined) {
                existing.quarantined = true;
                existing.quarantinedAt = new Date().toISOString();
                existing.quarantineReason = `Rule R20: Source encountered ${existing.consecutiveOperationalFailures} consecutive operational failures (${errType}: ${existing.lastError})`;
            }
        } else {
            // Successful HTTP response without operational error
            existing.consecutiveOperationalFailures = 0; // Healthy probe resets failure counter
            existing.lastErrorType = null;
            existing.retryAfterMs = 0;

            if (jobsFound > 0) {
                existing.consecutiveEmptyRuns = 0;
                if (existing.quarantined) {
                    existing.quarantined = false;
                    existing.quarantineReason = null;
                    existing.quarantinedAt = null;
                }
            } else {
                // Healthy response with 0 vacancies (normal empty state, NOT an error)
                existing.consecutiveEmptyRuns += 1;
            }
        }

        this.state.sources[key] = existing;
        this._saveState();

        return existing;
    }

    /**
     * Checks if a source is currently quarantined.
     */
    isSourceQuarantined(sourceKey) {
        if (!sourceKey) return false;
        const key = sourceKey.toLowerCase().trim();
        const record = this.state.sources[key];
        return Boolean(record && record.quarantined);
    }

    /**
     * Gets quarantine status and diagnostics for a source.
     */
    getSourceQuarantineStatus(sourceKey) {
        if (!sourceKey) return null;
        const key = sourceKey.toLowerCase().trim();
        return this.state.sources[key] || {
            consecutiveOperationalFailures: 0,
            consecutiveEmptyRuns: 0,
            totalRuns: 0,
            quarantined: false,
            quarantineReason: null
        };
    }

    /**
     * Explicitly forces quarantine on a source (e.g. permanently dead endpoint).
     */
    quarantineSource(sourceKey, reason = 'Manually quarantined or endpoint verified dead') {
        const key = sourceKey.toLowerCase().trim();
        const existing = this.getSourceQuarantineStatus(key);
        existing.quarantined = true;
        existing.quarantineReason = reason;
        existing.quarantinedAt = new Date().toISOString();
        this.state.sources[key] = existing;
        this._saveState();
        return existing;
    }

    /**
     * Manually lifts quarantine on a source.
     */
    unquarantineSource(sourceKey) {
        const key = sourceKey.toLowerCase().trim();
        if (this.state.sources[key]) {
            this.state.sources[key].quarantined = false;
            this.state.sources[key].quarantineReason = null;
            this.state.sources[key].quarantinedAt = null;
            this.state.sources[key].consecutiveOperationalFailures = 0;
            this.state.sources[key].retryAfterMs = 0;
            this._saveState();
        }
    }

    /**
     * Marks a source as permanently retired (e.g. decommissioned domain or service shutdown).
     */
    retireSource(sourceKey, reason = 'Permanently retired') {
        const key = sourceKey.toLowerCase().trim();
        const existing = this.getSourceQuarantineStatus(key);
        existing.retired = true;
        existing.retirementReason = reason;
        existing.quarantined = true;
        existing.quarantineReason = `RETIRED: ${reason}`;
        this.state.sources[key] = existing;
        this._saveState();
        return existing;
    }

    /**
     * Checks if a source has been retired.
     */
    isSourceRetired(sourceKey) {
        if (!sourceKey) return false;
        const key = sourceKey.toLowerCase().trim();
        const record = this.state.sources[key];
        return Boolean(record && record.retired);
    }
}

// Global default singleton
export const sourceQuarantine = new SourceQuarantineManager();
