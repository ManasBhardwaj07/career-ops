/**
 * discovery/adapters/jooble.mjs — Jooble Jobs REST API Adapter
 *
 * Implements Phase 4 public feed integration for Jooble (https://jooble.org/api/about).
 * Requires API Key (configured via process.env.JOOBLE_API_KEY).
 * When key is absent, cleanly reports CREDENTIALS_REQUIRED per Rule 9.
 */

import { createNormalizedJob, detectRemoteType, detectEmploymentType, fetchWithRetry } from './base.mjs';

export const JOOBLE_BASE_ENDPOINT = 'https://jooble.org/api';

export class JoobleAdapter {
    constructor({ fetchFn = fetch, apiKey = process.env.JOOBLE_API_KEY } = {}) {
        this.fetchFn = fetchFn;
        this.apiKey = apiKey;
        this.provider = 'jooble';
    }

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

        const items = data.jobs || [];
        const normalized = [];

        for (const item of items) {
            if (!item || typeof item !== 'object') continue;

            const title = item.title;
            if (!title) continue;

            const jobUrl = item.link;
            if (!jobUrl) continue;

            const location = item.location || 'India';
            const companyName = item.company || 'Employer via Jooble';
            const remoteType = detectRemoteType(title, location, item.type || '');
            const employmentType = detectEmploymentType(title, item.type || '', '');

            try {
                const job = createNormalizedJob({
                    company_name: companyName,
                    title,
                    location,
                    remote_type: remoteType,
                    applicant_eligibility: null,
                    employment_type: employmentType || 'full-time',
                    job_url: jobUrl,
                    description: item.snippet || '',
                    source: 'jooble',
                    source_job_id: item.id ? `jooble_${item.id}` : null,
                    source_updated_at: item.updated || null,
                    raw: item
                });
                normalized.push(job);
            } catch {
                // Ignore individual normalization error
            }
        }

        return normalized;
    }

    async fetchJobs({
        keywords = 'Software Engineer',
        location = 'India',
        page = 1,
        salary = null
    } = {}) {
        if (!this.apiKey) {
            return {
                jobs: [],
                status: 'CREDENTIALS_REQUIRED',
                message: 'Jooble API requires an API key in process.env.JOOBLE_API_KEY. Register at https://jooble.org/api/about.',
                provider: 'jooble'
            };
        }

        const endpoint = `${JOOBLE_BASE_ENDPOINT}/${this.apiKey}`;
        const bodyPayload = {
            keywords,
            location,
            page
        };
        if (salary) bodyPayload.salary = salary;

        try {
            const res = await fetchWithRetry(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                body: JSON.stringify(bodyPayload)
            }, { fetchFn: this.fetchFn, retries: 2, timeoutMs: 10000 });

            const data = await res.json();
            const jobs = this.parseResponse(data);

            return {
                jobs,
                totalCount: data.totalCount || jobs.length,
                status: 'SUCCESS',
                page,
                provider: 'jooble'
            };
        } catch (err) {
            return {
                jobs: [],
                status: 'ERROR',
                message: err.message || 'Failed to fetch Jooble jobs',
                provider: 'jooble'
            };
        }
    }
}

export function fetchJoobleJobs(options = {}) {
    const adapter = new JoobleAdapter(options);
    return adapter.fetchJobs(options);
}
