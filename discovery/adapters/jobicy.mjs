/**
 * discovery/adapters/jobicy.mjs — Jobicy Public API Discovery Adapter
 *
 * Implements Phase 4C Batch 1 (with Final Validation corrections):
 *   - Primary endpoint: https://jobicy.com/api/jobs
 *   - Default count=100 per request
 *   - Cursor pagination via `nextCursor` (`?cursor=...`), preserving identical filters across requests
 *   - Stops cleanly when `nextCursor` is null or on expired cursor error
 *   - Batch status check endpoint: https://jobicy.com/api/jobs/status?ids=... (up to 100 IDs/request)
 *   - Never marks a missing 7-day-feed listing as closed without explicit status evidence
 *   - Preserves Jobicy listing URL (free public tier; no paid API access) and visible attribution
 *   - Respects 1-hour minimum polling interval (JOBICY_POLL_INTERVAL_MS)
 */

import { createNormalizedJob, detectEmploymentType } from './base.mjs';
import { AdapterResult, validateAdapterResult } from '../interfaces.mjs';

export const JOBICY_PRIMARY_ENDPOINT = 'https://jobicy.com/api/jobs';
export const JOBICY_STATUS_ENDPOINT = 'https://jobicy.com/api/jobs/status';
export const JOBICY_PAGE_LIMIT = 100;
export const JOBICY_STATUS_BATCH_SIZE = 100;
export const JOBICY_POLL_INTERVAL_MS = 60 * 60 * 1000; // Once per hour
export const JOBICY_USER_AGENT = 'CareerOps-JobDiscovery/1.0 (+https://github.com/santifer/career-ops; Candidate Job Search)';

/**
 * Parses raw JSON payload from Jobicy API into normalized job records.
 *
 * @param {object} json - Response object from Jobicy
 * @param {object} [options]
 * @param {Function} [options.resolveCompanyId]
 * @returns {Array<object>} Normalized jobs
 */
export function parseJobicyResponse(json, options = {}) {
    const rawList = Array.isArray(json?.jobs) ? json.jobs : (Array.isArray(json) ? json : []);
    const result = [];
    const seenUrls = new Set();
    const resolveCompId = options.resolveCompanyId || ((name) => `company-${(name || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`);

    for (const item of rawList) {
        if (!item || (!item.id && !item.url)) continue;

        const title = (item.jobTitle || item.title || '').trim();
        const companyName = (item.companyName || item.company || '').trim() || 'Unknown Employer';
        const url = (item.url || '').trim();

        if (!title || !url) {
            continue;
        }

        if (seenUrls.has(url)) {
            continue;
        }
        seenUrls.add(url);

        const location = (item.jobGeo || item.geo || 'Remote').trim();
        const empType = detectEmploymentType(title, `${item.jobType || ''} ${item.jobLevel || ''}`, '');

        let sourceUpdatedAt = null;
        if (item.pubDate || item.date) {
            try {
                const parsed = new Date(item.pubDate || item.date);
                if (!isNaN(parsed.getTime())) {
                    sourceUpdatedAt = parsed.toISOString();
                }
            } catch {}
        }

        const compId = resolveCompId(companyName);

        result.push(createNormalizedJob({
            id: url || `jobicy-${item.id}`,
            company_id: compId,
            company_name: companyName,
            title,
            location,
            remote_type: 'remote', // Jobicy lists remote jobs
            applicant_eligibility: location && location.toLowerCase() !== 'anywhere' && location.toLowerCase() !== 'worldwide' ? location : null,
            employment_type: empType,
            job_url: url,
            description: item.jobDescription || item.jobExcerpt || item.description || null,
            source: 'jobicy',
            source_job_id: String(item.id || ''),
            source_updated_at: sourceUpdatedAt,
            raw: {
                ...item,
                _source_platform: 'jobicy',
                _jobicy_url: url,
                _attribution: 'Powered by Jobicy (https://jobicy.com)'
            }
        }));
    }

    return result;
}

/**
 * Helper to fetch a single URL with timeout and standard headers without retrying non-retryable 400/410 cursor errors.
 */
async function fetchJobicyRequest(url, { fetchFn = fetch, timeoutMs = 15000 } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const res = await fetchFn(url, {
            signal: controller.signal,
            headers: {
                'User-Agent': JOBICY_USER_AGENT,
                'Accept': 'application/json'
            }
        });
        clearTimeout(timer);
        return res;
    } catch (err) {
        clearTimeout(timer);
        throw err;
    }
}

/**
 * Fetches and normalizes live jobs from Jobicy using official `nextCursor` pagination.
 * Preserves identical filters (`count`, `industry`, `geo`, `tag`) across cursor requests.
 * Stops when `nextCursor` is null or if the cursor expires.
 *
 * @param {object} [options]
 * @param {string} [options.endpoint=JOBICY_PRIMARY_ENDPOINT]
 * @param {number} [options.count=JOBICY_PAGE_LIMIT]
 * @param {string} [options.industry]
 * @param {string} [options.geo]
 * @param {string} [options.tag]
 * @param {string} [options.cursor]
 * @param {number} [options.maxPages=5]
 * @param {Function} [options.fetchFn=fetch]
 * @param {number} [options.timeoutMs=15000]
 * @param {Function} [options.resolveCompanyId]
 * @returns {Promise<AdapterResult>}
 */
export async function fetchJobicyJobs(options = {}) {
    const baseEndpoint = options.endpoint || JOBICY_PRIMARY_ENDPOINT;
    const fetchFn = options.fetchFn || fetch;
    const timeoutMs = options.timeoutMs || 15000;
    const maxPages = options.maxPages || 5;
    const count = Math.min(options.count || JOBICY_PAGE_LIMIT, JOBICY_PAGE_LIMIT);

    let cursor = options.cursor || null;
    let pageCount = 0;
    const allJobs = [];
    let totalFetched = 0;
    const seenUrls = new Set();
    let duplicateInSource = 0;
    let lastError = null;
    let cursorExpired = false;
    let lastUrl = baseEndpoint;

    while (pageCount < maxPages) {
        pageCount++;
        const url = new URL(baseEndpoint);
        url.searchParams.set('count', String(count));
        if (options.industry) {
            url.searchParams.set('industry', options.industry);
        }
        if (options.geo) {
            url.searchParams.set('geo', options.geo);
        }
        if (options.tag) {
            url.searchParams.set('tag', options.tag);
        }
        if (cursor) {
            url.searchParams.set('cursor', cursor);
        }

        lastUrl = url.toString();

        try {
            const res = await fetchJobicyRequest(lastUrl, { fetchFn, timeoutMs });

            let json = null;
            try {
                json = await res.json();
            } catch {
                json = null;
            }

            // Detect expired/invalid cursor either by HTTP 400/410 or explicit API error message
            const apiErrorMsg = json?.error || json?.message || '';
            const isCursorError = Boolean(cursor) && (
                res.status === 400 ||
                res.status === 410 ||
                /cursor|expired/i.test(String(apiErrorMsg))
            );

            if (isCursorError) {
                cursorExpired = true;
                lastError = new Error(`Jobicy cursor expired or invalid (${res.status}${apiErrorMsg ? ': ' + apiErrorMsg : ''})`);
                break;
            }

            const isOk = res.ok !== undefined ? res.ok : (res.status >= 200 && res.status < 300);
            if (!isOk) {
                throw new Error(`HTTP ${res.status}: ${res.statusText || apiErrorMsg || 'Request failed'}`);
            }

            if (json?.error) {
                throw new Error(String(json.error));
            }

            const rawList = Array.isArray(json?.jobs) ? json.jobs : (Array.isArray(json) ? json : []);
            totalFetched += rawList.length;

            for (const j of rawList) {
                const u = (j.url || '').trim();
                if (u) {
                    if (seenUrls.has(u)) duplicateInSource++;
                    seenUrls.add(u);
                }
            }

            const pageJobs = parseJobicyResponse(json, options);
            for (const job of pageJobs) {
                if (!allJobs.some(existing => existing.job_url === job.job_url)) {
                    allJobs.push(job);
                }
            }

            // Advance cursor using official `nextCursor` field
            const nextCursor = json?.nextCursor ?? json?.meta?.nextCursor ?? null;
            if (!nextCursor || String(nextCursor).trim() === '') {
                break; // Reached end of dataset (nextCursor is null)
            }
            cursor = String(nextCursor).trim();

        } catch (err) {
            lastError = err;
            break;
        }
    }

    if (allJobs.length === 0 && lastError) {
        return new AdapterResult({
            sourceType: 'jobicy',
            endpoint: lastUrl,
            jobs: [],
            fetchedCount: 0,
            normalizedCount: 0,
            invalidCount: 0,
            duplicateInSourceCount: 0,
            error: `Jobicy fetch failed: ${lastError.message}`
        });
    }

    const invalidCount = Math.max(0, totalFetched - allJobs.length - duplicateInSource);
    const adapterResult = new AdapterResult({
        sourceType: 'jobicy',
        endpoint: lastUrl,
        jobs: allJobs,
        fetchedCount: totalFetched,
        normalizedCount: allJobs.length,
        invalidCount,
        duplicateInSourceCount: duplicateInSource,
        error: lastError
            ? (cursorExpired
                ? `Cursor expired after ${pageCount - 1} pages (preserved ${allJobs.length} fetched jobs): ${lastError.message}`
                : `Partial failure after ${pageCount} pages: ${lastError.message}`)
            : null
    });

    if (!lastError) {
        validateAdapterResult(adapterResult);
    }
    return adapterResult;
}

/**
 * Checks batch job statuses via official Jobicy `/api/jobs/status` endpoint.
 * Supports up to 100 IDs per request.
 * Each ID resolves strictly to 'active' | 'closed' | 'unknown'.
 *
 * @param {Array<string|number>} jobIds - Jobicy source_job_id values
 * @param {object} [options]
 * @param {string} [options.statusEndpoint=JOBICY_STATUS_ENDPOINT]
 * @param {Function} [options.fetchFn=fetch]
 * @param {number} [options.timeoutMs=15000]
 * @returns {Promise<{endpoint: string, checkedCount: number, statuses: Record<string, 'active'|'closed'|'unknown'>, errors: Array<string>}>}
 */
export async function checkJobicyJobStatuses(jobIds = [], options = {}) {
    const statusEndpoint = options.statusEndpoint || JOBICY_STATUS_ENDPOINT;
    const fetchFn = options.fetchFn || fetch;
    const timeoutMs = options.timeoutMs || 15000;

    const cleanIds = [...new Set(
        (Array.isArray(jobIds) ? jobIds : [])
            .map(id => String(id || '').trim())
            .filter(Boolean)
    )];

    const statuses = {};
    const errors = [];

    if (cleanIds.length === 0) {
        return { endpoint: statusEndpoint, checkedCount: 0, statuses, errors };
    }

    for (let i = 0; i < cleanIds.length; i += JOBICY_STATUS_BATCH_SIZE) {
        const chunk = cleanIds.slice(i, i + JOBICY_STATUS_BATCH_SIZE);
        const url = new URL(statusEndpoint);
        url.searchParams.set('ids', chunk.join(','));

        try {
            const res = await fetchJobicyRequest(url.toString(), { fetchFn, timeoutMs });
            const isOk = res.ok !== undefined ? res.ok : (res.status >= 200 && res.status < 300);
            if (!isOk) {
                errors.push(`HTTP ${res.status}: ${res.statusText || 'Status check failed'}`);
                for (const id of chunk) {
                    statuses[id] = 'unknown';
                }
                continue;
            }

            const json = await res.json();
            const parsedChunk = {};

            // Handle object map shape: { statuses: { "123": "active" } } or { "123": "active" }
            const mapSource = (json?.statuses && typeof json.statuses === 'object' && !Array.isArray(json.statuses))
                ? json.statuses
                : (json && typeof json === 'object' && !Array.isArray(json) && !Array.isArray(json.results) && !Array.isArray(json.jobs)
                    ? json
                    : null);

            if (mapSource) {
                for (const [k, v] of Object.entries(mapSource)) {
                    const norm = normalizeJobicyStatusValue(typeof v === 'object' && v !== null ? v.status : v);
                    parsedChunk[String(k).trim()] = norm;
                }
            }

            // Handle array shape: { results: [{ id, status }] } or { jobs: [{ id, status }] } or [{ id, status }]
            const listSource = Array.isArray(json?.results)
                ? json.results
                : (Array.isArray(json?.jobs) ? json.jobs : (Array.isArray(json) ? json : null));

            if (listSource) {
                for (const entry of listSource) {
                    if (!entry || entry.id === undefined || entry.id === null) continue;
                    const idStr = String(entry.id).trim();
                    parsedChunk[idStr] = normalizeJobicyStatusValue(entry.status);
                }
            }

            for (const id of chunk) {
                statuses[id] = parsedChunk[id] || 'unknown';
            }
        } catch (err) {
            errors.push(`Status check error: ${err.message}`);
            for (const id of chunk) {
                statuses[id] = 'unknown';
            }
        }
    }

    return {
        endpoint: statusEndpoint,
        checkedCount: cleanIds.length,
        statuses,
        errors
    };
}

/**
 * Normalizes raw Jobicy status value to canonical status token.
 */
export function normalizeJobicyStatusValue(rawStatus) {
    const val = String(rawStatus || '').trim().toLowerCase();
    if (val === 'active' || val === 'open' || val === 'live') return 'active';
    if (val === 'closed' || val === 'expired' || val === 'filled' || val === 'inactive') return 'closed';
    return 'unknown';
}

/**
 * Maps a Jobicy batch status token into a verification outcome.
 * Enforces: never mark a missing 7-day-feed or unknown status as closed.
 *
 * @param {'active'|'closed'|'unknown'} statusToken
 * @returns {{outcome: 'ACTIVE'|'CLOSED'|'UNKNOWN', reason: string, definitive: boolean}}
 */
export function mapJobicyStatusToVerificationOutcome(statusToken) {
    const norm = normalizeJobicyStatusValue(statusToken);
    if (norm === 'active') {
        return {
            outcome: 'ACTIVE',
            reason: 'Jobicy batch status endpoint confirmed listing is active',
            definitive: true
        };
    }
    if (norm === 'closed') {
        return {
            outcome: 'CLOSED',
            reason: 'Jobicy batch status endpoint explicitly confirmed listing is closed',
            definitive: true
        };
    }
    return {
        outcome: 'UNKNOWN',
        reason: 'Jobicy batch status returned unknown (missing from 7-day feed is not closed evidence)',
        definitive: false
    };
}

/**
 * Standard Adapter class implementing JobBoardProvider interface
 */
export class JobicyAdapter {
    constructor() {
        this.sourceType = 'jobicy';
    }

    async fetchJobs(options = {}) {
        return fetchJobicyJobs(options);
    }

    async checkStatuses(jobIds, options = {}) {
        return checkJobicyJobStatuses(jobIds, options);
    }
}
