/**
 * discovery/adapters/cutshort-adapter.mjs — Cutshort Portal Adapter (Authenticated & Session-Gated)
 *
 * Implements Deliverable 6 (Portal 1: Cutshort in sequence):
 * - Cutshort is a walled-garden hiring portal protected by Cloudflare Turnstile
 *   and authenticated candidate sessions (`cutshort_authentication` cookie).
 * - Checks SessionVault for valid authenticated session.
 * - If no session exists or session is expired, safely reports AUTHENTICATION_REQUIRED
 *   or SESSION_EXPIRED without failing destructively or bypassing security gates (R20).
 * - When valid session is present (via human login checkpoint), fetches candidate
 *   matched opportunities / recommendations and normalizes to career-ops schema.
 */

import { createNormalizedJob, detectRemoteType, detectEmploymentType } from './base.mjs';
import { sessionVault } from '../sessions/session-vault.mjs';

export const CUTSHORT_BASE_URL = 'https://cutshort.io';
export const CUTSHORT_OPPORTUNITIES_ENDPOINT = 'https://cutshort.io/backend-api/candidate/opportunities';
export const CUTSHORT_FEED_ENDPOINT = 'https://cutshort.io/backend-api/jobs/matched';

export class CutshortAdapter {
    constructor({ fetchFn = fetch, vault = sessionVault } = {}) {
        this.fetchFn = fetchFn;
        this.vault = vault;
        this.provider = 'cutshort';
    }

    /**
     * Parses Cutshort opportunity payload into normalized career-ops jobs.
     */
    parseResponse(rawData) {
        if (!rawData) return [];

        let data = rawData;
        if (typeof rawData === 'string') {
            try {
                data = JSON.parse(rawData);
            } catch {
                return [];
            }
        }

        const items = data.opportunities || data.jobs || data.data || (Array.isArray(data) ? data : []);
        const normalized = [];

        for (const item of items) {
            if (!item || typeof item !== 'object') continue;

            const title = item.title || item.designation || item.role;
            if (!title) continue;

            const slug = item.slug || item.id || item.jobId;
            const jobUrl = item.url || (slug ? `${CUTSHORT_BASE_URL}/job/${slug}` : null);
            if (!jobUrl) continue;

            const companyName = item.companyName || (item.company && item.company.name) || 'Tech Employer via Cutshort';
            const location = item.location || (item.locations ? item.locations.join(', ') : 'India');
            const remoteType = detectRemoteType(title, location, item.workplaceType || item.locationType || '');
            const employmentType = detectEmploymentType(title, item.type || '', item.employmentType || '');

            const description = item.description || item.jd || item.jobDescription || item.snippet || '';
            const sourceJobId = item.id || item.jobId ? `cutshort_${item.id || item.jobId}` : null;

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
                    source: 'cutshort',
                    source_job_id: sourceJobId,
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
     * Fetches opportunities from Cutshort using session vault credentials.
     * Enforces fail-safe security gates:
     * - Returns AUTHENTICATION_REQUIRED if no session.
     * - Returns SESSION_EXPIRED if 401/403 or redirect to login.
     * - Returns jobs if authenticated.
     */
    async fetchJobs(options = {}) {
        const hasSession = this.vault.hasValidSession('cutshort');

        if (!hasSession) {
            return {
                jobs: [],
                status: 'AUTHENTICATION_REQUIRED',
                authenticated: false,
                requiresInteractiveLogin: true,
                message: 'Cutshort candidate opportunities require an authenticated session. Place valid session in data/sessions/cutshort/session.json or complete human login checkpoint.',
                portal: 'cutshort'
            };
        }

        const session = this.vault.loadSession('cutshort');
        const cookieHeader = this.vault.getCookieHeader('cutshort');
        const customHeaders = (session && session.headers) || {};

        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            'Accept': 'application/json, text/plain, */*',
            'Referer': `${CUTSHORT_BASE_URL}/candidate/opportunities`,
            ...customHeaders
        };

        if (cookieHeader) {
            headers['Cookie'] = cookieHeader;
        }

        const endpoint = options.endpoint || CUTSHORT_OPPORTUNITIES_ENDPOINT;

        try {
            const res = await this.fetchFn(endpoint, {
                method: 'GET',
                headers
            });

            // Check if response redirected to unauth or returned 401/403
            if (res.status === 401 || res.status === 403 || res.status === 400) {
                return {
                    jobs: [],
                    status: 'SESSION_EXPIRED',
                    authenticated: false,
                    requiresInteractiveLogin: true,
                    httpStatus: res.status,
                    message: `Cutshort session expired or invalidated (HTTP ${res.status}). Human login checkpoint required.`,
                    portal: 'cutshort'
                };
            }

            if (!res.ok) {
                return {
                    jobs: [],
                    status: 'UPSTREAM_ERROR',
                    authenticated: true,
                    httpStatus: res.status,
                    message: `Cutshort upstream returned HTTP ${res.status}`,
                    portal: 'cutshort'
                };
            }

            const rawText = await res.text();
            // Check for Cloudflare challenge or HTML login redirect
            if (rawText.includes('cf-browser-verification') || rawText.includes('challenges.cloudflare.com') || rawText.includes('Unauth page loaded')) {
                return {
                    jobs: [],
                    status: 'BLOCKED_BY_CHALLENGE',
                    authenticated: false,
                    requiresInteractiveLogin: true,
                    message: 'Cutshort returned Cloudflare Turnstile challenge or unauthenticated redirect. Automated bypass is strictly prevented.',
                    portal: 'cutshort'
                };
            }

            let data;
            try {
                data = JSON.parse(rawText);
            } catch {
                return {
                    jobs: [],
                    status: 'INVALID_PAYLOAD',
                    authenticated: true,
                    message: 'Cutshort returned non-JSON response.',
                    portal: 'cutshort'
                };
            }

            const jobs = this.parseResponse(data);

            return {
                jobs,
                status: 'SUCCESS',
                authenticated: true,
                count: jobs.length,
                portal: 'cutshort'
            };
        } catch (err) {
            return {
                jobs: [],
                status: 'NETWORK_ERROR',
                authenticated: true,
                message: err.message || 'Cutshort fetch error',
                portal: 'cutshort'
            };
        }
    }
}

export function fetchCutshortJobs(options = {}) {
    const adapter = new CutshortAdapter(options);
    return adapter.fetchJobs(options);
}
