/**
 * discovery/adapters/pinpoint.mjs — Pinpoint ATS Public REST API Adapter
 *
 * Pinpoint provides an unauthenticated JSON endpoint for company postings:
 *   https://${subdomain}.pinpointhq.com/postings.json
 *
 * Normalizes postings into standard career-ops job contracts.
 */

import { createNormalizedJob, detectRemoteType, detectEmploymentType, fetchWithRetry } from './base.mjs';

export class PinpointAdapter {
    constructor({ fetchFn = fetch } = {}) {
        this.fetchFn = fetchFn;
        this.provider = 'pinpoint';
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
            items = items.data || items.postings || [];
        }

        const normalized = [];

        for (const item of items) {
            if (!item || typeof item !== 'object') continue;

            const title = item.title || item.name;
            if (!title) continue;

            const jobUrl = item.url || (item.id && subdomain ? `https://${subdomain}.pinpointhq.com/postings/${item.id}` : null);
            if (!jobUrl) continue;

            const locName = item.location?.city || item.location?.name || item.location_name || 'Remote';
            const effectiveCompany = item.company?.name || companyName || subdomain || 'Employer via Pinpoint';
            const remoteType = detectRemoteType(title, locName, item.workplace_type || (item.remote ? 'remote' : ''));
            const employmentType = detectEmploymentType(title, item.employment_type || '', '');

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
                    source: 'pinpoint',
                    source_job_id: item.id ? `pinpoint_${item.id}` : null,
                    source_updated_at: item.updated_at || item.created_at || null,
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
                message: 'Subdomain is required for Pinpoint adapter'
            };
        }

        const cleanSubdomain = String(subdomain).replace(/\.pinpointhq\.com.*$/, '').replace(/^https?:\/\//, '');
        const endpoint = `https://${cleanSubdomain}.pinpointhq.com/postings.json`;

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
                message: err.message || `Failed to fetch Pinpoint jobs for ${cleanSubdomain}`
            };
        }
    }
}

export function fetchPinpointJobs(options = {}) {
    const adapter = new PinpointAdapter(options);
    return adapter.fetchJobs(options);
}
