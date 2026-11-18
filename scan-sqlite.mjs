#!/usr/bin/env node

/**
 * scan-sqlite.mjs — Unified SQLite-backed Job Discovery Scanner (Milestone 2A + Phase 4C)
 *
 * Connects ATS Board Adapters (Greenhouse, Lever, Ashby, Workday, SmartRecruiters)
 * and Public Job Feed Providers (Remote OK, Himalayas, Remotive, Jobicy, We Work Remotely, Adzuna)
 * to the canonical SQLite repository.
 *
 * Guarantees:
 *   - Source-centric discovery: persists ALL valid normalized postings from permitted sources
 *   - Downstream candidate evaluation: evaluates title/eligibility into job_evaluations
 *   - Source policy & provider rate-limit enforcement
 *   - Dry-run guarantee (zero DB writes when --dry-run is set)
 *   - Content hashing & non-redundant snapshots (only new or changed content gets snapshots)
 *   - Explicit telemetry: fetched, normalized, inserted, updated, unchanged, invalid, eligible
 *   - Source failure isolation (single failure does not halt other scans)
 *
 * Usage:
 *   node scan-sqlite.mjs                  # scan all enabled companies & public feeds
 *   node scan-sqlite.mjs --dry-run        # preview without writing to SQLite
 *   node scan-sqlite.mjs --company Brevo  # scan a single company
 *   node scan-sqlite.mjs --source lever   # scan only sources matching a provider/ATS
 *   node scan-sqlite.mjs --feeds-only     # scan only configured public feeds
 */

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import yaml from 'js-yaml';
import {
    getDb,
    closeDb,
    upsertCompany,
    getCompany,
    findCompanyByNameOrAlias,
    upsertJobPosting,
    createSourceScan,
    updateSourceScan,
    isSourcePermitted,
    getJob,
    upsertJobEvaluation,
    getJobEvaluation,
    findCrossSourceDuplicates
} from './db/repo.mjs';
import { fetchGreenhouseJobs, extractBoard as extractGhBoard } from './discovery/adapters/greenhouse.mjs';
import { fetchLeverJobs, extractCompany as extractLeverCompany } from './discovery/adapters/lever.mjs';
import { fetchAshbyJobs, extractBoard as extractAshbyBoard } from './discovery/adapters/ashby.mjs';
import { fetchWorkdayJobs, extractWorkdayConfig } from './discovery/adapters/workday.mjs';
import { fetchSmartRecruitersJobs, extractCompanyIdentifier as extractSrIdentifier } from './discovery/adapters/smartrecruiters.mjs';
import { fetchWorkableJobs, extractAccount as extractWorkableAccount } from './discovery/adapters/workable.mjs';
import { fetchRecruiteeJobs, extractCompany as extractRecruiteeCompany } from './discovery/adapters/recruitee.mjs';
import {
    PUBLIC_FEED_PROVIDERS,
    PUBLIC_FEED_REGISTRY,
    STARTUP_ECOSYSTEM_PROVIDERS,
    STARTUP_ECOSYSTEM_REGISTRY
} from './discovery/adapters/index.mjs';

const parseYaml = yaml.load;
const DEFAULT_PORTALS_PATH = resolve(process.cwd(), 'portals.yml');

function slugify(name) {
    return (name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function buildTitleFilter(tf = {}) {
    const pos = (tf.positive || []).map(k => k.toLowerCase());
    const neg = (tf.negative || []).map(k => k.toLowerCase());

    return (title = '') => {
        const lower = title.toLowerCase();
        const hasPos = pos.length === 0 || pos.some(k => lower.includes(k));
        const hasNeg = neg.some(k => lower.includes(k));
        return hasPos && !hasNeg;
    };
}

export function detectCompanyAts(company) {
    const url = company.careers_url || '';
    const api = company.api || '';

    if (api.includes('greenhouse') || url.includes('greenhouse.io') || company.scan_method === 'greenhouse_api') {
        const board = extractGhBoard(url) || extractGhBoard(api) || (company.api ? company.api.split('/').filter(Boolean).slice(-2, -1)[0] : null);
        return {
            type: 'greenhouse',
            target: api || url || board,
            board
        };
    }

    if (url.includes('lever.co') || company.scan_method === 'lever') {
        const comp = extractLeverCompany(url);
        return {
            type: 'lever',
            target: url,
            board: comp
        };
    }

    if (url.includes('ashbyhq.com') || company.scan_method === 'ashby') {
        const board = extractAshbyBoard(url);
        return {
            type: 'ashby',
            target: url,
            board
        };
    }

    if (url.includes('myworkdayjobs.com') || company.scan_method === 'workday') {
        const config = extractWorkdayConfig(url);
        return {
            type: 'workday',
            target: url,
            board: config ? `${config.tenant}:${config.site}` : null
        };
    }

    if (url.includes('smartrecruiters.com') || company.scan_method === 'smartrecruiters') {
        const compId = extractSrIdentifier(url);
        return {
            type: 'smartrecruiters',
            target: url,
            board: compId
        };
    }

    if (url.includes('workable.com') || company.scan_method === 'workable') {
        const account = extractWorkableAccount(url || company.board_identifier);
        return {
            type: 'workable',
            target: url || account,
            board: account
        };
    }

    if (url.includes('recruitee.com') || company.scan_method === 'recruitee') {
        const slug = extractRecruiteeCompany(url || company.board_identifier);
        return {
            type: 'recruitee',
            target: url || slug,
            board: slug
        };
    }

    if (url.includes('amazon.jobs') || company.scan_method === 'amazon_jobs') {
        return {
            type: 'amazon_jobs',
            target: url,
            board: 'amazon'
        };
    }

    if (url.includes('breezy.hr') || company.scan_method === 'breezy') {
        const sub = (url.match(/([a-z0-9_-]+)\.breezy\.hr/i) || [])[1] || company.board_identifier;
        return {
            type: 'breezy',
            target: url,
            board: sub
        };
    }

    if (url.includes('pinpointhq.com') || company.scan_method === 'pinpoint') {
        const sub = (url.match(/([a-z0-9_-]+)\.pinpointhq\.com/i) || [])[1] || company.board_identifier;
        return {
            type: 'pinpoint',
            target: url,
            board: sub
        };
    }

    return null;
}

/**
 * Checks provider rate-limit compliance against SQLite `source_scans` history.
 */
export function checkFeedRateLimit(feedCid, provider, reg, { forceRateLimit = false } = {}) {
    if (forceRateLimit || !reg) {
        return { allowed: true };
    }

    const db = getDb();

    if (reg.maxRequestsPerDay) {
        const dailyCount = db.prepare(`
            SELECT COUNT(*) as cnt
            FROM source_scans
            WHERE company_id = ?
              AND source_type = ?
              AND is_complete = 1
              AND started_at >= datetime('now', '-24 hours')
        `).get(feedCid, provider)?.cnt || 0;

        if (dailyCount >= reg.maxRequestsPerDay) {
            return {
                allowed: false,
                reason: `daily limit reached (${dailyCount}/${reg.maxRequestsPerDay} in 24h)`
            };
        }
    }

    if (reg.minPollIntervalMs) {
        const lastScan = db.prepare(`
            SELECT completed_at, started_at
            FROM source_scans
            WHERE company_id = ?
              AND source_type = ?
              AND is_complete = 1
            ORDER BY COALESCE(completed_at, started_at) DESC
            LIMIT 1
        `).get(feedCid, provider);

        if (lastScan) {
            const lastTs = new Date(lastScan.completed_at || lastScan.started_at).getTime();
            if (!isNaN(lastTs)) {
                const elapsedMs = Date.now() - lastTs;
                if (elapsedMs < reg.minPollIntervalMs) {
                    const remainingMin = Math.ceil((reg.minPollIntervalMs - elapsedMs) / 60000);
                    return {
                        allowed: false,
                        reason: `min poll interval active (${remainingMin}m remaining)`
                    };
                }
            }
        }
    }

    return { allowed: true };
}

/**
 * Ensures the employer for a multi-employer public feed job exists in `companies`
 * before inserting into `job_postings` (maintaining foreign key integrity).
 */
function resolveFeedEmployerId(employerName, sourceType, { dryRun = false } = {}) {
    const cleanName = (employerName || '').trim() || 'Unknown Employer';
    if (!dryRun) {
        const existing = findCompanyByNameOrAlias(cleanName);
        if (existing) {
            return existing.id;
        }
    }

    const slug = slugify(cleanName) || 'unknown-employer';
    const cid = `company-${slug}`;

    if (!dryRun) {
        upsertCompany({
            id: cid,
            name: cleanName,
            policy_status: 'permitted',
            source_provenance: sourceType
        });
    }
    return cid;
}

/**
 * Shared job persistence + cross-source deduplication + title evaluation helper.
 */
function persistDiscoveredJobs(jobs, { dryRun, titleFilter, resolveEmployer = false }) {
    let inserted = 0;
    let updated = 0;
    let unchanged = 0;
    let eligible = 0;
    let crossDuplicates = 0;

    for (const job of jobs) {
        let targetJob = job;
        if (resolveEmployer) {
            const resolvedCid = resolveFeedEmployerId(job.company_name, job.source, { dryRun });
            if (resolvedCid && resolvedCid !== job.company_id) {
                targetJob = { ...job, company_id: resolvedCid };
            }
        }

        let upsertRes = { status: 'unchanged', isNew: false, contentChanged: false, snapshotCreated: false };
        if (!dryRun) {
            upsertRes = upsertJobPosting(targetJob);
        }

        if (upsertRes.status === 'inserted') inserted++;
        else if (upsertRes.status === 'updated') updated++;
        else unchanged++;

        if (!dryRun) {
            const crossDups = findCrossSourceDuplicates(targetJob);
            if (crossDups.length > 0) {
                crossDuplicates += crossDups.length;
            }
        }

        const isEligible = titleFilter(targetJob.title);
        if (isEligible) {
            eligible++;
        }

        if (!dryRun) {
            upsertJobEvaluation({
                job_id: targetJob.id,
                recommendation: isEligible ? 'CONSIDER' : 'DO_NOT_APPLY',
                match_score: isEligible ? 1.0 : 0.0,
                eval_details_json: {
                    title_matched: isEligible,
                    filter_rule: isEligible ? 'passed_title_filter' : 'failed_title_filter'
                }
            });
        }
    }

    return { inserted, updated, unchanged, eligible, crossDuplicates };
}

export async function runScanner({
    dryRun = false,
    filterCompany = null,
    filterSource = null,
    feedsOnly = false,
    includeFeeds = true,
    forceRateLimit = false,
    fetchFn = fetch,
    timeoutMs = 10000,
    portalsPath = process.env.PORTALS_PATH || DEFAULT_PORTALS_PATH
} = {}) {
    if (!existsSync(portalsPath)) {
        throw new Error(`Configuration file not found at ${portalsPath}`);
    }

    const config = parseYaml(readFileSync(portalsPath, 'utf-8'));
    const titleFilter = buildTitleFilter(config.title_filter || {});
    const companies = config.tracked_companies || [];
    const configuredFeeds = Array.isArray(config.public_feeds) ? config.public_feeds : [];
    const configuredStartupSources = Array.isArray(config.startup_sources) ? config.startup_sources : [];

    const isPublicFeedFilter = filterSource && (
        filterSource.toLowerCase() === 'public_feeds' ||
        Object.values(PUBLIC_FEED_PROVIDERS).includes(filterSource.toLowerCase())
    );

    const isStartupSourceFilter = filterSource && (
        filterSource.toLowerCase() === 'startup_sources' ||
        Object.values(STARTUP_ECOSYSTEM_PROVIDERS).includes(filterSource.toLowerCase())
    );

    const targets = feedsOnly || isPublicFeedFilter || isStartupSourceFilter
        ? []
        : companies
            .filter(c => c.enabled !== false)
            .filter(c => !filterCompany || c.name.toLowerCase().includes(filterCompany.toLowerCase()))
            .map(c => {
                const ats = detectCompanyAts(c);
                if (!ats) return null;
                if (filterSource && ats.type.toLowerCase() !== filterSource.toLowerCase()) return null;
                return { ...c, _ats: ats };
            })
            .filter(Boolean);

    let feedTargets = [];
    if (includeFeeds && !filterCompany && !isStartupSourceFilter) {
        if (configuredFeeds.length > 0) {
            feedTargets = configuredFeeds
                .filter(f => f && f.enabled !== false && f.provider)
                .filter(f => {
                    if (!filterSource || filterSource.toLowerCase() === 'public_feeds') return true;
                    return f.provider.toLowerCase() === filterSource.toLowerCase();
                });
        } else if (isPublicFeedFilter && filterSource.toLowerCase() !== 'public_feeds') {
            // Allow direct `--source <provider>` invocation even if public_feeds wasn't in a custom test config
            feedTargets = [{ provider: filterSource.toLowerCase(), enabled: true, options: {} }];
        }
    }

    let startupTargets = [];
    if (includeFeeds && !feedsOnly && !filterCompany && !isPublicFeedFilter) {
        if (configuredStartupSources.length > 0) {
            startupTargets = configuredStartupSources
                .filter(s => s && s.enabled !== false && s.provider)
                .filter(s => {
                    if (!filterSource || filterSource.toLowerCase() === 'startup_sources') return true;
                    return s.provider.toLowerCase() === filterSource.toLowerCase();
                });
        }
        if (startupTargets.length === 0 && isStartupSourceFilter && filterSource.toLowerCase() !== 'startup_sources') {
            startupTargets = [{ provider: filterSource.toLowerCase(), enabled: true, options: {} }];
        }
    }

    console.log(`\n==================================================`);
    console.log(`🔍 SQLite Job Discovery Scanner (Milestone 2A + Phase 4C)`);
    console.log(`==================================================`);
    console.log(`Target Companies: ${targets.length} | Public Feeds: ${feedTargets.length} | Startup Sources: ${startupTargets.length} ${dryRun ? '[DRY-RUN MODE — NO DB WRITES]' : ''}`);

    const summary = {
        scanned: 0,
        feedsScanned: 0,
        skippedPolicy: 0,
        skippedRateLimit: 0,
        blockedCredentials: [],
        fetchedCount: 0,
        normalizedCount: 0,
        insertedCount: 0,
        updatedCount: 0,
        unchangedCount: 0,
        invalidCount: 0,
        duplicateInSourceCount: 0,
        eligibleCount: 0,
        crossSourceDuplicateSuggestions: 0,
        errors: [],
        byCompany: {},
        byFeed: {}
    };

    // ── A. Tracked Companies (Single-Employer ATS Boards) ─────────────────────

    for (const comp of targets) {
        const cid = `company-${slugify(comp.name)}`;
        const { type, target } = comp._ats;

        if (!dryRun) {
            const existingComp = getCompany(cid);
            if (!existingComp) {
                const isBlocked = comp.policy_status === 'blocked';
                upsertCompany({
                    id: cid,
                    name: comp.name,
                    career_url: comp.careers_url,
                    ats_type: type,
                    board_identifier: comp._ats.board,
                    policy_status: comp.policy_status || 'permitted',
                    lifecycle_status: comp.lifecycle_status || (isBlocked ? 'DISABLED' : 'APPROVED'),
                    monitoring_status: comp.monitoring_status || (isBlocked ? 'disabled' : 'active'),
                    notes: comp.notes
                });
            }
        }

        const permitted = dryRun || isSourcePermitted(cid, type, 'monitoring');
        if (!permitted) {
            console.log(`  ⛔ ${comp.name}: Skipped (lifecycle/monitoring/source policy not permitted for recurring scan)`);
            summary.skippedPolicy++;
            continue;
        }

        summary.scanned++;
        process.stdout.write(`  ⏳ ${comp.name} (${type})... `);

        let scanId = null;
        if (!dryRun) {
            scanId = createSourceScan({
                company_id: cid,
                source_type: type,
                started_at: new Date().toISOString()
            });
        }

        let fetchResult = null;
        if (type === 'greenhouse') {
            fetchResult = await fetchGreenhouseJobs(target, cid, comp.name, { fetchFn, timeoutMs });
        } else if (type === 'lever') {
            fetchResult = await fetchLeverJobs(target, cid, comp.name, { fetchFn, timeoutMs });
        } else if (type === 'ashby') {
            fetchResult = await fetchAshbyJobs(target, cid, comp.name, { fetchFn, timeoutMs });
        } else if (type === 'workday') {
            fetchResult = await fetchWorkdayJobs(target, cid, comp.name, { fetchFn, timeoutMs });
        } else if (type === 'smartrecruiters') {
            fetchResult = await fetchSmartRecruitersJobs(target, cid, comp.name, { fetchFn, timeoutMs });
        } else if (type === 'workable') {
            fetchResult = await fetchWorkableJobs(target, cid, comp.name, { fetchFn, timeoutMs });
        } else if (type === 'recruitee') {
            fetchResult = await fetchRecruiteeJobs(target, cid, comp.name, { fetchFn, timeoutMs });
        }

        if (!fetchResult || fetchResult.error) {
            const errDetail = fetchResult?.error || 'Unknown scan error';
            console.log(`FAILED: ${errDetail}`);
            summary.errors.push({ company: comp.name, error: errDetail });
            if (!dryRun && scanId) {
                updateSourceScan(scanId, {
                    completed_at: new Date().toISOString(),
                    errors: 1,
                    is_complete: 0,
                    error_details: errDetail
                });
            }
            continue;
        }

        const jobs = fetchResult.jobs || [];
        const fetchedCount = fetchResult.fetchedCount || jobs.length;
        const normalizedCount = fetchResult.normalizedCount || jobs.length;
        const invalidCount = fetchResult.invalidCount || 0;
        const duplicateInSourceCount = fetchResult.duplicateInSourceCount || 0;

        summary.fetchedCount += fetchedCount;
        summary.normalizedCount += normalizedCount;
        summary.invalidCount += invalidCount;
        summary.duplicateInSourceCount += duplicateInSourceCount;

        const stats = persistDiscoveredJobs(jobs, { dryRun, titleFilter, resolveEmployer: false });

        summary.insertedCount += stats.inserted;
        summary.updatedCount += stats.updated;
        summary.unchangedCount += stats.unchanged;
        summary.eligibleCount += stats.eligible;
        summary.crossSourceDuplicateSuggestions += stats.crossDuplicates;

        summary.byCompany[comp.name] = {
            source_type: type,
            fetched_count: fetchedCount,
            normalized_count: normalizedCount,
            inserted_count: stats.inserted,
            updated_count: stats.updated,
            unchanged_count: stats.unchanged,
            invalid_count: invalidCount,
            duplicate_in_source_count: duplicateInSourceCount,
            cross_source_duplicate_suggestions: stats.crossDuplicates,
            eligible_count: stats.eligible
        };

        console.log(`${jobs.length} normalized (${stats.inserted} inserted, ${stats.updated} updated, ${stats.unchanged} unchanged, ${stats.eligible} candidate-eligible)`);

        if (!dryRun && scanId) {
            updateSourceScan(scanId, {
                completed_at: new Date().toISOString(),
                total_jobs: jobs.length,
                new_jobs: stats.inserted,
                duplicate_jobs: stats.unchanged + stats.updated,
                fetched_count: fetchedCount,
                normalized_count: normalizedCount,
                inserted_count: stats.inserted,
                updated_count: stats.updated,
                unchanged_count: stats.unchanged,
                invalid_count: invalidCount,
                duplicate_in_source_count: duplicateInSourceCount,
                eligible_count: stats.eligible,
                errors: 0,
                is_complete: fetchResult.isComplete === false ? 0 : 1
            });
        }
    }

    // ── B. Public Job Feeds & REST APIs (Phase 4C Batch 1) ────────────────────

    for (const feedCfg of feedTargets) {
        const provider = String(feedCfg.provider || '').toLowerCase();
        const reg = PUBLIC_FEED_REGISTRY[provider];

        if (!reg) {
            console.log(`  ⚠️ Unknown public feed provider: ${provider}`);
            continue;
        }

        const feedCid = `feed-${provider}`;
        if (!dryRun) {
            upsertCompany({
                id: feedCid,
                name: `${reg.displayName} (Public Feed)`,
                career_url: reg.endpoint,
                ats_type: provider,
                policy_status: feedCfg.policy_status || 'permitted',
                source_provenance: 'public_feed',
                notes: reg.attribution
            });
        }

        const permitted = dryRun || isSourcePermitted(feedCid, provider);
        if (!permitted) {
            console.log(`  ⛔ ${reg.displayName} (${provider}): Skipped (source policy not permitted)`);
            summary.skippedPolicy++;
            continue;
        }

        if (reg.requiresCredentials && typeof reg.hasCredentials === 'function' && !reg.hasCredentials()) {
            console.log(`  🔒 ${reg.displayName} (${provider}): BLOCKED_CREDENTIALS (API credentials not configured)`);
            summary.blockedCredentials.push(provider);
            summary.byFeed[provider] = {
                source_type: provider,
                status: 'BLOCKED_CREDENTIALS',
                fetched_count: 0,
                normalized_count: 0,
                inserted_count: 0
            };
            continue;
        }

        if (!dryRun) {
            const rateCheck = checkFeedRateLimit(feedCid, provider, reg, { forceRateLimit });
            if (!rateCheck.allowed) {
                console.log(`  ⏳ ${reg.displayName} (${provider}): Skipped (${rateCheck.reason})`);
                summary.skippedRateLimit++;
                summary.byFeed[provider] = {
                    source_type: provider,
                    status: `SKIPPED_RATE_LIMIT: ${rateCheck.reason}`,
                    fetched_count: 0,
                    normalized_count: 0,
                    inserted_count: 0
                };
                continue;
            }
        }

        summary.feedsScanned++;
        process.stdout.write(`  🌐 ${reg.displayName} (${provider})... `);

        let scanId = null;
        if (!dryRun) {
            scanId = createSourceScan({
                company_id: feedCid,
                source_type: provider,
                started_at: new Date().toISOString()
            });
        }

        const fetchResult = await reg.fetcher({
            ...(feedCfg.options || {}),
            fetchFn,
            timeoutMs
        });

        const jobs = fetchResult?.jobs || [];
        const hasFatalError = !fetchResult || (fetchResult.error && jobs.length === 0);

        if (hasFatalError) {
            const errDetail = fetchResult?.error || 'Unknown public feed scan error';
            console.log(`FAILED: ${errDetail}`);
            summary.errors.push({ feed: provider, company: reg.displayName, error: errDetail });
            summary.byFeed[provider] = {
                source_type: provider,
                status: 'ERROR',
                error: errDetail,
                fetched_count: 0,
                normalized_count: 0,
                inserted_count: 0
            };
            if (!dryRun && scanId) {
                updateSourceScan(scanId, {
                    completed_at: new Date().toISOString(),
                    errors: 1,
                    is_complete: 0,
                    error_details: errDetail
                });
            }
            continue;
        }

        const fetchedCount = fetchResult.fetchedCount || jobs.length;
        const normalizedCount = fetchResult.normalizedCount || jobs.length;
        const invalidCount = fetchResult.invalidCount || 0;
        const duplicateInSourceCount = fetchResult.duplicateInSourceCount || 0;

        summary.fetchedCount += fetchedCount;
        summary.normalizedCount += normalizedCount;
        summary.invalidCount += invalidCount;
        summary.duplicateInSourceCount += duplicateInSourceCount;

        const stats = persistDiscoveredJobs(jobs, { dryRun, titleFilter, resolveEmployer: true });

        summary.insertedCount += stats.inserted;
        summary.updatedCount += stats.updated;
        summary.unchangedCount += stats.unchanged;
        summary.eligibleCount += stats.eligible;
        summary.crossSourceDuplicateSuggestions += stats.crossDuplicates;

        summary.byFeed[provider] = {
            source_type: provider,
            status: fetchResult.error ? 'PARTIAL' : 'OK',
            warning: fetchResult.error || null,
            fetched_count: fetchedCount,
            normalized_count: normalizedCount,
            inserted_count: stats.inserted,
            updated_count: stats.updated,
            unchanged_count: stats.unchanged,
            invalid_count: invalidCount,
            duplicate_in_source_count: duplicateInSourceCount,
            cross_source_duplicate_suggestions: stats.crossDuplicates,
            eligible_count: stats.eligible
        };

        console.log(`${jobs.length} normalized (${stats.inserted} inserted, ${stats.updated} updated, ${stats.unchanged} unchanged, ${stats.eligible} candidate-eligible)${fetchResult.error ? ` [warning: ${fetchResult.error}]` : ''}`);

        if (!dryRun && scanId) {
            updateSourceScan(scanId, {
                completed_at: new Date().toISOString(),
                total_jobs: jobs.length,
                new_jobs: stats.inserted,
                duplicate_jobs: stats.unchanged + stats.updated,
                fetched_count: fetchedCount,
                normalized_count: normalizedCount,
                inserted_count: stats.inserted,
                updated_count: stats.updated,
                unchanged_count: stats.unchanged,
                invalid_count: invalidCount,
                duplicate_in_source_count: duplicateInSourceCount,
                eligible_count: stats.eligible,
                errors: fetchResult.error ? 1 : 0,
                is_complete: 1,
                error_details: fetchResult.error || null
            });
        }
    }

    // ── C. Startup Ecosystem & Employer Discovery (Phase 4C Batch 2) ──────────

    for (const srcCfg of startupTargets) {
        const provider = String(srcCfg.provider || '').toLowerCase();
        const reg = STARTUP_ECOSYSTEM_REGISTRY[provider];
        if (!reg) {
            console.log(`  ⚠️ Unknown startup ecosystem provider: ${provider}`);
            continue;
        }

        const feedCid = provider === 'hackernews' ? 'feed-hackernews-whoishiring' : 'feed-yc-directory';
        if (!dryRun) {
            const rateCheck = checkFeedRateLimit(feedCid, provider, reg, { forceRateLimit });
            if (!rateCheck.allowed) {
                console.log(`  ⏸️  ${reg.displayName}: ${rateCheck.reason}`);
                summary.skippedRateLimit++;
                summary.byFeed[provider] = { status: 'RATE_LIMITED', reason: rateCheck.reason };
                continue;
            }
        }

        summary.feedsScanned++;
        process.stdout.write(`  🚀 ${reg.displayName} (${provider})... `);

        try {
            const res = await reg.fetcher({
                ...(srcCfg.options || {}),
                dryRun,
                fetchFn,
                timeoutMs
            });

            const jobs = res?.jobs || [];
            let eligible = 0;
            for (const job of jobs) {
                const title = job.title || job.roleTitle || '';
                const isEligible = titleFilter(title);
                if (isEligible) eligible++;
                if (!dryRun && job.id && job.job_url) {
                    const existingEval = getJobEvaluation(job.id);
                    if (!existingEval) {
                        upsertJobEvaluation({
                            job_id: job.id,
                            recommendation: isEligible ? 'CONSIDER' : 'DO_NOT_APPLY',
                            overall_fit: isEligible ? 0.5 : 0.0,
                            rationale: isEligible
                                ? `Startup ecosystem title match (${provider})`
                                : `Excluded by title filter during ${provider} scan`
                        });
                    }
                }
            }

            const fetchedCount = res.commentsInspected ?? res.jobsFetchedFromAts ?? jobs.length;
            const normalizedCount = jobs.length;
            const inserted = res.jobsInserted ?? 0;
            const updated = res.jobsUpdated ?? 0;
            const unchanged = res.jobsUnchanged ?? 0;
            const crossDups = res.crossSourceDuplicates ?? 0;
            const invalid = res.commentsRejected ?? ((res.blockedUrls || 0) + (res.robotsBlocked || 0));

            summary.fetchedCount += fetchedCount;
            summary.normalizedCount += normalizedCount;
            summary.insertedCount += inserted;
            summary.updatedCount += updated;
            summary.unchangedCount += unchanged;
            summary.invalidCount += invalid;
            summary.eligibleCount += eligible;
            summary.crossSourceDuplicateSuggestions += crossDups;

            summary.byFeed[provider] = {
                source_type: provider,
                status: res.errors?.length ? 'PARTIAL' : 'OK',
                fetched_count: fetchedCount,
                normalized_count: normalizedCount,
                inserted_count: inserted,
                updated_count: updated,
                unchanged_count: unchanged,
                invalid_count: invalid,
                cross_source_duplicate_suggestions: crossDups,
                eligible_count: eligible
            };

            console.log(`${normalizedCount} normalized (${inserted} inserted, ${updated} updated, ${unchanged} unchanged, ${eligible} candidate-eligible)`);
        } catch (err) {
            console.log(`FAILED: ${err.message}`);
            summary.errors.push({ feed: provider, company: reg.displayName, error: err.message });
            summary.byFeed[provider] = {
                source_type: provider,
                status: 'ERROR',
                error: err.message,
                fetched_count: 0,
                normalized_count: 0,
                inserted_count: 0
            };
        }
    }

    console.log(`\n==================================================`);
    console.log(`📊 Scan Complete Summary`);
    console.log(`==================================================`);
    console.log(`Companies Scanned:                  ${summary.scanned} (Skipped Policy: ${summary.skippedPolicy})`);
    console.log(`Public Feeds Scanned:               ${summary.feedsScanned} (Skipped Rate Limit: ${summary.skippedRateLimit}, Blocked Creds: ${summary.blockedCredentials.length})`);
    console.log(`Fetched from Sources:               ${summary.fetchedCount}`);
    console.log(`Normalized Postings:                ${summary.normalizedCount}`);
    console.log(`Newly Inserted into DB:             ${summary.insertedCount}`);
    console.log(`Content Updated (New Snapshots):    ${summary.updatedCount}`);
    console.log(`Unchanged (Routine Refreshes):      ${summary.unchangedCount}`);
    console.log(`Invalid Payloads:                   ${summary.invalidCount}`);
    console.log(`Duplicates within Source:           ${summary.duplicateInSourceCount}`);
    console.log(`Candidate Eligible Postings:        ${summary.eligibleCount}`);
    console.log(`Cross-Source Duplicate Suggestions: ${summary.crossSourceDuplicateSuggestions}`);
    console.log(`Failures Isolated:                  ${summary.errors.length}`);
    if (summary.errors.length > 0) {
        console.log(`Errors:`);
        for (const e of summary.errors) {
            console.log(`  - ${e.company || e.feed}: ${e.error}`);
        }
    }
    console.log(`==================================================\n`);

    return summary;
}

async function main() {
    const args = process.argv.slice(2);
    const dryRun = args.includes('--dry-run');
    const feedsOnly = args.includes('--feeds-only');
    const noFeeds = args.includes('--no-feeds');
    const forceRateLimit = args.includes('--force-rate-limit');

    const cf = args.indexOf('--company');
    const filterCompany = cf !== -1 ? args[cf + 1] : null;

    const sf = args.indexOf('--source');
    const filterSource = sf !== -1 ? args[sf + 1] : null;

    try {
        await runScanner({
            dryRun,
            filterCompany,
            filterSource,
            feedsOnly,
            includeFeeds: !noFeeds,
            forceRateLimit
        });
    } finally {
        closeDb();
    }
}

if (process.argv[1] && (process.argv[1].endsWith('scan-sqlite.mjs') || process.argv[1].includes('scan-sqlite'))) {
    main().catch(err => {
        console.error('Scanner fatal error:', err);
        closeDb();
        process.exit(1);
    });
}
