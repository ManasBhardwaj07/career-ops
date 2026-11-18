/**
 * discovery/career-crawler.mjs — Unified Career Page Discovery & ATS Router
 *
 * Implements Phase 5:
 * - Discovers official career links from verified employer registry
 * - Detects ATS provider markers (Greenhouse, Lever, Ashby, Workday, etc.)
 * - Dispatches to high-fidelity native ATS adapters when detected
 * - Falls back to robots.txt, sitemap.xml, JSON-LD, and HTML parsing
 * - Implements a generic fallback preserving candidate job URLs even if full extraction fails
 * - Records extraction confidence, structure changes, and parsing evidence
 */

import { detectAtsFromUrl, ATS_CATALOG } from './ats-catalog.mjs';
import { crawlCompany } from './crawler/crawl-company.mjs';
import { getCompany } from '../db/repo.mjs';
import { createNormalizedJob } from './adapters/base.mjs';
import { fetchGreenhouseJobs } from './adapters/greenhouse.mjs';
import { fetchLeverJobs } from './adapters/lever.mjs';
import { fetchAshbyJobs } from './adapters/ashby.mjs';
import { fetchWorkdayJobs } from './adapters/workday.mjs';
import { fetchSmartRecruitersJobs } from './adapters/smartrecruiters.mjs';
import { fetchWorkableJobs } from './adapters/workable.mjs';
import { fetchRecruiteeJobs } from './adapters/recruitee.mjs';
import { fetchAmazonJobs } from './adapters/amazon-jobs.mjs';
import { fetchBreezyJobs } from './adapters/breezy.mjs';
import { fetchPinpointJobs } from './adapters/pinpoint.mjs';

export class CareerCrawler {
    constructor(options = {}) {
        this.options = options;
    }

    /**
     * Inspects a company and determines the optimal discovery strategy:
     * - 'NATIVE_ATS': Direct API fetch
     * - 'CRAWLER': Deep sitemap/JSON-LD/HTML crawl
     * - 'GENERIC_FALLBACK': Surface job link preservation
     */
    classifyStrategy(company) {
        if (!company) return { strategy: 'UNKNOWN', ats: null };

        const careerUrl = company.career_url || company.careers_url || '';
        const detectedAts = detectAtsFromUrl(careerUrl) || (company.ats_type ? { ats_type: company.ats_type } : null);

        if (detectedAts) {
            const atsKey = detectedAts.ats_type;
            const entry = ATS_CATALOG[atsKey];
            if (entry && entry.implementation_status === 'NATIVE_API_ADAPTER') {
                return {
                    strategy: 'NATIVE_ATS',
                    ats: atsKey,
                    entry
                };
            }
        }

        return {
            strategy: 'CRAWLER',
            ats: detectedAts ? detectedAts.ats_type : 'unknown',
            entry: detectedAts ? ATS_CATALOG[detectedAts.ats_type] : null
        };
    }

    /**
     * Executes discovery for a single employer.
     */
    async discoverCompanyJobs(companyId, options = {}) {
        const company = getCompany(companyId);
        if (!company) {
            return {
                company_id: companyId,
                status: 'FAILED',
                error: `Company ${companyId} not found in database`,
                jobs: []
            };
        }

        const strategyInfo = this.classifyStrategy(company);
        const careerUrl = company.career_url || '';

        // 1. If native ATS adapter is available, run direct API ingestion
        if (strategyInfo.strategy === 'NATIVE_ATS') {
            const result = await this._runNativeAts(strategyInfo.ats, company, options);
            if (result.status === 'SUCCESS' && result.jobs.length > 0) {
                return {
                    company_id: companyId,
                    company_name: company.name,
                    strategy: 'NATIVE_ATS',
                    ats: strategyInfo.ats,
                    status: 'COMPLETED',
                    jobs: result.jobs,
                    count: result.jobs.length
                };
            }
            // If native fetch returned 0 or errored, fall through to crawler fallback
        }

        // 2. Deep Crawler (Sitemap, JSON-LD, HTML links)
        try {
            const crawlResult = await crawlCompany(companyId, options);
            return {
                company_id: companyId,
                company_name: company.name,
                strategy: 'CRAWLER',
                ats: strategyInfo.ats,
                status: crawlResult.status === 'completed' ? 'COMPLETED' : crawlResult.status.toUpperCase(),
                error: crawlResult.error || null,
                jobs: crawlResult.jobs || [],
                count: (crawlResult.jobs || []).length,
                telemetry: crawlResult.telemetry
            };
        } catch (err) {
            // 3. Generic fallback: preserve the known career URL itself so the opportunity is not lost
            const fallbackJob = this._buildFallbackOpportunity(company, careerUrl, err.message);
            return {
                company_id: companyId,
                company_name: company.name,
                strategy: 'GENERIC_FALLBACK',
                ats: strategyInfo.ats,
                status: 'PARTIAL_FALLBACK',
                error: err.message,
                jobs: fallbackJob ? [fallbackJob] : [],
                count: fallbackJob ? 1 : 0
            };
        }
    }

    async _runNativeAts(atsType, company, options = {}) {
        const url = company.career_url || '';
        const board = company.board_identifier;

        try {
            switch (atsType) {
                case 'greenhouse': {
                    const b = board || (url.match(/boards\.greenhouse\.io\/([^/?#]+)/i) || [])[1];
                    if (!b) return { status: 'NO_BOARD', jobs: [] };
                    const jobs = await fetchGreenhouseJobs(b);
                    return { status: 'SUCCESS', jobs };
                }
                case 'lever': {
                    const c = board || (url.match(/jobs\.lever\.co\/([^/?#]+)/i) || [])[1];
                    if (!c) return { status: 'NO_BOARD', jobs: [] };
                    const jobs = await fetchLeverJobs(c);
                    return { status: 'SUCCESS', jobs };
                }
                case 'ashby': {
                    const b = board || (url.match(/jobs\.ashbyhq\.com\/([^/?#]+)/i) || [])[1];
                    if (!b) return { status: 'NO_BOARD', jobs: [] };
                    const jobs = await fetchAshbyJobs(b);
                    return { status: 'SUCCESS', jobs };
                }
                case 'workday': {
                    const jobs = await fetchWorkdayJobs(url);
                    return { status: 'SUCCESS', jobs };
                }
                case 'smartrecruiters': {
                    const compId = board || (url.match(/jobs\.smartrecruiters\.com\/([^/?#]+)/i) || [])[1];
                    if (!compId) return { status: 'NO_BOARD', jobs: [] };
                    const jobs = await fetchSmartRecruitersJobs(compId);
                    return { status: 'SUCCESS', jobs };
                }
                case 'workable': {
                    const acc = board || (url.match(/apply\.workable\.com\/([^/?#]+)/i) || [])[1];
                    if (!acc) return { status: 'NO_BOARD', jobs: [] };
                    const jobs = await fetchWorkableJobs(acc);
                    return { status: 'SUCCESS', jobs };
                }
                case 'recruitee': {
                    const slug = board || (url.match(/([a-z0-9_-]+)\.recruitee\.com/i) || [])[1];
                    if (!slug) return { status: 'NO_BOARD', jobs: [] };
                    const jobs = await fetchRecruiteeJobs(slug);
                    return { status: 'SUCCESS', jobs };
                }
                case 'amazon_jobs': {
                    const result = await fetchAmazonJobs(options);
                    return { status: result.status, jobs: result.jobs };
                }
                case 'breezy': {
                    const sub = board || (url.match(/([a-z0-9_-]+)\.breezy\.hr/i) || [])[1];
                    if (!sub) return { status: 'NO_BOARD', jobs: [] };
                    const result = await fetchBreezyJobs({ subdomain: sub, companyName: company.name });
                    return { status: result.status, jobs: result.jobs };
                }
                case 'pinpoint': {
                    const sub = board || (url.match(/([a-z0-9_-]+)\.pinpointhq\.com/i) || [])[1];
                    if (!sub) return { status: 'NO_BOARD', jobs: [] };
                    const result = await fetchPinpointJobs({ subdomain: sub, companyName: company.name });
                    return { status: result.status, jobs: result.jobs };
                }
                default:
                    return { status: 'UNSUPPORTED_NATIVE', jobs: [] };
            }
        } catch (err) {
            return { status: 'ERROR', error: err.message, jobs: [] };
        }
    }

    _buildFallbackOpportunity(company, careerUrl, errorDetails) {
        if (!careerUrl) return null;
        try {
            return createNormalizedJob({
                company_name: company.name,
                title: `${company.name} Open Opportunities`,
                location: company.country || 'Global',
                remote_type: 'unknown',
                applicant_eligibility: null,
                employment_type: 'full-time',
                job_url: careerUrl,
                description: `Discovered from verified corporate career portal for ${company.name} (${careerUrl}). Extraction fallback active: ${errorDetails}`,
                source: 'career_page_fallback',
                source_job_id: `fallback_${company.id}`,
                raw: { fallback: true, error: errorDetails, companyId: company.id }
            });
        } catch {
            return null;
        }
    }
}

export const careerCrawler = new CareerCrawler();
