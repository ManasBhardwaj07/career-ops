/**
 * test-discovery-milestone2a.mjs — Integration Test Suite for Milestone 2A (Updated)
 *
 * Verifies all Milestone 2A criteria & final data quality corrections:
 *   1. Greenhouse, Lever, and Ashby adapter contracts & payload normalization.
 *   2. Detection heuristics: remote_type and employment_type (including PascalCase enums).
 *   3. Network error handling and retry resilience.
 *   4. SQLite repository operations:
 *      - Source policy enforcement (blocked companies, disabled policies).
 *      - Dry-run guarantee (zero DB mutations).
 *      - Content hashing & non-redundant snapshot rule (no redundant snapshots on repeat scan).
 *      - Separate discovery from eligibility filtering (ineligible jobs remain stored; evaluated in job_evaluations).
 *      - Granular telemetry: fetched, normalized, inserted, updated, unchanged, invalid, eligible.
 *      - Company failure isolation (one failing company does not abort others).
 *      - Routine refresh updates last_seen_at while preserving source_updated_at.
 *      - Database restart persistence and 100% integrity check.
 */

import { existsSync, unlinkSync, writeFileSync } from 'fs';
import { resolve } from 'path';

const TEST_DB_PATH = resolve(process.cwd(), 'data/test_discovery_m2a.db');
const CANONICAL_DB_PATH = resolve(process.cwd(), 'data/job_agent.db');
process.env.JOB_AGENT_DB_PATH = TEST_DB_PATH;

const { getDb, closeDb, getDbPath } = await import('./db/db.mjs');
const resolvedDbPath = resolve(getDbPath());
if (resolvedDbPath === CANONICAL_DB_PATH) {
    throw new Error(`SAFETY ABORT: test-discovery-milestone2a.mjs resolved to canonical DB (${resolvedDbPath})`);
}

const {
    upsertCompany,
    getCompany,
    upsertSourcePolicy,
    isSourcePermitted,
    upsertJobPosting,
    getJob,
    getSnapshotsForJob,
    createSourceScan,
    updateSourceScan,
    getSourceScan,
    upsertJobEvaluation,
    getJobEvaluation,
    verifyIntegrity,
    computeJobContentHash
} = await import('./db/repo.mjs');
const { runMigrations } = await import('./db/migrate.js');
import { detectRemoteType, detectEmploymentType, createNormalizedJob } from './discovery/adapters/base.mjs';
import { parseGreenhouseResponse, extractBoard as extractGhBoard } from './discovery/adapters/greenhouse.mjs';
import { parseLeverResponse, extractCompany as extractLeverCompany } from './discovery/adapters/lever.mjs';
import { parseAshbyResponse, extractBoard as extractAshbyBoard } from './discovery/adapters/ashby.mjs';
import { runScanner } from './scan-sqlite.mjs';

let passedTests = 0;
let failedTests = 0;

function assert(condition, testName, details = '') {
    if (condition) {
        console.log(`  ✅ PASS: ${testName}`);
        passedTests++;
    } else {
        console.error(`  ❌ FAIL: ${testName} ${details ? `(${details})` : ''}`);
        failedTests++;
    }
}

async function runAllTests() {
    console.log('====================================================');
    console.log('🧪 MILESTONE 2A — DISCOVERY ADAPTERS & REPO TEST SUITE');
    console.log('====================================================\n');

    // ==========================================
    // 1. Adapter Contract & Normalization Tests
    // ==========================================
    console.log('--- 1. Base Detection & Normalization Heuristics ---');

    assert(detectRemoteType('Senior Backend Engineer', 'San Francisco, CA', 'Remote') === 'remote',
        'detectRemoteType detects remote workplaceType');
    assert(detectRemoteType('Staff Engineer (Remote - US)', 'Austin, TX', '') === 'remote',
        'detectRemoteType detects remote in title');
    assert(detectRemoteType('Frontend Engineer', 'Bangalore, India (Hybrid)', '') === 'hybrid',
        'detectRemoteType detects hybrid');
    assert(detectRemoteType('Systems Engineer', 'New York, NY', 'On-site') === 'onsite',
        'detectRemoteType detects onsite');

    assert(detectEmploymentType('Software Engineer Intern', '', '') === 'internship',
        'detectEmploymentType detects internship');
    assert(detectEmploymentType('DevOps Consultant', 'Contract', '') === 'contract',
        'detectEmploymentType detects contract');
    assert(detectEmploymentType('Platform Engineer', 'Full-time', 'permanent') === 'full-time',
        'detectEmploymentType detects full-time');
    assert(detectEmploymentType('Technical Writer', 'Part-Time', '') === 'part-time',
        'detectEmploymentType detects part-time');
    assert(detectEmploymentType('AI Researcher', 'FullTime', 'FullTime') === 'full-time',
        'detectEmploymentType handles PascalCase FullTime (Ashby enum)');

    const normalized = createNormalizedJob({
        id: 'https://example.com/jobs/101',
        company_id: 'company-acme',
        company_name: 'Acme Corp',
        title: 'Backend Engineer',
        location: 'Remote, US',
        job_url: 'https://example.com/jobs/101',
        description: 'Building microservices in Go',
        source: 'greenhouse',
        source_job_id: '101',
        raw: { original: true }
    });

    assert(normalized.company_id === 'company-acme', 'Normalized job retains company_id');
    assert(normalized.title === 'Backend Engineer', 'Normalized job retains title');
    assert(normalized.remote_type === 'remote', 'Normalized job derives remote_type');
    assert(normalized.raw_json.includes('original'), 'Normalized job formats raw_json');

    // ==========================================
    // 2. Greenhouse Adapter Unit Tests
    // ==========================================
    console.log('\n--- 2. Greenhouse Adapter Contract ---');

    assert(extractGhBoard('https://boards.greenhouse.io/anthropic') === 'anthropic',
        'extractGhBoard handles standard boards URL');
    assert(extractGhBoard('https://job-boards.greenhouse.io/stripe') === 'stripe',
        'extractGhBoard handles job-boards URL');
    assert(extractGhBoard('https://boards-api.greenhouse.io/v1/boards/anthropic/jobs') === 'anthropic',
        'extractGhBoard handles boards-api URL');

    const mockGhPayload = {
        jobs: [
            {
                id: 12345,
                title: 'Software Engineer, Infrastructure',
                absolute_url: 'https://boards.greenhouse.io/acme/jobs/12345',
                location: { name: 'San Francisco, CA / Remote' },
                updated_at: '2026-03-01T10:00:00Z',
                content: '&lt;p&gt;Work on high scale infrastructure.&lt;/p&gt;'
            },
            {
                id: 12346,
                title: 'Machine Learning Intern',
                absolute_url: 'https://boards.greenhouse.io/acme/jobs/12346',
                location: { name: 'London, UK' },
                updated_at: '2026-03-02T12:00:00Z',
                content: 'Research internship'
            }
        ]
    };

    const parsedGh = parseGreenhouseResponse(mockGhPayload, 'company-acme', 'Acme Corp');
    assert(parsedGh.length === 2, 'Greenhouse parser extracts all jobs');
    assert(parsedGh[0].source === 'greenhouse', 'Greenhouse sets source: greenhouse');
    assert(parsedGh[0].source_job_id === '12345', 'Greenhouse sets source_job_id');
    assert(parsedGh[0].remote_type === 'remote', 'Greenhouse detects remote from location');
    assert(parsedGh[1].employment_type === 'internship', 'Greenhouse detects internship from title');
    assert(parsedGh[0].company_id === 'company-acme', 'Greenhouse attaches company_id');

    // ==========================================
    // 3. Lever Adapter Unit Tests
    // ==========================================
    console.log('\n--- 3. Lever Adapter Contract ---');

    assert(extractLeverCompany('https://jobs.lever.co/palantir') === 'palantir',
        'extractLeverCompany extracts company from URL');

    const mockLeverPayload = [
        {
            id: 'lever-987',
            text: 'Forward Deployed Software Engineer',
            hostedUrl: 'https://jobs.lever.co/palantir/lever-987',
            categories: {
                location: 'Washington, DC',
                commitment: 'Full-time'
            },
            workplaceType: 'hybrid',
            createdAt: 1772500000000,
            descriptionPlain: 'Solve customer problems on-site.'
        }
    ];

    const parsedLever = parseLeverResponse(mockLeverPayload, 'company-palantir', 'Palantir');
    assert(parsedLever.length === 1, 'Lever parser extracts jobs');
    assert(parsedLever[0].source === 'lever', 'Lever sets source: lever');
    assert(parsedLever[0].source_job_id === 'lever-987', 'Lever extracts source_job_id');
    assert(parsedLever[0].remote_type === 'hybrid', 'Lever extracts remote_type from workplaceType');
    assert(parsedLever[0].employment_type === 'full-time', 'Lever extracts employment_type from commitment');

    // ==========================================
    // 4. Ashby Adapter Unit Tests
    // ==========================================
    console.log('\n--- 4. Ashby Adapter Contract ---');

    assert(extractAshbyBoard('https://jobs.ashbyhq.com/elevenlabs') === 'elevenlabs',
        'extractAshbyBoard extracts board identifier');

    const mockAshbyPayload = {
        jobs: [
            {
                id: 'ashby-555',
                title: 'Audio Research Scientist',
                jobUrl: 'https://jobs.ashbyhq.com/elevenlabs/ashby-555',
                location: 'Remote - Worldwide',
                isRemote: true,
                employmentType: 'FullTime',
                publishedAt: '2026-02-15T08:00:00Z',
                descriptionPlain: 'Train voice generative models.'
            }
        ]
    };

    const parsedAshby = parseAshbyResponse(mockAshbyPayload, 'company-elevenlabs', 'ElevenLabs');
    assert(parsedAshby.length === 1, 'Ashby parser extracts jobs');
    assert(parsedAshby[0].source === 'ashby', 'Ashby sets source: ashby');
    assert(parsedAshby[0].source_job_id === 'ashby-555', 'Ashby extracts source_job_id');
    assert(parsedAshby[0].remote_type === 'remote', 'Ashby detects remote from isRemote: true');
    assert(parsedAshby[0].employment_type === 'full-time', 'Ashby detects full-time from employmentType');

    // ==========================================
    // 5. Database & Repository Operations (Fresh DB)
    // ==========================================
    console.log('\n--- 5. SQLite Repository & Migration In Fresh DB ---');

    closeDb();
    if (existsSync(TEST_DB_PATH)) {
        unlinkSync(TEST_DB_PATH);
    }
    process.env.JOB_AGENT_DB_PATH = TEST_DB_PATH;

    // Run forward migrations
    const migrationResult = runMigrations();
    assert(migrationResult.applied.length >= 4, 'Fresh database runs all migrations successfully (002-005)');
    assert(verifyIntegrity(), 'Fresh database passes PRAGMA integrity_check');

    // Test Company Upsert
    upsertCompany({
        id: 'company-mock-gh',
        name: 'Mock Greenhouse Co',
        career_url: 'https://boards.greenhouse.io/mockgh',
        ats_type: 'greenhouse',
        board_identifier: 'mockgh',
        policy_status: 'permitted'
    });

    const storedComp = getCompany('company-mock-gh');
    assert(storedComp && storedComp.name === 'Mock Greenhouse Co', 'upsertCompany persists company');

    // Test Source Policy Check
    assert(isSourcePermitted('company-mock-gh', 'greenhouse') === true,
        'isSourcePermitted returns true for permitted company');

    // Test Blocked Company
    upsertCompany({
        id: 'company-blocked',
        name: 'Blocked Corp',
        career_url: 'https://jobs.lever.co/blocked',
        ats_type: 'lever',
        board_identifier: 'blocked',
        policy_status: 'blocked'
    });
    assert(isSourcePermitted('company-blocked', 'lever') === false,
        'isSourcePermitted returns false for blocked company');

    // Test Disabled Source Policy
    upsertSourcePolicy({
        id: 'sp_blocked_1',
        company_id: 'company-mock-gh',
        source_type: 'greenhouse',
        endpoint: 'https://boards.greenhouse.io/mockgh',
        enabled: 0
    });
    assert(isSourcePermitted('company-mock-gh', 'greenhouse') === false,
        'isSourcePermitted returns false when source_policies.enabled = 0');

    // Re-enable policy
    upsertSourcePolicy({
        id: 'sp_blocked_1',
        company_id: 'company-mock-gh',
        source_type: 'greenhouse',
        endpoint: 'https://boards.greenhouse.io/mockgh',
        enabled: 1
    });
    assert(isSourcePermitted('company-mock-gh', 'greenhouse') === true,
        'isSourcePermitted returns true after re-enabling source policy');

    // ==========================================
    // 6. Content Hashing & Non-Redundant Snapshots
    // ==========================================
    console.log('\n--- 6. Content Hashing & Non-Redundant Snapshots ---');

    const jobA1 = createNormalizedJob({
        id: 'https://boards.greenhouse.io/mockgh/jobs/901',
        company_id: 'company-mock-gh',
        company_name: 'Mock Greenhouse Co',
        title: 'Backend Engineer (v1)',
        job_url: 'https://boards.greenhouse.io/mockgh/jobs/901',
        description: 'First version description',
        source: 'greenhouse',
        source_job_id: '901',
        source_updated_at: '2026-03-01T00:00:00Z',
        raw: { version: 1 }
    });

    const res1 = upsertJobPosting(jobA1);
    assert(res1.status === 'inserted' && res1.isNew === true, 'First insert of job returns inserted / isNew: true');

    const loadedJob1 = getJob(jobA1.id);
    assert(loadedJob1.title === 'Backend Engineer (v1)', 'Job stored with initial title');
    assert(loadedJob1.content_hash === computeJobContentHash(jobA1), 'Job stored with valid SHA-256 content_hash');
    assert(loadedJob1.source_updated_at === '2026-03-01T00:00:00.000Z', 'Initial source_updated_at recorded');

    const snaps1 = getSnapshotsForJob(jobA1.id);
    assert(snaps1.length === 1, 'Initial job insert records snapshot 1');

    // Re-insert exact same job (Identical repeat scan)
    const initialLastSeen = loadedJob1.last_seen_at;
    const resDup = upsertJobPosting(jobA1);
    assert(resDup.status === 'unchanged' && resDup.isNew === false, 'Duplicate insert returns unchanged / isNew: false');

    const snapsAfterDup = getSnapshotsForJob(jobA1.id);
    assert(snapsAfterDup.length === 1, 'Non-redundant snapshot rule: identical repeat scan creates NO new snapshot');

    const jobAfterDup = getJob(jobA1.id);
    assert(jobAfterDup.source_updated_at === '2026-03-01T00:00:00.000Z', 'Routine refresh preserves original source_updated_at');

    const db = getDb();
    const countAfterDuplicate = db.prepare('SELECT COUNT(*) as c FROM job_postings WHERE id = ?').get(jobA1.id).c;
    assert(countAfterDuplicate === 1, 'Deduplication guarantee: identical job does not create duplicate row');

    // Update job content (Actual content change)
    const jobA2 = createNormalizedJob({
        id: 'https://boards.greenhouse.io/mockgh/jobs/901',
        company_id: 'company-mock-gh',
        company_name: 'Mock Greenhouse Co',
        title: 'Senior Backend Engineer (v2)',
        job_url: 'https://boards.greenhouse.io/mockgh/jobs/901',
        description: 'Updated second version description',
        source: 'greenhouse',
        source_job_id: '901',
        source_updated_at: '2026-03-05T00:00:00Z',
        raw: { version: 2 }
    });

    const resUpdate = upsertJobPosting(jobA2);
    assert(resUpdate.status === 'updated' && resUpdate.contentChanged === true, 'Content change returns updated / contentChanged: true');

    const updatedJob = getJob(jobA1.id);
    assert(updatedJob.title === 'Senior Backend Engineer (v2)', 'Job updated with new title');
    assert(updatedJob.source_updated_at === '2026-03-05T00:00:00.000Z', 'Job updated with new source_updated_at');

    const snaps2 = getSnapshotsForJob(jobA1.id);
    assert(snaps2.length === 2, 'Actual content change records new snapshot 2');

    // Repeat scan of updated job without change
    upsertJobPosting(jobA2);
    const snapsAfterRepeat = getSnapshotsForJob(jobA1.id);
    assert(snapsAfterRepeat.length === 2, 'Repeat scan of updated job creates NO redundant snapshot 3');

    // ==========================================
    // 7. Source Scan Telemetry
    // ==========================================
    console.log('\n--- 7. Source Scan Telemetry Logging ---');

    const scanId = createSourceScan({
        company_id: 'company-mock-gh',
        source_type: 'greenhouse'
    });
    assert(scanId.startsWith('scan_'), 'createSourceScan creates unique scan ID');

    updateSourceScan(scanId, {
        completed_at: new Date().toISOString(),
        total_jobs: 10,
        new_jobs: 2,
        duplicate_jobs: 8,
        fetched_count: 12,
        normalized_count: 10,
        inserted_count: 2,
        updated_count: 1,
        unchanged_count: 7,
        invalid_count: 2,
        eligible_count: 5,
        is_complete: 1
    });

    const scanRecord = getSourceScan(scanId);
    assert(scanRecord.total_jobs === 10, 'updateSourceScan records total_jobs');
    assert(scanRecord.fetched_count === 12, 'updateSourceScan records fetched_count');
    assert(scanRecord.normalized_count === 10, 'updateSourceScan records normalized_count');
    assert(scanRecord.inserted_count === 2, 'updateSourceScan records inserted_count');
    assert(scanRecord.updated_count === 1, 'updateSourceScan records updated_count');
    assert(scanRecord.unchanged_count === 7, 'updateSourceScan records unchanged_count');
    assert(scanRecord.invalid_count === 2, 'updateSourceScan records invalid_count');
    assert(scanRecord.eligible_count === 5, 'updateSourceScan records eligible_count');
    assert(scanRecord.is_complete === 1, 'updateSourceScan marks scan complete');

    // ==========================================
    // 8. Separation of Discovery from Eligibility & End-to-End
    // ==========================================
    console.log('\n--- 8. Separation of Discovery from Eligibility Filtering ---');

    // Mock response with 2 valid jobs:
    // 701: matches positive filter ("Software Engineer", "Backend")
    // 702: fails filter ("Executive Assistant / Office Manager")
    const mockResponses = {
        'https://boards-api.greenhouse.io/v1/boards/company-success/jobs?content=true': {
            status: 200,
            json: async () => ({
                jobs: [
                    {
                        id: 701,
                        title: 'Software Engineer - Backend',
                        absolute_url: 'https://boards.greenhouse.io/company-success/jobs/701',
                        location: { name: 'Remote' },
                        content: 'Backend Go development'
                    },
                    {
                        id: 702,
                        title: 'Executive Assistant to VP',
                        absolute_url: 'https://boards.greenhouse.io/company-success/jobs/702',
                        location: { name: 'New York, NY' },
                        content: 'Calendar management and travel coordination'
                    }
                ]
            })
        },
        'https://api.lever.co/v0/postings/company-failing?mode=json': {
            status: 500,
            json: async () => { throw new Error('HTTP 500: Internal Server Error'); }
        }
    };

    const mockFetch = async (url) => {
        const mock = mockResponses[url];
        if (!mock) {
            return {
                ok: false,
                status: 404,
                json: async () => ({ error: 'Not Found' })
            };
        }
        if (mock.status === 500) {
            return {
                ok: false,
                status: 500,
                statusText: 'Internal Server Error',
                text: async () => 'Internal Server Error',
                json: mock.json
            };
        }
        return {
            ok: true,
            status: 200,
            json: mock.json
        };
    };

    const testPortalsConfig = {
        title_filter: {
            positive: ['software', 'engineer', 'backend'],
            negative: ['assistant', 'manager']
        },
        tracked_companies: [
            {
                name: 'Company Success',
                careers_url: 'https://boards.greenhouse.io/company-success',
                enabled: true
            },
            {
                name: 'Company Failing',
                careers_url: 'https://jobs.lever.co/company-failing',
                enabled: true
            }
        ]
    };

    const testPortalsPath = resolve(process.cwd(), 'data/test_portals.yml');
    writeFileSync(testPortalsPath, JSON.stringify(testPortalsConfig));

    // Test Dry-run
    const preCount = db.prepare('SELECT COUNT(*) as c FROM job_postings').get().c;
    const dryRunSummary = await runScanner({
        dryRun: true,
        filterCompany: 'Company Success',
        fetchFn: mockFetch,
        portalsPath: testPortalsPath
    });

    const postDryRunCount = db.prepare('SELECT COUNT(*) as c FROM job_postings').get().c;
    assert(postDryRunCount === preCount, 'Dry-run guarantee: exactly 0 job postings written in dry-run mode');
    assert(dryRunSummary.normalizedCount === 2, 'Dry-run discovers and normalizes both jobs');

    // Test Live Scan: Separation of Discovery from Eligibility
    const liveSummary = await runScanner({
        dryRun: false,
        fetchFn: mockFetch,
        portalsPath: testPortalsPath
    });

    assert(liveSummary.scanned === 2, 'Scanner attempts both companies');
    assert(liveSummary.errors.length === 1, 'Failure isolation: records 1 failure for Company Failing');
    assert(liveSummary.insertedCount === 2, 'Discovery persistence: BOTH jobs inserted into job_postings (not discarded!)');
    assert(liveSummary.eligibleCount === 1, 'Eligibility telemetry: exactly 1 job matches candidate title filter');

    // Verify job 701 (eligible)
    const job701 = getJob('https://boards.greenhouse.io/company-success/jobs/701');
    assert(job701 !== undefined && job701.title === 'Software Engineer - Backend', 'Eligible job stored in job_postings');
    const eval701 = getJobEvaluation('https://boards.greenhouse.io/company-success/jobs/701');
    assert(eval701 && eval701.recommendation === 'CONSIDER' && eval701.match_score === 1.0,
        'Eligible job evaluated as CONSIDER with match_score 1.0');

    // Verify job 702 (ineligible by candidate title filter, but STILL STORED in DB!)
    const job702 = getJob('https://boards.greenhouse.io/company-success/jobs/702');
    assert(job702 !== undefined && job702.title === 'Executive Assistant to VP',
        'Ineligible job remains STORED in job_postings (not discarded!)');
    const eval702 = getJobEvaluation('https://boards.greenhouse.io/company-success/jobs/702');
    assert(eval702 && eval702.recommendation === 'DO_NOT_APPLY' && eval702.match_score === 0.0,
        'Ineligible job evaluated as DO_NOT_APPLY in job_evaluations without deleting posting');

    // Test Repeat Scan Idempotency & Telemetry
    const repeatSummary = await runScanner({
        dryRun: false,
        filterCompany: 'Company Success',
        fetchFn: mockFetch,
        portalsPath: testPortalsPath
    });

    assert(repeatSummary.insertedCount === 0, 'Repeat scan inserts 0 new jobs');
    assert(repeatSummary.unchangedCount === 2, 'Repeat scan marks both jobs as unchanged');
    assert(repeatSummary.updatedCount === 0, 'Repeat scan records 0 content updates');

    const snaps701 = getSnapshotsForJob('https://boards.greenhouse.io/company-success/jobs/701');
    assert(snaps701.length === 1, 'Repeat scan creates NO redundant snapshots');

    // ==========================================
    // 9. Database Restart & Integrity Verification
    // ==========================================
    console.log('\n--- 9. Database Restart & Persistence Guarantee ---');

    closeDb();
    const restartedDb = getDb();
    const countAfterRestart = restartedDb.prepare('SELECT COUNT(*) as c FROM job_postings').get().c;
    assert(countAfterRestart === 3, `Database count reconciles exactly (got: ${countAfterRestart}, expected: 3 [901, 701, 702])`);
    assert(verifyIntegrity(), 'Restarted database maintains 100% PRAGMA integrity');

    closeDb();

    // Clean up test files
    if (existsSync(TEST_DB_PATH)) {
        unlinkSync(TEST_DB_PATH);
    }
    if (existsSync(testPortalsPath)) {
        unlinkSync(testPortalsPath);
    }

    // Reset env
    delete process.env.JOB_AGENT_DB_PATH;

    console.log('\n====================================================');
    console.log(`Test Results: ${passedTests} PASSED, ${failedTests} FAILED`);
    console.log('====================================================');

    if (failedTests > 0) {
        process.exit(1);
    }
}

runAllTests().catch(err => {
    console.error('Fatal error running tests:', err);
    closeDb();
    process.exit(1);
});
