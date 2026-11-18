/**
 * discovery/adapters/adzuna.mjs — Adzuna Developer API Discovery Adapter (Optional)
 *
 * Implements Phase 4C Batch 1 Part C:
 *   - Official API requires app_id and app_key
 *   - Verifies environment credentials (ADZUNA_APP_ID / ADZUNA_APP_KEY)
 *   - Never prints or exposes secret credentials in logs
 *   - Reports ProviderAuthError / BLOCKED_CREDENTIALS when missing
 */

import { createNormalizedJob, detectEmploymentType, fetchWithRetry } from './base.mjs';
import { AdapterResult, ProviderAuthError, validateAdapterResult } from '../interfaces.mjs';

export const ADZUNA_BASE_ENDPOINT = 'https://api.adzuna.com/v1/api/jobs/in/search';

/**
 * Checks if Adzuna credentials are present in the environment
 *
 * @returns {boolean}
 */
export function hasAdzunaCredentials() {
    return Boolean(process.env.ADZUNA_APP_ID && process.env.ADZUNA_APP_KEY);
}

/**
 * Fetches Adzuna jobs for India if credentials are provided
 *
 * @param {object} [options]
 * @returns {Promise<AdapterResult>}
 */
export async function fetchAdzunaJobs(options = {}) {
    const appId = options.appId || process.env.ADZUNA_APP_ID;
    const appKey = options.appKey || process.env.ADZUNA_APP_KEY;

    if (!appId || !appKey) {
        return new AdapterResult({
            sourceType: 'adzuna',
            endpoint: ADZUNA_BASE_ENDPOINT,
            jobs: [],
            error: 'BLOCKED_CREDENTIALS: Missing ADZUNA_APP_ID or ADZUNA_APP_KEY in environment'
        });
    }

    const page = options.page || 1;
    const what = options.what || 'Software Engineer';
    const where = options.where || 'India';
    const fetchFn = options.fetchFn || fetch;
    const timeoutMs = options.timeoutMs || 15000;

    const url = new URL(`${ADZUNA_BASE_ENDPOINT}/${page}`);
    url.searchParams.set('app_id', appId);
    url.searchParams.set('app_key', appKey);
    url.searchParams.set('what', what);
    url.searchParams.set('where', where);
    url.searchParams.set('content-type', 'application/json');

    try {
        const res = await fetchWithRetry(url.toString(), {}, { timeoutMs, fetchFn });
        const json = await res.json();
        const rawList = Array.isArray(json?.results) ? json.results : [];

        const jobs = [];
        const seenUrls = new Set();
        const resolveCompId = options.resolveCompanyId || ((name) => `company-${(name || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`);

        for (const item of rawList) {
            const title = (item.title || '').trim();
            const companyName = (item.company?.display_name || '').trim() || 'Unknown Employer';
            const jobUrl = (item.redirect_url || '').trim();

            if (!title || !jobUrl || seenUrls.has(jobUrl)) continue;
            seenUrls.add(jobUrl);

            const location = (item.location?.display_name || 'India').trim();
            const empType = detectEmploymentType(title, item.contract_time || item.contract_type || '', '');
            const compId = resolveCompId(companyName);

            jobs.push(createNormalizedJob({
                id: `adzuna-${item.id}`,
                company_id: compId,
                company_name: companyName,
                title,
                location,
                remote_type: null,
                applicant_eligibility: 'India',
                employment_type: empType,
                job_url: jobUrl,
                description: item.description || null,
                source: 'adzuna',
                source_job_id: String(item.id),
                source_updated_at: item.created ? new Date(item.created).toISOString() : null,
                raw: {
                    id: item.id,
                    title: item.title,
                    company: companyName,
                    redirect_url: jobUrl,
                    salary_min: item.salary_min,
                    salary_max: item.salary_max,
                    _source_platform: 'adzuna',
                    _attribution: 'Powered by Adzuna (https://www.adzuna.in)'
                }
            }));
        }

        const adapterResult = new AdapterResult({
            sourceType: 'adzuna',
            endpoint: ADZUNA_BASE_ENDPOINT,
            jobs,
            fetchedCount: rawList.length,
            normalizedCount: jobs.length,
            invalidCount: 0,
            duplicateInSourceCount: 0,
            error: null
        });

        validateAdapterResult(adapterResult);
        return adapterResult;

    } catch (err) {
        return new AdapterResult({
            sourceType: 'adzuna',
            endpoint: ADZUNA_BASE_ENDPOINT,
            jobs: [],
            error: `Adzuna fetch failed: ${err.message}`
        });
    }
}

/**
 * Standard Adapter class implementing the ATSBoardAdapter / JobBoardProvider interface
 */
export class AdzunaAdapter {
    constructor() {
        this.sourceType = 'adzuna';
    }

    async fetchJobs(options = {}) {
        return fetchAdzunaJobs(options);
    }
}
