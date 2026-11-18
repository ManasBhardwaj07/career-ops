/**
 * test-discovery-expansion.mjs — Comprehensive Test Suite for Discovery Expansion
 *
 * Implements Deliverable 5 Phase 4:
 *   - Internshala adapter parsing and normalization (D1)
 *   - Hirist adapter parsing, liveness check, and error handling (D2)
 *   - JobSpy bridge ingestion and normalization (D3)
 *   - Rule R20 Quarantine Manager (3-consecutive-zero auto-quarantine)
 *   - Employer registry growth helper (D5)
 *   - Canonical database immutability verification
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import { InternshalaAdapter } from './discovery/adapters/internshala-adapter.mjs';
import { HiristAdapter } from './discovery/adapters/hirist-adapter.mjs';
import { JobSpyAdapter } from './discovery/adapters/jobspy-adapter.mjs';
import { SourceQuarantineManager } from './discovery/source-quarantine.mjs';
import { proposeEmployers, inferAtsFromUrl } from './scripts/propose-employers.mjs';

// Enforce test isolation flag
process.env.CAREER_OPS_TEST = '1';

const CANONICAL_DB_PATH = path.resolve('data/job_agent.db');
const TEST_QUARANTINE_FILE = path.resolve('data/test_quarantine_state.json');

function getFileHash(filePath) {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(content).digest('hex');
}

const CANONICAL_HASH_BEFORE = getFileHash(CANONICAL_DB_PATH);

console.log('====================================================');
console.log('🧪 DELIVERABLE 5 — DISCOVERY EXPANSION & R20 QUARANTINE');
console.log('====================================================\n');

let testPassed = 0;
let testFailed = 0;

function runTest(name, fn) {
    try {
        fn();
        console.log(`  ✅ PASS: ${name}`);
        testPassed++;
    } catch (err) {
        console.error(`  ❌ FAIL: ${name}`);
        console.error(`     Error: ${err.message}`);
        testFailed++;
    }
}

async function runTestAsync(name, fn) {
    try {
        await fn();
        console.log(`  ✅ PASS: ${name}`);
        testPassed++;
    } catch (err) {
        console.error(`  ❌ FAIL: ${name}`);
        console.error(`     Error: ${err.message}`);
        testFailed++;
    }
}

// ── 1. Internshala Adapter (D1) ───────────────────────────────────────────
console.log('--- 1. Internshala Adapter (D1) ---');

runTest('InternshalaAdapter parses structured JSON feed correctly', () => {
    const adapter = new InternshalaAdapter();
    const mockPayload = {
        internships_meta: {
            "1001": {
                id: 1001,
                title: "Full Stack Developer (MERN)",
                company_name: "Razorpay",
                location_names: ["Bengaluru", "Work from home"],
                is_work_from_home: true,
                stipend: { salary: "₹ 35,000 /month" },
                url: "/internship/detail/full-stack-developer-1001",
                is_internship: true,
                skills: ["React", "Node.js", "MongoDB"]
            },
            "1002": {
                id: 1002,
                title: "Associate Software Engineer",
                company_name: "Postman",
                location_names: ["Bengaluru"],
                is_work_from_home: false,
                stipend: { salary: "₹ 8,00,000 /year" },
                url: "https://internshala.com/job/detail/associate-software-engineer-1002",
                is_internship: false,
                skills: ["JavaScript", "TypeScript"]
            }
        }
    };

    const jobs = adapter.parseResponse(mockPayload);
    assert.strictEqual(jobs.length, 2);

    // Job 1 assertions
    const j1 = jobs[0];
    assert.strictEqual(j1.title, "Full Stack Developer (MERN)");
    assert.strictEqual(j1.company_name, "Razorpay");
    assert.strictEqual(j1.remote_type, "remote");
    assert.strictEqual(j1.employment_type, "internship");
    assert.strictEqual(j1.job_url, "https://internshala.com/internship/detail/full-stack-developer-1001");
    assert(j1.description.includes("₹ 35,000 /month"));
    assert(j1.description.includes("React, Node.js"));

    // Job 2 assertions
    const j2 = jobs[1];
    assert.strictEqual(j2.title, "Associate Software Engineer");
    assert.strictEqual(j2.company_name, "Postman");
    assert.strictEqual(j2.remote_type, "onsite");
    assert.strictEqual(j2.employment_type, "full-time");
});

// ── 2. Hirist Adapter (D2) ─────────────────────────────────────────────────
console.log('\n--- 2. Hirist Adapter (D2) ---');

runTest('HiristAdapter parses valid listings correctly', () => {
    const adapter = new HiristAdapter();
    const mockPayload = {
        jobs: [
            {
                id: "hirist_991",
                title: "Backend Engineer - Node.js/Go",
                company: "CRED",
                city: "Bengaluru",
                url: "https://www.hirist.tech/j/backend-engineer-991",
                description: "Design high throughput backend systems."
            }
        ]
    };

    const jobs = adapter.parseResponse(mockPayload);
    assert.strictEqual(jobs.length, 1);
    const j = jobs[0];
    assert.strictEqual(j.title, "Backend Engineer - Node.js/Go");
    assert.strictEqual(j.company_name, "CRED");
    assert.strictEqual(j.source, "hirist");
    assert.strictEqual(j.location, "Bengaluru");
});

// ── 3. Rule R20 Quarantine Policy ──────────────────────────────────────────
console.log('\n--- 3. Rule R20 Operational Quarantine Policy ---');

if (fs.existsSync(TEST_QUARANTINE_FILE)) {
    fs.unlinkSync(TEST_QUARANTINE_FILE);
}
const testQuarantine = new SourceQuarantineManager({ stateFile: TEST_QUARANTINE_FILE, threshold: 3 });

runTest('Healthy zero-vacancy responses (jobsFound: 0, error: null) do NOT trigger quarantine', () => {
    // 3 consecutive healthy empty responses (e.g. niche search returns 0 jobs on an active board)
    testQuarantine.recordSourceRun('healthy_portal', { jobsFound: 0, error: null });
    testQuarantine.recordSourceRun('healthy_portal', { jobsFound: 0, error: null });
    testQuarantine.recordSourceRun('healthy_portal', { jobsFound: 0, error: null });

    assert.strictEqual(testQuarantine.isSourceQuarantined('healthy_portal'), false);
    const status = testQuarantine.getSourceQuarantineStatus('healthy_portal');
    assert.strictEqual(status.consecutiveOperationalFailures, 0);
    assert.strictEqual(status.consecutiveEmptyRuns, 3);
});

runTest('Operational failures (HTTP 403, timeout, dead endpoint) increment failure count', () => {
    testQuarantine.recordSourceRun('hirist_test', { jobsFound: 0, error: 'Network timeout' });
    assert.strictEqual(testQuarantine.isSourceQuarantined('hirist_test'), false);

    testQuarantine.recordSourceRun('hirist_test', { jobsFound: 0, error: 'HTTP 403 Forbidden' });
    assert.strictEqual(testQuarantine.isSourceQuarantined('hirist_test'), false);
    const status = testQuarantine.getSourceQuarantineStatus('hirist_test');
    assert.strictEqual(status.consecutiveOperationalFailures, 2);
});

runTest('Rule R20: 3rd consecutive operational failure auto-quarantines source', () => {
    testQuarantine.recordSourceRun('hirist_test', { jobsFound: 0, error: 'Endpoint dead / connection refused' });
    assert.strictEqual(testQuarantine.isSourceQuarantined('hirist_test'), true);

    const status = testQuarantine.getSourceQuarantineStatus('hirist_test');
    assert(status.quarantineReason.includes('Rule R20'));
    assert(status.quarantineReason.includes('3 consecutive operational failures'));
});

runTest('Successful fetch resets failure count and lifts quarantine', () => {
    testQuarantine.recordSourceRun('hirist_test', { jobsFound: 5, error: null });
    assert.strictEqual(testQuarantine.isSourceQuarantined('hirist_test'), false);
    const status = testQuarantine.getSourceQuarantineStatus('hirist_test');
    assert.strictEqual(status.consecutiveOperationalFailures, 0);
});

// ── 4. JobSpy Bridge (D3) ─────────────────────────────────────────────────
console.log('\n--- 4. JobSpy Multi-Portal Bridge (D3) ---');

await runTestAsync('JobSpyAdapter ingests normalized jobs via Python bridge', async () => {
    const adapter = new JobSpyAdapter();
    const result = await adapter.fetchJobs({
        searchTerm: 'Full Stack Developer',
        location: 'India',
        mock: true
    });

    assert.strictEqual(result.quarantined, false);
    assert.strictEqual(result.mock, true);
    assert(result.jobs.length >= 2);

    const j1 = result.jobs.find(j => j.source === 'jobspy_naukri');
    assert(j1 !== undefined);
    assert(j1.title.includes('Full Stack Developer'));
    assert.strictEqual(j1.company_name, 'Swiggy');

    const j2 = result.jobs.find(j => j.source === 'jobspy_indeed');
    assert(j2 !== undefined);
    assert.strictEqual(j2.remote_type, 'remote');
    assert.strictEqual(j2.company_name, 'Paytm');
});

// ── 5. Employer Registry Growth Helper (D5) ───────────────────────────────
console.log('\n--- 5. Employer Registry Growth Helper (D5) ---');

runTest('inferAtsFromUrl correctly detects ATS boards', () => {
    const gh = inferAtsFromUrl('https://boards.greenhouse.io/zomato/jobs/12345');
    assert.deepStrictEqual(gh, { ats: 'greenhouse', board: 'zomato' });

    const lever = inferAtsFromUrl('https://jobs.lever.co/clevertap/abcdef');
    assert.deepStrictEqual(lever, { ats: 'lever', board: 'clevertap' });

    const ashby = inferAtsFromUrl('https://jobs.ashbyhq.com/postman/98765');
    assert.deepStrictEqual(ashby, { ats: 'ashby', board: 'postman' });

    const generic = inferAtsFromUrl('https://careers.google.com/jobs/results/123');
    assert.strictEqual(generic, null);
});

runTest('proposeEmployers aggregates candidate companies from DB and infers ATS', () => {
    const testDb = new DatabaseSync(':memory:');
    testDb.exec(`
        CREATE TABLE job_postings (
            id TEXT PRIMARY KEY,
            company_name TEXT,
            job_url TEXT,
            title TEXT
        );
        INSERT INTO job_postings VALUES
        ('j1', 'UnicornStartup', 'https://boards.greenhouse.io/unicornstartup/jobs/101', 'Frontend Developer'),
        ('j2', 'UnicornStartup', 'https://boards.greenhouse.io/unicornstartup/jobs/102', 'Backend Engineer'),
        ('j3', 'StealthAI', 'https://jobs.lever.co/stealthai/job201', 'Full Stack Developer');
    `);

    const proposals = proposeEmployers({ db: testDb, minPostings: 1 });
    assert(proposals.length >= 2);

    const p1 = proposals.find(p => p.name === 'UnicornStartup');
    assert(p1 !== undefined);
    assert.strictEqual(p1.postings_count, 2);
    assert.strictEqual(p1.ats_provider, 'greenhouse');
    assert.strictEqual(p1.board_identifier, 'unicornstartup');
    assert(p1.yaml_snippet.includes('name: "UnicornStartup"'));

    const p2 = proposals.find(p => p.name === 'StealthAI');
    assert(p2 !== undefined);
    assert.strictEqual(p2.ats_provider, 'lever');

    testDb.close();
});

// ── 6. Canonical Database Immutability ─────────────────────────────────────
console.log('\n--- 6. Canonical Database Immutability Check ---');

runTest('Canonical database remains byte-identical', () => {
    const hashAfter = getFileHash(CANONICAL_DB_PATH);
    assert.strictEqual(hashAfter, CANONICAL_HASH_BEFORE, 'Canonical database hash must not change during test!');
});

// Cleanup test quarantine file
if (fs.existsSync(TEST_QUARANTINE_FILE)) {
    fs.unlinkSync(TEST_QUARANTINE_FILE);
}

console.log('\n====================================================');
console.log(`📊 Discovery Expansion Results: ${testPassed} PASSED, ${testFailed} FAILED`);
console.log('====================================================');

if (testFailed > 0) {
    process.exit(1);
}
