/**
 * discovery/adapters/internshala-adapter.mjs — Internshala Discovery Adapter
 *
 * Implements Deliverable 5 Phase 4 (D1):
 *   - Connects Internshala public/entry-level tech job & internship listings
 *   - Normalizes to standardized career-ops job schema (createNormalizedJob)
 *   - Handles both JSON API feeds and HTML/structured dictionary responses
 *   - Enforces Rule R20 quarantine integration
 */

import { createNormalizedJob, fetchWithRetry, detectRemoteType, detectEmploymentType } from './base.mjs';
import { sourceQuarantine } from '../source-quarantine.mjs';

export const INTERNSHALA_BASE_URL = 'https://internshala.com';
export const INTERNSHALA_API_ENDPOINT = 'https://internshala.com/api/v1/internships/search';

export class InternshalaAdapter {
    constructor({ fetchFn = fetch } = {}) {
        this.fetchFn = fetchFn;
        this.provider = 'internshala';
    }

    /**
     * Parses an Internshala response into normalized career-ops jobs.
     * @param {object|string} rawData - Response JSON or string
     * @returns {Array<object>} Normalized jobs
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

        const normalizedJobs = [];

        // Internshala search API commonly returns { internships_meta: { ... } } or { jobs_meta: { ... } }
        const items = data.internships_meta || data.jobs_meta || data.jobs || data.data || (Array.isArray(data) ? data : []);

        const jobEntries = Array.isArray(items) ? items : Object.values(items);

        for (const entry of jobEntries) {
            if (!entry || typeof entry !== 'object') continue;

            const title = entry.title || entry.profile_name || entry.designation;
            if (!title) continue;

            const relativeUrl = entry.url || entry.job_url || entry.detail_url || '';
            const jobUrl = relativeUrl.startsWith('http')
                ? relativeUrl
                : `${INTERNSHALA_BASE_URL}${relativeUrl.startsWith('/') ? '' : '/'}${relativeUrl}`;

            const companyName = entry.company_name || entry.company || entry.employer_name || 'Confidential';

            // Location handling
            let location = 'India';
            if (Array.isArray(entry.location_names) && entry.location_names.length > 0) {
                location = entry.location_names.join(', ');
            } else if (entry.location) {
                location = String(entry.location);
            }

            // Remote / WFH detection
            let remoteType = 'onsite';
            if (entry.is_work_from_home || entry.work_from_home || entry.is_remote) {
                remoteType = 'remote';
            } else {
                remoteType = detectRemoteType(title, location);
            }

            const stipend = entry.stipend?.salary || entry.salary || entry.stipend_text || '';
            const description = [
                entry.job_description || entry.description || '',
                stipend ? `Compensation: ${stipend}` : '',
                entry.skills ? `Skills required: ${Array.isArray(entry.skills) ? entry.skills.join(', ') : entry.skills}` : ''
            ].filter(Boolean).join('\n\n');

            const sourceJobId = entry.id ? `internshala_${entry.id}` : null;

            try {
                const job = createNormalizedJob({
                    company_id: null,
                    company_name: companyName,
                    title,
                    location,
                    remote_type: remoteType,
                    applicant_eligibility: 'Open to India',
                    employment_type: entry.is_internship !== false ? 'internship' : 'full-time',
                    job_url: jobUrl,
                    description,
                    source: 'internshala',
                    source_job_id: sourceJobId,
                    raw: entry
                });
                normalizedJobs.push(job);
            } catch {
                // Ignore single job normalization error
            }
        }

        return normalizedJobs;
    }

    /**
     * Fetches and normalizes Internshala listings.
     */
    async fetchJobs({ query = 'full stack', location = 'india' } = {}) {
        if (sourceQuarantine.isSourceQuarantined('internshala')) {
            const status = sourceQuarantine.getSourceQuarantineStatus('internshala');
            return {
                jobs: [],
                quarantined: true,
                quarantineReason: status.quarantineReason
            };
        }

        try {
            const url = `${INTERNSHALA_API_ENDPOINT}?keyword=${encodeURIComponent(query)}&location=${encodeURIComponent(location)}`;
            const res = await fetchWithRetry(url, {}, { fetchFn: this.fetchFn, retries: 1 });
            const data = await res.json();
            const jobs = this.parseResponse(data);

            sourceQuarantine.recordSourceRun('internshala', { jobsFound: jobs.length });
            return { jobs, quarantined: false };
        } catch (err) {
            sourceQuarantine.recordSourceRun('internshala', { jobsFound: 0, error: err });
            return { jobs: [], quarantined: sourceQuarantine.isSourceQuarantined('internshala'), error: err.message };
        }
    }
}

export function fetchInternshalaJobs(options = {}) {
    const adapter = new InternshalaAdapter(options);
    return adapter.fetchJobs(options);
}
