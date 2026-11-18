/**
 * discovery/adapters/workday.mjs — Workday CXS (Candidate Experience Service) Discovery Adapter
 *
 * Supports Workday's public CXS REST API:
 *   URL format: https://<tenant>.<instance>.myworkdayjobs.com/[locale/]<site>
 *   Endpoint: POST https://<tenant>.<instance>.myworkdayjobs.com/wday/cxs/<tenant>/<site>/jobs
 *   Pagination: offset and limit in JSON body
 *
 * Implements ATSBoardAdapter contract.
 */

import { createNormalizedJob, detectRemoteType, detectEmploymentType, fetchWithRetry } from './base.mjs';
import { AdapterResult, validateAdapterResult } from '../interfaces.mjs';

export const WORKDAY_REGEX = /(?:https?:\/\/)?([a-zA-Z0-9_-]+)\.([a-zA-Z0-9_-]+)\.myworkdayjobs\.com\/(?:[a-zA-Z]{2}-[a-zA-Z]{2}\/)?([a-zA-Z0-9_-]+)/i;

/**
 * Extracts { tenant, instance, site } from a Workday career URL or board identifier
 */
export function extractWorkdayConfig(urlOrIdentifier) {
    if (!urlOrIdentifier) return null;
    const trimmed = String(urlOrIdentifier).trim();

    const match = trimmed.match(WORKDAY_REGEX);
    if (match) {
        return {
            tenant: match[1],
            instance: match[2],
            site: match[3]
        };
    }

    // Support structured identifier format: "tenant:instance:site" (e.g. "nvidia:wd5:NVIDIAExternalCareerSite")
    const parts = trimmed.split(':');
    if (parts.length === 3) {
        return {
            tenant: parts[0],
            instance: parts[1],
            site: parts[2]
        };
    }

    return null;
}

export function buildEndpoint(config) {
    if (!config || !config.tenant || !config.instance || !config.site) return null;
    return `https://${config.tenant}.${config.instance}.myworkdayjobs.com/wday/cxs/${config.tenant}/${config.site}/jobs`;
}

/**
 * Parse Workday CXS JSON page response
 */
export function parseWorkdayResponse(json, companyId, companyName, config) {
    if (!json || !Array.isArray(json.jobPostings)) {
        return [];
    }

    const result = [];
    const baseHost = `https://${config.tenant}.${config.instance}.myworkdayjobs.com`;

    for (const post of json.jobPostings) {
        const title = (post.title || '').trim();
        const externalPath = post.externalPath || '';
        if (!title || !externalPath) continue;

        // Construct canonical absolute apply URL
        const jobUrl = `${baseHost}/en-US/${config.site}${externalPath}`;
        const location = (post.locationsText || '').trim() || null;
        const remoteType = detectRemoteType(title, location || '');

        // Workday bulletFields often contain commitment/type e.g. ["JR1234", "Full time"]
        const bulletText = Array.isArray(post.bulletFields) ? post.bulletFields.join(' ') : '';
        const empType = detectEmploymentType(title, bulletText, '');

        // Extract job ID from externalPath (e.g. "..._JR19827" or bulletFields)
        let sourceJobId = null;
        const idMatch = externalPath.match(/_([a-zA-Z0-9]+)$/);
        if (idMatch) {
            sourceJobId = idMatch[1];
        } else if (Array.isArray(post.bulletFields) && post.bulletFields.length > 0) {
            sourceJobId = post.bulletFields[0];
        }

        result.push(createNormalizedJob({
            id: jobUrl,
            company_id: companyId,
            company_name: companyName,
            title,
            location,
            remote_type: remoteType,
            applicant_eligibility: null,
            employment_type: empType,
            job_url: jobUrl,
            description: null,
            source: 'workday',
            source_job_id: sourceJobId,
            source_updated_at: post.postedOn ? new Date().toISOString() : null,
            raw: post
        }));
    }

    return result;
}

/**
 * Fetch and paginate Workday CXS jobs
 */
export async function fetchWorkdayJobs(boardOrUrl, companyId, companyName, {
    fetchFn = fetch,
    timeoutMs = 10000,
    limit = 20,
    maxPages = 5,
    maxJobs = 100
} = {}) {
    const config = extractWorkdayConfig(boardOrUrl);
    const endpoint = buildEndpoint(config);

    if (!endpoint) {
        return {
            jobs: [],
            endpoint: null,
            total: 0,
            fetchedCount: 0,
            normalizedCount: 0,
            invalidCount: 0,
            duplicateInSourceCount: 0,
            error: `Invalid Workday board configuration or URL: ${boardOrUrl}`
        };
    }

    const allJobs = [];
    const seenUrls = new Set();
    let totalFound = 0;
    let fetchedRawCount = 0;
    let duplicateInSourceCount = 0;
    let offset = 0;
    let page = 0;
    let lastPageCount = 0;
    let exhausted = false;

    try {
        while (page < maxPages && allJobs.length < maxJobs) {
            const bodyPayload = JSON.stringify({
                appliedFacets: {},
                limit,
                offset,
                searchText: ''
            });

            const res = await fetchWithRetry(endpoint, {
                method: 'POST',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                },
                body: bodyPayload
            }, { timeoutMs, fetchFn });

            const json = await res.json();
            totalFound = typeof json.total === 'number' ? json.total : totalFound;
            const rawPostings = Array.isArray(json.jobPostings) ? json.jobPostings : [];
            lastPageCount = rawPostings.length;
            fetchedRawCount += rawPostings.length;

            if (rawPostings.length === 0) {
                exhausted = true;
                break;
            }

            const pageJobs = parseWorkdayResponse(json, companyId, companyName, config);
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

            if ((typeof json.total === 'number' && offset >= totalFound) || rawPostings.length < limit) {
                exhausted = true;
                break;
            }
        }

        const invalidCount = Math.max(0, fetchedRawCount - allJobs.length - duplicateInSourceCount);
        const isComplete = exhausted && (totalFound === 0 || offset >= totalFound || lastPageCount < limit);

        return {
            jobs: allJobs,
            endpoint,
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
            endpoint,
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
 * Standard ATSBoardAdapter implementation for Workday
 */
export class WorkdayAdapter {
    constructor() {
        this.sourceType = 'workday';
    }

    async fetchJobs(company, { fetchFn = fetch, timeoutMs = 10000, limit = 20, maxPages = 5, maxJobs = 100 } = {}) {
        const target = company.board_identifier || company.career_url || company.website_url;
        const res = await fetchWorkdayJobs(target, company.id, company.name, {
            fetchFn, timeoutMs, limit, maxPages, maxJobs
        });

        const adapterResult = new AdapterResult({
            sourceType: 'workday',
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
