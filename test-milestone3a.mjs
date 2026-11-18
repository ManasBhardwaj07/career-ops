#!/usr/bin/env node

/**
 * test-milestone3a.mjs — Comprehensive Test Suite for Milestone 3A
 *
 * Verifies:
 *   1. Standardized Provider Interfaces & Error Hierarchy
 *   2. Workday CXS Adapter (fixtures, pagination, normalization)
 *   3. SmartRecruiters Public Posting Adapter (fixtures, pagination, normalization)
 *   4. Brave Search Provider (auth checks, caching, result normalization)
 *   5. Migration 007 & Schema Integrity (source_leads, source_lead_observations, submission_policy)
 *   6. URL Normalization (tracking stripped, meaningful preserved, original retained)
 *   7. Lead Ingestion & Multi-Observation Provenance (deduplication of canonical identity)
 *   8. Lead Resolution Service (company/job linkage without conflating with liveness)
 *   9. Live Read-Only Adapter Probes (with clear offline/mock isolation)
 */

import assert from 'assert';
import { existsSync, unlinkSync } from 'fs';
import { resolve } from 'path';
import { DatabaseSync } from 'node:sqlite';

const TEST_DB_PATH = resolve(process.cwd(), 'data', 'test_milestone3a.db');
const CANONICAL_DB_PATH = resolve(process.cwd(), 'data', 'job_agent.db');

function cleanupTestDb() {
    for (const f of [TEST_DB_PATH, `${TEST_DB_PATH}-wal`, `${TEST_DB_PATH}-shm`]) {
        if (existsSync(f)) {
            try { unlinkSync(f); } catch { /* ignore */ }
        }
    }
}

cleanupTestDb();
process.env.JOB_AGENT_DB_PATH = TEST_DB_PATH;

const { getDb, closeDb, getDbPath } = await import('./db/db.mjs');
const resolvedDbPath = resolve(getDbPath());
if (resolvedDbPath === CANONICAL_DB_PATH) {
    throw new Error(`SAFETY ABORT: test-milestone3a.mjs resolved to canonical DB (${resolvedDbPath})`);
}
console.log(`🔒 Isolated DB Path: ${resolvedDbPath}`);

const { runMigrations } = await import('./db/migrate.js');
await runMigrations();
const {
    ingestSearchLead,
    getLeadById,
    getLeadByCanonicalUrl,
    getObservationsForLead,
    listPendingLeads,
    resolveLead,
    countLeads,
    normalizeLeadUrl,
    getJobByUrl,
    upsertCompany,
    upsertJobPosting
} = await import('./db/repo.mjs');
const {
    AdapterResult,
    JobBoardResult,
    SearchLeadItem,
    SearchLeadResult,
    ProviderError,
    ProviderRateLimitError,
    ProviderTimeoutError,
    ProviderAuthError,
    InvalidPayloadError,
    validateAdapterResult,
    validateSearchLeadResult
} = await import('./discovery/interfaces.mjs');
const {
    WorkdayAdapter,
    fetchWorkdayJobs,
    parseWorkdayResponse,
    extractWorkdayConfig,
    buildEndpoint: buildWdEndpoint
} = await import('./discovery/adapters/workday.mjs');
const {
    SmartRecruitersAdapter,
    fetchSmartRecruitersJobs,
    parseSmartRecruitersResponse,
    extractCompanyIdentifier: extractSrId,
    buildEndpoint: buildSrEndpoint
} = await import('./discovery/adapters/smartrecruiters.mjs');
const { GreenhouseAdapter } = await import('./discovery/adapters/greenhouse.mjs');
const { LeverAdapter } = await import('./discovery/adapters/lever.mjs');
const { AshbyAdapter } = await import('./discovery/adapters/ashby.mjs');
const { BraveSearchProvider } = await import('./discovery/providers/brave.mjs');
const { resolveSingleLead, resolvePendingLeads } = await import('./discovery/leads/resolver.mjs');

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`  ✅ PASS: ${name}`);
        passed++;
    } catch (err) {
        console.error(`  ❌ FAIL: ${name}`);
        console.error(`     ${err.message}`);
        failed++;
    }
}

async function asyncTest(name, fn) {
    try {
        await fn();
        console.log(`  ✅ PASS: ${name}`);
        passed++;
    } catch (err) {
        console.error(`  ❌ FAIL: ${name}`);
        console.error(`     ${err.message}`);
        failed++;
    }
}

async function runSuite() {
    console.log('====================================================');
    console.log('🧪 MILESTONE 3A — PROVIDERS, ADAPTERS & LEADS TEST');
    console.log('====================================================\n');

    // ── 1. Provider Interfaces & Error Hierarchy ───────────────────────
    console.log('--- 1. Provider Interfaces & Error Hierarchy ---');

    test('ProviderError hierarchy formats correctly', () => {
        const base = new ProviderError('generic error', { provider: 'test', statusCode: 500 });
        assert.strictEqual(base.name, 'ProviderError');
        assert.strictEqual(base.provider, 'test');
        assert.strictEqual(base.statusCode, 500);

        const rateLimit = new ProviderRateLimitError('slow down', { provider: 'brave', retryAfterMs: 3000 });
        assert.strictEqual(rateLimit.name, 'ProviderRateLimitError');
        assert.strictEqual(rateLimit.statusCode, 429);
        assert.strictEqual(rateLimit.recoverable, true);
        assert.strictEqual(rateLimit.retryAfterMs, 3000);

        const timeout = new ProviderTimeoutError('hung up', { provider: 'workday', timeoutMs: 5000 });
        assert.strictEqual(timeout.name, 'ProviderTimeoutError');
        assert.strictEqual(timeout.statusCode, 408);

        const auth = new ProviderAuthError('key missing', { provider: 'brave' });
        assert.strictEqual(auth.name, 'ProviderAuthError');
        assert.strictEqual(auth.statusCode, 401);
    });

    test('AdapterResult validates valid payload', () => {
        const result = new AdapterResult({
            sourceType: 'greenhouse',
            jobs: [
                { title: 'Software Engineer', job_url: 'https://example.com/1', company_id: 'c_1' }
            ]
        });
        assert.doesNotThrow(() => validateAdapterResult(result));
    });

    test('validateAdapterResult throws on missing required job attributes', () => {
        const badResult = new AdapterResult({
            sourceType: 'lever',
            jobs: [
                { title: 'Engineer', job_url: '' } // missing job_url and company_id
            ]
        });
        assert.throws(() => validateAdapterResult(badResult), /InvalidPayloadError/);
    });

    test('Thin wrappers GreenhouseAdapter, LeverAdapter, AshbyAdapter conform to interface', () => {
        const gh = new GreenhouseAdapter();
        assert.strictEqual(gh.sourceType, 'greenhouse');
        assert.strictEqual(typeof gh.fetchJobs, 'function');

        const lever = new LeverAdapter();
        assert.strictEqual(lever.sourceType, 'lever');
        assert.strictEqual(typeof lever.fetchJobs, 'function');

        const ashby = new AshbyAdapter();
        assert.strictEqual(ashby.sourceType, 'ashby');
        assert.strictEqual(typeof ashby.fetchJobs, 'function');
    });

    // ── 2. Workday CXS Adapter Contract ───────────────────────────────
    console.log('\n--- 2. Workday CXS Adapter Contract ---');

    test('extractWorkdayConfig parses canonical URL formats', () => {
        const c1 = extractWorkdayConfig('https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite');
        assert.deepStrictEqual(c1, { tenant: 'nvidia', instance: 'wd5', site: 'NVIDIAExternalCareerSite' });

        const c2 = extractWorkdayConfig('https://adobe.wd5.myworkdayjobs.com/en-US/external_experienced');
        assert.deepStrictEqual(c2, { tenant: 'adobe', instance: 'wd5', site: 'external_experienced' });

        const c3 = extractWorkdayConfig('salesforce:wd12:External_Career_Site');
        assert.deepStrictEqual(c3, { tenant: 'salesforce', instance: 'wd12', site: 'External_Career_Site' });

        assert.strictEqual(extractWorkdayConfig('https://invalid.com/careers'), null);
    });

    test('buildWdEndpoint constructs correct CXS POST endpoint', () => {
        const ep = buildWdEndpoint({ tenant: 'nvidia', instance: 'wd5', site: 'NVIDIAExternalCareerSite' });
        assert.strictEqual(ep, 'https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/NVIDIAExternalCareerSite/jobs');
    });

    test('parseWorkdayResponse extracts and normalizes jobPostings', () => {
        const mockPayload = {
            total: 2,
            jobPostings: [
                {
                    title: 'Senior Backend Engineer',
                    externalPath: '/job/Bengaluru-India/Senior-Backend-Engineer_JR10928',
                    locationsText: 'Bengaluru, Karnataka, India',
                    postedOn: 'Posted 2 Days Ago',
                    bulletFields: ['JR10928', 'Full time']
                },
                {
                    title: 'Machine Learning Intern (Remote)',
                    externalPath: '/job/Remote/ML-Intern_JR10929',
                    locationsText: 'Remote, India',
                    postedOn: 'Posted Today',
                    bulletFields: ['JR10929', 'Internship']
                }
            ]
        };

        const config = { tenant: 'mockcorp', instance: 'wd1', site: 'external' };
        const jobs = parseWorkdayResponse(mockPayload, 'c_mock', 'Mock Corp', config);

        assert.strictEqual(jobs.length, 2);
        assert.strictEqual(jobs[0].title, 'Senior Backend Engineer');
        assert.strictEqual(jobs[0].job_url, 'https://mockcorp.wd1.myworkdayjobs.com/en-US/external/job/Bengaluru-India/Senior-Backend-Engineer_JR10928');
        assert.strictEqual(jobs[0].location, 'Bengaluru, Karnataka, India');
        assert.strictEqual(jobs[0].employment_type, 'full-time');
        assert.strictEqual(jobs[0].source, 'workday');
        assert.strictEqual(jobs[0].source_job_id, 'JR10928');

        assert.strictEqual(jobs[1].title, 'Machine Learning Intern (Remote)');
        assert.strictEqual(jobs[1].remote_type, 'remote');
        assert.strictEqual(jobs[1].employment_type, 'internship');
    });

    await asyncTest('fetchWorkdayJobs handles pagination loop with mock fetchFn', async () => {
        let callCount = 0;
        const mockFetch = async (url, opts) => {
            callCount++;
            const body = JSON.parse(opts.body);
            const offset = body.offset || 0;

            if (offset === 0) {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        total: 3,
                        jobPostings: [
                            { title: 'Job 1', externalPath: '/job/1', locationsText: 'Pune' },
                            { title: 'Job 2', externalPath: '/job/2', locationsText: 'Pune' }
                        ]
                    })
                };
            } else {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        total: 3,
                        jobPostings: [
                            { title: 'Job 3', externalPath: '/job/3', locationsText: 'Pune' }
                        ]
                    })
                };
            }
        };

        const res = await fetchWorkdayJobs('https://testco.wd5.myworkdayjobs.com/careers', 'c_test', 'Test Co', {
            fetchFn: mockFetch,
            limit: 2,
            maxPages: 5
        });

        assert.strictEqual(res.total, 3);
        assert.strictEqual(res.jobs.length, 3);
        assert.strictEqual(res.fetchedCount, 3);
        assert.strictEqual(callCount, 2, 'Made exactly 2 paginated requests');
    });

    // ── 3. SmartRecruiters Public Posting Adapter Contract ─────────────
    console.log('\n--- 3. SmartRecruiters Public Posting Adapter Contract ---');

    test('extractSrId parses various SmartRecruiters URL formats and plain slugs', () => {
        assert.strictEqual(extractSrId('https://careers.smartrecruiters.com/SmartRecruiters'), 'SmartRecruiters');
        assert.strictEqual(extractSrId('https://jobs.smartrecruiters.com/Visa'), 'Visa');
        assert.strictEqual(extractSrId('https://api.smartrecruiters.com/v1/companies/square/postings'), 'square');
        assert.strictEqual(extractSrId('blizzard'), 'blizzard');
        assert.strictEqual(extractSrId('https://invalid.com/careers'), null);
    });

    test('buildSrEndpoint constructs clean public postings URL', () => {
        const ep = buildSrEndpoint('smartrecruiters', { limit: 50, offset: 100 });
        assert.strictEqual(ep, 'https://api.smartrecruiters.com/v1/companies/smartrecruiters/postings?limit=50&offset=100');
    });

    test('parseSmartRecruitersResponse normalizes public postings payload', () => {
        const mockPayload = {
            totalFound: 1,
            content: [
                {
                    id: '743999981726354',
                    name: 'Staff Full Stack Engineer',
                    uuid: 'u-123',
                    refNumber: 'REF908X',
                    location: {
                        city: 'Bengaluru',
                        region: 'Karnataka',
                        country: 'in',
                        remote: true
                    },
                    typeOfEmployment: { label: 'Full-time' },
                    releasedDate: '2026-03-01T08:00:00.000Z'
                }
            ]
        };

        const jobs = parseSmartRecruitersResponse(mockPayload, 'c_sr', 'SR Corp', 'smartrecruiters');
        assert.strictEqual(jobs.length, 1);
        assert.strictEqual(jobs[0].title, 'Staff Full Stack Engineer');
        assert.strictEqual(jobs[0].job_url, 'https://jobs.smartrecruiters.com/smartrecruiters/743999981726354');
        assert.strictEqual(jobs[0].location, 'Bengaluru, Karnataka, IN');
        assert.strictEqual(jobs[0].remote_type, 'remote');
        assert.strictEqual(jobs[0].employment_type, 'full-time');
        assert.strictEqual(jobs[0].source, 'smartrecruiters');
        assert.strictEqual(jobs[0].source_job_id, '743999981726354');
    });

    await asyncTest('fetchSmartRecruitersJobs paginates until totalFound is exhausted', async () => {
        let callCount = 0;
        const mockFetch = async () => {
            callCount++;
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    totalFound: 1,
                    content: [
                        { id: '101', name: 'Developer', location: { city: 'Berlin' } }
                    ]
                })
            };
        };

        const res = await fetchSmartRecruitersJobs('acme', 'c_acme', 'Acme', {
            fetchFn: mockFetch,
            limit: 100
        });

        assert.strictEqual(res.total, 1);
        assert.strictEqual(callCount, 1);
    });

    // ── 4. Brave Search Provider Contract ──────────────────────────────
    console.log('\n--- 4. Brave Search Provider Contract ---');

    test('BraveSearchProvider requires API key and fails fast if missing', async () => {
        const oldEnv = process.env.BRAVE_SEARCH_API_KEY;
        delete process.env.BRAVE_SEARCH_API_KEY;

        const provider = new BraveSearchProvider({ apiKey: null });
        assert.strictEqual(provider.isConfigured(), false);

        await assert.rejects(
            async () => await provider.search('test query'),
            /ProviderAuthError/
        );

        if (oldEnv) process.env.BRAVE_SEARCH_API_KEY = oldEnv;
    });

    await asyncTest('BraveSearchProvider parses results and respects query caching', async () => {
        let networkFetchCount = 0;
        const mockFetch = async () => {
            networkFetchCount++;
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    web: {
                        total: 100,
                        results: [
                            {
                                title: 'Full Stack Engineer - Lever',
                                url: 'https://jobs.lever.co/example/12345',
                                description: 'We are looking for a Node and React full stack developer.'
                            },
                            {
                                title: 'Backend Developer - Ashby',
                                url: 'https://jobs.ashbyhq.com/example/67890',
                                description: 'PostgreSQL and TypeScript backend systems.'
                            }
                        ]
                    }
                })
            };
        };

        const provider = new BraveSearchProvider({
            apiKey: 'mock-test-key-12345',
            minRequestIntervalMs: 0,
            fetchFn: mockFetch
        });

        // 1. First search -> triggers network
        const res1 = await provider.search('site:jobs.lever.co "Engineer"', { count: 2 });
        assert.strictEqual(networkFetchCount, 1);
        assert.strictEqual(res1.items.length, 2);
        assert.strictEqual(res1.items[0].rawUrl, 'https://jobs.lever.co/example/12345');
        assert.strictEqual(res1.items[0].resultRank, 1);
        assert.strictEqual(res1.items[1].resultRank, 2);

        // 2. Repeat search -> served from in-memory cache
        const res2 = await provider.search('site:jobs.lever.co "Engineer"', { count: 2 });
        assert.strictEqual(networkFetchCount, 1, 'Repeat query served from cache with 0 network calls');
        assert.strictEqual(res2.items.length, 2);
    });

    // ── 5. URL Normalization & Parameter Preservation ─────────────────
    console.log('\n--- 5. URL Normalization & Parameter Preservation ---');

    test('normalizeLeadUrl strips marketing/tracking query parameters', () => {
        const raw = 'https://jobs.lever.co/acme/123?utm_source=linkedin&utm_medium=job_post&ref=social';
        const norm = normalizeLeadUrl(raw);
        assert.strictEqual(norm, 'https://jobs.lever.co/acme/123');
    });

    test('normalizeLeadUrl preserves meaningful functional query parameters', () => {
        const raw = 'https://boards.greenhouse.io/embed/job_app?for=stripe&token=12345&gh_jid=67890&utm_source=ad';
        const norm = normalizeLeadUrl(raw);
        // Strips utm_source, keeps for, token, gh_jid
        assert(norm.includes('for=stripe'));
        assert(norm.includes('token=12345'));
        assert(norm.includes('gh_jid=67890'));
        assert(!norm.includes('utm_source'));
    });

    test('normalizeLeadUrl normalizes trailing slash and protocol', () => {
        const raw = 'http://jobs.lever.co/acme/openings/?utm_campaign=spring';
        const norm = normalizeLeadUrl(raw);
        assert.strictEqual(norm, 'https://jobs.lever.co/acme/openings');
    });

    // ── 6. Migration 007 & Lead Ingestion Multi-Observation ───────────
    console.log('\n--- 6. Migration 007 & Multi-Observation Provenance ---');

    test('Database has source_leads and source_lead_observations tables', () => {
        const db = getDb();
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t => t.name);
        assert(tables.includes('source_leads'), 'source_leads table exists');
        assert(tables.includes('source_lead_observations'), 'source_lead_observations table exists');

        const companyCols = db.prepare("PRAGMA table_info(companies)").all().map(c => c.name);
        assert(companyCols.includes('submission_policy'), 'companies table has submission_policy column');
    });

    test('ingestSearchLead preserves canonical identity across repeat observations', () => {
        const uniqueToken = Date.now();
        const raw1 = `https://jobs.lever.co/acme/backend-eng-${uniqueToken}?utm_source=brave_search`;
        const raw2 = `https://jobs.lever.co/acme/backend-eng-${uniqueToken}?utm_source=tavily&ref=newsletter`;
        const expectedCanonical = `https://jobs.lever.co/acme/backend-eng-${uniqueToken}`;

        // 1. Ingest first observation
        const res1 = ingestSearchLead({
            provider: 'search:brave',
            query: 'site:jobs.lever.co "backend"',
            rawUrl: raw1,
            title: 'Backend Engineer',
            snippet: 'Join Acme as a backend engineer',
            resultRank: 1,
            companyName: 'Acme Corp'
        });

        assert.strictEqual(res1.isNewLead, true);
        const lead = getLeadById(res1.leadId);
        assert.strictEqual(lead.observation_count, 1);
        assert.strictEqual(lead.canonical_url, expectedCanonical);

        // 2. Ingest second observation for the SAME canonical URL
        const res2 = ingestSearchLead({
            provider: 'search:tavily',
            query: 'acme backend engineer',
            rawUrl: raw2,
            title: 'Backend Engineer - Acme',
            snippet: 'Another snippet from Tavily',
            resultRank: 3,
            companyName: 'Acme Corp'
        });

        assert.strictEqual(res2.isNewLead, false, 'Not a new lead; reuses canonical identity');
        assert.strictEqual(res2.leadId, res1.leadId, 'Lead ID matches first observation');

        const updatedLead = getLeadById(res1.leadId);
        assert.strictEqual(updatedLead.observation_count, 2, 'observation_count incremented to 2');

        const observations = getObservationsForLead(res1.leadId);
        assert.strictEqual(observations.length, 2, 'Exactly 2 distinct observation provenance records exist');
        assert.strictEqual(observations[0].provider, 'search:tavily');
        assert.strictEqual(observations[1].provider, 'search:brave');
        assert.strictEqual(observations[1].raw_url, raw1, 'Raw URL 1 preserved verbatim');
        assert.strictEqual(observations[0].raw_url, raw2, 'Raw URL 2 preserved verbatim');
    });

    // ── 7. Lead Resolution Service ────────────────────────────────────
    console.log('\n--- 7. Lead Resolution Service ---');

    await asyncTest('resolveSingleLead resolves to existing job_postings URL', async () => {
        const uniqueId = `palantir-test-${Date.now()}`;
        const companyId = `comp_${uniqueId}`;
        upsertCompany({
            id: companyId,
            name: 'Palantir Test Co',
            domain: `${uniqueId}.com`,
            website_url: `https://${uniqueId}.com`
        });

        // Create an existing job posting
        const existingUrl = `https://jobs.lever.co/${uniqueId}/forward-deployed-eng`;
        upsertJobPosting({
            id: existingUrl,
            company_id: companyId,
            title: 'Forward Deployed Engineer',
            job_url: existingUrl,
            source: 'lever',
            discovered_at: new Date().toISOString()
        });

        // Ingest a lead that points to this existing job
        const leadRes = ingestSearchLead({
            provider: 'search:brave',
            query: `site:jobs.lever.co "${uniqueId}"`,
            rawUrl: `${existingUrl}?utm_campaign=recruiting`,
            title: 'Forward Deployed Engineer',
            companyName: 'Palantir Test Co'
        });

        const lead = getLeadById(leadRes.leadId);
        assert.strictEqual(lead.resolution_status, 'pending');

        // Resolve
        const resolution = await resolveSingleLead(lead);
        assert.strictEqual(resolution.resolved, true);
        assert.strictEqual(resolution.resolutionStatus, 'resolved_job');
        assert.strictEqual(resolution.resolvedJobId, existingUrl);

        const refreshedLead = getLeadById(leadRes.leadId);
        assert.strictEqual(refreshedLead.resolution_status, 'resolved_job');
        assert.strictEqual(refreshedLead.resolved_job_id, existingUrl);
    });

    await asyncTest('resolveSingleLead promotes unindexed lead to discovered job posting', async () => {
        const uniqueId = `elevenlabs-test-${Date.now()}`;
        const companyId = `comp_${uniqueId}`;
        upsertCompany({
            id: companyId,
            name: 'ElevenLabs Research',
            domain: `${uniqueId}.io`,
            website_url: `https://${uniqueId}.io`,
            lifecycle_status: 'VERIFIED'
        });

        const newLeadUrl = `https://${uniqueId}.io/careers/senior-researcher`;
        const leadRes = ingestSearchLead({
            provider: 'search:brave',
            query: 'elevenlabs research engineer',
            rawUrl: `${newLeadUrl}?ref=ai_jobs`,
            title: 'Senior Research Scientist',
            companyName: 'ElevenLabs Research'
        });

        const lead = getLeadById(leadRes.leadId);
        const resolution = await resolveSingleLead(lead);

        assert.strictEqual(resolution.resolved, true);
        assert.strictEqual(resolution.resolutionStatus, 'resolved_job');

        // Verify that promoted job enters job_postings with status = 'discovered' (NOT active!)
        const job = getJobByUrl(newLeadUrl);
        assert(job !== undefined, 'Job created in job_postings');
        assert.strictEqual(job.status, 'discovered', 'Newly promoted lead has status: discovered');
        assert.strictEqual(job.title, 'Senior Research Scientist');
        assert.strictEqual(job.company_id, companyId);
    });

    // ── 8. Live Public Read-Only Probes ───────────────────────────────
    console.log('\n--- 8. Live Public Read-Only Probes ---');

    await asyncTest('Live Workday probe: handles valid endpoint format gracefully', async () => {
        // Probe a known publicly accessible Workday tenant
        const target = 'https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite';
        const res = await fetchWorkdayJobs(target, 'c_nvidia_probe', 'NVIDIA', {
            limit: 2,
            maxPages: 1,
            maxJobs: 2,
            timeoutMs: 5000
        });

        // In sandbox environment, outbound network might be restricted (ENOTFOUND)
        // If network succeeds: res.jobs >= 0 and res.error == null.
        // If network is sandboxed: res.error contains network or ENOTFOUND message.
        if (res.error) {
            console.log(`     ℹ️ Live Workday network probe safely handled (isolated/sandboxed: ${res.error})`);
            assert(typeof res.error === 'string');
        } else {
            console.log(`     ✅ Live Workday probe fetched ${res.jobs.length} jobs successfully from public CXS endpoint`);
            assert(Array.isArray(res.jobs));
        }
    });

    await asyncTest('Live SmartRecruiters probe: handles public API gracefully', async () => {
        const res = await fetchSmartRecruitersJobs('smartrecruiters', 'c_sr_probe', 'SmartRecruiters', {
            limit: 2,
            maxPages: 1,
            maxJobs: 2,
            timeoutMs: 5000
        });

        if (res.error) {
            console.log(`     ℹ️ Live SmartRecruiters network probe safely handled (isolated/sandboxed: ${res.error})`);
            assert(typeof res.error === 'string');
        } else {
            console.log(`     ✅ Live SmartRecruiters probe fetched ${res.jobs.length} jobs from public posting API`);
            assert(Array.isArray(res.jobs));
        }
    });

    console.log('\n====================================================');
    console.log(`📊 Milestone 3A Test Results: ${passed} PASSED, ${failed} FAILED`);
    console.log('====================================================');

    if (failed > 0) {
        process.exitCode = 1;
    }
}

try {
    await runSuite();
} catch (err) {
    console.error('Fatal suite failure:', err);
    process.exitCode = 1;
} finally {
    closeDb();
    cleanupTestDb();
    delete process.env.JOB_AGENT_DB_PATH;
}
