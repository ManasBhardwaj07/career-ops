/**
 * discovery/adapters/himalayas.mjs — Himalayas Public REST API Discovery Adapter
 *
 * Implements Phase 4C Batch 1:
 *   - Endpoint: https://himalayas.app/jobs/api
 *   - Maximum 20 jobs per page
 *   - Cursor-based pagination via nextCursor
 *   - Preserves applicationLink exactly as supplied
 *   - Preserves visible Himalayas attribution and source URL
 *   - Adheres to daily refresh and non-redistribution terms
 */

import { createNormalizedJob, detectEmploymentType, fetchWithRetry } from './base.mjs';
import { AdapterResult, validateAdapterResult } from '../interfaces.mjs';

export const HIMALAYAS_API_ENDPOINT = 'https://himalayas.app/jobs/api';
export const HIMALAYAS_PAGE_LIMIT = 20;

/**
 * Parses raw JSON payload from Himalayas API into normalized job records.
 *
 * @param {object} json - Response from https://himalayas.app/jobs/api
 * @param {object} [options]
 * @param {Function} [options.resolveCompanyId]
 * @returns {Array<object>} Normalized jobs
 */
export function parseHimalayasResponse(json, options = {}) {
    const rawList = Array.isArray(json?.data)
        ? json.data
        : (Array.isArray(json?.jobs) ? json.jobs : (Array.isArray(json) ? json : []));

    const result = [];
    const seenUrls = new Set();
    const resolveCompId = options.resolveCompanyId || ((name) => `company-${(name || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`);

    for (const item of rawList) {
        if (!item) continue;

        const title = (item.title || '').trim();
        const companyName = (item.companyName || item.company?.name || '').trim() || 'Unknown Employer';
        const appLink = (item.applicationLink || '').trim();
        const himalayasUrl = (item.himalayasUrl || item.url || (item.slug ? `https://himalayas.app/companies/${item.companySlug || 'jobs'}/jobs/${item.slug}` : '')).trim();
        const primaryUrl = appLink || himalayasUrl;

        if (!title || !primaryUrl) {
            continue;
        }

        if (seenUrls.has(primaryUrl)) {
            continue;
        }
        seenUrls.add(primaryUrl);

        const location = (item.location || 'Remote').trim();
        const empType = detectEmploymentType(title, item.employmentType || '', '');
        const countryRestrictions = Array.isArray(item.countryRestrictions)
            ? item.countryRestrictions.join(', ')
            : (item.countryRestrictions || null);

        let sourceUpdatedAt = null;
        if (item.pubDate || item.publishedAt || item.createdAt) {
            try {
                const parsed = new Date(item.pubDate || item.publishedAt || item.createdAt);
                if (!isNaN(parsed.getTime())) {
                    sourceUpdatedAt = parsed.toISOString();
                }
            } catch {}
        }

        const compId = resolveCompId(companyName);

        result.push(createNormalizedJob({
            id: himalayasUrl || appLink || `himalayas-${item.id || item.slug}`,
            company_id: compId,
            company_name: companyName,
            title,
            location,
            remote_type: 'remote', // Himalayas lists remote roles
            applicant_eligibility: countryRestrictions,
            employment_type: empType,
            job_url: primaryUrl,
            description: item.description || item.excerpt || null,
            source: 'himalayas',
            source_job_id: String(item.id || item.slug || ''),
            source_updated_at: sourceUpdatedAt,
            raw: {
                ...item,
                _source_platform: 'himalayas',
                _himalayas_url: himalayasUrl,
                _application_link: appLink,
                _attribution: 'Powered by Himalayas (https://himalayas.app)'
            }
        }));
    }

    return result;
}

/**
 * Fetches and normalizes live jobs from Himalayas with cursor pagination.
 *
 * @param {object} [options]
 * @param {string} [options.endpoint=HIMALAYAS_API_ENDPOINT]
 * @param {number} [options.maxPages=5] - Maximum pages to retrieve (20 jobs/page)
 * @param {Function} [options.fetchFn=fetch]
 * @param {number} [options.timeoutMs=15000]
 * @param {Function} [options.resolveCompanyId]
 * @returns {Promise<AdapterResult>}
 */
export async function fetchHimalayasJobs(options = {}) {
    const baseEndpoint = options.endpoint || HIMALAYAS_API_ENDPOINT;
    const maxPages = options.maxPages || 5;
    const fetchFn = options.fetchFn || fetch;
    const timeoutMs = options.timeoutMs || 15000;

    let cursor = options.cursor || null;
    let pageCount = 0;
    const allJobs = [];
    let totalFetched = 0;
    const seenUrls = new Set();
    let duplicateInSource = 0;
    let lastError = null;

    while (pageCount < maxPages) {
        pageCount++;
        const url = new URL(baseEndpoint);
        url.searchParams.set('limit', String(HIMALAYAS_PAGE_LIMIT));
        if (cursor) {
            url.searchParams.set('cursor', cursor);
        }

        try {
            const res = await fetchWithRetry(url.toString(), {
                headers: {
                    'User-Agent': 'CareerOpsBot/1.0 (+https://github.com/santifer/career-ops)',
                    'Accept': 'application/json'
                }
            }, { timeoutMs, fetchFn });

            const json = await res.json();
            const rawList = Array.isArray(json?.data)
                ? json.data
                : (Array.isArray(json?.jobs) ? json.jobs : (Array.isArray(json) ? json : []));

            totalFetched += rawList.length;

            for (const j of rawList) {
                const u = (j.applicationLink || j.himalayasUrl || j.url || '').trim();
                if (u) {
                    if (seenUrls.has(u)) duplicateInSource++;
                    seenUrls.add(u);
                }
            }

            const pageJobs = parseHimalayasResponse(json, options);
            allJobs.push(...pageJobs);

            // Cursor pagination check
            cursor = json?.meta?.nextCursor || null;
            if (!cursor || rawList.length === 0) {
                break; // No more pages
            }

        } catch (err) {
            lastError = err;
            break;
        }
    }

    if (allJobs.length === 0 && lastError) {
        return new AdapterResult({
            sourceType: 'himalayas',
            endpoint: baseEndpoint,
            jobs: [],
            fetchedCount: 0,
            normalizedCount: 0,
            invalidCount: 0,
            duplicateInSourceCount: 0,
            error: `Himalayas fetch failed: ${lastError.message}`
        });
    }

    const invalidCount = Math.max(0, totalFetched - allJobs.length);
    const adapterResult = new AdapterResult({
        sourceType: 'himalayas',
        endpoint: baseEndpoint,
        jobs: allJobs,
        fetchedCount: totalFetched,
        normalizedCount: allJobs.length,
        invalidCount,
        duplicateInSourceCount: duplicateInSource,
        error: lastError ? `Partial failure after ${pageCount} pages: ${lastError.message}` : null
    });

    if (!lastError) {
        validateAdapterResult(adapterResult);
    }
    return adapterResult;
}

/**
 * Standard Adapter class implementing JobBoardProvider interface
 */
export class HimalayasAdapter {
    constructor() {
        this.sourceType = 'himalayas';
    }

    async fetchJobs(options = {}) {
        return fetchHimalayasJobs(options);
    }
}
