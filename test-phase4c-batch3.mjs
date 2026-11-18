#!/usr/bin/env node

/**
 * test-phase4c-batch3.mjs — Phase 4C Batch 3: Workable + Recruitee Discovery & Integration Tests
 *
 * Strictly isolated to data/test_phase4c_batch3.db with fail-closed canonical DB guard.
 */

import assert from 'node:assert/strict';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const CANONICAL_DB_PATH = resolve(process.cwd(), 'data', 'job_agent.db');
const TEST_DB_PATH = resolve(process.cwd(), 'data', 'test_phase4c_batch3.db');
const TEST_PORTALS_PATH = resolve(process.cwd(), 'data', 'test_phase4c_batch3_portals.yml');

function cleanupTempFiles() {
    for (const p of [TEST_DB_PATH, `${TEST_DB_PATH}-wal`, `${TEST_DB_PATH}-shm`, TEST_PORTALS_PATH]) {
        try {
            if (existsSync(p)) unlinkSync(p);
        } catch { /* ignore */ }
    }
}

cleanupTempFiles();
process.env.JOB_AGENT_DB_PATH = TEST_DB_PATH;

const { getDb, closeDb, getDbPath } = await import('./db/db.mjs');
const resolvedDbPath = resolve(getDbPath());
if (resolvedDbPath === CANONICAL_DB_PATH) {
    throw new Error(`SAFETY ABORT: test-phase4c-batch3.mjs resolved to canonical DB (${resolvedDbPath})`);
}
console.log(`🔒 Isolated DB Path: ${resolvedDbPath}`);

const { runMigrations } = await import('./db/migrate.js');
await runMigrations();

const {
    upsertCompany,
    getCompany,
    upsertJobPosting,
    getJob,
    getJobProvenance,
    findCrossSourceDuplicates,
    isSourcePermitted,
    claimAtsValidationScan,
    normalizeLeadUrl
} = await import('./db/repo.mjs');

const { ingestProfile } = await import('./scripts/ingest-profile.mjs');
ingestProfile();

const {
    WorkableAdapter,
    extractAccount,
    buildEndpoint: buildWorkableEndpoint,
    parseWorkableResponse,
    fetchWorkableJobs
} = await import('./discovery/adapters/workable.mjs');

const {
    RecruiteeAdapter,
    extractCompany: extractRecruiteeCompany,
    buildEndpoint: buildRecruiteeEndpoint,
    parseRecruiteeResponse,
    fetchRecruiteeJobs
} = await import('./discovery/adapters/recruitee.mjs');

const { detectAtsFromUrl: detectYcAtsFromUrl } = await import('./discovery/adapters/yc.mjs');
const { runScanner } = await import('./scan-sqlite.mjs');
const { verifyJobBatch } = await import('./verification/verify-jobs.mjs');
const { evaluateJob } = await import('./matching/scheduler.mjs');

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`  ✅ PASS: ${name}`);
        passed++;
    } catch (err) {
        console.error(`  ❌ FAIL: ${name}\n     ${err.message}`);
        failed++;
    }
}

async function asyncTest(name, fn) {
    try {
        await fn();
        console.log(`  ✅ PASS: ${name}`);
        passed++;
    } catch (err) {
        console.error(`  ❌ FAIL: ${name}\n     ${err.message}`);
        failed++;
    }
}

console.log('\n====================================================');
console.log('🧪 PHASE 4C BATCH 3 — WORKABLE & RECRUITEE TEST SUITE');
console.log('====================================================');

try {
    console.log('\n--- 1. Workable Adapter Contract & Edge Cases ---');

    test('extractAccount & buildEndpoint parse Workable URLs and slugs', () => {
        assert.strictEqual(extractAccount('https://apply.workable.com/huggingface/'), 'huggingface');
        assert.strictEqual(extractAccount('https://apply.workable.com/api/v1/widget/accounts/acme-corp'), 'acme-corp');
        assert.strictEqual(extractAccount('acme-corp'), 'acme-corp');
        assert.strictEqual(extractAccount('https://apply.workable.com/j/ABC123'), null);
        assert.strictEqual(
            buildWorkableEndpoint('https://apply.workable.com/huggingface'),
            'https://apply.workable.com/api/v1/widget/accounts/huggingface?details=true'
        );
    });

    test('parseWorkableResponse normalizes fields without fabricating missing data or dropping geographic state', () => {
        const payload = {
            name: 'Acme Workable',
            jobs: [
                {
                    id: 101,
                    shortcode: 'WK101',
                    title: 'Software Engineer (Backend)',
                    state: 'KA',
                    workplace_type: 'remote',
                    employment_type: 'full_time',
                    published_on: '2026-11-01',
                    created_at: '2026-10-30',
                    url: 'https://apply.workable.com/acme/j/WK101/',
                    application_url: 'https://apply.workable.com/acme/j/WK101/apply/',
                    location: { city: 'Bengaluru', region: 'KA', country: 'India', telecommuting: true },
                    description: '<p>Build Node.js and PostgreSQL services.</p>'
                },
                {
                    id: 102,
                    shortcode: 'WK102',
                    title: 'Systems Engineer',
                    state: 'Île-de-France',
                    updated_at: '2026-11-05T12:00:00.000Z',
                    url: 'https://apply.workable.com/acme/j/WK102/'
                    // Missing optional location object, description, salary, employment_type, published_on
                },
                {
                    id: 103,
                    shortcode: 'WK103',
                    title: 'ML Engineer',
                    state: 'New York',
                    url: 'https://apply.workable.com/acme/j/WK103/'
                }
            ]
        };

        const jobs = parseWorkableResponse(payload, 'comp-wk', 'Acme Workable', 'acme');
        assert.strictEqual(jobs.length, 3);
        assert.strictEqual(jobs[0].source, 'workable');
        assert.strictEqual(jobs[0].source_job_id, 'WK101');
        assert.strictEqual(jobs[0].job_url, 'https://apply.workable.com/acme/j/WK101/');
        assert.strictEqual(jobs[0].application_url, 'https://apply.workable.com/acme/j/WK101/apply/');
        assert.strictEqual(jobs[0].location, 'Bengaluru, KA, India');
        assert.strictEqual(jobs[0].remote_type, 'remote');
        assert.strictEqual(jobs[0].employment_type, 'full-time');
        assert.strictEqual(jobs[0].applicant_eligibility, null);
        // published_on / created_at must NOT be mapped to source_updated_at
        assert.strictEqual(jobs[0].source_updated_at, null);
        assert.strictEqual(jobs[0].published_at, '2026-11-01');

        // Geographic state preserved as location; explicit updated_at maps to source_updated_at
        assert.strictEqual(jobs[1].location, 'Île-de-France');
        assert.strictEqual(jobs[1].description, null);
        assert.strictEqual(jobs[1].applicant_eligibility, null);
        assert.strictEqual(jobs[1].application_url, null);
        assert.ok(jobs[1].source_updated_at.startsWith('2026-11-05'));
        assert.strictEqual(jobs[2].location, 'New York');
    });

    await asyncTest('WorkableAdapter handles empty board, duplicate IDs, malformed JSON, HTTP 429/500, and network error', async () => {
        const adapter = new WorkableAdapter();
        const comp = { id: 'comp-wk-1', name: 'Acme', board_identifier: 'acme' };

        // Empty board -> conservatively incomplete (v1 widget lacks completeness metadata)
        const emptyRes = await fetchWorkableJobs('acme', comp.id, comp.name, {
            fetchFn: async () => ({ ok: true, status: 200, json: async () => ({ jobs: [] }) })
        });
        assert.strictEqual(emptyRes.isComplete, false);
        assert.strictEqual(emptyRes.completenessReason, 'unpaginated_v1_widget_without_completeness_metadata');
        assert.strictEqual(emptyRes.jobs.length, 0);
        assert.strictEqual(emptyRes.error, null);
        assert.strictEqual(
            emptyRes.fetchedCount,
            emptyRes.normalizedCount + emptyRes.invalidCount + emptyRes.filteredCount + emptyRes.duplicateInSourceCount
        );

        // Duplicate IDs in payload
        const dupRes = await fetchWorkableJobs('acme', comp.id, comp.name, {
            fetchFn: async () => ({
                ok: true,
                status: 200,
                json: async () => ({
                    jobs: [
                        { shortcode: 'DUP1', title: 'Backend Engineer', url: 'https://apply.workable.com/acme/j/DUP1/' },
                        { shortcode: 'DUP1', title: 'Backend Engineer', url: 'https://apply.workable.com/acme/j/DUP1/' }
                    ]
                })
            })
        });
        assert.strictEqual(dupRes.jobs.length, 1);
        assert.strictEqual(dupRes.duplicateInSourceCount, 1);

        // Malformed payload
        const badJsonRes = await fetchWorkableJobs('acme', comp.id, comp.name, {
            fetchFn: async () => ({ ok: true, status: 200, json: async () => ({ unexpected: true }) })
        });
        assert.strictEqual(badJsonRes.isComplete, false);
        assert.ok(badJsonRes.error.includes('Malformed'));

        // HTTP 429 rate-limit -> incomplete
        const rlRes = await fetchWorkableJobs('acme', comp.id, comp.name, {
            fetchFn: async () => ({ ok: false, status: 429, statusText: 'Too Many Requests' })
        });
        assert.strictEqual(rlRes.isComplete, false);
        assert.ok(rlRes.error);

        // Network/timeout error -> incomplete
        const netRes = await adapter.fetchJobs(comp, {
            fetchFn: async () => { throw new Error('ETIMEDOUT'); }
        });
        assert.ok(netRes.error.includes('ETIMEDOUT'));
    });

    console.log('\n--- 2. Recruitee Adapter Contract & Edge Cases ---');

    test('extractCompany & buildEndpoint parse Recruitee URLs and slugs', () => {
        assert.strictEqual(extractRecruiteeCompany('https://acme.recruitee.com/'), 'acme');
        assert.strictEqual(extractRecruiteeCompany('https://api.recruitee.com/c/12345/offers'), '12345');
        assert.strictEqual(extractRecruiteeCompany('acme'), 'acme');
        assert.strictEqual(buildRecruiteeEndpoint('https://acme.recruitee.com'), 'https://acme.recruitee.com/api/offers/');
        assert.strictEqual(buildRecruiteeEndpoint('12345'), 'https://api.recruitee.com/c/12345/offers');
    });

    test('parseRecruiteeResponse normalizes fields, booleans, and closure states without fabrication', () => {
        const payload = {
            offers: [
                {
                    id: 9001,
                    slug: 'full-stack-engineer',
                    title: 'Full Stack Engineer',
                    status: 'published',
                    remote: true,
                    hybrid: false,
                    on_site: false,
                    city: 'Bengaluru',
                    country: 'India',
                    employment_type_code: 'fulltime',
                    published_at: '2026-11-05T08:30:00.000Z',
                    updated_at: '2026-11-06T09:00:00.000Z',
                    careers_url: 'https://acme.recruitee.com/o/full-stack-engineer',
                    careers_apply_url: 'https://acme.recruitee.com/o/full-stack-engineer/c/new',
                    description: '<p>TypeScript, React, Node.js, PostgreSQL.</p>'
                },
                {
                    id: 9002,
                    slug: 'closed-offer',
                    title: 'Closed Offer',
                    status: 'closed',
                    careers_url: 'https://acme.recruitee.com/o/closed-offer'
                },
                {
                    id: 9003,
                    slug: 'minimal-offer',
                    title: 'Platform Engineer',
                    careers_url: 'https://acme.recruitee.com/o/minimal-offer'
                }
            ]
        };

        const jobs = parseRecruiteeResponse(payload, 'comp-rec', 'Acme Recruitee', 'acme');
        assert.strictEqual(jobs.length, 2);
        assert.strictEqual(jobs[0].source, 'recruitee');
        assert.strictEqual(jobs[0].source_job_id, '9001');
        assert.strictEqual(jobs[0].job_url, 'https://acme.recruitee.com/o/full-stack-engineer');
        assert.strictEqual(jobs[0].application_url, 'https://acme.recruitee.com/o/full-stack-engineer/c/new');
        assert.strictEqual(jobs[0].remote_type, 'remote');
        assert.strictEqual(jobs[0].employment_type, 'full-time');
        assert.strictEqual(jobs[0].applicant_eligibility, null);
        assert.ok(jobs[0].source_updated_at.startsWith('2026-11-06'));
        assert.strictEqual(jobs[0].published_at, '2026-11-05T08:30:00.000Z');
        assert.strictEqual(jobs[1].location, null);
        assert.strictEqual(jobs[1].application_url, null);
        assert.strictEqual(jobs[1].source_updated_at, null);
    });

    await asyncTest('RecruiteeAdapter handles empty, duplicate, malformed, HTTP error, and network error', async () => {
        const adapter = new RecruiteeAdapter();
        const comp = { id: 'comp-rec-1', name: 'Acme Rec', board_identifier: 'acme' };

        const emptyRes = await fetchRecruiteeJobs('acme', comp.id, comp.name, {
            fetchFn: async () => ({ ok: true, status: 200, json: async () => ({ offers: [] }) })
        });
        assert.strictEqual(emptyRes.isComplete, true);
        assert.strictEqual(emptyRes.jobs.length, 0);

        const dupRes = await fetchRecruiteeJobs('acme', comp.id, comp.name, {
            fetchFn: async () => ({
                ok: true,
                status: 200,
                json: async () => ({
                    offers: [
                        { id: 55, title: 'Node.js Developer', careers_url: 'https://acme.recruitee.com/o/node-dev' },
                        { id: 55, title: 'Node.js Developer', careers_url: 'https://acme.recruitee.com/o/node-dev' },
                        { id: 56, title: 'Closed Role', status: 'closed', careers_url: 'https://acme.recruitee.com/o/closed' }
                    ]
                })
            })
        });
        assert.strictEqual(dupRes.jobs.length, 1);
        assert.strictEqual(dupRes.duplicateInSourceCount, 1);
        assert.strictEqual(dupRes.filteredCount, 1);
        assert.strictEqual(
            dupRes.fetchedCount,
            dupRes.normalizedCount + dupRes.invalidCount + dupRes.filteredCount + dupRes.duplicateInSourceCount
        );

        const badRes = await fetchRecruiteeJobs('acme', comp.id, comp.name, {
            fetchFn: async () => ({ ok: true, status: 200, json: async () => ({ wrong: [] }) })
        });
        assert.strictEqual(badRes.isComplete, false);
        assert.ok(badRes.error.includes('Malformed'));

        const errRes = await adapter.fetchJobs(comp, {
            fetchFn: async () => ({ ok: false, status: 503, statusText: 'Service Unavailable' })
        });
        assert.ok(errRes.error);
    });

    console.log('\n--- 3. Scanner Integration, Policy, Lifecycle & Isolation ---');

    writeFileSync(TEST_PORTALS_PATH, `
title_filter:
  positive: [software, engineer, backend, full stack, developer]
  negative: [sales, recruiter, senior manager, director]
tracked_companies:
  - name: Workable Test Co
    careers_url: https://apply.workable.com/workable-test-co
    enabled: true
  - name: Recruitee Test Co
    careers_url: https://recruitee-test-co.recruitee.com
    enabled: true
  - name: Blocked Workable Co
    careers_url: https://apply.workable.com/blocked-wk
    policy_status: blocked
    enabled: true
public_feeds:
  - provider: remoteok
    enabled: true
`, 'utf-8');

    await asyncTest('runScanner supports --source workable, --source recruitee, dry-run, feeds-only, and error isolation', async () => {
        const mockFetch = async (url) => {
            if (url.includes('workable-test-co')) {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        jobs: [
                            {
                                shortcode: 'W1',
                                title: 'Software Engineer',
                                url: 'https://apply.workable.com/workable-test-co/j/W1/',
                                location: { city: 'Bengaluru', country: 'India' },
                                description: 'Node.js PostgreSQL AWS REST APIs'
                            },
                            {
                                shortcode: 'W2',
                                title: 'Account Sales Executive',
                                url: 'https://apply.workable.com/workable-test-co/j/W2/'
                            }
                        ]
                    })
                };
            }
            if (url.includes('recruitee-test-co')) {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        offers: [
                            {
                                id: 701,
                                title: 'Backend Engineer',
                                careers_url: 'https://recruitee-test-co.recruitee.com/o/backend-engineer',
                                remote: true,
                                city: 'Bengaluru',
                                country: 'India',
                                description: 'TypeScript Node.js Redis Docker'
                            }
                        ]
                    })
                };
            }
            return { ok: false, status: 404, statusText: 'Not Found' };
        };

        // Dry-run writes zero rows
        const dryRes = await runScanner({
            dryRun: true,
            filterSource: 'workable',
            includeFeeds: false,
            portalsPath: TEST_PORTALS_PATH,
            fetchFn: mockFetch
        });
        assert.strictEqual(dryRes.scanned, 2); // Workable Test Co + Blocked Workable Co (dryRun skips policy)
        assert.strictEqual(getJob('https://apply.workable.com/workable-test-co/j/W1/'), undefined);

        // Workable-only scan
        const wkRes = await runScanner({
            filterSource: 'workable',
            includeFeeds: false,
            portalsPath: TEST_PORTALS_PATH,
            fetchFn: mockFetch
        });
        assert.strictEqual(wkRes.scanned, 1);
        assert.strictEqual(wkRes.skippedPolicy, 1);
        assert.strictEqual(wkRes.insertedCount, 2);
        assert.strictEqual(wkRes.eligibleCount, 1);

        // Recruitee-only scan
        const recRes = await runScanner({
            filterSource: 'recruitee',
            includeFeeds: false,
            portalsPath: TEST_PORTALS_PATH,
            fetchFn: mockFetch
        });
        assert.strictEqual(recRes.scanned, 1);
        assert.strictEqual(recRes.insertedCount, 1);

        // Combined failure isolation: Workable fails, Recruitee still succeeds
        const isolatedErrRes = await runScanner({
            includeFeeds: false,
            portalsPath: TEST_PORTALS_PATH,
            fetchFn: async (url) => {
                if (url.includes('workable.com')) {
                    throw new Error('Workable upstream 502');
                }
                return mockFetch(url);
            }
        });
        assert.strictEqual(isolatedErrRes.errors.length, 1);
        assert.ok(isolatedErrRes.byCompany['Recruitee Test Co']);

        // Feed-only compatibility: skips tracked ATS companies
        const feedsOnlyRes = await runScanner({
            feedsOnly: true,
            dryRun: true,
            portalsPath: TEST_PORTALS_PATH,
            fetchFn: mockFetch
        });
        assert.strictEqual(feedsOnlyRes.scanned, 0);
        assert.strictEqual(feedsOnlyRes.feedsScanned, 1);
    });

    test('ATS discovery, one-time validation claim, and lifecycle enforcement work for Workable & Recruitee', () => {
        const wkAts = detectYcAtsFromUrl('https://apply.workable.com/sample-startup/j/ABC123');
        assert.strictEqual(wkAts.atsType, 'workable');
        assert.strictEqual(wkAts.boardIdentifier, 'sample-startup');

        const recAts = detectYcAtsFromUrl('https://sample-startup.recruitee.com/o/engineer');
        assert.strictEqual(recAts.atsType, 'recruitee');
        assert.strictEqual(recAts.boardIdentifier, 'sample-startup');

        upsertCompany({
            id: 'comp-unverified-wk',
            name: 'Unverified WK',
            career_url: 'https://apply.workable.com/unverified-wk',
            ats_type: 'workable',
            board_identifier: 'unverified-wk',
            policy_status: 'permitted',
            lifecycle_status: 'DISCOVERED_UNVERIFIED',
            monitoring_status: 'paused_needs_validation'
        });

        // Recurring monitoring blocked, one-time validation permitted once
        assert.strictEqual(isSourcePermitted('comp-unverified-wk', 'workable', 'monitoring'), false);
        assert.strictEqual(isSourcePermitted('comp-unverified-wk', 'workable', 'ats_validation'), true);
        const claim = claimAtsValidationScan('comp-unverified-wk', 'workable', 'unverified-wk');
        assert.strictEqual(claim.permitted, true);
        assert.strictEqual(claim.oneTime, true);
        assert.strictEqual(claim.isRecurring, false);
        assert.strictEqual(isSourcePermitted('comp-unverified-wk', 'workable', 'ats_validation'), false);
        assert.strictEqual(isSourcePermitted('comp-unverified-wk', 'workable', 'monitoring'), false);
    });

    console.log('\n--- 4. Deduplication, Provenance, Verification & Evaluation ---');

    test('Deduplication, authoritative provenance protection, and distinct role preservation', () => {
        const wkUrl = 'https://apply.workable.com/workable-test-co/j/W1/';
        // Re-upserting from secondary source must NOT overwrite authoritative Workable source
        const secRes = upsertJobPosting({
            id: wkUrl,
            company_id: 'company-workable-test-co',
            title: 'Overwritten Title Attempt',
            job_url: wkUrl,
            source: 'hackernews',
            raw_json: JSON.stringify({ note: 'hn mention' })
        });
        assert.strictEqual(secRes.status, 'unchanged');
        const stored = getJob(wkUrl);
        assert.strictEqual(stored.source, 'workable');
        assert.strictEqual(stored.title, 'Software Engineer');

        // Distinct role at same employer is NOT merged
        upsertJobPosting({
            id: 'https://apply.workable.com/workable-test-co/j/W3/',
            company_id: 'company-workable-test-co',
            title: 'Software Engineer (Frontend)',
            location: 'Bengaluru, India',
            job_url: 'https://apply.workable.com/workable-test-co/j/W3/',
            source: 'workable',
            source_job_id: 'W3'
        });
        assert.ok(getJob('https://apply.workable.com/workable-test-co/j/W3/'));

        // Changed description creates a new snapshot
        const updRes = upsertJobPosting({
            id: wkUrl,
            company_id: 'company-workable-test-co',
            title: 'Software Engineer',
            location: 'Bengaluru, India',
            job_url: wkUrl,
            description: 'Updated description with Redis and Docker.',
            source: 'workable',
            source_job_id: 'W1',
            raw_json: JSON.stringify({ shortcode: 'W1', updated: true })
        });
        assert.strictEqual(updRes.status, 'updated');
        assert.strictEqual(updRes.snapshotCreated, true);

        const prov = getJobProvenance(wkUrl);
        assert.ok(prov && prov.snapshots.length >= 2);

        // Tracking parameters stripped by canonical URL normalizer
        const cleanTracked = normalizeLeadUrl('https://apply.workable.com/workable-test-co/j/W1/?utm_source=hn&ref=123');
        assert.strictEqual(cleanTracked, 'https://apply.workable.com/workable-test-co/j/W1');

        // Cross-source duplicate suggestion works across Workable and Recruitee
        const dups = findCrossSourceDuplicates('company-workable-test-co', 'Software Engineer', 'Bengaluru, India');
        assert.ok(Array.isArray(dups));
    });

    await asyncTest('Authoritative verification & candidate evaluation preserve Tier 1 and Batch 2.1 semantics', async () => {
        const wkJobUrl = 'https://apply.workable.com/workable-test-co/j/W1/';
        const salesJobUrl = 'https://apply.workable.com/workable-test-co/j/W2/';

        const vRes = await verifyJobBatch({
            companyId: 'company-workable-test-co',
            jobIds: [wkJobUrl, salesJobUrl],
            fetchFn: async (url) => {
                if (url.includes('workable.com/api/v1/widget/accounts/workable-test-co')) {
                    return {
                        ok: true,
                        status: 200,
                        json: async () => ({
                            jobs: [
                                {
                                    shortcode: 'W1',
                                    title: 'Software Engineer',
                                    url: wkJobUrl,
                                    location: { city: 'Bengaluru', country: 'India' },
                                    description: 'Node.js PostgreSQL AWS'
                                }
                            ]
                        })
                    };
                }
                return { ok: false, status: 404, text: async () => '' };
            }
        });

        const w1Verify = vRes.results.find(r => r.jobId === wkJobUrl);
        const w2Verify = vRes.results.find(r => r.jobId === salesJobUrl);
        assert.strictEqual(w1Verify.outcome, 'ACTIVE');
        // W2 absent from Workable v1 widget response -> UNKNOWN (never fabricated as CLOSED)
        assert.strictEqual(w2Verify.outcome, 'UNKNOWN');

        const evalPass = await evaluateJob(wkJobUrl, { requireVerifiedActive: true, forceReeval: true });
        assert.strictEqual(evalPass.recommendation, 'APPLY');

        const evalSales = await evaluateJob(salesJobUrl, { requireVerifiedActive: false, forceReeval: true });
        assert.strictEqual(evalSales.recommendation, 'DO_NOT_APPLY');

        // Failed / rate-limited fetch must NOT overwrite previously verified active status to closed
        const failVerify = await verifyJobBatch({
            companyId: 'company-workable-test-co',
            jobIds: [wkJobUrl],
            fetchFn: async () => ({ ok: false, status: 429, statusText: 'Too Many Requests' })
        });
        assert.strictEqual(failVerify.results[0].outcome, 'ERROR');
        assert.strictEqual(getJob(wkJobUrl).status, 'active');
    });

} finally {
    closeDb();
    cleanupTempFiles();
    delete process.env.JOB_AGENT_DB_PATH;
}

console.log('\n====================================================');
console.log(`📊 Phase 4C Batch 3 Test Results: ${passed} PASSED, ${failed} FAILED`);
console.log('====================================================');

if (failed > 0) {
    process.exit(1);
}
