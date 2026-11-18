/**
 * test-submission-cli-flow.mjs — Submission CLI Flow & Single Lifecycle Verification Suite
 *
 * Tests all 9 required cases for Deliverable 1:
 *   Case 1: No auth rejection
 *   Case 2: Packet tampering rejection
 *   Case 3: Resume mismatch rejection
 *   Case 4: Live form mismatch rejection
 *   Case 5: Valid end-to-end submit (CONFIRMED, recruitment_outcome=APPLIED, applications.md updated)
 *   Case 6: Consumed token reuse rejection
 *   Case 7: Crash before consumption retry
 *   Case 8: Crash after consumption UNCERTAIN_OUTCOME
 *   Case 9: Canonical DB safety (byte-identical SHA-256)
 */

import assert from 'assert';
import { createHash } from 'crypto';
import { existsSync, readFileSync, writeFileSync, appendFileSync, unlinkSync, copyFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DB_PATH = resolve(process.cwd(), 'data', 'test_submission_cli.db');
const CANONICAL_DB_PATH = resolve(process.cwd(), 'data', 'job_agent.db');

// Baseline hash of canonical database before any test setup
if (!existsSync(CANONICAL_DB_PATH)) {
    throw new Error(`Canonical database missing at ${CANONICAL_DB_PATH}`);
}
const baselineCanonicalHash = createHash('sha256').update(readFileSync(CANONICAL_DB_PATH)).digest('hex');

function cleanupTestDb() {
    for (const f of [TEST_DB_PATH, `${TEST_DB_PATH}-wal`, `${TEST_DB_PATH}-shm`]) {
        if (existsSync(f)) {
            try { unlinkSync(f); } catch { /* ignore */ }
        }
    }
}

cleanupTestDb();
copyFileSync(CANONICAL_DB_PATH, TEST_DB_PATH);

// Configure test environment BEFORE importing repo/db modules
process.env.CAREER_OPS_TEST = '1';
process.env.JOB_AGENT_DB_PATH = TEST_DB_PATH;

const { getDb, closeDb, getDbPath } = await import('./db/db.mjs');
const resolvedDbPath = resolve(getDbPath());
if (resolvedDbPath === CANONICAL_DB_PATH) {
    throw new Error(`SAFETY ABORT: test-submission-cli-flow.mjs resolved to canonical DB (${resolvedDbPath})`);
}
console.log(`🔒 Isolated Test DB Path: ${resolvedDbPath}`);

// Run migrations on isolated test database
const { runMigrations } = await import('./db/migrate.js');
runMigrations(getDb(), { quiet: true });

// Seed deterministic synthetic candidate facts into isolated test DB
const initDb = getDb();
initDb.prepare("INSERT OR REPLACE INTO candidate_facts (id, category, identifier, value, evidence_type, verified, created_at) VALUES ('fact-synth-name', 'identity', 'full_name', 'Jordan Lee', 'test', 1, datetime('now'))").run();
initDb.prepare("INSERT OR REPLACE INTO candidate_facts (id, category, identifier, value, evidence_type, verified, created_at) VALUES ('fact-synth-first', 'identity', 'first_name', 'Jordan', 'test', 1, datetime('now'))").run();
initDb.prepare("INSERT OR REPLACE INTO candidate_facts (id, category, identifier, value, evidence_type, verified, created_at) VALUES ('fact-synth-last', 'identity', 'last_name', 'Lee', 'test', 1, datetime('now'))").run();
initDb.prepare("INSERT OR REPLACE INTO candidate_facts (id, category, identifier, value, evidence_type, verified, created_at) VALUES ('fact-synth-email', 'contact', 'email', 'jordan.synthetic@example.test', 'test', 1, datetime('now'))").run();
initDb.prepare("INSERT OR REPLACE INTO candidate_facts (id, category, identifier, value, evidence_type, verified, created_at) VALUES ('fact-synth-phone', 'contact', 'phone', '+00-0000000000', 'test', 1, datetime('now'))").run();

process.on('exit', () => {
    cleanupTestDb();
});

const {
    getJob,
    getApplication,
    getAllApplications,
    getApplicationEvents,
    getCandidateFacts,
    getCandidateAnswers,
    updateApplicationState,
    updateApplicationExecution,
    createSubmissionAuthorization,
    getSubmissionAuthorization,
    useSubmissionAuthorization,
    insertJobEvaluationRun,
    insertResumeVersion,
    APPLICATION_STATES,
    RECRUITMENT_OUTCOMES
} = await import('./db/repo.mjs');

const { recordUserAnswer } = await import('./application/autofill/answer-mapper.mjs');
const { runApplicationWorkflow, resumeApplicationWorkflow } = await import('./application/apply.mjs');
const { canProceedToSubmit, computeApplicationPayloadDigest } = await import('./application/submission/policy.mjs');
const { PORTAL_TYPES } = await import('./application/detection/detect-portal.mjs');
const { getAdapterForPortal } = await import('./application/adapters/index.mjs');
const { submitApplication } = await import('./application/submission/submit.mjs');

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
console.log('🧪 DELIVERABLE 1 — SUBMISSION CLI FLOW REGRESSION SUITE');
console.log('====================================================');

// Helper to insert test company & job
function setupTestJob(prefix = 'sub_cli') {
    const db = getDb();
    const compId = `comp_${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const jobId = `job_${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

    db.prepare(`
        INSERT INTO companies (id, name, domain, lifecycle_status, monitoring_status)
        VALUES (?, ?, ?, 'APPROVED', 'active')
    `).run(compId, `Acme ${prefix}`, `${prefix}.acme.com`);

    db.prepare(`
        INSERT INTO job_postings (id, company_id, title, location, job_url, status, source)
        VALUES (?, ?, 'Senior Backend Engineer', 'Bengaluru, India', ?, 'active', 'greenhouse')
    `).run(jobId, compId, `https://job-boards.greenhouse.io/acme/jobs/${jobId}`);

    insertJobEvaluationRun({
        job_id: jobId,
        eval_version: '3B.1.0',
        input_hash: `hash_${prefix}`,
        tier1_passed: 1,
        tier1_matched_titles: ['Senior Backend Engineer'],
        tier2_eligibility: 'PASS',
        tier2_gates_json: [],
        tier3_match_score: 0.95,
        recommendation: 'APPLY',
        notes: 'Test eligible'
    });

    return { compId, jobId };
}

function getMockGreenhouseHtml(suffix = '') {
    const s = suffix ? `_${suffix}` : '';
    return `
<!DOCTYPE html>
<html>
<head><title>Job Application</title></head>
<body>
  <form id="application_form" action="/submit" method="POST">
    <div class="field">
      <label for="first_name">First Name</label>
      <input type="text" id="first_name" name="first_name" required />
    </div>
    <div class="field">
      <label for="last_name">Last Name</label>
      <input type="text" id="last_name" name="last_name" required />
    </div>
    <div class="field">
      <label for="email">Email</label>
      <input type="email" id="email" name="email" required />
    </div>
    <div class="field">
      <label for="phone">Phone</label>
      <input type="tel" id="phone" name="phone" required />
    </div>
    <div class="field">
      <label for="resume">Resume / CV</label>
      <input type="file" id="resume" name="resume" required />
    </div>
    <div class="field">
      <label for="years_experience${s}">Years of Experience ${s}</label>
      <input type="number" id="years_experience${s}" name="years_experience${s}" required />
    </div>
    <div class="field">
      <label for="work_arrangement${s}">Work Arrangement ${s}</label>
      <select id="work_arrangement${s}" name="work_arrangement${s}" required>
        <option value="">Select</option>
        <option value="remote">Remote</option>
        <option value="hybrid">Hybrid</option>
      </select>
    </div>
    <button type="submit" id="submit_app">Submit Application</button>
  </form>
</body>
</html>
`;
}

// ── Case 1: No auth rejection ──────────────────────────────────────────────
await asyncTest('Case 1: No auth rejection (Application in READY_FOR_REVIEW without authorization cannot be submitted)', async () => {
    const { compId, jobId } = setupTestJob('case1');
    const s = `c1_${Date.now()}`;
    const initRes = await runApplicationWorkflow(jobId, {
        htmlContent: getMockGreenhouseHtml(s),
        headless: true,
        logger: () => {}
    });

    recordUserAnswer({ applicationId: initRes.applicationId, questionKey: `years_experience_${s}`, answerValue: '10' });
    recordUserAnswer({ applicationId: initRes.applicationId, questionKey: `work_arrangement_${s}`, answerValue: 'remote' });

    const resumeRes = await resumeApplicationWorkflow(initRes.applicationId, {
        htmlContent: getMockGreenhouseHtml(s),
        headless: true,
        logger: () => {}
    });
    assert.strictEqual(resumeRes.status, APPLICATION_STATES.READY_FOR_REVIEW);

    let errorThrown = false;
    try {
        await resumeApplicationWorkflow(initRes.applicationId, {
            submit: true,
            htmlContent: getMockGreenhouseHtml(s),
            headless: true,
            logger: () => {}
        });
    } catch (err) {
        errorThrown = true;
        assert(err.message.includes('Submission rejected by policy') || err.message.includes('No explicit, active submission authorization found'));
    }
    assert(errorThrown, 'Expected submission to fail without authorization');

    const appAfter = getApplication(initRes.applicationId);
    assert.strictEqual(appAfter.state, APPLICATION_STATES.READY_FOR_REVIEW);
});

// ── Case 2: Packet tampering rejection ─────────────────────────────────────
await asyncTest('Case 2: Packet tampering rejection (Packet modified on disk after auth -> submission rejected)', async () => {
    const { compId, jobId } = setupTestJob('case2');
    const s = `c2_${Date.now()}`;
    const initRes = await runApplicationWorkflow(jobId, {
        htmlContent: getMockGreenhouseHtml(s),
        headless: true,
        logger: () => {}
    });

    recordUserAnswer({ applicationId: initRes.applicationId, questionKey: `years_experience_${s}`, answerValue: '8' });
    recordUserAnswer({ applicationId: initRes.applicationId, questionKey: `work_arrangement_${s}`, answerValue: 'remote' });

    const resumeRes = await resumeApplicationWorkflow(initRes.applicationId, {
        htmlContent: getMockGreenhouseHtml(s),
        headless: true,
        logger: () => {}
    });

    const app = getApplication(initRes.applicationId);
    const packetContent = readFileSync(resumeRes.reviewPacketPath, 'utf8');
    const packetHash = createHash('sha256').update(packetContent).digest('hex');
    const payloadDigest = computeApplicationPayloadDigest(app);

    createSubmissionAuthorization({
        scope: 'single',
        application_id: initRes.applicationId,
        authorized_by: 'user',
        packet_hash: packetHash,
        resume_version_id: app.resume_version_id,
        payload_digest: payloadDigest
    });

    // Tamper with packet markdown on disk
    appendFileSync(resumeRes.reviewPacketPath, '\n<!-- Tampered modification -->');

    let errorThrown = false;
    try {
        await resumeApplicationWorkflow(initRes.applicationId, {
            submit: true,
            htmlContent: getMockGreenhouseHtml(s),
            headless: true,
            logger: () => {}
        });
    } catch (err) {
        errorThrown = true;
        assert(err.message.includes('Review packet has been modified'));
    }
    assert(errorThrown, 'Expected submission to reject tampered packet');
});

// ── Case 3: Resume mismatch rejection ──────────────────────────────────────
await asyncTest('Case 3: Resume mismatch rejection (Resume version swapped after auth -> submission rejected)', async () => {
    const { compId, jobId } = setupTestJob('case3');
    const s = `c3_${Date.now()}`;
    const initRes = await runApplicationWorkflow(jobId, {
        htmlContent: getMockGreenhouseHtml(s),
        headless: true,
        logger: () => {}
    });

    recordUserAnswer({ applicationId: initRes.applicationId, questionKey: `years_experience_${s}`, answerValue: '12' });
    recordUserAnswer({ applicationId: initRes.applicationId, questionKey: `work_arrangement_${s}`, answerValue: 'remote' });

    const resumeRes = await resumeApplicationWorkflow(initRes.applicationId, {
        htmlContent: getMockGreenhouseHtml(s),
        headless: true,
        logger: () => {}
    });

    const app = getApplication(initRes.applicationId);
    const packetContent = readFileSync(resumeRes.reviewPacketPath, 'utf8');
    const packetHash = createHash('sha256').update(packetContent).digest('hex');
    const payloadDigest = computeApplicationPayloadDigest(app);

    createSubmissionAuthorization({
        scope: 'single',
        application_id: initRes.applicationId,
        authorized_by: 'user',
        packet_hash: packetHash,
        resume_version_id: app.resume_version_id,
        payload_digest: payloadDigest
    });

    // Insert another valid resume version and swap it in the application record
    const swappedResumeId = `resume_swapped_${Date.now()}`;
    insertResumeVersion({
        id: swappedResumeId,
        job_id: jobId,
        template_name: 'modern-ats',
        format: 'pdf',
        file_path: resolve(__dirname, 'output/test_resume_swapped.pdf'),
        content_hash: 'dummyhash',
        metadata: { tailored_for: 'Swapped' }
    });
    getDb().prepare('UPDATE applications SET resume_version_id = ? WHERE id = ?').run(swappedResumeId, initRes.applicationId);

    let errorThrown = false;
    try {
        await resumeApplicationWorkflow(initRes.applicationId, {
            submit: true,
            htmlContent: getMockGreenhouseHtml(s),
            headless: true,
            logger: () => {}
        });
    } catch (err) {
        errorThrown = true;
        assert(err.message.includes('Resume version'));
    }
    assert(errorThrown, 'Expected submission to reject swapped resume version');
});

// ── Case 4: Live form mismatch rejection ───────────────────────────────────
await asyncTest('Case 4: Live form mismatch rejection (Live form fields do not match payload_digest -> submission rejected)', async () => {
    const { compId, jobId } = setupTestJob('case4');
    const s = `c4_${Date.now()}`;
    const initRes = await runApplicationWorkflow(jobId, {
        htmlContent: getMockGreenhouseHtml(s),
        headless: true,
        logger: () => {}
    });

    recordUserAnswer({ applicationId: initRes.applicationId, questionKey: `years_experience_${s}`, answerValue: '5' });
    recordUserAnswer({ applicationId: initRes.applicationId, questionKey: `work_arrangement_${s}`, answerValue: 'remote' });

    const resumeRes = await resumeApplicationWorkflow(initRes.applicationId, {
        htmlContent: getMockGreenhouseHtml(s),
        headless: true,
        logger: () => {}
    });

    const app = getApplication(initRes.applicationId);
    const packetContent = readFileSync(resumeRes.reviewPacketPath, 'utf8');
    const packetHash = createHash('sha256').update(packetContent).digest('hex');
    const payloadDigest = computeApplicationPayloadDigest(app);

    createSubmissionAuthorization({
        scope: 'single',
        application_id: initRes.applicationId,
        authorized_by: 'user',
        packet_hash: packetHash,
        resume_version_id: app.resume_version_id,
        payload_digest: payloadDigest
    });

    // Update candidate answer so live DOM fill produces a different value than authorized payload_digest
    recordUserAnswer({
        applicationId: initRes.applicationId,
        questionKey: `years_experience_${s}`,
        answerValue: '15'
    });

    let errorThrown = false;
    try {
        await resumeApplicationWorkflow(initRes.applicationId, {
            submit: true,
            htmlContent: getMockGreenhouseHtml(s),
            headless: true,
            logger: () => {}
        });
    } catch (err) {
        errorThrown = true;
        assert(err.message.includes('Live DOM form fields do not match authorized payload digest'));
    }
    assert(errorThrown, 'Expected submission to reject live form payload digest mismatch');

    // Verification failure must transition application back to NEEDS_USER_INPUT
    const appAfter = getApplication(initRes.applicationId);
    assert.strictEqual(appAfter.state, APPLICATION_STATES.NEEDS_USER_INPUT);
});

// ── Case 5: Valid end-to-end submit ────────────────────────────────────────
await asyncTest('Case 5: Valid end-to-end submit (CONFIRMED, recruitment_outcome = APPLIED, confirmation code captured, applications.md updated)', async () => {
    const { compId, jobId } = setupTestJob('case5');
    const s = `c5_${Date.now()}`;
    const initRes = await runApplicationWorkflow(jobId, {
        htmlContent: getMockGreenhouseHtml(s),
        headless: true,
        logger: () => {}
    });

    recordUserAnswer({ applicationId: initRes.applicationId, questionKey: `years_experience_${s}`, answerValue: '7' });
    recordUserAnswer({ applicationId: initRes.applicationId, questionKey: `work_arrangement_${s}`, answerValue: 'remote' });

    const resumeRes = await resumeApplicationWorkflow(initRes.applicationId, {
        htmlContent: getMockGreenhouseHtml(s),
        headless: true,
        logger: () => {}
    });

    const app = getApplication(initRes.applicationId);
    const packetContent = readFileSync(resumeRes.reviewPacketPath, 'utf8');
    const packetHash = createHash('sha256').update(packetContent).digest('hex');
    const payloadDigest = computeApplicationPayloadDigest(app);

    const authId = createSubmissionAuthorization({
        scope: 'single',
        application_id: initRes.applicationId,
        authorized_by: 'user',
        packet_hash: packetHash,
        resume_version_id: app.resume_version_id,
        payload_digest: payloadDigest
    });

    // Provide browser session with mocked submission confirmation
    const browser = await chromium.launch({ headless: true });
    try {
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.setContent(getMockGreenhouseHtml(s));

        await page.evaluate(() => {
            const form = document.querySelector('form');
            if (form) form.setAttribute('novalidate', 'true');
            form.addEventListener('submit', (e) => {
                e.preventDefault();
                document.body.innerHTML = `
                    <div class="application-confirmation">
                      <h1>Thank you for applying</h1>
                      <p>Confirmation Reference: CONF-E2E-REGRESSION-8899</p>
                    </div>
                `;
            });
        });

        const mockBrowserSession = {
            getPage: async () => page,
            navigate: async () => {},
            close: async () => { await browser.close(); }
        };

        const submitResult = await resumeApplicationWorkflow(initRes.applicationId, {
            submit: true,
            browserSession: mockBrowserSession,
            headless: true,
            logger: () => {}
        });

        assert.strictEqual(submitResult.status, APPLICATION_STATES.CONFIRMED);
        assert.strictEqual(submitResult.confirmationReference, 'CONF-E2E-REGRESSION-8899');

        // Verify DB state and recruitment outcome
        const finalApp = getApplication(initRes.applicationId);
        assert.strictEqual(finalApp.state, APPLICATION_STATES.CONFIRMED);
        assert.strictEqual(finalApp.recruitment_outcome, RECRUITMENT_OUTCOMES.APPLIED);
        assert.strictEqual(finalApp.confirmation_reference, 'CONF-E2E-REGRESSION-8899');
        assert(finalApp.submitted_at !== null);

        // Verify authorization token consumed
        const finalAuth = getSubmissionAuthorization(authId);
        assert.strictEqual(finalAuth.used_count, 1);

        // Verify applications.md updated
        const trackerPath = resolve(process.cwd(), 'data', 'applications.md');
        if (existsSync(trackerPath)) {
            const trackerContent = readFileSync(trackerPath, 'utf8');
            assert(trackerContent.includes('Acme case5') || trackerContent.includes('Senior Backend Engineer'), 'Exported applications.md must include submitted company or role');
        }
    } finally {
        await browser.close();
    }
});

// ── Case 6: Consumed token reuse rejection ─────────────────────────────────
await asyncTest('Case 6: Consumed token reuse rejection (Re-submitting with consumed token rejected)', async () => {
    const { compId, jobId } = setupTestJob('case6');
    const s = `c6_${Date.now()}`;
    const initRes = await runApplicationWorkflow(jobId, {
        htmlContent: getMockGreenhouseHtml(s),
        headless: true,
        logger: () => {}
    });

    recordUserAnswer({ applicationId: initRes.applicationId, questionKey: `years_experience_${s}`, answerValue: '6' });
    recordUserAnswer({ applicationId: initRes.applicationId, questionKey: `work_arrangement_${s}`, answerValue: 'hybrid' });

    const resumeRes = await resumeApplicationWorkflow(initRes.applicationId, {
        htmlContent: getMockGreenhouseHtml(s),
        headless: true,
        logger: () => {}
    });

    const app = getApplication(initRes.applicationId);
    const packetContent = readFileSync(resumeRes.reviewPacketPath, 'utf8');
    const packetHash = createHash('sha256').update(packetContent).digest('hex');
    const payloadDigest = computeApplicationPayloadDigest(app);

    const authId = createSubmissionAuthorization({
        scope: 'single',
        application_id: initRes.applicationId,
        authorized_by: 'user',
        packet_hash: packetHash,
        resume_version_id: app.resume_version_id,
        payload_digest: payloadDigest
    });

    // Mark token as already consumed
    useSubmissionAuthorization(authId);

    let errorThrown = false;
    try {
        await resumeApplicationWorkflow(initRes.applicationId, {
            submit: true,
            htmlContent: getMockGreenhouseHtml(s),
            explicitAuthorization: getSubmissionAuthorization(authId),
            headless: true,
            logger: () => {}
        });
    } catch (err) {
        errorThrown = true;
        assert(err.message.includes('has already been consumed') || err.message.includes('is not active'));
    }
    assert(errorThrown, 'Expected submission to reject consumed authorization token');
});

// ── Case 7: Crash before consumption retry ─────────────────────────────────
await asyncTest('Case 7: Crash before consumption retry (If error happens before token consumption, token remains valid for retry)', async () => {
    const { compId, jobId } = setupTestJob('case7');
    const s = `c7_${Date.now()}`;
    const initRes = await runApplicationWorkflow(jobId, {
        htmlContent: getMockGreenhouseHtml(s),
        headless: true,
        logger: () => {}
    });

    recordUserAnswer({ applicationId: initRes.applicationId, questionKey: `years_experience_${s}`, answerValue: '9' });
    recordUserAnswer({ applicationId: initRes.applicationId, questionKey: `work_arrangement_${s}`, answerValue: 'remote' });

    const resumeRes = await resumeApplicationWorkflow(initRes.applicationId, {
        htmlContent: getMockGreenhouseHtml(s),
        headless: true,
        logger: () => {}
    });

    const app = getApplication(initRes.applicationId);
    const packetContent = readFileSync(resumeRes.reviewPacketPath, 'utf8');
    const packetHash = createHash('sha256').update(packetContent).digest('hex');
    const payloadDigest = computeApplicationPayloadDigest(app);

    const authId = createSubmissionAuthorization({
        scope: 'single',
        application_id: initRes.applicationId,
        authorized_by: 'user',
        packet_hash: packetHash,
        resume_version_id: app.resume_version_id,
        payload_digest: payloadDigest
    });

    // Provide HTML where submit button is disabled (pre-consumption failure)
    const disabledHtml = getMockGreenhouseHtml(s).replace('id="submit_app"', 'id="submit_app" disabled');

    let errorThrown = false;
    try {
        await resumeApplicationWorkflow(initRes.applicationId, {
            submit: true,
            htmlContent: disabledHtml,
            headless: true,
            logger: () => {}
        });
    } catch (err) {
        errorThrown = true;
        assert(err.message.includes('Submit button is disabled'));
    }
    assert(errorThrown, 'Expected submission to fail on disabled submit button');

    // Token must NOT be consumed
    const authRecord = getSubmissionAuthorization(authId);
    assert.strictEqual(authRecord.used_count, 0, 'Token must not be consumed on pre-submit failure');

    // Application state must still be READY_FOR_REVIEW
    const appRecord = getApplication(initRes.applicationId);
    assert.strictEqual(appRecord.state, APPLICATION_STATES.READY_FOR_REVIEW);

    // Retry with enabled button: succeeds and consumes token
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage();
        await page.setContent(getMockGreenhouseHtml(s));
        await page.evaluate(() => {
            const form = document.querySelector('form');
            if (form) form.setAttribute('novalidate', 'true');
            form.addEventListener('submit', (e) => {
                e.preventDefault();
                document.body.innerHTML = `
                    <div class="application-confirmation">
                      <h1>Thank you for applying</h1>
                      <p>Confirmation Reference: CONF-RETRY-SUCCESS-1234</p>
                    </div>
                `;
            });
        });

        const mockBrowserSession = {
            getPage: async () => page,
            navigate: async () => {},
            close: async () => { await browser.close(); }
        };

        const retryResult = await resumeApplicationWorkflow(initRes.applicationId, {
            submit: true,
            browserSession: mockBrowserSession,
            headless: true,
            logger: () => {}
        });

        assert.strictEqual(retryResult.status, APPLICATION_STATES.CONFIRMED);
        assert.strictEqual(getSubmissionAuthorization(authId).used_count, 1, 'Token must be consumed on successful retry');
    } finally {
        await browser.close();
    }
});

// ── Case 8: Crash after consumption UNCERTAIN_OUTCOME ──────────────────────
await asyncTest('Case 8: Crash after consumption UNCERTAIN_OUTCOME (Crash during submit transitions to UNCERTAIN_OUTCOME, token consumed)', async () => {
    const { compId, jobId } = setupTestJob('case8');
    const s = `c8_${Date.now()}`;
    const initRes = await runApplicationWorkflow(jobId, {
        htmlContent: getMockGreenhouseHtml(s),
        headless: true,
        logger: () => {}
    });

    recordUserAnswer({ applicationId: initRes.applicationId, questionKey: `years_experience_${s}`, answerValue: '11' });
    recordUserAnswer({ applicationId: initRes.applicationId, questionKey: `work_arrangement_${s}`, answerValue: 'remote' });

    const resumeRes = await resumeApplicationWorkflow(initRes.applicationId, {
        htmlContent: getMockGreenhouseHtml(s),
        headless: true,
        logger: () => {}
    });

    const app = getApplication(initRes.applicationId);
    const packetContent = readFileSync(resumeRes.reviewPacketPath, 'utf8');
    const packetHash = createHash('sha256').update(packetContent).digest('hex');
    const payloadDigest = computeApplicationPayloadDigest(app);

    const authId = createSubmissionAuthorization({
        scope: 'single',
        application_id: initRes.applicationId,
        authorized_by: 'user',
        packet_hash: packetHash,
        resume_version_id: app.resume_version_id,
        payload_digest: payloadDigest
    });

    // Mock page where submit button throws an in-flight crash
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage();
        await page.setContent(getMockGreenhouseHtml(s));
        await page.evaluate(() => {
            const form = document.querySelector('form');
            if (form) {
                form.addEventListener('submit', (e) => {
                    e.preventDefault();
                    // Simulate browser crash or network drop without rendering confirmation
                    document.body.innerHTML = '<h1>504 Gateway Timeout</h1>';
                });
            }
        });

        const mockBrowserSession = {
            getPage: async () => page,
            navigate: async () => {},
            close: async () => { await browser.close(); }
        };

        const submitResult = await resumeApplicationWorkflow(initRes.applicationId, {
            submit: true,
            browserSession: mockBrowserSession,
            headless: true,
            logger: () => {}
        });

        // Must transition to UNCERTAIN_OUTCOME
        assert.strictEqual(submitResult.status, APPLICATION_STATES.UNCERTAIN_OUTCOME);

        const appAfterCrash = getApplication(initRes.applicationId);
        assert.strictEqual(appAfterCrash.state, APPLICATION_STATES.UNCERTAIN_OUTCOME);

        // Token must be consumed
        const authAfterCrash = getSubmissionAuthorization(authId);
        assert.strictEqual(authAfterCrash.used_count, 1);

        // Attempting to resubmit directly without reconciliation must fail
        let resubmitError = false;
        try {
            await resumeApplicationWorkflow(initRes.applicationId, {
                submit: true,
                browserSession: mockBrowserSession,
                headless: true,
                logger: () => {}
            });
        } catch (err) {
            resubmitError = true;
        }
        assert(resubmitError, 'Direct resubmission from UNCERTAIN_OUTCOME must fail without reconciliation');
    } finally {
        await browser.close();
    }
});

// ── Case 9: Canonical DB safety ───────────────────────────────────────────
test('Case 9: Canonical DB safety (Verify data/job_agent.db is byte-identical and was never touched)', () => {
    assert.strictEqual(resolve(getDbPath()), TEST_DB_PATH, 'Runtime must use test DB path');
    assert.notStrictEqual(TEST_DB_PATH, CANONICAL_DB_PATH, 'Test DB path must differ from canonical DB');

    const currentCanonicalHash = createHash('sha256').update(readFileSync(CANONICAL_DB_PATH)).digest('hex');
    assert.strictEqual(currentCanonicalHash, baselineCanonicalHash, 'Canonical DB hash must remain strictly byte-identical');
});

console.log('====================================================');
console.log(`📊 Deliverable 1 Suite Results: ${passedCount} PASSED, ${failedCount} FAILED`);
console.log('====================================================');

closeDb();
cleanupTestDb();
delete process.env.JOB_AGENT_DB_PATH;

if (failedCount > 0) {
    process.exit(1);
}
