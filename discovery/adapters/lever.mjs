/**
 * discovery/adapters/lever.mjs — Lever ATS Discovery Adapter
 *
 * Supports:
 *   - jobs.lever.co/{company}
 *   - Direct Lever API endpoints: api.lever.co/v0/postings/{company}
 */

import { createNormalizedJob, detectRemoteType, detectEmploymentType, fetchWithRetry } from './base.mjs';
import { AdapterResult, validateAdapterResult } from '../interfaces.mjs';

export const LEVER_REGEX = /jobs\.lever\.co\/([^/?#]+)/i;

export function extractCompany(url) {
    if (!url) return null;
    const match = url.match(LEVER_REGEX);
    return match ? match[1] : null;
}

export function buildEndpoint(companyOrUrl) {
    const comp = extractCompany(companyOrUrl) || companyOrUrl;
    if (!comp) return null;
    return `https://api.lever.co/v0/postings/${comp}?mode=json`;
}

export function parseLeverResponse(json, companyId, companyName) {
    if (!Array.isArray(json)) {
        return [];
    }

    const seenUrls = new Set();
    const result = [];

    for (const j of json) {
        const title = j.text?.trim() || '';
        const url = j.hostedUrl?.trim() || '';

        if (!title || !url) {
            continue;
        }

        if (seenUrls.has(url)) {
            continue;
        }
        seenUrls.add(url);

        const location = j.categories?.location?.trim() || null;
        const commitment = j.categories?.commitment?.trim() || '';
        const workplaceType = j.workplaceType || '';
        const remoteType = workplaceType.toLowerCase().includes('remote')
            ? 'remote'
            : detectRemoteType(title, `${location || ''} ${workplaceType}`);
        const empType = detectEmploymentType(title, commitment, '');

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
            description: j.descriptionPlain || j.description || null,
            source: 'lever',
            source_job_id: String(j.id || ''),
            source_updated_at: j.createdAt ? new Date(j.createdAt).toISOString() : null,
            raw: j
        }));
    }

    return result;
}

export async function fetchLeverJobs(companyOrUrl, companyId, companyName, { fetchFn = fetch, timeoutMs = 10000 } = {}) {
    const endpoint = buildEndpoint(companyOrUrl);
    if (!endpoint) {
        return {
            jobs: [], endpoint: null, total: 0,
            fetchedCount: 0, normalizedCount: 0, invalidCount: 0, duplicateInSourceCount: 0,
            error: `Invalid Lever company or URL: ${companyOrUrl}`
        };
    }

    try {
        const res = await fetchWithRetry(endpoint, {
            headers: { 'Accept': 'application/json' }
        }, { timeoutMs, fetchFn });

        const json = await res.json();
        const rawList = Array.isArray(json) ? json : [];
        const jobs = parseLeverResponse(json, companyId, companyName);
        const invalidCount = Math.max(0, rawList.length - jobs.length);
        const seen = new Set();
        let duplicateInSourceCount = 0;
        for (const r of rawList) {
            const u = r.hostedUrl?.trim();
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
 * Standard ATSBoardAdapter implementation for Lever
 */
export class LeverAdapter {
    constructor() {
        this.sourceType = 'lever';
    }

    async fetchJobs(company, { fetchFn = fetch, timeoutMs = 10000 } = {}) {
        const boardOrUrl = company.board_identifier || company.career_url || company.website_url;
        const res = await fetchLeverJobs(boardOrUrl, company.id, company.name, { fetchFn, timeoutMs });
        const adapterResult = new AdapterResult({
            sourceType: 'lever',
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
