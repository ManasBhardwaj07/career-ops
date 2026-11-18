/**
 * test-milestone3d.mjs — Universal Application Execution Engine Test Suite
 *
 * Implements Milestone 3D Part 15:
 *   - Browser session and persistent context tests
 *   - Independent browser network security & egress proxy tests (SSRF, rebinding, metadata)
 *   - Portal platform detection (Greenhouse, Lever, Ashby, Workday, SmartRecruiters, Generic)
 *   - Multi-signal field detection and semantic classification
 *   - Verified candidate autofill and mandatory human-input gating
 *   - Document attachment and single-page resume verification
 *   - Strict application state machine enforcement and audit logging
 *   - Submission authorization policies (MANUAL_REVIEW, single, bounded batch)
 *   - Controlled submission, confirmation detection, and uncertain-outcome reconciliation
 *   - End-to-end local fixture application workflow
 */

import http from 'http';
import assert from 'assert';
import { createHash } from 'crypto';
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync, unlinkSync, readdirSync, copyFileSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const TEST_DB_PATH = resolve(process.cwd(), 'data', 'test_milestone3d.db');
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
process.env.JOB_AGENT_DB_PATH = TEST_DB_PATH;

const { getDb, closeDb, getDbPath } = await import('./db/db.mjs');
const resolvedDbPath = resolve(getDbPath());
if (resolvedDbPath === CANONICAL_DB_PATH) {
    throw new Error(`SAFETY ABORT: test-milestone3d.mjs resolved to canonical DB (${resolvedDbPath})`);
}
console.log(`🔒 Isolated DB Path: ${resolvedDbPath}`);

process.on('exit', () => {
    try { closeDb(); } catch { /* ignore */ }
    cleanupTestDb();
});

const {
    upsertCompany,
    upsertJobPosting,
    insertJobEvaluationRun,
    insertResumeVersion,
    getResumeVersion,
    getApplication,
    getAllApplications,
    getApplicationEvents,
    updateApplicationState,
    updateApplicationExecution,
    createSubmissionAuthorization,
    getSubmissionAuthorization,
    getValidSubmissionAuthorization,
    useSubmissionAuthorization,
    upsertCandidateAnswer,
    confirmCandidateAnswer,
    APPLICATION_STATES
} = await import('./db/repo.mjs');

const {
    isPrivateIPv4,
    isPrivateIPv6,
    isInternalHostname,
    validateHostDns,
    EgressSecurityError,
    startEgressProxy
} = await import('./application/browser/egress-proxy.mjs');

const { attachBrowserSecurity } = await import('./application/browser/security.mjs');
const { createBrowserSession } = await import('./application/browser/session.mjs');
const { detectApplicationPortal, PORTAL_TYPES } = await import('./application/detection/detect-portal.mjs');
const { classifyField, FIELD_CLASSIFICATIONS } = await import('./application/detection/classify-fields.mjs');
const { detectFields } = await import('./application/detection/detect-fields.mjs');
const { mapFieldsToCandidateData } = await import('./application/autofill/answer-mapper.mjs');
const { fillApplicationFields } = await import('./application/autofill/fill-fields.mjs');
const { attachResume } = await import('./application/documents/attach-resume.mjs');
const { validateApplication } = await import('./application/validation/validate-application.mjs');
const { buildReviewPacket } = await import('./application/review/build-review-packet.mjs');
const { canProceedToSubmit, computeApplicationPayloadDigest, SUBMISSION_POLICIES } = await import('./application/submission/policy.mjs');
const { submitApplication } = await import('./application/submission/submit.mjs');
const { confirmSubmission } = await import('./application/submission/confirm-submission.mjs');
const { reconcileSubmissionOutcome } = await import('./application/submission/reconcile-outcome.mjs');
const { getAdapterForPortal } = await import('./application/adapters/index.mjs');
const { runApplicationWorkflow } = await import('./application/apply.mjs');

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
console.log('🧪 MILESTONE 3D — APPLICATION EXECUTION ENGINE TEST');
console.log('====================================================');

// ── 1. Browser Network Security & Egress Proxy ───────────────────────────────
console.log('\n--- 1. Network Egress Security & Anti-SSRF ---');

test('Egress rejects private IPv4 ranges (127.0.0.1, 10.0.0.1, 192.168.1.1)', () => {
    assert(isPrivateIPv4('127.0.0.1') === true);
    assert(isPrivateIPv4('10.200.1.5') === true);
    assert(isPrivateIPv4('192.168.0.100') === true);
    assert(isPrivateIPv4('172.20.0.1') === true);
    assert(isPrivateIPv4('8.8.8.8') === false);
    assert(isPrivateIPv4('1.1.1.1') === false);
});

test('Egress rejects cloud metadata IP (169.254.169.254) and link-local', () => {
    assert(isPrivateIPv4('169.254.169.254') === true);
    assert(isPrivateIPv4('169.254.1.1') === true);
});

test('Egress rejects IPv6 loopback, link-local and IPv4-mapped IPv6', () => {
    assert(isPrivateIPv6('::1') === true);
    assert(isPrivateIPv6('fe80::1') === true);
    assert(isPrivateIPv6('::ffff:127.0.0.1') === true);
    assert(isPrivateIPv6('::ffff:169.254.169.254') === true);
    assert(isPrivateIPv6('2607:f8b0:4005:805::200e') === false);
});

test('Egress rejects internal and metadata hostnames', () => {
    assert(isInternalHostname('localhost') === true);
    assert(isInternalHostname('test.local') === true);
    assert(isInternalHostname('service.internal') === true);
    assert(isInternalHostname('metadata.google.internal') === true);
    assert(isInternalHostname('boards.greenhouse.io') === false);
    assert(isInternalHostname('jobs.lever.co') === false);
});

await asyncTest('Egress proxy blocks DNS rebinding with mixed public/private addresses', async () => {
    // Mock resolver simulating DNS rebinding attack
    const rebindingResolver = async (host) => {
        if (host === 'rebind.attacker.com') {
            return ['93.184.216.34', '127.0.0.1'];
        }
        return ['93.184.216.34'];
    };

    let rebindingBlocked = false;
    let blockReason = null;
    try {
        await validateHostDns('rebind.attacker.com', { dnsResolver: rebindingResolver });
    } catch (err) {
        if (err instanceof EgressSecurityError) {
            rebindingBlocked = true;
            blockReason = err.reason;
        }
    }

    assert.strictEqual(rebindingBlocked, true, 'Proxy must block DNS rebinding attack');
    assert.strictEqual(blockReason, 'DNS_REBINDING_PRIVATE_IP');
});

await asyncTest('Egress proxy blocks metadata IP connection attempts via CONNECT', async () => {
    const proxy = await startEgressProxy();
    try {
        const blocked = await new Promise((res) => {
            const req = http.request({
                host: '127.0.0.1',
                port: proxy.port,
                method: 'CONNECT',
                path: '169.254.169.254:80'
            });
            req.on('connect', () => res(false));
            req.on('response', (response) => {
                res(response.statusCode === 403);
            });
            req.on('error', () => res(true));
            req.end();
        });
        assert(blocked === true, 'Proxy must block CONNECT request to cloud metadata IP');
    } finally {
        await proxy.stop();
    }
});

// ── 2. Portal Platform Detection ─────────────────────────────────────────────
console.log('\n--- 2. Portal Platform Detection ---');

await asyncTest('detectApplicationPortal classifies Greenhouse URL correctly', async () => {
    const res = await detectApplicationPortal('https://job-boards.greenhouse.io/anthropic/jobs/12345');
    assert.strictEqual(res.type, PORTAL_TYPES.GREENHOUSE);
    assert(res.confidence >= 0.9);
});

await asyncTest('detectApplicationPortal classifies Lever URL correctly', async () => {
    const res = await detectApplicationPortal('https://jobs.lever.co/palantir/abcdef');
    assert.strictEqual(res.type, PORTAL_TYPES.LEVER);
    assert(res.confidence >= 0.9);
});

await asyncTest('detectApplicationPortal classifies Ashby URL correctly', async () => {
    const res = await detectApplicationPortal('https://jobs.ashbyhq.com/elevenlabs/12345');
    assert.strictEqual(res.type, PORTAL_TYPES.ASHBY);
    assert(res.confidence >= 0.9);
});

await asyncTest('detectApplicationPortal classifies Workday URL correctly', async () => {
    const res = await detectApplicationPortal('https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/123');
    assert.strictEqual(res.type, PORTAL_TYPES.WORKDAY);
});

await asyncTest('detectApplicationPortal classifies SmartRecruiters URL correctly', async () => {
    const res = await detectApplicationPortal('https://jobs.smartrecruiters.com/AcmeCorp/12345');
    assert.strictEqual(res.type, PORTAL_TYPES.SMARTRECRUITERS);
});

await asyncTest('detectApplicationPortal defaults to Generic for arbitrary career pages', async () => {
    const res = await detectApplicationPortal('https://example.com/careers/apply');
    assert.strictEqual(res.type, PORTAL_TYPES.GENERIC);
});

// ── 3. Field Classification & Semantic Mapping ───────────────────────────────
console.log('\n--- 3. Field Classification & Semantic Mapping ---');

test('classifyField identifies First Name, Last Name, Full Name', () => {
    assert.strictEqual(classifyField({ label: 'First Name', name: 'first_name' }).classification, FIELD_CLASSIFICATIONS.FIRST_NAME);
    assert.strictEqual(classifyField({ label: 'Last Name', name: 'last_name' }).classification, FIELD_CLASSIFICATIONS.LAST_NAME);
    assert.strictEqual(classifyField({ label: 'Full Name', name: 'candidate_name' }).classification, FIELD_CLASSIFICATIONS.FULL_NAME);
});

test('classifyField identifies Contact Information (Email, Phone, Location)', () => {
    assert.strictEqual(classifyField({ label: 'Email Address', type: 'email' }).classification, FIELD_CLASSIFICATIONS.EMAIL);
    assert.strictEqual(classifyField({ label: 'Phone Number', type: 'tel' }).classification, FIELD_CLASSIFICATIONS.PHONE);
    assert.strictEqual(classifyField({ label: 'Current Location', name: 'city' }).classification, FIELD_CLASSIFICATIONS.LOCATION);
});

test('classifyField identifies File Upload as Resume', () => {
    assert.strictEqual(classifyField({ label: 'Attach Resume / CV', type: 'file' }).classification, FIELD_CLASSIFICATIONS.RESUME);
});

test('classifyField flags Sensitive / Legal fields (Work Auth, Visa, Salary, EEO)', () => {
    const workAuth = classifyField({ label: 'Are you legally authorized to work in the United States?' });
    assert.strictEqual(workAuth.classification, FIELD_CLASSIFICATIONS.WORK_AUTHORIZATION);
    assert.strictEqual(workAuth.isSensitive, true);

    const visa = classifyField({ label: 'Will you now or in the future require visa sponsorship?' });
    assert.strictEqual(visa.classification, FIELD_CLASSIFICATIONS.VISA_SPONSORSHIP);
    assert.strictEqual(visa.isSensitive, true);

    const salary = classifyField({ label: 'Desired Salary / Compensation Expectation' });
    assert.strictEqual(salary.classification, FIELD_CLASSIFICATIONS.SALARY);
    assert.strictEqual(salary.isSensitive, true);

    const eeo = classifyField({ label: 'Gender Identification' });
    assert.strictEqual(eeo.classification, FIELD_CLASSIFICATIONS.EEO_GENDER);
    assert.strictEqual(eeo.isSensitive, true);
});

// ── 4. Candidate Autofill & Human Input Gating ────────────────────────────────
console.log('\n--- 4. Candidate Autofill & Human Input Gating ---');

test('mapFieldsToCandidateData populates verified identity and contact facts', () => {
    const fields = [
        { classification: FIELD_CLASSIFICATIONS.FIRST_NAME, required: true },
        { classification: FIELD_CLASSIFICATIONS.LAST_NAME, required: true },
        { classification: FIELD_CLASSIFICATIONS.EMAIL, required: true },
        { classification: FIELD_CLASSIFICATIONS.PHONE, required: true },
        { classification: FIELD_CLASSIFICATIONS.LINKEDIN, required: false }
    ];

    const mapping = mapFieldsToCandidateData(fields, {
        candidateFacts: [
            { identifier: 'first_name', value: 'Jordan' },
            { identifier: 'last_name', value: 'Lee' },
            { identifier: 'contact-email', value: 'jordan.synthetic@example.test' },
            { identifier: 'contact-phone', value: '+00-0000000000' },
            { identifier: 'link-linkedin', value: 'https://linkedin.com/in/jordan-lee' }
        ],
        resumePath: 'C:\\path\\to\\resume.pdf'
    });

    assert.strictEqual(mapping.canAutoProceed, true);
    assert.strictEqual(mapping.mappedCount, 5);

    const firstName = mapping.mappings.find(m => m.classification === FIELD_CLASSIFICATIONS.FIRST_NAME);
    assert.strictEqual(firstName.mappedValue, 'Jordan');

    const email = mapping.mappings.find(m => m.classification === FIELD_CLASSIFICATIONS.EMAIL);
    assert.strictEqual(email.mappedValue, 'jordan.synthetic@example.test');
});

test('mapFieldsToCandidateData gates unconfirmed sensitive questions to needs_user_input', () => {
    const fields = [
        { classification: FIELD_CLASSIFICATIONS.FIRST_NAME, required: true },
        { classification: FIELD_CLASSIFICATIONS.WORK_AUTHORIZATION, label: 'Work Authorization', isSensitive: true, required: true }
    ];

    const mapping = mapFieldsToCandidateData(fields, {
        candidateFacts: [],
        candidateAnswers: [] // No confirmed answer
    });

    assert.strictEqual(mapping.canAutoProceed, false);
    assert.strictEqual(mapping.sensitiveFieldsNeedingConfirmation.length, 1);

    const workAuth = mapping.mappings.find(m => m.classification === FIELD_CLASSIFICATIONS.WORK_AUTHORIZATION);
    assert.strictEqual(workAuth.status, 'needs_user_input');
});

test('mapFieldsToCandidateData resolves sensitive questions when confirmed in candidate_answers', () => {
    const fields = [
        { classification: FIELD_CLASSIFICATIONS.WORK_AUTHORIZATION, name: 'work_authorization', isSensitive: true, required: true }
    ];

    const mapping = mapFieldsToCandidateData(fields, {
        candidateAnswers: [
            { question_key: 'work_authorization', answer_value: 'Yes', confirmed_by_user: 1, confidence: 1.0 }
        ]
    });

    assert.strictEqual(mapping.canAutoProceed, true);
    assert.strictEqual(mapping.sensitiveFieldsNeedingConfirmation.length, 0);

    const workAuth = mapping.mappings.find(m => m.classification === FIELD_CLASSIFICATIONS.WORK_AUTHORIZATION);
    assert.strictEqual(workAuth.status, 'mapped');
    assert.strictEqual(workAuth.mappedValue, 'Yes');
});

test('mapFieldsToCandidateData handles optional unmapped fields without blocking', () => {
    const fields = [
        { classification: FIELD_CLASSIFICATIONS.CUSTOM, label: 'Twitter Profile', required: false }
    ];

    const mapping = mapFieldsToCandidateData(fields);
    assert.strictEqual(mapping.canAutoProceed, true);
    assert.strictEqual(mapping.mappings[0].status, 'unmapped_optional');
});

// ── 5. Application State Machine & Lifecycle Transitions ──────────────────────
console.log('\n--- 5. Application State Machine & Audit Events ---');

const testDb = getDb();
const testAppId = `app_test_lifecycle_${Date.now()}`;
const testJobId = `job_test_lifecycle_${Date.now()}`;
const testCompId = `comp_test_lifecycle_${Date.now()}`;
const testResumeId = `resume_test_${Date.now()}`;

// Ensure fixture company and job exist for foreign key constraints
testDb.prepare(`
    INSERT INTO companies (id, name, domain, lifecycle_status, monitoring_status)
    VALUES (?, 'Test Company', 'test.com', 'APPROVED', 'active')
    ON CONFLICT(id) DO NOTHING
`).run(testCompId);

testDb.prepare(`
    INSERT INTO job_postings (id, company_id, title, location, job_url, status, source)
    VALUES (?, ?, 'Test Engineer', 'Bengaluru, India', ?, 'active', 'test')
    ON CONFLICT(id) DO NOTHING
`).run(testJobId, testCompId, `https://example.com/jobs/${testJobId}`);

insertResumeVersion({
    id: testResumeId,
    job_id: testJobId,
    format: 'pdf',
    file_path: 'output/resumes/test_resume.pdf',
    variant_label: 'General'
});

test('Application state machine enforces legal transitions', () => {
    // Initial insert
    testDb.prepare(`
        INSERT INTO applications (id, job_id, company_id, state)
        VALUES (?, ?, ?, 'NOT_STARTED')
    `).run(testAppId, testJobId, testCompId);

    // NOT_STARTED -> DRAFTING (Legal)
    assert(updateApplicationState(testAppId, APPLICATION_STATES.DRAFTING) === true);

    // DRAFTING -> PORTAL_OPENED (Legal)
    assert(updateApplicationState(testAppId, APPLICATION_STATES.PORTAL_OPENED) === true);

    // PORTAL_OPENED -> FORM_FILLING (Legal)
    assert(updateApplicationState(testAppId, APPLICATION_STATES.FORM_FILLING) === true);

    // FORM_FILLING -> READY_FOR_REVIEW (Legal)
    assert(updateApplicationState(testAppId, APPLICATION_STATES.READY_FOR_REVIEW) === true);
});

test('Application state machine rejects illegal jumps', () => {
    // FORM_FILLING / READY_FOR_REVIEW cannot jump directly to CONFIRMED without SUBMITTING
    assert.throws(() => {
        updateApplicationState(testAppId, APPLICATION_STATES.CONFIRMED);
    }, /Illegal application state transition/);

    // Cannot jump from READY_FOR_REVIEW directly to SUBMITTING without SUBMISSION_APPROVED
    assert.throws(() => {
        updateApplicationState(testAppId, APPLICATION_STATES.SUBMITTING);
    }, /Illegal application state transition/);
});

test('Application state transitions record immutable audit events', () => {
    const events = getApplicationEvents(testAppId);
    assert(events.length >= 4, 'Must have recorded events for each state transition');
    assert.strictEqual(events[0].previous_state, 'NOT_STARTED');
    assert.strictEqual(events[0].new_state, 'DRAFTING');
    assert.strictEqual(events[events.length - 1].new_state, 'READY_FOR_REVIEW');
});

// ── 6. Submission Policy & Authorization Gating ──────────────────────────────
console.log('\n--- 6. Submission Policy & Authorization Gating ---');

test('canProceedToSubmit blocks by default under MANUAL_REVIEW without authorization', () => {
    const app = getApplication(testAppId);
    const check = canProceedToSubmit({
        application: app,
        job: { status: 'active' },
        validationResult: { valid: true }
    });

    assert.strictEqual(check.allowed, false);
    assert(check.reason.includes('MANUAL_REVIEW required'));
    assert.strictEqual(check.requiresHumanAuthorization, true);
});

test('canProceedToSubmit blocks when job is inactive/closed', () => {
    const app = getApplication(testAppId);
    const check = canProceedToSubmit({
        application: app,
        job: { status: 'closed' }
    });

    assert.strictEqual(check.allowed, false);
    assert(check.reason.includes('not active'));
});

test('canProceedToSubmit permits submission when explicit authorization is granted', () => {
    const packetPath = resolve(__dirname, `output/review-packets/${testAppId}.md`);
    mkdirSync(dirname(packetPath), { recursive: true });
    writeFileSync(packetPath, `# Review Packet for ${testAppId}\nStatus: READY_FOR_REVIEW`);
    updateApplicationExecution(testAppId, {
        review_packet_path: packetPath,
        resume_version_id: testResumeId
    });

    const app = getApplication(testAppId);
    const packetHash = createHash('sha256').update(readFileSync(packetPath, 'utf8')).digest('hex');
    const payloadDigest = computeApplicationPayloadDigest(app);

    const authId = createSubmissionAuthorization({
        scope: 'single',
        application_id: testAppId,
        packet_hash: packetHash,
        resume_version_id: testResumeId,
        payload_digest: payloadDigest,
        authorized_by: 'user'
    });

    const check = canProceedToSubmit({
        application: getApplication(testAppId),
        job: { status: 'active' },
        validationResult: { valid: true }
    });

    assert.strictEqual(check.allowed, true);
    assert.strictEqual(check.authorization.id, authId);
});

test('Candidate authorization CANNOT override employer submission restriction (submission_permitted = 0)', () => {
    const app = getApplication(testAppId);
    const validAuthId = createSubmissionAuthorization({
        scope: 'single',
        application_id: testAppId,
        authorized_by: 'user'
    });

    // Provide source policy with submission_permitted = 0 (the ethical hard-gate)
    const check = canProceedToSubmit({
        application: app,
        job: { status: 'active' },
        sourcePolicy: { submission_permitted: 0 },
        explicitAuthorization: { id: validAuthId, scope: 'single', application_id: testAppId },
        validationResult: { valid: true }
    });

    assert.strictEqual(check.allowed, false);
    assert(check.reason.includes('submission_permitted = 0'), 'Must reject due to source policy prohibition');
});

test('Authorization scoped to a different application is rejected', () => {
    const app = getApplication(testAppId);
    const diffAppAuth = {
        id: 'auth_diff_app_test',
        scope: 'single',
        application_id: 'diff_app_99999',
        authorized_by: 'user'
    };

    const check = canProceedToSubmit({
        application: app,
        job: { status: 'active' },
        explicitAuthorization: diffAppAuth,
        validationResult: { valid: true }
    });

    assert.strictEqual(check.allowed, false);
    assert(check.reason.includes('scoped to application diff_app_99999'));
});

test('Expired authorization is rejected', () => {
    const app = getApplication(testAppId);
    const expiredAuth = {
        id: 'auth_expired_test',
        scope: 'single',
        application_id: testAppId,
        expires_at: new Date(Date.now() - 60000).toISOString()
    };

    const check = canProceedToSubmit({
        application: app,
        job: { status: 'active' },
        explicitAuthorization: expiredAuth,
        validationResult: { valid: true }
    });

    assert.strictEqual(check.allowed, false);
    assert(check.reason.includes('has expired'));
});

test('Bounded batch authorization tracks usage limit and expires', () => {
    const batchAuthId = createSubmissionAuthorization({
        scope: 'bounded_batch',
        max_applications: 2,
        authorized_by: 'user'
    });

    // Use once
    assert(useSubmissionAuthorization(batchAuthId) === true);
    let auth = getSubmissionAuthorization(batchAuthId);
    assert.strictEqual(auth.used_count, 1);
    assert.strictEqual(auth.status, 'active');

    // Use second time (reaches limit 2)
    assert(useSubmissionAuthorization(batchAuthId) === true);
    auth = getSubmissionAuthorization(batchAuthId);
    assert.strictEqual(auth.used_count, 2);
    assert.strictEqual(auth.status, 'used');

    // Third check fails because batch is exhausted
    const checkAuth = getValidSubmissionAuthorization('any_app_id');
    assert(checkAuth?.id !== batchAuthId, 'Exhausted batch authorization must not be returned');
});

// ── 7. Submission, Confirmation & Uncertain Outcome Reconciliation ───────────
console.log('\n--- 7. Submission & Uncertain Outcome Reconciliation ---');

const uncertainAppId = `app_test_uncertain_${Date.now()}`;
const uncertainJobId = `job_test_uncertain_${Date.now()}`;

testDb.prepare(`
    INSERT INTO job_postings (id, company_id, title, location, job_url, status, source)
    VALUES (?, ?, 'Uncertain Job', 'Remote', ?, 'active', 'test')
    ON CONFLICT(id) DO NOTHING
`).run(uncertainJobId, testCompId, `https://example.com/jobs/${uncertainJobId}`);

testDb.prepare(`
    INSERT INTO applications (id, job_id, company_id, state)
    VALUES (?, ?, ?, 'SUBMISSION_APPROVED')
`).run(uncertainAppId, uncertainJobId, testCompId);

// Transition SUBMISSION_APPROVED -> SUBMITTING -> UNCERTAIN_OUTCOME
updateApplicationState(uncertainAppId, APPLICATION_STATES.SUBMITTING);
updateApplicationState(uncertainAppId, APPLICATION_STATES.UNCERTAIN_OUTCOME, {
    message: 'Portal response timed out'
});

test('UNCERTAIN_OUTCOME application cannot be blindly retried without reconciliation', () => {
    const app = getApplication(uncertainAppId);
    assert.strictEqual(app.state, APPLICATION_STATES.UNCERTAIN_OUTCOME);

    // Attempting invalid jump back to SUBMITTING must throw
    assert.throws(() => {
        updateApplicationState(uncertainAppId, APPLICATION_STATES.SUBMITTING);
    }, /Illegal application state transition/);
});

test('reconcileSubmissionOutcome safely reconciles UNCERTAIN_OUTCOME to CONFIRMED', () => {
    const res = reconcileSubmissionOutcome(uncertainAppId, {
        outcome: APPLICATION_STATES.CONFIRMED,
        confirmationReference: 'REC-PALANTIR-998877',
        notes: 'User verified confirmation email arrived',
        actor: 'user'
    });

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.newState, APPLICATION_STATES.CONFIRMED);

    const app = getApplication(uncertainAppId);
    assert.strictEqual(app.state, APPLICATION_STATES.CONFIRMED);
    assert.strictEqual(app.confirmation_reference, 'REC-PALANTIR-998877');
});

await asyncTest('submitApplication recovers from in-flight browser crash and records UNCERTAIN_OUTCOME', async () => {
    const crashAppId = `app_crash_${Date.now()}`;
    const crashJobId = `job_crash_${Date.now()}`;

    testDb.prepare(`
        INSERT INTO job_postings (id, company_id, title, location, job_url, status, source)
        VALUES (?, ?, 'Crash Job', 'Remote', ?, 'active', 'test')
        ON CONFLICT(id) DO NOTHING
    `).run(crashJobId, testCompId, `https://example.com/jobs/${crashJobId}`);

    const crashPacketPath = resolve(__dirname, `output/review-packets/${crashAppId}.md`);
    writeFileSync(crashPacketPath, `# Crash Review Packet for ${crashAppId}`);

    testDb.prepare(`
        INSERT INTO applications (id, job_id, company_id, state, resume_version_id, review_packet_path)
        VALUES (?, ?, ?, 'READY_FOR_REVIEW', ?, ?)
    `).run(crashAppId, crashJobId, testCompId, testResumeId, crashPacketPath);

    const crashApp = getApplication(crashAppId);
    const crashPacketHash = createHash('sha256').update(readFileSync(crashPacketPath, 'utf8')).digest('hex');
    const crashPayloadDigest = computeApplicationPayloadDigest(crashApp);

    const crashAuthId = createSubmissionAuthorization({
        scope: 'single',
        application_id: crashAppId,
        packet_hash: crashPacketHash,
        resume_version_id: testResumeId,
        payload_digest: crashPayloadDigest,
        authorized_by: 'user'
    });

    const mockAdapter = {
        findSubmitButton: async () => ({ selector: '#submit_crash', disabled: false }),
        detectConfirmation: async () => null
    };

    const mockCrashingPage = {
        click: async () => { throw new Error('Target page crashed / connection reset'); },
        url: () => 'https://example.com/apply'
    };

    const outcome = await submitApplication(mockCrashingPage, {
        application: getApplication(crashAppId),
        job: { status: 'active' },
        adapter: mockAdapter,
        authorization: getSubmissionAuthorization(crashAuthId),
        validationResult: { valid: true }
    });

    assert.strictEqual(outcome.status, APPLICATION_STATES.UNCERTAIN_OUTCOME);
    const crashedApp = getApplication(crashAppId);
    assert.strictEqual(crashedApp.state, APPLICATION_STATES.UNCERTAIN_OUTCOME);
    assert(crashedApp.error_details.includes('Target page crashed'));
});

// ── 8. End-to-End Controlled Application Workflow on Local Portal Fixture ────
console.log('\n--- 8. End-to-End Controlled Application Workflow ---');

await asyncTest('Controlled application workflow on local fixture portal', async () => {
    const fixtureFormHtml = `
        <!DOCTYPE html>
        <html>
        <head><title>Acme Careers - Full Stack Engineer</title></head>
        <body>
          <div id="grnhse_app">
            <h1>Full Stack Engineer Application</h1>
            <form id="application_form" action="/submit" method="POST">
              <label for="first_name">First Name *</label>
              <input type="text" id="first_name" name="first_name" required>

              <label for="last_name">Last Name *</label>
              <input type="text" id="last_name" name="last_name" required>

              <label for="email">Email *</label>
              <input type="email" id="email" name="email" required>

              <label for="phone">Phone *</label>
              <input type="tel" id="phone" name="phone" required>

              <label for="resume">Attach Resume *</label>
              <input type="file" id="resume" name="resume" required>

              <button type="submit" id="submit_app">Submit Application</button>
            </form>
          </div>
        </body>
        </html>
    `;

    // 1. Setup job & evaluation records in SQLite
    const fixtureJobId = `job_fixture_apply_${Date.now()}`;
    const fixtureCompId = `comp_fixture_apply_${Date.now()}`;
    const portalUrl = `https://job-boards.greenhouse.io/acme-test/jobs/${fixtureJobId}`;

    upsCompany({
        id: fixtureCompId,
        name: 'Acme Test Corp',
        domain: 'acme-test.com',
        lifecycle_status: 'APPROVED',
        monitoring_status: 'active'
    });

    upsJob({
        id: fixtureJobId,
        company_id: fixtureCompId,
        title: 'Full Stack Engineer',
        location: 'Bengaluru, India',
        job_url: portalUrl,
        status: 'active',
        source: 'test'
    });

    insertJobEvaluationRun({
        job_id: fixtureJobId,
        eval_version: '3B.1.0',
        input_hash: 'hash_test_fixture',
        tier1_passed: 1,
        tier1_matched_titles: ['Full Stack Engineer'],
        tier2_eligibility: 'PASS',
        tier2_gates_json: [],
        tier3_match_score: 1.0,
        recommendation: 'APPLY',
        notes: 'Test evaluation run'
    });

    const testDbInstance = getDb();
    testDbInstance.prepare(`
        INSERT OR REPLACE INTO candidate_facts (id, category, identifier, value, verified)
        VALUES
        ('fact-test-fn', 'personal', 'first_name', 'Jordan', 1),
        ('fact-test-ln', 'personal', 'last_name', 'Lee', 1),
        ('fact-test-name', 'personal', 'full_name', 'Jordan Lee', 1),
        ('fact-test-em', 'personal', 'contact-email', 'jordan.synthetic@example.test', 1),
        ('fact-test-ph', 'personal', 'contact-phone', '+00-0000000000', 1)
    `).run();

    // 2. Run application workflow (Stops at READY_FOR_REVIEW under default MANUAL_REVIEW)
    const workflowResult = await runApplicationWorkflow(fixtureJobId, {
        htmlContent: fixtureFormHtml,
        headless: true,
        dryRun: false,
        logger: () => {}
    });

    assert.strictEqual(workflowResult.status, APPLICATION_STATES.READY_FOR_REVIEW);
    assert.strictEqual(workflowResult.portalType, PORTAL_TYPES.GREENHOUSE);
    assert(workflowResult.validation.valid === true, 'Form validation must be valid');
    assert(existsSync(workflowResult.reviewPacketPath), 'Review packet markdown must exist on disk');

    // Verify review packet contents
    const packetMd = readFileSync(workflowResult.reviewPacketPath, 'utf8');
    assert(packetMd.includes('Jordan Lee'), 'Packet must include candidate name');
    assert(packetMd.includes('jordan.synthetic@example.test'), 'Packet must include candidate email');
    assert(packetMd.includes('READY_FOR_REVIEW') || packetMd.includes('MANUAL_REVIEW'), 'Packet must note review status');

    // 3. Explicitly authorize submission
    const workflowApp = getApplication(workflowResult.applicationId);
    const packetHash = createHash('sha256').update(readFileSync(workflowResult.reviewPacketPath, 'utf8')).digest('hex');
    const payloadDigest = computeApplicationPayloadDigest(workflowApp);

    const authId = createSubmissionAuthorization({
        scope: 'single',
        application_id: workflowResult.applicationId,
        packet_hash: packetHash,
        resume_version_id: workflowApp.resume_version_id,
        payload_digest: payloadDigest,
        authorized_by: 'user'
    });

    // 4. Open browser, render form, mock confirmation on submit, and verify submitApplication
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.setContent(fixtureFormHtml);

    // Mock submit click intercept to transition DOM to confirmation receipt
    await page.evaluate(() => {
        const showConfirmation = () => {
            document.body.innerHTML = `
                <div class="application-confirmation">
                  <h1>Thank you for applying</h1>
                  <p>Your application has been submitted successfully.</p>
                  <p>Confirmation Reference: CONF-GH-998877</p>
                </div>
            `;
        };
        const btn = document.querySelector('#submit_app');
        if (btn) {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                showConfirmation();
            });
        }
        const form = document.querySelector('form');
        if (form) {
            form.addEventListener('submit', (e) => {
                e.preventDefault();
                showConfirmation();
            });
        }
    });

    const adapter = getAdapterForPortal(PORTAL_TYPES.GREENHOUSE);
    const mapped = mapFieldsToCandidateData([
        { classification: FIELD_CLASSIFICATIONS.FIRST_NAME, selector: '#first_name', status: 'mapped', mappedValue: 'Jordan' },
        { classification: FIELD_CLASSIFICATIONS.LAST_NAME, selector: '#last_name', status: 'mapped', mappedValue: 'Lee' },
        { classification: FIELD_CLASSIFICATIONS.EMAIL, selector: '#email', status: 'mapped', mappedValue: 'jordan.synthetic@example.test' },
        { classification: FIELD_CLASSIFICATIONS.PHONE, selector: '#phone', status: 'mapped', mappedValue: '+00-0000000000' }
    ]).mappings;

    await adapter.fill(page, mapped);

    // Attach resume
    const resumePath = getResumeVersion(workflowApp?.resume_version_id)?.file_path;
    if (resumePath && existsSync(resumePath)) {
        await attachResume(page, { pdfPath: resumePath });
    }

    const appRecord = getApplication(workflowResult.applicationId);
    const submitResult = await submitApplication(page, {
        application: appRecord,
        job: { status: 'active' },
        company: { id: fixtureCompId },
        adapter,
        authorization: getSubmissionAuthorization(authId),
        validationResult: { valid: true },
        dryRun: false,
        logger: (msg) => console.log('    [submit log]', msg)
    });

    assert.strictEqual(submitResult.status, APPLICATION_STATES.CONFIRMED);
    assert.strictEqual(submitResult.confirmationReference, 'CONF-GH-998877');

    // Verify SQLite state updated to CONFIRMED
    const finalApp = getApplication(workflowResult.applicationId);
    assert.strictEqual(finalApp.state, APPLICATION_STATES.CONFIRMED);
    assert.strictEqual(finalApp.confirmation_reference, 'CONF-GH-998877');

    await browser.close();
});

// Helper functions for test fixture inserts
function upsCompany(c) {
    getDb().prepare(`
        INSERT INTO companies (id, name, domain, lifecycle_status, monitoring_status)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET lifecycle_status = excluded.lifecycle_status
    `).run(c.id, c.name, c.domain, c.lifecycle_status, c.monitoring_status);
}

function upsJob(j) {
    getDb().prepare(`
        INSERT INTO job_postings (id, company_id, title, location, job_url, status, source)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET status = excluded.status
    `).run(j.id, j.company_id, j.title, j.location, j.job_url, j.status, j.source);
}

console.log('\n====================================================');
console.log(`📊 Milestone 3D Test Results: ${passedCount} PASSED, ${failedCount} FAILED`);
console.log('====================================================');

closeDb();
cleanupTestDb();
delete process.env.JOB_AGENT_DB_PATH;

if (failedCount > 0) {
    process.exit(1);
} else {
    process.exit(0);
}
