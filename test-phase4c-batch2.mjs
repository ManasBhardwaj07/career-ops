/**
 * test-phase4c-batch2.mjs — Phase 4C Batch 2 Verification Suite
 *
 * Strictly uses an isolated temporary SQLite database (`data/test_phase4c_batch2.db`).
 * Never touches canonical `data/job_agent.db`.
 *
 * Covers:
 *   1. Section 0 Fix: `createCompany()` string return bug fixed in `discovery/leads/resolver.mjs`
 *      (genuinely new company + idempotent second resolution + schema `source_type` policy safety)
 *   2. Shared Employer Identity Resolver (`discovery/leads/company-resolver.mjs`):
 *      - Priority 1..5 (domain, exact name, alias, parent/acquisition, ATS board)
 *      - Ambiguous conflict stays pending rather than silently guessing
 *   3. Hacker News Who is Hiring (`discovery/adapters/hackernews.mjs`):
 *      - Algolia & Firebase thread discovery
 *      - Thread hash caching / redundant scan skip
 *      - Conservative parsing, email/PII redaction, rejection of discussion/deleted/dead/for-hire comments
 *      - HN permalink + direct ATS URL preservation + cross-source deduplication + `'discovered'` initial state
 *   4. Compliant Y Combinator Discovery (`discovery/adapters/yc.mjs`):
 *      - Blocks `workatastartup.com`, login/internal/apply endpoints
 *      - Enforces `robots.txt` + SSRF checks
 *      - Public YC profile -> official domain -> `/careers` -> ATS detection & board validation -> real jobs
 *      - YC profile never inserted as a job posting
 *   5. Normal Discovery Orchestration (`scan-sqlite.mjs` `runScanner` `--source hackernews` & `--source yc`)
 *   6. End-to-End Verification + Evaluation Pipeline (`verifyJobBatch()` + `evaluateJob()`)
 */

import assert from 'node:assert';
import { existsSync, mkdirSync, unlinkSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DB_PATH = resolve(__dirname, 'data', 'test_phase4c_batch2.db');
const CANONICAL_DB_PATH = resolve(__dirname, 'data', 'job_agent.db');
const TEST_PORTALS_PATH = resolve(__dirname, 'data', 'test_portals_batch2.yml');

process.env.JOB_AGENT_DB_PATH = TEST_DB_PATH;

function cleanupFiles() {
    for (const f of [TEST_DB_PATH, `${TEST_DB_PATH}-wal`, `${TEST_DB_PATH}-shm`, TEST_PORTALS_PATH]) {
        if (existsSync(f)) {
            try { unlinkSync(f); } catch { /* ignore */ }
        }
    }
}

cleanupFiles();
mkdirSync(resolve(__dirname, 'data'), { recursive: true });

const { getDb, closeDb, getDbPath } = await import('./db/db.mjs');
const resolvedDbPath = resolve(getDbPath());
if (resolvedDbPath === CANONICAL_DB_PATH) {
    throw new Error(`SAFETY ABORT: test-phase4c-batch2.mjs resolved to canonical DB (${resolvedDbPath})`);
}

const { runMigrations } = await import('./db/migrate.js');
import {
    createCompany,
    getCompany,
    addCompanyAlias,
    ingestSearchLead,
    getLeadById,
    getLeadByCanonicalUrl,
    getObservationsForLead,
    getSourcePolicy,
    getJob,
    getLatestEvaluationRun,
    findCrossSourceDuplicates,
    upsertCandidateFact
} from './db/repo.mjs';
import { resolveSingleLead } from './discovery/leads/resolver.mjs';
import {
    resolveCompanyIdentity,
    registerCompanyCareerSurface
} from './discovery/leads/company-resolver.mjs';
import {
    discoverHnHiringThreads,
    fetchHnThreadComments,
    parseHnHiringComment,
    fetchHackerNewsHiringJobs
} from './discovery/adapters/hackernews.mjs';
import {
    validateYcPublicUrl,
    parseYcProfileHtml,
    fetchYcStartupJobs
} from './discovery/adapters/yc.mjs';
import { runScanner } from './scan-sqlite.mjs';
import { verifyJobBatch, verifySingleJob, isJobVerifiedActive } from './verification/verify-jobs.mjs';
import { evaluateJob } from './matching/scheduler.mjs';

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

console.log('\n==================================================');
console.log('🧪 Phase 4C Batch 2 Verification Suite (Isolated DB)');
console.log('==================================================\n');

runMigrations();

// Seed minimal candidate facts for evaluateJob()
upsertCandidateFact({
    id: 'fact-role-1',
    category: 'role',
    identifier: 'target_role',
    value: 'Full Stack Engineer',
    verified: true
});
upsertCandidateFact({
    id: 'fact-loc-1',
    category: 'location',
    identifier: 'authorized_country',
    value: 'India',
    verified: true
});

/* ------------------------------------------------------------------ */
/* 1. Section 0: Company-Resolution Bug Fix & Schema Policy Safety    */
/* ------------------------------------------------------------------ */
console.log('--- 1. Section 0 Corrections (resolver.mjs & policy CHECK) ---');

await asyncTest('resolver.mjs fixes createCompany() string return for a genuinely new company', async () => {
    const leadRes = ingestSearchLead({
        provider: 'manual',
        query: 'new startup role',
        rawUrl: 'https://brandnewstartup.example/careers/senior-eng-101',
        title: 'Senior Backend Engineer',
        companyName: 'BrandNewStartup Labs'
    });
    const lead = getLeadById(leadRes.leadId);
    const resolution = await resolveSingleLead(lead, { createMissingCompany: true });

    assert.strictEqual(resolution.resolved, true, 'Lead should resolve with new company stub');
    assert.ok(resolution.companyId && typeof resolution.companyId === 'string', 'Must return non-null string companyId');
    const createdCompany = getCompany(resolution.companyId);
    assert.ok(createdCompany, 'Company row must exist in DB');
    assert.strictEqual(createdCompany.domain, 'brandnewstartup.example');
    assert.strictEqual(createdCompany.lifecycle_status, 'UNVERIFIED');
});

await asyncTest('resolver.mjs idempotency: second lead for same new company reuses existing companyId', async () => {
    const leadRes2 = ingestSearchLead({
        provider: 'manual',
        query: 'new startup role 2',
        rawUrl: 'https://brandnewstartup.example/careers/staff-eng-102',
        title: 'Staff Systems Engineer',
        companyName: 'BrandNewStartup Labs'
    });
    const lead2 = getLeadById(leadRes2.leadId);
    const resolution2 = await resolveSingleLead(lead2, { createMissingCompany: true });

    assert.strictEqual(resolution2.resolved, true);
    const matches = getDb().prepare('SELECT id FROM companies WHERE domain = ?').all('brandnewstartup.example');
    assert.strictEqual(matches.length, 1, 'Must not create duplicate company rows');
    assert.strictEqual(resolution2.companyId, matches[0].id);
});

test('source_policies enforces schema source_type CHECK while allowing ATS and custom surfaces', () => {
    const compId = createCompany({
        id: 'company-policy-check',
        name: 'Policy Check Inc',
        domain: 'policycheck.example'
    });

    assert.throws(() => {
        registerCompanyCareerSurface({
            companyId: compId,
            policySourceType: 'yc',
            policyEndpoint: 'https://www.ycombinator.com/companies/policy-check'
        });
    }, /Invalid policy source_type/, 'Must reject invalid source_type values outside CHECK constraint');

    registerCompanyCareerSurface({
        companyId: compId,
        careerUrl: 'https://policycheck.example/careers',
        policySourceType: 'custom',
        policyEndpoint: 'https://policycheck.example/careers'
    });
    const customPolicy = getSourcePolicy(compId, 'custom');
    assert.ok(customPolicy && customPolicy.enabled === 1);
});

/* ------------------------------------------------------------------ */
/* 2. Shared Employer Identity Resolver                               */
/* ------------------------------------------------------------------ */
console.log('\n--- 2. Shared Employer Resolver Priority & Ambiguity ---');

test('company-resolver resolves by domain > exact name > alias > parent > ATS board and blocks ambiguity', () => {
    const parentId = createCompany({
        id: 'company-parent-alpha',
        name: 'Alpha Holdings Corp',
        domain: 'alphaholdings.example',
        ats_type: 'lever',
        board_identifier: 'alphaholdings'
    });
    const childId = createCompany({
        id: 'company-child-beta',
        name: 'Beta Cloud',
        domain: 'betacloud.example',
        parent_company_id: parentId,
        ats_type: 'ashby',
        board_identifier: 'betacloud-hq'
    });
    addCompanyAlias(childId, 'Beta Systems', 'manual');

    // Domain match (ignoring ATS host)
    const byDomain = resolveCompanyIdentity({
        name: 'Completely Different Label',
        websiteUrl: 'https://www.betacloud.example/about'
    });
    assert.strictEqual(byDomain.resolved, true);
    assert.strictEqual(byDomain.matchType, 'domain');
    assert.strictEqual(byDomain.companyId, childId);
    assert.strictEqual(byDomain.parentCompany?.id, parentId);

    // Exact name with legal suffix stripped
    const byName = resolveCompanyIdentity({ name: 'Beta Cloud Inc.' });
    assert.strictEqual(byName.resolved, true);
    assert.strictEqual(byName.companyId, childId);

    // Verified alias match
    const byAlias = resolveCompanyIdentity({ name: 'Beta Systems' });
    assert.strictEqual(byAlias.resolved, true);
    assert.strictEqual(byAlias.matchType, 'alias');
    assert.strictEqual(byAlias.companyId, childId);

    // ATS board identity match
    const byAts = resolveCompanyIdentity({
        name: 'Beta ATS Name',
        atsType: 'ashby',
        boardIdentifier: 'betacloud-hq'
    });
    assert.strictEqual(byAts.resolved, true);
    assert.strictEqual(byAts.matchType, 'ats_board');
    assert.strictEqual(byAts.companyId, childId);

    // Ambiguous conflict: same name, conflicting official domain -> MUST NOT merge arbitrarily
    const conflict = resolveCompanyIdentity({
        name: 'Beta Cloud',
        domain: 'other-betacloud.example',
        createIfMissing: true
    });
    assert.strictEqual(conflict.resolved, false);
    assert.strictEqual(conflict.ambiguous, true);
    assert.strictEqual(conflict.matchType, 'domain_conflict');
});

/* ------------------------------------------------------------------ */
/* 3. Hacker News Hiring Connector                                    */
/* ------------------------------------------------------------------ */
console.log('\n--- 3. Hacker News Who is Hiring Connector ---');

await asyncTest('discoverHnHiringThreads works via Algolia and falls back cleanly to Firebase', async () => {
    const nowSec = Math.floor(Date.now() / 1000) - 3600;
    const algoliaMockFetch = async (url) => {
        if (url.includes('hn.algolia.com')) {
            return new Response(JSON.stringify({
                hits: [
                    { objectID: '4100001', title: 'Ask HN: Who wants to be hired? (Nov 2026)', created_at_i: nowSec, num_comments: 40 },
                    { objectID: '4100002', title: 'Ask HN: Who is hiring? (November 2026)', created_at_i: nowSec, num_comments: 312 }
                ]
            }), { status: 200 });
        }
        throw new Error(`Unexpected URL ${url}`);
    };

    const algoliaThreads = await discoverHnHiringThreads({ limit: 3, fetchFn: algoliaMockFetch });
    assert.strictEqual(algoliaThreads.length, 1);
    assert.strictEqual(algoliaThreads[0].threadId, 4100002);
    assert.strictEqual(algoliaThreads[0].via, 'algolia');

    // Now simulate Algolia failing -> Firebase fallback
    const firebaseMockFetch = async (url) => {
        if (url.includes('hn.algolia.com')) return new Response('error', { status: 503 });
        if (url.endsWith('/user/whoishiring.json')) {
            return new Response(JSON.stringify({ submitted: [5100001, 5100002] }), { status: 200 });
        }
        if (url.endsWith('/item/5100001.json')) {
            return new Response(JSON.stringify({ id: 5100001, title: 'Ask HN: Who is hiring? (November 2026)', time: nowSec, kids: [601, 602] }), { status: 200 });
        }
        if (url.endsWith('/item/5100002.json')) {
            return new Response(JSON.stringify({ id: 5100002, title: 'Ask HN: Freelancer? Seeking freelancer?', time: nowSec, kids: [] }), { status: 200 });
        }
        return new Response('not found', { status: 404 });
    };

    const fbThreads = await discoverHnHiringThreads({ limit: 2, fetchFn: firebaseMockFetch });
    assert.strictEqual(fbThreads.length, 1);
    assert.strictEqual(fbThreads[0].threadId, 5100001);
    assert.strictEqual(fbThreads[0].via, 'firebase');
});

test('parseHnHiringComment extracts valid jobs, strips PII emails, and rejects non-job/deleted/reply comments', () => {
    const validComment = {
        id: 7001001,
        parent: 8000000,
        time: Math.floor(Date.now() / 1000),
        text: 'StreamForge (YC W24) | Senior Backend Engineer | San Francisco / Remote | $180k - $220k + equity | Full-time<p>Stack: Go, TypeScript, PostgreSQL, Kubernetes. US only. Email jobs@streamforge.example or recruiter.jane@streamforge.example or apply at <a href="https://boards.greenhouse.io/streamforge/jobs/987654">https://boards.greenhouse.io/streamforge/jobs/987654</a>.</p>'
    };
    const parsed = parseHnHiringComment(validComment, { threadId: 8000000 });
    assert.strictEqual(parsed.valid, true);
    assert.strictEqual(parsed.companyName, 'StreamForge');
    assert.strictEqual(parsed.ycBatch, 'W24');
    assert.strictEqual(parsed.roleTitle, 'Senior Backend Engineer');
    assert.strictEqual(parsed.remoteType, 'remote');
    assert.strictEqual(parsed.atsType, 'greenhouse');
    assert.strictEqual(parsed.boardIdentifier, 'streamforge');
    assert.strictEqual(parsed.permalink, 'https://news.ycombinator.com/item?id=7001001');
    assert.strictEqual(parsed.canonicalJobUrl, 'https://boards.greenhouse.io/streamforge/jobs/987654');
    assert.ok(parsed.compensation && parsed.compensation.includes('$180k'), 'Compensation should be parsed');
    assert.ok(parsed.techStack.includes('TypeScript') && parsed.techStack.includes('Go'));
    assert.ok(!parsed.description.includes('recruiter.jane@streamforge.example'), 'Recruiter email PII must be redacted');
    assert.ok(!parsed.description.includes('jobs@streamforge.example'), 'All raw emails must be redacted');

    // Rejection cases
    assert.strictEqual(parseHnHiringComment({ id: 7001002, deleted: true, text: 'x' }, { threadId: 8000000 }).rejectReason, 'deleted_or_dead');
    assert.strictEqual(parseHnHiringComment({ id: 7001003, parent: 7001001, text: 'Great company! Agree with this.' }, { threadId: 8000000 }).rejectReason, 'discussion_reply');
    assert.strictEqual(parseHnHiringComment({ id: 7001004, parent: 8000000, text: 'FOR HIRE: Senior Go Developer looking for remote work anywhere.' }, { threadId: 8000000 }).rejectReason, 'non_hiring_comment');
    assert.strictEqual(parseHnHiringComment({ id: 7001005, parent: 8000000, text: 'Short ping' }, { threadId: 8000000 }).rejectReason, 'empty_or_too_short');
    assert.strictEqual(parseHnHiringComment({ id: 7001006, parent: 8000000, text: 'Hey everyone, is this thread slow this month or just me? Thanks for checking!' }, { threadId: 8000000 }).valid, false);
});

await asyncTest('fetchHackerNewsHiringJobs persists discovered jobs, skips cached unchanged thread, and tracks provenance', async () => {
    const nowSec = Math.floor(Date.now() / 1000) - 1800;
    const mockHnFetch = async (url) => {
        if (url.includes('search_by_date')) {
            return new Response(JSON.stringify({
                hits: [{ objectID: '9100000', title: 'Ask HN: Who is hiring? (November 2026)', created_at_i: nowSec, num_comments: 3 }]
            }), { status: 200 });
        }
        if (url.includes('/items/9100000')) {
            return new Response(JSON.stringify({
                id: 9100000,
                title: 'Ask HN: Who is hiring? (November 2026)',
                created_at_i: nowSec,
                children: [
                    {
                        id: 9100001,
                        parent_id: 9100000,
                        created_at_i: nowSec,
                        text: 'VectorPeak | Staff Distributed Systems Engineer | Bengaluru / Remote (India) | https://vectorpeak.example/careers'
                    },
                    {
                        id: 9100002,
                        parent_id: 9100000,
                        created_at_i: nowSec,
                        text: 'StreamForge (YC W24) | Senior Backend Engineer | San Francisco / Remote | https://boards.greenhouse.io/streamforge/jobs/987654'
                    },
                    {
                        id: 9100003,
                        parent_id: 9100000,
                        created_at_i: nowSec,
                        text: 'For Hire: Full stack developer seeking contract role in Europe.'
                    },
                    {
                        id: 9100004,
                        parent_id: 9100000,
                        created_at_i: nowSec,
                        text: 'NoLinkStartup | Platform Engineer | Remote (US) | Email founder if interested'
                    }
                ]
            }), { status: 200 });
        }
        if (url === 'https://boards-api.greenhouse.io/v1/boards/streamforge/jobs?content=true') {
            return new Response(JSON.stringify({
                jobs: [
                    {
                        id: 987654,
                        title: 'Senior Backend Engineer',
                        location: { name: 'San Francisco / Remote' },
                        absolute_url: 'https://boards.greenhouse.io/streamforge/jobs/987654',
                        content: 'StreamForge role from ATS',
                        updated_at: new Date().toISOString()
                    },
                    {
                        id: 987655,
                        title: 'Staff Infrastructure Engineer',
                        location: { name: 'Remote' },
                        absolute_url: 'https://boards.greenhouse.io/streamforge/jobs/987655',
                        content: 'Extra live ATS role discovered by scanning HN board',
                        updated_at: new Date().toISOString()
                    }
                ]
            }), { status: 200 });
        }
        return new Response('not found', { status: 404 });
    };

    const run1 = await fetchHackerNewsHiringJobs({
        maxThreads: 1,
        maxComments: 20,
        fetchFn: mockHnFetch
    });

    assert.strictEqual(run1.threadsScanned, 1);
    assert.strictEqual(run1.commentsParsed, 3);
    assert.strictEqual(run1.commentsRejected, 1);
    assert.strictEqual(run1.jobsInserted, 3);
    assert.strictEqual(run1.atsBoardsDiscovered, 1);
    assert.strictEqual(run1.atsBoardsScanned, 1, 'Discovered HN ATS board should be scanned cleanly');
    assert.strictEqual(run1.atsJobsFetched, 2, 'Live ATS jobs fetched from HN-discovered board');
    assert.strictEqual(run1.atsJobsInserted, 1, 'Additional unindexed ATS job inserted without duplicating 987654');

    const hnJob = getJob('https://news.ycombinator.com/item?id=9100001');
    assert.ok(hnJob, 'VectorPeak job should be stored with HN permalink URL when no specific ATS job URL exists');
    assert.strictEqual(hnJob.status, 'discovered', 'New HN job must enter as discovered, NOT active');
    assert.strictEqual(isJobVerifiedActive(hnJob), false, 'Must not be active before live verification');

    const noLinkJob = getJob('https://news.ycombinator.com/item?id=9100004');
    assert.ok(noLinkJob, 'HN comment without external apply URL preserves permalink as provenance');
    const noLinkCheck = await verifySingleJob(noLinkJob, {
        fetchFn: async () => new Response('<html><body>Apply Now</body></html>', { status: 200 })
    });
    assert.strictEqual(noLinkCheck.outcome, 'UNKNOWN', 'HN discussion permalink without employer URL must NEVER be confirmed active');
    assert.strictEqual(getJob('https://news.ycombinator.com/item?id=9100004').status, 'discovered');

    const lead = getLeadByCanonicalUrl('https://news.ycombinator.com/item?id=9100001');
    assert.ok(lead && lead.resolution_status === 'resolved_job', 'source_leads provenance must exist');

    // Second run on unchanged thread should hit cache and skip redundant re-parsing
    const run2 = await fetchHackerNewsHiringJobs({
        maxThreads: 1,
        maxComments: 20,
        fetchFn: mockHnFetch
    });
    assert.strictEqual(run2.threadsSkippedCached, 1, 'Unchanged HN thread should be skipped by thread hash cache');
    assert.strictEqual(run2.threadsScanned, 0);
});

/* ------------------------------------------------------------------ */
/* 4. Y Combinator Public Discovery Connector                         */
/* ------------------------------------------------------------------ */
console.log('\n--- 4. Y Combinator Public Profile & ATS Connector ---');

test('validateYcPublicUrl strictly blocks Work at a Startup, auth, internal APIs, and apply routes', () => {
    assert.strictEqual(validateYcPublicUrl('https://www.ycombinator.com/companies/streamforge').allowed, true);
    assert.strictEqual(validateYcPublicUrl('https://www.ycombinator.com/companies/sitemap.xml').allowed, true);
    assert.strictEqual(validateYcPublicUrl('https://www.workatastartup.com/jobs/123').allowed, false);
    assert.strictEqual(validateYcPublicUrl('https://workatastartup.com/companies').allowed, false);
    assert.strictEqual(validateYcPublicUrl('https://www.ycombinator.com/api/v1/jobs').allowed, false);
    assert.strictEqual(validateYcPublicUrl('https://www.ycombinator.com/login').allowed, false);
    assert.strictEqual(validateYcPublicUrl('https://www.ycombinator.com/companies/acme/apply').allowed, false);
});

test('parseYcProfileHtml extracts public company metadata safely without false ATS/website links', () => {
    const sampleHtml = `
        <html>
          <head>
            <script type="application/ld+json">
              {"@type": "Organization", "name": "QuantumGrid", "url": "https://quantumgrid.example", "description": "Grid orchestration platform"}
            </script>
          </head>
          <body>
            <h1>QuantumGrid</h1>
            <span>W24</span>
            <a href="https://twitter.com/quantumgrid">Twitter</a>
            <a href="https://quantumgrid.example">Website</a>
          </body>
        </html>
    `;
    const parsed = parseYcProfileHtml(sampleHtml, 'https://www.ycombinator.com/companies/quantumgrid');
    assert.strictEqual(parsed.name, 'QuantumGrid');
    assert.strictEqual(parsed.officialDomain, 'quantumgrid.example');
    assert.strictEqual(parsed.batch, 'W24');
    assert.strictEqual(parsed.ycProfileUrl, 'https://www.ycombinator.com/companies/quantumgrid');
});

await asyncTest('fetchYcStartupJobs follows profile -> robots check -> /careers -> Greenhouse API -> real jobs & blocks disallowed robots', async () => {
    const mockFetchRouter = async (url) => {
        // Robots.txt checks (includes real YC-style Disallow: /companies?* query pattern)
        if (url === 'https://www.ycombinator.com/robots.txt') {
            return new Response('User-agent: *\nDisallow: /companies?*\nAllow: /companies/', { status: 200 });
        }
        if (url === 'https://quantumgrid.example/robots.txt') {
            return new Response('User-agent: *\nAllow: /', { status: 200 });
        }
        if (url === 'https://robotsblocked.example/robots.txt') {
            return new Response('User-agent: *\nDisallow: /', { status: 200 });
        }
        // Public YC profiles
        if (url === 'https://www.ycombinator.com/companies/quantumgrid') {
            return new Response(`
                <html><body>
                    <h1>QuantumGrid</h1><span>S24</span>
                    <a href="https://quantumgrid.example">Website</a>
                </body></html>
            `, { status: 200 });
        }
        if (url === 'https://www.ycombinator.com/companies/robotsblocked') {
            return new Response(`
                <html><body>
                    <h1>RobotsBlockedCo</h1>
                    <a href="https://robotsblocked.example">Website</a>
                </body></html>
            `, { status: 200 });
        }
        // Official employer pages
        if (url === 'https://quantumgrid.example' || url === 'https://quantumgrid.example/') {
            return new Response('<html><body><a href="/careers">Careers</a></body></html>', { status: 200 });
        }
        if (url === 'https://quantumgrid.example/careers') {
            return new Response('<html><body><a href="https://boards.greenhouse.io/quantumgrid">Open Roles</a></body></html>', { status: 200 });
        }
        // Validated Greenhouse API endpoint
        if (url === 'https://boards-api.greenhouse.io/v1/boards/quantumgrid/jobs?content=true') {
            return new Response(JSON.stringify({
                jobs: [
                    {
                        id: 445501,
                        title: 'Full Stack Software Engineer',
                        location: { name: 'Bengaluru, India' },
                        absolute_url: 'https://boards.greenhouse.io/quantumgrid/jobs/445501',
                        content: '<p>Build distributed grid systems in TypeScript and Go.</p>',
                        updated_at: new Date().toISOString()
                    }
                ]
            }), { status: 200 });
        }
        return new Response('Not found', { status: 404 });
    };

    const res = await fetchYcStartupJobs({
        companyUrls: [
            'https://www.workatastartup.com/jobs/999', // must be policy-blocked
            'https://www.ycombinator.com/companies/quantumgrid',
            'https://www.ycombinator.com/companies/robotsblocked'
        ],
        fetchJobsFromAts: true,
        fetchFn: mockFetchRouter
    });

    assert.strictEqual(res.blockedUrls, 1, 'workatastartup.com URL must be blocked');
    assert.strictEqual(res.atsBoardsValidated, 1, 'QuantumGrid Greenhouse board must validate');
    assert.strictEqual(res.jobsInserted, 1, 'Greenhouse job from YC company must be persisted');

    // YC profile itself must NOT be a job_posting
    assert.strictEqual(getJob('https://www.ycombinator.com/companies/quantumgrid'), undefined, 'YC company profile must NEVER be stored as a job posting');

    // Company should have registered career_url, ats_type, board_identifier, and policy
    const qg = resolveCompanyIdentity({ domain: 'quantumgrid.example' }).company;
    assert.ok(qg, 'QuantumGrid company must exist');
    assert.strictEqual(qg.ats_type, 'greenhouse');
    assert.strictEqual(qg.board_identifier, 'quantumgrid');
    assert.strictEqual(qg.career_url, 'https://quantumgrid.example/careers');

    // Robots-blocked employer must NOT have ATS or homepage jobs crawled
    const rb = resolveCompanyIdentity({ domain: 'robotsblocked.example' }).company;
    assert.ok(rb, 'RobotsBlockedCo metadata parsed from public YC profile still recorded conservatively');
    assert.strictEqual(rb.career_url, null, 'Disallowed website /careers must not be crawled');

    // Real ATS job entered as 'discovered'
    const qgJob = getJob('https://boards.greenhouse.io/quantumgrid/jobs/445501');
    assert.ok(qgJob && qgJob.status === 'discovered');
});

/* ------------------------------------------------------------------ */
/* 5. CLI Orchestration & Cross-Source Deduplication                  */
/* ------------------------------------------------------------------ */
console.log('\n--- 5. Discovery Orchestration (scan-sqlite.mjs) & Cross-Source Dedup ---');

await asyncTest('scan-sqlite.mjs runScanner supports --source hackernews and --source yc cleanly', async () => {
    writeFileSync(TEST_PORTALS_PATH, `
title_filter:
  include: ["engineer", "software", "backend", "full stack", "developer"]
  exclude: ["intern"]
startup_sources:
  - provider: hackernews
    enabled: true
    options:
      maxThreads: 1
      maxComments: 10
      forceRescan: true
  - provider: yc
    enabled: true
    options:
      slugs: ["cloudpulse"]
      maxCompanies: 3
`, 'utf-8');

    const nowSec = Math.floor(Date.now() / 1000);
    const cliMockFetch = async (url) => {
        if (url.includes('hn.algolia.com/api/v1/search_by_date')) {
            return new Response(JSON.stringify({
                hits: [{ objectID: '9200000', title: 'Ask HN: Who is hiring? (December 2026)', created_at_i: nowSec, num_comments: 1 }]
            }), { status: 200 });
        }
        if (url.includes('hn.algolia.com/api/v1/items/9200000')) {
            return new Response(JSON.stringify({
                id: 9200000,
                title: 'Ask HN: Who is hiring? (December 2026)',
                created_at_i: nowSec,
                children: [
                    {
                        id: 9200001,
                        parent_id: 9200000,
                        created_at_i: nowSec,
                        // Same CloudPulse role posted directly via Greenhouse elsewhere -> cross-source duplicate test!
                        text: 'CloudPulse | Senior Backend Engineer | Remote | https://cloudpulse.example/careers'
                    }
                ]
            }), { status: 200 });
        }
        if (url === 'https://www.ycombinator.com/robots.txt') {
            return new Response('User-agent: *\nAllow: /companies/', { status: 200 });
        }
        if (url === 'https://www.ycombinator.com/companies/cloudpulse') {
            return new Response('<html><body><h1>CloudPulse</h1><span>W24</span><a href="https://cloudpulse.example">Web</a></body></html>', { status: 200 });
        }
        if (url === 'https://cloudpulse.example/robots.txt') {
            return new Response('User-agent: *\nAllow: /', { status: 200 });
        }
        if (url === 'https://cloudpulse.example' || url === 'https://cloudpulse.example/careers') {
            return new Response('<html><body><a href="https://boards.greenhouse.io/cloudpulse">Jobs</a></body></html>', { status: 200 });
        }
        if (url === 'https://boards-api.greenhouse.io/v1/boards/cloudpulse/jobs?content=true') {
            return new Response(JSON.stringify({
                jobs: [{
                    id: 987659,
                    title: 'Senior Backend Engineer',
                    location: { name: 'Remote' },
                    absolute_url: 'https://boards.greenhouse.io/cloudpulse/jobs/987659',
                    content: 'Backend role',
                    updated_at: new Date().toISOString()
                }]
            }), { status: 200 });
        }
        return new Response('', { status: 404 });
    };

    const hnSummary = await runScanner({
        filterSource: 'hackernews',
        forceRateLimit: true,
        fetchFn: cliMockFetch,
        portalsPath: TEST_PORTALS_PATH
    });
    assert.ok(hnSummary.byFeed.hackernews?.status === 'OK', 'HN scan via runScanner must succeed');
    assert.strictEqual(hnSummary.insertedCount, 1);

    const ycSummary = await runScanner({
        filterSource: 'yc',
        forceRateLimit: true,
        fetchFn: cliMockFetch,
        portalsPath: TEST_PORTALS_PATH
    });
    assert.ok(ycSummary.byFeed.yc?.status === 'OK', 'YC scan via runScanner must succeed');

    // Cross-source duplicate check: HN comment 9200001 matches existing StreamForge Greenhouse job by company+title!
    const dupMatches = findCrossSourceDuplicates(getJob('https://news.ycombinator.com/item?id=9200001'));
    assert.ok(dupMatches.length >= 1, 'Cross-source duplicate between HN post and Greenhouse job should be detected');
});

/* ------------------------------------------------------------------ */
/* 6. End-to-End Verification + Eligibility Evaluation + Integrity    */
/* ------------------------------------------------------------------ */
console.log('\n--- 6. Full E2E Pipeline: Verification + Evaluation + SQLite Integrity ---');

await asyncTest('verifyJobBatch verifies live HN/YC jobs to active and handles closed jobs', async () => {
    const mockVerifyFetch = async (url) => {
        if (url.includes('445501')) {
            return new Response('<html><body>Full Stack Software Engineer Apply Now</body></html>', { status: 200 });
        }
        if (url.includes('987654')) {
            return new Response('<html><body>Senior Backend Engineer StreamForge Apply Now</body></html>', { status: 200 });
        }
        if (url.includes('boards-api.greenhouse.io/v1/boards/quantumgrid/jobs')) {
            return new Response(JSON.stringify({
                jobs: [
                    {
                        id: 445501,
                        title: 'Junior Software Engineer',
                        absolute_url: 'https://boards.greenhouse.io/quantumgrid/jobs/445501',
                        location: { name: 'Bengaluru, India' },
                        updated_at: '2026-11-12T00:00:00Z',
                        content: 'Node.js TypeScript React SQL'
                    }
                ]
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (url.includes('vectorpeak.example/careers')) {
            return new Response('<html><body>Job no longer accepting applications - position filled</body></html>', { status: 404 });
        }
        return new Response('<html><body><h1>Open Position</h1><button>Apply Now</button></body></html>', { status: 200 });
    };

    const vRes = await verifyJobBatch({
        fetchFn: mockVerifyFetch,
        limit: 20
    });
    assert.ok(vRes.totalProcessed >= 3);
    assert.ok(vRes.activeCount >= 2);
    assert.strictEqual(vRes.expiredCount, 1, '404 HN posting should be marked expired');
    assert.strictEqual(getJob('https://news.ycombinator.com/item?id=9100001').status, 'expired');

    const activeYcJob = getJob('https://boards.greenhouse.io/quantumgrid/jobs/445501');
    assert.strictEqual(isJobVerifiedActive(activeYcJob), true, 'YC->Greenhouse job must now be verified active');

    const evalRes = await evaluateJob(activeYcJob.id, { requireVerifiedActive: true });
    assert.ok(evalRes && evalRes.evaluationId, 'Verified active job must evaluate cleanly');
    const latestEval = getLatestEvaluationRun(activeYcJob.id);
    assert.ok(latestEval, 'job_evaluation_runs record must exist');
});

test('Isolated DB passes PRAGMA integrity_check and foreign_key_check', () => {
    const db = getDb();
    const ic = db.prepare('PRAGMA integrity_check').all();
    const fk = db.prepare('PRAGMA foreign_key_check').all();
    assert.strictEqual(ic[0]?.integrity_check, 'ok');
    assert.strictEqual(fk.length, 0, `Expected 0 FK violations, got ${fk.length}`);
});

closeDb();
cleanupFiles();

console.log('\n==================================================');
console.log(`📊 Batch 2 Suite Summary: ${passed} passed, ${failed} failed`);
console.log('==================================================\n');

if (failed > 0) {
    process.exit(1);
}
