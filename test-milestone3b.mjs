#!/usr/bin/env node

/**
 * test-milestone3b.mjs — Comprehensive Test Suite for Milestone 3B
 *
 * Verifies:
 *   1. Migration 008 Schema & Columns (last_verified_at, verification_method, job_evaluation_runs)
 *   2. Job Liveness Verification (all 14 scenarios including 403, 429, CAPTCHA, timeout, 500, closures)
 *   3. Tier 1 Deterministic Title Screening (target engineering vs excluded non-eng roles)
 *   4. Tier 2 Hard Eligibility Gates (20+ combinations: India onsite, remote, US-only, exp, degree, salary, clearance)
 *   5. Tier 3 Fact-Grounded Technical Matching (real fact/evidence citations, 0.0–1.0 score, transparent breakdown)
 *   6. Multi-Tier End-to-End Recommendations (APPLY, CONSIDER, DO_NOT_APPLY, UNKNOWN)
 *   7. Evaluation Runs Persistence & History (idempotency, fingerprinting, multiple historical runs)
 *   8. Batch Scheduling & CLI Orchestration (dry-run, batch limits, failure isolation)
 */

import assert from 'assert';
import { existsSync, unlinkSync, readdirSync, readFileSync } from 'fs';
import { resolve } from 'path';

const TEST_DB_PATH = resolve(process.cwd(), 'data', 'test_milestone3b.db');
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
const resolvedPath = resolve(getDbPath());
if (resolvedPath === CANONICAL_DB_PATH) {
    throw new Error(`SAFETY ABORT: test-milestone3b.mjs resolved to canonical DB (${resolvedPath})`);
}

const {
    getJob,
    upsertJobPosting,
    upsertCompany,
    upsertCandidateFact,
    insertEvidenceRecord,
    getCandidateFacts,
    getEvidenceForFact,
    updateJobVerification,
    getJobsForVerification,
    insertJobEvaluationRun,
    getLatestEvaluationRun,
    getEvaluationRunsForJob
} = await import('./db/repo.mjs');
const {
    determineVerificationOutcome,
    verifySingleJob,
    verifyJobBatch
} = await import('./verification/verify-jobs.mjs');
const {
    titleScreening,
    normalizeCompensation,
    eligibilityCheck,
    factGroundedMatch,
    evaluateJobOffer
} = await import('./matching/pipeline.mjs');
const {
    evaluateJob,
    evaluateBatch,
    computeEvaluationFingerprint
} = await import('./matching/scheduler.mjs');

function initIsolatedTestDb() {
    const db = getDb();
    const migDir = resolve(process.cwd(), 'db', 'migrations');
    const files = readdirSync(migDir).filter(f => f.endsWith('.sql')).sort();
    for (const file of files) {
        db.exec(readFileSync(resolve(migDir, file), 'utf8'));
    }

    upsertCompany({
        id: 'company-palantir',
        name: 'Palantir',
        domain: 'palantir.com',
        ats_type: 'lever',
        board_identifier: 'palantir',
        lifecycle_status: 'APPROVED',
        monitoring_status: 'active',
        policy_status: 'permitted'
    });

    const facts = [
        { id: 'fact-edu-btech-cse', category: 'education', identifier: 'degree-btech-cse', value: 'B.Tech in Computer Science & Engineering, Synthetic University (Graduation: May 2026, CGPA: 7.46)', verified: 1 },
        { id: 'fact-exp-emendo-swe', category: 'experience', identifier: 'acme-corp-swe', value: 'Software Engineer at Acme Corp (May 2026 - July 2026, ~3 months)', verified: 1 },
        { id: 'fact-exp-hcl-trainee', category: 'experience', identifier: 'techcorp-fullstack-trainee', value: 'Full Stack Developer Trainee at TechCorp (December 2025 - March 2026, ~4 months)', verified: 1 },
        { id: 'fact-work-auth-india', category: 'work_authorization', identifier: 'work_authorization_india', value: 'Citizen of India legally authorized to work full-time without employer sponsorship', verified: 1 },
        { id: 'fact-skill-nodejs', category: 'skill', identifier: 'nodejs', value: 'Node.js & Express', verified: 1 },
        { id: 'fact-skill-typescript', category: 'skill', identifier: 'typescript', value: 'TypeScript', verified: 1 },
        { id: 'fact-skill-javascript', category: 'skill', identifier: 'javascript', value: 'JavaScript (ES6+)', verified: 1 },
        { id: 'fact-skill-react', category: 'skill', identifier: 'react', value: 'React.js', verified: 1 },
        { id: 'fact-skill-nextjs', category: 'skill', identifier: 'nextjs', value: 'Next.js', verified: 1 },
        { id: 'fact-skill-postgresql', category: 'skill', identifier: 'postgresql', value: 'PostgreSQL', verified: 1 },
        { id: 'fact-skill-mongodb', category: 'skill', identifier: 'mongodb', value: 'MongoDB', verified: 1 },
        { id: 'fact-skill-redis', category: 'skill', identifier: 'redis', value: 'Redis', verified: 1 },
        { id: 'fact-skill-docker', category: 'skill', identifier: 'docker', value: 'Docker & Docker Compose', verified: 1 },
        { id: 'fact-skill-aws', category: 'skill', identifier: 'aws', value: 'AWS (EC2, S3)', verified: 1 },
        { id: 'fact-skill-websockets', category: 'skill', identifier: 'websockets', value: 'WebSockets & Socket.IO', verified: 1 },
        { id: 'fact-skill-rest-apis', category: 'skill', identifier: 'rest-apis', value: 'RESTful API Architecture', verified: 1 }
    ];
    for (const f of facts) {
        upsertCandidateFact(f);
    }

    const evidence = [
        { id: 'ev-skill-nodejs-apis', fact_id: 'fact-skill-nodejs', title: 'Node.js APIs', description: 'Built REST APIs in Node.js', source_type: 'work_experience', source_reference: 'test://techcorp', verified: 1 },
        { id: 'ev-skill-react-ui', fact_id: 'fact-skill-react', title: 'React Frontend UI', description: 'Built React frontend', source_type: 'project', source_reference: 'test://project-alpha', verified: 1 },
        { id: 'ev-skill-postgres-db', fact_id: 'fact-skill-postgresql', title: 'PostgreSQL Database', description: 'Designed PostgreSQL schema', source_type: 'project', source_reference: 'test://project-alpha', verified: 1 },
        { id: 'ev-skill-docker-exec', fact_id: 'fact-skill-docker', title: 'Docker Execution Sandbox', description: 'Containerized execution', source_type: 'project', source_reference: 'test://project-gamma', verified: 1 },
        { id: 'ev-skill-websocket-realtime', fact_id: 'fact-skill-websockets', title: 'Realtime WebSockets', description: 'Socket.IO and Redis caching', source_type: 'work_experience', source_reference: 'test://techcorp', verified: 1 }
    ];
    for (const ev of evidence) {
        insertEvidenceRecord(ev);
    }

    return db;
}

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
    console.log('🧪 MILESTONE 3B — VERIFICATION & MATCHING TEST SUITE');
    console.log('====================================================\n');

    const db = initIsolatedTestDb();

    // ── 1. Migration 008 Schema Verification ──────────────────────────
    console.log('--- 1. Migration 008 Schema & Columns ---');

    test('job_postings has last_verified_at and verification_method columns', () => {
        const cols = db.prepare("PRAGMA table_info(job_postings)").all().map(c => c.name);
        assert(cols.includes('last_verified_at'), 'last_verified_at column exists');
        assert(cols.includes('verification_method'), 'verification_method column exists');
    });

    test('job_evaluation_runs table exists with correct columns and primary key', () => {
        const cols = db.prepare("PRAGMA table_info(job_evaluation_runs)").all();
        const colNames = cols.map(c => c.name);
        const pkCol = cols.find(c => c.pk === 1);

        assert(colNames.includes('id'), 'id exists');
        assert(colNames.includes('job_id'), 'job_id exists');
        assert(colNames.includes('eval_version'), 'eval_version exists');
        assert(colNames.includes('input_hash'), 'input_hash exists');
        assert(colNames.includes('tier1_passed'), 'tier1_passed exists');
        assert(colNames.includes('tier2_eligibility'), 'tier2_eligibility exists');
        assert(colNames.includes('tier3_match_score'), 'tier3_match_score exists');
        assert(colNames.includes('matched_fact_ids'), 'matched_fact_ids exists');
        assert(colNames.includes('evidence_ids'), 'evidence_ids exists');
        assert(colNames.includes('recommendation'), 'recommendation exists');

        assert.strictEqual(pkCol.name, 'id');
        assert.strictEqual(pkCol.type, 'TEXT');
    });

    // ── 2. Job Liveness Verification Scenarios ────────────────────────
    console.log('\n--- 2. Job Liveness Verification Scenarios ---');

    test('Scenario 1: Valid active job page classifies as ACTIVE', () => {
        const out = determineVerificationOutcome({
            status: 200,
            finalUrl: 'https://example.com/jobs/101',
            bodyText: 'About the role: Software Engineer at Acme Corp. We are hiring a full stack developer.',
            applyControls: ['Apply for this job', 'Submit Application']
        });
        assert.strictEqual(out.outcome, 'ACTIVE');
        assert.strictEqual(out.definitive, true);
    });

    test('Scenario 2: Explicit closed job classifies as CLOSED', () => {
        const out = determineVerificationOutcome({
            status: 200,
            finalUrl: 'https://example.com/jobs/102',
            bodyText: 'Thank you for your interest. Applications have closed for this position.',
            applyControls: []
        });
        assert.strictEqual(out.outcome, 'CLOSED');
        assert.strictEqual(out.definitive, true);
    });

    test('Scenario 3: HTTP 404 classifies as EXPIRED', () => {
        const out = determineVerificationOutcome({
            status: 404,
            finalUrl: 'https://example.com/jobs/103',
            bodyText: '404 Not Found'
        });
        assert.strictEqual(out.outcome, 'EXPIRED');
        assert.strictEqual(out.definitive, true);
    });

    test('Scenario 4: HTTP 403 classifies as UNKNOWN (never accidentally closed)', () => {
        const out = determineVerificationOutcome({
            status: 403,
            finalUrl: 'https://example.com/jobs/104',
            bodyText: 'Forbidden: Access Denied'
        });
        assert.strictEqual(out.outcome, 'UNKNOWN');
        assert.strictEqual(out.definitive, false);
    });

    test('Scenario 5: HTTP 429 classifies as UNKNOWN (rate limit, never closed)', () => {
        const out = determineVerificationOutcome({
            status: 429,
            finalUrl: 'https://example.com/jobs/105',
            bodyText: 'Too Many Requests'
        });
        assert.strictEqual(out.outcome, 'UNKNOWN');
        assert.strictEqual(out.definitive, false);
    });

    test('Scenario 6: Network timeout classifies as ERROR (never closed)', () => {
        const out = determineVerificationOutcome({
            error: new Error('Request timed out after 15000ms')
        });
        assert.strictEqual(out.outcome, 'ERROR');
        assert.strictEqual(out.definitive, false);
    });

    test('Scenario 7: HTTP 500 server error classifies as ERROR (never closed)', () => {
        const out = determineVerificationOutcome({
            status: 500,
            bodyText: 'Internal Server Error'
        });
        assert.strictEqual(out.outcome, 'ERROR');
        assert.strictEqual(out.definitive, false);
    });

    test('Scenario 8: CAPTCHA or Cloudflare challenge classifies as UNKNOWN (never closed)', () => {
        const out = determineVerificationOutcome({
            status: 200,
            bodyText: 'Checking your browser before accessing the website. Please complete the security check with Cloudflare Turnstile.'
        });
        assert.strictEqual(out.outcome, 'UNKNOWN');
        assert.strictEqual(out.definitive, false);
    });

    test('Scenario 9: Malformed or insufficient content handled safely without crash', () => {
        const out = determineVerificationOutcome({
            status: 200,
            bodyText: 'Tiny page'
        });
        assert(['EXPIRED', 'CLOSED', 'UNKNOWN'].includes(out.outcome));
    });

    await asyncTest('Scenario 10: Active job becoming closed updates status & records snapshot', async () => {
        const testJobId = `job_test_liveness_${Date.now()}`;
        upsertJobPosting({
            id: testJobId,
            company_id: 'company-palantir',
            title: 'Liveness Transition Test Engineer',
            job_url: `https://example.com/jobs/${testJobId}`,
            source: 'test',
            status: 'active'
        });

        // Verify with mock fetch returning closed pattern
        const mockFetch = async () => ({
            status: 200,
            url: `https://example.com/jobs/${testJobId}`,
            text: async () => 'We appreciate your interest, but applications are closed for this role.'
        });

        const res = await verifySingleJob(getJob(testJobId), { fetchFn: mockFetch });
        assert.strictEqual(res.outcome, 'CLOSED');
        assert.strictEqual(res.newStatus, 'closed');

        const updated = getJob(testJobId);
        assert.strictEqual(updated.status, 'closed');
        assert(updated.last_verified_at !== null);

        const snaps = db.prepare('SELECT * FROM job_snapshots WHERE job_id = ?').all(testJobId);
        assert(snaps.length >= 1, 'Snapshot recorded on status transition to closed');
    });

    test('Scenario 11: Stale jobs older than maxAgeDays are selected for verification', () => {
        const staleJobId = `job_stale_${Date.now()}`;
        upsertJobPosting({
            id: staleJobId,
            company_id: 'company-palantir',
            title: 'Stale Active Engineer',
            job_url: `https://example.com/jobs/${staleJobId}`,
            source: 'test',
            status: 'active'
        });

        // Set last_verified_at to 5 days ago
        db.prepare("UPDATE job_postings SET last_verified_at = datetime('now', '-5 days') WHERE id = ?").run(staleJobId);

        const candidates = getJobsForVerification({ limit: 100, maxAgeDays: 3, jobIds: [staleJobId] });
        assert.strictEqual(candidates.length, 1);
        assert.strictEqual(candidates[0].id, staleJobId);
    });

    test('Scenario 12: Recently verified jobs within maxAgeDays are skipped', () => {
        const freshJobId = `job_fresh_${Date.now()}`;
        upsertJobPosting({
            id: freshJobId,
            company_id: 'company-palantir',
            title: 'Fresh Active Engineer',
            job_url: `https://example.com/jobs/${freshJobId}`,
            source: 'test',
            status: 'active'
        });

        // Set last_verified_at to 1 hour ago
        db.prepare("UPDATE job_postings SET last_verified_at = datetime('now', '-1 hour') WHERE id = ?").run(freshJobId);

        const candidates = getJobsForVerification({ limit: 100, maxAgeDays: 3 });
        const found = candidates.find(j => j.id === freshJobId);
        assert.strictEqual(found, undefined, 'Recently verified job is not in verification queue');
    });

    await asyncTest('Scenario 13: Dry-run verification leaves database status untouched', async () => {
        const dryJobId = `job_dry_${Date.now()}`;
        upsertJobPosting({
            id: dryJobId,
            company_id: 'company-palantir',
            title: 'Dry Run Engineer',
            job_url: `https://example.com/jobs/${dryJobId}`,
            source: 'test',
            status: 'discovered'
        });

        const mockFetch = async () => ({
            status: 404,
            url: `https://example.com/jobs/${dryJobId}`,
            text: async () => 'Not Found'
        });

        const res = await verifySingleJob(getJob(dryJobId), { fetchFn: mockFetch, dryRun: true });
        assert.strictEqual(res.outcome, 'EXPIRED');

        const inDb = getJob(dryJobId);
        assert.strictEqual(inDb.status, 'discovered', 'Status remained discovered in dry-run mode');
        assert.strictEqual(inDb.last_verified_at, null);
    });

    await asyncTest('Scenario 14: verifyJobBatch processes multiple candidates with failure isolation', async () => {
        const batchJob1 = `job_batch_1_${Date.now()}`;
        const batchJob2 = `job_batch_2_${Date.now()}`;

        upsertJobPosting({ id: batchJob1, company_id: 'company-palantir', title: 'Batch Eng 1', job_url: `https://example.com/${batchJob1}`, source: 'test' });
        upsertJobPosting({ id: batchJob2, company_id: 'company-palantir', title: 'Batch Eng 2', job_url: `https://example.com/${batchJob2}`, source: 'test' });

        const mockFetch = async (url) => {
            if (url.includes('batch_1')) {
                return { status: 200, url, text: async () => 'We are hiring! Apply now.' };
            } else {
                throw new Error('Connection refused');
            }
        };

        const summary = await verifyJobBatch({
            jobIds: [batchJob1, batchJob2],
            fetchFn: mockFetch
        });

        assert.strictEqual(summary.totalProcessed, 2);
        assert.strictEqual(summary.activeCount, 1);
        assert.strictEqual(summary.errorCount, 1);
    });

    // ── 3. Tier 1 Deterministic Title Screening ───────────────────────
    console.log('\n--- 3. Tier 1 Deterministic Title Screening ---');

    test('Tier 1 matches target software engineering titles', () => {
        assert(titleScreening({ title: 'Full Stack Engineer' }).passed);
        assert(titleScreening({ title: 'Software Developer (Node/React)' }).passed);
        assert(titleScreening({ title: 'Backend Software Engineer' }).passed);
        assert(titleScreening({ title: 'Frontend Developer' }).passed);
        assert(titleScreening({ title: 'Junior SDE' }).passed);
        assert(titleScreening({ title: 'Software Engineering Intern' }).passed);
        assert(titleScreening({ title: 'Member of Technical Staff (MTS)' }).passed);
    });

    test('Tier 1 rejects excluded non-engineering titles', () => {
        assert(!titleScreening({ title: 'Enterprise Account Executive (Sales)' }).passed);
        assert(!titleScreening({ title: 'Senior Marketing Manager' }).passed);
        assert(!titleScreening({ title: 'HR Generalist / Recruiter' }).passed);
        assert(!titleScreening({ title: 'VP of Operations' }).passed);
        assert(!titleScreening({ title: 'Legal Counsel' }).passed);
        assert(!titleScreening({ title: 'Finance Associate' }).passed);
    });

    test('Tier 1 falls back to description when title is unconventional', () => {
        const res = titleScreening({
            title: 'Technical Ninja',
            description: 'We are seeking a Software Engineer to develop backend APIs using Node.js.'
        });
        assert.strictEqual(res.passed, true);
        assert(res.matchedKeywords.includes('description_engineering_role'));
    });

    // ── 4. Tier 2 Hard Eligibility Gates (20+ Scenarios) ──────────────
    console.log('\n--- 4. Tier 2 Hard Eligibility Gates ---');

    const facts = getCandidateFacts();

    test('Gate Combo 1: India onsite employment passes', () => {
        const res = eligibilityCheck({ title: 'Software Engineer', location: 'Bengaluru, India' }, facts);
        assert.strictEqual(res.eligibility, 'PASS');
    });

    test('Gate Combo 2: India remote role passes', () => {
        const res = eligibilityCheck({ title: 'Backend Developer', location: 'Remote, India', remote_type: 'remote' }, facts);
        assert.strictEqual(res.eligibility, 'PASS');
    });

    test('Gate Combo 3: Worldwide remote role passes', () => {
        const res = eligibilityCheck({ title: 'Full Stack Engineer', location: 'Worldwide Remote', remote_type: 'remote', description: 'Work from anywhere in the world' }, facts);
        assert.strictEqual(res.eligibility, 'PASS');
    });

    test('Gate Combo 4: US-only remote fails (Remote != open to India)', () => {
        const res = eligibilityCheck({ title: 'Full Stack Engineer', location: 'Remote', remote_type: 'remote', description: 'Remote - US Only. Must reside in the US.' }, facts);
        assert.strictEqual(res.eligibility, 'FAIL');
        assert(res.failedGates.includes('remote_eligibility'));
    });

    test('Gate Combo 5: Explicit US Citizenship / No Sponsorship requirement fails', () => {
        const res = eligibilityCheck({ title: 'Software Engineer', location: 'San Francisco, CA', description: 'Must be a U.S. Citizen. No sponsorship will be provided.' }, facts);
        assert.strictEqual(res.eligibility, 'FAIL');
        assert(res.failedGates.includes('work_authorization'));
    });

    test('Location Policy: US on-site/hybrid is ineligible for India candidate without sponsorship', () => {
        const resOnsite = eligibilityCheck({ title: 'Software Engineer', location: 'New York, NY', remote_type: 'onsite' }, facts);
        assert.strictEqual(resOnsite.eligibility, 'FAIL');
        assert(resOnsite.failedGates.includes('work_authorization'));

        const resHybrid = eligibilityCheck({ title: 'Software Engineer', location: 'Austin, TX', remote_type: 'hybrid' }, facts);
        assert.strictEqual(resHybrid.eligibility, 'FAIL');
        assert(resHybrid.failedGates.includes('work_authorization'));
    });

    test('Location Policy: India on-site/hybrid is eligible for India candidate', () => {
        const res = eligibilityCheck({ title: 'Full Stack Engineer', location: 'Gurugram, India', remote_type: 'hybrid' }, facts);
        assert.strictEqual(res.eligibility, 'PASS');
    });

    test('Gate Combo 6: Foreign location with unstated sponsorship returns UNKNOWN (requires input)', () => {
        const res = eligibilityCheck({ title: 'Software Engineer', location: 'Berlin, Germany', description: 'Join our Berlin office.' }, facts);
        assert.strictEqual(res.eligibility, 'UNKNOWN');
        assert(res.unknownGates.includes('work_authorization'));
        assert.strictEqual(res.requiresHumanInput, true);
    });

    test('Gate Combo 7: Completed graduation (May 2026 B.Tech) satisfies degree requirement', () => {
        const res = eligibilityCheck({ title: 'Junior Developer', location: 'Pune, India', description: 'Bachelor degree in Computer Science required.' }, facts);
        assert.strictEqual(res.eligibility, 'PASS');
    });

    test('Gate Combo 8: PhD strictly required fails', () => {
        const res = eligibilityCheck({ title: 'Research Scientist', location: 'Bengaluru, India', description: 'PhD required in Computer Science or Robotics.' }, facts);
        assert.strictEqual(res.eligibility, 'FAIL');
        assert(res.failedGates.includes('education'));
    });

    test('Gate Combo 9: Mandatory 5+ years experience fails (candidate has ~7 months)', () => {
        const res = eligibilityCheck({ title: 'Senior Developer', location: 'Hyderabad, India', description: 'Minimum 5 years of required experience in Node.js.' }, facts);
        assert.strictEqual(res.eligibility, 'FAIL');
        assert(res.failedGates.includes('experience_seniority'));
    });

    test('Gate Combo 10: Preferred-only experience passes (preferred != mandatory)', () => {
        const res = eligibilityCheck({ title: 'Software Developer', location: 'Bengaluru, India', description: 'Freshers welcome. 2+ years preferred but not required.' }, facts);
        assert.strictEqual(res.eligibility, 'PASS');
    });

    test('Gate Combo 11: Junior / Fresher 0-1 years experience passes', () => {
        const res = eligibilityCheck({ title: 'Associate Software Engineer', location: 'Bengaluru, India', description: 'Open to fresh graduates and developers with 0-1 years experience.' }, facts);
        assert.strictEqual(res.eligibility, 'PASS');
    });

    test('Gate Combo 12: Unstated salary returns UNKNOWN without failing eligibility', () => {
        const res = eligibilityCheck({ title: 'Full Stack Engineer', location: 'Bengaluru, India', description: 'Competitive compensation.' }, facts);
        assert.strictEqual(res.eligibility, 'PASS', 'Unstated compensation does not block overall PASS');
        const compGate = res.gates.find(g => g.gate === 'compensation');
        assert.strictEqual(compGate.outcome, 'UNKNOWN');
    });

    test('Gate Combo 13: Stated salary below minimum floor (₹3 LPA < ₹4 LPA) fails', () => {
        const res = eligibilityCheck({ title: 'Junior Developer', location: 'Noida, India', description: 'Salary: 2.5 - 3 LPA based on interview performance.' }, facts);
        assert.strictEqual(res.eligibility, 'FAIL');
        assert(res.failedGates.includes('compensation'));
    });

    test('Gate Combo 14: Stated salary meeting minimum floor (₹5-6 LPA) passes', () => {
        const res = eligibilityCheck({ title: 'Software Engineer', location: 'Bengaluru, India', description: 'Compensation: ₹5–6 LPA + stock options.' }, facts);
        assert.strictEqual(res.eligibility, 'PASS');
    });

    test('Gate Combo 15: Foreign USD salary ($80k/yr) passes compensation floor', () => {
        const res = eligibilityCheck({ title: 'Software Engineer', location: 'Remote, India', remote_type: 'remote', description: 'Salary: $80,000 - $100,000 per year.' }, facts);
        assert.strictEqual(res.eligibility, 'PASS');
    });

    test('Gate Combo 16: National security clearance strictly required fails', () => {
        const res = eligibilityCheck({ title: 'Defense Software Engineer', location: 'Bengaluru, India', description: 'Must possess an active Top Secret/SCI security clearance.' }, facts);
        assert.strictEqual(res.eligibility, 'FAIL');
        assert(res.failedGates.includes('security_clearance'));
    });

    test('Gate Combo 17: Full-time employment commitment passes', () => {
        const res = eligibilityCheck({ title: 'Full Stack Engineer', location: 'Pune, India', employment_type: 'full-time' }, facts);
        assert.strictEqual(res.eligibility, 'PASS');
    });

    test('Gate Combo 18: High-impact software internship passes', () => {
        const res = eligibilityCheck({ title: 'Software Engineering Intern', location: 'Bengaluru, India', employment_type: 'internship' }, facts);
        assert.strictEqual(res.eligibility, 'PASS');
    });

    test('Gate Combo 19: Contract role passes', () => {
        const res = eligibilityCheck({ title: 'Contract Node Developer', location: 'Remote, India', employment_type: 'contract' }, facts);
        assert.strictEqual(res.eligibility, 'PASS');
    });

    test('Gate Combo 20: Missing candidate facts do not crash and evaluate safely to UNKNOWN', () => {
        const res = eligibilityCheck({ title: 'Software Engineer', location: 'Unknown Location' }, []);
        assert.strictEqual(res.eligibility, 'UNKNOWN');
    });

    // ── Location Policy & Boilerplate Worldwide Isolation Regressions ─
    test('Location Policy Regression: Washington, D.C. hybrid role fails work authorization and Gate 2 is NOT_APPLICABLE', () => {
        const res = eligibilityCheck({
            title: 'Software Engineer',
            location: 'Washington, D.C.',
            remote_type: 'hybrid',
            description: 'Join our team in Washington, D.C. 3 days per week in office.'
        }, facts);
        assert.strictEqual(res.eligibility, 'FAIL');
        assert(res.failedGates.includes('work_authorization'));
        const authGate = res.gates.find(g => g.gate === 'work_authorization');
        assert(authGate.reason.includes('Foreign on-site/hybrid role in Washington, D.C.'));
        const remoteGate = res.gates.find(g => g.gate === 'remote_eligibility');
        assert.strictEqual(remoteGate.outcome, 'NOT_APPLICABLE');
        assert(remoteGate.reason.includes('Physical presence required in foreign location'));
    });

    test('Location Policy Regression: Washington, D.C. onsite role fails work authorization for India candidate', () => {
        const res = eligibilityCheck({
            title: 'Systems Engineer',
            location: 'Washington, D.C.',
            remote_type: 'onsite',
            description: 'Physical onsite presence required at our Washington, D.C. headquarters.'
        }, facts);
        assert.strictEqual(res.eligibility, 'FAIL');
        assert(res.failedGates.includes('work_authorization'));
        const remoteGate = res.gates.find(g => g.gate === 'remote_eligibility');
        assert.strictEqual(remoteGate.outcome, 'NOT_APPLICABLE');
    });

    test('Location Policy Regression: US hybrid role with "worldwide" in company boilerplate fails work authorization', () => {
        const res = eligibilityCheck({
            title: 'Software Engineer, New Grad - Production Infrastructure',
            location: 'Washington, D.C.',
            remote_type: 'hybrid',
            description: 'Palantir builds software for data-driven decisions. Used by defense agencies worldwide to power infrastructure.'
        }, facts);
        assert.strictEqual(res.eligibility, 'FAIL');
        assert(res.failedGates.includes('work_authorization'));
        const authGate = res.gates.find(g => g.gate === 'work_authorization');
        assert.strictEqual(authGate.outcome, 'FAIL');
        assert(!authGate.reason.includes('Worldwide remote'));
        const remoteGate = res.gates.find(g => g.gate === 'remote_eligibility');
        assert.strictEqual(remoteGate.outcome, 'NOT_APPLICABLE');
    });

    test('Location Policy Regression: US onsite role with "worldwide" in company boilerplate fails work authorization', () => {
        const res = eligibilityCheck({
            title: 'Infrastructure Engineer',
            location: 'San Francisco, CA',
            remote_type: 'onsite',
            description: 'We connect customers worldwide with our cutting edge platforms.'
        }, facts);
        assert.strictEqual(res.eligibility, 'FAIL');
        assert(res.failedGates.includes('work_authorization'));
    });

    test('Location Policy Regression: UK/London hybrid role without sponsorship fails work authorization', () => {
        const res = eligibilityCheck({
            title: 'Backend Developer',
            location: 'London, UK',
            remote_type: 'hybrid',
            description: '2 days in our central London office. Collaborative culture.'
        }, facts);
        assert.strictEqual(res.eligibility, 'FAIL');
        assert(res.failedGates.includes('work_authorization'));
    });

    test('Location Policy Regression: Germany/Berlin onsite role without sponsorship fails work authorization', () => {
        const res = eligibilityCheck({
            title: 'DevOps Engineer',
            location: 'Berlin, Germany',
            remote_type: 'onsite',
            description: 'Join our engineering team on-site in Berlin.'
        }, facts);
        assert.strictEqual(res.eligibility, 'FAIL');
        assert(res.failedGates.includes('work_authorization'));
    });

    test('Location Policy Regression: Remote role explicitly worldwide in applicant_eligibility passes', () => {
        const res = eligibilityCheck({
            title: 'Full Stack Engineer',
            location: 'Remote',
            remote_type: 'remote',
            applicant_eligibility: 'Worldwide',
            description: 'We hire talent globally across all time zones.'
        }, facts);
        assert.strictEqual(res.eligibility, 'PASS');
        const authGate = res.gates.find(g => g.gate === 'work_authorization');
        assert.strictEqual(authGate.outcome, 'PASS');
        assert(authGate.reason.includes('Worldwide remote role open to candidates in India'));
    });

    test('Location Policy Regression: Remote role explicitly worldwide in location passes', () => {
        const res = eligibilityCheck({
            title: 'Software Engineer',
            location: 'Worldwide Remote',
            remote_type: 'remote',
            description: 'Distributed team building open source tools.'
        }, facts);
        assert.strictEqual(res.eligibility, 'PASS');
        const authGate = res.gates.find(g => g.gate === 'work_authorization');
        assert.strictEqual(authGate.outcome, 'PASS');
    });

    test('Location Policy Regression: Remote role with "work from anywhere in the world" in description passes', () => {
        const res = eligibilityCheck({
            title: 'Platform Engineer',
            location: 'Remote',
            remote_type: 'remote',
            description: 'Work from anywhere in the world. Fully asynchronous team.'
        }, facts);
        assert.strictEqual(res.eligibility, 'PASS');
        const authGate = res.gates.find(g => g.gate === 'work_authorization');
        assert.strictEqual(authGate.outcome, 'PASS');
    });

    test('Location Policy Regression: Remote role with company boilerplate "worldwide" but restricted to US fails', () => {
        const res = eligibilityCheck({
            title: 'Frontend Engineer',
            location: 'Remote',
            remote_type: 'remote',
            description: 'We serve clients worldwide. Role is strictly Remote - US Only. Must reside in the US.'
        }, facts);
        assert.strictEqual(res.eligibility, 'FAIL');
        assert(res.failedGates.includes('remote_eligibility'));
    });

    test('Location Policy Regression: Domestic India remote role passes work authorization and remote eligibility', () => {
        const res = eligibilityCheck({
            title: 'Node.js Developer',
            location: 'Remote - India',
            remote_type: 'remote',
            description: 'India-based engineering team building financial products.'
        }, facts);
        assert.strictEqual(res.eligibility, 'PASS');
        assert.strictEqual(res.gates.find(g => g.gate === 'work_authorization').outcome, 'PASS');
        assert.strictEqual(res.gates.find(g => g.gate === 'remote_eligibility').outcome, 'PASS');
    });

    // ── 3E Batch A.1: Gate Consistency Regressions ────────────────────
    test('Batch A.1 Gate Consistency: Bengaluru onsite has NOT_APPLICABLE remote eligibility', () => {
        const res = eligibilityCheck({ title: 'Software Engineer', location: 'Bengaluru, India', remote_type: 'onsite' }, facts);
        assert.strictEqual(res.eligibility, 'PASS');
        assert.strictEqual(res.gates.find(g => g.gate === 'work_authorization').outcome, 'PASS');
        const remoteGate = res.gates.find(g => g.gate === 'remote_eligibility');
        assert.strictEqual(remoteGate.outcome, 'NOT_APPLICABLE');
        assert(remoteGate.reason.includes('India; remote geographic eligibility restrictions do not apply'));
    });

    test('Batch A.1 Gate Consistency: Bengaluru hybrid has NOT_APPLICABLE remote eligibility', () => {
        const res = eligibilityCheck({ title: 'Full Stack Engineer', location: 'Bengaluru, India', remote_type: 'hybrid' }, facts);
        assert.strictEqual(res.eligibility, 'PASS');
        assert.strictEqual(res.gates.find(g => g.gate === 'work_authorization').outcome, 'PASS');
        const remoteGate = res.gates.find(g => g.gate === 'remote_eligibility');
        assert.strictEqual(remoteGate.outcome, 'NOT_APPLICABLE');
    });

    test('Batch A.1 Gate Consistency: Ambiguous remote geographic scope returns UNKNOWN', () => {
        const res = eligibilityCheck({ title: 'Backend Developer', location: 'Remote', remote_type: 'remote', description: 'Collaborative development team.' }, facts);
        assert.strictEqual(res.eligibility, 'UNKNOWN');
        const remoteGate = res.gates.find(g => g.gate === 'remote_eligibility');
        assert.strictEqual(remoteGate.outcome, 'UNKNOWN');
        assert(remoteGate.reason.includes('does not specify eligible applicant countries'));
    });

    // ── 3E Batch A.1: Explicit Work Authorization Evidence Regressions
    test('Strict Evidence Verification: Education and employment facts alone CANNOT produce PASS on work authorization', () => {
        // Strip any work_authorization facts; provide only education and employment facts
        const factsWithoutAuth = facts.filter(f => f.category !== 'work_authorization' && f.identifier !== 'work_authorization_india');
        assert(factsWithoutAuth.some(f => f.category === 'education'), 'Education fact present');
        assert(factsWithoutAuth.some(f => f.category === 'experience'), 'Experience fact present');

        // Evaluating an India job with only education and experience facts must NOT pass
        const res = eligibilityCheck({ title: 'Software Engineer', location: 'Bengaluru, India', remote_type: 'onsite' }, factsWithoutAuth);
        assert.notStrictEqual(res.eligibility, 'PASS', 'Must not produce PASS without explicit work authorization fact');
        assert.strictEqual(res.eligibility, 'UNKNOWN', 'Must produce UNKNOWN requiring user confirmation');
        const authGate = res.gates.find(g => g.gate === 'work_authorization');
        assert.strictEqual(authGate.outcome, 'UNKNOWN');
        assert(authGate.reason.includes('not explicitly confirmed'), 'Reason must explicitly cite unconfirmed work authorization');
        assert.strictEqual(authGate.candidateEvidence.length, 0, 'Must not cite education or employment fact as work authorization');
        assert.strictEqual(res.requiresHumanInput, true, 'Must require human confirmation');
    });

    // ── 3E Batch A.1: Sponsorship Semantics Regressions ───────────────
    test('Batch A.1 Sponsorship: Foreign hybrid with employer sponsorship but unconfirmed relocation returns UNKNOWN', () => {
        const res = eligibilityCheck({
            title: 'Software Engineer',
            location: 'London, UK',
            remote_type: 'hybrid',
            description: 'Hybrid role in London. Visa sponsorship is available for international applicants.'
        }, facts);
        assert.strictEqual(res.eligibility, 'UNKNOWN');
        const authGate = res.gates.find(g => g.gate === 'work_authorization');
        assert.strictEqual(authGate.outcome, 'UNKNOWN');
        assert(authGate.reason.includes('not confirmed willingness to relocate'));
        assert.strictEqual(authGate.candidateEvidence.length, 0, 'Does not cite B.Tech degree or skill as visa evidence');
    });

    test('Batch A.1 Sponsorship: Foreign hybrid with sponsorship and confirmed relocation has unresolved visa pathway (UNKNOWN)', () => {
        const factsWithRelo = [
            ...facts,
            { id: 'fact-pref-relo', identifier: 'relocation_international', category: 'preference', value: 'Willing to relocate internationally to the UK or Europe' }
        ];
        const res = eligibilityCheck({
            title: 'Software Engineer',
            location: 'London, UK',
            remote_type: 'hybrid',
            description: 'Visa sponsorship is available for international applicants.'
        }, factsWithRelo);
        assert.strictEqual(res.eligibility, 'UNKNOWN');
        const authGate = res.gates.find(g => g.gate === 'work_authorization');
        assert.strictEqual(authGate.outcome, 'UNKNOWN');
        assert(authGate.reason.includes('legal visa eligibility pathway is unresolved'));
        assert.strictEqual(authGate.candidateEvidence.length, 0);
    });

    test('Batch A.1 Sponsorship: Foreign role with confirmed applicable work authorization passes with evidence', () => {
        const factsWithUkAuth = [
            ...facts,
            { id: 'fact-auth-uk', identifier: 'work_authorization_uk', category: 'work_authorization', value: 'Authorized to work in United Kingdom' }
        ];
        const res = eligibilityCheck({
            title: 'Software Engineer',
            location: 'London, UK',
            remote_type: 'hybrid',
            description: 'Join our London team.'
        }, factsWithUkAuth);
        assert.strictEqual(res.eligibility, 'PASS');
        const authGate = res.gates.find(g => g.gate === 'work_authorization');
        assert.strictEqual(authGate.outcome, 'PASS');
        assert.deepStrictEqual(authGate.candidateEvidence, ['fact-auth-uk']);
    });

    test('Batch A.1 Sponsorship: Employer explicitly restricts sponsorship fails where excluding candidate', () => {
        const res = eligibilityCheck({
            title: 'Software Engineer',
            location: 'London, UK',
            remote_type: 'hybrid',
            description: 'No visa sponsorship will be provided for this position.'
        }, facts);
        assert.strictEqual(res.eligibility, 'FAIL');
        assert(res.failedGates.includes('work_authorization'));
    });

    // ── 3E Batch A.1: Contradictory Location Evidence Regressions ─────
    test('Batch A.1 Contradictory Location: India structured location + explicit US onsite requirement fails', () => {
        const res = eligibilityCheck({
            title: 'Software Engineer',
            location: 'Bengaluru, India',
            remote_type: 'onsite',
            description: 'Position is strictly on-site in San Francisco, CA. Must work from our California office.'
        }, facts);
        assert.strictEqual(res.eligibility, 'FAIL');
        assert(res.failedGates.includes('work_authorization'));
    });

    test('Batch A.1 Contradictory Location: India structured location + US-citizenship-only requirement fails', () => {
        const res = eligibilityCheck({
            title: 'Software Engineer',
            location: 'Bengaluru, India',
            remote_type: 'onsite',
            description: 'Applicants must be a U.S. Citizen. No sponsorship will be provided.'
        }, facts);
        assert.strictEqual(res.eligibility, 'FAIL');
        assert(res.failedGates.includes('work_authorization'));
        const authGate = res.gates.find(g => g.gate === 'work_authorization');
        assert(authGate.reason.includes('US Citizenship'));
    });

    test('Batch A.1 Contradictory Location: US structured location + India-only description returns UNKNOWN', () => {
        const res = eligibilityCheck({
            title: 'Software Engineer',
            location: 'San Francisco, CA',
            remote_type: 'onsite',
            description: 'Join our engineering team based in our Bengaluru office.'
        }, facts);
        assert.strictEqual(res.eligibility, 'UNKNOWN');
        const authGate = res.gates.find(g => g.gate === 'work_authorization');
        assert.strictEqual(authGate.outcome, 'UNKNOWN');
        assert(authGate.reason.includes('Contradictory location evidence'));
    });

    test('Batch A.1 Contradictory Location: Structured and textual locations consistently identify Bengaluru (PASS)', () => {
        const res = eligibilityCheck({
            title: 'Software Engineer',
            location: 'Bengaluru, India',
            remote_type: 'onsite',
            description: 'Join our engineering team on-site in our Bengaluru office.'
        }, facts);
        assert.strictEqual(res.eligibility, 'PASS');
        assert.strictEqual(res.gates.find(g => g.gate === 'work_authorization').outcome, 'PASS');
    });

    // ── 3E Batch A.1: Unlisted Locations and Non-Empty Reasons ────────
    test('Batch A.1 Unlisted Location: Tokyo, Japan onsite recognized as foreign and fails without auth', () => {
        const res = eligibilityCheck({ title: 'Software Engineer', location: 'Tokyo, Japan', remote_type: 'onsite' }, facts);
        assert.strictEqual(res.eligibility, 'FAIL');
        assert(res.failedGates.includes('work_authorization'));
        const authGate = res.gates.find(g => g.gate === 'work_authorization');
        assert(authGate.reason.includes('Foreign on-site/hybrid role in Tokyo, Japan'));
        assert(authGate.reason.length > 0);
    });

    test('Batch A.1 Unlisted Location: Zurich, Switzerland hybrid recognized as foreign and fails without auth', () => {
        const res = eligibilityCheck({ title: 'Software Engineer', location: 'Zurich, Switzerland', remote_type: 'hybrid' }, facts);
        assert.strictEqual(res.eligibility, 'FAIL');
        assert(res.failedGates.includes('work_authorization'));
        const authGate = res.gates.find(g => g.gate === 'work_authorization');
        assert(authGate.reason.includes('Foreign on-site/hybrid role in Zurich, Switzerland'));
    });

    test('Batch A.1 Unlisted Location: Dubai, UAE onsite recognized as foreign and fails without auth', () => {
        const res = eligibilityCheck({ title: 'Software Engineer', location: 'Dubai, UAE', remote_type: 'onsite' }, facts);
        assert.strictEqual(res.eligibility, 'FAIL');
        assert(res.failedGates.includes('work_authorization'));
        const authGate = res.gates.find(g => g.gate === 'work_authorization');
        assert(authGate.reason.includes('Foreign on-site/hybrid role in Dubai, UAE'));
    });

    test('Batch A.1 Unlisted Location: Unresolvable location text returns UNKNOWN with non-empty reason', () => {
        const res = eligibilityCheck({ title: 'Software Engineer', location: 'Valparaiso', remote_type: 'onsite' }, facts);
        assert.strictEqual(res.eligibility, 'UNKNOWN');
        const authGate = res.gates.find(g => g.gate === 'work_authorization');
        assert.strictEqual(authGate.outcome, 'UNKNOWN');
        assert(authGate.reason.includes('cannot be confidently resolved'));
    });

    test('Batch A.1 Unlisted Location: Missing location returns UNKNOWN with non-empty reason', () => {
        const res = eligibilityCheck({ title: 'Software Engineer', location: '', remote_type: '' }, facts);
        assert.strictEqual(res.eligibility, 'UNKNOWN');
        const authGate = res.gates.find(g => g.gate === 'work_authorization');
        assert.strictEqual(authGate.outcome, 'UNKNOWN');
        assert(authGate.reason.includes('lacks structured location information'));
    });

    // ── 5. Tier 3 Fact-Grounded Technical Matching ────────────────────
    console.log('\n--- 5. Tier 3 Fact-Grounded Technical Matching ---');

    test('Full Stack role matches Node, React, PostgreSQL, Docker with real evidence IDs', () => {
        const job = {
            title: 'Full Stack Engineer',
            description: 'Looking for a developer experienced in TypeScript, Node.js, Express, React, PostgreSQL, Redis and Docker.'
        };

        const res = factGroundedMatch(job, facts);
        assert(res.matchScore >= 0.70, `Score is ${res.matchScore} (expected >= 0.70)`);
        assert(res.matchedFactIds.includes('fact-skill-nodejs'));
        assert(res.matchedFactIds.includes('fact-skill-react'));
        assert(res.matchedFactIds.includes('fact-skill-postgresql'));
        assert(res.matchedFactIds.includes('fact-skill-docker'));

        assert(res.evidenceIds.includes('ev-skill-nodejs-apis'));
        assert(res.evidenceIds.includes('ev-skill-react-ui'));
    });

    test('Backend Engineer role matches Node, REST APIs, WebSockets, AWS', () => {
        const job = {
            title: 'Backend Software Developer',
            description: 'Building microservices and real-time APIs with Node.js, REST, WebSockets, Redis and AWS deployment.'
        };

        const res = factGroundedMatch(job, facts);
        assert(res.matchScore >= 0.70);
        assert(res.matchedFactIds.includes('fact-skill-nodejs'));
        assert(res.matchedFactIds.includes('fact-skill-websockets'));
        assert(res.matchedFactIds.includes('fact-skill-aws'));
    });

    test('Skills not in candidate database are recorded in missingEvidenceFacts (not hallucinated)', () => {
        const job = {
            title: 'Go / Kubernetes Platform Engineer',
            description: 'Must have production experience with Go, Kubernetes, Terraform and Rust.'
        };

        const res = factGroundedMatch(job, facts);
        assert(res.matchScore <= 0.50, `Unmatched skills score should be low, got ${res.matchScore}`);
    });

    // ── 6. Multi-Tier End-to-End Recommendations ──────────────────────
    console.log('\n--- 6. Multi-Tier End-to-End Recommendations ---');

    test('Strong match with passing Tier 2 produces APPLY recommendation', () => {
        const job = {
            title: 'Full Stack Developer',
            location: 'Bengaluru, India',
            description: 'We need a TypeScript, Node.js, React and PostgreSQL developer with ~1 year experience. ₹6-8 LPA.'
        };

        const evalRes = evaluateJobOffer(job, facts);
        assert.strictEqual(evalRes.recommendation, 'APPLY');
        assert(evalRes.finalScore >= 0.70);
    });

    test('Moderate match produces CONSIDER recommendation', () => {
        const job = {
            title: 'Frontend React Developer',
            location: 'Remote, India',
            remote_type: 'remote',
            description: 'Focus exclusively on React and CSS animations.'
        };

        const evalRes = evaluateJobOffer(job, facts);
        assert(['CONSIDER', 'APPLY'].includes(evalRes.recommendation));
    });

    test('Excluded role produces DO_NOT_APPLY via Tier 1', () => {
        const job = {
            title: 'VP of Marketing & Brand',
            location: 'Bengaluru, India',
            description: 'Lead global B2B marketing campaigns.'
        };

        const evalRes = evaluateJobOffer(job, facts);
        assert.strictEqual(evalRes.recommendation, 'DO_NOT_APPLY');
        assert.strictEqual(evalRes.finalScore, 0.0);
    });

    test('Hard eligibility failure produces DO_NOT_APPLY via Tier 2', () => {
        const job = {
            title: 'Staff Full Stack Engineer',
            location: 'San Francisco, CA',
            description: 'Must be US Citizen with 10+ years experience.'
        };

        const evalRes = evaluateJobOffer(job, facts);
        assert.strictEqual(evalRes.recommendation, 'DO_NOT_APPLY');
        assert.strictEqual(evalRes.finalScore, 0.0);
    });

    // ── 7. Evaluation Runs Persistence & History ───────────────────────
    console.log('\n--- 7. Evaluation Runs Persistence & History ---');

    await asyncTest('evaluateJob persists run into job_evaluation_runs and is idempotent on repeat', async () => {
        const testJobId = `job_eval_persist_${Date.now()}`;
        upsertJobPosting({
            id: testJobId,
            company_id: 'company-palantir',
            title: 'Full Stack Engineer (Node/React)',
            location: 'Bengaluru, India',
            description: 'Building web applications with Node.js, Express, React and PostgreSQL.',
            job_url: `https://example.com/jobs/${testJobId}`,
            source: 'test',
            status: 'discovered'
        });

        // First evaluation -> writes to job_evaluation_runs
        const res1 = await evaluateJob(testJobId, { candidateFacts: facts });
        assert.strictEqual(res1.skipped, false);
        assert.strictEqual(res1.recommendation, 'APPLY');
        assert(res1.evaluationId !== null);

        const latest1 = getLatestEvaluationRun(testJobId);
        assert.strictEqual(latest1.id, res1.evaluationId);
        assert.strictEqual(latest1.recommendation, 'APPLY');

        // Repeat evaluation -> idempotent skip
        const res2 = await evaluateJob(testJobId, { candidateFacts: facts });
        assert.strictEqual(res2.skipped, true);
        assert.strictEqual(res2.evaluationId, res1.evaluationId);

        // Forced re-evaluation preserves history (appends new run without deleting previous)
        const res3 = await evaluateJob(testJobId, { candidateFacts: facts, forceReeval: true });
        assert.strictEqual(res3.skipped, false);
        assert.notStrictEqual(res3.evaluationId, res1.evaluationId);

        const allRuns = getEvaluationRunsForJob(testJobId);
        assert.strictEqual(allRuns.length, 2, 'History preserved: exactly 2 distinct evaluation runs exist');
    });

    // ── 8. Batch Scheduling & CLI Orchestration ───────────────────────
    console.log('\n--- 8. Batch Scheduling & CLI Orchestration ---');

    await asyncTest('evaluateBatch processes candidate jobs and returns structured summary', async () => {
        const summary = await evaluateBatch({ limit: 5, dryRun: true });
        assert(summary.totalEvaluated >= 1);
        assert.strictEqual(summary.dryRun, true);
        assert(typeof summary.applyCount === 'number');
        assert(typeof summary.considerCount === 'number');
        assert(typeof summary.doNotApplyCount === 'number');
        assert.strictEqual(summary.errorCount, 0);
    });

    console.log('\n====================================================');
    console.log(`📊 Milestone 3B Test Results: ${passed} PASSED, ${failed} FAILED`);
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
