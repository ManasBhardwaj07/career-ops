/**
 * verification/verify-jobs.mjs — Job Existence and Liveness Verification Service
 *
 * Implements Milestone 3B Part 2:
 *   - Verifies whether job postings still exist and are accepting applications
 *   - Updates job_postings.status (single authoritative status: active, closed, expired)
 *   - Records verification metadata (last_verified_at, verification_method)
 *   - Never marks jobs closed on 403, 429, CAPTCHA, Cloudflare, timeout, or 5xx
 *   - Preserves snapshot history on status transitions
 */

import { classifyLiveness } from '../liveness-core.mjs';
import {
    getJobsForVerification,
    updateJobVerification,
    getJob,
    getDb,
    getCompany,
    createSourceScan,
    updateSourceScan
} from '../db/repo.mjs';
import { checkJobicyJobStatuses, mapJobicyStatusToVerificationOutcome } from '../discovery/adapters/jobicy.mjs';
import { fetchAshbyJobs, extractBoard as extractAshbyBoard } from '../discovery/adapters/ashby.mjs';
import { fetchLeverJobs, extractCompany as extractLeverCompany } from '../discovery/adapters/lever.mjs';
import { fetchGreenhouseJobs, extractBoard as extractGreenhouseBoard } from '../discovery/adapters/greenhouse.mjs';
import { fetchSmartRecruitersJobs, extractCompanyIdentifier as extractSmartRecruitersBoard } from '../discovery/adapters/smartrecruiters.mjs';
import { fetchWorkdayJobs, extractWorkdayConfig } from '../discovery/adapters/workday.mjs';
import { fetchWorkableJobs, extractAccount as extractWorkableAccount } from '../discovery/adapters/workable.mjs';
import { fetchRecruiteeJobs, extractCompany as extractRecruiteeCompany } from '../discovery/adapters/recruitee.mjs';

const ATS_PROVIDERS = new Set(['ashby', 'lever', 'greenhouse', 'smartrecruiters', 'workday', 'workable', 'recruitee']);
const DEFAULT_ATS_FRESHNESS_HOURS = 24;

const BOT_CHALLENGE_PATTERNS = [
    /cloudflare/i,
    /turnstile/i,
    /recaptcha/i,
    /hcaptcha/i,
    /verify you are human/i,
    /checking your browser/i,
    /please complete the security check/i,
    /access denied/i
];

const EXPLICIT_CLOSED_PATTERNS = [
    /this job has expired/i,
    /position has been filled/i,
    /job.*no longer open/i,
    /no longer accepting applications/i,
    /applications?\s+(?:(?:have|are|is)\s+)?closed/i,
    /this job (listing )?is closed/i,
    /the vacancy has closed/i
];

/**
 * Classifies an HTTP or Playwright result into strict verification outcomes:
 *   ACTIVE | CLOSED | EXPIRED | UNKNOWN | ERROR
 */
export function determineVerificationOutcome({
    status = 0,
    finalUrl = '',
    bodyText = '',
    applyControls = [],
    error = null
} = {}) {
    // 1. Technical error / Network timeout / DNS failure
    if (error) {
        const msg = String(error.message || error).toLowerCase();
        if (msg.includes('timeout') || msg.includes('etimedout') || msg.includes('aborterror')) {
            return {
                outcome: 'ERROR',
                reason: `Network timeout: ${error.message || error}`,
                definitive: false
            };
        }
        if (msg.includes('enotfound') || msg.includes('econnrefused') || msg.includes('econnreset')) {
            return {
                outcome: 'ERROR',
                reason: `Connection error: ${error.message || error}`,
                definitive: false
            };
        }
        return {
            outcome: 'ERROR',
            reason: `Technical failure: ${error.message || error}`,
            definitive: false
        };
    }

    // 2. HTTP 5xx Server Error -> Temporary, do NOT mark closed
    if (status >= 500 && status <= 599) {
        return {
            outcome: 'ERROR',
            reason: `Temporary server error (HTTP ${status})`,
            definitive: false
        };
    }

    // 3. HTTP 429 Rate Limit -> Do NOT mark closed
    if (status === 429) {
        return {
            outcome: 'UNKNOWN',
            reason: 'Rate limit encountered (HTTP 429)',
            definitive: false
        };
    }

    // 4. HTTP 403 Forbidden -> Bot protection or auth gate, do NOT mark closed
    if (status === 403) {
        return {
            outcome: 'UNKNOWN',
            reason: 'Access forbidden / Bot defense (HTTP 403)',
            definitive: false
        };
    }

    // 5. Bot challenge / CAPTCHA text in body
    for (const pat of BOT_CHALLENGE_PATTERNS) {
        if (pat.test(bodyText)) {
            return {
                outcome: 'UNKNOWN',
                reason: `Bot verification gate detected: ${pat.source}`,
                definitive: false
            };
        }
    }

    // 6. HTTP 404 / 410 -> Permanent expiration
    if (status === 404 || status === 410) {
        return {
            outcome: 'EXPIRED',
            reason: `HTTP ${status}: Not Found`,
            definitive: true
        };
    }

    // 7. Explicit closure patterns in body text
    for (const pat of EXPLICIT_CLOSED_PATTERNS) {
        if (pat.test(bodyText)) {
            return {
                outcome: 'CLOSED',
                reason: `Explicit closure: ${pat.source}`,
                definitive: true
            };
        }
    }

    // 8. Extract apply controls if not directly provided (e.g. from plain HTTP probe body)
    let effectiveControls = applyControls;
    if ((!effectiveControls || effectiveControls.length === 0) && bodyText) {
        const matches = bodyText.match(/(?:apply\s+now|submit\s+application|apply\s+for\s+this\s+job|apply\s+online|start\s+application)/gi);
        if (matches) effectiveControls = matches;
    }

    // 9. Delegate to liveness core classifier for DOM / apply controls
    const core = classifyLiveness({ status, finalUrl, bodyText, applyControls: effectiveControls });
    if (core.result === 'active') {
        return {
            outcome: 'ACTIVE',
            reason: core.reason,
            definitive: true
        };
    }

    if (core.result === 'expired') {
        // Distinguish between closure and expiration from core reason
        if (core.reason.includes('HTTP 404') || core.reason.includes('redirect')) {
            return {
                outcome: 'EXPIRED',
                reason: core.reason,
                definitive: true
            };
        }
        return {
            outcome: 'CLOSED',
            reason: core.reason,
            definitive: true
        };
    }

    // Fallback: uncertain / unknown
    return {
        outcome: 'UNKNOWN',
        reason: core.reason || 'Insufficient evidence to determine availability',
        definitive: false
    };
}

function isHnPermalinkUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return false;
    try {
        const u = new URL(rawUrl);
        const h = u.hostname.toLowerCase();
        return (h === 'news.ycombinator.com' || h === 'www.news.ycombinator.com') && u.pathname.startsWith('/item');
    } catch {
        return false;
    }
}

function findAuthoritativeAtsListingForHnJob(job, raw) {
    if (!job?.company_id || !raw?.atsType) return null;
    try {
        const db = getDb();
        const atsJobs = db.prepare(`
            SELECT * FROM job_postings
            WHERE company_id = ? AND source = ?
        `).all(job.company_id, raw.atsType);
        if (!atsJobs || atsJobs.length === 0) return null;

        const cleanTarget = String(job.title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
        if (!cleanTarget) return null;

        const exact = atsJobs.find(aj =>
            String(aj.title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() === cleanTarget
        );
        if (exact) return exact;

        const tokenMatch = atsJobs.find(aj => {
            const t = String(aj.title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
            return t && (t.includes(cleanTarget) || cleanTarget.includes(t));
        });
        return tokenMatch || null;
    } catch {
        return null;
    }
}

function resolveVerificationTarget(job) {
    const isHnUrl = isHnPermalinkUrl(job.job_url);
    if (!isHnUrl && job.source !== 'hackernews') {
        return { url: job.job_url, isAuthoritative: true, isGenericBoardOrCareers: false, isHnDiscussionOnly: false };
    }

    let raw = null;
    let rawJsonText = job.raw_json || null;
    if (!rawJsonText && job.id) {
        try {
            const snap = getDb().prepare(
                'SELECT raw_json FROM job_snapshots WHERE job_id = ? ORDER BY id DESC LIMIT 1'
            ).get(job.id);
            rawJsonText = snap?.raw_json || null;
        } catch {
            rawJsonText = null;
        }
    }
    if (rawJsonText) {
        try { raw = JSON.parse(rawJsonText); } catch { raw = null; }
    }

    if (!isHnUrl) {
        return { url: job.job_url, isAuthoritative: true, isGenericBoardOrCareers: false, isHnDiscussionOnly: false };
    }

    if (raw?.specificJobUrl && !isHnPermalinkUrl(raw.specificJobUrl)) {
        return { url: raw.specificJobUrl, isAuthoritative: true, isGenericBoardOrCareers: false, isHnDiscussionOnly: false };
    }

    const atsMatch = findAuthoritativeAtsListingForHnJob(job, raw);
    if (atsMatch && atsMatch.job_url && !isHnPermalinkUrl(atsMatch.job_url)) {
        return { url: atsMatch.job_url, isAuthoritative: true, isGenericBoardOrCareers: false, isHnDiscussionOnly: false };
    }

    if (raw?.atsUrl && !isHnPermalinkUrl(raw.atsUrl)) {
        return { url: raw.atsUrl, isAuthoritative: false, isGenericBoardOrCareers: true, isHnDiscussionOnly: false };
    }

    if (raw?.careersUrl && !isHnPermalinkUrl(raw.careersUrl)) {
        return { url: raw.careersUrl, isAuthoritative: false, isGenericBoardOrCareers: true, isHnDiscussionOnly: false };
    }

    return { url: job.job_url, isAuthoritative: false, isGenericBoardOrCareers: false, isHnDiscussionOnly: true };
}

/**
 * Verifies a single job posting using provided fetchFn or Playwright
 */
export async function verifySingleJob(job, {
    timeoutMs = 15000,
    fetchFn = null,
    page = null,
    dryRun = false
} = {}) {
    const target = resolveVerificationTarget(job);

    if (target.isHnDiscussionOnly) {
        const outcome = 'UNKNOWN';
        const reason = 'HN discussion permalink is provenance only; no employer vacancy URL or authoritative ATS listing available';
        if (!dryRun) {
            updateJobVerification(job.id, {
                status: null,
                lastVerifiedAt: new Date().toISOString(),
                verificationMethod: 'hn_provenance_only:unknown'
            });
        }
        return {
            jobId: job.id,
            jobUrl: job.job_url,
            verifiedTargetUrl: null,
            previousStatus: job.status,
            newStatus: job.status,
            outcome,
            reason,
            definitive: false
        };
    }

    let checkData = {
        status: 0,
        finalUrl: target.url,
        bodyText: '',
        applyControls: [],
        error: null
    };

    // Pathway A: Custom fetchFn (mock testing or fast HTTP probe)
    if (fetchFn) {
        try {
            const res = await fetchFn(target.url, {
                headers: { 'Accept': 'text/html,application/json' },
                timeout: timeoutMs
            });
            checkData.status = res.status;
            checkData.finalUrl = res.url || target.url;
            checkData.bodyText = typeof res.text === 'function' ? await res.text() : '';
        } catch (err) {
            checkData.error = err;
        }
    }
    // Pathway B: Playwright Browser Page (rich SPA evaluation)
    else if (page) {
        try {
            const response = await page.goto(target.url, {
                waitUntil: 'domcontentloaded',
                timeout: timeoutMs
            });
            checkData.status = response?.status() ?? 0;
            checkData.finalUrl = page.url();

            // Brief wait for SPA hydration
            await page.waitForTimeout(1500);

            checkData.bodyText = await page.evaluate(() => document.body?.innerText ?? '');
            checkData.applyControls = await page.evaluate(() => {
                const candidates = Array.from(
                    document.querySelectorAll('a, button, input[type="submit"], input[type="button"], [role="button"]')
                );
                return candidates
                    .filter(el => !el.closest('nav, header, footer') && !el.closest('[aria-hidden="true"]'))
                    .map(el => (el.innerText || el.value || el.getAttribute('aria-label') || '').trim())
                    .filter(Boolean);
            });
        } catch (err) {
            checkData.error = err;
        }
    }
    // Pathway C: Default Node.js global fetch fallback
    else {
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            const res = await fetch(target.url, {
                signal: controller.signal,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            });
            clearTimeout(timer);
            checkData.status = res.status;
            checkData.finalUrl = res.url || target.url;
            checkData.bodyText = await res.text();
        } catch (err) {
            checkData.error = err;
        }
    }

    let { outcome, reason, definitive } = determineVerificationOutcome(checkData);

    // Never allow a generic careers/board overview page without specific vacancy match to mark an HN comment active
    if (target.isGenericBoardOrCareers && outcome === 'ACTIVE') {
        outcome = 'UNKNOWN';
        reason = 'Generic careers/board page cannot definitively confirm specific HN vacancy without direct job URL or ATS match';
        definitive = false;
    }

    // Map outcome to canonical job_postings.status (only on definitive change)
    let newStatus = null;
    if (definitive) {
        if (outcome === 'ACTIVE') newStatus = 'active';
        else if (outcome === 'CLOSED') newStatus = 'closed';
        else if (outcome === 'EXPIRED') newStatus = 'expired';
    }

    if (!dryRun) {
        const baseMethod = page ? 'playwright_browser' : 'http_probe';
        const methodWithOutcome = `${baseMethod}:${outcome.toLowerCase()}`;
        updateJobVerification(job.id, {
            status: newStatus, // if null, status is unchanged
            lastVerifiedAt: new Date().toISOString(),
            verificationMethod: methodWithOutcome
        });
    }

    return {
        jobId: job.id,
        jobUrl: job.job_url,
        verifiedTargetUrl: target.url,
        previousStatus: job.status,
        newStatus: newStatus || job.status,
        outcome,
        reason,
        definitive
    };
}

function normalizeAtsUrl(url) {
    if (!url || typeof url !== 'string') return '';
    try {
        const u = new URL(url.trim());
        const pathname = u.pathname.replace(/\/+$/, '').toLowerCase();
        return `${u.protocol}//${u.hostname.toLowerCase()}${pathname}`;
    } catch {
        return url.trim().replace(/\/+$/, '').toLowerCase();
    }
}

function resolveAtsBoardIdentifier(job, company) {
    if (company?.board_identifier && company?.ats_type === job.source) {
        return company.board_identifier;
    }
    const candidates = [job.job_url, company?.career_url].filter(Boolean);
    for (const candidate of candidates) {
        switch (job.source) {
            case 'ashby': {
                const b = extractAshbyBoard(candidate);
                if (b) return b;
                break;
            }
            case 'lever': {
                const b = extractLeverCompany(candidate);
                if (b) return b;
                break;
            }
            case 'greenhouse': {
                const b = extractGreenhouseBoard(candidate);
                if (b) return b;
                break;
            }
            case 'smartrecruiters': {
                const b = extractSmartRecruitersBoard(candidate);
                if (b) return b;
                break;
            }
            case 'workday': {
                const cfg = extractWorkdayConfig(candidate);
                if (cfg) return `${cfg.tenant}:${cfg.instance}:${cfg.site}`;
                break;
            }
            case 'workable': {
                const b = extractWorkableAccount(candidate);
                if (b) return b;
                break;
            }
            case 'recruitee': {
                const b = extractRecruiteeCompany(candidate);
                if (b) return b;
                break;
            }
        }
    }
    return company?.board_identifier || null;
}

async function fetchAtsBoardSnapshot(provider, boardIdentifier, companyId, companyName, { fetchFn = fetch, timeoutMs = 10000 } = {}) {
    const opts = { fetchFn, timeoutMs };
    switch (provider) {
        case 'ashby':
            return fetchAshbyJobs(boardIdentifier, companyId, companyName, opts);
        case 'lever':
            return fetchLeverJobs(boardIdentifier, companyId, companyName, opts);
        case 'greenhouse':
            return fetchGreenhouseJobs(boardIdentifier, companyId, companyName, opts);
        case 'smartrecruiters':
            return fetchSmartRecruitersJobs(boardIdentifier, companyId, companyName, {
                ...opts,
                limit: 100,
                maxPages: 20,
                maxJobs: 2000
            });
        case 'workday':
            return fetchWorkdayJobs(boardIdentifier, companyId, companyName, {
                ...opts,
                limit: 50,
                maxPages: 20,
                maxJobs: 1000
            });
        case 'workable':
            return fetchWorkableJobs(boardIdentifier, companyId, companyName, opts);
        case 'recruitee':
            return fetchRecruiteeJobs(boardIdentifier, companyId, companyName, opts);
        default:
            return {
                jobs: [],
                fetchedCount: 0,
                normalizedCount: 0,
                invalidCount: 0,
                duplicateInSourceCount: 0,
                isComplete: false,
                error: `Unsupported ATS provider: ${provider}`
            };
    }
}

function getFreshCompleteAtsScan(companyId, sourceType, freshnessHours = DEFAULT_ATS_FRESHNESS_HOURS) {
    if (!companyId || !sourceType) return null;
    const db = getDb();
    const scan = db.prepare(`
        SELECT * FROM source_scans
        WHERE company_id = ? AND source_type = ? AND is_complete = 1 AND errors = 0 AND completed_at IS NOT NULL
        ORDER BY completed_at DESC
        LIMIT 1
    `).get(companyId, sourceType);
    if (!scan) return null;

    const completedMs = new Date(scan.completed_at).getTime();
    if (Number.isNaN(completedMs)) return null;
    const maxAgeMs = freshnessHours * 60 * 60 * 1000;
    if (Date.now() - completedMs > maxAgeMs) {
        return null; // Stale scan
    }
    return scan;
}

function isExplicitAtsListingClosed(fetchedJob) {
    if (!fetchedJob) return false;
    if (fetchedJob.status === 'closed') return true;
    const raw = fetchedJob.raw || {};
    if (raw.isListed === false) return true;
    const rawStatus = String(raw.status || raw.state || '').toLowerCase();
    return rawStatus === 'closed' || rawStatus === 'filled' || rawStatus === 'expired';
}

function isNewerTimestamp(candidateTs, existingTs) {
    if (!candidateTs) return false;
    const candMs = new Date(candidateTs).getTime();
    if (Number.isNaN(candMs)) return false;
    if (!existingTs) return true;
    const existMs = new Date(existingTs).getTime();
    if (Number.isNaN(existMs)) return true;
    return candMs > existMs;
}

function evaluateJobAgainstAtsBoard(job, boardRes) {
    const extId = job.source_job_id ? String(job.source_job_id).trim() : '';
    if (!extId) {
        return {
            outcome: 'UNKNOWN',
            newStatus: null,
            definitive: false,
            verificationMethod: 'ats_board_api:unknown',
            reason: 'Job posting lacks external source_job_id; cannot verify authoritatively',
            matchedFetched: null
        };
    }

    const fetchedJobs = Array.isArray(boardRes?.jobs) ? boardRes.jobs : [];
    const byId = new Map();
    for (const fj of fetchedJobs) {
        const fid = fj.source_job_id ? String(fj.source_job_id).trim() : '';
        if (fid) byId.set(fid, fj);
    }

    const matched = byId.get(extId);
    if (matched) {
        const expectedUrl = normalizeAtsUrl(job.job_url);
        const actualUrl = normalizeAtsUrl(matched.job_url);
        if (expectedUrl && actualUrl && expectedUrl !== actualUrl) {
            return {
                outcome: 'UNKNOWN',
                newStatus: null,
                definitive: false,
                verificationMethod: 'ats_board_api:unknown',
                reason: `ATS listing URL mismatch for source_job_id ${extId}`,
                matchedFetched: null
            };
        }

        if (isExplicitAtsListingClosed(matched)) {
            return {
                outcome: 'CLOSED',
                newStatus: 'closed',
                definitive: true,
                verificationMethod: 'ats_board_api:closed',
                reason: 'Authoritative ATS API reports explicit closed/unlisted status',
                matchedFetched: matched
            };
        }

        if (boardRes.error && boardRes.isComplete === false) {
            return {
                outcome: 'ACTIVE',
                newStatus: 'active',
                definitive: true,
                verificationMethod: 'ats_board_api:active',
                reason: `Matched active listing in official ${job.source} ATS feed`,
                matchedFetched: matched
            };
        }

        return {
            outcome: 'ACTIVE',
            newStatus: 'active',
            definitive: true,
            verificationMethod: 'ats_board_api:active',
            reason: `Matched active listing in complete official ${job.source} ATS board feed`,
            matchedFetched: matched
        };
    }

    if (boardRes?.error) {
        return {
            outcome: 'ERROR',
            newStatus: null,
            definitive: false,
            verificationMethod: 'ats_board_api:error',
            reason: `ATS board fetch failed: ${boardRes.error}`,
            matchedFetched: null
        };
    }

    if (boardRes?.isComplete === false) {
        return {
            outcome: 'UNKNOWN',
            newStatus: null,
            definitive: false,
            verificationMethod: 'ats_board_api:unknown',
            reason: 'Job absent from partial ATS board feed; never marking closed from incomplete feed',
            matchedFetched: null
        };
    }

    return {
        outcome: 'UNKNOWN',
        newStatus: null,
        definitive: false,
        verificationMethod: 'ats_board_api:unknown',
        reason: 'Job absent from single complete ATS board feed; not marking closed on single absence',
        matchedFetched: null
    };
}

/**
 * Verifies a batch of jobs according to freshness and priority policies
 */
export async function verifyJobBatch(options = {}) {
    const {
        limit = 50,
        maxAgeDays = 3,
        companyId = null,
        jobIds = null,
        dryRun = false,
        timeoutMs = 15000,
        fetchFn = null,
        page = null,
        atsFreshnessHours = DEFAULT_ATS_FRESHNESS_HOURS,
        preferFreshScan = false
    } = options;

    const candidateJobs = getJobsForVerification({ limit, maxAgeDays, companyId, jobIds });

    const summary = {
        totalProcessed: 0,
        activeCount: 0,
        closedCount: 0,
        expiredCount: 0,
        unknownCount: 0,
        errorCount: 0,
        atsBoardCalls: 0,
        dryRun,
        results: []
    };

    // Batch check stored Jobicy listings via official /api/jobs/status endpoint
    let jobicyStatusMap = null;
    let jobicyBatchError = null;
    if (!page) {
        const jobicyIds = candidateJobs
            .filter(j => j.source === 'jobicy' && j.source_job_id)
            .map(j => String(j.source_job_id).trim())
            .filter(Boolean);

        if (jobicyIds.length > 0) {
            const batchRes = await checkJobicyJobStatuses(jobicyIds, {
                fetchFn: fetchFn || fetch,
                timeoutMs
            });
            jobicyStatusMap = batchRes.statuses;
            if (batchRes.errors.length > 0) {
                jobicyBatchError = batchRes.errors.join('; ');
            }
        }
    }

    // Group authoritative ATS postings by (company_id, source, board_identifier)
    const atsOutcomeByJobId = new Map();
    if (!page) {
        const atsGroups = new Map();
        const companyCache = new Map();

        for (const job of candidateJobs) {
            if (!ATS_PROVIDERS.has(job.source)) continue;
            let comp = companyCache.get(job.company_id);
            if (comp === undefined) {
                comp = job.company_id ? getCompany(job.company_id) : null;
                companyCache.set(job.company_id, comp);
            }
            const boardId = resolveAtsBoardIdentifier(job, comp);
            const groupKey = `${job.company_id || ''}::${job.source}::${boardId || 'MISSING'}`;
            if (!atsGroups.has(groupKey)) {
                atsGroups.set(groupKey, {
                    companyId: job.company_id,
                    companyName: comp?.name || job.company_id || 'Unknown',
                    provider: job.source,
                    boardIdentifier: boardId,
                    jobs: []
                });
            }
            atsGroups.get(groupKey).jobs.push(job);
        }

        for (const group of atsGroups.values()) {
            const now = new Date().toISOString();

            if (!group.boardIdentifier) {
                for (const job of group.jobs) {
                    atsOutcomeByJobId.set(job.id, {
                        outcome: 'UNKNOWN',
                        newStatus: null,
                        definitive: false,
                        verificationMethod: 'ats_board_api:unknown',
                        reason: 'Missing ATS board identifier for company/URL',
                        matchedFetched: null
                    });
                }
                continue;
            }

            // Optional fresh-scan short-circuit (strictly within atsFreshnessHours, complete & 0 errors)
            if (preferFreshScan && !fetchFn && group.companyId) {
                const freshScan = getFreshCompleteAtsScan(group.companyId, group.provider, atsFreshnessHours);
                if (freshScan) {
                    const scanStartMs = new Date(freshScan.started_at).getTime();
                    const allSeenInScan = group.jobs.every(j => {
                        if (!j.source_job_id || !j.last_seen_at) return false;
                        const seenMs = new Date(j.last_seen_at).getTime();
                        return !Number.isNaN(seenMs) && !Number.isNaN(scanStartMs) && seenMs >= scanStartMs;
                    });
                    if (allSeenInScan) {
                        for (const job of group.jobs) {
                            atsOutcomeByJobId.set(job.id, {
                                outcome: 'ACTIVE',
                                newStatus: 'active',
                                definitive: true,
                                verificationMethod: 'ats_board_api:active',
                                reason: `Verified active via fresh complete ${group.provider} scan (${freshScan.id})`,
                                matchedFetched: null
                            });
                        }
                        continue;
                    }
                }
            }

            let scanId = null;
            if (!dryRun && group.companyId) {
                scanId = createSourceScan({
                    company_id: group.companyId,
                    source_type: group.provider,
                    started_at: now
                });
            }

            summary.atsBoardCalls++;
            const boardRes = await fetchAtsBoardSnapshot(
                group.provider,
                group.boardIdentifier,
                group.companyId,
                group.companyName,
                { fetchFn: fetchFn || fetch, timeoutMs }
            );

            if (!dryRun && scanId) {
                const completedAt = new Date().toISOString();
                const isComplete = Boolean(boardRes.isComplete !== false && !boardRes.error);
                updateSourceScan(scanId, {
                    completed_at: completedAt,
                    total_jobs: Array.isArray(boardRes.jobs) ? boardRes.jobs.length : 0,
                    fetched_count: boardRes.fetchedCount ?? (boardRes.jobs?.length || 0),
                    normalized_count: boardRes.normalizedCount ?? (boardRes.jobs?.length || 0),
                    invalid_count: boardRes.invalidCount ?? 0,
                    duplicate_in_source_count: boardRes.duplicateInSourceCount ?? 0,
                    errors: boardRes.error ? 1 : 0,
                    is_complete: isComplete,
                    error_details: boardRes.error || null
                });
            }

            for (const job of group.jobs) {
                atsOutcomeByJobId.set(job.id, evaluateJobAgainstAtsBoard(job, boardRes));
            }
        }
    }

    for (const job of candidateJobs) {
        let res;
        if (!page && job.source === 'jobicy' && job.source_job_id && jobicyStatusMap) {
            const idKey = String(job.source_job_id).trim();
            const rawToken = jobicyStatusMap[idKey] || 'unknown';
            const mapped = jobicyBatchError && rawToken === 'unknown'
                ? { outcome: 'ERROR', reason: `Jobicy batch status error: ${jobicyBatchError}`, definitive: false }
                : mapJobicyStatusToVerificationOutcome(rawToken);

            let newStatus = null;
            if (mapped.definitive) {
                if (mapped.outcome === 'ACTIVE') newStatus = 'active';
                else if (mapped.outcome === 'CLOSED') newStatus = 'closed';
            }

            if (!dryRun) {
                updateJobVerification(job.id, {
                    status: newStatus,
                    lastVerifiedAt: new Date().toISOString(),
                    verificationMethod: `jobicy_batch_status:${mapped.outcome.toLowerCase()}`
                });
            }

            res = {
                jobId: job.id,
                jobUrl: job.job_url,
                previousStatus: job.status,
                newStatus: newStatus || job.status,
                outcome: mapped.outcome,
                reason: mapped.reason,
                definitive: mapped.definitive
            };
        } else if (!page && atsOutcomeByJobId.has(job.id)) {
            const evalRes = atsOutcomeByJobId.get(job.id);
            const now = new Date().toISOString();

            if (!dryRun) {
                updateJobVerification(job.id, {
                    status: evalRes.newStatus,
                    lastVerifiedAt: now,
                    verificationMethod: evalRes.verificationMethod
                });

                if (evalRes.matchedFetched) {
                    const db = getDb();
                    const newerTs = isNewerTimestamp(evalRes.matchedFetched.source_updated_at, job.source_updated_at)
                        ? evalRes.matchedFetched.source_updated_at
                        : job.source_updated_at;
                    db.prepare(`
                        UPDATE job_postings
                        SET last_seen_at = ?,
                            source_updated_at = COALESCE(?, source_updated_at)
                        WHERE id = ?
                    `).run(now, newerTs || null, job.id);
                }
            }

            res = {
                jobId: job.id,
                jobUrl: job.job_url,
                previousStatus: job.status,
                newStatus: evalRes.newStatus || job.status,
                outcome: evalRes.outcome,
                reason: evalRes.reason,
                definitive: evalRes.definitive,
                verificationMethod: evalRes.verificationMethod
            };
        } else {
            res = await verifySingleJob(job, { timeoutMs, fetchFn, page, dryRun });
        }

        summary.totalProcessed++;
        summary.results.push(res);

        if (res.outcome === 'ACTIVE') summary.activeCount++;
        else if (res.outcome === 'CLOSED') summary.closedCount++;
        else if (res.outcome === 'EXPIRED') summary.expiredCount++;
        else if (res.outcome === 'UNKNOWN') summary.unknownCount++;
        else if (res.outcome === 'ERROR') summary.errorCount++;
    }

    return summary;
}

/**
 * Evaluates whether a job posting currently has a successful, sufficiently recent verification.
 * A job is only verified active if:
 *   1. Canonical status is 'active'
 *   2. last_verified_at is present and within maxAgeDays
 *   3. The latest verification outcome was not ERROR, UNKNOWN, CLOSED, or EXPIRED
 */
export function isJobVerifiedActive(job, { maxAgeDays = 7 } = {}) {
    if (!job) return false;
    if (job.status !== 'active') return false;
    if (!job.last_verified_at) return false;

    const verifiedDate = new Date(job.last_verified_at).getTime();
    if (isNaN(verifiedDate)) return false;

    const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
    if (Date.now() - verifiedDate > maxAgeMs) {
        return false; // Stale verification
    }

    if (job.verification_method) {
        const vm = job.verification_method.toLowerCase();
        if (vm.includes(':error') || vm.includes(':unknown') || vm.includes(':closed') || vm.includes(':expired')) {
            return false; // Latest verification attempt was not successful
        }
    }

    return true;
}
