/**
 * discovery/adapters/remoteok.mjs — Remote OK Public API Discovery Adapter
 *
 * Implements Phase 4C Batch 1:
 *   - Endpoint: https://remoteok.com/api
 *   - RSS fallback: https://remoteok.com/remote-jobs.rss
 *   - No authentication required
 *   - Preserves original job URL, apply URL, and Remote OK attribution
 *   - Emits standardized createNormalizedJob() contract and AdapterResult
 */

import { createNormalizedJob, detectEmploymentType, fetchWithRetry } from './base.mjs';
import { AdapterResult, validateAdapterResult } from '../interfaces.mjs';

export const REMOTEOK_API_ENDPOINT = 'https://remoteok.com/api';
export const REMOTEOK_RSS_ENDPOINT = 'https://remoteok.com/remote-jobs.rss';
export const REMOTEOK_USER_AGENT = 'CareerOps-JobDiscovery/1.0 (+https://github.com/santifer/career-ops; Candidate Job Search)';

/**
 * Parses raw JSON payload from Remote OK API into normalized job records.
 *
 * @param {Array<object>} json - Raw response array from https://remoteok.com/api
 * @param {object} [options]
 * @param {string} [options.sourceProvenance='remoteok']
 * @param {Function} [options.resolveCompanyId] - Optional company ID resolver function
 * @returns {Array<object>} Normalized jobs
 */
export function parseRemoteOkResponse(json, options = {}) {
    if (!Array.isArray(json)) {
        return [];
    }

    const result = [];
    const seenUrls = new Set();
    const resolveCompId = options.resolveCompanyId || ((name) => `company-${(name || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`);

    for (const item of json) {
        // Skip legal notice/metadata object (first element in Remote OK array)
        if (!item || !item.id || item.legal) {
            continue;
        }

        const title = (item.position || '').trim();
        const companyName = (item.company || '').trim() || 'Unknown Employer';
        const applyUrl = (item.apply_url || '').trim();
        const listingUrl = (item.url || '').trim();
        const primaryUrl = applyUrl || listingUrl;

        if (!title || !primaryUrl) {
            continue;
        }

        if (seenUrls.has(primaryUrl)) {
            continue;
        }
        seenUrls.add(primaryUrl);

        const location = (item.location || 'Remote').trim();
        const tags = Array.isArray(item.tags) ? item.tags.join(' ') : (item.tags || '');
        const empType = detectEmploymentType(title, tags, '');

        let sourceUpdatedAt = null;
        if (item.date) {
            try {
                const parsed = new Date(item.date);
                if (!isNaN(parsed.getTime())) {
                    sourceUpdatedAt = parsed.toISOString();
                }
            } catch {}
        }

        const compId = resolveCompId(companyName);

        result.push(createNormalizedJob({
            id: listingUrl || `remoteok-${item.id}`,
            company_id: compId,
            company_name: companyName,
            title,
            location,
            remote_type: 'remote', // Remote OK is 100% remote by definition
            applicant_eligibility: location && location.toLowerCase() !== 'worldwide' && location.toLowerCase() !== 'anywhere' ? location : null,
            employment_type: empType,
            job_url: primaryUrl,
            description: item.description || null,
            source: 'remoteok',
            source_job_id: String(item.id),
            source_updated_at: sourceUpdatedAt,
            raw: {
                ...item,
                _source_platform: 'remoteok',
                _listing_url: listingUrl,
                _apply_url: applyUrl || null,
                _attribution: 'Powered by Remote OK (https://remoteok.com)',
                _attribution_link_rel: 'follow'
            }
        }));
    }

    return result;
}

/**
 * Fetches and normalizes live jobs from Remote OK.
 *
 * @param {object} [options]
 * @param {string} [options.endpoint=REMOTEOK_API_ENDPOINT]
 * @param {Function} [options.fetchFn=fetch]
 * @param {number} [options.timeoutMs=15000]
 * @param {Function} [options.resolveCompanyId]
 * @returns {Promise<AdapterResult>}
 */
export async function fetchRemoteOkJobs(options = {}) {
    const endpoint = options.endpoint || REMOTEOK_API_ENDPOINT;
    const fetchFn = options.fetchFn || fetch;
    const timeoutMs = options.timeoutMs || 15000;

    try {
        const res = await fetchWithRetry(endpoint, {
            headers: {
                'User-Agent': REMOTEOK_USER_AGENT,
                'Accept': 'application/json'
            }
        }, { timeoutMs, fetchFn });

        const json = await res.json();
        const rawList = Array.isArray(json) ? json.filter(j => j && j.id && !j.legal) : [];
        const jobs = parseRemoteOkResponse(json, options);

        const seen = new Set();
        let duplicateInSourceCount = 0;
        for (const j of rawList) {
            const u = (j.apply_url || j.url || '').trim();
            if (u) {
                if (seen.has(u)) duplicateInSourceCount++;
                seen.add(u);
            }
        }
        const invalidCount = Math.max(0, rawList.length - jobs.length - duplicateInSourceCount);

        const adapterResult = new AdapterResult({
            sourceType: 'remoteok',
            endpoint,
            jobs,
            fetchedCount: rawList.length,
            normalizedCount: jobs.length,
            invalidCount,
            duplicateInSourceCount,
            error: null
        });

        validateAdapterResult(adapterResult);
        return adapterResult;

    } catch (err) {
        return new AdapterResult({
            sourceType: 'remoteok',
            endpoint,
            jobs: [],
            fetchedCount: 0,
            normalizedCount: 0,
            invalidCount: 0,
            duplicateInSourceCount: 0,
            error: `Remote OK fetch failed: ${err.message}`
        });
    }
}

/**
 * Standard Adapter class implementing the ATSBoardAdapter / JobBoardProvider interface
 */
export class RemoteOkAdapter {
    constructor() {
        this.sourceType = 'remoteok';
    }

    async fetchJobs(options = {}) {
        return fetchRemoteOkJobs(options);
    }
}
