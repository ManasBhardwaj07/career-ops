/**
 * discovery/adapters/hirist-adapter.mjs — Hirist Discovery Adapter & Liveness Probe
 *
 * Implements Deliverable 5 Phase 4 (D2):
 *   - Probes and checks Hirist API / public feed status
 *   - Documents live/dead status and Cloudflare/auth gates
 *   - Auto-quarantines per Rule R20 if endpoint is dead or repeatedly unreachable
 *   - Normalizes valid tech listings to standardized career-ops contract
 */

import { createNormalizedJob, fetchWithRetry, detectRemoteType } from './base.mjs';
import { sourceQuarantine } from '../source-quarantine.mjs';

export const HIRIST_BASE_URL = 'https://www.hirist.tech';
export const HIRIST_SEARCH_ENDPOINT = 'https://www.hirist.tech/api/job/search';

export class HiristAdapter {
    constructor({ fetchFn = fetch } = {}) {
        this.fetchFn = fetchFn;
        this.provider = 'hirist';
    }

    /**
     * Parses Hirist response into normalized career-ops jobs.
     */
    parseResponse(rawData) {
        if (!rawData) return [];

        let data = rawData;
        if (typeof rawData === 'string') {
            try {
                data = JSON.parse(rawData);
            } catch {
                return [];
            }
        }

        const items = data.jobs || data.data || data.results || (Array.isArray(data) ? data : []);
        const normalized = [];

        for (const item of items) {
            if (!item || typeof item !== 'object') continue;

            const title = item.title || item.jobTitle || item.designation;
            if (!title) continue;

            const jobUrl = item.url || item.jobUrl || (item.id ? `${HIRIST_BASE_URL}/j/${item.id}` : null);
            if (!jobUrl) continue;

            const companyName = item.company || item.companyName || 'Confidential Tech Employer';
            const location = item.location || item.city || 'India';
            const remoteType = detectRemoteType(title, location);

            try {
                const job = createNormalizedJob({
                    company_name: companyName,
                    title,
                    location,
                    remote_type: remoteType,
                    applicant_eligibility: 'Open to India',
                    employment_type: 'full-time',
                    job_url: jobUrl,
                    description: item.description || item.jobDescription || '',
                    source: 'hirist',
                    source_job_id: item.id ? `hirist_${item.id}` : null,
                    raw: item
                });
                normalized.push(job);
            } catch {
                // Ignore single job normalization error
            }
        }

        return normalized;
    }

    /**
     * Probes Hirist endpoint liveness and fetches jobs.
     * Records health and enforces Rule R20 quarantine.
     */
    async fetchJobs({ query = 'Full Stack Developer', location = 'India' } = {}) {
        if (sourceQuarantine.isSourceQuarantined('hirist')) {
            const status = sourceQuarantine.getSourceQuarantineStatus('hirist');
            return {
                jobs: [],
                quarantined: true,
                quarantineReason: status.quarantineReason,
                endpointStatus: 'quarantined'
            };
        }

        try {
            const res = await fetchWithRetry(HIRIST_SEARCH_ENDPOINT, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query, location })
            }, { fetchFn: this.fetchFn, retries: 1, timeoutMs: 8000 });

            const data = await res.json();
            const jobs = this.parseResponse(data);

            sourceQuarantine.recordSourceRun('hirist', { jobsFound: jobs.length });
            return {
                jobs,
                quarantined: false,
                endpointStatus: 'live'
            };
        } catch (err) {
            // Document error and record zero run for R20
            const errorMsg = err.message || 'Unknown network error';
            sourceQuarantine.recordSourceRun('hirist', { jobsFound: 0, error: err });
            const isNowQuarantined = sourceQuarantine.isSourceQuarantined('hirist');

            return {
                jobs: [],
                quarantined: isNowQuarantined,
                quarantineReason: isNowQuarantined ? sourceQuarantine.getSourceQuarantineStatus('hirist').quarantineReason : null,
                endpointStatus: 'dead_or_blocked',
                error: errorMsg
            };
        }
    }
}

export function fetchHiristJobs(options = {}) {
    const adapter = new HiristAdapter(options);
    return adapter.fetchJobs(options);
}
