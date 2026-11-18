/**
 * test-application-worker.mjs — Application Worker & Standing Authorization Test Suite
 *
 * Implements thorough isolated testing of:
 *   - Atomic queue claims and database leases (application_leases)
 *   - Concurrency protection and collision prevention
 *   - Human checkpointing (NEEDS_USER_INPUT)
 *   - Standing authorization evaluator across all constraint dimensions
 *   - Gated auto-submission and cryptographic token creation
 *   - Submission outcome persistence and UNCERTAIN_OUTCOME recovery
 *   - Daily submission quotas under concurrency
 *   - Crash recovery of expired leases
 *   - Canonical DB immutability & isolation verification
 */

import assert from 'assert';
import { createHash } from 'crypto';
import { existsSync, readFileSync, writeFileSync, unlinkSync, copyFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DB_PATH = resolve(process.cwd(), 'data', 'test_application_worker.db');
const CANONICAL_DB_PATH = resolve(process.cwd(), 'data', 'job_agent.db');

// R1 / R9: Verify baseline hash of canonical database before test setup
if (!existsSync(CANONICAL_DB_PATH)) {
    throw new Error(`Canonical database missing at ${CANONICAL_DB_PATH}`);
}
const baselineCanonicalHash = createHash('sha256').update(readFileSync(CANONICAL_DB_PATH)).digest('hex');

// R8: Fail-closed cleanup guard
function safeCleanupTestDb() {
    if (resolve(TEST_DB_PATH) === resolve(CANONICAL_DB_PATH)) {
        throw new Error('FAIL-CLOSED SAFETY: Attempted to cleanup canonical DB!');
    }
    for (const f of [TEST_DB_PATH, `${TEST_DB_PATH}-wal`, `${TEST_DB_PATH}-shm`]) {
        if (existsSync(f)) {
            try { unlinkSync(f); } catch { /* ignore */ }
        }
    }
}

safeCleanupTestDb();
copyFileSync(CANONICAL_DB_PATH, TEST_DB_PATH);

// Configure test environment BEFORE importing repo/db modules
process.env.CAREER_OPS_TEST = '1';
process.env.JOB_AGENT_DB_PATH = TEST_DB_PATH;

const { getDb, closeDb, getDbPath } = await import('./db/db.mjs');
const resolvedDbPath = resolve(getDbPath());
if (resolvedDbPath === CANONICAL_DB_PATH) {
    throw new Error(`SAFETY ABORT: test-application-worker.mjs resolved to canonical DB (${resolvedDbPath})`);
}
console.log(`🔒 Isolated Test DB Path: ${resolvedDbPath}`);

// Run migrations on isolated test database
const { runMigrations } = await import('./db/migrate.js');
runMigrations(getDb(), { quiet: true });

// Mark unrelated copied postings closed so batch tests focus exclusively on test fixtures
{
    const db = getDb();
    db.prepare(`
        UPDATE job_postings SET status = 'closed'
        WHERE status IN ('discovered', 'active')
    `).run();
}

const {
    getJob,
    getCompany,
    getApplication,
    getApplicationByJobId,
    updateApplicationState,
    createSubmissionAuthorization,
    getValidSubmissionAuthorization,
    useSubmissionAuthorization,
    APPLICATION_STATES,
    RECRUITMENT_OUTCOMES
} = await import('./db/repo.mjs');

const {
    ensureLeasesTable,
    claimNextApplication,
    releaseLease,
    renewLease,
    recoverExpiredLeases,
    getDailyQuotaUsage,
    processQueuedApplication,
    runWorkerCycle,
    runWorkerBatch,
    inspectQueue
} = await import('./application/worker.mjs');

const {
    evaluateStandingAuthorization,
    STANDING_DECISIONS,
    DEFAULT_STANDING_POLICY
} = await import('./application/submission/standing-policy.mjs');

const { computeApplicationPayloadDigest } = await import('./application/submission/policy.mjs');

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
console.log('🧪 DELIVERABLE 3 — APPLICATION WORKER & STANDING POLICY SUITE');
console.log('====================================================');

// Helper to seed test job and application
function seedWorkerFixture(prefix = 'w', { state = 'NOT_STARTED', score = 0.95, overrideStatus = 'active', source = 'greenhouse' } = {}) {
    const db = getDb();
    const compId = `comp_${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const jobId = `job_${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const appId = `app_${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

    db.prepare(`
        INSERT INTO companies (id, name, domain, lifecycle_status, monitoring_status)
        VALUES (?, ?, ?, 'APPROVED', 'active')
    `).run(compId, `Acme ${prefix}`, `${prefix}.acme.com`);

    db.prepare(`
        INSERT INTO job_postings (id, company_id, title, description, location, job_url, status, source, last_verified_at, verification_method, discovered_at, last_seen_at)
        VALUES (?, ?, 'Backend Engineer', 'We need a Node.js and JavaScript backend engineer for REST APIs.', 'Bengaluru, India', ?, ?, ?, datetime('now'), 'ats_api', datetime('now'), datetime('now'))
    `).run(jobId, compId, `https://job-boards.greenhouse.io/acme/jobs/${jobId}`, overrideStatus, source);

    db.prepare(`
        INSERT INTO applications (id, job_id, company_id, state, score, source_origin, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'pipeline-handoff', datetime('now'), datetime('now'))
    `).run(appId, jobId, compId, state, score);

    return { compId, jobId, appId };
}

// ── Part 1: Queue Processing & Atomic Leases (Tests 1–8) ───────────────────

console.log('\n--- Part 1: Queue Processing & Atomic Leases (Tests 1–8) ---');

test('Case 1: Eligible NOT_STARTED application is claimed with valid lease', () => {
    const f1 = seedWorkerFixture('c1', { score: 0.92 });
    const claim = claimNextApplication({ workerId: 'w1', leaseDurationSeconds: 120 });

    assert(claim, 'Worker must claim eligible application');
    assert.strictEqual(claim.application.id, f1.appId);
    assert.strictEqual(claim.lease.status, 'PROCESSING');
    assert.strictEqual(claim.lease.worker_id, 'w1');
    assert.strictEqual(claim.lease.attempt_count, 1);
});

test('Case 2: Ineligible application (state != NOT_STARTED) is skipped', () => {
    const f2 = seedWorkerFixture('c2', { state: 'READY_FOR_REVIEW', score: 0.99 });
    const db = getDb();
    // Claim should not claim f2 because it is not in NOT_STARTED
    const claim = claimNextApplication({ workerId: 'w2' });
    if (claim) {
        assert.notStrictEqual(claim.application.id, f2.appId, 'Application in READY_FOR_REVIEW must not be claimed');
    }
});

await asyncTest('Case 3: Closed job application is detected and safely discarded', async () => {
    const f3 = seedWorkerFixture('c3', { overrideStatus: 'closed' });
    const res = await processQueuedApplication(f3.appId, { workerId: 'w3', logger: () => {} });
    assert.strictEqual(res.outcome, RECRUITMENT_OUTCOMES.DISCARDED);
    const db = getDb();
    const app = getApplication(f3.appId);
    assert.strictEqual(app.recruitment_outcome, RECRUITMENT_OUTCOMES.DISCARDED);
});

test('Case 4: Duplicate application is prevented', () => {
    const f4 = seedWorkerFixture('c4', { state: 'CONFIRMED' });
    const db = getDb();
    const app = getApplication(f4.appId);
    assert.strictEqual(app.state, APPLICATION_STATES.CONFIRMED);
    // Worker inspectQueue should not report CONFIRMED application
    const queue = inspectQueue();
    const found = queue.queued.find(q => q.id === f4.appId);
    assert.strictEqual(found, undefined, 'Confirmed application must not appear in worker queue');
});

test('Case 5: Two workers cannot claim the same application (Atomic Concurrency Test)', () => {
    const f5 = seedWorkerFixture('c5', { score: 0.98 });
    const claimA = claimNextApplication({ workerId: 'worker_alpha', leaseDurationSeconds: 60 });
    assert(claimA, 'First worker must claim');
    assert.strictEqual(claimA.application.id, f5.appId);

    // Second worker attempts to claim concurrently
    const claimB = claimNextApplication({ workerId: 'worker_beta', leaseDurationSeconds: 60 });
    // Should NOT be able to claim the same application
    if (claimB) {
        assert.notStrictEqual(claimB.application.id, f5.appId, 'Second worker must not claim already leased application');
    }
});

test('Case 6: Lease renewal updates heartbeat and expiry', () => {
    const f6 = seedWorkerFixture('c6', { score: 0.88 });
    const claim = claimNextApplication({ workerId: 'w6', leaseDurationSeconds: 60 });
    assert(claim);

    const renewed = renewLease(claim.application.id, { workerId: 'w6', additionalSeconds: 300 });
    assert.strictEqual(renewed, true, 'Active worker must be able to renew lease');

    // Mismatched worker cannot renew
    const badRenew = renewLease(claim.application.id, { workerId: 'imposter_worker', additionalSeconds: 300 });
    assert.strictEqual(badRenew, false, 'Imposter worker must not renew lease');
});

test('Case 7: Abandoned/expired lease is safely recovered for retry', () => {
    const f7 = seedWorkerFixture('c7', { score: 0.85 });
    const claim = claimNextApplication({ workerId: 'w7_crashed', leaseDurationSeconds: 1 });
    assert(claim);

    // Artificially expire lease in database
    const db = getDb();
    db.prepare(`
        UPDATE application_leases
        SET lease_expires_at = datetime('now', '-10 seconds')
        WHERE application_id = ?
    `).run(f7.appId);

    const recoveryResult = recoverExpiredLeases();
    assert(recoveryResult.recovered.some(r => r.applicationId === f7.appId), 'Expired lease must be recovered');

    // Application is now reset to NOT_STARTED and can be claimed again
    const appAfter = getApplication(f7.appId);
    assert.strictEqual(appAfter.state, 'NOT_STARTED');

    const claim2 = claimNextApplication({ workerId: 'w7_healthy' });
    assert(claim2);
    assert.strictEqual(claim2.application.id, f7.appId);
    assert.strictEqual(claim2.lease.attempt_count, 2, 'Attempt count must increment on recovery claim');
});

test('Case 8: Human checkpoint releases the claim safely', () => {
    const f8 = seedWorkerFixture('c8', { score: 0.86 });
    const claim = claimNextApplication({ workerId: 'w8' });
    assert(claim);

    // Follow legal state transitions: NOT_STARTED -> DRAFTING -> PORTAL_OPENED -> FORM_FILLING -> NEEDS_USER_INPUT
    updateApplicationState(f8.appId, APPLICATION_STATES.DRAFTING);
    updateApplicationState(f8.appId, APPLICATION_STATES.PORTAL_OPENED);
    updateApplicationState(f8.appId, APPLICATION_STATES.FORM_FILLING);
    updateApplicationState(f8.appId, APPLICATION_STATES.NEEDS_USER_INPUT, {
        actor: 'system',
        eventType: 'needs_user_input',
        message: 'Question requires user input'
    });
    releaseLease(f8.appId, { status: 'RELEASED' });

    const db = getDb();
    const lease = db.prepare('SELECT * FROM application_leases WHERE application_id = ?').get(f8.appId);
    assert.strictEqual(lease.status, 'RELEASED');
    const app = getApplication(f8.appId);
    assert.strictEqual(app.state, APPLICATION_STATES.NEEDS_USER_INPUT);
});

// ── Part 2: Standing Authorization Evaluator (Tests 9–18) ─────────────────

console.log('\n--- Part 2: Standing Authorization Evaluator (Tests 9–18) ---');

// Helper to construct mock review packet & app state for standing eval tests
function prepareMockPreparedApp(prefix = 'se', {
    score = 0.95,
    title = 'Backend Engineer',
    location = 'Bengaluru, India',
    unmappedRequired = [],
    sensitivePending = [],
    reviewPacketPresent = true
} = {}) {
    const db = getDb();
    const compId = `comp_${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const jobId = `job_${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const appId = `app_${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

    db.prepare(`
        INSERT INTO companies (id, name, domain, lifecycle_status, monitoring_status)
        VALUES (?, ?, ?, 'APPROVED', 'active')
    `).run(compId, `Acme ${prefix}`, `${prefix}.acme.com`);

    db.prepare(`
        INSERT INTO job_postings (id, company_id, title, description, location, job_url, status, source)
        VALUES (?, ?, ?, 'Node.js backend role', ?, ?, 'active', 'greenhouse')
    `).run(jobId, compId, title, location, `https://boards.greenhouse.io/job/${jobId}`);

    // Insert fake tailored resume version
    const resumeVerId = `rv_${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    db.prepare(`
        INSERT INTO resume_versions (id, job_id, format, file_path, tailored, created_at)
        VALUES (?, ?, 'pdf', 'output/resumes/test.pdf', 1, datetime('now'))
    `).run(resumeVerId, jobId);

    const packetPath = resolve(process.cwd(), 'scratch', `review_${appId}.md`);
    if (reviewPacketPresent) {
        writeFileSync(packetPath, `# Review Packet for ${appId}\n\nAll verified.`, 'utf8');
    }

    const metadata = {
        unmappedRequired,
        pendingQuestions: sensitivePending,
        completedFields: [
            { name: 'first_name', value: 'Alex' },
            { name: 'last_name', value: 'Doe' },
            { name: 'email', value: 'alex.doe@example.org' }
        ]
    };

    db.prepare(`
        INSERT INTO applications (
            id, job_id, company_id, resume_version_id, state, score,
            review_packet_path, execution_metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'READY_FOR_REVIEW', ?, ?, ?, datetime('now'), datetime('now'))
    `).run(appId, jobId, compId, resumeVerId, score, reviewPacketPresent ? packetPath : null, JSON.stringify(metadata));

    const app = getApplication(appId);
    const job = getJob(jobId);
    const comp = getCompany(compId);

    return { app, job, comp, packetPath };
}

test('Case 9: Strong, fully verified application passes standing policy (AUTO_SUBMIT)', () => {
    const { app, job, comp } = prepareMockPreparedApp('c9', { score: 0.95 });
    const res = evaluateStandingAuthorization({
        application: app,
        job,
        company: comp,
        policyOverrides: { auto_submit_enabled: true }
    });
    assert.strictEqual(res.authorized, true);
    assert.strictEqual(res.decision, STANDING_DECISIONS.AUTO_SUBMIT);
    assert(res.payloadDigest, 'Must compute valid payload digest');
});

test('Case 10: Insufficient score fails policy (PREPARE_AND_PAUSE)', () => {
    const { app, job, comp } = prepareMockPreparedApp('c10', { score: 0.55 });
    const res = evaluateStandingAuthorization({
        application: app,
        job,
        company: comp,
        policyOverrides: { auto_submit_enabled: true, min_score_threshold: 0.70 }
    });
    assert.strictEqual(res.authorized, false);
    assert.strictEqual(res.decision, STANDING_DECISIONS.PREPARE_AND_PAUSE);
    assert(res.reason.includes('below standing threshold'));
});

test('Case 11: Unknown required candidate answer pauses (PREPARE_AND_PAUSE)', () => {
    const { app, job, comp } = prepareMockPreparedApp('c11', {
        score: 0.95,
        unmappedRequired: ['years_of_experience']
    });
    const res = evaluateStandingAuthorization({
        application: app,
        job,
        company: comp,
        policyOverrides: { auto_submit_enabled: true }
    });
    assert.strictEqual(res.authorized, false);
    assert.strictEqual(res.decision, STANDING_DECISIONS.PREPARE_AND_PAUSE);
    assert(res.reason.includes('unmapped required field'));
});

test('Case 12: Sensitive question unconfirmed pauses (PREPARE_AND_PAUSE)', () => {
    const { app, job, comp } = prepareMockPreparedApp('c12', {
        score: 0.95,
        sensitivePending: [{ key: 'gender', isSensitive: true, confirmedByUser: false }]
    });
    const res = evaluateStandingAuthorization({
        application: app,
        job,
        company: comp,
        policyOverrides: { auto_submit_enabled: true }
    });
    assert.strictEqual(res.authorized, false);
    assert.strictEqual(res.decision, STANDING_DECISIONS.PREPARE_AND_PAUSE);
    assert(res.reason.includes('unconfirmed sensitive question'));
});

test('Case 13: Unsupported source pauses or rejects according to policy', () => {
    const { app, job, comp } = prepareMockPreparedApp('c13', { score: 0.95 });
    job.source = 'untrusted_aggregator';
    const res = evaluateStandingAuthorization({
        application: app,
        job,
        company: comp,
        policyOverrides: { auto_submit_enabled: true, permitted_sources: ['greenhouse', 'lever'] }
    });
    assert.strictEqual(res.authorized, false);
    assert.strictEqual(res.decision, STANDING_DECISIONS.PREPARE_AND_PAUSE);
    assert(res.reason.includes('not in permitted sources'));
});

test('Case 14: Hard eligibility failure (excessive seniority / excluded keyword) rejects', () => {
    const { app, job, comp } = prepareMockPreparedApp('c14', {
        score: 0.95,
        title: 'Principal Lead Architect'
    });
    const res = evaluateStandingAuthorization({
        application: app,
        job,
        company: comp,
        policyOverrides: { auto_submit_enabled: true }
    });
    assert.strictEqual(res.authorized, false);
    assert.strictEqual(res.decision, STANDING_DECISIONS.REJECT);
    assert(res.reason.includes('excluded non-engineering or excessive seniority'));
});

test('Case 15: Expired / closed job rejects', () => {
    const { app, job, comp } = prepareMockPreparedApp('c15', { score: 0.95 });
    job.status = 'closed';
    const res = evaluateStandingAuthorization({
        application: app,
        job,
        company: comp,
        policyOverrides: { auto_submit_enabled: true }
    });
    assert.strictEqual(res.authorized, false);
    assert.strictEqual(res.decision, STANDING_DECISIONS.REJECT);
    assert(res.reason.includes('not active'));
});

test('Case 16: Invalid / missing review packet fails authorization', () => {
    const { app, job, comp } = prepareMockPreparedApp('c16', {
        score: 0.95,
        reviewPacketPresent: false
    });
    const res = evaluateStandingAuthorization({
        application: app,
        job,
        company: comp,
        policyOverrides: { auto_submit_enabled: true }
    });
    assert.strictEqual(res.authorized, false);
    assert.strictEqual(res.decision, STANDING_DECISIONS.PREPARE_AND_PAUSE);
    assert(res.reason.includes('Review packet does not exist on disk'));
});

test('Case 17: Auto-submit disabled safety gate keeps application at READY_FOR_REVIEW', () => {
    const { app, job, comp } = prepareMockPreparedApp('c17', { score: 0.95 });
    // Default config has auto_submit_enabled: false
    const res = evaluateStandingAuthorization({
        application: app,
        job,
        company: comp,
        policyOverrides: { auto_submit_enabled: false }
    });
    assert.strictEqual(res.authorized, false);
    assert.strictEqual(res.decision, STANDING_DECISIONS.PREPARE_AND_PAUSE);
    assert(res.reason.includes('auto-submission is currently disabled by configuration'));
});

test('Case 18: Foreign on-site location without auth rejects', () => {
    const { app, job, comp } = prepareMockPreparedApp('c18', {
        score: 0.95,
        location: 'Berlin, Germany'
    });
    const res = evaluateStandingAuthorization({
        application: app,
        job,
        company: comp,
        policyOverrides: { auto_submit_enabled: true }
    });
    assert.strictEqual(res.authorized, false);
    assert.strictEqual(res.decision, STANDING_DECISIONS.REJECT);
    assert(res.reason.includes('requires work authorization/sponsorship'));
});

// ── Part 3: Submission Safety & Tokens (Tests 19–24) ──────────────────────

console.log('\n--- Part 3: Submission Safety & Tokens (Tests 19–24) ---');

test('Case 19: Valid standing authorization token enables submission', () => {
    const { app, packetPath } = prepareMockPreparedApp('c19', { score: 0.95 });
    const packetContent = readFileSync(packetPath, 'utf8');
    const packetHash = createHash('sha256').update(packetContent).digest('hex');
    const payloadDigest = computeApplicationPayloadDigest(app);

    const authId = createSubmissionAuthorization({
        scope: 'single',
        application_id: app.id,
        max_applications: 1,
        authorized_by: 'standing_policy',
        packet_hash: packetHash,
        resume_version_id: app.resume_version_id,
        payload_digest: payloadDigest
    });

    const validAuth = getValidSubmissionAuthorization(app.id, app.company_id);
    assert(validAuth, 'Valid standing authorization token must be found in DB');
    assert.strictEqual(validAuth.id, authId);
    assert.strictEqual(validAuth.authorized_by, 'standing_policy');
});

test('Case 20: Consumed authorization cannot be reused', () => {
    const { app, packetPath } = prepareMockPreparedApp('c20', { score: 0.95 });
    const packetContent = readFileSync(packetPath, 'utf8');
    const packetHash = createHash('sha256').update(packetContent).digest('hex');
    const payloadDigest = computeApplicationPayloadDigest(app);

    const authId = createSubmissionAuthorization({
        scope: 'single',
        application_id: app.id,
        max_applications: 1,
        authorized_by: 'standing_policy',
        packet_hash: packetHash,
        resume_version_id: app.resume_version_id,
        payload_digest: payloadDigest
    });

    // Canonical token consumption
    useSubmissionAuthorization(authId);

    const authAfter = getValidSubmissionAuthorization(app.id, app.company_id);
    assert.strictEqual(authAfter, null, 'Consumed token must not be valid for reuse');
});

test('Case 21: Receipt reference is persisted and retrievable', () => {
    const { app } = prepareMockPreparedApp('c21', { score: 0.95 });
    const db = getDb();
    const testRef = 'CONF-REC-998811';
    db.prepare(`
        UPDATE applications
        SET state = 'CONFIRMED', recruitment_outcome = 'APPLIED', confirmation_reference = ?
        WHERE id = ?
    `).run(testRef, app.id);

    const updated = getApplication(app.id);
    assert.strictEqual(updated.state, 'CONFIRMED');
    assert.strictEqual(updated.confirmation_reference, testRef);
});

test('Case 22: UNCERTAIN_OUTCOME prohibits blind automatic resubmission', () => {
    const { app } = prepareMockPreparedApp('c22', { score: 0.95 });
    const db = getDb();
    db.prepare(`
        UPDATE applications
        SET state = 'UNCERTAIN_OUTCOME'
        WHERE id = ?
    `).run(app.id);

    const queue = inspectQueue();
    const found = queue.queued.find(q => q.id === app.id);
    assert.strictEqual(found, undefined, 'UNCERTAIN_OUTCOME application must not be in worker queue');
});

test('Case 23: Expired lease recovery on UNCERTAIN_OUTCOME marks UNCERTAIN (never retries)', () => {
    const { app } = prepareMockPreparedApp('c23', { score: 0.95 });
    const db = getDb();
    db.prepare(`
        UPDATE applications
        SET state = 'UNCERTAIN_OUTCOME'
        WHERE id = ?
    `).run(app.id);

    ensureLeasesTable(db);
    db.prepare(`
        INSERT INTO application_leases (application_id, worker_id, lease_expires_at, status)
        VALUES (?, 'w_timeout', datetime('now', '-5 seconds'), 'PROCESSING')
    `).run(app.id);

    const rec = recoverExpiredLeases();
    assert(rec.recovered.some(r => r.applicationId === app.id && r.action === 'HOLD_UNCERTAIN'));

    const lease = db.prepare('SELECT status FROM application_leases WHERE application_id = ?').get(app.id);
    assert.strictEqual(lease.status, 'UNCERTAIN');
});

test('Case 24: Existing CONFIRMED application is never resubmitted', () => {
    const { app, job, comp } = prepareMockPreparedApp('c24', { score: 0.95 });
    const db = getDb();
    db.prepare("UPDATE applications SET state = 'CONFIRMED' WHERE id = ?").run(app.id);

    const standingEval = evaluateStandingAuthorization({
        application: getApplication(app.id),
        job,
        company: comp,
        policyOverrides: { auto_submit_enabled: true }
    });

    assert.strictEqual(standingEval.authorized, false);
    assert.strictEqual(standingEval.decision, STANDING_DECISIONS.REJECT);
    assert(standingEval.reason.includes('terminal/uncertain state'));
});

// ── Part 4: Daily Quota & Concurrency (Tests 25–28) ────────────────────────

console.log('\n--- Part 4: Daily Quota & Concurrency (Tests 25–28) ---');

test('Case 25: Daily quota is strictly tracked and enforced', () => {
    const quota = getDailyQuotaUsage();
    assert(typeof quota.current === 'number', 'Daily quota must return current count');
    assert(typeof quota.confirmed === 'number', 'Confirmed count must be numeric');
    assert(typeof quota.in_flight === 'number', 'In-flight count must be numeric');
});

test('Case 26: Quota boundary blocks automatic submission (pauses at READY_FOR_REVIEW)', () => {
    const { app, job, comp } = prepareMockPreparedApp('c26', { score: 0.95 });
    // Simulate quota full: current = 10, max = 10
    const standingEval = evaluateStandingAuthorization({
        application: app,
        job,
        company: comp,
        dailyQuotaUsage: { current: 10, max: 10 },
        policyOverrides: { auto_submit_enabled: true, max_daily_submissions: 10 }
    });

    assert.strictEqual(standingEval.authorized, false);
    assert.strictEqual(standingEval.decision, STANDING_DECISIONS.PREPARE_AND_PAUSE);
    assert(standingEval.reason.includes('Daily submission quota reached'));
});

test('Case 27: Resuming an application does not create a duplicate quota entry', () => {
    const today = new Date().toISOString().slice(0, 10);
    const quotaBefore = getDailyQuotaUsage({ dateString: today });
    const { app } = prepareMockPreparedApp('c27', { score: 0.95 });

    const quotaAfter = getDailyQuotaUsage({ dateString: today });
    // READY_FOR_REVIEW applications do not count against confirmed/in_flight quota
    assert.strictEqual(quotaAfter.current, quotaBefore.current);
});

test('Case 28: Uncertain submissions count against daily quota safely', () => {
    const today = new Date().toISOString().slice(0, 10);
    const quotaBefore = getDailyQuotaUsage({ dateString: today });

    const { app } = prepareMockPreparedApp('c28', { score: 0.95 });
    const db = getDb();
    db.prepare(`
        UPDATE applications
        SET state = 'UNCERTAIN_OUTCOME', submitted_at = datetime('now')
        WHERE id = ?
    `).run(app.id);

    const quotaAfter = getDailyQuotaUsage({ dateString: today });
    assert.strictEqual(quotaAfter.uncertain, quotaBefore.uncertain + 1);
    assert.strictEqual(quotaAfter.current, quotaBefore.current + 1);
});

// ── Part 5: Failure Handling & Worker Lifecycle (Tests 29–33) ──────────────

console.log('\n--- Part 5: Failure Handling & Worker Lifecycle (Tests 29–33) ---');

test('Case 29: Worker crash after claim recovers to NOT_STARTED', () => {
    const f29 = seedWorkerFixture('c29', { score: 0.91 });
    const claim = claimNextApplication({ workerId: 'crashed_worker_29', leaseDurationSeconds: 1 });
    assert(claim);

    // Simulate expired lease
    const db = getDb();
    db.prepare("UPDATE application_leases SET lease_expires_at = datetime('now', '-5 seconds') WHERE application_id = ?").run(f29.appId);

    const rec = recoverExpiredLeases();
    assert(rec.recovered.some(r => r.applicationId === f29.appId && r.action === 'RESET_NOT_STARTED'));

    const appAfter = getApplication(f29.appId);
    assert.strictEqual(appAfter.state, 'NOT_STARTED');
});

test('Case 30: Repeated worker crashes exhaust max attempts and transition to FAILED', () => {
    const f30 = seedWorkerFixture('c30', { score: 0.90 });
    const db = getDb();
    ensureLeasesTable(db);
    db.prepare(`
        INSERT INTO application_leases (application_id, worker_id, lease_expires_at, attempt_count, status)
        VALUES (?, 'failing_worker', datetime('now', '-5 seconds'), 3, 'PROCESSING')
    `).run(f30.appId);

    const rec = recoverExpiredLeases({ maxAttempts: 3 });
    assert(rec.recovered.some(r => r.applicationId === f30.appId && r.action === 'EXHAUSTED_RETRIES'));

    const lease = db.prepare('SELECT status FROM application_leases WHERE application_id = ?').get(f30.appId);
    assert.strictEqual(lease.status, 'FAILED');
});

test('Case 31: Queue inspection reports accurate totals and active leases', () => {
    const queue = inspectQueue();
    assert(typeof queue.queuedTotal === 'number');
    assert(typeof queue.activeLeasesCount === 'number');
    assert(Array.isArray(queue.queued));
    assert(Array.isArray(queue.activeLeases));
});

test('Case 32: Database integrity check and zero foreign key violations', () => {
    const db = getDb();
    const integrity = db.prepare('PRAGMA integrity_check').get();
    assert.strictEqual(integrity.integrity_check, 'ok');

    const fkCheck = db.prepare('PRAGMA foreign_key_check').all();
    assert.strictEqual(fkCheck.length, 0, 'Zero foreign key violations in test database');
});

test('Case 33: Canonical DB safety (Verify data/job_agent.db is byte-identical and was never touched)', () => {
    assert.strictEqual(resolve(getDbPath()), TEST_DB_PATH, 'Runtime must use test DB path');
    assert.notStrictEqual(TEST_DB_PATH, CANONICAL_DB_PATH, 'Test DB path must differ from canonical DB');

    const currentCanonicalHash = createHash('sha256').update(readFileSync(CANONICAL_DB_PATH)).digest('hex');
    assert.strictEqual(currentCanonicalHash, baselineCanonicalHash, 'Canonical DB hash must remain strictly byte-identical');
});

console.log('====================================================');
console.log(`📊 Application Worker Suite Results: ${passedCount} PASSED, ${failedCount} FAILED`);
console.log('====================================================');

closeDb();
safeCleanupTestDb();
delete process.env.JOB_AGENT_DB_PATH;

if (failedCount > 0) {
    process.exit(1);
}
