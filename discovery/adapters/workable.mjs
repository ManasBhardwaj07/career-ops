/**
 * discovery/adapters/workable.mjs — Workable Public Widget API Discovery Adapter
 *
 * Supports Workable's unauthenticated Public Widget API (v1):
 *   Endpoint: GET https://apply.workable.com/api/v1/widget/accounts/{account_slug}?details=true
 *
 * Implements ATSBoardAdapter contract.
 */

import { createNormalizedJob, detectRemoteType, detectEmploymentType, fetchWithRetry } from './base.mjs';
import { AdapterResult, validateAdapterResult } from '../interfaces.mjs';

export const WORKABLE_REGEX = /(?:https?:\/\/)?(?:apply|www)\.workable\.com\/(?:api\/v[13]\/(?:widget\/)?accounts\/)?([^/?#]+)/i;
const RESERVED_WORKABLE_SEGMENTS = new Set(['api', 'j', 'jobs', 'assets', 'static', 'favicon.ico']);

/**
 * Extracts Workable account slug from a board URL, widget API URL, or plain slug.
 */
export function extractAccount(urlOrSlug) {
    if (!urlOrSlug) return null;
    const trimmed = String(urlOrSlug).trim();

    const match = trimmed.match(WORKABLE_REGEX);
    if (match) {
        const candidate = match[1];
        if (candidate && !RESERVED_WORKABLE_SEGMENTS.has(candidate.toLowerCase())) {
            return candidate;
        }
        return null;
    }

    if (/^[a-zA-Z0-9_-]+$/.test(trimmed) && !RESERVED_WORKABLE_SEGMENTS.has(trimmed.toLowerCase())) {
        return trimmed;
    }

    return null;
}

export function buildEndpoint(accountOrUrl) {
    const account = extractAccount(accountOrUrl);
    if (!account) return null;
    return `https://apply.workable.com/api/v1/widget/accounts/${account}?details=true`;
}

function formatWorkableLocation(j) {
    const locObj = j.location && typeof j.location === 'object' ? j.location : null;
    const parts = [];
    const city = locObj?.city || j.city;
    const region = locObj?.region || locObj?.state || j.state;
    const country = locObj?.country || j.country;

    if (city) parts.push(String(city).trim());
    if (region) parts.push(String(region).trim());
    if (country) parts.push(String(country).trim());

    if (parts.length > 0) {
        return parts.filter(Boolean).join(', ');
    }

    if (typeof j.location === 'string' && j.location.trim()) {
        return j.location.trim();
    }

    if (Array.isArray(j.locations) && j.locations.length > 0) {
        const first = j.locations[0];
        if (typeof first === 'string' && first.trim()) return first.trim();
        if (first && typeof first === 'object') {
            return [first.city, first.region || first.state, first.country].filter(Boolean).join(', ') || null;
        }
    }

    return null;
}

function buildWorkableDescription(j) {
    const sections = [];
    if (j.description && typeof j.description === 'string' && j.description.trim()) {
        sections.push(j.description.trim());
    }
    if (j.requirements && typeof j.requirements === 'string' && j.requirements.trim()) {
        sections.push(j.requirements.trim());
    }
    if (j.benefits && typeof j.benefits === 'string' && j.benefits.trim()) {
        sections.push(j.benefits.trim());
    }
    return sections.length > 0 ? sections.join('\n\n') : null;
}

/**
 * Parse Workable Public Widget API v1 JSON response into canonical normalized jobs.
 */
export function parseWorkableResponse(json, companyId, companyName, accountSlug = null) {
    if (!json || !Array.isArray(json.jobs)) {
        return [];
    }

    const seenUrls = new Set();
    const seenIds = new Set();
    const result = [];

    for (const j of json.jobs) {
        if (!j || typeof j !== 'object') continue;

        const title = (j.title || j.full_title || '').trim();
        const shortcode = j.shortcode ? String(j.shortcode).trim() : '';
        const sourceJobId = shortcode || (j.id != null ? String(j.id).trim() : '');
        const rawUrl = (j.url || j.shortlink || '').trim() ||
            (accountSlug && shortcode ? `https://apply.workable.com/${accountSlug}/j/${shortcode}/` : '');

        if (!title || !rawUrl) {
            continue;
        }

        if (seenUrls.has(rawUrl) || (sourceJobId && seenIds.has(sourceJobId))) {
            continue;
        }
        seenUrls.add(rawUrl);
        if (sourceJobId) seenIds.add(sourceJobId);

        const locationStr = formatWorkableLocation(j);
        const workplaceType = j.workplace_type || (j.telecommuting === true || j.location?.telecommuting === true ? 'remote' : '');
        let remoteType = null;
        if (j.telecommuting === true || j.location?.telecommuting === true || String(j.workplace_type || '').toLowerCase() === 'remote') {
            remoteType = 'remote';
        } else if (String(j.workplace_type || '').toLowerCase() === 'hybrid') {
            remoteType = 'hybrid';
        } else {
            remoteType = detectRemoteType(title, locationStr || '', workplaceType);
        }

        const empType = detectEmploymentType(title, '', String(j.employment_type || '').replace(/_/g, ' '));
        const applicationUrl = j.application_url && typeof j.application_url === 'string' && j.application_url.trim()
            ? j.application_url.trim()
            : null;
        // Workable v1 widget exposes published_on and created_at; only map an explicit updated_at to source_updated_at
        const updatedAt = j.updated_at || null;

        const normalized = createNormalizedJob({
            id: rawUrl,
            company_id: companyId,
            company_name: companyName || json.name || null,
            title,
            location: locationStr,
            remote_type: remoteType,
            applicant_eligibility: null,
            employment_type: empType,
            job_url: rawUrl,
            description: buildWorkableDescription(j),
            source: 'workable',
            source_job_id: sourceJobId || null,
            source_updated_at: updatedAt,
            raw: applicationUrl ? { ...j, application_url: applicationUrl } : j
        });
        normalized.application_url = applicationUrl;
        normalized.published_at = j.published_on || null;
        result.push(normalized);
    }

    return result;
}

/**
 * Fetch jobs from Workable's public v1 widget endpoint.
 */
export async function fetchWorkableJobs(accountOrUrl, companyId, companyName, {
    fetchFn = fetch,
    timeoutMs = 10000
} = {}) {
    const account = extractAccount(accountOrUrl);
    const endpoint = buildEndpoint(accountOrUrl);
    if (!endpoint || !account) {
        return {
            jobs: [],
            endpoint: null,
            total: 0,
            fetchedCount: 0,
            normalizedCount: 0,
            invalidCount: 0,
            duplicateInSourceCount: 0,
            pagesFetched: 0,
            isComplete: false,
            error: `Invalid Workable account slug or URL: ${accountOrUrl}`
        };
    }

    try {
        const res = await fetchWithRetry(endpoint, {
            headers: { 'Accept': 'application/json' }
        }, { timeoutMs, fetchFn });

        const json = await res.json();
        if (!json || !Array.isArray(json.jobs)) {
            return {
                jobs: [],
                endpoint,
                total: 0,
                fetchedCount: 0,
                normalizedCount: 0,
                invalidCount: 0,
                duplicateInSourceCount: 0,
                pagesFetched: 1,
                isComplete: false,
                error: 'Malformed Workable API response: missing jobs array'
            };
        }

        const rawList = json.jobs;
        const jobs = parseWorkableResponse(json, companyId, companyName, account);

        const seenUrls = new Set();
        const seenIds = new Set();
        let duplicateInSourceCount = 0;
        let invalidCount = 0;

        for (const r of rawList) {
            if (!r || typeof r !== 'object') {
                invalidCount++;
                continue;
            }
            const title = (r.title || r.full_title || '').trim();
            const shortcode = r.shortcode ? String(r.shortcode).trim() : '';
            const sid = shortcode || (r.id != null ? String(r.id).trim() : '');
            const u = (r.url || r.shortlink || '').trim() ||
                (account && shortcode ? `https://apply.workable.com/${account}/j/${shortcode}/` : '');

            if (!title || !u) {
                invalidCount++;
                continue;
            }
            if (seenUrls.has(u) || (sid && seenIds.has(sid))) {
                duplicateInSourceCount++;
            } else {
                seenUrls.add(u);
                if (sid) seenIds.add(sid);
            }
        }

        return {
            jobs,
            endpoint,
            total: jobs.length,
            fetchedCount: rawList.length,
            normalizedCount: jobs.length,
            invalidCount,
            filteredCount: 0,
            duplicateInSourceCount,
            pagesFetched: 1,
            // Workable v1 widget endpoint provides no total count or pagination completeness guarantee
            isComplete: false,
            completenessReason: 'unpaginated_v1_widget_without_completeness_metadata',
            error: null
        };
    } catch (err) {
        return {
            jobs: [],
            endpoint,
            total: 0,
            fetchedCount: 0,
            normalizedCount: 0,
            invalidCount: 0,
            filteredCount: 0,
            duplicateInSourceCount: 0,
            pagesFetched: 0,
            isComplete: false,
            error: err.message
        };
    }
}

/**
 * Standard ATSBoardAdapter implementation for Workable.
 */
export class WorkableAdapter {
    constructor() {
        this.sourceType = 'workable';
    }

    async fetchJobs(company, { fetchFn = fetch, timeoutMs = 10000 } = {}) {
        const boardOrUrl = company.board_identifier || company.career_url || company.website_url;
        const res = await fetchWorkableJobs(boardOrUrl, company.id, company.name, { fetchFn, timeoutMs });
        const adapterResult = new AdapterResult({
            sourceType: 'workable',
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
