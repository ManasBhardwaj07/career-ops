/**
 * discovery/crawler/crawl-company.mjs — Single-Company Career-Page Crawl Orchestrator
 */

import { checkCompanyCrawlAuthorization } from './safety.mjs';
import {
    safeFetch,
    HttpError,
    SSRFBlockedError,
    RedirectOutsideBoundaryError,
    FetchTimeoutError,
    FetchSizeExceededError
} from './fetch.mjs';
import { getRobotsForUrl } from './robots.mjs';
import { crawlSitemaps, isCandidateJobUrl } from './sitemap.mjs';
import { parseFeedXml } from './rss.mjs';
import { parseJobPostingsFromJsonLd } from './jsonld.mjs';
import { parseJobFromHtml, extractJobLinks } from './html.mjs';
import { normalizeCrawledJob } from './normalize-job.mjs';
import {
    getCompany,
    updateCompany,
    upsertJobPosting,
    createSourceScan,
    updateSourceScan,
    normalizeDomain
} from '../../db/repo.mjs';
import { getDb } from '../../db/db.mjs';

/**
 * Crawl career opportunities for a single registered employer.
 *
 * @param {string} companyId - Canonical company ID
 * @param {Object} [options]
 * @param {boolean} [options.dryRun=false] - If true, simulate crawl without writing to DB
 * @param {number} [options.maxPages=25] - Maximum total pages to fetch per crawl run
 * @param {number} [options.maxSitemaps=5] - Maximum sitemaps to parse
 * @param {boolean} [options.allowHtmlFallback=true]
 * @param {boolean} [options.manualOverride=false] - Explicit manual crawl override
 * @param {string} [options.overrideReason] - Required reason for manual override
 * @param {string[]} [options.resumeQueue] - Array of pending URLs from prior partial run to resume
 * @param {Function} [options.fetcher] - Custom fetcher function (for deterministic testing)
 * @returns {Promise<{
 *   company_id: string,
 *   company_name: string,
 *   status: 'completed'|'partial'|'failed'|'skipped',
 *   error: string|null,
 *   telemetry: {
 *     sources_attempted: number,
 *     sources_approved: number,
 *     robots_exclusions: number,
 *     sitemaps_discovered: number,
 *     sitemaps_visited: number,
 *     sitemaps_failed: number,
 *     pages_discovered: number,
 *     pages_fetched: number,
 *     pages_blocked: number,
 *     pages_parsed: number,
 *     jsonld_extracted: number,
 *     html_extracted: number,
 *     normalized_jobs: number,
 *     inserted_count: number,
 *     updated_count: number,
 *     unchanged_count: number,
 *     invalid_count: number,
 *     new_snapshots: number,
 *     blocked_reasons: {
 *       robots_disallowed: number,
 *       off_host_redirect: number,
 *       http_error: number,
 *       invalid_target: number,
 *       ssrf_rejection: number,
 *       fetch_timeout: number,
 *       size_exceeded: number,
 *       other: number
 *     }
 *   },
 *   jobs: Object[],
 *   remainingQueue: string[]
 * }>}
 */
export async function crawlCompany(companyId, options = {}) {
    const dryRun = Boolean(options.dryRun);
    const maxPages = options.maxPages ?? 25;
    const maxSitemaps = options.maxSitemaps ?? 5;
    const allowHtmlFallback = options.allowHtmlFallback !== false;
    const doFetch = options.fetcher || safeFetch;

    const company = getCompany(companyId);
    if (!company) {
        return {
            company_id: companyId,
            company_name: companyId,
            status: 'failed',
            error: `Company not found in registry: ${companyId}`,
            telemetry: emptyTelemetry(),
            jobs: [],
            remainingQueue: []
        };
    }

    const careerUrl = company.career_url || (company.website_url ? `${company.website_url.replace(/\/+$/, '')}/careers` : null);
    if (!careerUrl) {
        return {
            company_id: companyId,
            company_name: company.name,
            status: 'skipped',
            error: 'No career URL or website configured',
            telemetry: emptyTelemetry(),
            jobs: [],
            remainingQueue: []
        };
    }

    // 1. Strict Source Authorization Check (Requires APPROVED, active, permitted)
    const auth = checkCompanyCrawlAuthorization(companyId, careerUrl, {
        manualOverride: options.manualOverride,
        overrideReason: options.overrideReason
    });

    if (!auth.authorized) {
        return {
            company_id: companyId,
            company_name: company.name,
            status: 'skipped',
            error: `Source policy authorization check failed: ${auth.reason}`,
            telemetry: emptyTelemetry(),
            jobs: [],
            remainingQueue: []
        };
    }

    const telemetry = emptyTelemetry();
    telemetry.sources_attempted = 1;
    telemetry.sources_approved = 1;

    let scanId = null;
    if (!dryRun) {
        scanId = createSourceScan({
            company_id: companyId,
            source_type: 'crawler',
            endpoint: careerUrl
        });
    }

    const allowedHosts = [];
    if (company.domain) allowedHosts.push(normalizeDomain(company.domain));
    try {
        const cHost = normalizeDomain(new URL(careerUrl).hostname);
        if (!allowedHosts.includes(cHost)) allowedHosts.push(cHost);
    } catch {
        // ignore
    }

    let parsedCareerUrl;
    try {
        parsedCareerUrl = new URL(careerUrl);
    } catch {
        return {
            company_id: companyId,
            company_name: company.name,
            status: 'failed',
            error: `Malformed career URL: ${careerUrl}`,
            telemetry,
            jobs: [],
            remainingQueue: []
        };
    }

    const origin = parsedCareerUrl.origin;
    let hitLimit = false;
    let fatalError = null;
    const collectedJobs = [];
    let remainingCandidateQueue = [];

    try {
        // 2. Fetch and evaluate robots.txt
        const robotsResult = await getRobotsForUrl(careerUrl, { allowedHosts, fetcher: doFetch });
        const robots = robotsResult.parser;

        const careerPathCheck = robots.isAllowed(parsedCareerUrl.pathname);
        if (!careerPathCheck.allowed) {
            telemetry.robots_exclusions++;
            telemetry.pages_blocked++;
            telemetry.blocked_reasons.robots_disallowed++;

            const errMsg = `Career page disallowed by robots.txt: ${careerPathCheck.reason}`;
            if (!dryRun) {
                if (scanId) {
                    updateSourceScan(scanId, {
                        is_complete: 0,
                        completed_at: new Date().toISOString(),
                        error_details: `status=failed: ${errMsg}`
                    });
                }
                updateCompany(companyId, {
                    last_scanned_at: new Date().toISOString()
                });
            }
            return {
                company_id: companyId,
                company_name: company.name,
                status: 'failed',
                error: errMsg,
                telemetry,
                jobs: [],
                remainingQueue: []
            };
        }

        // 3. Candidate Queue Initialization & Resume Frontier
        const candidateUrlQueue = [];
        const seenUrls = new Set();

        if (Array.isArray(options.resumeQueue) && options.resumeQueue.length > 0) {
            // Explicit caller-provided resume frontier
            for (const u of options.resumeQueue) {
                if (u && !seenUrls.has(u)) {
                    seenUrls.add(u);
                    candidateUrlQueue.push(u);
                }
            }
        } else if (options.autoResume) {
            // Automatic durable recovery from SQLite source_scans table
            try {
                const db = getDb();
                const lastScan = db.prepare(`
                    SELECT error_details FROM source_scans
                    WHERE company_id = ? AND is_complete = 0 AND error_details IS NOT NULL
                    ORDER BY started_at DESC, rowid DESC LIMIT 1
                `).get(companyId);

                if (lastScan?.error_details) {
                    const parsed = JSON.parse(lastScan.error_details);
                    if (Array.isArray(parsed.remaining_frontier_urls) && parsed.remaining_frontier_urls.length > 0) {
                        for (const u of parsed.remaining_frontier_urls) {
                            if (u && !seenUrls.has(u)) {
                                seenUrls.add(u);
                                candidateUrlQueue.push(u);
                            }
                        }
                    }
                }
            } catch {
                // fall back to fresh discovery
            }
        }

        if (candidateUrlQueue.length === 0) {
            // Fresh crawl discovery via sitemaps and direct careerUrl
            const initialSitemaps = [...robots.sitemaps];
            if (initialSitemaps.length === 0) {
                initialSitemaps.push(`${origin}/sitemap.xml`);
            }
            telemetry.sitemaps_discovered = initialSitemaps.length;

            const sitemapResult = await crawlSitemaps(initialSitemaps, {
                allowedHosts,
                maxDepth: 2,
                maxSitemaps,
                maxUrls: maxPages * 2,
                fetcher: doFetch
            });

            telemetry.sitemaps_visited = sitemapResult.sitemapsVisited.length;
            telemetry.sitemaps_failed = sitemapResult.sitemapsFailed.length;
            if (sitemapResult.hitLimits) hitLimit = true;

            // Always include root careerUrl
            candidateUrlQueue.push(careerUrl);
            seenUrls.add(careerUrl);

            for (const item of sitemapResult.candidateUrls) {
                if (!seenUrls.has(item.url)) {
                    seenUrls.add(item.url);
                    candidateUrlQueue.push(item.url);
                }
            }
        }

        telemetry.pages_discovered = candidateUrlQueue.length;

        // 4. Crawl Candidate URLs within budget
        let pagesCrawled = 0;

        while (candidateUrlQueue.length > 0 && pagesCrawled < maxPages) {
            const currentUrl = candidateUrlQueue.shift();
            let parsed;
            try {
                parsed = new URL(currentUrl);
            } catch {
                telemetry.pages_blocked++;
                telemetry.blocked_reasons.invalid_target++;
                continue;
            }

            // Check robots rule for this specific URL path
            const ruleCheck = robots.isAllowed(parsed.pathname);
            if (!ruleCheck.allowed) {
                telemetry.robots_exclusions++;
                telemetry.pages_blocked++;
                telemetry.blocked_reasons.robots_disallowed++;
                continue;
            }

            try {
                const pageRes = await doFetch(currentUrl, {
                    allowedHosts,
                    timeoutMs: 8000,
                    maxSizeBytes: 2 * 1024 * 1024
                });

                pagesCrawled++;
                telemetry.pages_fetched++;
                telemetry.pages_parsed++;

                // A. Check for RSS/Atom feed content
                if (pageRes.text.includes('<rss') || pageRes.text.includes('<feed')) {
                    const parsedFeed = parseFeedXml(pageRes.text);
                    for (const entry of parsedFeed.entries) {
                        try {
                            const norm = normalizeCrawledJob({
                                company_id: companyId,
                                title: entry.title,
                                description: entry.description,
                                url: entry.url,
                                source_job_id: entry.id,
                                source_updated_at: entry.publishedAt || entry.updatedAt,
                                confidence: 0.85,
                                extraction_method: 'feed',
                                raw_payload: entry
                            });
                            collectedJobs.push(norm);
                            telemetry.normalized_jobs++;
                        } catch {
                            telemetry.invalid_count++;
                        }
                    }
                    continue;
                }

                // Extract candidate job links to expand the crawl frontier
                const discoveredLinks = extractJobLinks(pageRes.text, currentUrl);
                for (const link of discoveredLinks) {
                    if (!seenUrls.has(link.url) && candidateUrlQueue.length + pagesCrawled < maxPages * 4) {
                        seenUrls.add(link.url);
                        candidateUrlQueue.push(link.url);
                        telemetry.pages_discovered++;
                    }
                }

                // B. Try JSON-LD JobPosting Extraction
                const jsonLdJobs = parseJobPostingsFromJsonLd(pageRes.text, currentUrl);
                if (jsonLdJobs.length > 0) {
                    telemetry.jsonld_extracted += jsonLdJobs.length;
                    for (const rawJob of jsonLdJobs) {
                        try {
                            const norm = normalizeCrawledJob({
                                company_id: companyId,
                                title: rawJob.title,
                                description: rawJob.description,
                                url: rawJob.url,
                                source_job_id: rawJob.source_job_id,
                                location: rawJob.location,
                                remote_type: rawJob.remote_type,
                                applicant_eligibility: rawJob.applicant_eligibility,
                                employment_type: rawJob.employment_type,
                                source_updated_at: rawJob.date_posted,
                                confidence: 0.95,
                                extraction_method: 'json_ld',
                                raw_payload: rawJob.raw_node
                            });
                            collectedJobs.push(norm);
                            telemetry.normalized_jobs++;
                        } catch {
                            telemetry.invalid_count++;
                        }
                    }
                } else if (allowHtmlFallback && discoveredLinks.length <= 1) {
                    // C. HTML Fallback (on leaf detail pages, not hub pages that contain multiple job links)
                    const parsedHtml = parseJobFromHtml(pageRes.text, currentUrl);
                    if (parsedHtml.isJobPosting && parsedHtml.title) {
                        telemetry.html_extracted++;
                        try {
                            const norm = normalizeCrawledJob({
                                company_id: companyId,
                                title: parsedHtml.title,
                                description: parsedHtml.description,
                                url: currentUrl,
                                confidence: parsedHtml.confidence,
                                extraction_method: parsedHtml.extraction_method,
                                needs_review: true,
                                raw_payload: { url: currentUrl, title: parsedHtml.title }
                            });
                            collectedJobs.push(norm);
                            telemetry.normalized_jobs++;
                        } catch {
                            telemetry.invalid_count++;
                        }
                    }
                }
            } catch (err) {
                telemetry.pages_blocked++;

                // Categorize blocked reason
                if (err instanceof SSRFBlockedError) {
                    telemetry.blocked_reasons.ssrf_rejection++;
                } else if (err instanceof RedirectOutsideBoundaryError) {
                    telemetry.blocked_reasons.off_host_redirect++;
                } else if (err instanceof FetchTimeoutError) {
                    telemetry.blocked_reasons.fetch_timeout++;
                } else if (err instanceof FetchSizeExceededError) {
                    telemetry.blocked_reasons.size_exceeded++;
                } else if (err instanceof HttpError) {
                    telemetry.blocked_reasons.http_error++;
                } else {
                    telemetry.blocked_reasons.other++;
                }
            }
        }

        // Remaining candidate URLs in queue constitute the unfinished frontier
        remainingCandidateQueue = [...candidateUrlQueue];
        if (remainingCandidateQueue.length > 0) {
            hitLimit = true;
        }

        // 5. Persistence to SQLite
        if (!dryRun) {
            for (const job of collectedJobs) {
                try {
                    const res = upsertJobPosting(job);
                    if (res.isNew) {
                        telemetry.inserted_count++;
                        telemetry.new_snapshots++;
                    } else if (res.contentChanged) {
                        telemetry.updated_count++;
                        telemetry.new_snapshots++;
                    } else {
                        telemetry.unchanged_count++;
                    }
                } catch {
                    telemetry.invalid_count++;
                }
            }
        } else {
            // Dry run telemetry
            telemetry.inserted_count = collectedJobs.length;
        }
    } catch (topErr) {
        fatalError = topErr.message;
    }

    // Determine final status
    let finalStatus = 'completed';
    if (fatalError) {
        finalStatus = 'failed';
    } else if (hitLimit || telemetry.robots_exclusions > 0 || telemetry.sitemaps_failed > 0 || remainingCandidateQueue.length > 0) {
        finalStatus = 'partial';
    }

    if (!dryRun && scanId) {
        const errorDetailsObj = {
            status: finalStatus,
            hit_limit: hitLimit,
            remaining_frontier_count: remainingCandidateQueue.length,
            remaining_frontier_urls: remainingCandidateQueue,
            blocked_reasons: telemetry.blocked_reasons,
            manual_override: options.manualOverride || false,
            override_reason: options.manualOverride ? options.overrideReason : null,
            error: fatalError
        };

        updateSourceScan(scanId, {
            completed_at: new Date().toISOString(),
            total_jobs: collectedJobs.length,
            fetched_count: telemetry.pages_fetched,
            normalized_count: telemetry.normalized_jobs,
            inserted_count: telemetry.inserted_count,
            updated_count: telemetry.updated_count,
            unchanged_count: telemetry.unchanged_count,
            invalid_count: telemetry.invalid_count,
            eligible_count: collectedJobs.length,
            is_complete: finalStatus === 'completed' ? 1 : 0,
            error_details: JSON.stringify(errorDetailsObj)
        });

        updateCompany(companyId, {
            last_scanned_at: new Date().toISOString()
        });
    }

    return {
        company_id: companyId,
        company_name: company.name,
        status: finalStatus,
        error: fatalError,
        telemetry,
        jobs: collectedJobs,
        remainingQueue: remainingCandidateQueue
    };
}

function emptyTelemetry() {
    return {
        sources_attempted: 0,
        sources_approved: 0,
        robots_exclusions: 0,
        sitemaps_discovered: 0,
        sitemaps_visited: 0,
        sitemaps_failed: 0,
        pages_discovered: 0,
        pages_fetched: 0,
        pages_blocked: 0,
        pages_parsed: 0,
        jsonld_extracted: 0,
        html_extracted: 0,
        normalized_jobs: 0,
        inserted_count: 0,
        updated_count: 0,
        unchanged_count: 0,
        invalid_count: 0,
        new_snapshots: 0,
        blocked_reasons: {
            robots_disallowed: 0,
            off_host_redirect: 0,
            http_error: 0,
            invalid_target: 0,
            ssrf_rejection: 0,
            fetch_timeout: 0,
            size_exceeded: 0,
            other: 0
        }
    };
}
