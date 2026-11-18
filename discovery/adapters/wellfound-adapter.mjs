/**
 * discovery/adapters/wellfound-adapter.mjs — Wellfound (AngelList Talent) Portal Adapter
 *
 * Implements Deliverable 6 (Portal 3 in sequence):
 * - Forensic Probe Findings:
 *   - Public GraphQL endpoint (https://wellfound.com/graphql) returns HTTP 403
 *     with '<title>Security Check | Wellfound</title>' (Cloudflare Turnstile WAF).
 *   - Headless scraping without candidate session cookies is actively blocked.
 * - Integration Architecture:
 *   - Strictly adheres to Rule R20: ZERO CAPTCHA/Turnstile bypass.
 *   - Checks SessionVault (`data/sessions/wellfound/session.json`) for valid
 *     candidate session cookie (`_angellist`) and CSRF token.
 *   - If no session exists, returns AUTHENTICATION_REQUIRED with forensic block evidence.
 *   - If security check is encountered, reports BLOCKED_BY_CHALLENGE fail-closed.
 *   - When valid authenticated session is present, queries candidate job feed
 *     and normalizes to career-ops schema.
 */

import { createNormalizedJob, detectRemoteType, detectEmploymentType } from './base.mjs';
import { sessionVault } from '../sessions/session-vault.mjs';

export const WELLFOUND_BASE_URL = 'https://wellfound.com';
export const WELLFOUND_GRAPHQL_ENDPOINT = 'https://wellfound.com/graphql';

export class WellfoundAdapter {
    constructor({ fetchFn = fetch, vault = sessionVault } = {}) {
        this.fetchFn = fetchFn;
        this.vault = vault;
        this.provider = 'wellfound';
    }

    /**
     * Parses Wellfound GraphQL job listing items into normalized jobs.
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

        const items = data.jobs || data.data?.talentJobSearch?.listings || data.data?.jobs || (Array.isArray(data) ? data : []);
        const normalized = [];

        for (const item of items) {
            if (!item || typeof item !== 'object') continue;

            const title = item.title || item.role || item.position;
            if (!title) continue;

            const slug = item.slug || item.id;
            const jobUrl = item.url || (slug ? `${WELLFOUND_BASE_URL}/jobs/${slug}` : null);
            if (!jobUrl) continue;

            const companyName = item.company?.name || item.startup?.name || item.companyName || 'Startup via Wellfound';
            const location = item.location || (item.locations ? item.locations.join(', ') : 'Remote / Global');
            const remoteType = detectRemoteType(title, location, item.remote ? 'remote' : (item.workplaceType || ''));
            const employmentType = detectEmploymentType(title, item.commitment || '', item.employmentType || '');
            const description = item.description || item.pitch || item.snippet || '';
            const sourceJobId = item.id ? `wellfound_${item.id}` : null;

            try {
                const job = createNormalizedJob({
                    company_name: companyName,
                    title,
                    location,
                    remote_type: remoteType,
                    applicant_eligibility: item.eligibility || 'Global / Remote',
                    employment_type: employmentType || 'full-time',
                    job_url: jobUrl,
                    description,
                    source: 'wellfound',
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
     * Fetches jobs from Wellfound candidate feed.
     * Enforces fail-closed safety and authentic session requirements.
     */
    async fetchJobs(options = {}) {
        const hasSession = this.vault.hasValidSession('wellfound');

        if (!hasSession) {
            return {
                jobs: [],
                status: 'AUTHENTICATION_REQUIRED',
                authenticated: false,
                requiresInteractiveLogin: true,
                forensicEvidence: {
                    endpoint: WELLFOUND_GRAPHQL_ENDPOINT,
                    publicAccess: 'BLOCKED_BY_WAF',
                    httpStatus: 403,
                    reason: 'Cloudflare Turnstile Security Check gates Wellfound endpoints without authenticated session.'
                },
                message: 'Wellfound candidate listings require authenticated session. Login via Wellfound or supply session in data/sessions/wellfound/session.json.',
                portal: 'wellfound'
            };
        }

        const session = this.vault.loadSession('wellfound');
        const cookieHeader = this.vault.getCookieHeader('wellfound');
        const customHeaders = (session && session.headers) || {};

        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            ...customHeaders
        };

        if (cookieHeader) {
            headers['Cookie'] = cookieHeader;
        }

        const queryPayload = options.queryPayload || {
            query: `
                query CandidateJobsQuery {
                    talentJobSearch {
                        listings {
                            id
                            title
                            slug
                            startup { name }
                            location
                            remote
                            pitch
                        }
                    }
                }
            `
        };

        try {
            const endpoint = options.endpoint || WELLFOUND_GRAPHQL_ENDPOINT;
            const res = await this.fetchFn(endpoint, {
                method: 'POST',
                headers,
                body: JSON.stringify(queryPayload)
            });

            if (res.status === 401 || res.status === 403) {
                const text = await res.text();
                const isChallenge = text.includes('Security Check') || text.includes('challenges.cloudflare.com');
                return {
                    jobs: [],
                    status: isChallenge ? 'BLOCKED_BY_CHALLENGE' : 'SESSION_EXPIRED',
                    authenticated: false,
                    requiresInteractiveLogin: true,
                    httpStatus: res.status,
                    message: isChallenge
                        ? 'Wellfound returned Cloudflare Turnstile Security Check. Automated bypass strictly forbidden.'
                        : `Wellfound session expired (HTTP ${res.status}). Human login checkpoint required.`,
                    portal: 'wellfound'
                };
            }

            if (!res.ok) {
                return {
                    jobs: [],
                    status: 'UPSTREAM_ERROR',
                    authenticated: true,
                    httpStatus: res.status,
                    message: `Wellfound upstream returned HTTP ${res.status}`,
                    portal: 'wellfound'
                };
            }

            const rawText = await res.text();
            if (rawText.includes('Security Check') || rawText.includes('challenges.cloudflare.com')) {
                return {
                    jobs: [],
                    status: 'BLOCKED_BY_CHALLENGE',
                    authenticated: false,
                    requiresInteractiveLogin: true,
                    message: 'Wellfound returned Cloudflare Turnstile challenge. Automated bypass is strictly prevented.',
                    portal: 'wellfound'
                };
            }

            const data = JSON.parse(rawText);
            const jobs = this.parseResponse(data);

            return {
                jobs,
                status: 'SUCCESS',
                authenticated: true,
                count: jobs.length,
                portal: 'wellfound'
            };
        } catch (err) {
            return {
                jobs: [],
                status: 'NETWORK_ERROR',
                authenticated: true,
                message: err.message || 'Wellfound fetch error',
                portal: 'wellfound'
            };
        }
    }
}

export function fetchWellfoundJobs(options = {}) {
    const adapter = new WellfoundAdapter(options);
    return adapter.fetchJobs(options);
}
