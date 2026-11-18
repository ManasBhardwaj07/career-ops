/**
 * test-milestone1-regression.mjs — Comprehensive Regression Suite for Milestone 1
 *
 * Covers Milestone 1 Requirements:
 *   Part 1: Radio Button Answer Matching (DOM order independence, affirmative/negative, ambiguity, threshold)
 *   Part 2: Expired Submission Lease Recovery (SUBMITTING -> UNCERTAIN, SUBMISSION_APPROVED safety, idempotency)
 *   Part 3: Batch Worker Fault Isolation (Navigation failure isolation, subsequent job processing, state preservation)
 *   Part 4: Canonical Database Immutability Invariant
 */

import assert from 'assert';
import { createHash } from 'crypto';
import { existsSync, readFileSync, unlinkSync, copyFileSync } from 'fs';
import { resolve } from 'path';
import http from 'http';
import { chromium } from 'playwright';

// ── 0. Fail-Closed Test Environment & DB Isolation ─────────────────────────────
process.env.CAREER_OPS_TEST = '1';

const CANONICAL_DB_PATH = resolve(process.cwd(), 'data', 'job_agent.db');
const TEST_DB_PATH = resolve(process.cwd(), 'data', 'test_milestone1_regression.db');

if (!existsSync(CANONICAL_DB_PATH)) {
    throw new Error(`Canonical database missing at ${CANONICAL_DB_PATH}`);
}

const baselineCanonicalHash = createHash('sha256').update(readFileSync(CANONICAL_DB_PATH)).digest('hex');
const baselineCanonicalSize = readFileSync(CANONICAL_DB_PATH).length;

function cleanupTestDb() {
    for (const f of [TEST_DB_PATH, `${TEST_DB_PATH}-wal`, `${TEST_DB_PATH}-shm`]) {
        if (existsSync(f)) {
            try { unlinkSync(f); } catch {}
        }
    }
}

cleanupTestDb();
copyFileSync(CANONICAL_DB_PATH, TEST_DB_PATH);
process.env.JOB_AGENT_DB_PATH = TEST_DB_PATH;

const { getDb, closeDb } = await import('./db/db.mjs');
const { runMigrations } = await import('./db/migrate.js');
runMigrations(getDb(), { quiet: true });

const {
    fillApplicationFields,
    scoreRadioOption,
    matchRadioOption
} = await import('./application/autofill/fill-fields.mjs');

const {
    claimNextApplication,
    recoverExpiredLeases,
    runWorkerCycle,
    runWorkerBatch,
    ensureLeasesTable
} = await import('./application/worker.mjs');

const {
    updateApplicationState,
    getApplication,
    APPLICATION_STATES
} = await import('./db/repo.mjs');

console.log('====================================================');
console.log('🧪 CAREER-OPS MILESTONE 1 REGRESSION SUITE');
console.log('====================================================\n');

let passedTests = 0;
let failedTests = 0;

async function runTestCase(name, fn) {
    try {
        await fn();
        console.log(`  ✅ PASS: ${name}`);
        passedTests++;
    } catch (err) {
        console.error(`  ❌ FAIL: ${name}`);
        console.error(`     Error: ${err.message}`);
        if (err.stack) console.error(err.stack.split('\n').slice(1, 4).join('\n'));
        failedTests++;
    }
}

// ════════════════════════════════════════════════════════════════════════════════
// PART 1: RADIO BUTTON ANSWER MATCHING
// ════════════════════════════════════════════════════════════════════════════════
console.log('--- Part 1: Radio Button Answer Matching ---');

await runTestCase('1.1: scoreRadioOption scoring model verification', async () => {
    // Exact value and label matches
    assert.strictEqual(scoreRadioOption('yes', { value: 'yes', labelText: 'Yes' }), 1.0);
    assert.strictEqual(scoreRadioOption('no', { value: 'no', labelText: 'No' }), 1.0);
    assert.strictEqual(scoreRadioOption('authorized', { value: 'wa_auth', labelText: 'Authorized' }), 1.0);

    // Affirmative synonyms
    assert.strictEqual(scoreRadioOption('yes', { value: '1', labelText: 'I am authorized to work in India' }), 0.95);
    assert.strictEqual(scoreRadioOption('true', { value: '1', labelText: 'Yes' }), 0.95);

    // Negative synonyms
    assert.strictEqual(scoreRadioOption('no', { value: '0', labelText: 'Will not require sponsorship' }), 0.95);
    assert.strictEqual(scoreRadioOption('not required', { value: 'none', labelText: 'No sponsorship needed' }), 0.95);

    // Substring non-boolean matching
    assert.strictEqual(scoreRadioOption('full-time', { value: 'ft', labelText: 'Full-Time Employment' }), 0.88);

    // Irrelevant / zero score
    assert.strictEqual(scoreRadioOption('yes', { value: 'no', labelText: 'No' }), 0.0);
    assert.strictEqual(scoreRadioOption('contract', { value: 'intern', labelText: 'Internship' }), 0.0);
});

await runTestCase('1.2: matchRadioOption ambiguity and threshold rejection', async () => {
    // Single clear winner
    const options1 = [
        { id: 'opt_no', value: 'no', labelText: 'No' },
        { id: 'opt_yes', value: 'yes', labelText: 'Yes' }
    ];
    const res1 = matchRadioOption('yes', options1, 0.85);
    assert.ok(res1.matched);
    assert.strictEqual(res1.matched.id, 'opt_yes');
    assert.strictEqual(res1.confidence, 1.0);

    // Low confidence rejection (< 0.85)
    const options2 = [
        { id: 'opt_a', value: 'a', labelText: 'Contractor' },
        { id: 'opt_b', value: 'b', labelText: 'Intern' }
    ];
    const res2 = matchRadioOption('Full-time', options2, 0.85);
    assert.strictEqual(res2.matched, null);
    assert.ok(res2.confidence < 0.85);

    // Ambiguity rejection (two options tie with identical score >= threshold)
    const options3 = [
        { id: 'opt_h1', value: 'h1', labelText: 'Hybrid 2 days remote' },
        { id: 'opt_h2', value: 'h2', labelText: 'Hybrid 3 days remote' }
    ];
    const res3 = matchRadioOption('hybrid', options3, 0.85);
    assert.strictEqual(res3.matched, null);
    assert.ok(res3.reason.includes('Ambiguous'));
});

await runTestCase('1.3: DOM order independence & reversed order handling', async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    // Form with REVERSED DOM order: "No" is first, "Yes" is second
    const formHtml = `
    <!DOCTYPE html>
    <html><body>
        <form id="reversed-form">
            <fieldset id="wa-grp">
                <legend>Are you legally authorized to work in India?</legend>
                <label><input type="radio" name="work_auth" id="wa_no" value="no" /> No, unauthorized</label>
                <label><input type="radio" name="work_auth" id="wa_yes" value="yes" /> Yes, authorized</label>
            </fieldset>

            <fieldset id="spons-grp">
                <legend>Will you now or in the future require visa sponsorship?</legend>
                <label><input type="radio" name="sponsorship" id="sp_yes" value="yes" /> Yes, require sponsorship</label>
                <label><input type="radio" name="sponsorship" id="sp_no" value="no" /> No sponsorship required</label>
            </fieldset>
        </form>
    </body></html>
    `;
    await page.setContent(formHtml);

    const mappedFields = [
        {
            name: 'work_auth',
            type: 'radio',
            selector: '#wa_no',
            classification: 'work_authorization',
            mappedValue: 'yes',
            status: 'mapped'
        },
        {
            name: 'work_auth',
            type: 'radio',
            selector: '#wa_yes',
            classification: 'work_authorization',
            mappedValue: 'yes',
            status: 'mapped'
        },
        {
            name: 'sponsorship',
            type: 'radio',
            selector: '#sp_yes',
            classification: 'sponsorship',
            mappedValue: 'no',
            status: 'mapped'
        },
        {
            name: 'sponsorship',
            type: 'radio',
            selector: '#sp_no',
            classification: 'sponsorship',
            mappedValue: 'no',
            status: 'mapped'
        }
    ];

    const fillResult = await fillApplicationFields(page, mappedFields);
    assert.strictEqual(fillResult.failedCount, 0);

    const checkedState = await page.evaluate(() => ({
        waYesChecked: document.getElementById('wa_yes').checked,
        waNoChecked: document.getElementById('wa_no').checked,
        spYesChecked: document.getElementById('sp_yes').checked,
        spNoChecked: document.getElementById('sp_no').checked
    }));

    // In reversed order, Yes must STILL be selected, No must be unselected!
    assert.strictEqual(checkedState.waYesChecked, true, 'wa_yes MUST be checked even though wa_no was first in DOM');
    assert.strictEqual(checkedState.waNoChecked, false, 'wa_no MUST NOT be checked');

    // Sponsorship: candidate is No; sp_no must be checked, sp_yes must be unselected
    assert.strictEqual(checkedState.spNoChecked, true, 'sp_no MUST be checked for candidate value "no"');
    assert.strictEqual(checkedState.spYesChecked, false, 'sp_yes MUST NOT be checked');

    await browser.close();
});

await runTestCase('1.4: Unmatched or ambiguous radio options halt safely without clicking', async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    const formHtml = `
    <!DOCTYPE html>
    <html><body>
        <form>
            <fieldset id="shift-grp">
                <legend>Preferred Shift</legend>
                <label><input type="radio" name="shift" id="shift_morning" value="morning" /> Morning Shift</label>
                <label><input type="radio" name="shift" id="shift_night" value="night" /> Night Shift</label>
            </fieldset>
        </form>
    </body></html>
    `;
    await page.setContent(formHtml);

    // Candidate answer is "Rotational", which matches neither option
    const mappedFields = [
        {
            name: 'shift',
            type: 'radio',
            selector: '#shift_morning',
            classification: 'shift_preference',
            mappedValue: 'Rotational',
            status: 'mapped'
        }
    ];

    const fillResult = await fillApplicationFields(page, mappedFields);
    assert.strictEqual(fillResult.successfulCount, 0);
    assert.strictEqual(fillResult.failedCount, 1);
    assert.strictEqual(fillResult.results[0].requiresHumanInput, true);

    const checkedCount = await page.evaluate(() => {
        return document.querySelectorAll('input[type="radio"]:checked').length;
    });
    assert.strictEqual(checkedCount, 0, 'No radio button should be clicked when match confidence is low');

    await browser.close();
});

// ════════════════════════════════════════════════════════════════════════════════
// PART 2: EXPIRED SUBMISSION LEASE RECOVERY
// ════════════════════════════════════════════════════════════════════════════════
console.log('\n--- Part 2: Expired Submission Lease Recovery ---');

const db = getDb();
ensureLeasesTable(db);

// Ensure parent company and job records exist for foreign key constraints
db.prepare(`
    INSERT OR REPLACE INTO companies (id, name, created_at, updated_at)
    VALUES ('comp_test', 'Test Recovery Corp', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
`).run();

db.prepare(`
    INSERT OR REPLACE INTO job_postings (id, company_id, title, job_url, source, status, created_at, updated_at)
    VALUES ('job_test_recovery', 'comp_test', 'Software Engineer', 'http://localhost/test-recovery-job', 'direct', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
`).run();

// Helper to seed a test application with an expired lease
function seedApplicationWithExpiredLease(appId, state, attemptCount = 1) {
    const jobId = `job_rec_${appId}`;
    db.prepare(`
        INSERT OR REPLACE INTO job_postings (id, company_id, title, job_url, source, status, created_at, updated_at)
        VALUES (?, 'comp_test', 'Software Engineer', ?, 'direct', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(jobId, `http://localhost/${jobId}`);

    db.prepare(`
        INSERT OR REPLACE INTO applications (id, job_id, company_id, state, score, created_at, updated_at)
        VALUES (?, ?, 'comp_test', ?, 0.85, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(appId, jobId, state);

    db.prepare(`
        INSERT OR REPLACE INTO application_leases (
            application_id, worker_id, claimed_at, lease_expires_at, attempt_count, status, last_heartbeat_at
        ) VALUES (
            ?, 'crashed_worker_1',
            strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 minutes'),
            strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-10 minutes'),
            ?, 'PROCESSING', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 minutes')
        )
    `).run(appId, attemptCount);
}

await runTestCase('2.1: Expired lease on SUBMITTING transitions to UNCERTAIN_OUTCOME (never NOT_STARTED)', async () => {
    const appId = 'app_test_submitting_crash';
    seedApplicationWithExpiredLease(appId, APPLICATION_STATES.SUBMITTING, 1);

    const recovery = recoverExpiredLeases({ dbInstance: db });
    const recoveredItem = recovery.recovered.find(r => r.applicationId === appId);

    assert.ok(recoveredItem, 'Application must be inspected during recovery');
    assert.strictEqual(recoveredItem.action, 'HELD_UNCERTAIN_FROM_SUBMITTING');
    assert.strictEqual(recoveredItem.state, APPLICATION_STATES.UNCERTAIN_OUTCOME);

    const appAfter = getApplication(appId);
    assert.strictEqual(appAfter.state, APPLICATION_STATES.UNCERTAIN_OUTCOME, 'Application state must be UNCERTAIN_OUTCOME');

    const leaseAfter = db.prepare('SELECT * FROM application_leases WHERE application_id = ?').get(appId);
    assert.strictEqual(leaseAfter.status, 'UNCERTAIN', 'Lease must be marked UNCERTAIN');
});

await runTestCase('2.2: Expired lease on SUBMISSION_APPROVED safely reverts to READY_FOR_REVIEW (never NOT_STARTED)', async () => {
    const appId = 'app_test_approved_recovery';
    seedApplicationWithExpiredLease(appId, APPLICATION_STATES.SUBMISSION_APPROVED, 1);

    const recovery = recoverExpiredLeases({ dbInstance: db });
    const recoveredItem = recovery.recovered.find(r => r.applicationId === appId);

    assert.ok(recoveredItem);
    assert.strictEqual(recoveredItem.action, 'REVERT_READY_FOR_REVIEW');

    const appAfter = getApplication(appId);
    assert.strictEqual(appAfter.state, APPLICATION_STATES.READY_FOR_REVIEW, 'Must safely revert to READY_FOR_REVIEW');

    const leaseAfter = db.prepare('SELECT * FROM application_leases WHERE application_id = ?').get(appId);
    assert.strictEqual(leaseAfter.status, 'RELEASED');
});

await runTestCase('2.3: Ordinary pre-submission lease expiration resets to NOT_STARTED for retry', async () => {
    const appId = 'app_test_presubmission_draft';
    seedApplicationWithExpiredLease(appId, APPLICATION_STATES.DRAFTING, 1);

    const recovery = recoverExpiredLeases({ dbInstance: db });
    const recoveredItem = recovery.recovered.find(r => r.applicationId === appId);

    assert.ok(recoveredItem);
    assert.strictEqual(recoveredItem.action, 'RESET_NOT_STARTED');

    const appAfter = getApplication(appId);
    assert.strictEqual(appAfter.state, APPLICATION_STATES.NOT_STARTED);

    const leaseAfter = db.prepare('SELECT * FROM application_leases WHERE application_id = ?').get(appId);
    assert.strictEqual(leaseAfter.status, 'RELEASED');
});

await runTestCase('2.4: Repeated worker crashes exhaust max attempts and transition to FAILED', async () => {
    const appId = 'app_test_exhaust_retries';
    seedApplicationWithExpiredLease(appId, APPLICATION_STATES.DRAFTING, 3); // 3 attempts already

    const recovery = recoverExpiredLeases({ dbInstance: db });
    const recoveredItem = recovery.recovered.find(r => r.applicationId === appId);

    assert.ok(recoveredItem);
    assert.strictEqual(recoveredItem.action, 'EXHAUSTED_RETRIES');

    const leaseAfter = db.prepare('SELECT * FROM application_leases WHERE application_id = ?').get(appId);
    assert.strictEqual(leaseAfter.status, 'FAILED');
});

await runTestCase('2.5: Repeated recovery calls are idempotent', async () => {
    // Calling recovery a second time when all expired rows were handled
    const recoverySecond = recoverExpiredLeases({ dbInstance: db });
    assert.strictEqual(recoverySecond.totalInspected, 0, 'No remaining processing leases should exist');
    assert.strictEqual(recoverySecond.recovered.length, 0);
});

// ════════════════════════════════════════════════════════════════════════════════
// PART 3: BATCH WORKER FAULT ISOLATION
// ════════════════════════════════════════════════════════════════════════════════
console.log('\n--- Part 3: Batch Worker Fault Isolation ---');

await runTestCase('3.1: Individual application failure does not crash runWorkerBatch', async () => {
    const job1Id = 'job_batch_fail_1';
    const job2Id = 'job_batch_success_2';
    const job3Id = 'job_batch_pause_3';

    const app1Id = 'app_batch_fail_1';
    const app2Id = 'app_batch_success_2';
    const app3Id = 'app_batch_pause_3';

    db.prepare(`INSERT OR REPLACE INTO companies (id, name, created_at, updated_at) VALUES ('comp_batch', 'Batch Corp', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`).run();

    db.prepare(`
        INSERT OR REPLACE INTO job_postings (id, company_id, title, job_url, source, status, created_at, updated_at)
        VALUES
            (?, 'comp_batch', 'Broken Job', 'http://127.0.0.1:59999/nonexistent-portal', 'direct', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
            (?, 'comp_batch', 'Backend Engineer', 'http://localhost/apply/batch-2', 'direct', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
            (?, 'comp_batch', 'Full Stack Engineer', 'http://localhost/apply/batch-3', 'direct', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(job1Id, job2Id, job3Id);

    db.prepare(`
        INSERT OR REPLACE INTO job_evaluation_runs (
            id, job_id, eval_version, tier1_passed, tier2_eligibility, tier2_gates_json, tier3_match_score, recommendation
        ) VALUES
            ('eval_batch_1', ?, '1.0.0', 1, 'PASS', '[]', 0.99, 'APPLY'),
            ('eval_batch_2', ?, '1.0.0', 1, 'PASS', '[]', 0.95, 'APPLY'),
            ('eval_batch_3', ?, '1.0.0', 1, 'PASS', '[]', 0.90, 'APPLY')
    `).run(job1Id, job2Id, job3Id);

    db.prepare(`
        INSERT OR REPLACE INTO applications (id, job_id, company_id, state, score, created_at, updated_at)
        VALUES
            (?, ?, 'comp_batch', 'NOT_STARTED', 0.99, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
            (?, ?, 'comp_batch', 'NOT_STARTED', 0.95, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
            (?, ?, 'comp_batch', 'NOT_STARTED', 0.90, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(app1Id, job1Id, app2Id, job2Id, app3Id, job3Id);

    db.prepare(`DELETE FROM application_leases WHERE application_id IN (?, ?, ?)`).run(app1Id, app2Id, app3Id);

    const validHtml = `
        <!DOCTYPE html>
        <html><body>
            <form id="valid-form">
                <label for="name">Name</label>
                <input type="text" name="name" id="name" />
                <label for="email">Email</label>
                <input type="email" name="email" id="email" />
            </form>
        </body></html>
    `;

    const pauseHtml = `
        <!DOCTYPE html>
        <html><body>
            <form id="pause-form">
                <label for="custom_secret">Custom Secret *</label>
                <input type="text" name="custom_secret" id="custom_secret" required />
            </form>
        </body></html>
    `;

    const batchSummary = await runWorkerBatch({
        workerId: 'worker_isolation_test',
        batchSize: 3,
        options: {
            headless: true,
            dryRun: true,
            perJob: {
                [app2Id]: { htmlContent: validHtml },
                [app3Id]: { htmlContent: pauseHtml }
            }
        },
        logger: () => {}
    });

    assert.ok(batchSummary, 'Batch summary must be returned');
    assert.strictEqual(batchSummary.totalProcessed, 3, 'All 3 queued applications must be processed');
    assert.strictEqual(batchSummary.results.length, 3, 'Must contain 3 cycle results');

    // Job 1 should have failed due to invalid port / navigation error, but was caught and isolated
    const cycle1 = batchSummary.results[0];
    assert.strictEqual(cycle1.applicationId, app1Id);
    assert.strictEqual(cycle1.success, false);
    assert.ok(cycle1.error, 'Cycle 1 must record its error without killing the batch');

    // Job 2 should have completed to READY_FOR_REVIEW
    const cycle2 = batchSummary.results[1];
    assert.strictEqual(cycle2.applicationId, app2Id);
    assert.strictEqual(cycle2.success, true);
    assert.strictEqual(cycle2.status, APPLICATION_STATES.READY_FOR_REVIEW);

    // Job 3 should have halted at NEEDS_USER_INPUT
    const cycle3 = batchSummary.results[2];
    assert.strictEqual(cycle3.applicationId, app3Id);
    assert.strictEqual(cycle3.success, true);
    assert.strictEqual(cycle3.status, APPLICATION_STATES.NEEDS_USER_INPUT);
});

// ════════════════════════════════════════════════════════════════════════════════
// PART 4: CANONICAL DATABASE IMMUTABILITY INVARIANT
// ════════════════════════════════════════════════════════════════════════════════
console.log('\n--- Part 4: Canonical Database Immutability Check ---');

await runTestCase('4.1: Canonical database SHA-256 and byte-size are strictly unchanged', async () => {
    closeDb();
    cleanupTestDb();

    const currentHash = createHash('sha256').update(readFileSync(CANONICAL_DB_PATH)).digest('hex');
    const currentSize = readFileSync(CANONICAL_DB_PATH).length;

    assert.strictEqual(currentHash, baselineCanonicalHash, 'CANONICAL DB MUTATION DETECTED: Hash mismatch!');
    assert.strictEqual(currentSize, baselineCanonicalSize, 'CANONICAL DB MUTATION DETECTED: Size mismatch!');
    assert.strictEqual(currentSize, 40374272, 'Canonical DB size must match exactly 40,374,272 bytes');
});

console.log('====================================================');
console.log(`📊 Milestone 1 Regression Results: ${passedTests} PASSED, ${failedTests} FAILED`);
console.log('====================================================\n');

if (failedTests > 0) {
    process.exit(1);
} else {
    process.exit(0);
}
