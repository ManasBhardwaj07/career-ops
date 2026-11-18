#!/usr/bin/env node

/**
 * test-phase4c-batch4.mjs — Phase 4C Batch 4: India-First Employer Coverage & ATS Board Expansion Tests
 *
 * Strictly isolated to data/test_phase4c_batch4.db with fail-closed canonical DB guard.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';

const CANONICAL_DB_PATH = resolve(process.cwd(), 'data', 'job_agent.db');
const TEST_DB_PATH = resolve(process.cwd(), 'data', 'test_phase4c_batch4.db');
const TEST_PORTALS_PATH = resolve(process.cwd(), 'data', 'test_phase4c_batch4_portals.yml');

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
    throw new Error(`SAFETY ABORT: test-phase4c-batch4.mjs resolved to canonical DB (${resolvedDbPath})`);
}
console.log(`🔒 Isolated DB Path: ${resolvedDbPath}`);

const { runMigrations } = await import('./db/migrate.js');
await runMigrations();

const {
    upsertCompany,
    getCompany,
    isSourcePermitted,
    claimAtsValidationScan
} = await import('./db/repo.mjs');

const { ingestProfile } = await import('./scripts/ingest-profile.mjs');
ingestProfile();

const {
    isThirdPartyPlatformDomain,
    extractOfficialDomain,
    resolveCompanyIdentity,
    registerCompanyCareerSurface
} = await import('./discovery/leads/company-resolver.mjs');

const { detectCompanyAts, runScanner } = await import('./scan-sqlite.mjs');
const { evaluateJob } = await import('./matching/scheduler.mjs');
const { titleScreening, eligibilityCheck } = await import('./matching/pipeline.mjs');
const { fetchSmartRecruitersJobs } = await import('./discovery/adapters/smartrecruiters.mjs');

let passed = 0;
let failed = 0;

async function test(name, fn) {
    try {
        await fn();
        console.log(`  ✅ PASS: ${name}`);
        passed++;
    } catch (err) {
        console.error(`  ❌ FAIL: ${name}`);
        console.error(`     ${err.stack || err.message}`);
        failed++;
    }
}

try {
    await test('portals.yml contains all 13 verified Batch 4 India-first ATS boards with valid detectCompanyAts()', () => {
        const raw = readFileSync(resolve(process.cwd(), 'portals.yml'), 'utf8');
        const cfg = yaml.load(raw);
        const expected = [
            { name: 'GitLab', type: 'greenhouse', target: 'gitlab' },
            { name: 'Glean', type: 'greenhouse', target: 'gleanwork' },
            { name: 'Smartsheet', type: 'greenhouse', target: 'smartsheet' },
            { name: 'DevRev', type: 'greenhouse', target: 'devrev' },
            { name: 'Enterpret', type: 'greenhouse', target: 'enterpret' },
            { name: '6sense', type: 'greenhouse', target: '6sense' },
            { name: 'Sarvam AI', type: 'ashby', target: 'sarvam' },
            { name: 'AiPrise', type: 'ashby', target: 'aiprise' },
            { name: 'Plane', type: 'ashby', target: 'plane' },
            { name: 'Ema', type: 'ashby', target: 'ema' },
            { name: 'SIXT', type: 'smartrecruiters', target: 'sixt' },
            { name: 'ClanX', type: 'recruitee', target: 'clanx' },
            { name: 'Aftershoot', type: 'recruitee', target: 'aftershoot' }
        ];

        for (const item of expected) {
            const entry = (cfg.tracked_companies || []).find(c => c.name === item.name);
            assert.ok(entry, `Expected ${item.name} in portals.yml tracked_companies`);
            assert.equal(entry.enabled, true, `${item.name} should be enabled`);
            const detected = detectCompanyAts(entry);
            assert.ok(detected, `detectCompanyAts should resolve ${item.name}`);
            assert.equal(detected.type, item.type, `${item.name} ATS type`);
            assert.ok(detected.target.includes(item.target), `${item.name} ATS target should include ${item.target}`);
        }
    });

    await test('Official domain vs third-party ATS URL validation rejects ATS hosts as official domains', () => {
        assert.equal(isThirdPartyPlatformDomain('https://jobs.ashbyhq.com/sarvam'), true);
        assert.equal(isThirdPartyPlatformDomain('https://job-boards.greenhouse.io/gleanwork'), true);
        assert.equal(isThirdPartyPlatformDomain('https://clanx.recruitee.com'), true);
        assert.equal(extractOfficialDomain('https://jobs.ashbyhq.com/sarvam'), null);
        assert.equal(extractOfficialDomain('https://www.sarvam.ai'), 'sarvam.ai');
        assert.equal(extractOfficialDomain('https://devrev.ai/careers'), 'devrev.ai');
    });

    await test('Duplicate resolution matches existing companies instead of creating duplicate rows', () => {
        upsertCompany({
            id: 'company-gitlab',
            name: 'GitLab',
            domain: 'gitlab.com',
            website_url: 'https://about.gitlab.com',
            lifecycle_status: 'VERIFIED',
            monitoring_status: 'active',
            policy_status: 'permitted'
        });
        upsertCompany({
            id: 'company-sarvam-ai',
            name: 'Sarvam AI',
            domain: 'sarvam.ai',
            website_url: 'https://www.sarvam.ai',
            lifecycle_status: 'VERIFIED',
            monitoring_status: 'active',
            policy_status: 'permitted'
        });

        const resGitlab = resolveCompanyIdentity({
            name: 'GitLab Inc.',
            websiteUrl: 'https://gitlab.com',
            atsType: 'greenhouse',
            boardIdentifier: 'gitlab',
            createIfMissing: true
        });
        assert.equal(resGitlab.resolved, true);
        assert.equal(resGitlab.created, false);
        assert.equal(resGitlab.companyId, 'company-gitlab');

        const resSarvam = resolveCompanyIdentity({
            name: 'Sarvam AI',
            websiteUrl: 'https://www.sarvam.ai',
            atsType: 'ashby',
            boardIdentifier: 'sarvam',
            createIfMissing: true
        });
        assert.equal(resSarvam.resolved, true);
        assert.equal(resSarvam.created, false);
        assert.equal(resSarvam.companyId, 'company-sarvam-ai');
    });

    await test('New verified employer registration stores ATS board & valid source policy', () => {
        const res = resolveCompanyIdentity({
            name: 'Smartsheet',
            websiteUrl: 'https://www.smartsheet.com',
            atsType: 'greenhouse',
            boardIdentifier: 'smartsheet',
            createIfMissing: true,
            lifecycleStatus: 'APPROVED',
            monitoringStatus: 'active',
            sourceProvenance: 'batch4_audit'
        });
        assert.equal(res.resolved, true);
        assert.equal(res.created, true);

        const updated = registerCompanyCareerSurface({
            companyId: res.companyId,
            careerUrl: 'https://job-boards.greenhouse.io/smartsheet',
            atsType: 'greenhouse',
            boardIdentifier: 'smartsheet',
            source: 'batch4_audit',
            enabled: true
        });
        assert.equal(updated.ats_type, 'greenhouse');
        assert.equal(updated.board_identifier, 'smartsheet');
        assert.equal(updated.domain, 'smartsheet.com');

        // Without explicit policy_status: 'permitted', recurring monitoring stays blocked
        assert.equal(isSourcePermitted(res.companyId, 'greenhouse', 'monitoring'), false);

        upsertCompany({
            id: res.companyId,
            name: 'Smartsheet',
            lifecycle_status: 'APPROVED',
            monitoring_status: 'active',
            policy_status: 'permitted'
        });
        assert.equal(isSourcePermitted(res.companyId, 'greenhouse', 'monitoring'), true);
    });

    await test('Unverified/paused employer is blocked from recurring monitoring and limited to one-time ats_validation', () => {
        upsertCompany({
            id: 'company-unverified-batch4',
            name: 'Unverified Co',
            lifecycle_status: 'UNVERIFIED',
            monitoring_status: 'paused',
            policy_status: 'permitted'
        });

        const monPerm = isSourcePermitted('company-unverified-batch4', 'ashby', 'monitoring');
        assert.equal(monPerm, false);

        const firstClaim = claimAtsValidationScan('company-unverified-batch4', 'ashby', 'unverified-board');
        assert.equal(firstClaim.permitted, true);
        assert.equal(firstClaim.oneTime, true);

        const secondClaim = claimAtsValidationScan('company-unverified-batch4', 'ashby', 'unverified-board');
        assert.equal(secondClaim.permitted, false);
    });

    await test('Controlled runScanner persists jobs, records scan completeness/failures, and prevents duplicates on rerun', async () => {
        const portalsYaml = {
            title_filter: {
                include_keywords: ['Software Engineer', 'Backend Engineer', 'Platform Engineer', 'AI Engineer'],
                exclude_keywords: ['Intern', 'Recruiter']
            },
            tracked_companies: [
                {
                    name: 'DevRev',
                    careers_url: 'https://job-boards.greenhouse.io/devrev',
                    scan_method: 'greenhouse_api',
                    enabled: true
                },
                {
                    name: 'Plane',
                    careers_url: 'https://jobs.ashbyhq.com/plane',
                    scan_method: 'ashby',
                    enabled: true
                },
                {
                    name: 'ClanX',
                    careers_url: 'https://clanx.recruitee.com',
                    scan_method: 'recruitee',
                    enabled: true
                },
                {
                    name: 'BrokenBoard',
                    careers_url: 'https://jobs.ashbyhq.com/brokenboard',
                    scan_method: 'ashby',
                    enabled: true
                }
            ]
        };
        writeFileSync(TEST_PORTALS_PATH, yaml.dump(portalsYaml), 'utf8');

        const mockFetch = async (url) => {
            if (url.includes('boards-api.greenhouse.io/v1/boards/devrev')) {
                return new Response(JSON.stringify({
                    jobs: [
                        {
                            id: 1001,
                            title: 'Senior Backend Engineer',
                            absolute_url: 'https://job-boards.greenhouse.io/devrev/jobs/1001',
                            location: { name: 'Bengaluru, India' },
                            updated_at: '2026-11-12T10:00:00Z'
                        }
                    ]
                }), { status: 200, headers: { 'content-type': 'application/json' } });
            }
            if (url.includes('api.ashbyhq.com/posting-api/job-board/plane')) {
                return new Response(JSON.stringify({
                    jobs: [
                        {
                            id: 'plane-2001',
                            title: 'Software Engineer, Backend (Node.js)',
                            jobUrl: 'https://jobs.ashbyhq.com/plane/plane-2001',
                            location: 'Hyderabad, India',
                            isRemote: false,
                            publishedAt: '2026-11-12T09:00:00Z',
                            descriptionPlain: 'Build scalable Node.js and TypeScript backend services.'
                        }
                    ]
                }), { status: 200, headers: { 'content-type': 'application/json' } });
            }
            if (url.includes('clanx.recruitee.com/api/offers')) {
                return new Response(JSON.stringify({
                    offers: [
                        {
                            id: 3001,
                            title: 'Founding Platform Engineer',
                            careers_url: 'https://clanx.recruitee.com/o/founding-platform-engineer',
                            location: 'Gurugram, India',
                            remote: false,
                            published_at: '2026-11-12T08:00:00Z',
                            description: 'Platform infrastructure in Kubernetes, Go, and TypeScript.'
                        }
                    ]
                }), { status: 200, headers: { 'content-type': 'application/json' } });
            }
            if (url.includes('brokenboard')) {
                return new Response('Internal Server Error', { status: 500 });
            }
            return new Response('Not Found', { status: 404 });
        };

        const run1 = await runScanner({
            portalsPath: TEST_PORTALS_PATH,
            includeFeeds: false,
            fetchFn: mockFetch
        });
        assert.equal(run1.scanned, 4);
        assert.equal(run1.insertedCount, 3);
        assert.equal(run1.errors.length, 1);

        const db = getDb();
        const postingsCount1 = db.prepare(`SELECT COUNT(*) as c FROM job_postings WHERE source IN ('greenhouse','ashby','recruitee')`).get().c;
        assert.equal(postingsCount1, 3);

        const brokenScan = db.prepare(`SELECT errors, is_complete, error_details FROM source_scans WHERE company_id = 'company-brokenboard' ORDER BY started_at DESC LIMIT 1`).get();
        assert.ok(brokenScan, 'Failed scan should be logged in source_scans');
        assert.ok(brokenScan.errors > 0);
        assert.equal(brokenScan.is_complete, 0);
        assert.ok(brokenScan.error_details && brokenScan.error_details.includes('500'));

        // Idempotent rerun
        const run2 = await runScanner({
            portalsPath: TEST_PORTALS_PATH,
            includeFeeds: false,
            fetchFn: mockFetch
        });
        assert.equal(run2.insertedCount, 0, 'Rerun must not insert duplicate postings');
        const postingsCount2 = db.prepare(`SELECT COUNT(*) as c FROM job_postings WHERE source IN ('greenhouse','ashby','recruitee')`).get().c;
        assert.equal(postingsCount2, 3);
    });

    await test('evaluateJob evaluates discovered India-compatible engineering posting cleanly', async () => {
        const db = getDb();
        const job = db.prepare(`SELECT * FROM job_postings WHERE source = 'ashby' AND title LIKE '%Backend%' LIMIT 1`).get();
        assert.ok(job, 'Expected Plane Ashby backend job in isolated DB');
        const evalRes = await evaluateJob(job.id);
        assert.ok(evalRes && typeof evalRes === 'object');
        assert.equal(evalRes.tier1Passed, true);
        assert.equal(evalRes.tier2Eligibility, 'PASS');
        assert.ok(['APPLY', 'CONSIDER', 'SKIP'].includes(evalRes.recommendation));
    });

    await test('Batch 4.1 regression: Tier 1 rejects non-IC-SWE titles even if description mentions software engineer', () => {
        const boilerplate = 'You will collaborate closely with software engineer teams across the org.';
        for (const title of ['Technical Program Manager', 'Developer Community Manager', 'Solution Architect', 'People Systems Engineer']) {
            const res = titleScreening({ title, description: boilerplate });
            assert.equal(res.passed, false, `Expected Tier 1 reject for "${title}"`);
        }
    });

    await test('Batch 4.1 regression: Tier 2 rejects Senior/Level-II+ titles and 3+ years experience even when "is a plus" appears elsewhere', async () => {
        const { getCandidateFacts } = await import('./db/repo.mjs');
        const facts = getCandidateFacts();

        for (const title of ['Senior AI/ML Ops Engineer', 'Senior Fullstack Engineer', 'Software Engineer II', 'Site Reliability Engineer II (Platform Engineer)']) {
            const res = eligibilityCheck({
                title,
                location: 'Bengaluru, India',
                remote_type: 'onsite',
                description: 'Build backend services in Bengaluru.'
            }, facts);
            const expGate = res.gates.find(g => g.gate === 'experience_seniority');
            assert.equal(expGate.outcome, 'FAIL', `Expected experience FAIL for "${title}"`);
        }

        const unrelatedPlusDesc = '<p><strong>Requirements:</strong></p><p>3-4 years of software engineering experience building full stack systems.</p>' +
            '<p>Nice to have: Kubernetes experience is a plus.</p>';
        const expRes = eligibilityCheck({
            title: 'Software Engineer - Full Stack',
            location: 'Bangalore, India',
            remote_type: 'onsite',
            description: unrelatedPlusDesc
        }, facts);
        const expGate = expRes.gates.find(g => g.gate === 'experience_seniority');
        assert.equal(expGate.outcome, 'FAIL', 'Unrelated "is a plus" must not bypass mandatory 3-4 years requirement');
    });

    await test('Batch 4.1 regression: SmartRecruiters paginates beyond 500 items and preserves isComplete=false when capped', async () => {
        const makePage = (offset, count) => ({
            totalFound: 555,
            content: Array.from({ length: count }, (_, idx) => ({
                id: `sr-${offset + idx}`,
                name: `Software Engineer ${offset + idx}`,
                location: { city: 'Bengaluru', country: 'in', remote: false },
                releasedDate: '2026-11-11T08:00:00Z'
            }))
        });
        const mockSrFetch = async (url) => {
            const u = new URL(url);
            const offset = Number(u.searchParams.get('offset') || '0');
            const count = offset === 500 ? 55 : 100;
            return new Response(JSON.stringify(makePage(offset, count)), { status: 200 });
        };

        const fullRes = await fetchSmartRecruitersJobs('sixt', 'company-sixt', 'SIXT', { fetchFn: mockSrFetch });
        assert.equal(fullRes.jobs.length, 555);
        assert.equal(fullRes.isComplete, true);

        const cappedRes = await fetchSmartRecruitersJobs('sixt', 'company-sixt', 'SIXT', { fetchFn: mockSrFetch, maxPages: 3, maxJobs: 300 });
        assert.equal(cappedRes.jobs.length, 300);
        assert.equal(cappedRes.isComplete, false);
    });
} finally {
    try { closeDb(); } catch { /* ignore */ }
    cleanupTempFiles();
}

console.log(`\nBatch 4 Test Results: ${passed} PASSED, ${failed} FAILED`);
if (failed > 0) process.exit(1);
