/**
 * discovery/adapters/instahyre-adapter.mjs — Instahyre Portal Adapter (Hybrid Public/Authenticated)
 *
 * Implements Deliverable 6 (Portal 2 in sequence):
 * - Instahyre operates a hybrid architecture:
 *   1. Public Discovery: Server-rendered search pages at /search-jobs/ containing
 *      verified tech postings (/job-<id>-<slug>).
 *   2. Authenticated Candidate Feed: Inbound recruiter outreach and matched opportunity
 *      recommendations gated by session cookies / Bearer token.
 * - Integrates with SessionVault (`data/sessions/instahyre/session.json`).
 * - Gracefully falls back to public discovery or reports AUTHENTICATION_REQUIRED for
 *   candidate-matched private endpoints.
 * - Enforces fail-closed safety (zero CAPTCHA/WAF bypass).
 * - Standardizes all jobs to career-ops schema.
 */

import { createNormalizedJob, detectRemoteType, detectEmploymentType } from './base.mjs';
import { sessionVault } from '../sessions/session-vault.mjs';

export const INSTAHYRE_BASE_URL = 'https://www.instahyre.com';
export const INSTAHYRE_PUBLIC_SEARCH_URL = 'https://www.instahyre.com/search-jobs/';
export const INSTAHYRE_CANDIDATE_OPPORTUNITIES_ENDPOINT = 'https://www.instahyre.com/api/v1/candidate_opportunities';

export class InstahyreAdapter {
    constructor({ fetchFn = fetch, vault = sessionVault } = {}) {
        this.fetchFn = fetchFn;
        this.vault = vault;
        this.provider = 'instahyre';
    }

    /**
     * Parses Instahyre JSON API response (from authenticated feed or structured API).
     */
    parseApiResponse(rawData) {
        if (!rawData) return [];

        let data = rawData;
        if (typeof rawData === 'string') {
            try {
                data = JSON.parse(rawData);
            } catch {
                return [];
            }
        }

        const items = data.jobs || data.objects || data.opportunities || data.data || (Array.isArray(data) ? data : []);
        const normalized = [];

        for (const item of items) {
            if (!item || typeof item !== 'object') continue;

            const title = item.title || item.designation || item.job_title;
            if (!title) continue;

            const jobId = item.id || item.job_id;
            const jobUrl = item.url || (jobId ? `${INSTAHYRE_BASE_URL}/job-${jobId}` : null);
            if (!jobUrl) continue;

            const companyName = item.company_name || (item.company && item.company.name) || 'Tech Employer via Instahyre';
            const location = item.location || (item.locations ? item.locations.join(', ') : 'India');
            const remoteType = detectRemoteType(title, location, item.workplace_type || item.work_type || '');
            const employmentType = detectEmploymentType(title, item.type || '', item.employment_type || '');
            const description = item.description || item.job_description || item.snippet || '';

            try {
                const job = createNormalizedJob({
                    company_name: companyName,
                    title,
                    location,
                    remote_type: remoteType,
                    applicant_eligibility: item.eligibility || 'Open to India',
                    employment_type: employmentType || 'full-time',
                    job_url: jobUrl,
                    description,
                    source: 'instahyre',
                    source_job_id: jobId ? `instahyre_${jobId}` : null,
                    raw: item
                });
                normalized.push(job);
            } catch {
                // Ignore single job normalization error
            }
        }

        return normalized;
    }

    /**
     * Parses Instahyre public search HTML page.
     * Extracts /job-<id>-<slug> listings, titles, company names, and locations.
     */
    parseHtmlListings(html) {
        if (!html || typeof html !== 'string') return [];

        const normalized = [];
        // Pattern: href="/job-(\d+)-([^"]+)"
        const linkRegex = /href="\/job-(\d+)-([^"]+)"/gi;
        const matches = [...html.matchAll(linkRegex)];
        const seenUrls = new Set();

        for (const match of matches) {
            const jobId = match[1];
            const slug = match[2];
            const relativeUrl = `/job-${jobId}-${slug}`;
            const fullUrl = `${INSTAHYRE_BASE_URL}${relativeUrl}`;

            if (seenUrls.has(fullUrl)) continue;
            seenUrls.add(fullUrl);

            // Clean title and company from slug if HTML markup parsing is minimal
            // e.g. "sde-fullstack-developer-at-gokiwi-bengaluru" -> Title: "SDE Fullstack Developer", Company: "Gokiwi"
            let title = 'Software Engineer';
            let companyName = 'Tech Employer via Instahyre';
            let location = 'India';

            if (slug.includes('-at-')) {
                const parts = slug.split('-at-');
                const titlePart = parts[0];
                const restPart = parts[1] || '';

                title = titlePart.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
                const restTokens = restPart.split('-');
                if (restTokens.length > 0) {
                    companyName = restTokens[0].charAt(0).toUpperCase() + restTokens[0].slice(1);
                    if (restTokens.length > 1) {
                        location = restTokens.slice(1).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
                    }
                }
            }

            try {
                const job = createNormalizedJob({
                    company_name: companyName,
                    title,
                    location,
                    remote_type: detectRemoteType(title, location),
                    applicant_eligibility: 'Open to India',
                    employment_type: 'full-time',
                    job_url: fullUrl,
                    description: `Discovered from Instahyre listing: ${title} at ${companyName}`,
                    source: 'instahyre',
                    source_job_id: `instahyre_${jobId}`,
                    raw: { jobId, slug, fullUrl }
                });
                normalized.push(job);
            } catch {
                // Ignore individual parsing failure
            }
        }

        return normalized;
    }

    /**
     * Fetches Instahyre jobs:
     * - If candidate feed requested (`options.authenticatedOnly: true`), uses SessionVault.
     * - Otherwise checks public search or authenticated feed depending on session availability.
     */
    async fetchJobs(options = {}) {
        const hasSession = this.vault.hasValidSession('instahyre');

        // If authenticated candidate feed specifically requested
        if (options.authenticatedOnly) {
            if (!hasSession) {
                return {
                    jobs: [],
                    status: 'AUTHENTICATION_REQUIRED',
                    authenticated: false,
                    requiresInteractiveLogin: true,
                    message: 'Instahyre candidate opportunities feed requires authenticated session in data/sessions/instahyre/session.json.',
                    portal: 'instahyre'
                };
            }

            return this._fetchAuthenticatedOpportunities(options);
        }

        // If valid session exists, prefer authenticated opportunities
        if (hasSession) {
            const authResult = await this._fetchAuthenticatedOpportunities(options);
            if (authResult.status === 'SUCCESS' && authResult.jobs.length > 0) {
                return authResult;
            }
            // If session expired or failed, report or fall back to public
            if (authResult.status === 'SESSION_EXPIRED') {
                return authResult;
            }
        }

        // Public discovery route
        return this._fetchPublicListings(options);
    }

    async _fetchAuthenticatedOpportunities(options = {}) {
        const session = this.vault.loadSession('instahyre');
        const cookieHeader = this.vault.getCookieHeader('instahyre');
        const customHeaders = (session && session.headers) || {};

        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            'Accept': 'application/json, text/plain, */*',
            ...customHeaders
        };

        if (cookieHeader) {
            headers['Cookie'] = cookieHeader;
        }

        try {
            const endpoint = options.endpoint || INSTAHYRE_CANDIDATE_OPPORTUNITIES_ENDPOINT;
            const res = await this.fetchFn(endpoint, {
                method: 'GET',
                headers
            });

            if (res.status === 401 || res.status === 403) {
                return {
                    jobs: [],
                    status: 'SESSION_EXPIRED',
                    authenticated: false,
                    requiresInteractiveLogin: true,
                    message: `Instahyre session expired or invalid (HTTP ${res.status}).`,
                    portal: 'instahyre'
                };
            }

            if (!res.ok) {
                return {
                    jobs: [],
                    status: 'UPSTREAM_ERROR',
                    authenticated: true,
                    httpStatus: res.status,
                    message: `Instahyre returned HTTP ${res.status}`,
                    portal: 'instahyre'
                };
            }

            const rawText = await res.text();
            if (rawText.includes('cf-browser-verification') || rawText.includes('challenges.cloudflare.com')) {
                return {
                    jobs: [],
                    status: 'BLOCKED_BY_CHALLENGE',
                    authenticated: false,
                    requiresInteractiveLogin: true,
                    message: 'Instahyre returned Cloudflare challenge. Automated bypass is strictly prevented.',
                    portal: 'instahyre'
                };
            }

            const data = JSON.parse(rawText);
            const jobs = this.parseApiResponse(data);

            return {
                jobs,
                status: 'SUCCESS',
                authenticated: true,
                count: jobs.length,
                portal: 'instahyre'
            };
        } catch (err) {
            return {
                jobs: [],
                status: 'NETWORK_ERROR',
                authenticated: true,
                message: err.message || 'Instahyre authenticated fetch error',
                portal: 'instahyre'
            };
        }
    }

    async _fetchPublicListings(options = {}) {
        try {
            const url = options.searchUrl || INSTAHYRE_PUBLIC_SEARCH_URL;
            const res = await this.fetchFn(url, {
                method: 'GET',
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
                }
            });

            if (res.status === 403 || res.status === 429) {
                return {
                    jobs: [],
                    status: 'BLOCKED_BY_WAF',
                    authenticated: false,
                    httpStatus: res.status,
                    message: `Instahyre public search gated by WAF/rate-limit (HTTP ${res.status}).`,
                    portal: 'instahyre'
                };
            }

            if (!res.ok) {
                return {
                    jobs: [],
                    status: 'UPSTREAM_ERROR',
                    authenticated: false,
                    httpStatus: res.status,
                    message: `Instahyre public search returned HTTP ${res.status}`,
                    portal: 'instahyre'
                };
            }

            const html = await res.text();
            if (html.includes('challenges.cloudflare.com') || html.includes('cf-browser-verification')) {
                return {
                    jobs: [],
                    status: 'BLOCKED_BY_CHALLENGE',
                    authenticated: false,
                    message: 'Instahyre public page gated by Cloudflare challenge.',
                    portal: 'instahyre'
                };
            }

            const jobs = this.parseHtmlListings(html);

            return {
                jobs,
                status: 'SUCCESS',
                authenticated: false,
                count: jobs.length,
                portal: 'instahyre'
            };
        } catch (err) {
            return {
                jobs: [],
                status: 'NETWORK_ERROR',
                authenticated: false,
                message: err.message || 'Instahyre public fetch error',
                portal: 'instahyre'
            };
        }
    }
}

export function fetchInstahyreJobs(options = {}) {
    const adapter = new InstahyreAdapter(options);
    return adapter.fetchJobs(options);
}
