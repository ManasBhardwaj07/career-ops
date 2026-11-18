/**
 * discovery/adapters/remotive.mjs — Remotive Public API Discovery Adapter
 *
 * Implements Phase 4C Batch 1:
 *   - Endpoint: https://remotive.com/api/remote-jobs
 *   - Software engineering category focus (?category=software-dev)
 *   - Respects 24-hour listing delay and max 2 req/min rate limit
 *   - Preserves Remotive URL and source attribution
 *   - Adheres to non-redistribution terms
 */

import { createNormalizedJob, detectEmploymentType, fetchWithRetry } from './base.mjs';
import { AdapterResult, validateAdapterResult } from '../interfaces.mjs';

export const REMOTIVE_API_ENDPOINT = 'https://remotive.com/api/remote-jobs';
export const REMOTIVE_DEFAULT_CATEGORY = 'software-dev';
export const REMOTIVE_MAX_REQUESTS_PER_DAY = 4;
export const REMOTIVE_MIN_POLL_INTERVAL_MS = 6 * 60 * 60 * 1000; // Max 4 requests/day (every 6 hours)
export const REMOTIVE_USER_AGENT = 'CareerOps-JobDiscovery/1.0 (+https://github.com/santifer/career-ops; Candidate Job Search)';

/**
 * Parses raw JSON payload from Remotive API into normalized job records.
 *
 * @param {object} json - Response object from https://remotive.com/api/remote-jobs
 * @param {object} [options]
 * @param {Function} [options.resolveCompanyId]
 * @returns {Array<object>} Normalized jobs
 */
export function parseRemotiveResponse(json, options = {}) {
    const rawList = Array.isArray(json?.jobs) ? json.jobs : (Array.isArray(json) ? json : []);
    const result = [];
    const seenUrls = new Set();
    const resolveCompId = options.resolveCompanyId || ((name) => `company-${(name || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`);

    for (const item of rawList) {
        if (!item || !item.id) continue;

        const title = (item.title || '').trim();
        const companyName = (item.company_name || '').trim() || 'Unknown Employer';
        const url = (item.url || '').trim();

        if (!title || !url) {
            continue;
        }

        if (seenUrls.has(url)) {
            continue;
        }
        seenUrls.add(url);

        const location = (item.candidate_required_location || 'Remote').trim();
        const tags = Array.isArray(item.tags) ? item.tags.join(' ') : (item.tags || '');
        const empType = detectEmploymentType(title, `${item.job_type || ''} ${tags}`, '');

        let sourceUpdatedAt = null;
        if (item.publication_date) {
            try {
                const parsed = new Date(item.publication_date);
                if (!isNaN(parsed.getTime())) {
                    sourceUpdatedAt = parsed.toISOString();
                }
            } catch {}
        }

        const compId = resolveCompId(companyName);

        result.push(createNormalizedJob({
            id: url || `remotive-${item.id}`,
            company_id: compId,
            company_name: companyName,
            title,
            location,
            remote_type: 'remote', // Remotive is 100% remote
            applicant_eligibility: location && location.toLowerCase() !== 'worldwide' && location.toLowerCase() !== 'anywhere' ? location : null,
            employment_type: empType,
            job_url: url,
            description: item.description || null,
            source: 'remotive',
            source_job_id: String(item.id),
            source_updated_at: sourceUpdatedAt,
            raw: {
                ...item,
                _source_platform: 'remotive',
                _remotive_url: url,
                _attribution: 'Powered by Remotive (https://remotive.com)',
                _delay_notice: json?.['0-legal-notice'] || '24h delay applies per Remotive API terms'
            }
        }));
    }

    return result;
}

/**
 * Fetches and normalizes live jobs from Remotive.
 *
 * @param {object} [options]
 * @param {string} [options.endpoint=REMOTIVE_API_ENDPOINT]
 * @param {string} [options.category='software-dev']
 * @param {string} [options.search]
 * @param {number} [options.limit]
 * @param {Function} [options.fetchFn=fetch]
 * @param {number} [options.timeoutMs=15000]
 * @param {Function} [options.resolveCompanyId]
 * @returns {Promise<AdapterResult>}
 */
export async function fetchRemotiveJobs(options = {}) {
    const baseEndpoint = options.endpoint || REMOTIVE_API_ENDPOINT;
    const fetchFn = options.fetchFn || fetch;
    const timeoutMs = options.timeoutMs || 15000;

    const url = new URL(baseEndpoint);
    if (options.category !== null) {
        url.searchParams.set('category', options.category || REMOTIVE_DEFAULT_CATEGORY);
    }
    if (options.search) {
        url.searchParams.set('search', options.search);
    }
    if (options.limit) {
        url.searchParams.set('limit', String(options.limit));
    }

    try {
        const res = await fetchWithRetry(url.toString(), {
            headers: {
                'User-Agent': 'CareerOpsBot/1.0 (+https://github.com/santifer/career-ops)',
                'Accept': 'application/json'
            }
        }, { timeoutMs, fetchFn });

        const json = await res.json();
        const rawList = Array.isArray(json?.jobs) ? json.jobs : (Array.isArray(json) ? json : []);
        const jobs = parseRemotiveResponse(json, options);

        const invalidCount = Math.max(0, rawList.length - jobs.length);
        const seen = new Set();
        let duplicateInSource = 0;
        for (const j of rawList) {
            const u = (j.url || '').trim();
            if (u) {
                if (seen.has(u)) duplicateInSource++;
                seen.add(u);
            }
        }

        const adapterResult = new AdapterResult({
            sourceType: 'remotive',
            endpoint: url.toString(),
            jobs,
            fetchedCount: rawList.length,
            normalizedCount: jobs.length,
            invalidCount,
            duplicateInSourceCount: duplicateInSource,
            error: null
        });

        validateAdapterResult(adapterResult);
        return adapterResult;

    } catch (err) {
        return new AdapterResult({
            sourceType: 'remotive',
            endpoint: url.toString(),
            jobs: [],
            fetchedCount: 0,
            normalizedCount: 0,
            invalidCount: 0,
            duplicateInSourceCount: 0,
            error: `Remotive fetch failed: ${err.message}`
        });
    }
}

/**
 * Standard Adapter class implementing JobBoardProvider interface
 */
export class RemotiveAdapter {
    constructor() {
        this.sourceType = 'remotive';
    }

    async fetchJobs(options = {}) {
        return fetchRemotiveJobs(options);
    }
}
