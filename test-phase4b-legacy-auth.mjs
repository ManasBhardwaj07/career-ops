/**
 * test-phase4b-legacy-auth.mjs — Phase 4B Stage 1: Legacy Authorization Safety Test Suite
 *
 * Verifies that:
 * 1. Missing packet_hash -> rejected with clear re-review notice.
 * 2. Missing resume_version_id -> rejected with clear re-review notice.
 * 3. Missing payload_digest -> rejected with clear re-review notice.
 * 4. Missing all bindings -> rejected.
 * 5. Fully bound authorization -> allowed.
 * 6. Modified review packet -> rejected.
 * 7. Modified resume version -> rejected.
 * 8. Modified answers / payload -> rejected.
 * 9. Scoped to different application -> rejected.
 * 10. Existing legacy records in SQLite remain intact (no auto-upgrade).
 * 11. submitApplication() cannot bypass authorization validation.
 * 12. Pre-submission authorization consumption remains intact.
 * 13. Database integrity & foreign key checks pass.
 */

import assert from 'assert';
import { createHash } from 'crypto';
import { existsSync, unlinkSync, writeFileSync, mkdirSync, readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Direct to isolated test database
const TEST_DB_PATH = resolve(__dirname, 'data/test_phase4b_legacy_auth.db');
const CANONICAL_DB_PATH = resolve(__dirname, 'data/job_agent.db');
if (existsSync(TEST_DB_PATH)) {
    try { unlinkSync(TEST_DB_PATH); } catch {}
}
process.env.JOB_AGENT_DB_PATH = TEST_DB_PATH;

// Import database and repository modules with isolated environment
const { getDb, closeDb, getDbPath } = await import('./db/db.mjs');
const resolvedDbPath = resolve(getDbPath());
if (resolvedDbPath === CANONICAL_DB_PATH) {
    throw new Error(`SAFETY ABORT: test-phase4b-legacy-auth.mjs resolved to canonical DB (${resolvedDbPath})`);
}

const { runMigrations } = await import('./db/migrate.js');
const {
    createSubmissionAuthorization,
    getSubmissionAuthorization,
    useSubmissionAuthorization,
    insertResumeVersion,
    getApplication,
    updateApplicationState,
    updateApplicationExecution,
    migrateAuthorizationsSchema,
    APPLICATION_STATES
} = await import('./db/repo.mjs');

import {
    canProceedToSubmit,
    computeApplicationPayloadDigest
} from './application/submission/policy.mjs';

import { submitApplication } from './application/submission/submit.mjs';

let passed = 0;
let failed = 0;

function test(description, fn) {
    try {
        fn();
        console.log(`  ✅ PASS: ${description}`);
        passed++;
    } catch (err) {
        console.error(`  ❌ FAIL: ${description}`);
        console.error(err);
        failed++;
    }
}

async function asyncTest(description, fn) {
    try {
        await fn();
        console.log(`  ✅ PASS: ${description}`);
        passed++;
    } catch (err) {
        console.error(`  ❌ FAIL: ${description}`);
        console.error(err);
        failed++;
    }
}

console.log('====================================================');
console.log('🧪 PHASE 4B STAGE 1 — LEGACY AUTHORIZATION SAFETY TEST');
console.log('====================================================\n');

// 1. Initialize isolated database and apply all migrations
runMigrations(null, { quiet: true });
migrateAuthorizationsSchema();

const db = getDb();

// 2. Setup reusable fixtures
const compId = 'comp_phase4b_auth';
const jobId = 'job_phase4b_auth';
const resumeId = 'resume_phase4b_v1';
const resumeTamperedId = 'resume_phase4b_v2';
const packetsDir = resolve(__dirname, 'output/review-packets');
mkdirSync(packetsDir, { recursive: true });

db.prepare(`
    INSERT INTO companies (id, name, domain, lifecycle_status, monitoring_status)
    VALUES (?, 'Acme Global', 'acme.example.com', 'APPROVED', 'active')
`).run(compId);

db.prepare(`
    INSERT INTO job_postings (id, company_id, title, location, job_url, status, source)
    VALUES (?, ?, 'Senior Backend Engineer', 'Bengaluru, India', 'https://acme.example.com/job/1', 'active', 'greenhouse')
`).run(jobId, compId);

insertResumeVersion({
    id: resumeId,
    job_id: jobId,
    format: 'pdf',
    file_path: 'output/resumes/synthetic_v1.pdf',
    variant_label: 'Backend'
});

insertResumeVersion({
    id: resumeTamperedId,
    job_id: jobId,
    format: 'pdf',
    file_path: 'output/resumes/synthetic_v2.pdf',
    variant_label: 'Tampered'
});

function createFixtureApplication(suffix, { withPacket = true } = {}) {
    const testJobId = `job_p4b_${suffix}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const jobUrl = `https://acme.example.com/job/${testJobId}`;
    db.prepare(`
        INSERT INTO job_postings (id, company_id, title, location, job_url, status, source)
        VALUES (?, ?, 'Senior Backend Engineer', 'Bengaluru, India', ?, 'active', 'greenhouse')
    `).run(testJobId, compId, jobUrl);

    const appId = `app_p4b_${suffix}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const packetPath = resolve(packetsDir, `${appId}.md`);
    if (withPacket) {
        writeFileSync(packetPath, `# Review Packet for ${appId}\nCandidate: Jordan Lee\nRole: Senior Backend Engineer\nStatus: READY_FOR_REVIEW`);
    }

    const metadata = {
        completedFields: [
            { name: 'full_name', value: 'Jordan Lee' },
            { name: 'email', value: 'candidate.synthetic@example.test' },
            { name: 'notice_period', value: 'immediate' }
        ]
    };

    db.prepare(`
        INSERT INTO applications (id, job_id, company_id, state, resume_version_id, review_packet_path, execution_metadata_json)
        VALUES (?, ?, ?, 'READY_FOR_REVIEW', ?, ?, ?)
    `).run(appId, testJobId, compId, resumeId, withPacket ? packetPath : null, JSON.stringify(metadata));

    return { appId, testJobId, packetPath };
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('Test 1: Legacy authorization missing packet_hash is strictly rejected', () => {
    const { appId, packetPath } = createFixtureApplication('missing_packet_hash');
    const app = getApplication(appId);
    const digest = computeApplicationPayloadDigest(app);

    const authId = createSubmissionAuthorization({
        scope: 'single',
        application_id: appId,
        packet_hash: null, // Legacy missing hash
        resume_version_id: resumeId,
        payload_digest: digest,
        authorized_by: 'user'
    });

    const check = canProceedToSubmit({ application: app, job: { status: 'active' } });
    assert.strictEqual(check.allowed, false);
    assert(check.reason.includes('missing required review packet binding (packet_hash)'), 'Rejection must cite missing packet_hash');
    assert(check.reason.includes('Fresh review and authorization are required'), 'Rejection must explain fresh review required');
});

test('Test 2: Legacy authorization missing resume_version_id is strictly rejected', () => {
    const { appId, packetPath } = createFixtureApplication('missing_resume_id');
    const app = getApplication(appId);
    const packetHash = createHash('sha256').update(readFileSync(packetPath, 'utf8')).digest('hex');
    const digest = computeApplicationPayloadDigest(app);

    const authId = createSubmissionAuthorization({
        scope: 'single',
        application_id: appId,
        packet_hash: packetHash,
        resume_version_id: null, // Legacy missing resume version
        payload_digest: digest,
        authorized_by: 'user'
    });

    const check = canProceedToSubmit({ application: app, job: { status: 'active' } });
    assert.strictEqual(check.allowed, false);
    assert(check.reason.includes('missing required resume version binding (resume_version_id)'), 'Rejection must cite missing resume_version_id');
    assert(check.reason.includes('Fresh review and authorization are required'), 'Rejection must explain fresh review required');
});

test('Test 3: Legacy authorization missing payload_digest is strictly rejected', () => {
    const { appId, packetPath } = createFixtureApplication('missing_payload_digest');
    const app = getApplication(appId);
    const packetHash = createHash('sha256').update(readFileSync(packetPath, 'utf8')).digest('hex');

    const authId = createSubmissionAuthorization({
        scope: 'single',
        application_id: appId,
        packet_hash: packetHash,
        resume_version_id: resumeId,
        payload_digest: null, // Legacy missing payload digest
        authorized_by: 'user'
    });

    const check = canProceedToSubmit({ application: app, job: { status: 'active' } });
    assert.strictEqual(check.allowed, false);
    assert(check.reason.includes('missing required submission payload digest binding (payload_digest)'), 'Rejection must cite missing payload_digest');
    assert(check.reason.includes('Fresh review and authorization are required'), 'Rejection must explain fresh review required');
});

test('Test 4: Legacy authorization missing all three bindings is strictly rejected', () => {
    const { appId } = createFixtureApplication('missing_all_bindings');
    const app = getApplication(appId);

    const authId = createSubmissionAuthorization({
        scope: 'single',
        application_id: appId,
        packet_hash: null,
        resume_version_id: null,
        payload_digest: null,
        authorized_by: 'user'
    });

    const check = canProceedToSubmit({ application: app, job: { status: 'active' } });
    assert.strictEqual(check.allowed, false);
    assert(check.reason.includes('missing required review packet binding'));
});

test('Test 5: Fully bound authorization with all matching bindings is permitted', () => {
    const { appId, packetPath } = createFixtureApplication('fully_bound');
    const app = getApplication(appId);
    const packetHash = createHash('sha256').update(readFileSync(packetPath, 'utf8')).digest('hex');
    const digest = computeApplicationPayloadDigest(app);

    const authId = createSubmissionAuthorization({
        scope: 'single',
        application_id: appId,
        packet_hash: packetHash,
        resume_version_id: resumeId,
        payload_digest: digest,
        authorized_by: 'user'
    });

    const check = canProceedToSubmit({ application: app, job: { status: 'active' } });
    assert.strictEqual(check.allowed, true);
    assert.strictEqual(check.authorization.id, authId);
});

test('Test 6: Modified review packet rejects even when hash was originally recorded', () => {
    const { appId, packetPath } = createFixtureApplication('modified_packet');
    const app = getApplication(appId);
    const packetHash = createHash('sha256').update(readFileSync(packetPath, 'utf8')).digest('hex');
    const digest = computeApplicationPayloadDigest(app);

    const authId = createSubmissionAuthorization({
        scope: 'single',
        application_id: appId,
        packet_hash: packetHash,
        resume_version_id: resumeId,
        payload_digest: digest,
        authorized_by: 'user'
    });

    // Verify valid before modification
    assert.strictEqual(canProceedToSubmit({ application: getApplication(appId), job: { status: 'active' } }).allowed, true);

    // Tamper with packet on disk
    writeFileSync(packetPath, readFileSync(packetPath, 'utf8') + '\n<!-- Tampered post-approval -->');

    // Policy must now reject
    const check = canProceedToSubmit({ application: getApplication(appId), job: { status: 'active' } });
    assert.strictEqual(check.allowed, false);
    assert(check.reason.includes('Review packet has been modified'));
    assert(check.reason.includes('Re-review and fresh authorization required'));
});

test('Test 7: Modified resume version rejects', () => {
    const { appId, packetPath } = createFixtureApplication('modified_resume');
    const app = getApplication(appId);
    const packetHash = createHash('sha256').update(readFileSync(packetPath, 'utf8')).digest('hex');
    const digest = computeApplicationPayloadDigest(app);

    const authId = createSubmissionAuthorization({
        scope: 'single',
        application_id: appId,
        packet_hash: packetHash,
        resume_version_id: resumeId,
        payload_digest: digest,
        authorized_by: 'user'
    });

    // Swap resume version in application record
    updateApplicationExecution(appId, { resume_version_id: resumeTamperedId });

    const check = canProceedToSubmit({ application: getApplication(appId), job: { status: 'active' } });
    assert.strictEqual(check.allowed, false);
    assert(check.reason.includes('differs from authorized resume version'));
    assert(check.reason.includes('Re-review and fresh authorization required'));
});

test('Test 8: Modified application answers / fields rejects', () => {
    const { appId, packetPath } = createFixtureApplication('modified_payload');
    const app = getApplication(appId);
    const packetHash = createHash('sha256').update(readFileSync(packetPath, 'utf8')).digest('hex');
    const digest = computeApplicationPayloadDigest(app);

    const authId = createSubmissionAuthorization({
        scope: 'single',
        application_id: appId,
        packet_hash: packetHash,
        resume_version_id: resumeId,
        payload_digest: digest,
        authorized_by: 'user'
    });

    // Modify completed fields in application execution metadata
    const tamperedMeta = {
        completedFields: [
            { name: 'full_name', value: 'Jordan Lee' },
            { name: 'email', value: 'candidate.synthetic@example.test' },
            { name: 'notice_period', value: '90 days' } // Modified from immediate
        ]
    };
    updateApplicationExecution(appId, { execution_metadata_json: JSON.stringify(tamperedMeta) });

    const check = canProceedToSubmit({ application: getApplication(appId), job: { status: 'active' } });
    assert.strictEqual(check.allowed, false);
    assert(check.reason.includes('Application answers or fields have been modified'));
    assert(check.reason.includes('Re-review and fresh authorization required'));
});

test('Test 9: Authorization scoped to different application is rejected', () => {
    const { appId: appA, packetPath: packetPathA } = createFixtureApplication('app_a');
    const { appId: appB } = createFixtureApplication('app_b');
    const packetHashA = createHash('sha256').update(readFileSync(packetPathA, 'utf8')).digest('hex');
    const digestA = computeApplicationPayloadDigest(getApplication(appA));

    // Authorize appA
    const authId = createSubmissionAuthorization({
        scope: 'single',
        application_id: appA,
        packet_hash: packetHashA,
        resume_version_id: resumeId,
        payload_digest: digestA,
        authorized_by: 'user'
    });

    // Attempt to evaluate for appB with authA
    const check = canProceedToSubmit({
        application: getApplication(appB),
        job: { status: 'active' },
        explicitAuthorization: getSubmissionAuthorization(authId)
    });

    assert.strictEqual(check.allowed, false);
    assert(check.reason.includes(`scoped to application ${appA}`));
});

test('Test 10: Existing legacy authorization records in SQLite remain intact without auto-upgrade', () => {
    const { appId } = createFixtureApplication('db_legacy_unmutated');

    // Simulate an older legacy authorization directly stored in DB before migration
    const legacyAuthId = `auth_legacy_historical_${Date.now()}`;
    db.prepare(`
        INSERT INTO submission_authorizations (id, scope, application_id, max_applications, used_count, status, packet_hash, resume_version_id, payload_digest, authorized_by, created_at)
        VALUES (?, 'single', ?, 1, 0, 'active', NULL, NULL, NULL, 'historical_user', '2026-04-01 12:00:00')
    `).run(legacyAuthId, appId);

    // Call canProceedToSubmit with this legacy record
    const check = canProceedToSubmit({
        application: getApplication(appId),
        job: { status: 'active' },
        explicitAuthorization: getSubmissionAuthorization(legacyAuthId)
    });

    assert.strictEqual(check.allowed, false, 'Legacy authorization must be rejected');

    // Verify row in database was NOT automatically upgraded or altered
    const recordAfterCheck = db.prepare('SELECT * FROM submission_authorizations WHERE id = ?').get(legacyAuthId);
    assert.strictEqual(recordAfterCheck.packet_hash, null, 'packet_hash must remain null');
    assert.strictEqual(recordAfterCheck.resume_version_id, null, 'resume_version_id must remain null');
    assert.strictEqual(recordAfterCheck.payload_digest, null, 'payload_digest must remain null');
    assert.strictEqual(recordAfterCheck.status, 'active', 'status must remain intact for historical ledger');
    assert.strictEqual(recordAfterCheck.used_count, 0, 'used_count must remain 0');
});

await asyncTest('Test 11: submitApplication() cannot bypass validation with unbound authorization', async () => {
    const { appId } = createFixtureApplication('submit_bypass_blocked');
    const app = getApplication(appId);

    const legacyAuthId = createSubmissionAuthorization({
        scope: 'single',
        application_id: appId,
        packet_hash: null,
        resume_version_id: null,
        payload_digest: null,
        authorized_by: 'user'
    });

    let thrown = false;
    try {
        const dummyPage = { click: async () => {}, url: () => 'http://example.com' };
        await submitApplication(dummyPage, {
            application: app,
            job: { id: jobId, status: 'active' },
            authorization: getSubmissionAuthorization(legacyAuthId)
        });
    } catch (err) {
        thrown = true;
        assert(err.message.includes('missing required review packet binding'));
    }

    assert.strictEqual(thrown, true, 'submitApplication must throw and block submission');
});

test('Test 12: Pre-submission authorization consumption remains intact on valid authorization', () => {
    const { appId, packetPath } = createFixtureApplication('consumption_intact');
    const app = getApplication(appId);
    const packetHash = createHash('sha256').update(readFileSync(packetPath, 'utf8')).digest('hex');
    const digest = computeApplicationPayloadDigest(app);

    const authId = createSubmissionAuthorization({
        scope: 'single',
        application_id: appId,
        packet_hash: packetHash,
        resume_version_id: resumeId,
        payload_digest: digest,
        authorized_by: 'user'
    });

    // Pre-consumption: used_count = 0, status = active
    let auth = getSubmissionAuthorization(authId);
    assert.strictEqual(auth.used_count, 0);
    assert.strictEqual(auth.status, 'active');

    // Consume authorization
    assert.strictEqual(useSubmissionAuthorization(authId), true);

    // Post-consumption: used_count = 1, status = used
    auth = getSubmissionAuthorization(authId);
    assert.strictEqual(auth.used_count, 1);
    assert.strictEqual(auth.status, 'used');

    // Repeated call to canProceedToSubmit cannot use exhausted authorization
    const secondCheck = canProceedToSubmit({
        application: app,
        job: { status: 'active' },
        explicitAuthorization: auth
    });
    // With status = 'used', it is no longer valid
    assert.strictEqual(secondCheck.allowed, false);
});

test('Test 13: Database integrity and foreign key check pass on isolated test DB', () => {
    const integrity = db.prepare('PRAGMA integrity_check').all();
    assert.strictEqual(integrity[0].integrity_check, 'ok');

    const foreignKeys = db.prepare('PRAGMA foreign_key_check').all();
    assert.strictEqual(foreignKeys.length, 0, `Expected 0 foreign key violations, found: ${JSON.stringify(foreignKeys)}`);
    closeDb();
    if (existsSync(TEST_DB_PATH)) {
        try { unlinkSync(TEST_DB_PATH); } catch {}
    }
    for (const f of [`${TEST_DB_PATH}-wal`, `${TEST_DB_PATH}-shm`]) {
        if (existsSync(f)) { try { unlinkSync(f); } catch {} }
    }
});

console.log('\n====================================================');
console.log(`📊 Phase 4B Stage 1 Test Results: ${passed} PASSED, ${failed} FAILED`);
console.log('====================================================');

if (failed > 0) {
    process.exit(1);
}
