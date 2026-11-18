/**
 * discovery/crawler/crawl-manager.mjs — Multi-Company Career-Page Crawl Manager & CLI Runner
 */

import { getAllCompanies, getCompany } from '../../db/repo.mjs';
import { crawlCompany } from './crawl-company.mjs';

/**
 * Run career-page crawling across eligible companies in the persistent registry.
 *
 * @param {Object} [options]
 * @param {string} [options.companyId] - Run only for specific company
 * @param {number} [options.limit] - Limit number of companies to crawl
 * @param {boolean} [options.dryRun=false] - If true, do not write to database
 * @param {boolean} [options.pilotOnly=false] - Run only pilot-approved companies
 * @param {number} [options.maxPagesPerCompany=25]
 * @param {boolean} [options.manualOverride=false] - Explicit manual crawl override
 * @param {string} [options.overrideReason] - Reason for manual override
 * @returns {Promise<{
 *   total_companies_selected: number,
 *   summary: Object,
 *   results: Object[]
 * }>}
 */
export async function runCrawlManager(options = {}) {
    const dryRun = Boolean(options.dryRun);
    const limit = options.limit || 0;
    const pilotOnly = Boolean(options.pilotOnly);
    const maxPages = options.maxPagesPerCompany ?? 25;
    const manualOverride = Boolean(options.manualOverride);
    const overrideReason = options.overrideReason;

    let targetCompanies = [];

    if (options.companyId) {
        const comp = getCompany(options.companyId);
        if (comp) targetCompanies.push(comp);
    } else {
        const all = getAllCompanies();
        // Select only companies with lifecycle status in APPROVED, active monitoring, and has career URL
        targetCompanies = all.filter(c => {
            const isApproved = c.lifecycle_status === 'APPROVED';
            const isActive = c.monitoring_status === 'active';
            const hasCareer = Boolean(c.career_url || c.website_url);

            if (manualOverride) {
                // Manual override can select VERIFIED or MONITORING if requested
                return hasCareer && c.monitoring_status !== 'disabled';
            }

            return isApproved && isActive && hasCareer;
        });

        // Rotate companies based on least-recently scanned (null/oldest first)
        targetCompanies.sort((a, b) => {
            const timeA = a.last_scanned_at ? new Date(a.last_scanned_at).getTime() : 0;
            const timeB = b.last_scanned_at ? new Date(b.last_scanned_at).getTime() : 0;
            return timeA - timeB;
        });
    }

    if (limit > 0) {
        targetCompanies = targetCompanies.slice(0, limit);
    }

    const summary = {
        companies_attempted: targetCompanies.length,
        companies_completed: 0,
        companies_partial: 0,
        companies_failed: 0,
        companies_skipped: 0,
        total_pages_fetched: 0,
        total_pages_blocked: 0,
        total_robots_exclusions: 0,
        total_jsonld_jobs: 0,
        total_html_jobs: 0,
        total_normalized_jobs: 0,
        total_inserted: 0,
        total_updated: 0,
        total_unchanged: 0,
        blocked_reasons: {
            robots_disallowed: 0,
            off_host_redirect: 0,
            http_error: 0,
            invalid_target: 0,
            ssrf_rejection: 0,
            fetch_timeout: 0,
            size_exceeded: 0,
            other: 0
        },
        errors: []
    };

    const results = [];

    console.log(`\n==================================================`);
    console.log(`🕷️  Career-Page Crawler Engine (Milestone 2C)`);
    console.log(`==================================================`);
    console.log(`Eligible Companies Selected: ${targetCompanies.length}`);
    if (dryRun) console.log(`Mode: DRY-RUN (Zero DB mutations)`);
    if (manualOverride) console.log(`Mode: MANUAL OVERRIDE (Audited: "${overrideReason || 'none'}")`);
    console.log(`--------------------------------------------------\n`);

    for (const comp of targetCompanies) {
        console.log(`⏳ Crawling ${comp.name} [${comp.id}]...`);
        const result = await crawlCompany(comp.id, {
            dryRun,
            maxPages,
            manualOverride,
            overrideReason
        });

        results.push(result);

        if (result.status === 'completed') summary.companies_completed++;
        else if (result.status === 'partial') summary.companies_partial++;
        else if (result.status === 'failed') {
            summary.companies_failed++;
            summary.errors.push(`${comp.name}: ${result.error}`);
        } else if (result.status === 'skipped') summary.companies_skipped++;

        summary.total_pages_fetched += result.telemetry.pages_fetched;
        summary.total_pages_blocked += result.telemetry.pages_blocked;
        summary.total_robots_exclusions += result.telemetry.robots_exclusions;
        summary.total_jsonld_jobs += result.telemetry.jsonld_extracted;
        summary.total_html_jobs += result.telemetry.html_extracted;
        summary.total_normalized_jobs += result.telemetry.normalized_jobs;
        summary.total_inserted += result.telemetry.inserted_count;
        summary.total_updated += result.telemetry.updated_count;
        summary.total_unchanged += result.telemetry.unchanged_count;

        for (const k of Object.keys(summary.blocked_reasons)) {
            summary.blocked_reasons[k] += result.telemetry.blocked_reasons[k] || 0;
        }

        console.log(
            `   ↳ Status: ${result.status.toUpperCase()} | ` +
            `Pages: ${result.telemetry.pages_fetched} | ` +
            `Jobs: ${result.telemetry.normalized_jobs} (JSON-LD: ${result.telemetry.jsonld_extracted}, HTML: ${result.telemetry.html_extracted}) | ` +
            `Inserted: ${result.telemetry.inserted_count}, Unchanged: ${result.telemetry.unchanged_count}`
        );
        if (result.error) {
            console.log(`   ⚠️ Notice: ${result.error}`);
        }
        if (result.remainingQueue && result.remainingQueue.length > 0) {
            console.log(`   📌 Frontier Pending: ${result.remainingQueue.length} candidate URLs remaining in queue`);
        }
    }

    console.log(`\n==================================================`);
    console.log(`📊 Crawl Manager Summary`);
    console.log(`==================================================`);
    console.log(`Companies Attempted:        ${summary.companies_attempted}`);
    console.log(`Companies Completed:        ${summary.companies_completed}`);
    console.log(`Companies Partial:          ${summary.companies_partial}`);
    console.log(`Companies Failed:           ${summary.companies_failed}`);
    console.log(`Companies Skipped:          ${summary.companies_skipped}`);
    console.log(`Total Pages Fetched:        ${summary.total_pages_fetched}`);
    console.log(`Total Pages Blocked:        ${summary.total_pages_blocked}`);
    console.log(`Robots Exclusions:          ${summary.total_robots_exclusions}`);
    console.log(`Total JSON-LD Jobs:         ${summary.total_jsonld_jobs}`);
    console.log(`Total HTML Fallback Jobs:   ${summary.total_html_jobs}`);
    console.log(`Total Normalized Jobs:      ${summary.total_normalized_jobs}`);
    console.log(`Newly Inserted:             ${summary.total_inserted}`);
    console.log(`Updated Content:            ${summary.total_updated}`);
    console.log(`Unchanged:                  ${summary.total_unchanged}`);
    console.log(`--- Blocked Pages Categorized ---`);
    console.log(`  - Robots Disallowed:      ${summary.blocked_reasons.robots_disallowed}`);
    console.log(`  - Off-Host Redirect:      ${summary.blocked_reasons.off_host_redirect}`);
    console.log(`  - HTTP Errors (4xx/5xx):  ${summary.blocked_reasons.http_error}`);
    console.log(`  - Invalid Target URL:     ${summary.blocked_reasons.invalid_target}`);
    console.log(`  - SSRF Rejection:         ${summary.blocked_reasons.ssrf_rejection}`);
    console.log(`  - Fetch Timeouts:         ${summary.blocked_reasons.fetch_timeout}`);
    console.log(`  - Size Exceeded:          ${summary.blocked_reasons.size_exceeded}`);
    console.log(`  - Other Errors:           ${summary.blocked_reasons.other}`);
    if (summary.errors.length > 0) {
        console.log(`\nErrors Encountered:`);
        for (const err of summary.errors) {
            console.log(`  - ${err}`);
        }
    }
    console.log(`==================================================\n`);

    return {
        total_companies_selected: targetCompanies.length,
        summary,
        results
    };
}

// ── CLI Dispatcher ─────────────────────────────────────────────────────────

async function main() {
    const args = process.argv.slice(2);
    const dryRun = args.includes('--dry-run');
    const pilotOnly = args.includes('--pilot');
    const manualOverride = args.includes('--manual-override');

    const reasonIdx = args.indexOf('--override-reason');
    const overrideReason = reasonIdx !== -1 && args[reasonIdx + 1] ? args[reasonIdx + 1] : undefined;

    const companyIdx = args.indexOf('--company');
    const companyId = companyIdx !== -1 ? args[companyIdx + 1] : undefined;

    const limitIdx = args.indexOf('--limit');
    const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : 0;

    await runCrawlManager({
        dryRun,
        pilotOnly,
        companyId,
        limit,
        manualOverride,
        overrideReason
    });
}

if (process.argv[1]?.endsWith('crawl-manager.mjs')) {
    main().catch(err => {
        console.error('Fatal Crawl Manager Error:', err);
        process.exit(1);
    });
}
