/**
 * test-massive-expansion.mjs — Comprehensive Verification Suite for Massive Source Coverage Expansion
 *
 * Verifies Phases 0 through 9:
 *   - Phase 0: Forensic Inventory, Canonical DB Invariant, Target Employer Truth (Rule 5 & 16)
 *   - Phase 1: Employer Registry (140+ verified employers, zero fake URLs)
 *   - Phase 2: ATS Catalog (25+ ATS engines, Amazon Jobs, Breezy, Pinpoint)
 *   - Phase 3: Direct Job Boards Registry (19 platforms, terms check, JobSpy truth)
 *   - Phase 4: Public Feeds & Jooble (Credentials requirement, normalization)
 *   - Phase 5: Generic Career Crawler & ATS Router (Strategy classification, fallback)
 *   - Phase 6: Source Health & R20 Quarantine (Healthy empty response vs failure)
 *   - Phase 7: Normalization Contract (Preserves all provenance & URLs)
 *   - Phase 8: Coverage & Operating Metrics Reporter
 *   - Canonical Database Immutability Guarantee
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

// Enforce fail-closed test mode and isolated test database
process.env.CAREER_OPS_TEST = '1';
process.env.JOB_AGENT_DB_PATH = 'data/test_expansion.db';

const CANONICAL_DB_PATH = path.resolve('data/job_agent.db');
function getFileHash(filePath) {
    if (!fs.existsSync(filePath)) return null;
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}
const CANONICAL_HASH_BEFORE = getFileHash(CANONICAL_DB_PATH);

let passed = 0;
let failed = 0;

function it(desc, fn) {
    try {
        fn();
        console.log(`  ✓ ${desc}`);
        passed++;
    } catch (err) {
        console.error(`  ✗ ${desc}`);
        console.error(err);
        failed++;
    }
}

async function itAsync(desc, fn) {
    try {
        await fn();
        console.log(`  ✓ ${desc}`);
        passed++;
    } catch (err) {
        console.error(`  ✗ ${desc}`);
        console.error(err);
        failed++;
    }
}

console.log('====================================================');
console.log('🧪 MASSIVE SOURCE COVERAGE EXPANSION TEST SUITE');
console.log('====================================================\n');

// ── Phase 0 & Invariants: Canonical DB & Target Employers Audit ────────────
console.log('--- Phase 0: Forensic Inventory & Target Employer Truth ---');

it('Canonical DB baseline hash matches expected pre-test state', () => {
    assert.strictEqual(CANONICAL_HASH_BEFORE, '27b8fbd8bb88396d9c0282475566ecc58711e27c0f3022e5b416989eac8f8c6b');
});

// ── Phase 1: Verified Employer Registry ────────────────────────────────────
console.log('\n--- Phase 1: Verified Employer Registry ---');
import { employerRegistry } from './discovery/employer-registry.mjs';

it('Loads 140+ verified employers from employer_registry.json', () => {
    const employers = employerRegistry.getAllEmployers();
    assert.ok(employers.length >= 140, `Expected at least 140 employers, got ${employers.length}`);
});

it('Every employer has non-empty name, canonical ID, and official career URL', () => {
    const employers = employerRegistry.getAllEmployers();
    for (const emp of employers) {
        assert.ok(emp.id && emp.id.startsWith('company-'), `Invalid ID for ${emp.name}`);
        assert.ok(emp.name && emp.name.trim().length > 0, `Missing name for ${emp.id}`);
        assert.ok(emp.career_url && emp.career_url.startsWith('http'), `Missing valid career_url for ${emp.name}`);
        assert.ok(emp.industry, `Missing industry for ${emp.name}`);
        assert.ok(emp.country, `Missing country for ${emp.name}`);
    }
});

it('All required target employer groups are present in registry', () => {
    // 1. Indian IT
    assert.ok(employerRegistry.findEmployerByName('TCS'), 'TCS must exist');
    assert.ok(employerRegistry.findEmployerByName('Infosys'), 'Infosys must exist');
    assert.ok(employerRegistry.findEmployerByName('Wipro'), 'Wipro must exist');
    assert.ok(employerRegistry.findEmployerByName('HCLTech'), 'HCLTech must exist');
    assert.ok(employerRegistry.findEmployerByName('Tech Mahindra'), 'Tech Mahindra must exist');
    assert.ok(employerRegistry.findEmployerByName('LTIMindtree'), 'LTIMindtree must exist');

    // 2. Global IT
    assert.ok(employerRegistry.findEmployerByName('Accenture'), 'Accenture must exist');
    assert.ok(employerRegistry.findEmployerByName('IBM'), 'IBM must exist');
    assert.ok(employerRegistry.findEmployerByName('Deloitte'), 'Deloitte must exist');

    // 3. Product / Enterprise
    assert.ok(employerRegistry.findEmployerByName('Microsoft'), 'Microsoft must exist');
    assert.ok(employerRegistry.findEmployerByName('Amazon'), 'Amazon must exist');
    assert.ok(employerRegistry.findEmployerByName('Google'), 'Google must exist');
    assert.ok(employerRegistry.findEmployerByName('Cisco'), 'Cisco must exist');

    // 4. Hardware / Semiconductors
    assert.ok(employerRegistry.findEmployerByName('Intel'), 'Intel must exist');
    assert.ok(employerRegistry.findEmployerByName('NVIDIA'), 'NVIDIA must exist');

    // 5. FinTech
    assert.ok(employerRegistry.findEmployerByName('JPMorgan Chase'), 'JPMorgan Chase must exist');
    assert.ok(employerRegistry.findEmployerByName('Goldman Sachs'), 'Goldman Sachs must exist');

    // 6. Indian Product / Startups
    assert.ok(employerRegistry.findEmployerByName('Flipkart'), 'Flipkart must exist');
    assert.ok(employerRegistry.findEmployerByName('PhonePe'), 'PhonePe must exist');
    assert.ok(employerRegistry.findEmployerByName('Swiggy'), 'Swiggy must exist');
    assert.ok(employerRegistry.findEmployerByName('Zomato'), 'Zomato must exist');
    assert.ok(employerRegistry.findEmployerByName('Razorpay'), 'Razorpay must exist');
});

// ── Phase 2: ATS Provider Catalog & New Adapters ───────────────────────────
console.log('\n--- Phase 2: ATS Provider Catalog & New Adapters ---');
import { ATS_CATALOG, detectAtsFromUrl } from './discovery/ats-catalog.mjs';
import { AmazonJobsAdapter } from './discovery/adapters/amazon-jobs.mjs';
import { BreezyAdapter } from './discovery/adapters/breezy.mjs';
import { PinpointAdapter } from './discovery/adapters/pinpoint.mjs';

it('ATS catalog documents 25+ distinct ATS engines with technical contracts', () => {
    const keys = Object.keys(ATS_CATALOG);
    assert.ok(keys.length >= 25, `Expected at least 25 ATS engines, got ${keys.length}`);
    assert.ok(ATS_CATALOG.greenhouse, 'Greenhouse documented');
    assert.ok(ATS_CATALOG.lever, 'Lever documented');
    assert.ok(ATS_CATALOG.ashby, 'Ashby documented');
    assert.ok(ATS_CATALOG.workday, 'Workday documented');
    assert.ok(ATS_CATALOG.oracle_cloud, 'Oracle Cloud documented');
    assert.ok(ATS_CATALOG.taleo, 'Taleo documented');
    assert.ok(ATS_CATALOG.successfactors, 'SuccessFactors documented');
    assert.ok(ATS_CATALOG.amazon_jobs, 'Amazon Jobs documented');
});

it('detectAtsFromUrl accurately classifies ATS signatures from URLs', () => {
    const gh = detectAtsFromUrl('https://boards.greenhouse.io/postman');
    assert.strictEqual(gh.ats_type, 'greenhouse');

    const lev = detectAtsFromUrl('https://jobs.lever.co/paytm');
    assert.strictEqual(lev.ats_type, 'lever');

    const ash = detectAtsFromUrl('https://jobs.ashbyhq.com/meesho');
    assert.strictEqual(ash.ats_type, 'ashby');

    const wd = detectAtsFromUrl('https://salesforce.wd12.myworkdayjobs.com/External_Career_Site');
    assert.strictEqual(wd.ats_type, 'workday');

    const amz = detectAtsFromUrl('https://www.amazon.jobs/en/jobs/12345');
    assert.strictEqual(amz.ats_type, 'amazon_jobs');

    const br = detectAtsFromUrl('https://mycompany.breezy.hr/p/abc123');
    assert.strictEqual(br.ats_type, 'breezy');

    const pp = detectAtsFromUrl('https://techcorp.pinpointhq.com/postings/55');
    assert.strictEqual(pp.ats_type, 'pinpoint');
});

await itAsync('AmazonJobsAdapter parses mock payload into normalized jobs', async () => {
    const mockPayload = {
        hits: 1,
        jobs: [
            {
                id_icims: '10513905',
                title: 'Software Development Engineer I',
                city: 'Bengaluru',
                state: 'Karnataka',
                country_code: 'IND',
                schedule_type_id: 'full-time',
                basic_qualifications: 'B.Tech in Computer Science and 6+ months experience in Node.js or Java.',
                preferred_qualifications: 'Knowledge of AWS, Docker and distributed systems.',
                job_path: '/en/jobs/10513905/software-development-engineer-i'
            }
        ]
    };

    const mockFetch = async () => ({
        status: 200,
        ok: true,
        json: async () => mockPayload
    });

    const adapter = new AmazonJobsAdapter({ fetchFn: mockFetch });
    const result = await adapter.fetchJobs();

    assert.strictEqual(result.status, 'SUCCESS');
    assert.strictEqual(result.jobs.length, 1);
    const job = result.jobs[0];
    assert.strictEqual(job.title, 'Software Development Engineer I');
    assert.strictEqual(job.company_name, 'Amazon');
    assert.strictEqual(job.source, 'amazon_jobs');
    assert.strictEqual(job.source_job_id, 'amazon_10513905');
    assert.strictEqual(job.job_url, 'https://www.amazon.jobs/en/jobs/10513905/software-development-engineer-i');
    assert.ok(job.description.includes('Basic Qualifications'));
});

await itAsync('BreezyAdapter parses JSON feed into normalized jobs', async () => {
    const mockFeed = [
        {
            id: 'breezy_101',
            name: 'Backend Developer (Node.js)',
            url: 'https://acme.breezy.hr/p/101-backend-developer',
            location: { name: 'Remote, India' },
            type: { id: 'fullTime', name: 'Full-Time' },
            summary: 'Develop REST and GraphQL microservices in TypeScript and Node.js.'
        }
    ];

    const mockFetch = async () => ({
        status: 200,
        ok: true,
        json: async () => mockFeed
    });

    const adapter = new BreezyAdapter({ fetchFn: mockFetch });
    const result = await adapter.fetchJobs({ subdomain: 'acme' });

    assert.strictEqual(result.status, 'SUCCESS');
    assert.strictEqual(result.jobs.length, 1);
    assert.strictEqual(result.jobs[0].title, 'Backend Developer (Node.js)');
    assert.strictEqual(result.jobs[0].source, 'breezy');
    assert.strictEqual(result.jobs[0].job_url, 'https://acme.breezy.hr/p/101-backend-developer');
});

await itAsync('PinpointAdapter parses postings JSON into normalized jobs', async () => {
    const mockFeed = {
        data: [
            {
                id: 'pp_909',
                title: 'Full Stack Engineer',
                location_name: 'Bengaluru, India',
                employment_type: 'Full-time',
                url: 'https://globex.pinpointhq.com/postings/pp_909',
                description: 'Full stack development with React and Express.'
            }
        ]
    };

    const mockFetch = async () => ({
        status: 200,
        ok: true,
        json: async () => mockFeed
    });

    const adapter = new PinpointAdapter({ fetchFn: mockFetch });
    const result = await adapter.fetchJobs({ subdomain: 'globex' });

    assert.strictEqual(result.status, 'SUCCESS');
    assert.strictEqual(result.jobs.length, 1);
    assert.strictEqual(result.jobs[0].title, 'Full Stack Engineer');
    assert.strictEqual(result.jobs[0].source, 'pinpoint');
});

// ── Phase 3: Direct Job Boards Registry ────────────────────────────────────
console.log('\n--- Phase 3: Direct Job Boards Registry ---');
import { DIRECT_JOB_BOARDS_REGISTRY, getJobBoardDetails } from './discovery/job-boards-registry.mjs';

it('Registers all 19 direct job-board platforms across India and International', () => {
    const boards = Object.keys(DIRECT_JOB_BOARDS_REGISTRY);
    assert.strictEqual(boards.length, 19);

    const indiaExpected = ['naukri', 'foundit', 'timesjobs', 'shine', 'cutshort', 'instahyre', 'wellfound', 'hirist', 'internshala', 'unstop', 'freshersworld', 'apna'];
    const intlExpected = ['indeed', 'linkedin', 'glassdoor', 'ziprecruiter', 'bayt', 'bdjobs', 'hellowork'];

    for (const b of indiaExpected) assert.ok(DIRECT_JOB_BOARDS_REGISTRY[b], `India board ${b} missing`);
    for (const b of intlExpected) assert.ok(DIRECT_JOB_BOARDS_REGISTRY[b], `Intl board ${b} missing`);
});

it('Explicitly documents JobSpy status as UNOFFICIAL_SCRAPER_BRIDGE and not authorized API', () => {
    const naukri = getJobBoardDetails('naukri');
    assert.strictEqual(naukri.jobspy_status, 'UNOFFICIAL_SCRAPER_BRIDGE');
    assert.strictEqual(naukri.operational_status, 'PERMISSION_REQUIRED');

    const linkedin = getJobBoardDetails('linkedin');
    assert.strictEqual(linkedin.jobspy_status, 'UNOFFICIAL_SCRAPER_BRIDGE');
    assert.strictEqual(linkedin.operational_status, 'PERMISSION_REQUIRED');
});

// ── Phase 4: Public Feeds & Jooble ─────────────────────────────────────────
console.log('\n--- Phase 4: Public Feeds & Jooble ---');
import { JoobleAdapter } from './discovery/adapters/jooble.mjs';

await itAsync('JoobleAdapter reports CREDENTIALS_REQUIRED when API key is missing', async () => {
    const adapter = new JoobleAdapter({ apiKey: null });
    const result = await adapter.fetchJobs();
    assert.strictEqual(result.status, 'CREDENTIALS_REQUIRED');
    assert.strictEqual(result.jobs.length, 0);
});

await itAsync('JoobleAdapter parses valid payload into normalized jobs when key present', async () => {
    const mockPayload = {
        totalCount: 1,
        jobs: [
            {
                id: 'jb_777',
                title: 'Junior Web Developer',
                company: 'Tech Solutions India',
                location: 'Noida, India',
                type: 'full-time',
                link: 'https://jooble.org/desc/777',
                snippet: 'Entry level web development role with HTML, CSS, JavaScript, and Node.js.'
            }
        ]
    };

    const mockFetch = async () => ({
        status: 200,
        ok: true,
        json: async () => mockPayload
    });

    const adapter = new JoobleAdapter({ apiKey: 'test_key_123', fetchFn: mockFetch });
    const result = await adapter.fetchJobs();

    assert.strictEqual(result.status, 'SUCCESS');
    assert.strictEqual(result.jobs.length, 1);
    assert.strictEqual(result.jobs[0].title, 'Junior Web Developer');
    assert.strictEqual(result.jobs[0].company_name, 'Tech Solutions India');
    assert.strictEqual(result.jobs[0].source, 'jooble');
});

// ── Phase 5: Generic Career Crawler & ATS Router ───────────────────────────
console.log('\n--- Phase 5: Generic Career Crawler & ATS Router ---');
import { careerCrawler } from './discovery/career-crawler.mjs';

it('CareerCrawler classifies Greenhouse/Lever/Ashby companies as NATIVE_ATS', () => {
    const ghComp = { career_url: 'https://boards.greenhouse.io/postman' };
    assert.strictEqual(careerCrawler.classifyStrategy(ghComp).strategy, 'NATIVE_ATS');

    const levComp = { career_url: 'https://jobs.lever.co/paytm' };
    assert.strictEqual(careerCrawler.classifyStrategy(levComp).strategy, 'NATIVE_ATS');

    const ashComp = { career_url: 'https://jobs.ashbyhq.com/meesho' };
    assert.strictEqual(careerCrawler.classifyStrategy(ashComp).strategy, 'NATIVE_ATS');
});

it('CareerCrawler classifies enterprise/custom portals as CRAWLER', () => {
    const tcsComp = { career_url: 'https://ibegin.tcs.com/iBegin/' };
    assert.strictEqual(careerCrawler.classifyStrategy(tcsComp).strategy, 'CRAWLER');

    const orcComp = { career_url: 'https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001' };
    assert.strictEqual(careerCrawler.classifyStrategy(orcComp).strategy, 'CRAWLER');
});

it('CareerCrawler builds generic fallback opportunity when crawl fails', () => {
    const fallback = careerCrawler._buildFallbackOpportunity(
        { id: 'company-test', name: 'Test Corp', country: 'India' },
        'https://testcorp.com/careers',
        'Timeout connecting'
    );
    assert.ok(fallback, 'Fallback job created');
    assert.strictEqual(fallback.title, 'Test Corp Open Opportunities');
    assert.strictEqual(fallback.source, 'career_page_fallback');
    assert.strictEqual(fallback.job_url, 'https://testcorp.com/careers');
});

// ── Phase 6: Source Health and R20 Quarantine ──────────────────────────────
console.log('\n--- Phase 6: Source Health and R20 Quarantine ---');
import { SourceQuarantineManager } from './discovery/source-quarantine.mjs';

const tempStateFile = path.resolve('scratch/test-quarantine-state.json');
if (fs.existsSync(tempStateFile)) fs.unlinkSync(tempStateFile);

const testQuarantine = new SourceQuarantineManager({ stateFile: tempStateFile, threshold: 3 });

it('Healthy zero-result responses do NOT trigger quarantine and reset operational failures', () => {
    // 1 operational failure
    testQuarantine.recordSourceRun('test_feed', { jobsFound: 0, error: 'HTTP 500' });
    assert.strictEqual(testQuarantine.isSourceQuarantined('test_feed'), false);
    assert.strictEqual(testQuarantine.getSourceQuarantineStatus('test_feed').consecutiveOperationalFailures, 1);

    // Healthy zero vacancy response
    testQuarantine.recordSourceRun('test_feed', { jobsFound: 0, error: null });
    assert.strictEqual(testQuarantine.isSourceQuarantined('test_feed'), false);
    assert.strictEqual(testQuarantine.getSourceQuarantineStatus('test_feed').consecutiveOperationalFailures, 0);
    assert.strictEqual(testQuarantine.getSourceQuarantineStatus('test_feed').consecutiveEmptyRuns, 1);
});

it('3 consecutive operational failures triggers Rule R20 quarantine with exponential backoff', () => {
    testQuarantine.recordSourceRun('failing_feed', { jobsFound: 0, error: 'HTTP 403 Forbidden' });
    testQuarantine.recordSourceRun('failing_feed', { jobsFound: 0, error: 'HTTP 403 Forbidden' });
    assert.strictEqual(testQuarantine.isSourceQuarantined('failing_feed'), false);

    testQuarantine.recordSourceRun('failing_feed', { jobsFound: 0, error: 'HTTP 403 Forbidden' });
    assert.strictEqual(testQuarantine.isSourceQuarantined('failing_feed'), true);
    const status = testQuarantine.getSourceQuarantineStatus('failing_feed');
    assert.strictEqual(status.lastErrorType, 'HTTP_403');
    assert.ok(status.retryAfterMs > Date.now(), 'Retry after must be in the future');
});

it('Permanent retirement marks source retired permanently', () => {
    testQuarantine.retireSource('dead_service', 'Service shut down permanently');
    assert.strictEqual(testQuarantine.isSourceRetired('dead_service'), true);
    assert.strictEqual(testQuarantine.isSourceQuarantined('dead_service'), true);
});

if (fs.existsSync(tempStateFile)) fs.unlinkSync(tempStateFile);

// ── Phase 7: Normalization and Deduplication ───────────────────────────────
console.log('\n--- Phase 7: Normalization and Deduplication ---');
import { createNormalizedJob } from './discovery/adapters/base.mjs';

it('createNormalizedJob preserves all required provenance, dates, and URL fields', () => {
    const job = createNormalizedJob({
        company_name: 'Acme Corp',
        title: 'Backend Engineer',
        location: 'Bengaluru, India',
        job_url: 'https://acme.com/jobs/101',
        apply_url: 'https://acme.com/apply/101',
        employer_career_url: 'https://acme.com/careers',
        source: 'naukri',
        source_job_id: 'naukri_8899',
        published_at: '2026-11-10T00:00:00Z',
        raw: { test: true }
    });

    assert.strictEqual(job.company_name, 'Acme Corp');
    assert.strictEqual(job.title, 'Backend Engineer');
    assert.strictEqual(job.source, 'naukri');
    assert.strictEqual(job.source_job_id, 'naukri_8899');
    assert.strictEqual(job.job_url, 'https://acme.com/jobs/101');
    assert.strictEqual(job.apply_url, 'https://acme.com/apply/101');
    assert.strictEqual(job.employer_career_url, 'https://acme.com/careers');
    assert.strictEqual(job.published_at, '2026-11-10T00:00:00.000Z');
    assert.ok(job.discovered_at, 'Discovered at must be populated');
    assert.ok(job.last_seen_at, 'Last seen at must be populated');
});

// ── Phase 8: Coverage & Operating Metrics Reporter ─────────────────────────
console.log('\n--- Phase 8: Coverage & Operating Metrics Reporter ---');
import { coverageReporter } from './discovery/coverage-reporter.mjs';

it('coverageReporter generates structured report with employer and connector metrics', () => {
    const report = coverageReporter.generateReport();
    assert.ok(report.employers.totalRegistered >= 140, 'Total employers >= 140');
    assert.ok(report.employers.verifiedCareerUrls >= 140, 'Verified career URLs >= 140');
    assert.ok(report.connectors.totalAtsEnginesCataloged >= 25, 'Cataloged ATS >= 25');
    assert.ok(report.connectors.directJobBoardsTotal === 19, 'Direct job boards == 19');
    assert.ok(report.connectors.publicFeedsActive >= 10, 'Public feeds >= 10');
    assert.ok(report.throughputTiers.tier1_high_frequency, 'Throughput tiers defined');
});

// ── Invariant Check: Canonical Database Immutability ───────────────────────
console.log('\n--- Canonical Database Immutability Check ---');
it('Canonical database SHA-256 remains 100% byte-identical', () => {
    const hashAfter = getFileHash(CANONICAL_DB_PATH);
    assert.strictEqual(hashAfter, CANONICAL_HASH_BEFORE, 'Canonical database must NOT be modified');
});

// Cleanup test db
import { closeDb } from './db/db.mjs';
closeDb();
['data/test_expansion.db', 'data/test_expansion.db-shm', 'data/test_expansion.db-wal'].forEach(f => {
    try {
        if (fs.existsSync(f)) fs.unlinkSync(f);
    } catch {
        // ignore if locked
    }
});

console.log(`\n====================================================`);
console.log(`📊 Expansion Test Summary: ${passed} PASSED, ${failed} FAILED`);
console.log(`====================================================`);

if (failed > 0) process.exit(1);
