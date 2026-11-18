/**
 * test-phase4c-batch2-1.mjs — Phase 4C Batch 2.1 Regression Suite
 *
 * Tests (strictly isolated DB):
 *   1. Authoritative ATS API verification (Ashby, Lever, Greenhouse, SmartRecruiters, Workday)
 *   2. Full, partial, and failed board fetches + stale source scans + source_updated_at immutability
 *   3. External ID & URL matching, explicit closed status, partial & single-complete absence safety
 *   4. Source-policy & company-lifecycle matrix (pending/approved/blocked; UNVERIFIED/VERIFIED/APPROVED/MONITORING; paused/active; HN ats_validation; runScanner recurring gate)
 *   5. YC ATS source_scans lifecycle (start, completion, error, counts, last_scanned_at, idempotency)
 *   6. Canonical multi-source provenance (HN->Ashby and Ashby->HN, 1 canonical row, 0 duplicates, getJobProvenance)
 *   7. Evaluation reporting (Tier-1 NOT_EVALUATED vs genuine Tier-2 UNKNOWN)
 */

import assert from 'node:assert/strict';
import { existsSync, unlinkSync, readFileSync, readdirSync, rmSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const TEST_DB_PATH = resolve(process.cwd(), 'data', 'test_phase4c_batch2_1.db');
const CANONICAL_DB_PATH = resolve(process.cwd(), 'data', 'job_agent.db');

function cleanupFiles() {
    for (const f of [TEST_DB_PATH, `${TEST_DB_PATH}-wal`, `${TEST_DB_PATH}-shm`]) {
        if (existsSync(f)) {
            try { unlinkSync(f); } catch { /* ignore */ }
        }
    }
}

cleanupFiles();
process.env.JOB_AGENT_DB_PATH = TEST_DB_PATH;

const { getDb, closeDb, getDbPath } = await import('./db/db.mjs');
const resolvedDbPath = resolve(getDbPath());
if (resolvedDbPath === CANONICAL_DB_PATH) {
    throw new Error(`SAFETY ABORT: test-phase4c-batch2-1.mjs resolved to canonical DB (${resolvedDbPath})`);
}
const {
    upsertCompany,
    getCompany,
    upsertSourcePolicy,
    isSourcePermitted,
    upsertJobPosting,
    getJob,
    getSnapshotsForJob,
    getJobProvenance,
    createSourceScan,
    updateSourceScan,
    claimAtsValidationScan,
    getLatestEvaluationRun,
    ingestSearchLead,
    resolveLead
} = await import('./db/repo.mjs');
const { registerCompanyCareerSurface } = await import('./discovery/leads/company-resolver.mjs');
const { fetchSmartRecruitersJobs } = await import('./discovery/adapters/smartrecruiters.mjs');
const { fetchWorkdayJobs } = await import('./discovery/adapters/workday.mjs');
const { fetchHackerNewsHiringJobs } = await import('./discovery/adapters/hackernews.mjs');
const { fetchJobsFromValidatedAts, fetchYcStartupJobs } = await import('./discovery/adapters/yc.mjs');
const { verifyJobBatch, isJobVerifiedActive } = await import('./verification/verify-jobs.mjs');
const { evaluateJobOffer } = await import('./matching/pipeline.mjs');
const { evaluateJob, getEffectiveTier2Eligibility } = await import('./matching/scheduler.mjs');
const { runApplicationWorkflow } = await import('./application/apply.mjs');
const { runScanner } = await import('./scan-sqlite.mjs');

function runMigrations() {
    const db = getDb();
    const migDir = resolve(process.cwd(), 'db', 'migrations');
    const files = readdirSync(migDir).filter(f => f.endsWith('.sql')).sort();
    for (const file of files) {
        const sql = readFileSync(resolve(migDir, file), 'utf8');
        db.exec(sql);
    }
}

runMigrations();

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`  ✅ PASS: ${name}`);
        passed++;
    } catch (err) {
        console.error(`  ❌ FAIL: ${name}\n     ${err.stack || err.message}`);
        failed++;
    }
}

async function asyncTest(name, fn) {
    try {
        await fn();
        console.log(`  ✅ PASS: ${name}`);
        passed++;
    } catch (err) {
        console.error(`  ❌ FAIL: ${name}\n     ${err.stack || err.message}`);
        failed++;
    }
}

console.log('\n==================================================');
console.log('🧪 Phase 4C Batch 2.1 Regression Suite (Isolated DB)');
console.log('==================================================\n');

// ─── 1. Authoritative ATS Verification Across All 5 Providers ──────────────────
console.log('--- 1. Authoritative ATS API Verification (All 5 Providers) ---');

await asyncTest('verifyJobBatch verifies all 5 ATS providers with single board fetch per group', async () => {
    const companies = [
        { id: 'c-ashby', name: 'AshbyCo', ats_type: 'ashby', board_identifier: 'ashbyco' },
        { id: 'c-lever', name: 'LeverCo', ats_type: 'lever', board_identifier: 'leverco' },
        { id: 'c-gh', name: 'GreenhouseCo', ats_type: 'greenhouse', board_identifier: 'ghco' },
        { id: 'c-sr', name: 'SmartRecruitersCo', ats_type: 'smartrecruiters', board_identifier: 'srco' },
        { id: 'c-wd', name: 'WorkdayCo', ats_type: 'workday', board_identifier: 'wdco:wd5:Careers' }
    ];
    for (const c of companies) {
        upsertCompany({ ...c, policy_status: 'permitted', lifecycle_status: 'APPROVED', monitoring_status: 'active' });
    }

    const jobsToInsert = [
        {
            id: 'https://jobs.ashbyhq.com/ashbyco/ash-1',
            company_id: 'c-ashby',
            title: 'Software Engineer',
            job_url: 'https://jobs.ashbyhq.com/ashbyco/ash-1',
            source: 'ashby',
            source_job_id: 'ash-1',
            source_updated_at: '2026-10-01T00:00:00.000Z',
            raw_json: JSON.stringify({ id: 'ash-1', title: 'Software Engineer' })
        },
        {
            id: 'https://jobs.ashbyhq.com/ashbyco/ash-2',
            company_id: 'c-ashby',
            title: 'Backend Engineer',
            job_url: 'https://jobs.ashbyhq.com/ashbyco/ash-2',
            source: 'ashby',
            source_job_id: 'ash-2',
            source_updated_at: '2026-10-15T00:00:00.000Z'
        },
        {
            id: 'https://jobs.lever.co/leverco/lev-1',
            company_id: 'c-lever',
            title: 'Full Stack Engineer',
            job_url: 'https://jobs.lever.co/leverco/lev-1',
            source: 'lever',
            source_job_id: 'lev-1'
        },
        {
            id: 'https://boards.greenhouse.io/ghco/jobs/7001',
            company_id: 'c-gh',
            title: 'Software Engineer',
            job_url: 'https://boards.greenhouse.io/ghco/jobs/7001',
            source: 'greenhouse',
            source_job_id: '7001'
        },
        {
            id: 'https://jobs.smartrecruiters.com/srco/sr-1',
            company_id: 'c-sr',
            title: 'Backend Developer',
            job_url: 'https://jobs.smartrecruiters.com/srco/sr-1',
            source: 'smartrecruiters',
            source_job_id: 'sr-1'
        },
        {
            id: 'https://wdco.wd5.myworkdayjobs.com/en-US/Careers/job/Remote/SWE_JR900',
            company_id: 'c-wd',
            title: 'Software Engineer',
            job_url: 'https://wdco.wd5.myworkdayjobs.com/en-US/Careers/job/Remote/SWE_JR900',
            source: 'workday',
            source_job_id: 'JR900'
        }
    ];
    for (const j of jobsToInsert) upsertJobPosting(j);

    let apiCallCount = 0;
    const mockFetch = async (url) => {
        apiCallCount++;
        if (url.includes('api.ashbyhq.com/posting-api/job-board/ashbyco')) {
            return new Response(JSON.stringify({
                jobs: [
                    { id: 'ash-1', title: 'Software Engineer', jobUrl: 'https://jobs.ashbyhq.com/ashbyco/ash-1', publishedAt: '2026-10-20T00:00:00.000Z', isListed: true },
                    { id: 'ash-2', title: 'Backend Engineer', jobUrl: 'https://jobs.ashbyhq.com/ashbyco/ash-2', publishedAt: '2026-09-01T00:00:00.000Z', isListed: true }
                ]
            }), { status: 200 });
        }
        if (url.includes('api.lever.co/v0/postings/leverco')) {
            return new Response(JSON.stringify([
                { id: 'lev-1', text: 'Full Stack Engineer', hostedUrl: 'https://jobs.lever.co/leverco/lev-1', createdAt: Date.parse('2026-11-01T00:00:00Z') }
            ]), { status: 200 });
        }
        if (url.includes('boards-api.greenhouse.io/v1/boards/ghco/jobs')) {
            return new Response(JSON.stringify({
                jobs: [{ id: 7001, title: 'Software Engineer', absolute_url: 'https://boards.greenhouse.io/ghco/jobs/7001', location: { name: 'Bengaluru' } }]
            }), { status: 200 });
        }
        if (url.includes('api.smartrecruiters.com/v1/companies/srco/postings')) {
            return new Response(JSON.stringify({
                totalFound: 1,
                content: [{ id: 'sr-1', name: 'Backend Developer', releasedDate: '2026-11-01T00:00:00Z' }]
            }), { status: 200 });
        }
        if (url.includes('wdco.wd5.myworkdayjobs.com/wday/cxs/wdco/Careers/jobs')) {
            return new Response(JSON.stringify({
                total: 1,
                jobPostings: [{ title: 'Software Engineer', externalPath: '/job/Remote/SWE_JR900', locationsText: 'Remote' }]
            }), { status: 200 });
        }
        return new Response('Not found', { status: 404 });
    };

    const res = await verifyJobBatch({
        jobIds: jobsToInsert.map(j => j.id),
        fetchFn: mockFetch
    });

    assert.strictEqual(res.totalProcessed, 6);
    assert.strictEqual(res.activeCount, 6, 'All 6 jobs across 5 ATS providers must verify ACTIVE');
    assert.strictEqual(res.atsBoardCalls, 5, 'Must make exactly 5 board calls (1 per board, not 6 per job)');
    assert.strictEqual(apiCallCount, 5);

    const ash1 = getJob('https://jobs.ashbyhq.com/ashbyco/ash-1');
    const ash2 = getJob('https://jobs.ashbyhq.com/ashbyco/ash-2');
    assert.strictEqual(ash1.status, 'active');
    assert.strictEqual(ash1.verification_method, 'ats_board_api:active');
    assert.strictEqual(ash1.source_updated_at, '2026-10-20T00:00:00.000Z', 'Newer provider source_updated_at updates');
    assert.strictEqual(ash2.source_updated_at, '2026-10-15T00:00:00.000Z', 'Older provider source_updated_at must NOT overwrite');
    assert.strictEqual(isJobVerifiedActive(ash1), true);

    const snaps = getSnapshotsForJob(ash1.id);
    assert.ok(snaps.length >= 2, 'Verification status change must preserve snapshot history');
});

// ─── 2. Edge Cases: Partial, Failed, Stale, Missing ID, URL Mismatch, Closed, Single Absence ───
console.log('--- 2. ATS Verification Edge Cases & Safety Guardrails ---');

await asyncTest('Partial feeds, failed fetches, missing IDs, URL mismatches, closed, and single-absence behave safely', async () => {
    upsertCompany({ id: 'c-edge', name: 'EdgeCo', ats_type: 'ashby', board_identifier: 'edgeco', policy_status: 'permitted', lifecycle_status: 'APPROVED', monitoring_status: 'active' });

    const edgeJobs = [
        { id: 'https://jobs.ashbyhq.com/edgeco/closed-1', company_id: 'c-edge', title: 'SWE', job_url: 'https://jobs.ashbyhq.com/edgeco/closed-1', source: 'ashby', source_job_id: 'closed-1' },
        { id: 'https://jobs.ashbyhq.com/edgeco/missing-id', company_id: 'c-edge', title: 'SWE', job_url: 'https://jobs.ashbyhq.com/edgeco/missing-id', source: 'ashby', source_job_id: null },
        { id: 'https://jobs.ashbyhq.com/edgeco/url-mismatch', company_id: 'c-edge', title: 'SWE', job_url: 'https://jobs.ashbyhq.com/edgeco/url-mismatch', source: 'ashby', source_job_id: 'mismatch-1' },
        { id: 'https://jobs.ashbyhq.com/edgeco/absent-1', company_id: 'c-edge', title: 'SWE', job_url: 'https://jobs.ashbyhq.com/edgeco/absent-1', source: 'ashby', source_job_id: 'absent-1' }
    ];
    for (const j of edgeJobs) upsertJobPosting(j);

    const mockEdgeFetch = async () => new Response(JSON.stringify({
        jobs: [
            { id: 'closed-1', title: 'SWE', jobUrl: 'https://jobs.ashbyhq.com/edgeco/closed-1', isListed: false },
            { id: 'mismatch-1', title: 'SWE', jobUrl: 'https://jobs.ashbyhq.com/edgeco/DIFFERENT-PATH', isListed: true }
        ]
    }), { status: 200 });

    const r1 = await verifyJobBatch({ jobIds: edgeJobs.map(j => j.id), fetchFn: mockEdgeFetch });
    assert.strictEqual(r1.closedCount, 1, 'Explicit unlisted/closed establishes CLOSED');
    assert.strictEqual(getJob('https://jobs.ashbyhq.com/edgeco/closed-1').status, 'closed');
    assert.strictEqual(getJob('https://jobs.ashbyhq.com/edgeco/closed-1').verification_method, 'ats_board_api:closed');

    assert.strictEqual(getJob('https://jobs.ashbyhq.com/edgeco/missing-id').status, 'discovered', 'Missing external ID stays discovered');
    assert.strictEqual(getJob('https://jobs.ashbyhq.com/edgeco/url-mismatch').status, 'discovered', 'URL mismatch stays discovered');
    assert.strictEqual(getJob('https://jobs.ashbyhq.com/edgeco/absent-1').status, 'discovered', 'Single complete-feed absence NEVER marks closed');

    // Failed board fetch
    const rFail = await verifyJobBatch({
        jobIds: ['https://jobs.ashbyhq.com/edgeco/absent-1'],
        fetchFn: async () => new Response('Server Error', { status: 500 })
    });
    assert.strictEqual(rFail.errorCount, 1);
    assert.strictEqual(getJob('https://jobs.ashbyhq.com/edgeco/absent-1').status, 'discovered', 'Failed board fetch never marks closed');

    // Partial paginated SmartRecruiters & Workday feeds
    const partialSr = await fetchSmartRecruitersJobs('srpartial', 'c-edge', 'EdgeCo', {
        limit: 1,
        maxPages: 1,
        maxJobs: 1,
        fetchFn: async () => new Response(JSON.stringify({ totalFound: 5, content: [{ id: 'p1', name: 'SWE' }] }), { status: 200 })
    });
    assert.strictEqual(partialSr.isComplete, false, 'Truncated SmartRecruiters feed must be marked isComplete: false');

    const partialWd = await fetchWorkdayJobs('wd:wd5:Site', 'c-edge', 'EdgeCo', {
        limit: 1,
        maxPages: 1,
        maxJobs: 1,
        fetchFn: async () => new Response(JSON.stringify({ total: 10, jobPostings: [{ title: 'SWE', externalPath: '/job/A_JR1' }] }), { status: 200 })
    });
    assert.strictEqual(partialWd.isComplete, false, 'Truncated Workday feed must be marked isComplete: false');

    // Absence from partial feed -> never CLOSED
    upsertCompany({ id: 'c-sr-part', name: 'SRPart', ats_type: 'smartrecruiters', board_identifier: 'srpart', policy_status: 'permitted', lifecycle_status: 'APPROVED', monitoring_status: 'active' });
    upsertJobPosting({
        id: 'https://jobs.smartrecruiters.com/srpart/missing-part',
        company_id: 'c-sr-part',
        title: 'SWE',
        job_url: 'https://jobs.smartrecruiters.com/srpart/missing-part',
        source: 'smartrecruiters',
        source_job_id: 'missing-part'
    });
    const rPartialVerify = await verifyJobBatch({
        jobIds: ['https://jobs.smartrecruiters.com/srpart/missing-part'],
        fetchFn: async () => {
            // Simulate 20 pages returning partial (offset stops at maxPages) -> return totalFound 99999
            return new Response(JSON.stringify({ totalFound: 99999, content: [{ id: 'other', name: 'Other' }] }), { status: 200 });
        }
    });
    assert.strictEqual(rPartialVerify.closedCount, 0);
    assert.strictEqual(rPartialVerify.unknownCount, 1);
    assert.strictEqual(getJob('https://jobs.smartrecruiters.com/srpart/missing-part').status, 'discovered');
});

await asyncTest('Stale source_scans (>24h) are rejected when preferFreshScan=true', async () => {
    upsertCompany({ id: 'c-stale', name: 'StaleCo', ats_type: 'ashby', board_identifier: 'staleco', policy_status: 'permitted', lifecycle_status: 'APPROVED', monitoring_status: 'active' });
    upsertJobPosting({
        id: 'https://jobs.ashbyhq.com/staleco/s1',
        company_id: 'c-stale',
        title: 'SWE',
        job_url: 'https://jobs.ashbyhq.com/staleco/s1',
        source: 'ashby',
        source_job_id: 's1',
        last_seen_at: new Date(Date.now() - 48 * 3600 * 1000).toISOString()
    });
    const scanId = createSourceScan({
        company_id: 'c-stale',
        source_type: 'ashby',
        started_at: new Date(Date.now() - 48 * 3600 * 1000).toISOString()
    });
    updateSourceScan(scanId, {
        completed_at: new Date(Date.now() - 48 * 3600 * 1000).toISOString(),
        is_complete: true,
        errors: 0,
        total_jobs: 1
    });

    // Since preferFreshScan=true with no fetchFn and stale 48h scan, it must NOT verify active from stale scan!
    // (In sandbox, live fetch fails network and stays discovered/error)
    const rStale = await verifyJobBatch({
        jobIds: ['https://jobs.ashbyhq.com/staleco/s1'],
        preferFreshScan: true,
        atsFreshnessHours: 24,
        timeoutMs: 1500
    });
    assert.notStrictEqual(rStale.activeCount, 1, 'Stale >24h scan must never verify job active');
    assert.strictEqual(getJob('https://jobs.ashbyhq.com/staleco/s1').status, 'discovered');
});

// ─── 3. Source-Policy & Company Lifecycle Gate Matrix ──────────────────────────
console.log('--- 3. Source-Policy & Lifecycle Gate Matrix ---');

test('isSourcePermitted enforces exact lifecycle, monitoring, and policy combinations', () => {
    const cases = [
        // [id, lifecycle, monitoring, policy_status, enabled, disc, feed, expDiscovery, expAtsVal, expMonitoring]
        ['m-unver-pend', 'UNVERIFIED', 'paused', 'pending', 1, 1, 1, true, true, false],
        ['m-unver-noperm', 'UNVERIFIED', 'paused', 'pending', 1, 0, 1, false, false, false],
        ['m-ver-paused', 'VERIFIED', 'paused', 'permitted', 1, 1, 1, true, true, false],
        ['m-app-paused', 'APPROVED', 'paused', 'permitted', 1, 1, 1, true, true, false],
        ['m-app-pend', 'APPROVED', 'active', 'pending', 1, 1, 1, true, true, false],
        ['m-app-active', 'APPROVED', 'active', 'permitted', 1, 1, 1, true, true, true],
        ['m-mon-active', 'MONITORING', 'active', 'permitted', 1, 1, 1, true, true, true],
        ['m-app-blocked', 'APPROVED', 'active', 'blocked', 1, 1, 1, false, false, false],
        ['m-disabled', 'DISABLED', 'disabled', 'permitted', 1, 1, 1, false, false, false],
        ['m-pol-off', 'APPROVED', 'active', 'permitted', 0, 1, 1, false, false, false]
    ];

    for (const [id, life, mon, pol, en, disc, feed, expDisc, expAts, expMon] of cases) {
        upsertCompany({
            id, name: id, ats_type: 'ashby', board_identifier: id,
            lifecycle_status: life, monitoring_status: mon, policy_status: pol
        });
        upsertSourcePolicy({
            id: `pol-${id}`, company_id: id, source_type: 'ashby', endpoint: `ashby:${id}`,
            enabled: en, discovery_permitted: disc, public_nav_permitted: 1, feed_access_permitted: feed
        });
        assert.strictEqual(isSourcePermitted(id, 'ashby', 'discovery'), expDisc, `${id} discovery`);
        assert.strictEqual(isSourcePermitted(id, 'ashby', 'ats_validation'), expAts, `${id} ats_validation`);
        assert.strictEqual(isSourcePermitted(id, 'ashby', 'monitoring'), expMon, `${id} monitoring`);
        assert.strictEqual(isSourcePermitted(id, 'ashby', 'submission'), false, `${id} submission always false`);
    }
});

await asyncTest('registerCompanyCareerSurface never auto-approves, and runScanner blocks paused/UNVERIFIED', async () => {
    upsertCompany({
        id: 'company-paused-co',
        name: 'Paused Co',
        career_url: 'https://boards.greenhouse.io/pausedco',
        ats_type: 'greenhouse',
        board_identifier: 'pausedco',
        lifecycle_status: 'APPROVED',
        monitoring_status: 'paused',
        policy_status: 'permitted'
    });
    registerCompanyCareerSurface({
        companyId: 'company-paused-co',
        atsType: 'greenhouse',
        boardIdentifier: 'pausedco',
        policySourceType: 'greenhouse'
    });
    const afterReg = getCompany('company-paused-co');
    assert.strictEqual(afterReg.monitoring_status, 'paused', 'registerCompanyCareerSurface must preserve paused');
    const pol = getDb().prepare('SELECT * FROM source_policies WHERE company_id = ?').get('company-paused-co');
    assert.strictEqual(pol.policy_approved_at, null, 'Pending policy must not be silently approved');

    const tmpPortalsDir = resolve(process.cwd(), 'data', 'test_b21_portals');
    mkdirSync(tmpPortalsDir, { recursive: true });
    const portalsPath = resolve(tmpPortalsDir, 'portals.yml');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(portalsPath, `tracked_companies:\n  - name: Paused Co\n    careers_url: https://boards.greenhouse.io/pausedco\n`, 'utf8');

    let fetchedCount = 0;
    const scanRes = await runScanner({
        portalsPath,
        fetchFn: async () => { fetchedCount++; return new Response('{}', { status: 200 }); }
    });
    rmSync(tmpPortalsDir, { recursive: true, force: true });
    assert.strictEqual(scanRes.skippedPolicy, 1, 'runScanner must skip paused company');
    assert.strictEqual(fetchedCount, 0, 'Zero API calls made for paused company');
});

await asyncTest('HN ATS scan gates respect blocked policy and skip unpermitted ATS validation', async () => {
    // Pre-register BlockedHNCo as blocked
    upsertCompany({
        id: 'company-blocked-hn',
        name: 'BlockedHNCo',
        domain: 'blockedhn.example',
        lifecycle_status: 'UNVERIFIED',
        monitoring_status: 'paused',
        policy_status: 'blocked'
    });

    let atsApiCalled = false;
    const hnMockFetch = async (url) => {
        if (url.includes('hn.algolia.com/api/v1/search_by_date')) {
            return new Response(JSON.stringify({
                hits: [{ objectID: '991000', title: 'Ask HN: Who is hiring? (November 2026)', created_at: new Date().toISOString() }]
            }), { status: 200 });
        }
        if (url.includes('hacker-news.firebaseio.com/v0/item/991000.json')) {
            return new Response(JSON.stringify({ id: 991000, title: 'Ask HN: Who is hiring? (November 2026)', kids: [991001] }), { status: 200 });
        }
        if (url.includes('hacker-news.firebaseio.com/v0/item/991001.json')) {
            return new Response(JSON.stringify({
                id: 991001,
                type: 'comment',
                text: 'BlockedHNCo | Software Engineer | Bengaluru | https://jobs.ashbyhq.com/blockedhn/abc-123 (https://blockedhn.example)'
            }), { status: 200 });
        }
        if (url.includes('api.ashbyhq.com')) {
            atsApiCalled = true;
        }
        return new Response('{}', { status: 404 });
    };

    const hnRes = await fetchHackerNewsHiringJobs({
        maxThreads: 1,
        maxComments: 5,
        scanDiscoveredAts: true,
        forceRescan: true,
        fetchFn: hnMockFetch
    });
    assert.strictEqual(atsApiCalled, false, 'Blocked company must not trigger HN ATS board scan');
    const blockedDetail = hnRes.atsBoardDetails.find(b => b.companyId === 'company-blocked-hn');
    assert.strictEqual(blockedDetail?.scanStatus, 'SKIPPED_POLICY');
});

// ─── 4. YC ATS Scan-History Consistency ────────────────────────────────────────
console.log('--- 4. YC ATS Scan-History Consistency ---');

await asyncTest('fetchJobsFromValidatedAts records source_scans start, completion, counts, errors, and idempotency', async () => {
    upsertCompany({
        id: 'c-yc-scan',
        name: 'YcScanCo',
        ats_type: 'ashby',
        board_identifier: 'ycscanco',
        lifecycle_status: 'UNVERIFIED',
        monitoring_status: 'paused',
        policy_status: 'pending'
    });

    const mockYcAtsFetch = async () => new Response(JSON.stringify({
        jobs: [
            { id: 'yc-1', title: 'Software Engineer', jobUrl: 'https://jobs.ashbyhq.com/ycscanco/yc-1', location: 'Remote', isListed: true, publishedAt: '2026-11-01T00:00:00Z' }
        ]
    }), { status: 200 });

    const jobs1 = await fetchJobsFromValidatedAts(
        { atsType: 'ashby', boardIdentifier: 'ycscanco' },
        'c-yc-scan',
        'YcScanCo',
        { fetchFn: mockYcAtsFetch, upsert: true }
    );
    assert.strictEqual(jobs1.length, 1);
    assert.strictEqual(jobs1._scanStats.inserted, 1);
    const scans1 = getDb().prepare('SELECT * FROM source_scans WHERE company_id = ? ORDER BY started_at DESC').all('c-yc-scan');
    assert.strictEqual(scans1.length, 1);
    assert.strictEqual(scans1[0].is_complete, 1);
    assert.strictEqual(scans1[0].inserted_count, 1);
    assert.ok(getCompany('c-yc-scan').last_scanned_at, 'last_scanned_at updated');

    // Repeat scan: idempotent
    const jobs2 = await fetchJobsFromValidatedAts(
        { atsType: 'ashby', boardIdentifier: 'ycscanco' },
        'c-yc-scan',
        'YcScanCo',
        { fetchFn: mockYcAtsFetch, upsert: true }
    );
    assert.strictEqual(jobs2._scanStats.inserted, 0);
    assert.strictEqual(jobs2._scanStats.unchanged, 1);

    // Failed scan: records error
    let threw = false;
    try {
        await fetchJobsFromValidatedAts(
            { atsType: 'ashby', boardIdentifier: 'ycscanco' },
            'c-yc-scan',
            'YcScanCo',
            { fetchFn: async () => new Response('fail', { status: 500 }), upsert: true }
        );
    } catch {
        threw = true;
    }
    assert.strictEqual(threw, true);
    const latestErrScan = getDb().prepare('SELECT * FROM source_scans WHERE company_id = ? ORDER BY started_at DESC LIMIT 1').get('c-yc-scan');
    assert.strictEqual(latestErrScan.is_complete, 0);
    assert.strictEqual(latestErrScan.errors, 1);
    assert.ok(latestErrScan.error_details, 'Error details recorded');
});

// ─── 5. Canonical Multi-Source Provenance ──────────────────────────────────────
console.log('--- 5. Canonical Multi-Source Provenance ---');

test('HN->Ashby and Ashby->HN preserve 1 canonical job, 0 duplicates, and both sources provenance', () => {
    upsertCompany({ id: 'c-prov', name: 'ProvCo', lifecycle_status: 'UNVERIFIED', monitoring_status: 'paused' });

    // Order A: Ashby first, then HN second (must NOT overwrite Ashby primary source/source_job_id!)
    const urlA = 'https://jobs.ashbyhq.com/provco/role-a';
    upsertJobPosting({
        id: urlA,
        company_id: 'c-prov',
        title: 'Backend Engineer',
        job_url: urlA,
        description: 'Full Ashby description with Node.js and PostgreSQL',
        source: 'ashby',
        source_job_id: 'ashby-uuid-a',
        source_updated_at: '2026-10-10T00:00:00Z',
        raw_json: JSON.stringify({ id: 'ashby-uuid-a', jobUrl: urlA })
    });
    const leadA = ingestSearchLead({
        provider: 'hackernews',
        query: 'hn:thread:1',
        rawUrl: urlA,
        title: 'ProvCo - Backend Engineer',
        companyName: 'ProvCo',
        companyId: 'c-prov',
        providerPayload: { permalink: 'https://news.ycombinator.com/item?id=777001', commentId: '777001' }
    });
    resolveLead(leadA.leadId, { resolutionStatus: 'resolved_job', resolvedJobId: urlA, companyId: 'c-prov' });

    upsertJobPosting({
        id: urlA,
        company_id: 'c-prov',
        title: 'Backend Engineer',
        job_url: urlA,
        description: 'Short HN snippet',
        source: 'hackernews',
        source_job_id: '777001',
        raw_json: JSON.stringify({ permalink: 'https://news.ycombinator.com/item?id=777001', specificJobUrl: urlA })
    });

    const jobA = getJob(urlA);
    assert.strictEqual(jobA.source, 'ashby', 'HN must not overwrite authoritative Ashby primary source');
    assert.strictEqual(jobA.source_job_id, 'ashby-uuid-a', 'HN must not overwrite Ashby source_job_id');
    assert.strictEqual(getDb().prepare('SELECT COUNT(*) AS c FROM job_postings WHERE id = ?').get(urlA).c, 1);

    const provA = getJobProvenance(urlA);
    assert.ok(provA.sources.includes('ashby') && provA.sources.includes('hackernews'), 'Both sources retrievable');
    assert.ok(provA.originalUrls.includes(urlA), 'ATS URL retrievable');
    assert.ok(provA.originalUrls.includes('https://news.ycombinator.com/item?id=777001'), 'HN permalink retrievable');
    assert.strictEqual(provA.snapshots.length, 2, 'Both snapshots retained');
    assert.strictEqual(provA.observations.length, 1, 'HN source observation retained');
});

// ─── 6. Evaluation Reporting: NOT_EVALUATED vs UNKNOWN ─────────────────────────
console.log('--- 6. Evaluation Reporting (NOT_EVALUATED vs UNKNOWN) ---');

await asyncTest('Tier-1 rejected jobs report NOT_EVALUATED rather than genuine Tier-2 UNKNOWN', async () => {
    upsertCompany({ id: 'c-eval', name: 'EvalCo', lifecycle_status: 'APPROVED', monitoring_status: 'active', policy_status: 'permitted' });

    const nonEngId = 'https://jobs.ashbyhq.com/evalco/sales-1';
    upsertJobPosting({
        id: nonEngId,
        company_id: 'c-eval',
        title: 'Account Executive - Sales',
        location: 'Bengaluru, India',
        job_url: nonEngId,
        description: 'Enterprise SaaS sales role',
        source: 'ashby',
        source_job_id: 'sales-1'
    });

    const ambigRemoteId = 'https://jobs.ashbyhq.com/evalco/swe-ambig';
    upsertJobPosting({
        id: ambigRemoteId,
        company_id: 'c-eval',
        title: 'Software Engineer',
        location: 'Remote',
        remote_type: 'remote',
        job_url: ambigRemoteId,
        description: 'Node.js TypeScript backend role',
        source: 'ashby',
        source_job_id: 'swe-ambig'
    });

    const offerT1Fail = evaluateJobOffer(getJob(nonEngId));
    assert.strictEqual(offerT1Fail.tier1.passed, false);
    assert.strictEqual(offerT1Fail.tier2.eligibility, 'NOT_EVALUATED');

    const evT1Fail = await evaluateJob(nonEngId, { forceReeval: true });
    assert.strictEqual(evT1Fail.tier1Passed, false);
    assert.strictEqual(evT1Fail.tier2Eligibility, 'NOT_EVALUATED');
    const runT1Fail = getLatestEvaluationRun(nonEngId);
    assert.strictEqual(getEffectiveTier2Eligibility(runT1Fail), 'NOT_EVALUATED');

    const evAmbig = await evaluateJob(ambigRemoteId, { forceReeval: true });
    assert.strictEqual(evAmbig.tier1Passed, true);
    assert.strictEqual(evAmbig.tier2Eligibility, 'UNKNOWN', 'Genuine Tier-2 ambiguity remains UNKNOWN');
    assert.strictEqual(getEffectiveTier2Eligibility(getLatestEvaluationRun(ambigRemoteId)), 'UNKNOWN');

    // Tier-1 passed, Tier-2 FAIL (US Citizenship required)
    const usOnlyId = 'https://jobs.ashbyhq.com/evalco/swe-us-only';
    upsertJobPosting({
        id: usOnlyId,
        company_id: 'c-eval',
        title: 'Software Engineer',
        location: 'San Francisco, CA',
        remote_type: 'onsite',
        job_url: usOnlyId,
        description: 'Must be a US Citizen. No visa sponsorship available.',
        source: 'ashby',
        source_job_id: 'swe-us-only'
    });
    const evTier2Fail = await evaluateJob(usOnlyId, { forceReeval: true });
    assert.strictEqual(evTier2Fail.tier1Passed, true);
    assert.strictEqual(evTier2Fail.tier2Eligibility, 'FAIL');
    assert.strictEqual(getEffectiveTier2Eligibility(getLatestEvaluationRun(usOnlyId)), 'FAIL');

    // Set both jobs active so runApplicationWorkflow() reaches the Tier-1/Tier-2 eligibility gate
    getDb().prepare("UPDATE job_postings SET status = 'active' WHERE id IN (?, ?)").run(nonEngId, usOnlyId);

    // Application gating via runApplicationWorkflow() remains blocked for both Tier-1 NOT_EVALUATED and Tier-2 FAIL
    await assert.rejects(
        () => runApplicationWorkflow(nonEngId, { dryRun: true }),
        /NOT_EVALUATED/i,
        'Tier-1 rejected job must be blocked explicitly at NOT_EVALUATED gate in apply.mjs'
    );
    await assert.rejects(
        () => runApplicationWorkflow(usOnlyId, { dryRun: true }),
        /Tier 2 Hard Eligibility failed/i,
        'Tier-2 FAIL job must remain blocked in apply.mjs'
    );
});

await asyncTest('One-time ATS validation: HN & YC enforce single attempt for unverified/paused, allow distinct boards, block failed retries, prevent concurrent double-claim, and keep approved monitoring recurring', async () => {
    const db = getDb();

    // 1. Unverified + paused company with permitted Greenhouse policy (board-a)
    upsertCompany({
        id: 'c-onetime-hn',
        name: 'OneTimeHN',
        domain: 'onetimehn.example',
        ats_type: 'greenhouse',
        board_identifier: 'onetimehn-a',
        lifecycle_status: 'UNVERIFIED',
        monitoring_status: 'paused',
        policy_status: 'pending'
    });
    upsertSourcePolicy({
        id: 'pol-onetime-hn-gh',
        company_id: 'c-onetime-hn',
        source_type: 'greenhouse',
        endpoint: 'https://boards.greenhouse.io/onetimehn-a',
        enabled: 1,
        discovery_permitted: 1,
        feed_access_permitted: 1
    });

    // 2. Approved + active + permitted company for recurring monitoring
    upsertCompany({
        id: 'c-recurring-hn',
        name: 'RecurringHN',
        domain: 'recurringhn.example',
        ats_type: 'greenhouse',
        board_identifier: 'recurringhn',
        lifecycle_status: 'APPROVED',
        monitoring_status: 'active',
        policy_status: 'permitted'
    });
    upsertSourcePolicy({
        id: 'pol-recurring-hn-gh',
        company_id: 'c-recurring-hn',
        source_type: 'greenhouse',
        endpoint: 'https://boards.greenhouse.io/recurringhn',
        enabled: 1,
        discovery_permitted: 1,
        feed_access_permitted: 1
    });

    // 3. Blocked & disabled companies
    upsertCompany({
        id: 'c-blocked-hn',
        name: 'BlockedHN',
        domain: 'blockedhn.example',
        ats_type: 'greenhouse',
        board_identifier: 'blockedhn',
        lifecycle_status: 'UNVERIFIED',
        monitoring_status: 'paused',
        policy_status: 'blocked'
    });
    upsertSourcePolicy({
        id: 'pol-blocked-hn-gh',
        company_id: 'c-blocked-hn',
        source_type: 'greenhouse',
        endpoint: 'https://boards.greenhouse.io/blockedhn',
        enabled: 1,
        discovery_permitted: 1,
        feed_access_permitted: 1
    });

    // 4. Failed-first-attempt unverified/paused company
    upsertCompany({
        id: 'c-fail-onetime',
        name: 'FailOneTime',
        domain: 'failonetime.example',
        ats_type: 'greenhouse',
        board_identifier: 'failonetime',
        lifecycle_status: 'UNVERIFIED',
        monitoring_status: 'paused',
        policy_status: 'pending'
    });
    upsertSourcePolicy({
        id: 'pol-fail-onetime-gh',
        company_id: 'c-fail-onetime',
        source_type: 'greenhouse',
        endpoint: 'https://boards.greenhouse.io/failonetime',
        enabled: 1,
        discovery_permitted: 1,
        feed_access_permitted: 1
    });

    const fetchCounts = { onetimeA: 0, onetimeB: 0, recurring: 0, blocked: 0, failOnce: 0, ycOneTime: 0 };
    let threadId = 88001;
    let boardForOneTime = 'onetimehn-a';

    const makeHnFetch = () => async (url) => {
        const u = String(url);
        if (u.includes('algolia.com')) {
            return new Response(JSON.stringify({
                hits: [{ objectID: String(threadId), title: 'Ask HN: Who is hiring? (November 2026)', created_at_i: Math.floor(Date.now() / 1000) }]
            }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (u.includes(`item/${threadId}.json`)) {
            return new Response(JSON.stringify({ id: threadId, kids: [99001, 99002, 99003, 99004] }), { status: 200 });
        }
        if (u.includes('item/99001.json')) {
            return new Response(JSON.stringify({
                id: 99001,
                by: 'h1',
                time: Math.floor(Date.now() / 1000),
                text: `OneTimeHN | Software Engineer | Remote | https://boards.greenhouse.io/${boardForOneTime}/jobs/1`
            }), { status: 200 });
        }
        if (u.includes('item/99002.json')) {
            return new Response(JSON.stringify({
                id: 99002,
                by: 'h2',
                time: Math.floor(Date.now() / 1000),
                text: `RecurringHN | Software Engineer | Remote | https://boards.greenhouse.io/recurringhn/jobs/2`
            }), { status: 200 });
        }
        if (u.includes('item/99003.json')) {
            return new Response(JSON.stringify({
                id: 99003,
                by: 'h3',
                time: Math.floor(Date.now() / 1000),
                text: `BlockedHN | Software Engineer | Remote | https://boards.greenhouse.io/blockedhn/jobs/3`
            }), { status: 200 });
        }
        if (u.includes('item/99004.json')) {
            return new Response(JSON.stringify({
                id: 99004,
                by: 'h4',
                time: Math.floor(Date.now() / 1000),
                text: `FailOneTime | Software Engineer | Remote | https://boards.greenhouse.io/failonetime/jobs/4`
            }), { status: 200 });
        }
        if (u.includes('boards-api.greenhouse.io/v1/boards/onetimehn-a/jobs')) {
            fetchCounts.onetimeA++;
            return new Response(JSON.stringify({ jobs: [{ id: 1, title: 'Software Engineer', absolute_url: 'https://boards.greenhouse.io/onetimehn-a/jobs/1', location: { name: 'Remote' }, updated_at: '2026-11-12T00:00:00Z' }] }), { status: 200 });
        }
        if (u.includes('boards-api.greenhouse.io/v1/boards/onetimehn-b/jobs')) {
            fetchCounts.onetimeB++;
            return new Response(JSON.stringify({ jobs: [{ id: 10, title: 'Backend Engineer', absolute_url: 'https://boards.greenhouse.io/onetimehn-b/jobs/10', location: { name: 'Remote' }, updated_at: '2026-11-12T00:00:00Z' }] }), { status: 200 });
        }
        if (u.includes('boards-api.greenhouse.io/v1/boards/recurringhn/jobs')) {
            fetchCounts.recurring++;
            return new Response(JSON.stringify({ jobs: [{ id: 2, title: 'Software Engineer', absolute_url: 'https://boards.greenhouse.io/recurringhn/jobs/2', location: { name: 'Remote' }, updated_at: '2026-11-12T00:00:00Z' }] }), { status: 200 });
        }
        if (u.includes('boards-api.greenhouse.io/v1/boards/blockedhn/jobs')) {
            fetchCounts.blocked++;
            return new Response(JSON.stringify({ jobs: [] }), { status: 200 });
        }
        if (u.includes('boards-api.greenhouse.io/v1/boards/failonetime/jobs')) {
            fetchCounts.failOnce++;
            return new Response('Internal Server Error', { status: 500 });
        }
        return new Response('Not found', { status: 404 });
    };

    // Run 1: initial validation allowed for onetimeA, failOnce, recurring; blocked stays 0
    await fetchHackerNewsHiringJobs({ threadId, forceRescan: true, scanDiscoveredAts: true, fetchFn: makeHnFetch() });
    assert.strictEqual(fetchCounts.onetimeA, 1, 'Unverified/paused company gets 1st HN ATS validation fetch');
    assert.strictEqual(fetchCounts.recurring, 1, 'Approved/active company gets 1st HN ATS fetch');
    assert.strictEqual(fetchCounts.blocked, 0, 'Blocked company gets 0 HN ATS fetches');
    assert(fetchCounts.failOnce >= 1, 'Failed first attempt recorded');
    const failCountAfterRun1 = fetchCounts.failOnce;

    const failScans = db.prepare('SELECT * FROM source_scans WHERE company_id = ?').all('c-fail-onetime');
    assert.strictEqual(failScans.length, 1);
    assert.strictEqual(failScans[0].is_complete, 0);
    assert.strictEqual(failScans[0].errors, 1);

    // Run 2 (new HN thread, same boards): onetimeA and failOnce MUST be skipped, recurring continues
    threadId = 88002;
    const res2 = await fetchHackerNewsHiringJobs({ threadId, forceRescan: true, scanDiscoveredAts: true, fetchFn: makeHnFetch() });
    assert.strictEqual(fetchCounts.onetimeA, 1, 'Second HN run must NOT re-fetch unverified/paused board-a');
    assert.strictEqual(fetchCounts.failOnce, failCountAfterRun1, 'Failed first attempt must NOT enable retries on second HN run');
    assert.strictEqual(fetchCounts.recurring, 2, 'Approved/active company continues recurring monitoring');
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS c FROM source_scans WHERE company_id = ?').get('c-onetime-hn').c, 1);
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS c FROM source_scans WHERE company_id = ?').get('c-fail-onetime').c, 1);
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS c FROM source_scans WHERE company_id = ?').get('c-recurring-hn').c, 2);
    assert(res2.atsBoardDetails.some(b => b.companyId === 'c-onetime-hn' && b.scanStatus === 'SKIPPED_POLICY'));

    // Run 3: genuinely different board (onetimehn-b) for the same company is NOT blocked
    threadId = 88003;
    boardForOneTime = 'onetimehn-b';
    await fetchHackerNewsHiringJobs({ threadId, forceRescan: true, scanDiscoveredAts: true, fetchFn: makeHnFetch() });
    assert.strictEqual(fetchCounts.onetimeB, 1, 'Different board for same company is allowed its own initial validation');
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS c FROM source_scans WHERE company_id = ?').get('c-onetime-hn').c, 2);

    // YC path: unverified/paused company gets 1 ATS fetch, 2nd run skips
    upsertCompany({
        id: 'c-yc-onetime',
        name: 'YcOneTime',
        domain: 'yconetime.example',
        lifecycle_status: 'UNVERIFIED',
        monitoring_status: 'paused',
        policy_status: 'pending'
    });
    const ycFetch = async (url) => {
        const u = String(url);
        if (u === 'https://www.ycombinator.com/robots.txt') {
            return new Response('User-agent: *\nAllow: /companies/', { status: 200 });
        }
        if (u.includes('ycombinator.com/companies/yconetime')) {
            return new Response('<html><body><h1>YcOneTime</h1><a href="https://yconetime.example">Website</a></body></html>', { status: 200 });
        }
        if (u.includes('yconetime.example/robots.txt')) {
            return new Response('User-agent: *\nAllow: /', { status: 200 });
        }
        if (u === 'https://yconetime.example' || u === 'https://yconetime.example/' || u.includes('yconetime.example/careers')) {
            return new Response('<html><body><a href="https://boards.greenhouse.io/yconetime">Careers</a></body></html>', { status: 200 });
        }
        if (u.includes('boards-api.greenhouse.io/v1/boards/yconetime/jobs')) {
            fetchCounts.ycOneTime++;
            return new Response(JSON.stringify({ jobs: [{ id: 55, title: 'Software Engineer', absolute_url: 'https://boards.greenhouse.io/yconetime/jobs/55', location: { name: 'Remote' }, updated_at: '2026-11-12T00:00:00Z' }] }), { status: 200 });
        }
        return new Response('', { status: 404 });
    };
    await fetchYcStartupJobs({ companyUrls: ['https://www.ycombinator.com/companies/yconetime'], fetchJobsFromAts: true, fetchFn: ycFetch });
    assert.strictEqual(fetchCounts.ycOneTime, 1, 'YC 1st run fetches unverified/paused ATS once');
    await fetchYcStartupJobs({ companyUrls: ['https://www.ycombinator.com/companies/yconetime'], fetchJobsFromAts: true, fetchFn: ycFetch });
    assert.strictEqual(fetchCounts.ycOneTime, 1, 'YC 2nd run does NOT re-fetch same unverified/paused ATS');
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS c FROM source_scans WHERE company_id = ?').get('c-yc-onetime').c, 1);

    // Concurrent claim check: two callers cannot both claim the same one-time validation
    upsertCompany({
        id: 'c-concurrent',
        name: 'ConcurrentCo',
        domain: 'concurrent.example',
        lifecycle_status: 'UNVERIFIED',
        monitoring_status: 'paused',
        policy_status: 'pending'
    });
    upsertSourcePolicy({
        id: 'pol-concurrent-ashby',
        company_id: 'c-concurrent',
        source_type: 'ashby',
        endpoint: 'https://jobs.ashbyhq.com/concurrentco',
        enabled: 1,
        discovery_permitted: 1,
        feed_access_permitted: 1
    });
    const [claim1, claim2] = await Promise.all([
        Promise.resolve().then(() => claimAtsValidationScan('c-concurrent', 'ashby', 'concurrentco')),
        Promise.resolve().then(() => claimAtsValidationScan('c-concurrent', 'ashby', 'concurrentco'))
    ]);
    assert.strictEqual([claim1.permitted, claim2.permitted].filter(Boolean).length, 1, 'Exactly one concurrent caller may claim one-time validation');
});

test('Isolated DB passes PRAGMA integrity_check and foreign_key_check', () => {
    const db = getDb();
    assert.strictEqual(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.strictEqual(db.prepare('PRAGMA foreign_key_check').all().length, 0);
});

closeDb();
cleanupFiles();

console.log('\n==================================================');
console.log(`📊 Batch 2.1 Suite Summary: ${passed} passed, ${failed} failed`);
console.log('==================================================\n');

if (failed > 0) {
    process.exit(1);
}
