/**
 * discovery/adapters/smartrecruiters.mjs — SmartRecruiters Public Posting API Discovery Adapter
 *
 * Supports SmartRecruiters' public, unauthenticated Posting API:
 *   Endpoint: GET https://api.smartrecruiters.com/v1/companies/{companyIdentifier}/postings
 *   Query params: limit (default 100), offset
 *   Rate Limit: 10 requests / second
 *
 * Implements ATSBoardAdapter contract.
 */

import { createNormalizedJob, detectRemoteType, detectEmploymentType, fetchWithRetry } from './base.mjs';
import { AdapterResult, validateAdapterResult } from '../interfaces.mjs';

export const SMARTRECRUITERS_REGEX = /(?:careers\.|jobs\.|api\.)?smartrecruiters\.com\/(?:v1\/companies\/)?([^/?#]+)/i;

/**
 * Extracts companyIdentifier from a SmartRecruiters career URL, API URL, or plain identifier
 */
export function extractCompanyIdentifier(urlOrIdentifier) {
    if (!urlOrIdentifier) return null;
    const trimmed = String(urlOrIdentifier).trim();

    const match = trimmed.match(SMARTRECRUITERS_REGEX);
    if (match) {
        return match[1];
    }

    // Plain slug (e.g. "smartrecruiters", "visa", "blizzard")
    if (/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
        return trimmed;
    }

    return null;
}

export function buildEndpoint(companyIdentifier, { limit = 100, offset = 0 } = {}) {
    const id = extractCompanyIdentifier(companyIdentifier);
    if (!id) return null;
    return `https://api.smartrecruiters.com/v1/companies/${id}/postings?limit=${limit}&offset=${offset}`;
}

/**
 * Parse SmartRecruiters public posting API response
 */
export function parseSmartRecruitersResponse(json, companyId, companyName, companyIdentifier) {
    if (!json || !Array.isArray(json.content)) {
        return [];
    }

    const result = [];
    const compSlug = companyIdentifier || 'company';

    for (const post of json.content) {
        const title = (post.name || '').trim();
        const postId = post.id || post.uuid || '';
        if (!title || !postId) continue;

        // Canonical public job URL
        const jobUrl = `https://jobs.smartrecruiters.com/${compSlug}/${postId}`;

        // Location formatting
        const locParts = [];
        if (post.location?.city) locParts.push(post.location.city);
        if (post.location?.region) locParts.push(post.location.region);
        if (post.location?.country) locParts.push(post.location.country.toUpperCase());
        const locationStr = locParts.join(', ') || null;

        // Remote detection: explicit boolean or title/location text
        let remoteType = null;
        if (post.location?.remote === true) {
            remoteType = 'remote';
        } else {
            remoteType = detectRemoteType(title, locationStr || '');
        }

        // Employment type
        const empLabel = post.typeOfEmployment?.label || post.typeOfEmployment?.id || '';
        const empType = detectEmploymentType(title, empLabel, '');

        result.push(createNormalizedJob({
            id: jobUrl,
            company_id: companyId,
            company_name: companyName,
            title,
            location: locationStr,
            remote_type: remoteType,
            applicant_eligibility: null,
            employment_type: empType,
            job_url: jobUrl,
            description: null,
            source: 'smartrecruiters',
            source_job_id: String(postId),
            source_updated_at: post.releasedDate || null,
            raw: post
        }));
    }

    return result;
}

/**
 * Fetch and paginate SmartRecruiters public postings
 */
export async function fetchSmartRecruitersJobs(boardOrUrl, companyId, companyName, {
    fetchFn = fetch,
    timeoutMs = 10000,
    limit = 100,
    maxPages = 20,
    maxJobs = 2000
} = {}) {
    const compId = extractCompanyIdentifier(boardOrUrl);
    if (!compId) {
        return {
            jobs: [],
            endpoint: null,
            total: 0,
            fetchedCount: 0,
            normalizedCount: 0,
            invalidCount: 0,
            duplicateInSourceCount: 0,
            error: `Invalid SmartRecruiters company identifier or URL: ${boardOrUrl}`
        };
    }

    const allJobs = [];
    const seenUrls = new Set();
    let totalFound = 0;
    let fetchedRawCount = 0;
    let duplicateInSourceCount = 0;
    let offset = 0;
    let page = 0;
    let lastEndpoint = null;
    let lastPageCount = 0;
    let exhausted = false;

    try {
        while (page < maxPages && allJobs.length < maxJobs) {
            const endpoint = buildEndpoint(compId, { limit, offset });
            lastEndpoint = endpoint;

            const res = await fetchWithRetry(endpoint, {
                method: 'GET',
                headers: {
                    'Accept': 'application/json'
                }
            }, { timeoutMs, fetchFn });

            const json = await res.json();
            totalFound = typeof json.totalFound === 'number' ? json.totalFound : totalFound;
            const content = Array.isArray(json.content) ? json.content : [];
            lastPageCount = content.length;
            fetchedRawCount += content.length;

            if (content.length === 0) {
                exhausted = true;
                break;
            }

            const pageJobs = parseSmartRecruitersResponse(json, companyId, companyName, compId);
            for (const j of pageJobs) {
                if (seenUrls.has(j.job_url)) {
                    duplicateInSourceCount++;
                } else {
                    seenUrls.add(j.job_url);
                    allJobs.push(j);
                }
            }

            offset += limit;
            page++;

            if ((typeof json.totalFound === 'number' && offset >= totalFound) || content.length < limit) {
                exhausted = true;
                break;
            }
        }

        const invalidCount = Math.max(0, fetchedRawCount - allJobs.length - duplicateInSourceCount);
        const isComplete = exhausted && (totalFound === 0 || offset >= totalFound || lastPageCount < limit);

        return {
            jobs: allJobs,
            endpoint: lastEndpoint,
            total: allJobs.length,
            totalFound,
            fetchedCount: fetchedRawCount,
            normalizedCount: allJobs.length,
            invalidCount,
            duplicateInSourceCount,
            isComplete,
            error: null
        };
    } catch (err) {
        return {
            jobs: allJobs,
            endpoint: lastEndpoint,
            total: allJobs.length,
            totalFound,
            fetchedCount: fetchedRawCount,
            normalizedCount: allJobs.length,
            invalidCount: 0,
            duplicateInSourceCount,
            isComplete: false,
            error: err.message
        };
    }
}

/**
 * Standard ATSBoardAdapter implementation for SmartRecruiters
 */
export class SmartRecruitersAdapter {
    constructor() {
        this.sourceType = 'smartrecruiters';
    }

    async fetchJobs(company, { fetchFn = fetch, timeoutMs = 10000, limit = 100, maxPages = 5, maxJobs = 500 } = {}) {
        const target = company.board_identifier || company.career_url || company.website_url;
        const res = await fetchSmartRecruitersJobs(target, company.id, company.name, {
            fetchFn, timeoutMs, limit, maxPages, maxJobs
        });

        const adapterResult = new AdapterResult({
            sourceType: 'smartrecruiters',
            endpoint: res.endpoint,
            jobs: res.jobs,
            fetchedCount: res.fetchedCount,
            normalizedCount: res.normalizedCount,
            invalidCount: res.invalidCount,
            duplicateInSourceCount: res.duplicateInSourceCount,
            error: res.error
        });

        if (!res.error) {
            validateAdapterResult(adapterResult);
        }

        return adapterResult;
    }
}
