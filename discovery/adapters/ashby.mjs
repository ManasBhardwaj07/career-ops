/**
 * discovery/adapters/ashby.mjs — Ashby ATS Discovery Adapter
 *
 * Supports:
 *   - jobs.ashbyhq.com/{board}
 *   - Direct Ashby posting API: https://api.ashbyhq.com/posting-api/job-board/{board}
 */

import { createNormalizedJob, detectRemoteType, detectEmploymentType, fetchWithRetry } from './base.mjs';
import { AdapterResult, validateAdapterResult } from '../interfaces.mjs';

export const ASHBY_REGEX = /jobs\.ashbyhq\.com\/([^/?#]+)/i;

export function extractBoard(url) {
    if (!url) return null;
    const match = url.match(ASHBY_REGEX);
    return match ? match[1] : null;
}

export function buildEndpoint(boardOrUrl) {
    const board = extractBoard(boardOrUrl) || boardOrUrl;
    if (!board) return null;
    return `https://api.ashbyhq.com/posting-api/job-board/${board}?includeCompensation=true`;
}

export function parseAshbyResponse(json, companyId, companyName) {
    if (!json || !Array.isArray(json.jobs)) {
        return [];
    }

    const seenUrls = new Set();
    const result = [];

    for (const j of json.jobs) {
        const title = j.title?.trim() || '';
        const url = j.jobUrl?.trim() || '';

        if (!title || !url) {
            continue;
        }

        if (seenUrls.has(url)) {
            continue;
        }
        seenUrls.add(url);

        const location = j.location?.trim() || null;
        const isRemote = j.isRemote || false;
        const remoteType = isRemote ? 'remote' : detectRemoteType(title, location || '');
        const ashbyEmpType = j.employmentType || '';
        const empType = detectEmploymentType(title, ashbyEmpType, ashbyEmpType);

        result.push(createNormalizedJob({
            id: url,
            company_id: companyId,
            company_name: companyName,
            title,
            location,
            remote_type: remoteType,
            applicant_eligibility: null,
            employment_type: empType,
            job_url: url,
            description: j.descriptionPlain || j.descriptionHtml || null,
            source: 'ashby',
            source_job_id: String(j.id || ''),
            source_updated_at: j.publishedAt || null,
            raw: j
        }));
    }

    return result;
}

export async function fetchAshbyJobs(boardOrUrl, companyId, companyName, { fetchFn = fetch, timeoutMs = 10000 } = {}) {
    const endpoint = buildEndpoint(boardOrUrl);
    if (!endpoint) {
        return {
            jobs: [], endpoint: null, total: 0,
            fetchedCount: 0, normalizedCount: 0, invalidCount: 0, duplicateInSourceCount: 0,
            error: `Invalid Ashby board or URL: ${boardOrUrl}`
        };
    }

    try {
        const res = await fetchWithRetry(endpoint, {
            headers: { 'Accept': 'application/json' }
        }, { timeoutMs, fetchFn });

        const json = await res.json();
        const rawList = Array.isArray(json?.jobs) ? json.jobs : [];
        const jobs = parseAshbyResponse(json, companyId, companyName);
        const invalidCount = Math.max(0, rawList.length - jobs.length);
        const seen = new Set();
        let duplicateInSourceCount = 0;
        for (const r of rawList) {
            const u = r.jobUrl?.trim();
            if (u) {
                if (seen.has(u)) duplicateInSourceCount++;
                seen.add(u);
            }
        }

        return {
            jobs,
            endpoint,
            total: jobs.length,
            fetchedCount: rawList.length,
            normalizedCount: jobs.length,
            invalidCount,
            duplicateInSourceCount,
            isComplete: true,
            error: null
        };
    } catch (err) {
        return {
            jobs: [], endpoint, total: 0,
            fetchedCount: 0, normalizedCount: 0, invalidCount: 0, duplicateInSourceCount: 0,
            isComplete: false,
            error: err.message
        };
    }
}

/**
 * Standard ATSBoardAdapter implementation for Ashby
 */
export class AshbyAdapter {
    constructor() {
        this.sourceType = 'ashby';
    }

    async fetchJobs(company, { fetchFn = fetch, timeoutMs = 10000 } = {}) {
        const boardOrUrl = company.board_identifier || company.career_url || company.website_url;
        const res = await fetchAshbyJobs(boardOrUrl, company.id, company.name, { fetchFn, timeoutMs });
        const adapterResult = new AdapterResult({
            sourceType: 'ashby',
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
