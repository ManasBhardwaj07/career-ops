/**
 * discovery/adapters/recruitee.mjs — Recruitee Public Careers Site API Discovery Adapter
 *
 * Supports Recruitee's unauthenticated public Careers Site API:
 *   Endpoint: GET https://{company_slug}.recruitee.com/api/offers/
 *   or        GET https://api.recruitee.com/c/{company_id}/offers
 *
 * Implements ATSBoardAdapter contract.
 */

import { createNormalizedJob, detectRemoteType, detectEmploymentType, fetchWithRetry } from './base.mjs';
import { AdapterResult, validateAdapterResult } from '../interfaces.mjs';

export const RECRUITEE_SUBDOMAIN_REGEX = /(?:https?:\/\/)?([a-zA-Z0-9-]+)\.recruitee\.com(?:\/|$)/i;
export const RECRUITEE_API_REGEX = /(?:https?:\/\/)?api\.recruitee\.com\/c\/([^/?#]+)\/offers/i;
const RESERVED_RECRUITEE_SUBDOMAINS = new Set(['api', 'www', 'docs', 'app', 'help', 'status']);

/**
 * Extracts Recruitee company slug or API ID from a career URL, API URL, or plain slug.
 */
export function extractCompany(urlOrSlug) {
    if (!urlOrSlug) return null;
    const trimmed = String(urlOrSlug).trim();

    const apiMatch = trimmed.match(RECRUITEE_API_REGEX);
    if (apiMatch && apiMatch[1]) {
        return apiMatch[1];
    }

    const subMatch = trimmed.match(RECRUITEE_SUBDOMAIN_REGEX);
    if (subMatch && subMatch[1] && !RESERVED_RECRUITEE_SUBDOMAINS.has(subMatch[1].toLowerCase())) {
        return subMatch[1];
    }

    if (/^[a-zA-Z0-9_-]+$/.test(trimmed) && !RESERVED_RECRUITEE_SUBDOMAINS.has(trimmed.toLowerCase())) {
        return trimmed;
    }

    return null;
}

export function buildEndpoint(companyOrUrl) {
    const trimmed = String(companyOrUrl || '').trim();
    const apiMatch = trimmed.match(RECRUITEE_API_REGEX);
    if (apiMatch && apiMatch[1]) {
        return `https://api.recruitee.com/c/${apiMatch[1]}/offers`;
    }

    const slug = extractCompany(trimmed);
    if (!slug) return null;

    if (/^\d+$/.test(slug)) {
        return `https://api.recruitee.com/c/${slug}/offers`;
    }
    return `https://${slug}.recruitee.com/api/offers/`;
}

function formatRecruiteeLocation(offer) {
    const parts = [];
    if (offer.city) parts.push(String(offer.city).trim());
    if (offer.state_name || offer.state) parts.push(String(offer.state_name || offer.state).trim());
    if (offer.country) parts.push(String(offer.country).trim());
    if (parts.length > 0) {
        return parts.filter(Boolean).join(', ');
    }
    if (typeof offer.location === 'string' && offer.location.trim()) {
        return offer.location.trim();
    }
    return null;
}

function buildRecruiteeDescription(offer) {
    const sections = [];
    if (offer.description && typeof offer.description === 'string' && offer.description.trim()) {
        sections.push(offer.description.trim());
    }
    if (offer.requirements && typeof offer.requirements === 'string' && offer.requirements.trim()) {
        sections.push(offer.requirements.trim());
    }
    return sections.length > 0 ? sections.join('\n\n') : null;
}

/**
 * Parse Recruitee public Careers Site API JSON response into canonical normalized jobs.
 */
export function parseRecruiteeResponse(json, companyId, companyName, companySlug = null) {
    if (!json || !Array.isArray(json.offers)) {
        return [];
    }

    const seenUrls = new Set();
    const seenIds = new Set();
    const result = [];

    for (const offer of json.offers) {
        if (!offer || typeof offer !== 'object') continue;
        if (offer.status && ['closed', 'archived', 'draft'].includes(String(offer.status).toLowerCase())) {
            continue;
        }

        const title = (offer.title || '').trim();
        const sourceJobId = offer.id != null ? String(offer.id).trim() : (offer.slug ? String(offer.slug).trim() : '');
        const rawUrl = (offer.careers_url || offer.url || '').trim() ||
            (companySlug && offer.slug ? `https://${companySlug}.recruitee.com/o/${offer.slug}` : '');

        if (!title || !rawUrl) {
            continue;
        }

        if (seenUrls.has(rawUrl) || (sourceJobId && seenIds.has(sourceJobId))) {
            continue;
        }
        seenUrls.add(rawUrl);
        if (sourceJobId) seenIds.add(sourceJobId);

        const locationStr = formatRecruiteeLocation(offer);
        let remoteType = null;
        if (offer.remote === true) {
            remoteType = 'remote';
        } else if (offer.hybrid === true) {
            remoteType = 'hybrid';
        } else if (offer.on_site === true || offer['on-site'] === true) {
            remoteType = 'onsite';
        } else {
            remoteType = detectRemoteType(title, locationStr || '');
        }

        const empRaw = String(offer.employment_type_code || offer.employment_type || offer.hours || '').replace(/_/g, ' ');
        const empType = detectEmploymentType(title, empRaw, '');
        const applicationUrl = offer.careers_apply_url && typeof offer.careers_apply_url === 'string' && offer.careers_apply_url.trim()
            ? offer.careers_apply_url.trim()
            : null;
        // Only map Recruitee's explicit update timestamp to source_updated_at
        const updatedAt = offer.updated_at || null;

        const normalized = createNormalizedJob({
            id: rawUrl,
            company_id: companyId,
            company_name: companyName || offer.company_name || null,
            title,
            location: locationStr,
            remote_type: remoteType,
            applicant_eligibility: null,
            employment_type: empType,
            job_url: rawUrl,
            description: buildRecruiteeDescription(offer),
            source: 'recruitee',
            source_job_id: sourceJobId || null,
            source_updated_at: updatedAt,
            raw: applicationUrl ? { ...offer, application_url: applicationUrl } : offer
        });
        normalized.application_url = applicationUrl;
        normalized.published_at = offer.published_at || null;
        result.push(normalized);
    }

    return result;
}

/**
 * Fetch jobs from Recruitee's public Careers Site API.
 */
export async function fetchRecruiteeJobs(companyOrUrl, companyId, companyName, {
    fetchFn = fetch,
    timeoutMs = 10000
} = {}) {
    const companySlug = extractCompany(companyOrUrl);
    const endpoint = buildEndpoint(companyOrUrl);
    if (!endpoint || !companySlug) {
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
            error: `Invalid Recruitee company slug or URL: ${companyOrUrl}`
        };
    }

    try {
        const res = await fetchWithRetry(endpoint, {
            headers: { 'Accept': 'application/json' }
        }, { timeoutMs, fetchFn });

        const json = await res.json();
        if (!json || !Array.isArray(json.offers)) {
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
                error: 'Malformed Recruitee API response: missing offers array'
            };
        }

        const rawList = json.offers;
        const jobs = parseRecruiteeResponse(json, companyId, companyName, companySlug);

        const seenUrls = new Set();
        const seenIds = new Set();
        let duplicateInSourceCount = 0;
        let invalidCount = 0;
        let filteredCount = 0;

        for (const r of rawList) {
            if (!r || typeof r !== 'object') {
                invalidCount++;
                continue;
            }
            if (r.status && ['closed', 'archived', 'draft'].includes(String(r.status).toLowerCase())) {
                filteredCount++;
                continue;
            }
            const title = (r.title || '').trim();
            const sid = r.id != null ? String(r.id).trim() : (r.slug ? String(r.slug).trim() : '');
            const u = (r.careers_url || r.url || '').trim() ||
                (companySlug && r.slug ? `https://${companySlug}.recruitee.com/o/${r.slug}` : '');

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
            filteredCount,
            duplicateInSourceCount,
            pagesFetched: 1,
            isComplete: true,
            completenessReason: 'unpaginated_official_careers_offers_endpoint',
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
 * Standard ATSBoardAdapter implementation for Recruitee.
 */
export class RecruiteeAdapter {
    constructor() {
        this.sourceType = 'recruitee';
    }

    async fetchJobs(company, { fetchFn = fetch, timeoutMs = 10000 } = {}) {
        const boardOrUrl = company.board_identifier || company.career_url || company.website_url;
        const res = await fetchRecruiteeJobs(boardOrUrl, company.id, company.name, { fetchFn, timeoutMs });
        const adapterResult = new AdapterResult({
            sourceType: 'recruitee',
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
