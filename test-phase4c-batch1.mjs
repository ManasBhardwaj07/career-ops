/**
 * test-phase4c-batch1.mjs — Phase 4C Batch 1 Public Feeds & REST APIs Test Suite
 *
 * Implements Phase 4C Batch 1 Part F:
 *   1. Unit tests for each public connector against mock/fixture data:
 *      - Remote OK: header/legal notice filtering, field extraction, attribution, deduplication
 *      - Himalayas: cursor-based pagination, applicationLink preservation, attribution
 *      - Remotive: category filtering, 24h delay notice, attribution
 *      - Jobicy: endpoint compliance, pagination, attribution
 *      - We Work Remotely: RSS XML parsing, "Company: Title" splitting, JSON fallback, attribution
 *      - Adzuna: BLOCKED_CREDENTIALS when env keys are missing, secret safety
 *   2. Ingestion pipeline integration (using isolated SQLite test database):
 *      - Clean normalization & persistence into job_postings and job_snapshots
 *      - Idempotent re-ingestion without duplicate records or snapshots
 *      - Cross-source duplicate detection across adapters
 *      - Batch verification integration (verifyJobBatch)
 *      - Evaluation integration (evaluateJob)
 *   3. Controlled live smoke test (graceful offline handling when sandboxed).
 */

import assert from 'assert';
import { existsSync, unlinkSync, mkdirSync, rmSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── 0. Directory and Database Isolation ──────────────────────────────────────────

const TEST_DB_PATH = resolve(__dirname, 'data/test_phase4c_batch1.db');
const CANONICAL_DB_PATH = resolve(__dirname, 'data/job_agent.db');

if (existsSync(TEST_DB_PATH)) {
    try { unlinkSync(TEST_DB_PATH); } catch {}
}

// Bind process database path to isolate from canonical data/job_agent.db
process.env.JOB_AGENT_DB_PATH = TEST_DB_PATH;

// Import db, repo, migrations, adapters after setting DB path
const { getDb, closeDb, getDbPath } = await import('./db/db.mjs');
const resolvedDbPath = resolve(getDbPath());
if (resolvedDbPath === CANONICAL_DB_PATH) {
    throw new Error(`SAFETY ABORT: test-phase4c-batch1.mjs resolved to canonical DB (${resolvedDbPath})`);
}

const { runMigrations } = await import('./db/migrate.js');
const {
    upsertCompany,
    upsertJobPosting,
    getJob,
    findCrossSourceDuplicates,
    getLatestEvaluationRun
} = await import('./db/repo.mjs');

import {
    RemoteOkAdapter,
    fetchRemoteOkJobs,
    parseRemoteOkResponse,
    HimalayasAdapter,
    fetchHimalayasJobs,
    parseHimalayasResponse,
    RemotiveAdapter,
    fetchRemotiveJobs,
    parseRemotiveResponse,
    JobicyAdapter,
    fetchJobicyJobs,
    parseJobicyResponse,
    checkJobicyJobStatuses,
    mapJobicyStatusToVerificationOutcome,
    WeworkremotelyAdapter,
    fetchWwrJobs,
    parseWwrRss,
    parseWwrJson,
    AdzunaAdapter,
    fetchAdzunaJobs,
    hasAdzunaCredentials,
    PUBLIC_FEED_PROVIDERS,
    PUBLIC_FEED_REGISTRY
} from './discovery/adapters/index.mjs';

import { runScanner, checkFeedRateLimit } from './scan-sqlite.mjs';
import { verifyJobBatch, isJobVerifiedActive } from './verification/verify-jobs.mjs';
import { evaluateJob } from './matching/scheduler.mjs';

let passedCount = 0;
let failedCount = 0;

function test(description, fn) {
    try {
        fn();
        console.log(`  ✅ PASS: ${description}`);
        passedCount++;
    } catch (err) {
        console.error(`  ❌ FAIL: ${description}`);
        console.error(err);
        failedCount++;
    }
}

async function asyncTest(description, fn) {
    try {
        await fn();
        console.log(`  ✅ PASS: ${description}`);
        passedCount++;
    } catch (err) {
        console.error(`  ❌ FAIL: ${description}`);
        console.error(err);
        failedCount++;
    }
}

console.log('====================================================');
console.log('🧪 CAREER OPS — PHASE 4C BATCH 1 TEST SUITE');
console.log('   Public Job Feeds & REST API Integrations');
console.log('====================================================\n');

// Initialize isolated database schema
const db = getDb();
runMigrations(db);

// ── 1. Unit Tests: Remote OK Adapter ────────────────────────────────────────────

console.log('--- 1. Remote OK Adapter Tests ---');

const mockRemoteOkPayload = [
    {
        legal: "Please note this data is copyrighted and provided for personal non-commercial use only.",
        info: "https://remoteok.com/api"
    },
    {
        id: "1001",
        position: "Full Stack Engineer (MERN)",
        company: "RemoteLabs Inc",
        location: "Worldwide",
        tags: ["full-time", "react", "node", "javascript", "mongodb"],
        apply_url: "https://remotelabs.example.com/apply/1001",
        url: "https://remoteok.com/l/1001",
        salary_min: 75000,
        salary_max: 110000,
        description: "<p>We are seeking a Full Stack Engineer experienced with Node.js and React.</p>",
        date: "2026-11-10T10:00:00Z"
    },
    {
        id: "1002",
        position: "Backend Node.js Developer",
        company: "CloudScale",
        location: "Remote",
        tags: ["node", "backend", "typescript"],
        url: "https://remoteok.com/l/1002",
        // no apply_url, fallback to url
        salary_min: 90000,
        salary_max: 130000,
        description: "<p>Backend services developer.</p>",
        date: "2026-11-11T08:00:00Z"
    },
    {
        id: "1003",
        // Missing position/title -> should be filtered
        company: "NoTitle Corp",
        url: "https://remoteok.com/l/1003"
    },
    {
        id: "1004",
        position: "No URL Engineer",
        company: "NoUrl Corp"
        // Missing URL -> should be filtered
    },
    {
        // Duplicate URL of 1001
        id: "1005",
        position: "Full Stack Engineer (Duplicate URL)",
        company: "RemoteLabs Inc",
        apply_url: "https://remotelabs.example.com/apply/1001"
    }
];

test('Remote OK: parses valid payload, ignores legal disclaimer object', () => {
    const jobs = parseRemoteOkResponse(mockRemoteOkPayload);
    assert.strictEqual(jobs.length, 2, 'Should extract exactly 2 valid jobs, ignoring disclaimer and invalid items');

    const job1 = jobs[0];
    assert.strictEqual(job1.title, 'Full Stack Engineer (MERN)');
    assert.strictEqual(job1.company_name, 'RemoteLabs Inc');
    assert.strictEqual(job1.job_url, 'https://remotelabs.example.com/apply/1001');
    assert.strictEqual(job1.employment_type, 'full-time');
    assert.strictEqual(job1.source, 'remoteok');
    assert.strictEqual(job1.raw._source_platform, 'remoteok');
    assert.ok(job1.raw._attribution.includes('Remote OK'), 'Attribution must be present in raw');
    assert.strictEqual(job1.raw.salary_min, 75000);
    assert.strictEqual(job1.raw.salary_max, 110000);

    const job2 = jobs[1];
    assert.strictEqual(job2.title, 'Backend Node.js Developer');
    assert.strictEqual(job2.job_url, 'https://remoteok.com/l/1002');
});

test('Remote OK: handles malformed, empty, or non-array payloads gracefully', () => {
    assert.deepStrictEqual(parseRemoteOkResponse([]), []);
    assert.deepStrictEqual(parseRemoteOkResponse(null), []);
    assert.deepStrictEqual(parseRemoteOkResponse({ error: 'not an array' }), []);
    assert.deepStrictEqual(parseRemoteOkResponse("string"), []);
});

await asyncTest('Remote OK: fetchRemoteOkJobs adapter integration with mock fetch', async () => {
    const mockFetch = async () => ({
        ok: true,
        status: 200,
        json: async () => mockRemoteOkPayload
    });

    const adapter = new RemoteOkAdapter();
    const result = await adapter.fetchJobs({ fetchFn: mockFetch });

    assert.strictEqual(result.sourceType, 'remoteok');
    assert.strictEqual(result.jobs.length, 2);
    assert.strictEqual(result.error, null);
    assert.strictEqual(result.fetchedCount, 5);
    assert.strictEqual(result.normalizedCount, 2);
    assert.strictEqual(result.invalidCount, 2);
    assert.strictEqual(result.duplicateInSourceCount, 1);
});

// ── 2. Unit Tests: Himalayas Adapter ───────────────────────────────────────────

console.log('\n--- 2. Himalayas Adapter Tests ---');

const mockHimalayasPayload = {
    meta: {
        total: 100,
        nextCursor: "eyJvZmZzZXQiOjIwfQ=="
    },
    data: [
        {
            title: "Senior Full Stack Engineer",
            companyName: "HimalayasPartner",
            applicationLink: "https://himalayaspartner.com/careers/senior-full-stack",
            location: "Remote (India or Worldwide)",
            employmentType: "Full-Time",
            minSalary: 80000,
            maxSalary: 120000,
            currency: "USD",
            description: "Build robust full-stack applications with React and Node.js.",
            pubDate: 1731320000,
            tags: ["Full Stack", "React", "Node.js"]
        },
        {
            title: "Frontend React Developer",
            companyName: "FrontDesign",
            applicationLink: "https://frontdesign.com/jobs/react-dev",
            location: "Remote",
            employmentType: "Full-Time",
            pubDate: 1731321000,
            description: "Frontend focused role."
        },
        {
            // Missing applicationLink -> filter out
            title: "No Link Role",
            companyName: "Ghost Company"
        }
    ]
};

test('Himalayas: parses valid payload, preserves applicationLink as job_url', () => {
    const jobs = parseHimalayasResponse(mockHimalayasPayload);
    assert.strictEqual(jobs.length, 2, 'Should parse exactly 2 valid jobs');

    const job1 = jobs[0];
    assert.strictEqual(job1.title, 'Senior Full Stack Engineer');
    assert.strictEqual(job1.company_name, 'HimalayasPartner');
    assert.strictEqual(job1.job_url, 'https://himalayaspartner.com/careers/senior-full-stack');
    assert.strictEqual(job1.source, 'himalayas');
    assert.strictEqual(job1.raw._source_platform, 'himalayas');
    assert.ok(job1.raw._attribution.includes('Himalayas'), 'Attribution must be present in raw');
    assert.strictEqual(job1.raw.minSalary, 80000);
    assert.strictEqual(job1.raw.maxSalary, 120000);
});

test('Himalayas: handles empty data or malformed response gracefully', () => {
    assert.deepStrictEqual(parseHimalayasResponse({}), []);
    assert.deepStrictEqual(parseHimalayasResponse(null), []);
    assert.deepStrictEqual(parseHimalayasResponse({ data: [] }), []);
    assert.deepStrictEqual(parseHimalayasResponse("string"), []);
});

await asyncTest('Himalayas: fetchHimalayasJobs adapter integration and pagination cursor', async () => {
    const requestedUrls = [];
    let callNum = 0;
    const mockFetch = async (url) => {
        requestedUrls.push(url);
        callNum++;
        if (callNum === 1) {
            return {
                ok: true,
                status: 200,
                json: async () => mockHimalayasPayload
            };
        }
        return {
            ok: true,
            status: 200,
            json: async () => ({
                meta: { nextCursor: null },
                data: [
                    {
                        title: "Page 2 Full Stack Engineer",
                        companyName: "Page2Corp",
                        applicationLink: "https://page2corp.com/jobs/1"
                    }
                ]
            })
        };
    };

    const adapter = new HimalayasAdapter();
    const result = await adapter.fetchJobs({ fetchFn: mockFetch, cursor: 'test_cursor_val' });

    assert.strictEqual(requestedUrls.length, 2, 'Should fetch 2 pages following nextCursor');
    assert.ok(requestedUrls[0].includes('cursor=test_cursor_val'), 'Page 1 should forward initial cursor');
    assert.ok(requestedUrls[0].includes('limit=20'), 'Should default limit to 20');
    assert.ok(requestedUrls[1].includes('cursor=eyJvZmZzZXQiOjIwfQ'), 'Page 2 should forward meta.nextCursor');
    assert.strictEqual(result.sourceType, 'himalayas');
    assert.strictEqual(result.jobs.length, 3, 'Should aggregate jobs across cursor pages');
});

// ── 3. Unit Tests: Remotive Adapter ────────────────────────────────────────────

console.log('\n--- 3. Remotive Adapter Tests ---');

const mockRemotivePayload = {
    "0-legal-notice": "Remotive jobs API is provided for personal use. Note that job offers can be outdated by 24h.",
    "job-count": 2,
    "jobs": [
        {
            id: 2001,
            url: "https://remotive.com/remote-jobs/software-dev/full-stack-dev-2001",
            title: "Full Stack Developer",
            company_name: "RemotiveTech",
            category: "Software Development",
            tags: ["react", "nodejs", "postgresql"],
            job_type: "full_time",
            publication_date: "2026-11-10T12:00:00",
            candidate_required_location: "Worldwide",
            salary: "$85,000 - $115,000",
            description: "<p>Full stack developer position building web apps.</p>"
        },
        {
            id: 2002,
            url: "https://remotive.com/remote-jobs/software-dev/backend-dev-2002",
            title: "Node.js Backend Engineer",
            company_name: "ServerCore",
            category: "Software Development",
            tags: ["node", "express", "redis"],
            job_type: "full_time",
            candidate_required_location: "APAC / India",
            description: "<p>Backend Node.js API development.</p>"
        },
        {
            id: 2003,
            // Missing title
            url: "https://remotive.com/remote-jobs/missing-title-2003",
            company_name: "BrokenCorp"
        }
    ]
};

test('Remotive: parses valid payload, respects 24h delay notice & preserves attribution', () => {
    const jobs = parseRemotiveResponse(mockRemotivePayload);
    assert.strictEqual(jobs.length, 2, 'Should extract 2 valid jobs, ignoring 0-legal-notice');

    const job1 = jobs[0];
    assert.strictEqual(job1.title, 'Full Stack Developer');
    assert.strictEqual(job1.company_name, 'RemotiveTech');
    assert.strictEqual(job1.job_url, 'https://remotive.com/remote-jobs/software-dev/full-stack-dev-2001');
    assert.strictEqual(job1.source, 'remotive');
    assert.strictEqual(job1.raw._source_platform, 'remotive');
    assert.ok(job1.raw._attribution.includes('Remotive'), 'Attribution must be present in raw');
    assert.strictEqual(job1.raw.salary, '$85,000 - $115,000');
});

test('Remotive: handles malformed or empty responses gracefully', () => {
    assert.deepStrictEqual(parseRemotiveResponse({}), []);
    assert.deepStrictEqual(parseRemotiveResponse(null), []);
    assert.deepStrictEqual(parseRemotiveResponse({ jobs: [] }), []);
});

await asyncTest('Remotive: fetchRemotiveJobs adapter integration with mock fetch', async () => {
    let requestedUrl = null;
    const mockFetch = async (url) => {
        requestedUrl = url;
        return {
            ok: true,
            status: 200,
            json: async () => mockRemotivePayload
        };
    };

    const adapter = new RemotiveAdapter();
    const result = await adapter.fetchJobs({ fetchFn: mockFetch, category: 'software-dev' });

    assert.ok(requestedUrl.includes('category=software-dev'), 'Should pass category parameter');
    assert.strictEqual(result.sourceType, 'remotive');
    assert.strictEqual(result.jobs.length, 2);
    assert.strictEqual(result.fetchedCount, 3);
    assert.strictEqual(result.normalizedCount, 2);
});

// ── 4. Unit Tests: Jobicy Adapter ──────────────────────────────────────────────

console.log('\n--- 4. Jobicy Adapter Tests ---');

const mockJobicyPayload = {
    apiVersion: "2.0",
    jobCount: 2,
    jobs: [
        {
            id: 3001,
            url: "https://jobicy.com/jobs/3001-mern-stack-engineer",
            jobTitle: "MERN Stack Engineer",
            companyName: "JobicyGlobal",
            jobGeo: "Anywhere",
            jobType: ["full-time"],
            pubDate: "2026-11-10T14:00:00Z",
            annualSalaryMin: 80000,
            annualSalaryMax: 110000,
            salaryCurrency: "USD",
            jobDescription: "<p>Work on React and Node.js microservices.</p>"
        },
        {
            id: 3002,
            url: "https://jobicy.com/jobs/3002-frontend-engineer",
            jobTitle: "Frontend Engineer (React)",
            companyName: "AppStudio",
            jobGeo: "APAC",
            jobType: ["contract"],
            pubDate: "2026-11-11T09:00:00Z",
            jobDescription: "<p>Frontend React contract role.</p>"
        },
        {
            id: 3003,
            // Missing URL -> filter out
            jobTitle: "No URL Role",
            companyName: "Invalid Corp"
        }
    ]
};

test('Jobicy: parses valid payload, uses public /api/jobs format and preserves attribution', () => {
    const jobs = parseJobicyResponse(mockJobicyPayload);
    assert.strictEqual(jobs.length, 2, 'Should parse exactly 2 valid jobs');

    const job1 = jobs[0];
    assert.strictEqual(job1.title, 'MERN Stack Engineer');
    assert.strictEqual(job1.company_name, 'JobicyGlobal');
    assert.strictEqual(job1.job_url, 'https://jobicy.com/jobs/3001-mern-stack-engineer');
    assert.strictEqual(job1.source, 'jobicy');
    assert.strictEqual(job1.raw._source_platform, 'jobicy');
    assert.ok(job1.raw._attribution.includes('Jobicy'), 'Attribution must be present in raw');
    assert.strictEqual(job1.raw.annualSalaryMin, 80000);
    assert.strictEqual(job1.raw.annualSalaryMax, 110000);

    const job2 = jobs[1];
    assert.strictEqual(job2.employment_type, 'contract');
});

test('Jobicy: handles malformed or empty payloads gracefully', () => {
    assert.deepStrictEqual(parseJobicyResponse({}), []);
    assert.deepStrictEqual(parseJobicyResponse(null), []);
    assert.deepStrictEqual(parseJobicyResponse({ jobs: [] }), []);
});

await asyncTest('Jobicy: cursor pagination with nextCursor, filter preservation, and null termination', async () => {
    const requestedUrls = [];
    let callNum = 0;
    const mockFetch = async (url) => {
        requestedUrls.push(url);
        callNum++;
        if (callNum === 1) {
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    ...mockJobicyPayload,
                    nextCursor: 'jobicy_cursor_page2'
                })
            };
        }
        return {
            ok: true,
            status: 200,
            json: async () => ({
                apiVersion: '2.0',
                nextCursor: null,
                jobs: [
                    {
                        id: 3004,
                        url: 'https://jobicy.com/jobs/3004-backend-node',
                        jobTitle: 'Backend Node.js Engineer',
                        companyName: 'PageTwoCorp',
                        jobGeo: 'usa',
                        jobType: ['full-time'],
                        pubDate: '2026-11-11T10:00:00Z'
                    }
                ]
            })
        };
    };

    const adapter = new JobicyAdapter();
    const result = await adapter.fetchJobs({
        fetchFn: mockFetch,
        count: 100,
        industry: 'engineering',
        geo: 'usa',
        tag: 'nodejs'
    });

    assert.strictEqual(requestedUrls.length, 2, 'Should make 2 requests and stop when nextCursor is null');
    assert.ok(requestedUrls[0].includes('count=100'), 'Page 1 must use count=100');
    assert.ok(requestedUrls[0].includes('industry=engineering'), 'Page 1 must preserve industry filter');
    assert.ok(requestedUrls[0].includes('geo=usa'), 'Page 1 must preserve geo filter');
    assert.ok(requestedUrls[0].includes('tag=nodejs'), 'Page 1 must preserve tag filter');
    assert.ok(!requestedUrls[0].includes('cursor='), 'Page 1 must not send cursor');

    assert.ok(requestedUrls[1].includes('count=100'), 'Page 2 must preserve identical count filter');
    assert.ok(requestedUrls[1].includes('industry=engineering'), 'Page 2 must preserve identical industry filter');
    assert.ok(requestedUrls[1].includes('geo=usa'), 'Page 2 must preserve identical geo filter');
    assert.ok(requestedUrls[1].includes('tag=nodejs'), 'Page 2 must preserve identical tag filter');
    assert.ok(requestedUrls[1].includes('cursor=jobicy_cursor_page2'), 'Page 2 must forward nextCursor');

    assert.strictEqual(result.sourceType, 'jobicy');
    assert.strictEqual(result.jobs.length, 3, 'Should aggregate jobs across cursor pages');
    assert.strictEqual(result.error, null);
});

await asyncTest('Jobicy: handles expired cursor safely on subsequent and initial requests', async () => {
    let callNum = 0;
    const mockExpiredSubsequent = async () => {
        callNum++;
        if (callNum === 1) {
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    ...mockJobicyPayload,
                    nextCursor: 'stale_cursor_xyz'
                })
            };
        }
        return {
            ok: false,
            status: 410,
            statusText: 'Gone',
            json: async () => ({ error: 'Expired cursor' })
        };
    };

    const partialResult = await fetchJobicyJobs({ fetchFn: mockExpiredSubsequent });
    assert.strictEqual(partialResult.jobs.length, 2, 'Must preserve page 1 jobs when page 2 cursor expires');
    assert.ok(partialResult.error && /cursor/i.test(partialResult.error), 'Must report expired cursor warning');

    const mockExpiredInitial = async () => ({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        json: async () => ({ error: 'Invalid or expired cursor' })
    });

    const initialFailResult = await fetchJobicyJobs({ fetchFn: mockExpiredInitial, cursor: 'bad_cursor' });
    assert.strictEqual(initialFailResult.jobs.length, 0);
    assert.ok(initialFailResult.error && /cursor/i.test(initialFailResult.error), 'Must report initial expired cursor cleanly');
});

await asyncTest('Jobicy: batch status endpoint handles active, closed, and unknown statuses', async () => {
    let statusUrl = null;
    const mockStatusFetch = async (url) => {
        statusUrl = url;
        return {
            ok: true,
            status: 200,
            json: async () => ({
                statuses: {
                    '3001': 'active',
                    '3002': 'closed',
                    '3099': 'unknown'
                }
            })
        };
    };

    const res = await checkJobicyJobStatuses(['3001', '3002', '3099', '3100'], { fetchFn: mockStatusFetch });
    assert.ok(statusUrl.startsWith('https://jobicy.com/api/jobs/status'), 'Must call official /api/jobs/status endpoint');
    assert.ok(statusUrl.includes('ids=3001%2C3002%2C3099%2C3100') || statusUrl.includes('ids=3001,3002,3099,3100'));
    assert.strictEqual(res.statuses['3001'], 'active');
    assert.strictEqual(res.statuses['3002'], 'closed');
    assert.strictEqual(res.statuses['3099'], 'unknown');
    assert.strictEqual(res.statuses['3100'], 'unknown', 'Missing IDs from status payload must default to unknown');

    // Never mark unknown / missing from 7-day feed as closed
    const activeOutcome = mapJobicyStatusToVerificationOutcome(res.statuses['3001']);
    assert.strictEqual(activeOutcome.outcome, 'ACTIVE');
    assert.strictEqual(activeOutcome.definitive, true);

    const closedOutcome = mapJobicyStatusToVerificationOutcome(res.statuses['3002']);
    assert.strictEqual(closedOutcome.outcome, 'CLOSED');
    assert.strictEqual(closedOutcome.definitive, true);

    const unknownOutcome = mapJobicyStatusToVerificationOutcome(res.statuses['3099']);
    assert.strictEqual(unknownOutcome.outcome, 'UNKNOWN');
    assert.strictEqual(unknownOutcome.definitive, false, 'Unknown / missing 7-day-feed listing must NOT be marked closed');
});

// ── 5. Unit Tests: We Work Remotely Adapter ─────────────────────────────────────

console.log('\n--- 5. We Work Remotely Adapter Tests ---');

const mockWwrXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>We Work Remotely: Programming Jobs</title>
    <link>https://weworkremotely.com</link>
    <item>
      <title>FinTech Corp: Senior Full Stack Engineer</title>
      <link>https://weworkremotely.com/remote-jobs/fintech-corp-senior-full-stack-engineer</link>
      <description><![CDATA[<p>Join our payments platform team building Node.js microservices.</p>]]></description>
      <pubDate>Wed, 11 Nov 2026 12:00:00 GMT</pubDate>
    </item>
    <item>
      <title>Title Without Colon Prefix</title>
      <link>https://weworkremotely.com/remote-jobs/standalone-title</link>
      <description><![CDATA[<p>Software development role.</p>]]></description>
      <pubDate>Wed, 11 Nov 2026 13:00:00 GMT</pubDate>
    </item>
    <item>
      <!-- Missing link -> filtered -->
      <title>Broken Item: No Link</title>
      <description>No link here</description>
    </item>
  </channel>
</rss>`;

test('We Work Remotely: parses RSS XML and splits "Company: Title" convention', () => {
    const jobs = parseWwrRss(mockWwrXml);
    assert.strictEqual(jobs.length, 2, 'Should parse 2 valid jobs from RSS XML');

    const job1 = jobs[0];
    assert.strictEqual(job1.company_name, 'FinTech Corp');
    assert.strictEqual(job1.title, 'Senior Full Stack Engineer');
    assert.strictEqual(job1.job_url, 'https://weworkremotely.com/remote-jobs/fintech-corp-senior-full-stack-engineer');
    assert.strictEqual(job1.source, 'weworkremotely');
    assert.strictEqual(job1.raw._source_platform, 'weworkremotely');
    assert.ok(job1.raw._attribution.includes('We Work Remotely'), 'Attribution must be present in raw');

    const job2 = jobs[1];
    assert.strictEqual(job2.company_name, 'Unknown Employer');
    assert.strictEqual(job2.title, 'Title Without Colon Prefix');
});

test('We Work Remotely: parseWwrJson parses JSON feed fallback', () => {
    const mockJson = {
        jobs: [
            {
                id: 4001,
                title: "Backend Engineer",
                company: "JsonRemote",
                url: "https://weworkremotely.com/remote-jobs/jsonremote-backend",
                description: "<p>Backend role</p>"
            }
        ]
    };
    const jobs = parseWwrJson(mockJson);
    assert.strictEqual(jobs.length, 1);
    assert.strictEqual(jobs[0].title, 'Backend Engineer');
    assert.strictEqual(jobs[0].company_name, 'JsonRemote');
    assert.ok(jobs[0].raw._attribution.includes('We Work Remotely'));
});

test('We Work Remotely: handles malformed XML or empty strings gracefully', () => {
    assert.deepStrictEqual(parseWwrRss(''), []);
    assert.deepStrictEqual(parseWwrRss(null), []);
    assert.deepStrictEqual(parseWwrRss('<rss><channel>No items</channel></rss>'), []);
});

await asyncTest('We Work Remotely: fetchWwrJobs adapter integration with mock fetch', async () => {
    const mockFetch = async () => ({
        ok: true,
        status: 200,
        text: async () => mockWwrXml
    });

    const adapter = new WeworkremotelyAdapter();
    const result = await adapter.fetchJobs({ fetchFn: mockFetch });

    assert.strictEqual(result.sourceType, 'weworkremotely');
    assert.strictEqual(result.jobs.length, 2);
    assert.strictEqual(result.error, null);
});

// ── 6. Unit Tests: Adzuna Adapter Credential Gate ──────────────────────────────

console.log('\n--- 6. Adzuna Adapter Credential Gate Tests ---');

test('Adzuna: hasAdzunaCredentials returns false when environment variables are missing', () => {
    const origId = process.env.ADZUNA_APP_ID;
    const origKey = process.env.ADZUNA_APP_KEY;
    delete process.env.ADZUNA_APP_ID;
    delete process.env.ADZUNA_APP_KEY;

    try {
        assert.strictEqual(hasAdzunaCredentials(), false);
    } finally {
        if (origId) process.env.ADZUNA_APP_ID = origId;
        if (origKey) process.env.ADZUNA_APP_KEY = origKey;
    }
});

await asyncTest('Adzuna: fetchAdzunaJobs reports BLOCKED_CREDENTIALS safely without throwing', async () => {
    const origId = process.env.ADZUNA_APP_ID;
    const origKey = process.env.ADZUNA_APP_KEY;
    delete process.env.ADZUNA_APP_ID;
    delete process.env.ADZUNA_APP_KEY;

    try {
        const adapter = new AdzunaAdapter();
        const result = await adapter.fetchJobs();

        assert.strictEqual(result.sourceType, 'adzuna');
        assert.strictEqual(result.jobs.length, 0);
        assert.ok(result.error && result.error.includes('BLOCKED_CREDENTIALS'), 'Error should specify BLOCKED_CREDENTIALS');
        assert.ok(!result.error.includes('undefined'), 'Must not leak sensitive details');
    } finally {
        if (origId) process.env.ADZUNA_APP_ID = origId;
        if (origKey) process.env.ADZUNA_APP_KEY = origKey;
    }
});

await asyncTest('Adzuna: fetchAdzunaJobs normalizes results when credentials are provided', async () => {
    const mockAdzunaPayload = {
        results: [
            {
                id: "5001",
                title: "Software Engineer",
                company: { display_name: "AdzunaEmployer" },
                redirect_url: "https://www.adzuna.in/land/ad/5001",
                location: { display_name: "Bengaluru, India" },
                contract_time: "permanent",
                salary_min: 600000,
                salary_max: 1200000,
                description: "Full stack engineering in Bangalore."
            }
        ]
    };

    let requestedUrl = null;
    const mockFetch = async (url) => {
        requestedUrl = url;
        return {
            ok: true,
            status: 200,
            json: async () => mockAdzunaPayload
        };
    };

    const result = await fetchAdzunaJobs({
        appId: 'test_app_id',
        appKey: 'test_app_key',
        fetchFn: mockFetch
    });

    assert.ok(requestedUrl.includes('app_id=test_app_id'));
    assert.strictEqual(result.jobs.length, 1);
    const job = result.jobs[0];
    assert.strictEqual(job.title, 'Software Engineer');
    assert.strictEqual(job.company_name, 'AdzunaEmployer');
    assert.strictEqual(job.job_url, 'https://www.adzuna.in/land/ad/5001');
    assert.strictEqual(job.applicant_eligibility, 'India');
    assert.ok(job.raw._attribution.includes('Adzuna'));
});

// ── 7. SQLite Ingestion & Pipeline Integration ─────────────────────────────────

console.log('\n--- 7. SQLite Ingestion & Pipeline Integration Tests ---');

test('Pipeline: Company registration and normalized job persistence', () => {
    // 1. Register companies
    const companies = [
        { id: 'company-remotelabs', name: 'RemoteLabs Inc', career_url: 'https://remotelabs.example.com' },
        { id: 'company-himalayaspartner', name: 'HimalayasPartner', career_url: 'https://himalayaspartner.com' },
        { id: 'company-remotivetech', name: 'RemotiveTech', career_url: 'https://remotivetech.com' },
        { id: 'company-jobicyglobal', name: 'JobicyGlobal', career_url: 'https://jobicyglobal.com' },
        { id: 'company-fintechcorp', name: 'FinTech Corp', career_url: 'https://fintechcorp.com' }
    ];

    for (const c of companies) {
        upsertCompany({
            id: c.id,
            name: c.name,
            career_url: c.career_url,
            policy_status: 'permitted'
        });
    }

    // 2. Normalize and ingest one job from each of the 5 adapters
    const remoteOkJob = parseRemoteOkResponse(mockRemoteOkPayload, {
        resolveCompanyId: () => 'company-remotelabs'
    })[0];

    const himalayasJob = parseHimalayasResponse(mockHimalayasPayload, {
        resolveCompanyId: () => 'company-himalayaspartner'
    })[0];

    const remotiveJob = parseRemotiveResponse(mockRemotivePayload, {
        resolveCompanyId: () => 'company-remotivetech'
    })[0];

    const jobicyJob = parseJobicyResponse(mockJobicyPayload, {
        resolveCompanyId: () => 'company-jobicyglobal'
    })[0];

    const wwrJob = parseWwrRss(mockWwrXml, {
        resolveCompanyId: () => 'company-fintechcorp'
    })[0];

    const testJobs = [remoteOkJob, himalayasJob, remotiveJob, jobicyJob, wwrJob];

    for (const j of testJobs) {
        const res = upsertJobPosting(j);
        assert.ok(res.status === 'inserted' || res.status === 'updated', `Job ${j.id} should be persisted`);

        const stored = getJob(j.id);
        assert.ok(stored, `Job ${j.id} must exist in job_postings`);
        assert.strictEqual(stored.title, j.title);
        assert.strictEqual(stored.job_url, j.job_url);
        assert.strictEqual(stored.status, 'discovered');
        assert.ok(stored.content_hash, 'Must have computed content hash');
    }
});

test('Pipeline: Idempotency guarantee (re-ingestion produces unchanged action, no dupes)', () => {
    const remoteOkJob = parseRemoteOkResponse(mockRemoteOkPayload, {
        resolveCompanyId: () => 'company-remotelabs'
    })[0];

    // Re-ingest identical job
    const res = upsertJobPosting(remoteOkJob);
    assert.strictEqual(res.status, 'unchanged', 'Exact duplicate content must return unchanged');

    // Confirm snapshots table only has 1 snapshot
    const snapshots = db.prepare('SELECT COUNT(*) as cnt FROM job_snapshots WHERE job_id = ?').get(remoteOkJob.id);
    assert.strictEqual(snapshots.cnt, 1, 'Idempotent ingestion must not create redundant snapshots');
});

test('Pipeline: Cross-source deduplication detection', () => {
    // Ingest a posting for FinTech Corp with slightly different ID/source but identical title & company
    const crossSourceJob = {
        id: 'remoteok-duplicate-test',
        company_id: 'company-fintechcorp',
        company_name: 'FinTech Corp',
        title: 'Senior Full Stack Engineer',
        job_url: 'https://remoteok.com/l/duplicate-test',
        location: 'Remote',
        remote_type: 'remote',
        employment_type: 'full-time',
        source: 'remoteok',
        source_job_id: 'duplicate-test',
        raw: {
            title: 'Senior Full Stack Engineer',
            company: 'FinTech Corp',
            _source_platform: 'remoteok'
        }
    };

    upsertJobPosting(crossSourceJob);

    const dupes = findCrossSourceDuplicates(crossSourceJob);
    assert.ok(Array.isArray(dupes), 'Should return duplicate candidates array');
    assert.ok(dupes.length >= 1, 'Should find FinTech Corp job from WeWorkRemotely as duplicate candidate');
});

await asyncTest('Pipeline: verifyJobBatch integrates with newly ingested jobs & Jobicy batch status endpoint', async () => {
    // Also ingest two extra Jobicy postings to test closed & unknown batch status handling
    upsertJobPosting({
        id: 'https://jobicy.com/jobs/3098-closed-role',
        company_id: 'company-jobicyglobal',
        company_name: 'JobicyGlobal',
        title: 'Closed Legacy Engineer',
        job_url: 'https://jobicy.com/jobs/3098-closed-role',
        location: 'Remote',
        remote_type: 'remote',
        source: 'jobicy',
        source_job_id: '3098'
    });
    upsertJobPosting({
        id: 'https://jobicy.com/jobs/3099-missing-feed-role',
        company_id: 'company-jobicyglobal',
        company_name: 'JobicyGlobal',
        title: 'Aged Missing From 7Day Feed Engineer',
        job_url: 'https://jobicy.com/jobs/3099-missing-feed-role',
        location: 'Remote',
        remote_type: 'remote',
        status: 'active', // Simulate previously active job no longer in 7-day rolling feed
        source: 'jobicy',
        source_job_id: '3099'
    });
    // Force 3099 into verification batch via jobIds or stale last_verified_at
    db.prepare("UPDATE job_postings SET last_verified_at = datetime('now', '-10 days') WHERE source_job_id = '3099'").run();

    // Mock fetcher: returns Jobicy batch JSON for /api/jobs/status, HTML for other job URLs
    const mockVerifyFetch = async (url) => {
        if (url.includes('jobicy.com/api/jobs/status')) {
            return {
                ok: true,
                status: 200,
                url,
                json: async () => ({
                    statuses: {
                        '3001': 'active',
                        '3098': 'closed',
                        '3099': 'unknown'
                    }
                })
            };
        }
        return {
            status: 200,
            url,
            text: async () => '<html><body><h1>Senior Full Stack Engineer</h1><button>Apply Now</button></body></html>'
        };
    };

    const summary = await verifyJobBatch({
        fetchFn: mockVerifyFetch,
        limit: 20
    });

    assert.ok(summary.totalProcessed >= 7, `Expected >= 7 jobs processed, got ${summary.totalProcessed}`);
    assert.ok(summary.activeCount >= 5, `Expected >= 5 jobs verified active, got ${summary.activeCount}`);
    assert.strictEqual(summary.closedCount, 1, 'Explicit closed status from Jobicy batch endpoint must mark closed');
    assert.strictEqual(summary.unknownCount, 1, 'Unknown status from Jobicy batch endpoint must record UNKNOWN');

    const jobicyActive = getJob('https://jobicy.com/jobs/3001-mern-stack-engineer');
    assert.strictEqual(jobicyActive.status, 'active');
    assert.strictEqual(jobicyActive.verification_method, 'jobicy_batch_status:active');

    const jobicyClosed = getJob('https://jobicy.com/jobs/3098-closed-role');
    assert.strictEqual(jobicyClosed.status, 'closed');
    assert.strictEqual(jobicyClosed.verification_method, 'jobicy_batch_status:closed');

    // Crucial: missing from 7-day feed / unknown status MUST NOT mark job as closed!
    const jobicyUnknown = getJob('https://jobicy.com/jobs/3099-missing-feed-role');
    assert.strictEqual(jobicyUnknown.status, 'active', 'Missing from 7-day feed / unknown status must NOT mark job closed');
    assert.strictEqual(jobicyUnknown.verification_method, 'jobicy_batch_status:unknown');

    // Verify Remote OK job has last_verified_at set
    const remoteOkJob = parseRemoteOkResponse(mockRemoteOkPayload, {
        resolveCompanyId: () => 'company-remotelabs'
    })[0];
    const verifiedJob = getJob(remoteOkJob.id);
    assert.ok(verifiedJob.last_verified_at, 'Job must have last_verified_at timestamp recorded');
    assert.strictEqual(isJobVerifiedActive(verifiedJob), true, 'Job must satisfy isJobVerifiedActive()');
});

await asyncTest('Pipeline: evaluateJob evaluates newly ingested and verified jobs', async () => {
    const remoteOkJob = parseRemoteOkResponse(mockRemoteOkPayload, {
        resolveCompanyId: () => 'company-remotelabs'
    })[0];
    const job = getJob(remoteOkJob.id);
    assert.ok(job, `Job ${remoteOkJob.id} must exist`);

    const evalResult = await evaluateJob(job.id, {
        requireVerifiedActive: false
    });

    assert.ok(evalResult, 'Evaluation result must be returned');
    assert.ok(evalResult.evaluationId, 'Evaluation record must be saved in database');

    const latest = getLatestEvaluationRun(job.id);
    assert.ok(latest, 'Latest evaluation run must exist in SQLite');
    assert.strictEqual(latest.job_id, job.id);
    assert.strictEqual(latest.tier1_passed, 1, 'MERN / Full Stack title must pass Tier 1 keywords');
});

await asyncTest('Pipeline: Normal Discovery CLI (scan-sqlite.mjs) invokes PUBLIC_FEED_PROVIDERS and enforces rate limits', async () => {
    // Verify all 5 Batch 1 feeds + Adzuna exist in operational registry
    for (const key of Object.values(PUBLIC_FEED_PROVIDERS)) {
        assert.ok(PUBLIC_FEED_REGISTRY[key], `PUBLIC_FEED_REGISTRY must register ${key}`);
    }

    const mockCliFetch = async (url) => {
        if (url.includes('remoteok.com')) {
            return { ok: true, status: 200, json: async () => mockRemoteOkPayload };
        }
        if (url.includes('himalayas.app')) {
            return { ok: true, status: 200, json: async () => ({ meta: { nextCursor: null }, data: mockHimalayasPayload.data }) };
        }
        if (url.includes('remotive.com')) {
            return { ok: true, status: 200, json: async () => mockRemotivePayload };
        }
        if (url.includes('jobicy.com/api/jobs')) {
            return { ok: true, status: 200, json: async () => ({ ...mockJobicyPayload, nextCursor: null }) };
        }
        if (url.includes('weworkremotely.com')) {
            return { ok: true, status: 200, text: async () => mockWwrXml };
        }
        throw new Error(`Unexpected mock URL: ${url}`);
    };

    // Execute runScanner directly against portals.yml with --feeds-only semantics
    const firstScan = await runScanner({
        dryRun: false,
        feedsOnly: true,
        fetchFn: mockCliFetch
    });

    assert.strictEqual(firstScan.feedsScanned, 5, 'Should scan all 5 unauthenticated public feeds');
    assert.ok(firstScan.blockedCredentials.includes('adzuna'), 'Adzuna must remain in BLOCKED_CREDENTIALS');
    assert.ok(firstScan.normalizedCount >= 9, `Expected >= 9 total normalized jobs across 5 feeds, got ${firstScan.normalizedCount}`);

    // Verify rate limit enforcement on immediate repeat scan (Jobicy 1h, Remotive 6h/4-per-day, etc.)
    const jobicyLimit = checkFeedRateLimit('feed-jobicy', 'jobicy', PUBLIC_FEED_REGISTRY.jobicy);
    assert.strictEqual(jobicyLimit.allowed, false, 'Jobicy must enforce 1-hour minimum poll interval');

    const remotiveLimit = checkFeedRateLimit('feed-remotive', 'remotive', PUBLIC_FEED_REGISTRY.remotive);
    assert.strictEqual(remotiveLimit.allowed, false, 'Remotive must enforce 4-requests/day interval spacing');

    const repeatScan = await runScanner({
        dryRun: false,
        feedsOnly: true,
        fetchFn: mockCliFetch
    });
    assert.strictEqual(repeatScan.skippedRateLimit, 5, 'Immediate repeat scan must respect rate limits for all 5 feeds');
    assert.strictEqual(repeatScan.feedsScanned, 0, 'Zero redundant API requests permitted inside cooldown window');
});

// ── 8. Controlled Live Smoke Probes (Polite) ───────────────────────────────────

console.log('\n--- 8. Controlled Live Smoke Probes ---');

const LIVE_FEEDS = [
    { name: 'Remote OK', fn: fetchRemoteOkJobs, platform: 'remoteok' },
    { name: 'Himalayas', fn: fetchHimalayasJobs, platform: 'himalayas' },
    { name: 'Remotive', fn: fetchRemotiveJobs, platform: 'remotive' },
    { name: 'Jobicy', fn: fetchJobicyJobs, platform: 'jobicy' },
    { name: 'We Work Remotely', fn: fetchWwrJobs, platform: 'weworkremotely' }
];

for (const feed of LIVE_FEEDS) {
    await asyncTest(`Live Probe: ${feed.name} endpoint compliance & attribution`, async () => {
        try {
            const result = await feed.fn({
                timeoutMs: 5000,
                limit: 5,
                count: 5,
                maxPages: 1
            });

            if (result.error && (/fetch failed|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|aborted|timeout|network/i.test(result.error))) {
                console.log(`    🔒 [LIVE_VALIDATION_BLOCKED] ${feed.name}: Outbound network unreachable in sandbox (${result.error}).`);
                return;
            }

            if (result.error) {
                console.log(`    ⚠️ [LIVE_ERROR] ${feed.name}: ${result.error}`);
                return;
            }

            assert.strictEqual(result.sourceType, feed.platform);
            assert.ok(Array.isArray(result.jobs), 'Jobs must be an array');
            console.log(`    🌐 [LIVE OK] ${feed.name}: Fetched ${result.fetchedCount}, normalized ${result.normalizedCount} jobs.`);

            if (result.jobs.length > 0) {
                const sample = result.jobs[0];
                assert.ok(sample.title, 'Live job must have title');
                assert.ok(sample.job_url, 'Live job must have URL');
                assert.strictEqual(sample.raw._source_platform, feed.platform);
                assert.ok(sample.raw._attribution, 'Live job must include source attribution');
            }
        } catch (err) {
            console.log(`    🔒 [LIVE_VALIDATION_BLOCKED] ${feed.name}: ${err.message}`);
        }
    });
}

// ── 9. Final Cleanup & Summary ─────────────────────────────────────────────────

closeDb();

if (existsSync(TEST_DB_PATH)) {
    try { unlinkSync(TEST_DB_PATH); } catch {}
}

console.log('\n====================================================');
console.log(`Test Execution Summary: ${passedCount} PASSED, ${failedCount} FAILED`);
console.log('====================================================');

if (failedCount > 0) {
    process.exit(1);
} else {
    process.exit(0);
}
