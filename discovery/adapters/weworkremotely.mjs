/**
 * discovery/adapters/weworkremotely.mjs — We Work Remotely RSS & Feed Discovery Adapter
 *
 * Implements Phase 4C Batch 1:
 *   - Feeds:
 *       Programming: https://weworkremotely.com/categories/remote-programming-jobs.rss
 *       Full-Stack:  https://weworkremotely.com/categories/remote-full-stack-programming-jobs.rss
 *       Back-End:    https://weworkremotely.com/categories/remote-back-end-programming-jobs.rss
 *       Front-End:   https://weworkremotely.com/categories/remote-front-end-programming-jobs.rss
 *   - JSON feed fallback: https://weworkremotely.com/jobs.json
 *   - Preserves original listing links and We Work Remotely attribution
 *   - Emits standardized createNormalizedJob() and AdapterResult
 */

import { createNormalizedJob, detectEmploymentType, fetchWithRetry } from './base.mjs';
import { AdapterResult, validateAdapterResult } from '../interfaces.mjs';
import { unescapeHtmlEntities } from '../crawler/rss.mjs';

export const WWR_DEFAULT_RSS_FEED = 'https://weworkremotely.com/categories/remote-programming-jobs.rss';
export const WWR_CATEGORIES = {
    programming: 'https://weworkremotely.com/categories/remote-programming-jobs.rss',
    fullstack: 'https://weworkremotely.com/categories/remote-full-stack-programming-jobs.rss',
    backend: 'https://weworkremotely.com/categories/remote-back-end-programming-jobs.rss',
    frontend: 'https://weworkremotely.com/categories/remote-front-end-programming-jobs.rss'
};
export const WWR_JSON_FEED = 'https://weworkremotely.com/jobs.json';

/**
 * Parses We Work Remotely RSS XML text into normalized job records.
 *
 * @param {string} xmlText - Raw XML string from WWR RSS feed
 * @param {object} [options]
 * @param {Function} [options.resolveCompanyId]
 * @returns {Array<object>} Normalized jobs
 */
export function parseWwrRss(xmlText, options = {}) {
    if (!xmlText || typeof xmlText !== 'string') {
        return [];
    }

    const result = [];
    const seenUrls = new Set();
    const resolveCompId = options.resolveCompanyId || ((name) => `company-${(name || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`);

    const itemRegex = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
    let match;

    while ((match = itemRegex.exec(xmlText)) !== null) {
        const itemBlock = match[1];

        // Extract title
        const titleMatch = itemBlock.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i);
        const rawTitle = titleMatch ? unescapeHtmlEntities(titleMatch[1].trim()) : '';

        // Extract link / URL
        const linkMatch = itemBlock.match(/<link>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/i) ||
                          itemBlock.match(/<guid[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/guid>/i);
        const jobUrl = linkMatch ? unescapeHtmlEntities(linkMatch[1].trim()) : '';

        if (!rawTitle || !jobUrl) continue;
        if (seenUrls.has(jobUrl)) continue;
        seenUrls.add(jobUrl);

        // WWR RSS format convention: "Company Name: Job Title"
        let companyName = 'Unknown Employer';
        let jobTitle = rawTitle;
        const colonIdx = rawTitle.indexOf(':');
        if (colonIdx > 0 && colonIdx < rawTitle.length - 1) {
            companyName = rawTitle.slice(0, colonIdx).trim();
            jobTitle = rawTitle.slice(colonIdx + 1).trim();
        }

        // Extract pubDate
        const dateMatch = itemBlock.match(/<pubDate>([\s\S]*?)<\/pubDate>/i);
        let sourceUpdatedAt = null;
        if (dateMatch) {
            try {
                const parsed = new Date(dateMatch[1].trim());
                if (!isNaN(parsed.getTime())) {
                    sourceUpdatedAt = parsed.toISOString();
                }
            } catch {}
        }

        // Extract description
        const descMatch = itemBlock.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/i);
        const description = descMatch ? unescapeHtmlEntities(descMatch[1].trim()) : null;

        // Extract category or tags
        const catMatch = itemBlock.match(/<category>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/category>/i);
        const category = catMatch ? catMatch[1].trim() : '';

        // Extract external ID from link (e.g. /remote-jobs/12345-title)
        let sourceJobId = null;
        const idMatch = jobUrl.match(/\/remote-jobs\/(\d+)/i) || itemBlock.match(/<guid[^>]*>.*?(\d+).*?<\/guid>/i);
        if (idMatch) {
            sourceJobId = idMatch[1];
        }

        const empType = detectEmploymentType(jobTitle, category, '');
        const compId = resolveCompId(companyName);

        result.push(createNormalizedJob({
            id: jobUrl || `wwr-${sourceJobId || Buffer.from(jobUrl).toString('base64').slice(0, 16)}`,
            company_id: compId,
            company_name: companyName,
            title: jobTitle,
            location: 'Remote',
            remote_type: 'remote', // We Work Remotely is 100% remote
            applicant_eligibility: null,
            employment_type: empType,
            job_url: jobUrl,
            description,
            source: 'weworkremotely',
            source_job_id: sourceJobId,
            source_updated_at: sourceUpdatedAt,
            raw: {
                title: rawTitle,
                company: companyName,
                url: jobUrl,
                category,
                pubDate: dateMatch ? dateMatch[1].trim() : null,
                _source_platform: 'weworkremotely',
                _attribution: 'Powered by We Work Remotely (https://weworkremotely.com)'
            }
        }));
    }

    return result;
}

/**
 * Parses We Work Remotely JSON feed if queried directly.
 *
 * @param {object|Array} json
 * @param {object} [options]
 * @returns {Array<object>} Normalized jobs
 */
export function parseWwrJson(json, options = {}) {
    const rawList = Array.isArray(json?.jobs) ? json.jobs : (Array.isArray(json) ? json : []);
    const result = [];
    const seenUrls = new Set();
    const resolveCompId = options.resolveCompanyId || ((name) => `company-${(name || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`);

    for (const item of rawList) {
        if (!item) continue;
        const title = (item.title || item.position || '').trim();
        const companyName = (item.company_name || item.company || '').trim() || 'Unknown Employer';
        const url = (item.url || '').trim();

        if (!title || !url) continue;
        if (seenUrls.has(url)) continue;
        seenUrls.add(url);

        const empType = detectEmploymentType(title, item.category || '', '');
        const compId = resolveCompId(companyName);

        result.push(createNormalizedJob({
            id: url || `wwr-${item.id}`,
            company_id: compId,
            company_name: companyName,
            title,
            location: 'Remote',
            remote_type: 'remote',
            applicant_eligibility: null,
            employment_type: empType,
            job_url: url,
            description: item.description || null,
            source: 'weworkremotely',
            source_job_id: item.id ? String(item.id) : null,
            source_updated_at: item.published_at || item.created_at || null,
            raw: {
                ...item,
                _source_platform: 'weworkremotely',
                _attribution: 'Powered by We Work Remotely (https://weworkremotely.com)'
            }
        }));
    }

    return result;
}

/**
 * Fetches and normalizes live jobs from We Work Remotely RSS feed(s).
 *
 * @param {object} [options]
 * @param {string|string[]} [options.feedUrls] - Single RSS URL or array of category RSS URLs
 * @param {Function} [options.fetchFn=fetch]
 * @param {number} [options.timeoutMs=15000]
 * @param {Function} [options.resolveCompanyId]
 * @returns {Promise<AdapterResult>}
 */
export async function fetchWwrJobs(options = {}) {
    const feedUrls = options.feedUrls
        ? (Array.isArray(options.feedUrls) ? options.feedUrls : [options.feedUrls])
        : [WWR_DEFAULT_RSS_FEED];

    const fetchFn = options.fetchFn || fetch;
    const timeoutMs = options.timeoutMs || 15000;

    const allJobs = [];
    let totalFetched = 0;
    const seenUrls = new Set();
    let duplicateInSource = 0;
    let lastError = null;

    for (const url of feedUrls) {
        try {
            const res = await fetchWithRetry(url, {
                headers: {
                    'User-Agent': 'CareerOpsBot/1.0 (+https://github.com/santifer/career-ops; Candidate Job Search)',
                    'Accept': 'application/rss+xml, application/xml, text/xml, application/json, */*'
                }
            }, { timeoutMs, fetchFn });

            const contentType = res.headers?.get ? (res.headers.get('content-type') || '') : '';
            let jobsFromFeed = [];

            if (contentType.includes('json') || url.endsWith('.json')) {
                const json = await res.json();
                jobsFromFeed = parseWwrJson(json, options);
            } else {
                const xmlText = await res.text();
                jobsFromFeed = parseWwrRss(xmlText, options);
            }

            totalFetched += jobsFromFeed.length;
            for (const j of jobsFromFeed) {
                if (seenUrls.has(j.job_url)) {
                    duplicateInSource++;
                } else {
                    seenUrls.add(j.job_url);
                    allJobs.push(j);
                }
            }

        } catch (err) {
            lastError = err;
        }
    }

    if (allJobs.length === 0 && lastError) {
        return new AdapterResult({
            sourceType: 'weworkremotely',
            endpoint: feedUrls[0],
            jobs: [],
            fetchedCount: 0,
            normalizedCount: 0,
            invalidCount: 0,
            duplicateInSourceCount: 0,
            error: `We Work Remotely fetch failed: ${lastError.message}`
        });
    }

    const adapterResult = new AdapterResult({
        sourceType: 'weworkremotely',
        endpoint: feedUrls.join('; '),
        jobs: allJobs,
        fetchedCount: totalFetched,
        normalizedCount: allJobs.length,
        invalidCount: 0,
        duplicateInSourceCount: duplicateInSource,
        error: lastError ? `Partial failure across feeds: ${lastError.message}` : null
    });

    if (!lastError) {
        validateAdapterResult(adapterResult);
    }
    return adapterResult;
}

/**
 * Standard Adapter class implementing JobBoardProvider interface
 */
export class WeworkremotelyAdapter {
    constructor() {
        this.sourceType = 'weworkremotely';
    }

    async fetchJobs(options = {}) {
        return fetchWwrJobs(options);
    }
}
