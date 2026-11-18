/**
 * discovery/adapters/breezy.mjs — Breezy HR Public JSON Feed Adapter
 *
 * Breezy HR provides a public, unauthenticated JSON endpoint for company job boards:
 *   https://${subdomain}.breezy.hr/json
 *
 * Normalizes postings into standard career-ops job contracts.
 */

import { createNormalizedJob, detectRemoteType, detectEmploymentType, fetchWithRetry } from './base.mjs';

export class BreezyAdapter {
    constructor({ fetchFn = fetch } = {}) {
        this.fetchFn = fetchFn;
        this.provider = 'breezy';
    }

    parseResponse(rawData, { companyName = null, subdomain = '' } = {}) {
        if (!rawData) return [];

        let items = rawData;
        if (typeof rawData === 'string') {
            try {
                items = JSON.parse(rawData);
            } catch {
                return [];
            }
        }

        if (!Array.isArray(items)) {
            items = items.positions || items.jobs || items.data || [];
        }

        const normalized = [];

        for (const item of items) {
            if (!item || typeof item !== 'object') continue;

            const title = item.name || item.title;
            if (!title) continue;

            const jobUrl = item.url || (item.friendly_id && subdomain ? `https://${subdomain}.breezy.hr/p/${item.friendly_id}` : null);
            if (!jobUrl) continue;

            const locName = item.location?.name || item.location?.city || (typeof item.location === 'string' ? item.location : 'Remote');
            const effectiveCompany = item.company?.name || companyName || subdomain || 'Tech Employer via Breezy HR';
            const remoteType = detectRemoteType(title, locName, item.type?.id || '');
            const employmentType = detectEmploymentType(title, item.type?.name || '', '');

            try {
                const job = createNormalizedJob({
                    company_name: effectiveCompany,
                    title,
                    location: locName,
                    remote_type: remoteType,
                    applicant_eligibility: null,
                    employment_type: employmentType || 'full-time',
                    job_url: jobUrl,
                    description: item.description || item.summary || '',
                    source: 'breezy',
                    source_job_id: item.id ? `breezy_${item.id}` : null,
                    source_updated_at: item.updated_at || item.published_date || null,
                    raw: item
                });
                normalized.push(job);
            } catch {
                // Ignore individual normalization error
            }
        }

        return normalized;
    }

    async fetchJobs({ subdomain, companyName } = {}) {
        if (!subdomain) {
            return {
                jobs: [],
                status: 'ERROR',
                message: 'Subdomain is required for Breezy HR adapter'
            };
        }

        const cleanSubdomain = String(subdomain).replace(/\.breezy\.hr.*$/, '').replace(/^https?:\/\//, '');
        const endpoint = `https://${cleanSubdomain}.breezy.hr/json`;

        try {
            const res = await fetchWithRetry(endpoint, {
                method: 'GET',
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                    'Accept': 'application/json, text/plain, */*'
                }
            }, { fetchFn: this.fetchFn, retries: 2, timeoutMs: 10000 });

            const data = await res.json();
            const jobs = this.parseResponse(data, { companyName, subdomain: cleanSubdomain });

            return {
                jobs,
                status: 'SUCCESS',
                count: jobs.length,
                subdomain: cleanSubdomain
            };
        } catch (err) {
            return {
                jobs: [],
                status: 'ERROR',
                message: err.message || `Failed to fetch Breezy jobs for ${cleanSubdomain}`
            };
        }
    }
}

export function fetchBreezyJobs(options = {}) {
    const adapter = new BreezyAdapter(options);
    return adapter.fetchJobs(options);
}
