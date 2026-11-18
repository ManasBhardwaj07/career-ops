/**
 * discovery/adapters/amazon-jobs.mjs — Amazon & AWS Public Jobs API Adapter
 *
 * Implements direct discovery for Amazon, AWS, and subsidiaries using the official
 * Amazon Jobs public REST API (https://www.amazon.jobs/en/search.json).
 *
 * Features:
 * - Public REST JSON endpoint (no authentication required)
 * - Structured pagination (offset / result_limit)
 * - Country & keyword filtering (e.g. India, Software Development Engineer)
 * - Direct apply URL preservation (https://www.amazon.jobs/en/jobs/${id})
 * - Normalizes to standard career-ops job contract
 */

import { createNormalizedJob, detectRemoteType, detectEmploymentType, fetchWithRetry } from './base.mjs';

export const AMAZON_JOBS_BASE_URL = 'https://www.amazon.jobs';
export const AMAZON_JOBS_SEARCH_ENDPOINT = 'https://www.amazon.jobs/en/search.json';

export class AmazonJobsAdapter {
    constructor({ fetchFn = fetch } = {}) {
        this.fetchFn = fetchFn;
        this.provider = 'amazon_jobs';
    }

    /**
     * Parses Amazon Jobs JSON payload into normalized career-ops jobs.
     */
    parseResponse(rawData, { companyName = 'Amazon' } = {}) {
        if (!rawData) return [];

        let data = rawData;
        if (typeof rawData === 'string') {
            try {
                data = JSON.parse(rawData);
            } catch {
                return [];
            }
        }

        const items = data.jobs || [];
        const normalized = [];

        for (const item of items) {
            if (!item || typeof item !== 'object') continue;

            const title = item.title;
            if (!title) continue;

            const jobId = item.id_icims || item.job_path || item.id;
            const jobPath = item.job_path || (jobId ? `/en/jobs/${jobId}` : null);
            if (!jobPath) continue;

            const jobUrl = jobPath.startsWith('http') ? jobPath : `${AMAZON_JOBS_BASE_URL}${jobPath}`;
            const location = item.location || [item.city, item.state, item.country_code].filter(Boolean).join(', ') || 'India';
            const remoteType = detectRemoteType(title, location, item.workplace_type || '');
            const employmentType = detectEmploymentType(title, item.schedule_type_id || '', '');

            const description = item.description || item.basic_qualifications || item.description_short || '';
            const businessCategory = item.business_category || 'Software Development';
            const effectiveCompany = businessCategory.toLowerCase().includes('aws') || businessCategory.toLowerCase().includes('web services')
                ? 'Amazon Web Services'
                : companyName;

            try {
                const job = createNormalizedJob({
                    company_name: effectiveCompany,
                    title,
                    location,
                    remote_type: remoteType,
                    applicant_eligibility: item.country_code === 'IND' ? 'Open to India' : null,
                    employment_type: employmentType || 'full-time',
                    job_url: jobUrl,
                    description: `${description}\n\nBasic Qualifications:\n${item.basic_qualifications || 'N/A'}\n\nPreferred Qualifications:\n${item.preferred_qualifications || 'N/A'}`,
                    source: 'amazon_jobs',
                    source_job_id: `amazon_${jobId}`,
                    source_updated_at: item.posted_date || item.updated_at || null,
                    raw: item
                });
                normalized.push(job);
            } catch {
                // Ignore individual normalization error
            }
        }

        return normalized;
    }

    /**
     * Fetches postings from Amazon Jobs API.
     */
    async fetchJobs({
        query = 'Software Engineer',
        country = 'IND',
        offset = 0,
        resultLimit = 25,
        category = 'software-development'
    } = {}) {
        const params = new URLSearchParams({
            base_query: query,
            country: country,
            offset: String(offset),
            result_limit: String(resultLimit),
            sort: 'recent'
        });

        if (category) {
            params.set('category[]', category);
        }

        const endpoint = `${AMAZON_JOBS_SEARCH_ENDPOINT}?${params.toString()}`;

        try {
            const res = await fetchWithRetry(endpoint, {
                method: 'GET',
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                    'Accept': 'application/json, text/plain, */*'
                }
            }, { fetchFn: this.fetchFn, retries: 2, timeoutMs: 10000 });

            const data = await res.json();
            const jobs = this.parseResponse(data);

            return {
                jobs,
                totalHits: data.hits || jobs.length,
                status: 'SUCCESS',
                offset,
                resultLimit,
                provider: 'amazon_jobs'
            };
        } catch (err) {
            return {
                jobs: [],
                totalHits: 0,
                status: 'ERROR',
                message: err.message || 'Failed to fetch Amazon jobs',
                provider: 'amazon_jobs'
            };
        }
    }
}

export function fetchAmazonJobs(options = {}) {
    const adapter = new AmazonJobsAdapter(options);
    return adapter.fetchJobs(options);
}
