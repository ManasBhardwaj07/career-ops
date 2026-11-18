/**
 * test-recurring-runner.mjs — Regression Suite for Recurring Runner & Orchestrator
 *
 * Covers Deliverable 4 Section 6 Requirements (Cases 1–9):
 *   - Case 1: Refuses to start if auto_submit_enabled is true (R13 safety gate)
 *   - Case 2: Overlap lock prevents second concurrent runner instance
 *   - Case 3: Stale lock (> 2x budget, dead PID) is safely broken and recovered
 *   - Case 4: Pipeline stage timeout aborts cleanly and logs DEGRADED
 *   - Case 5: Worker batch processes enqueued NOT_STARTED apps up to batch limit
 *   - Case 6: Human checkpoint pauses apps at READY_FOR_REVIEW / NEEDS_USER_INPUT (none auto-submitted)
 *   - Case 7: High NEEDS_USER_INPUT count (> 5) raises alert in cycle report
 *   - Case 8: Cycle report written to data/runs/ with valid schema
 *   - Case 9: Clean SIGINT handling releases lockfile
 */

import assert from 'assert';
import { createHash } from 'crypto';
import { existsSync, readFileSync, writeFileSync, unlinkSync, copyFileSync, rmSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DB_PATH = resolve(process.cwd(), 'data', 'test_recurring_runner.db');
const CANONICAL_DB_PATH = resolve(process.cwd(), 'data', 'job_agent.db');
const TEST_LOCK_PATH = resolve(process.cwd(), 'data', 'test_runner.lock');
const TEST_RUNS_DIR = resolve(process.cwd(), 'data', 'test_runs');

// Baseline canonical hash check
if (!existsSync(CANONICAL_DB_PATH)) {
    throw new Error(`Canonical database missing at ${CANONICAL_DB_PATH}`);
}
const baselineCanonicalHash = createHash('sha256').update(readFileSync(CANONICAL_DB_PATH)).digest('hex');

function safeCleanupTestDb() {
    if (resolve(TEST_DB_PATH) === resolve(CANONICAL_DB_PATH)) {
        throw new Error('FAIL-CLOSED SAFETY: Attempted to cleanup canonical DB!');
    }
    for (const f of [TEST_DB_PATH, `${TEST_DB_PATH}-wal`, `${TEST_DB_PATH}-shm`, TEST_LOCK_PATH]) {
        if (existsSync(f)) {
            try { unlinkSync(f); } catch {}
        }
    }
    if (existsSync(TEST_RUNS_DIR)) {
        try { rmSync(TEST_RUNS_DIR, { recursive: true, force: true }); } catch {}
    }
}

safeCleanupTestDb();
copyFileSync(CANONICAL_DB_PATH, TEST_DB_PATH);
mkdirSync(TEST_RUNS_DIR, { recursive: true });

// Setup test environment
process.env.CAREER_OPS_TEST = '1';
process.env.JOB_AGENT_DB_PATH = TEST_DB_PATH;

const { getDb, closeDb } = await import('./db/db.mjs');
const { runMigrations } = await import('./db/migrate.js');
runMigrations(getDb(), { quiet: true });

// Close all active postings in test DB so test fixtures are isolated
{
    const db = getDb();
    db.prepare("UPDATE job_postings SET status = 'closed' WHERE status IN ('discovered', 'active')").run();
    db.prepare("INSERT OR REPLACE INTO candidate_facts (id, category, identifier, value, verified) VALUES ('f_name', 'identity', 'full_name', 'Jordan Lee', 1)").run();
    db.prepare("INSERT OR REPLACE INTO candidate_facts (id, category, identifier, value, verified) VALUES ('f_email', 'identity', 'email', 'jordan.synthetic@example.test', 1)").run();
    db.prepare("INSERT OR REPLACE INTO candidate_facts (id, category, identifier, value, verified) VALUES ('f_phone', 'identity', 'phone', '+00-0000000000', 1)").run();
    db.prepare("INSERT OR REPLACE INTO candidate_facts (id, category, identifier, value, verified) VALUES ('f_loc', 'identity', 'location', 'Bengaluru, India', 1)").run();
}

const mockPortalHtml = `<!DOCTYPE html>
<html>
<head><title>Careers at Acme Corp</title></head>
<body>
  <div id="app">
    <h1>Software Engineer</h1>
    <form id="application_form" action="/portal/greenhouse/submit" method="POST" enctype="multipart/form-data">
      <div class="field">
        <label for="first_name">First Name</label>
        <input type="text" id="first_name" name="first_name" value="Jordan" required />
      </div>
      <div class="field">
        <label for="last_name">Last Name</label>
        <input type="text" id="last_name" name="last_name" value="Lee" required />
      </div>
      <div class="field">
        <label for="email">Email</label>
        <input type="email" id="email" name="email" value="jordan.synthetic@example.test" required />
      </div>
      <div class="field">
        <label for="phone">Phone</label>
        <input type="tel" id="phone" name="phone" value="+1-555-0199" required />
      </div>
      <button type="submit" id="submit_app">Submit Application</button>
    </form>
  </div>
</body>
</html>`;

const {
    checkAutoSubmitSafetyGate,
    acquireRunnerLock,
    releaseRunnerLock,
    registerSignalHandlers,
    runBoundedStage,
    writeCycleReport,
    runRecurringCycle
} = await import('./scripts/recurring-runner.mjs');

const {
    getApplication,
    updateApplicationState,
    upsertCompany,
    upsertJobPosting,
    insertJobEvaluationRun,
    APPLICATION_STATES
} = await import('./db/repo.mjs');

let passedTests = 0;
let failedTests = 0;

async function runTestCase(name, fn) {
    try {
        await fn();
        console.log(`  ✅ PASS: ${name}`);
        passedTests++;
    } catch (err) {
        console.error(`  ❌ FAIL: ${name}`);
        console.error(err);
        failedTests++;
    }
}

console.log('====================================================');
console.log('🧪 DELIVERABLE 4 — RECURRING RUNNER TEST SUITE');
console.log('====================================================\n');

// ── Case 1: Refuses to start if auto_submit_enabled is true ───────────
await runTestCase('Case 1: Refuses to start if auto_submit_enabled is true (R13)', async () => {
    // 1. Env check
    assert.throws(() => {
        checkAutoSubmitSafetyGate({ env: { CAREER_OPS_AUTO_SUBMIT: 'true' } });
    }, /SAFETY GATE VIOLATION/);

    assert.throws(() => {
        checkAutoSubmitSafetyGate({ env: { AUTO_SUBMIT_ENABLED: '1' } });
    }, /SAFETY GATE VIOLATION/);

    // 2. Default clean env succeeds
    assert.strictEqual(checkAutoSubmitSafetyGate({ env: {} }), true);
});

// ── Case 2: Overlap lock prevents second concurrent runner instance ───
await runTestCase('Case 2: Overlap lock prevents second concurrent runner instance', async () => {
    if (existsSync(TEST_LOCK_PATH)) unlinkSync(TEST_LOCK_PATH);

    const lock = acquireRunnerLock(TEST_LOCK_PATH, {
        cycleId: 'cycle_test_c2',
        stage: 'PIPELINE'
    });
    assert.strictEqual(lock.pid, process.pid);

    // Attempting to acquire again with live PID throws CONCURRENCY_LOCKED
    assert.throws(() => {
        acquireRunnerLock(TEST_LOCK_PATH, {
            cycleId: 'cycle_test_c2_second',
            stage: 'PIPELINE'
        });
    }, /CONCURRENCY_LOCKED/);

    releaseRunnerLock(TEST_LOCK_PATH);
    assert.strictEqual(existsSync(TEST_LOCK_PATH), false);
});

// ── Case 3: Stale lock (> 2x budget, dead PID) is safely broken ────────
await runTestCase('Case 3: Stale lock (> 2x budget, dead PID) is safely broken and recovered', async () => {
    // Write stale lock with dead PID and old timestamp
    const deadPid = 99999999;
    const oldTimestamp = new Date(Date.now() - 3600000).toISOString(); // 1 hour ago
    writeFileSync(TEST_LOCK_PATH, JSON.stringify({
        pid: deadPid,
        cycle_id: 'cycle_dead',
        started_at: oldTimestamp,
        stage: 'PIPELINE'
    }), 'utf8');

    let warningLogged = false;
    const lock = acquireRunnerLock(TEST_LOCK_PATH, {
        cycleId: 'cycle_recovered',
        stage: 'PIPELINE',
        maxLockAgeMs: 60000,
        logger: (msg) => {
            if (msg.includes('Breaking stale lock')) warningLogged = true;
        }
    });

    assert.strictEqual(lock.pid, process.pid);
    assert.strictEqual(warningLogged, true);
    releaseRunnerLock(TEST_LOCK_PATH);
});

// ── Case 4: Pipeline stage timeout aborts cleanly and logs DEGRADED ───
await runTestCase('Case 4: Pipeline stage timeout aborts cleanly and logs DEGRADED', async () => {
    const stageResult = await runBoundedStage('slow_stage', async () => {
        await new Promise(res => setTimeout(res, 200));
        return { ok: true };
    }, 50, () => {});

    assert.strictEqual(stageResult.success, false);
    assert.strictEqual(stageResult.timedOut, true);
    assert.match(stageResult.error, /TIMEOUT: Stage 'slow_stage' exceeded timeout budget/);
});

// ── Case 5: Worker batch processes enqueued NOT_STARTED apps up to limit
await runTestCase('Case 5: Worker batch processes enqueued NOT_STARTED apps up to batch limit', async () => {
    const db = getDb();
    const uid = Date.now();
    const companyId = `comp_c5_${uid}`;
    upsertCompany({ id: companyId, name: `C5 Corp ${uid}`, domain: `c5-${uid}.com` });
    const existingPdf = resolve(process.cwd(), 'output', 'resumes', 'jordan-lee-backend.pdf');

    // Insert 3 test jobs and 3 NOT_STARTED applications
    for (let i = 1; i <= 3; i++) {
        const jobId = `job_c5_${uid}_${i}`;
        const appId = `app_c5_${uid}_${i}`;
        const resumeVerId = `rv_c5_${uid}_${i}`;

        upsertJobPosting({
            id: jobId,
            company_id: companyId,
            title: `Engineer ${i}`,
            location: 'Remote',
            remote_type: 'remote',
            job_url: `https://boards.greenhouse.io/c5/jobs/${uid}_${i}`,
            source: 'greenhouse',
            status: 'active'
        });

        insertJobEvaluationRun({
            job_id: jobId,
            eval_version: '3B.1.0',
            tier1_passed: 1,
            tier2_eligibility: 'PASS',
            recommendation: 'APPLY'
        });

        db.prepare(`
            INSERT INTO resume_versions (id, job_id, format, file_path, tailored, created_at)
            VALUES (?, ?, 'pdf', ?, 1, CURRENT_TIMESTAMP)
        `).run(resumeVerId, jobId, existingPdf);

        db.prepare(`
            INSERT INTO applications (id, job_id, company_id, resume_version_id, state, score, created_at)
            VALUES (?, ?, ?, ?, 'NOT_STARTED', ?, CURRENT_TIMESTAMP)
        `).run(appId, jobId, companyId, resumeVerId, 0.85 + (i * 0.02));
    }

    const { runWorkerBatch } = await import('./application/worker.mjs');
    const batchResult = await runWorkerBatch({
        batchSize: 2,
        dryRun: true,
        options: { htmlContent: mockPortalHtml, headless: true },
        standingPolicyOverrides: { auto_submit_enabled: false },
        logger: () => {}
    });

    assert.strictEqual(batchResult.totalProcessed, 2);
});

// ── Case 6: Human checkpoint pauses apps at READY_FOR_REVIEW / NEEDS_USER_INPUT
await runTestCase('Case 6: Human checkpoint pauses apps at READY_FOR_REVIEW / NEEDS_USER_INPUT (none auto-submitted)', async () => {
    const db = getDb();
    const uid = Date.now() + 1;
    const companyId = `comp_c6_${uid}`;
    upsertCompany({ id: companyId, name: `C6 Corp ${uid}`, domain: `c6-${uid}.com` });
    const existingPdf = resolve(process.cwd(), 'output', 'resumes', 'jordan-lee-backend.pdf');

    const jobId = `job_c6_${uid}`;
    const appId = `app_c6_${uid}`;
    const resumeVerId = `rv_c6_${uid}`;

    upsertJobPosting({
        id: jobId,
        company_id: companyId,
        title: 'React Developer',
        location: 'Remote',
        remote_type: 'remote',
        job_url: `https://boards.greenhouse.io/c6/jobs/${uid}`,
        source: 'greenhouse',
        status: 'active'
    });

    insertJobEvaluationRun({
        job_id: jobId,
        eval_version: '3B.1.0',
        tier1_passed: 1,
        tier2_eligibility: 'PASS',
        recommendation: 'APPLY'
    });

    db.prepare(`
        INSERT INTO resume_versions (id, job_id, format, file_path, tailored, created_at)
        VALUES (?, ?, 'pdf', ?, 1, CURRENT_TIMESTAMP)
    `).run(resumeVerId, jobId, existingPdf);

    db.prepare(`
        INSERT INTO applications (id, job_id, company_id, resume_version_id, state, score, created_at)
        VALUES (?, ?, ?, ?, 'NOT_STARTED', 0.88, CURRENT_TIMESTAMP)
    `).run(appId, jobId, companyId, resumeVerId);

    const { runWorkerBatch } = await import('./application/worker.mjs');
    await runWorkerBatch({
        batchSize: 1,
        dryRun: true,
        options: { htmlContent: mockPortalHtml, headless: true },
        standingPolicyOverrides: { auto_submit_enabled: false },
        logger: () => {}
    });

    const finalApp = getApplication(appId);
    assert.ok(
        [APPLICATION_STATES.READY_FOR_REVIEW, APPLICATION_STATES.NEEDS_USER_INPUT].includes(finalApp.state),
        `Expected state READY_FOR_REVIEW or NEEDS_USER_INPUT, got: ${finalApp.state}`
    );
    assert.strictEqual(finalApp.recruitment_outcome, null);
});

// ── Case 7: High NEEDS_USER_INPUT count (> 5) raises alert in report ───
await runTestCase('Case 7: High NEEDS_USER_INPUT count (> 5) raises alert in cycle report', async () => {
    const db = getDb();
    const uid = Date.now() + 2;

    // Seed 6 applications in NEEDS_USER_INPUT
    for (let i = 1; i <= 6; i++) {
        const appId = `app_nui_${uid}_${i}`;
        const jobId = `job_nui_${uid}_${i}`;
        const compId = `comp_nui_${uid}_${i}`;

        upsertCompany({ id: compId, name: `NUI ${i}`, domain: `nui${i}.com` });
        upsertJobPosting({
            id: jobId,
            company_id: compId,
            title: `Job ${i}`,
            job_url: `https://boards.greenhouse.io/nui/jobs/${uid}_${i}`,
            source: 'greenhouse',
            status: 'active'
        });
        db.prepare(`
            INSERT INTO applications (id, job_id, company_id, state, score)
            VALUES (?, ?, ?, 'NEEDS_USER_INPUT', 0.75)
        `).run(appId, jobId, compId);
    }

    const report = await runRecurringCycle({
        dbPath: TEST_DB_PATH,
        lockPath: TEST_LOCK_PATH,
        runsDir: TEST_RUNS_DIR,
        dryRun: true,
        batchLimit: 0, // don't process further apps
        logger: () => {}
    });

    assert.ok(report.counts.needs_user_input >= 6, `Expected >= 6 needs_user_input, got: ${report.counts.needs_user_input}`);
    const hasAlert = report.alerts.some(a => a.includes('HIGH_PRIORITY_ALERT: Needs User Input count'));
    assert.strictEqual(hasAlert, true, 'Report must contain HIGH_PRIORITY_ALERT when needs_user_input > 5');
});

// ── Case 8: Cycle report written to data/runs/ with valid schema ───────
await runTestCase('Case 8: Cycle report written to data/runs/ with valid schema', async () => {
    const report = await runRecurringCycle({
        dbPath: TEST_DB_PATH,
        lockPath: TEST_LOCK_PATH,
        runsDir: TEST_RUNS_DIR,
        dryRun: true,
        batchLimit: 0,
        logger: () => {}
    });

    const reportFile = resolve(TEST_RUNS_DIR, `cycle-${report.cycle_id}.json`);
    assert.strictEqual(existsSync(reportFile), true);

    const parsed = JSON.parse(readFileSync(reportFile, 'utf8'));
    assert.strictEqual(parsed.cycle_id, report.cycle_id);
    assert.ok(parsed.started_at);
    assert.ok(parsed.finished_at);
    assert.strictEqual(typeof parsed.duration_ms, 'number');
    assert.ok(parsed.stages);
    assert.ok(parsed.counts);
    assert.strictEqual(parsed.counts.auto_submitted, 0);
    assert.ok(Array.isArray(parsed.alerts));
    assert.ok(['COMPLETED', 'DEGRADED', 'FAILED'].includes(parsed.status));
});

// ── Case 9: Clean SIGINT handling releases lockfile ───────────────────
await runTestCase('Case 9: Clean SIGINT handling releases lockfile', async () => {
    if (existsSync(TEST_LOCK_PATH)) unlinkSync(TEST_LOCK_PATH);

    acquireRunnerLock(TEST_LOCK_PATH, {
        cycleId: 'cycle_sigint_test',
        stage: 'INITIALIZING',
        logger: () => {}
    });

    assert.strictEqual(existsSync(TEST_LOCK_PATH), true, 'Lockfile should exist before SIGINT');

    let capturedExitCode = null;
    const cleanupListener = registerSignalHandlers(TEST_LOCK_PATH, {
        logger: () => {},
        exitFn: (code) => { capturedExitCode = code; }
    });

    try {
        process.emit('SIGINT');
        assert.strictEqual(existsSync(TEST_LOCK_PATH), false, 'Lockfile must be unlinked after SIGINT');
        assert.strictEqual(capturedExitCode, 130, 'Exit code for SIGINT should be 130');
    } finally {
        cleanupListener();
        if (existsSync(TEST_LOCK_PATH)) unlinkSync(TEST_LOCK_PATH);
    }
});

// Teardown & Canonical Immutability Verification
safeCleanupTestDb();
closeDb();

const finalCanonicalHash = createHash('sha256').update(readFileSync(CANONICAL_DB_PATH)).digest('hex');
assert.strictEqual(
    finalCanonicalHash,
    baselineCanonicalHash,
    'CRITICAL FAILURE: Canonical DB was mutated during test-recurring-runner execution!'
);

console.log('\n====================================================');
console.log(`📊 Recurring Runner Results: ${passedTests} PASSED, ${failedTests} FAILED`);
console.log('🔒 Canonical DB SHA-256 byte-identical verification: PASSED');
console.log('====================================================\n');

if (failedTests > 0) {
    process.exit(1);
}
