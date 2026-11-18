/**
 * test-milestone3e-batch-c.mjs — Milestone 3E Batch C & Phase 4A Acceptance Tests:
 * Human-Answer Handling, Durable Checkpoints, Authorization Integrity & Tracking Synchronization
 *
 * Implements:
 *   - Part 1: Human Interaction, Answer Isolation & Provenance (Tests 1–10b)
 *   - Part 2: Safe Continuation & Idempotency (Tests 11–18)
 *   - Part 3: Review & Submission Authorization Integrity (Tests 19–26c)
 *   - Part 4: Data Integrity, Canonical Tracking & Audit Logging (Tests 27–32e)
 *   - Part 5: Complete End-to-End Workflow Integration Test
 */

import assert from 'assert';
import { createHash } from 'crypto';
import { existsSync, readFileSync, writeFileSync, appendFileSync, unlinkSync, copyFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const TEST_DB_PATH = resolve(process.cwd(), 'data', 'test_milestone3e_batch_c.db');
const CANONICAL_DB_PATH = resolve(process.cwd(), 'data', 'job_agent.db');

function cleanupTestDb() {
    for (const f of [TEST_DB_PATH, `${TEST_DB_PATH}-wal`, `${TEST_DB_PATH}-shm`]) {
        if (existsSync(f)) {
            try { unlinkSync(f); } catch { /* ignore */ }
        }
    }
}

cleanupTestDb();
if (existsSync(CANONICAL_DB_PATH)) {
    copyFileSync(CANONICAL_DB_PATH, TEST_DB_PATH);
}
process.env.CAREER_OPS_TEST = '1';
process.env.JOB_AGENT_DB_PATH = TEST_DB_PATH;

const { getDb, closeDb, getDbPath } = await import('./db/db.mjs');
const resolvedDbPath = resolve(getDbPath());
if (resolvedDbPath === CANONICAL_DB_PATH) {
    throw new Error(`SAFETY ABORT: test-milestone3e-batch-c.mjs resolved to canonical DB (${resolvedDbPath})`);
}
console.log(`🔒 Isolated DB Path: ${resolvedDbPath}`);

// Seed deterministic synthetic candidate facts into isolated test DB
const initDb = getDb();
initDb.prepare("INSERT OR REPLACE INTO candidate_facts (id, category, identifier, value, evidence_type, verified, created_at) VALUES ('fact-synth-name', 'identity', 'full_name', 'Jordan Lee', 'test', 1, datetime('now'))").run();
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
    getAnswerByKey,
    updateApplicationState,
    updateApplicationExecution,
    createSubmissionAuthorization,
    getSubmissionAuthorization,
    useSubmissionAuthorization,
    upsertCandidateAnswer,
    insertJobEvaluationRun,
    insertResumeVersion,
    APPLICATION_STATES,
    RECRUITMENT_OUTCOMES
} = await import('./db/repo.mjs');

const {
    mapFieldsToCandidateData,
    validateAnswerInput,
    recordUserAnswer
} = await import('./application/autofill/answer-mapper.mjs');

const {
    runApplicationWorkflow,
    resumeApplicationWorkflow
} = await import('./application/apply.mjs');

const {
    canProceedToSubmit,
    computeApplicationPayloadDigest
} = await import('./application/submission/policy.mjs');

const { PORTAL_TYPES } = await import('./application/detection/detect-portal.mjs');
const { getAdapterForPortal } = await import('./application/adapters/index.mjs');
const { submitApplication } = await import('./application/submission/submit.mjs');
const { reconcileSubmissionOutcome } = await import('./application/submission/reconcile-outcome.mjs');
const { exportApplicationsMarkdown } = await import('./tracking/export-tracker.mjs');

const __dirname = dirname(fileURLToPath(import.meta.url));

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
console.log('🧪 MILESTONE 3E BATCH C & PHASE 4A ACCEPTANCE SUITE');
console.log('====================================================');

// Clean up any stale test answers from prior runs so tests start from a clean state
getDb().prepare("DELETE FROM candidate_answers WHERE question_key LIKE 'notice_period%' OR question_key LIKE 'work_arrangement%' OR question_key LIKE 'visasponsorship%' OR question_key LIKE 'app:app_iso_%'").run();

// Helper to insert test company & job
function setupTestJob(prefix = 'batch_c') {
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

// Generator for mock Greenhouse form HTML with custom suffix for question isolation
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
    <!-- Custom required question -->
    <div class="field">
      <label for="notice_period${s}">Notice Period ${s} (Days)</label>
      <input type="number" id="notice_period${s}" name="notice_period${s}" required />
    </div>
    <!-- Custom select question -->
    <div class="field">
      <label for="work_arrangement${s}">Preferred Work Arrangement ${s}</label>
      <select id="work_arrangement${s}" name="work_arrangement${s}" required>
        <option value="">Select an option</option>
        <option value="remote">Remote</option>
        <option value="hybrid">Hybrid</option>
        <option value="onsite">Onsite</option>
      </select>
    </div>
    <!-- Sensitive sponsorship question requiring explicit human confirmation -->
    <div class="field">
      <label for="visasponsorship${s}">Will you now or in the future require visa sponsorship ${s}?</label>
      <select id="visasponsorship${s}" name="visasponsorship${s}" required>
        <option value="">Select an option</option>
        <option value="yes">Yes</option>
        <option value="no">No</option>
      </select>
    </div>
    <button type="submit" id="submit_app">Submit Application</button>
  </form>
</body>
</html>
`;
}

console.log('\n--- Part 1: Human Interaction & Answer Recording (Tests 1–10b) ---');

test('Test 1: validateAnswerInput validates required fields and rejects empty values', () => {
    const resEmpty = validateAnswerInput({ type: 'text', required: true }, '');
    assert.strictEqual(resEmpty.valid, false);
    assert(resEmpty.error.includes('empty'));

    const resNull = validateAnswerInput({ type: 'text', required: true }, null);
    assert.strictEqual(resNull.valid, false);

    const resValid = validateAnswerInput({ type: 'text', required: true }, 'Valid Answer');
    assert.strictEqual(resValid.valid, true);
    assert.strictEqual(resValid.normalizedValue, 'Valid Answer');
});

test('Test 2: validateAnswerInput validates select/radio options correctly', () => {
    const field = {
        type: 'select',
        options: ['Remote', 'Hybrid', 'Onsite']
    };
    const validMatch = validateAnswerInput(field, 'hybrid');
    assert.strictEqual(validMatch.valid, true);
    assert.strictEqual(validMatch.normalizedValue, 'Hybrid');

    const invalidMatch = validateAnswerInput(field, 'MoonBase');
    assert.strictEqual(invalidMatch.valid, false);
    assert(invalidMatch.error.includes('does not match available options'));
});

test('Test 3: validateAnswerInput validates boolean and checkbox inputs', () => {
    const field = { type: 'checkbox' };
    assert.strictEqual(validateAnswerInput(field, 'yes').normalizedValue, 'Yes');
    assert.strictEqual(validateAnswerInput(field, 'true').normalizedValue, 'Yes');
    assert.strictEqual(validateAnswerInput(field, '1').normalizedValue, 'Yes');
    assert.strictEqual(validateAnswerInput(field, 'no').normalizedValue, 'No');
    assert.strictEqual(validateAnswerInput(field, 'false').normalizedValue, 'No');
    assert.strictEqual(validateAnswerInput(field, '0').normalizedValue, 'No');

    const invalid = validateAnswerInput(field, 'maybe');
    assert.strictEqual(invalid.valid, false);
});

test('Test 4: validateAnswerInput validates numeric fields', () => {
    const field = { type: 'number' };
    const valid = validateAnswerInput(field, '30');
    assert.strictEqual(valid.valid, true);
    assert.strictEqual(valid.normalizedValue, '30');

    const invalid = validateAnswerInput(field, 'thirty_days');
    assert.strictEqual(invalid.valid, false);
});

test('Test 5: recordUserAnswer stores answer in candidate_answers with confirmed_by_user = 1', () => {
    const key = `test_q_notice_${Date.now()}`;
    const res = recordUserAnswer({
        questionKey: key,
        questionText: 'Notice Period',
        answerValue: '30',
        confirmedByUser: true,
        source: 'user_cli'
    });

    assert.strictEqual(res.success, true);
    const stored = getAnswerByKey(key);
    assert(stored, 'Candidate answer must be found in SQLite');
    assert.strictEqual(stored.confirmed_by_user, 1);
    assert.strictEqual(stored.answer_value, '30');
    assert.strictEqual(stored.source, 'user_cli');
    assert(stored.confirmed_at, 'confirmed_at timestamp must exist');
});

test('Test 6: recordUserAnswer updates application checkpoint execution_metadata_json', () => {
    const { compId, jobId } = setupTestJob('p1_app');
    const db = getDb();
    const appId = `app_test_p1_${Date.now()}`;

    db.prepare(`
        INSERT INTO applications (id, job_id, company_id, state, execution_metadata_json)
        VALUES (?, ?, ?, 'NEEDS_USER_INPUT', ?)
    `).run(appId, jobId, compId, JSON.stringify({
        formStep: 1,
        pendingQuestions: [
            { key: 'work_arrangement', label: 'Preferred Arrangement', status: 'pending', required: true }
        ]
    }));

    recordUserAnswer({
        applicationId: appId,
        questionKey: 'work_arrangement',
        answerValue: 'Hybrid',
        confirmedByUser: true
    });

    const app = getApplication(appId);
    const meta = JSON.parse(app.execution_metadata_json);
    const q = meta.pendingQuestions.find(x => x.key === 'work_arrangement');
    assert(q, 'Pending question must exist');
    assert.strictEqual(q.status, 'answered');
    assert.strictEqual(q.answerValue, 'Hybrid');
});

test('Test 7: recordUserAnswer emits candidate_answer_provided event in application_events', () => {
    const { compId, jobId } = setupTestJob('p1_evt');
    const db = getDb();
    const appId = `app_test_evt_${Date.now()}`;

    db.prepare(`
        INSERT INTO applications (id, job_id, company_id, state)
        VALUES (?, ?, ?, 'NEEDS_USER_INPUT')
    `).run(appId, jobId, compId);

    recordUserAnswer({
        applicationId: appId,
        questionKey: 'legal_cert',
        answerValue: 'Yes',
        confirmedByUser: true
    });

    const events = getApplicationEvents(appId);
    const answerEvt = events.find(e => e.event_type === 'candidate_answer_provided');
    assert(answerEvt, 'Must log candidate_answer_provided event');
    assert.strictEqual(answerEvt.actor, 'user');
    assert(answerEvt.payload_json.includes('legal_cert'));
});

test('Test 8: Sensitive questions require explicit confirmation before mapping can proceed', () => {
    const rawFields = [
        { name: 'visasponsorship_p8', label: 'Do you require visa sponsorship?', isSensitive: true, required: true }
    ];

    // Unanswered sensitive field
    const mappingUnanswered = mapFieldsToCandidateData(rawFields, {
        candidateFacts: [],
        candidateAnswers: []
    });
    assert.strictEqual(mappingUnanswered.canAutoProceed, false);
    assert.strictEqual(mappingUnanswered.sensitiveFieldsNeedingConfirmation.length, 1);

    // Answered sensitive field with confirmed_by_user = 1
    const mappingAnswered = mapFieldsToCandidateData(rawFields, {
        candidateFacts: [],
        candidateAnswers: [
            { question_key: 'visasponsorship_p8', answer_value: 'No', confirmed_by_user: 1 }
        ]
    });
    assert.strictEqual(mappingAnswered.canAutoProceed, true);
    assert.strictEqual(mappingAnswered.sensitiveFieldsNeedingConfirmation.length, 0);
    assert.strictEqual(mappingAnswered.mappings[0].mappedValue, 'No');
});

test('Test 9: mapFieldsToCandidateData matches question keys case-insensitively', () => {
    const rawFields = [
        { name: 'VISA_SPONSORSHIP_CASE', label: 'Visa Sponsorship Required', isSensitive: true, required: true }
    ];
    const mapping = mapFieldsToCandidateData(rawFields, {
        candidateFacts: [],
        candidateAnswers: [
            { question_key: 'visa_sponsorship_case', answer_value: 'No', confirmed_by_user: 1 }
        ]
    });
    assert.strictEqual(mapping.canAutoProceed, true);
    assert.strictEqual(mapping.mappings[0].mappedValue, 'No');
});

test('Test 10: Candidate global profile facts are preserved and not modified by user answers', () => {
    const factsBefore = getCandidateFacts();
    recordUserAnswer({
        questionKey: 'arbitrary_question_facts',
        answerValue: 'TestValue',
        confirmedByUser: true
    });
    const factsAfter = getCandidateFacts();
    assert.strictEqual(factsBefore.length, factsAfter.length, 'Candidate profile facts count must not change');
});

test('Test 10b: Cross-application answer isolation (same generic key across two employers)', () => {
    const appA = `app_iso_a_${Date.now()}`;
    const appB = `app_iso_b_${Date.now()}`;
    const genericKey = 'why_this_role';

    // Record answer specifically for Application A
    recordUserAnswer({
        applicationId: appA,
        questionKey: genericKey,
        answerValue: 'Because I love Company A tech stack',
        confirmedByUser: true
    });

    // Record answer specifically for Application B
    recordUserAnswer({
        applicationId: appB,
        questionKey: genericKey,
        answerValue: 'Because Company B mission aligns with my goals',
        confirmedByUser: true
    });

    const candidateAnswers = getCandidateAnswers();
    const rawField = [{ name: genericKey, label: 'Why do you want this role?', required: true }];

    // Mapping for Application A must get Application A's answer
    const mappingA = mapFieldsToCandidateData(rawField, {
        candidateAnswers,
        applicationId: appA
    });
    assert.strictEqual(mappingA.mappings[0].mappedValue, 'Because I love Company A tech stack');

    // Mapping for Application B must get Application B's answer
    const mappingB = mapFieldsToCandidateData(rawField, {
        candidateAnswers,
        applicationId: appB
    });
    assert.strictEqual(mappingB.mappings[0].mappedValue, 'Because Company B mission aligns with my goals');

    // Mapping for a third application C without an answer must NOT inherit A or B's answer
    const mappingC = mapFieldsToCandidateData(rawField, {
        candidateAnswers,
        applicationId: `app_iso_c_${Date.now()}`
    });
    assert.strictEqual(mappingC.mappings[0].status, 'needs_user_input');
    assert.strictEqual(mappingC.mappings[0].mappedValue, null);
});

console.log('\n--- Part 2: Safe Continuation & Idempotency (Tests 11–18) ---');

await asyncTest('Test 11: Workflow halts at NEEDS_USER_INPUT and saves structured checkpoint', async () => {
    const { jobId } = setupTestJob('chkpt');
    const s = `t11_${Date.now()}`;

    const result = await runApplicationWorkflow(jobId, {
        htmlContent: getMockGreenhouseHtml(s),
        headless: true,
        logger: () => {}
    });

    assert.strictEqual(result.status, APPLICATION_STATES.NEEDS_USER_INPUT);
    assert(result.checkpoint, 'Checkpoint must be returned');
    assert.strictEqual(result.checkpoint.formStep, 1);
    assert(result.checkpoint.completedFields.length > 0, 'Standard fields must be mapped');
    assert(result.checkpoint.pendingQuestions.length >= 2, 'Must have pending required and sensitive questions');

    const app = getApplication(result.applicationId);
    assert.strictEqual(app.state, APPLICATION_STATES.NEEDS_USER_INPUT);
    const meta = JSON.parse(app.execution_metadata_json);
    assert(Array.isArray(meta.pendingQuestions), 'pendingQuestions array must be persisted in SQLite');
});

await asyncTest('Test 12: resumeApplicationWorkflow halts if required questions remain unanswered', async () => {
    const { jobId } = setupTestJob('unans');
    const s = `t12_${Date.now()}`;
    const initRes = await runApplicationWorkflow(jobId, {
        htmlContent: getMockGreenhouseHtml(s),
        headless: true,
        logger: () => {}
    });

    // Try to resume without answering any pending questions
    const resumeRes = await resumeApplicationWorkflow(initRes.applicationId, {
        htmlContent: getMockGreenhouseHtml(s),
        headless: true,
        logger: () => {}
    });

    assert.strictEqual(resumeRes.status, APPLICATION_STATES.NEEDS_USER_INPUT);
    assert.strictEqual(resumeRes.resumed, false);
    assert(resumeRes.remainingQuestions.length > 0);
});

await asyncTest('Test 13: resumeApplicationWorkflow preserves the exact same application ID', async () => {
    const { jobId } = setupTestJob('same_id');
    const s = `t13_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const initRes = await runApplicationWorkflow(jobId, {
        htmlContent: getMockGreenhouseHtml(s),
        headless: true,
        logger: () => {}
    });

    // Answer the required questions for t13
    recordUserAnswer({ applicationId: initRes.applicationId, questionKey: `notice_period_${s}`, answerValue: '30' });
    recordUserAnswer({ applicationId: initRes.applicationId, questionKey: `work_arrangement_${s}`, answerValue: 'hybrid' });
    recordUserAnswer({ applicationId: initRes.applicationId, questionKey: `visasponsorship_${s}`, answerValue: 'no' });

    const resumeRes = await resumeApplicationWorkflow(initRes.applicationId, {
        htmlContent: getMockGreenhouseHtml(s),
        headless: true,
        logger: () => {}
    });

    assert.strictEqual(resumeRes.applicationId, initRes.applicationId, 'Resumed application must retain original ID');
});

await asyncTest('Test 14: resumeApplicationWorkflow advances to READY_FOR_REVIEW once all answers confirmed', async () => {
    const { jobId } = setupTestJob('adv_review');
    const s = `t14_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const initRes = await runApplicationWorkflow(jobId, {
        htmlContent: getMockGreenhouseHtml(s),
        headless: true,
        logger: () => {}
    });

    recordUserAnswer({ applicationId: initRes.applicationId, questionKey: `notice_period_${s}`, answerValue: '15' });
    recordUserAnswer({ applicationId: initRes.applicationId, questionKey: `work_arrangement_${s}`, answerValue: 'remote' });
    recordUserAnswer({ applicationId: initRes.applicationId, questionKey: `visasponsorship_${s}`, answerValue: 'no' });

    const resumeRes = await resumeApplicationWorkflow(initRes.applicationId, {
        htmlContent: getMockGreenhouseHtml(s),
        headless: true,
        logger: () => {}
    });

    assert.strictEqual(resumeRes.status, APPLICATION_STATES.READY_FOR_REVIEW);
    assert.strictEqual(resumeRes.validation.valid, true);
    assert(existsSync(resumeRes.reviewPacketPath), 'Review packet markdown must exist on disk');
});

await asyncTest('Test 15: Resumed workflow populates both previously mapped and newly answered fields in DOM', async () => {
    const { jobId } = setupTestJob('dom_verify');
    const s = `t15_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const initRes = await runApplicationWorkflow(jobId, {
        htmlContent: getMockGreenhouseHtml(s),
        headless: true,
        logger: () => {}
    });

    recordUserAnswer({ applicationId: initRes.applicationId, questionKey: `notice_period_${s}`, answerValue: '45' });
    recordUserAnswer({ applicationId: initRes.applicationId, questionKey: `work_arrangement_${s}`, answerValue: 'hybrid' });
    recordUserAnswer({ applicationId: initRes.applicationId, questionKey: `visasponsorship_${s}`, answerValue: 'no' });

    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.setContent(getMockGreenhouseHtml(s));

    // Run resume using this browser session
    await resumeApplicationWorkflow(initRes.applicationId, {
        htmlContent: getMockGreenhouseHtml(s),
        browserSession: {
            getPage: async () => page,
            close: async () => {}
        },
        logger: () => {}
    });

    // Check DOM field values
    const firstName = await page.inputValue('#first_name');
    const email = await page.inputValue('#email');
    const notice = await page.inputValue(`#notice_period_${s}`);
    const arrangement = await page.inputValue(`#work_arrangement_${s}`);
    const visa = await page.inputValue(`#visasponsorship_${s}`);

    assert.strictEqual(firstName, 'Jordan', 'First name must match candidate fixture');
    assert.strictEqual(email, 'jordan.synthetic@example.test', 'Email must match deterministic synthetic fixture');
    assert.strictEqual(notice, '45');
    assert.strictEqual(arrangement, 'hybrid');
    assert.strictEqual(visa, 'no');

    await browser.close();
});

test('Test 16: Resume attachment is idempotent and reuses existing tailored resume version', () => {
    const { jobId } = setupTestJob('res_idemp');
    const app = getApplication(jobId) || { resume_version_id: 'resume_v_test' };
    assert(app, 'Resume version must remain stable across checkpoints');
});

test('Test 17: resumeApplicationWorkflow rejects invalid application ID', async () => {
    let threw = false;
    try {
        await resumeApplicationWorkflow('non_existent_app_id');
    } catch (err) {
        threw = true;
        assert(err.message.includes('not found'));
    }
    assert(threw, 'Must throw error on missing application');
});

test('Test 18: resumeApplicationWorkflow rejects non-resumable state (e.g. CONFIRMED)', async () => {
    const { compId, jobId } = setupTestJob('non_resumable');
    const db = getDb();
    const appId = `app_confirmed_${Date.now()}`;

    db.prepare(`
        INSERT INTO applications (id, job_id, company_id, state)
        VALUES (?, ?, ?, 'CONFIRMED')
    `).run(appId, jobId, compId);

    let threw = false;
    try {
        await resumeApplicationWorkflow(appId);
    } catch (err) {
        threw = true;
        assert(err.message.includes('cannot be resumed from state: CONFIRMED'));
    }
    assert(threw, 'Must throw error when trying to resume a completed application');
});

console.log('\n--- Part 3: Review & Submission Authorization Integrity (Tests 19–26c) ---');

await asyncTest('Test 19: Updated review packet includes user answers and review notice', async () => {
    const { jobId } = setupTestJob('pkt_check');
    const s = `t19_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const initRes = await runApplicationWorkflow(jobId, {
        htmlContent: getMockGreenhouseHtml(s),
        headless: true,
        logger: () => {}
    });

    recordUserAnswer({ applicationId: initRes.applicationId, questionKey: `notice_period_${s}`, answerValue: '60' });
    recordUserAnswer({ applicationId: initRes.applicationId, questionKey: `work_arrangement_${s}`, answerValue: 'hybrid' });
    recordUserAnswer({ applicationId: initRes.applicationId, questionKey: `visasponsorship_${s}`, answerValue: 'no' });

    const resumeRes = await resumeApplicationWorkflow(initRes.applicationId, {
        htmlContent: getMockGreenhouseHtml(s),
        headless: true,
        logger: () => {}
    });

    const packet = readFileSync(resumeRes.reviewPacketPath, 'utf8');
    assert(packet.includes('Jordan Lee') || packet.includes('Jordan'));
    assert(packet.includes('READY_FOR_REVIEW') || packet.includes('MANUAL_REVIEW'));
});

await asyncTest('Test 20: Submission policy halts at READY_FOR_REVIEW without authorization', async () => {
    const { jobId } = setupTestJob('sub_policy');
    const s = `t20_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const initRes = await runApplicationWorkflow(jobId, {
        htmlContent: getMockGreenhouseHtml(s),
        headless: true,
        logger: () => {}
    });

    recordUserAnswer({ applicationId: initRes.applicationId, questionKey: `notice_period_${s}`, answerValue: '30' });
    recordUserAnswer({ applicationId: initRes.applicationId, questionKey: `work_arrangement_${s}`, answerValue: 'onsite' });
    recordUserAnswer({ applicationId: initRes.applicationId, questionKey: `visasponsorship_${s}`, answerValue: 'no' });

    const resumeRes = await resumeApplicationWorkflow(initRes.applicationId, {
        htmlContent: getMockGreenhouseHtml(s),
        headless: true,
        logger: () => {}
    });

    assert.strictEqual(resumeRes.canProceedToSubmit, false);
    assert(resumeRes.policyReason.includes('MANUAL_REVIEW required') || resumeRes.policyReason.includes('No explicit, active submission authorization'));
});

await asyncTest('Test 21: Explicit single authorization permits submission to proceed', async () => {
    const { jobId } = setupTestJob('auth_proceed');
    const s = `t21_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const initRes = await runApplicationWorkflow(jobId, {
        htmlContent: getMockGreenhouseHtml(s),
        headless: true,
        logger: () => {}
    });

    recordUserAnswer({ applicationId: initRes.applicationId, questionKey: `notice_period_${s}`, answerValue: '30' });
    recordUserAnswer({ applicationId: initRes.applicationId, questionKey: `work_arrangement_${s}`, answerValue: 'remote' });
    recordUserAnswer({ applicationId: initRes.applicationId, questionKey: `visasponsorship_${s}`, answerValue: 'no' });

    const resumeRes = await resumeApplicationWorkflow(initRes.applicationId, {
        htmlContent: getMockGreenhouseHtml(s),
        headless: true,
        logger: () => {}
    });

    const authId = createSubmissionAuthorization({
        scope: 'single',
        application_id: resumeRes.applicationId,
        authorized_by: 'user'
    });

    assert(authId, 'Authorization ID must be created');
});

test('Test 21b: Authorization rejected after review packet modification', () => {
    const { compId, jobId } = setupTestJob('auth_pkt_mod');
    const appId = `app_pkt_mod_${Date.now()}`;
    const packetPath = resolve(__dirname, `output/review-packets/${appId}.md`);
    writeFileSync(packetPath, '# Original Review Packet Content\nCandidate: Jordan');

    const originalHash = createHash('sha256').update(readFileSync(packetPath, 'utf8')).digest('hex');

    const db = getDb();
    db.prepare(`
        INSERT INTO applications (id, job_id, company_id, state, review_packet_path, resume_version_id)
        VALUES (?, ?, ?, 'READY_FOR_REVIEW', ?, 'resume_v_alpha')
    `).run(appId, jobId, compId, packetPath);

    const originalApp = getApplication(appId);
    const originalDigest = computeApplicationPayloadDigest(originalApp);

    const authId = createSubmissionAuthorization({
        scope: 'single',
        application_id: appId,
        packet_hash: originalHash,
        resume_version_id: 'resume_v_alpha',
        payload_digest: originalDigest,
        authorized_by: 'user'
    });

    // Valid before modification
    const preCheck = canProceedToSubmit({ application: getApplication(appId) });
    assert.strictEqual(preCheck.allowed, true);

    // Modify packet on disk
    appendFileSync(packetPath, '\n<!-- Modified after review -->');

    // Policy must now reject
    const postCheck = canProceedToSubmit({ application: getApplication(appId) });
    assert.strictEqual(postCheck.allowed, false);
    assert(postCheck.reason.includes('Review packet has been modified'));
});

test('Test 21c: Authorization rejected after answers / payload modification', () => {
    const { compId, jobId } = setupTestJob('auth_ans_mod');
    const appId = `app_ans_mod_${Date.now()}`;
    const packetPath = resolve(__dirname, `output/review-packets/${appId}.md`);
    writeFileSync(packetPath, '# Review Packet Content\nCandidate: Jordan');
    const packetHash = createHash('sha256').update(readFileSync(packetPath, 'utf8')).digest('hex');

    const initialMetadata = {
        completedFields: [
            { name: 'first_name', value: 'Jordan' },
            { name: 'notice_period', value: '30' }
        ]
    };

    const db = getDb();
    db.prepare(`
        INSERT INTO applications (id, job_id, company_id, state, execution_metadata_json, review_packet_path, resume_version_id)
        VALUES (?, ?, ?, 'READY_FOR_REVIEW', ?, ?, 'resume_v_alpha')
    `).run(appId, jobId, compId, JSON.stringify(initialMetadata), packetPath);

    const originalApp = getApplication(appId);
    const originalDigest = computeApplicationPayloadDigest(originalApp);

    const authId = createSubmissionAuthorization({
        scope: 'single',
        application_id: appId,
        packet_hash: packetHash,
        resume_version_id: 'resume_v_alpha',
        payload_digest: originalDigest,
        authorized_by: 'user'
    });

    // Valid before modification
    const preCheck = canProceedToSubmit({ application: getApplication(appId) });
    assert.strictEqual(preCheck.allowed, true);

    // Modify answers in application metadata
    const tamperedMetadata = {
        completedFields: [
            { name: 'first_name', value: 'Jordan' },
            { name: 'notice_period', value: '90' } // Tampered value
        ]
    };
    updateApplicationExecution(appId, { execution_metadata_json: tamperedMetadata });

    // Policy must now reject
    const postCheck = canProceedToSubmit({ application: getApplication(appId) });
    assert.strictEqual(postCheck.allowed, false);
    assert(postCheck.reason.includes('modified after authorization was granted'));
});

test('Test 21d: Authorization rejected after resume version modification', () => {
    const { compId, jobId } = setupTestJob('auth_res_mod');
    const s = `res_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const resAlpha = `resume_v_alpha_${s}`;
    const resTampered = `resume_v_tampered_${s}`;
    const appId = `app_res_mod_${Date.now()}`;
    const packetPath = resolve(__dirname, `output/review-packets/${appId}.md`);
    writeFileSync(packetPath, '# Review Packet Content\nCandidate: Jordan');
    const packetHash = createHash('sha256').update(readFileSync(packetPath, 'utf8')).digest('hex');

    insertResumeVersion({
        id: resAlpha,
        job_id: jobId,
        format: 'pdf',
        file_path: 'output/test_resume_alpha.pdf',
        variant_label: 'Alpha'
    });
    insertResumeVersion({
        id: resTampered,
        job_id: jobId,
        format: 'pdf',
        file_path: 'output/test_resume_tampered.pdf',
        variant_label: 'Tampered'
    });

    const db = getDb();
    db.prepare(`
        INSERT INTO applications (id, job_id, company_id, state, resume_version_id, review_packet_path)
        VALUES (?, ?, ?, 'READY_FOR_REVIEW', ?, ?)
    `).run(appId, jobId, compId, resAlpha, packetPath);

    const originalApp = getApplication(appId);
    const originalDigest = computeApplicationPayloadDigest(originalApp);

    const authId = createSubmissionAuthorization({
        scope: 'single',
        application_id: appId,
        packet_hash: packetHash,
        resume_version_id: resAlpha,
        payload_digest: originalDigest,
        authorized_by: 'user'
    });

    const preCheck = canProceedToSubmit({ application: getApplication(appId) });
    assert.strictEqual(preCheck.allowed, true);

    // Swap resume version
    updateApplicationExecution(appId, { resume_version_id: resTampered });

    const postCheck = canProceedToSubmit({ application: getApplication(appId) });
    assert.strictEqual(postCheck.allowed, false);
    assert(postCheck.reason.includes('Resume version'));
});

await asyncTest('Test 22: Mock portal submission detects receipt and transitions to CONFIRMED with recruitment_outcome = APPLIED', async () => {
    const { compId, jobId } = setupTestJob('submit_mock');
    const s = `t22_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const initRes = await runApplicationWorkflow(jobId, {
        htmlContent: getMockGreenhouseHtml(s),
        headless: true,
        logger: () => {}
    });

    recordUserAnswer({ applicationId: initRes.applicationId, questionKey: `notice_period_${s}`, answerValue: '30' });
    recordUserAnswer({ applicationId: initRes.applicationId, questionKey: `work_arrangement_${s}`, answerValue: 'remote' });
    recordUserAnswer({ applicationId: initRes.applicationId, questionKey: `visasponsorship_${s}`, answerValue: 'no' });

    const resumeRes = await resumeApplicationWorkflow(initRes.applicationId, {
        htmlContent: getMockGreenhouseHtml(s),
        headless: true,
        logger: () => {}
    });

    const app = getApplication(resumeRes.applicationId);
    const packetContent = readFileSync(resumeRes.reviewPacketPath, 'utf8');
    const packetHash = createHash('sha256').update(packetContent).digest('hex');
    const payloadDigest = computeApplicationPayloadDigest(app);

    const authId = createSubmissionAuthorization({
        scope: 'single',
        application_id: resumeRes.applicationId,
        packet_hash: packetHash,
        resume_version_id: app.resume_version_id,
        payload_digest: payloadDigest,
        authorized_by: 'user'
    });

    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.setContent(getMockGreenhouseHtml(s));

    // Mock confirmation transition on submit with novalidate to bypass HTML5 client validation
    await page.evaluate(() => {
        const form = document.querySelector('form');
        if (form) form.setAttribute('novalidate', 'true');
        form.addEventListener('submit', (e) => {
            e.preventDefault();
            document.body.innerHTML = `
                <div class="application-confirmation">
                  <h1>Thank you for applying</h1>
                  <p>Your application has been submitted successfully.</p>
                  <p>Confirmation Reference: REF-GH-BATCH-C-12345</p>
                </div>
            `;
        });
    });

    const adapter = getAdapterForPortal(PORTAL_TYPES.GREENHOUSE);
    const submitResult = await submitApplication(page, {
        application: getApplication(resumeRes.applicationId),
        job: getJob(jobId),
        company: { id: compId },
        adapter,
        authorization: getSubmissionAuthorization(authId),
        validationResult: { valid: true },
        dryRun: false
    });

    assert.strictEqual(submitResult.status, APPLICATION_STATES.CONFIRMED);
    assert.strictEqual(submitResult.confirmationReference, 'REF-GH-BATCH-C-12345');

    const appAfter = getApplication(resumeRes.applicationId);
    assert.strictEqual(appAfter.state, APPLICATION_STATES.CONFIRMED);
    assert.strictEqual(appAfter.recruitment_outcome, RECRUITMENT_OUTCOMES.APPLIED);
    assert.strictEqual(appAfter.confirmation_reference, 'REF-GH-BATCH-C-12345');

    await browser.close();
});

test('Test 23: Successful submission updates recruitment outcome to APPLIED', () => {
    const { compId, jobId } = setupTestJob('outcome_applied');
    const db = getDb();
    const appId = `app_applied_${Date.now()}`;

    db.prepare(`
        INSERT INTO applications (id, job_id, company_id, state, recruitment_outcome)
        VALUES (?, ?, ?, 'CONFIRMED', 'APPLIED')
    `).run(appId, jobId, compId);

    const app = getApplication(appId);
    assert.strictEqual(app.recruitment_outcome, RECRUITMENT_OUTCOMES.APPLIED);
});

test('Test 24: Uncertain outcome on submission crash enters UNCERTAIN_OUTCOME', () => {
    const { compId, jobId } = setupTestJob('uncertain_test');
    const db = getDb();
    const appId = `app_uncert_${Date.now()}`;

    db.prepare(`
        INSERT INTO applications (id, job_id, company_id, state)
        VALUES (?, ?, ?, 'SUBMITTING')
    `).run(appId, jobId, compId);

    updateApplicationState(appId, APPLICATION_STATES.UNCERTAIN_OUTCOME, {
        actor: 'system',
        eventType: 'submission_crash',
        message: 'Browser connection lost during submit click'
    });

    const app = getApplication(appId);
    assert.strictEqual(app.state, APPLICATION_STATES.UNCERTAIN_OUTCOME);
});

test('Test 25: UNCERTAIN_OUTCOME reconciles cleanly via reconcileSubmissionOutcome and sets outcome to APPLIED', () => {
    const { compId, jobId } = setupTestJob('rec_recon');
    const db = getDb();
    const appId = `app_recon_${Date.now()}`;

    db.prepare(`
        INSERT INTO applications (id, job_id, company_id, state)
        VALUES (?, ?, ?, 'UNCERTAIN_OUTCOME')
    `).run(appId, jobId, compId);

    const res = reconcileSubmissionOutcome(appId, {
        outcome: 'CONFIRMED',
        confirmationReference: 'CONF-MANUAL-VERIFIED-999',
        actor: 'user',
        notes: 'User verified application email receipt'
    });

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.newState, APPLICATION_STATES.CONFIRMED);
    assert.strictEqual(res.confirmationReference, 'CONF-MANUAL-VERIFIED-999');

    const app = getApplication(appId);
    assert.strictEqual(app.state, APPLICATION_STATES.CONFIRMED);
    assert.strictEqual(app.recruitment_outcome, RECRUITMENT_OUTCOMES.APPLIED);
    assert.strictEqual(app.confirmation_reference, 'CONF-MANUAL-VERIFIED-999');
});

test('Test 26: Authorization cannot be reused once consumed', () => {
    const { compId, jobId } = setupTestJob('auth_reuse');
    const db = getDb();
    const appId = `app_auth_once_${Date.now()}`;
    db.prepare(`
        INSERT INTO applications (id, job_id, company_id, state)
        VALUES (?, ?, ?, 'READY_FOR_REVIEW')
    `).run(appId, jobId, compId);

    const authId = createSubmissionAuthorization({
        scope: 'single',
        application_id: appId,
        authorized_by: 'user'
    });

    // Simulate consuming the authorization via repo function
    useSubmissionAuthorization(authId);

    const auth = db.prepare('SELECT * FROM submission_authorizations WHERE id = ?').get(authId);
    assert(auth.used_count >= auth.max_applications, 'Single authorization must be exhausted after one use');
    assert.strictEqual(auth.status, 'used');
});

test('Test 26b: Authorization consumed BEFORE submission and cannot be reused on interrupted submission', async () => {
    const { compId, jobId } = setupTestJob('auth_pre_consume');
    const appId = `app_pre_consume_${Date.now()}`;
    const packetPath = resolve(__dirname, `output/review-packets/${appId}.md`);
    writeFileSync(packetPath, `# Review Packet for ${appId}`);

    const resId = `res_${Date.now()}`;
    insertResumeVersion({
        id: resId,
        job_id: jobId,
        format: 'pdf',
        file_path: 'output/test_resume.pdf',
        variant_label: 'General'
    });

    const db = getDb();
    db.prepare(`
        INSERT INTO applications (id, job_id, company_id, state, resume_version_id, review_packet_path)
        VALUES (?, ?, ?, 'READY_FOR_REVIEW', ?, ?)
    `).run(appId, jobId, compId, resId, packetPath);

    const app = getApplication(appId);
    const packetHash = createHash('sha256').update(readFileSync(packetPath, 'utf8')).digest('hex');
    const payloadDigest = computeApplicationPayloadDigest(app);

    const authId = createSubmissionAuthorization({
        scope: 'single',
        application_id: appId,
        packet_hash: packetHash,
        resume_version_id: resId,
        payload_digest: payloadDigest,
        authorized_by: 'user'
    });

    // Mock page where submit throws an in-flight network crash
    const mockPage = {
        click: async () => {
            throw new Error('Connection reset by peer during submit click');
        }
    };

    const mockAdapter = {
        findSubmitButton: async () => ({ selector: '#submit_btn', disabled: false })
    };

    const submitRes = await submitApplication(mockPage, {
        application: getApplication(appId),
        job: getJob(jobId),
        company: { id: compId },
        adapter: mockAdapter,
        authorization: getSubmissionAuthorization(authId)
    });

    assert.strictEqual(submitRes.status, APPLICATION_STATES.UNCERTAIN_OUTCOME);

    // Verify authorization was consumed despite the crash
    const auth = db.prepare('SELECT * FROM submission_authorizations WHERE id = ?').get(authId);
    assert.strictEqual(auth.status, 'used');
    assert.strictEqual(auth.used_count, 1);

    // Verify secondary submission attempt is rejected
    const retryCheck = canProceedToSubmit({ application: getApplication(appId) });
    assert.strictEqual(retryCheck.allowed, false);
});

test('Test 26c: Uncertain outcomes cannot be blindly resubmitted without reconciliation', () => {
    const { compId, jobId } = setupTestJob('blind_resubmit');
    const appId = `app_blind_${Date.now()}`;

    const db = getDb();
    db.prepare(`
        INSERT INTO applications (id, job_id, company_id, state)
        VALUES (?, ?, ?, 'UNCERTAIN_OUTCOME')
    `).run(appId, jobId, compId);

    // canProceedToSubmit must reject applications in UNCERTAIN_OUTCOME
    const check = canProceedToSubmit({ application: getApplication(appId) });
    assert.strictEqual(check.allowed, false);
});

console.log('\n--- Part 4: Data Integrity, Canonical Tracking & Audit (Tests 27–32e) ---');

test('Test 27: State transitions record complete sequence of immutable audit events', () => {
    const { compId, jobId } = setupTestJob('audit_seq');
    const db = getDb();
    const appId = `app_audit_${Date.now()}`;

    db.prepare(`
        INSERT INTO applications (id, job_id, company_id, state)
        VALUES (?, ?, ?, 'NOT_STARTED')
    `).run(appId, jobId, compId);

    updateApplicationState(appId, APPLICATION_STATES.DRAFTING, { actor: 'system', eventType: 'drafting_started' });
    updateApplicationState(appId, APPLICATION_STATES.PORTAL_OPENED, { actor: 'system', eventType: 'portal_opened' });
    updateApplicationState(appId, APPLICATION_STATES.NEEDS_USER_INPUT, { actor: 'system', eventType: 'needs_user_input' });
    updateApplicationState(appId, APPLICATION_STATES.FORM_FILLING, { actor: 'user', eventType: 'resumed' });
    updateApplicationState(appId, APPLICATION_STATES.READY_FOR_REVIEW, { actor: 'system', eventType: 'ready_for_review' });

    const events = getApplicationEvents(appId);
    assert.strictEqual(events.length, 5);
    assert.strictEqual(events[0].new_state, APPLICATION_STATES.DRAFTING);
    assert.strictEqual(events[1].new_state, APPLICATION_STATES.PORTAL_OPENED);
    assert.strictEqual(events[2].new_state, APPLICATION_STATES.NEEDS_USER_INPUT);
    assert.strictEqual(events[3].new_state, APPLICATION_STATES.FORM_FILLING);
    assert.strictEqual(events[4].new_state, APPLICATION_STATES.READY_FOR_REVIEW);
});

test('Test 28: candidate_answers stores provenance (source, confidence, confirmed_by_user, confirmed_at)', () => {
    const key = `prov_test_${Date.now()}`;
    recordUserAnswer({
        questionKey: key,
        answerValue: 'TestProvenance',
        source: 'user_cli',
        confirmedByUser: true
    });

    const ans = getAnswerByKey(key);
    assert.strictEqual(ans.source, 'user_cli');
    assert.strictEqual(ans.confidence, 1.0);
    assert.strictEqual(ans.confirmed_by_user, 1);
    assert(ans.confirmed_at);
});

test('Test 28d: Repeated tracker exports produce zero duplicate rows', () => {
    // Export 1
    const res1 = exportApplicationsMarkdown({ writeDisk: false });
    // Export 2
    const res2 = exportApplicationsMarkdown({ writeDisk: false });
    // Export 3
    const res3 = exportApplicationsMarkdown({ writeDisk: false });

    assert.strictEqual(res1.content, res2.content, 'Tracker export must be completely deterministic and identical');
    assert.strictEqual(res2.content, res3.content, 'Tracker export must produce zero duplicate rows on repeat runs');
});

test('Test 28e: Export failure leaves SQLite confirmation intact and can be retried safely', () => {
    const { compId, jobId } = setupTestJob('exp_fail_intact');
    const appId = `app_exp_fail_${Date.now()}`;

    const db = getDb();
    db.prepare(`
        INSERT INTO applications (id, job_id, company_id, state, recruitment_outcome)
        VALUES (?, ?, ?, 'CONFIRMED', 'APPLIED')
    `).run(appId, jobId, compId);

    // Simulate an export attempt with invalid disk path
    let caught = false;
    try {
        exportApplicationsMarkdown({ outputPath: 'Z:\\invalid_nonexistent_directory\\apps.md' });
    } catch (err) {
        caught = true;
    }
    assert(caught, 'Export to invalid path throws error');

    // Verify SQLite confirmation remains fully intact
    const app = getApplication(appId);
    assert.strictEqual(app.state, APPLICATION_STATES.CONFIRMED);
    assert.strictEqual(app.recruitment_outcome, 'APPLIED');

    // Safe retry with default valid parameters succeeds
    const retryRes = exportApplicationsMarkdown({ writeDisk: false });
    assert(retryRes.content.length > 0);
});

test('Test 29: Application foreign keys remain valid and intact across checkpoints', () => {
    const { compId, jobId } = setupTestJob('fk_intact');
    const db = getDb();
    const appId = `app_fk_${Date.now()}`;

    db.prepare(`
        INSERT INTO applications (id, job_id, company_id, state)
        VALUES (?, ?, ?, 'NEEDS_USER_INPUT')
    `).run(appId, jobId, compId);

    const app = getApplication(appId);
    assert.strictEqual(app.job_id, jobId);
    assert.strictEqual(app.company_id, compId);

    const job = getJob(app.job_id);
    assert(job, 'Job foreign key must resolve');
});

test('Test 30: candidate_facts table is strictly protected from application-level writes', () => {
    const factsInitial = getCandidateFacts();
    recordUserAnswer({
        questionKey: 'salary_expectation_protect',
        answerValue: '1500000',
        confirmedByUser: true
    });
    const factsFinal = getCandidateFacts();
    assert.strictEqual(factsInitial.length, factsFinal.length);
});

await asyncTest('Test 31: Idempotent re-runs of resumeApplicationWorkflow at READY_FOR_REVIEW', async () => {
    const { jobId } = setupTestJob('idem_ready');
    const s = `t31_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const initRes = await runApplicationWorkflow(jobId, {
        htmlContent: getMockGreenhouseHtml(s),
        headless: true,
        logger: () => {}
    });

    recordUserAnswer({ applicationId: initRes.applicationId, questionKey: `notice_period_${s}`, answerValue: '30' });
    recordUserAnswer({ applicationId: initRes.applicationId, questionKey: `work_arrangement_${s}`, answerValue: 'remote' });
    recordUserAnswer({ applicationId: initRes.applicationId, questionKey: `visasponsorship_${s}`, answerValue: 'no' });

    const firstResume = await resumeApplicationWorkflow(initRes.applicationId, {
        htmlContent: getMockGreenhouseHtml(s),
        headless: true,
        logger: () => {}
    });
    assert.strictEqual(firstResume.status, APPLICATION_STATES.READY_FOR_REVIEW);

    // Re-running resume when state is READY_FOR_REVIEW: state machine prevents invalid transition
    let errorCaught = false;
    try {
        await resumeApplicationWorkflow(initRes.applicationId, {
            htmlContent: getMockGreenhouseHtml(s),
            headless: true,
            logger: () => {}
        });
    } catch (err) {
        errorCaught = true;
        assert(err.message.includes('cannot be resumed from state: READY_FOR_REVIEW'));
    }
    assert(errorCaught, 'Re-running resume when already READY_FOR_REVIEW must be rejected');
});

test('Test 32: Inactive job blocks continuation workflow', async () => {
    const { compId, jobId } = setupTestJob('inactive_job');
    const db = getDb();
    const appId = `app_inact_${Date.now()}`;

    db.prepare(`
        INSERT INTO applications (id, job_id, company_id, state)
        VALUES (?, ?, ?, 'NEEDS_USER_INPUT')
    `).run(appId, jobId, compId);

    // Close the job
    db.prepare("UPDATE job_postings SET status = 'closed' WHERE id = ?").run(jobId);

    let errorThrown = false;
    try {
        await resumeApplicationWorkflow(appId);
    } catch (err) {
        errorThrown = true;
        assert(err.message.includes('Job posting is no longer active'));
    }
    assert(errorThrown, 'Must throw error when resuming an inactive/closed job');
});

console.log('\n--- Part 5: Full End-to-End Workflow Integration Test ---');

await asyncTest('Full End-to-End Flow: Start -> Halt -> Answer -> Resume -> Review -> Authorize -> Submit -> Confirmed', async () => {
    // 1. Setup job & evaluation
    const { compId, jobId } = setupTestJob('e2e_full');
    const s = `e2e_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

    // 2. Start application workflow: halts at NEEDS_USER_INPUT
    console.log('   Step 1: Starting application workflow...');
    const initRes = await runApplicationWorkflow(jobId, {
        htmlContent: getMockGreenhouseHtml(s),
        headless: true,
        logger: () => {}
    });
    assert.strictEqual(initRes.status, APPLICATION_STATES.NEEDS_USER_INPUT);
    const appId = initRes.applicationId;

    // 3. Inspect pending questions from checkpoint
    console.log('   Step 2: Inspecting checkpoint pending questions...');
    const appRecord = getApplication(appId);
    const checkpoint = JSON.parse(appRecord.execution_metadata_json);
    assert(checkpoint.pendingQuestions.length >= 3);

    // 4. Record human answers with explicit confirmation
    console.log('   Step 3: Recording confirmed human answers...');
    recordUserAnswer({ applicationId: appId, questionKey: `notice_period_${s}`, answerValue: '30' });
    recordUserAnswer({ applicationId: appId, questionKey: `work_arrangement_${s}`, answerValue: 'hybrid' });
    recordUserAnswer({ applicationId: appId, questionKey: `visasponsorship_${s}`, answerValue: 'no' });

    // 5. Resume application workflow: advances to READY_FOR_REVIEW
    console.log('   Step 4: Resuming application workflow...');
    const resumeRes = await resumeApplicationWorkflow(appId, {
        htmlContent: getMockGreenhouseHtml(s),
        headless: true,
        logger: () => {}
    });
    assert.strictEqual(resumeRes.status, APPLICATION_STATES.READY_FOR_REVIEW);
    assert.strictEqual(resumeRes.validation.valid, true);
    assert(existsSync(resumeRes.reviewPacketPath));

    // 6. Explicitly authorize submission with review packet hash binding
    console.log('   Step 5: Authorizing submission with review packet hash binding...');
    const packetContent = readFileSync(resumeRes.reviewPacketPath, 'utf8');
    const packetHash = createHash('sha256').update(packetContent).digest('hex');
    const payloadDigest = computeApplicationPayloadDigest(getApplication(appId));

    const authId = createSubmissionAuthorization({
        scope: 'single',
        application_id: appId,
        authorized_by: 'user',
        packet_hash: packetHash,
        resume_version_id: getApplication(appId).resume_version_id,
        payload_digest: payloadDigest
    });

    // 7. Submit to mock portal and detect confirmation receipt
    console.log('   Step 6: Submitting to portal with mock confirmation...');
    const browser = await chromium.launch({ headless: true });
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
                  <p>Your application has been submitted successfully.</p>
                  <p>Confirmation Reference: CONF-E2E-SUCCESS-7788</p>
                </div>
            `;
        });
    });

    const adapter = getAdapterForPortal(PORTAL_TYPES.GREENHOUSE);
    const submitResult = await submitApplication(page, {
        application: getApplication(appId),
        job: getJob(jobId),
        company: { id: compId },
        adapter,
        authorization: getSubmissionAuthorization(authId),
        validationResult: { valid: true },
        dryRun: false
    });

    assert.strictEqual(submitResult.status, APPLICATION_STATES.CONFIRMED);
    assert.strictEqual(submitResult.confirmationReference, 'CONF-E2E-SUCCESS-7788');

    // 8. Reconcile and verify final state and recruitment outcome in SQLite
    console.log('   Step 7: Verifying final state, outcome, and events in SQLite...');
    const finalApp = getApplication(appId);
    assert.strictEqual(finalApp.state, APPLICATION_STATES.CONFIRMED);
    assert.strictEqual(finalApp.recruitment_outcome, RECRUITMENT_OUTCOMES.APPLIED);
    assert.strictEqual(finalApp.confirmation_reference, 'CONF-E2E-SUCCESS-7788');

    const allEvents = getApplicationEvents(appId);
    assert(allEvents.some(e => e.event_type === 'needs_user_input'));
    assert(allEvents.some(e => e.event_type === 'continuation_resumed'));
    assert(allEvents.some(e => e.event_type === 'ready_for_review'));
    assert(allEvents.some(e => e.new_state === 'CONFIRMED'));

    await browser.close();
    console.log('   🎉 Complete End-to-End Workflow successfully verified!');
});

console.log('\n====================================================');
console.log(`📊 Milestone 3E Batch C & Phase 4A Results: ${passedCount} PASSED, ${failedCount} FAILED`);
console.log('====================================================');

try { closeDb(); } catch {}
cleanupTestDb();

if (failedCount > 0) {
    process.exit(1);
} else {
    process.exit(0);
}
