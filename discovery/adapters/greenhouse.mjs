/**
 * discovery/adapters/greenhouse.mjs — Greenhouse ATS Discovery Adapter
 *
 * Supports:
 *   - boards.greenhouse.io/{board}
 *   - job-boards.greenhouse.io/{board}
 *   - job-boards.eu.greenhouse.io/{board}
 *   - Direct boards API endpoints
 */

import { createNormalizedJob, detectRemoteType, detectEmploymentType, fetchWithRetry } from './base.mjs';
import { AdapterResult, validateAdapterResult } from '../interfaces.mjs';

export const GREENHOUSE_REGEX = /(?:boards|job-boards(?:\.eu)?|boards-api)\.greenhouse\.io\/(?:v1\/boards\/)?([^/?#]+)/i;

export function extractBoard(url) {
    if (!url) return null;
    const match = url.match(GREENHOUSE_REGEX);
    return match ? match[1] : null;
}

export function buildEndpoint(boardOrUrl) {
    const board = extractBoard(boardOrUrl) || boardOrUrl;
    if (!board) return null;
    return `https://boards-api.greenhouse.io/v1/boards/${board}/jobs?content=true`;
}

export function parseGreenhouseResponse(json, companyId, companyName) {
    if (!json || !Array.isArray(json.jobs)) {
        return [];
    }

    const seenUrls = new Set();
    const result = [];

    for (const j of json.jobs) {
        const title = j.title?.trim() || '';
        const url = j.absolute_url?.trim() || '';

        if (!title || !url) {
            continue;
        }

        if (seenUrls.has(url)) {
            continue;
        }
        seenUrls.add(url);

        const location = j.location?.name?.trim() || null;
        const remoteType = detectRemoteType(title, location || '');
        const empType = detectEmploymentType(title, '', '');

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
            description: j.content || null,
            source: 'greenhouse',
            source_job_id: String(j.id || ''),
            source_updated_at: j.updated_at || null,
            raw: j
        }));
    }

    return result;
}

export async function fetchGreenhouseJobs(boardOrUrl, companyId, companyName, { fetchFn = fetch, timeoutMs = 10000 } = {}) {
    const endpoint = buildEndpoint(boardOrUrl);
    if (!endpoint) {
        return {
            jobs: [], endpoint: null, total: 0,
            fetchedCount: 0, normalizedCount: 0, invalidCount: 0, duplicateInSourceCount: 0,
            error: `Invalid Greenhouse board or URL: ${boardOrUrl}`
        };
    }

    try {
        const res = await fetchWithRetry(endpoint, {
            headers: { 'Accept': 'application/json' }
        }, { timeoutMs, fetchFn });

        const json = await res.json();
        const rawList = Array.isArray(json?.jobs) ? json.jobs : [];
        const jobs = parseGreenhouseResponse(json, companyId, companyName);
        const invalidCount = Math.max(0, rawList.length - jobs.length);
        const seen = new Set();
        let duplicateInSourceCount = 0;
        for (const r of rawList) {
            const u = r.absolute_url?.trim();
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
 * Standard ATSBoardAdapter implementation for Greenhouse
 */
export class GreenhouseAdapter {
    constructor() {
        this.sourceType = 'greenhouse';
    }

    async fetchJobs(company, { fetchFn = fetch, timeoutMs = 10000 } = {}) {
        const boardOrUrl = company.board_identifier || company.career_url || company.website_url;
        const res = await fetchGreenhouseJobs(boardOrUrl, company.id, company.name, { fetchFn, timeoutMs });
        const adapterResult = new AdapterResult({
            sourceType: 'greenhouse',
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
