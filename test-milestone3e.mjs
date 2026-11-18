/**
 * test-milestone3e.mjs — SQLite-Authoritative Tracking, Historical Migration & Reconciliation Test Suite
 *
 * Implements Milestone 3E Part 10:
 *   1. Historical Import & Provenance Ledger
 *   2. Canonical State Machine (Execution Lifecycle & Recruitment Outcomes)
 *   3. Repository Operations & Audit Integrity
 *   4. Tracker Export Projections (applications.md)
 *   5. End-to-End Pipeline & Execution Engine Integration
 */

import assert from 'assert';
import { createHash } from 'crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, copyFileSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';

const TEST_DB_PATH = resolve(process.cwd(), 'data', 'test_milestone3e.db');
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
    throw new Error(`SAFETY ABORT: test-milestone3e.mjs resolved to canonical DB (${resolvedDbPath})`);
}
console.log(`🔒 Isolated DB Path: ${resolvedDbPath}`);

{
    // Mark unrelated copied postings closed in the isolated copy so batch limits focus on test fixtures
    const db = getDb();
    db.prepare(`
        UPDATE job_postings SET status = 'closed'
        WHERE status IN ('discovered', 'active')
    `).run();
}

const {
    getJob,
    findCrossSourceDuplicates,
    createApplication,
    getApplication,
    getAllApplications,
    getApplicationEvents,
    updateApplicationState,
    updateApplicationExecution,
    updateRecruitmentOutcome,
    associateResumeVersion,
    recordApplicationEvent,
    logHistoricalLedgerRecord,
    getHistoricalLedger,
    getHistoricalLedgerSummary,
    getApplicationWithDetails,
    upsertCompany,
    upsertJobPosting,
    insertJobEvaluationRun,
    insertResumeVersion,
    resolveDuplicateSuggestion,
    isConfirmedDuplicate,
    APPLICATION_STATES,
    RECRUITMENT_OUTCOMES,
    EXECUTION_TRANSITIONS
} = await import('./db/repo.mjs');

const {
    exportApplicationsMarkdown,
    CANONICAL_COLUMNS
} = await import('./tracking/export-tracker.mjs');

const {
    reconcileHistory,
    reconcileApplicationsMarkdown,
    reconcileBatchAdditions,
    classifyHistoricalRecord,
    HISTORICAL_CLASSIFICATIONS,
    RESOLUTION_STATUSES
} = await import('./tracking/reconcile-history.mjs');

const { reconcileSubmissionOutcome } = await import('./application/submission/reconcile-outcome.mjs');
const {
    runUnifiedPipeline,
    deduplicateBatch,
    evaluateBatch,
    evaluateJob
} = await import('./matching/scheduler.mjs');
const {
    verifySingleJob,
    isJobVerifiedActive
} = await import('./verification/verify-jobs.mjs');

process.on('exit', () => {
    try { closeDb(); } catch { /* ignore */ }
    cleanupTestDb();
});

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
console.log('🧪 MILESTONE 3E — TRACKER RECONCILIATION & REPOSITORY TEST');
console.log('====================================================');

// Setup test helper fixtures
const db = getDb();

function cleanupFixtures() {
    db.prepare("DELETE FROM application_events WHERE application_id LIKE 'app_m3e_%'").run();
    db.prepare("DELETE FROM applications WHERE id LIKE 'app_m3e_%' OR company_id LIKE 'comp_m3e_%'").run();
    db.prepare("DELETE FROM historical_tracker_ledger WHERE resolved_company_id LIKE 'comp_m3e_%' OR resolved_job_id LIKE 'job_m3e_%' OR id LIKE 'test_ledger_%'").run();
    db.prepare("DELETE FROM job_evaluation_runs WHERE id LIKE 'eval_m3e_%' OR job_id LIKE 'job_m3e_%'").run();
    db.prepare("DELETE FROM resume_versions WHERE id LIKE 'res_m3e_%'").run();
    db.prepare("DELETE FROM duplicate_suggestions WHERE original_job_id LIKE 'job_m3e_%' OR duplicate_job_id LIKE 'job_m3e_%'").run();
    db.prepare("DELETE FROM job_postings WHERE id LIKE 'job_m3e_%' OR company_id LIKE 'comp_m3e_%'").run();
    db.prepare("DELETE FROM companies WHERE id LIKE 'comp_m3e_%'").run();
    exportApplicationsMarkdown();
}

function setupTestFixtures() {
    cleanupFixtures();

    // Insert test company
    db.prepare(`
        INSERT INTO companies (id, name, domain, lifecycle_status, monitoring_status)
        VALUES ('comp_m3e_test', 'Milestone3E Test Corp', 'm3etest.example.com', 'ACTIVE', 'ACTIVE')
        ON CONFLICT(id) DO UPDATE SET name = excluded.name
    `).run();

    // Insert test job postings
    db.prepare(`
        INSERT INTO job_postings (id, company_id, title, location, job_url, status, source)
        VALUES
            ('job_m3e_applied_1', 'comp_m3e_test', 'Senior Systems Engineer', 'Remote, US', 'https://m3etest.example.com/jobs/1', 'OPEN', 'TEST'),
            ('job_m3e_eval_only_1', 'comp_m3e_test', 'Junior Evaluated Only', 'Remote, US', 'https://m3etest.example.com/jobs/2', 'OPEN', 'TEST'),
            ('job_m3e_workflow_1', 'comp_m3e_test', 'Staff Platform Engineer', 'Remote, Worldwide', 'https://m3etest.example.com/jobs/3', 'OPEN', 'TEST')
        ON CONFLICT(id) DO UPDATE SET status = excluded.status
    `).run();

    // Insert test evaluation run for job_m3e_eval_only_1
    insertJobEvaluationRun({
        id: 'eval_m3e_test_1',
        job_id: 'job_m3e_eval_only_1',
        tier3_match_score: 2.0,
        recommendation: 'DO_NOT_APPLY',
        tier1_passed: true,
        tier2_eligibility: 'FAIL'
    });

    // Insert test resume version
    insertResumeVersion({
        id: 'res_m3e_test_1',
        format: 'pdf',
        variant_label: 'fullstack',
        file_path: 'output/resumes/test_m3e.pdf',
        html_path: 'output/resumes/test_m3e.html'
    });
}

setupTestFixtures();

// ── 1. Historical Import & Classification ──────────────────────────────────────
console.log('\n--- 1. Historical Import & Classification ---');

test('classifyHistoricalRecord categorizes evaluated opportunity with DO NOT APPLY as DISCARDED_OPPORTUNITY', () => {
    const res = classifyHistoricalRecord({
        company: 'PolyAI',
        role: 'AI Engineer',
        rawStatus: 'REJECTED',
        scoreStr: '1.0',
        reportPath: 'reports/004-polyai-fde-toronto.md',
        notes: 'Low score'
    });
    assert.strictEqual(res.classification, HISTORICAL_CLASSIFICATIONS.DISCARDED_OPPORTUNITY);
    assert.strictEqual(res.resolvedStatus, RESOLUTION_STATUSES.DISCARDED_EVALUATION);
});

test('classifyHistoricalRecord categorizes genuine interview interaction correctly', () => {
    const res = classifyHistoricalRecord({
        company: 'Acme',
        role: 'Lead Architect',
        rawStatus: 'Interview',
        notes: 'Round 1 completed'
    });
    assert.strictEqual(res.classification, HISTORICAL_CLASSIFICATIONS.INTERVIEW_OR_RECRUITER_INTERACTION);
    assert.strictEqual(res.resolvedStatus, RESOLUTION_STATUSES.RESOLVED);
});

test('classifyHistoricalRecord categorizes submitted application without interview as ACTUAL_APPLICATION_SUBMITTED', () => {
    const res = classifyHistoricalRecord({
        company: 'Stripe',
        role: 'Backend Engineer',
        rawStatus: 'Applied',
        notes: 'Applied via Greenhouse'
    });
    assert.strictEqual(res.classification, HISTORICAL_CLASSIFICATIONS.ACTUAL_APPLICATION_SUBMITTED);
    assert.strictEqual(res.resolvedStatus, RESOLUTION_STATUSES.RESOLVED);
});

test('classifyHistoricalRecord identifies duplicate batch row', () => {
    const res = classifyHistoricalRecord({
        company: 'Hume AI',
        role: 'AI Research Scientist',
        rawStatus: 'Evaluated',
        isDuplicate: true
    });
    assert.strictEqual(res.classification, HISTORICAL_CLASSIFICATIONS.DUPLICATE_HISTORICAL_RECORD);
    assert.strictEqual(res.resolvedStatus, RESOLUTION_STATUSES.DUPLICATE);
});

test('classifyHistoricalRecord marks unresolved record requiring manual reconciliation when company is missing', () => {
    const res = classifyHistoricalRecord({
        company: '',
        role: 'Mysterious Role',
        rawStatus: 'Unknown'
    });
    assert.strictEqual(res.classification, HISTORICAL_CLASSIFICATIONS.UNRESOLVED_RECORD);
    assert.strictEqual(res.resolvedStatus, RESOLUTION_STATUSES.UNRESOLVED);
});

// ── 2. Historical Provenance Ledger & Idempotency ──────────────────────────────
console.log('\n--- 2. Historical Provenance Ledger & Idempotency ---');

test('logHistoricalLedgerRecord inserts provenance record with full fidelity', () => {
    const ledgerEntry = {
        id: 'test_ledger_row_1',
        sourceFile: 'batch/test.tsv',
        sourceRowId: 101,
        rawTimestamp: '2026-11-10',
        rawCompany: 'Test Co',
        rawRole: 'Dev',
        rawStatus: 'Evaluada',
        rawScore: '4.5',
        rawPdf: 'cv.pdf',
        rawReport: 'rep.md',
        rawNotes: 'test note',
        rawPayload: JSON.stringify({ key: 'val' }),
        classification: HISTORICAL_CLASSIFICATIONS.EVALUATED_OPPORTUNITY,
        canonicalCompanyId: 'comp_m3e_test',
        canonicalJobId: 'job_m3e_eval_only_1',
        resolutionStatus: RESOLUTION_STATUSES.RESOLVED,
        reconciliationNotes: 'Verified clean import'
    };

    logHistoricalLedgerRecord(ledgerEntry);

    const fetched = db.prepare(`SELECT * FROM historical_tracker_ledger WHERE id = ?`).get('test_ledger_row_1');
    assert.ok(fetched);
    assert.strictEqual(fetched.source_file, 'batch/test.tsv');
    assert.strictEqual(parseFloat(fetched.row_identifier), 101);
    assert.strictEqual(fetched.original_company, 'Test Co');
    assert.strictEqual(fetched.classification, HISTORICAL_CLASSIFICATIONS.EVALUATED_OPPORTUNITY);
    assert.strictEqual(fetched.resolved_job_id, 'job_m3e_eval_only_1');
});

test('logHistoricalLedgerRecord is strictly idempotent on duplicate insert', () => {
    const beforeCount = db.prepare(`SELECT COUNT(*) as count FROM historical_tracker_ledger`).get().count;

    const ledgerEntry = {
        id: 'test_ledger_row_1',
        sourceFile: 'batch/test.tsv',
        sourceRowId: 101,
        rawTimestamp: '2026-11-10',
        rawCompany: 'Test Co',
        rawRole: 'Dev',
        rawStatus: 'Evaluada',
        classification: HISTORICAL_CLASSIFICATIONS.EVALUATED_OPPORTUNITY,
        resolutionStatus: RESOLUTION_STATUSES.RESOLVED
    };

    // Re-insert exact same ID
    logHistoricalLedgerRecord(ledgerEntry);

    const afterCount = db.prepare(`SELECT COUNT(*) as count FROM historical_tracker_ledger`).get().count;
    assert.strictEqual(afterCount, beforeCount);
});

test('reconcileHistory runs idempotently across repeat runs', () => {
    const run1 = reconcileHistory();
    const run2 = reconcileHistory();

    assert.strictEqual(run1.applicationsCount, run2.applicationsCount);
    assert.strictEqual(run1.batchCount, run2.batchCount);
    assert.strictEqual(run1.totalLedgerRecords, run2.totalLedgerRecords);
});

// ── 3. Canonical State Machine & Recruitment Outcomes ─────────────────────────
console.log('\n--- 3. Canonical State Machine & Recruitment Outcomes ---');

test('Execution lifecycle states adhere to validated transitions', () => {
    assert.ok(EXECUTION_TRANSITIONS[APPLICATION_STATES.NOT_STARTED].includes(APPLICATION_STATES.DRAFTING));
    assert.ok(EXECUTION_TRANSITIONS[APPLICATION_STATES.DRAFTING].includes(APPLICATION_STATES.PORTAL_OPENED));
    assert.ok(EXECUTION_TRANSITIONS[APPLICATION_STATES.PORTAL_OPENED].includes(APPLICATION_STATES.FORM_FILLING));
    assert.ok(EXECUTION_TRANSITIONS[APPLICATION_STATES.FORM_FILLING].includes(APPLICATION_STATES.READY_FOR_REVIEW));
    assert.ok(EXECUTION_TRANSITIONS[APPLICATION_STATES.READY_FOR_REVIEW].includes(APPLICATION_STATES.SUBMISSION_APPROVED));
    assert.ok(EXECUTION_TRANSITIONS[APPLICATION_STATES.SUBMISSION_APPROVED].includes(APPLICATION_STATES.SUBMITTING));
    assert.ok(EXECUTION_TRANSITIONS[APPLICATION_STATES.SUBMITTING].includes(APPLICATION_STATES.CONFIRMED));
    assert.ok(EXECUTION_TRANSITIONS[APPLICATION_STATES.SUBMITTING].includes(APPLICATION_STATES.UNCERTAIN_OUTCOME));
});

test('updateApplicationState rejects invalid transition', () => {
    const testJobId = 'job_m3e_inv_job';
    db.prepare(`
        INSERT INTO job_postings (id, company_id, title, location, job_url, status, source)
        VALUES (?, 'comp_m3e_test', 'Invalid Trans Role', 'Remote', 'https://m3etest.example.com/jobs/inv', 'OPEN', 'TEST')
        ON CONFLICT(id) DO UPDATE SET status = excluded.status
    `).run(testJobId);

    const testAppId = 'app_m3e_invalid_trans';
    createApplication({
        id: testAppId,
        job_id: testJobId,
        company_id: 'comp_m3e_test',
        initial_state: APPLICATION_STATES.NOT_STARTED
    });

    // Attempt invalid jump from NOT_STARTED directly to CONFIRMED
    assert.throws(() => {
        updateApplicationState(testAppId, APPLICATION_STATES.CONFIRMED);
    }, /Illegal application state transition/);

    const current = getApplication(testAppId);
    assert.strictEqual(current.state, APPLICATION_STATES.NOT_STARTED);
});

test('updateRecruitmentOutcome accepts valid outcome transitions and logs event', () => {
    const testJobId = 'job_m3e_outcome_job_1';
    db.prepare(`
        INSERT INTO job_postings (id, company_id, title, location, job_url, status, source)
        VALUES (?, 'comp_m3e_test', 'Dev Advocate', 'Remote', 'https://m3etest.example.com/jobs/out1', 'OPEN', 'TEST')
        ON CONFLICT(id) DO UPDATE SET status = excluded.status
    `).run(testJobId);

    const testAppId = 'app_m3e_outcome_test';
    createApplication({
        id: testAppId,
        job_id: testJobId,
        company_id: 'comp_m3e_test',
        initial_state: APPLICATION_STATES.NOT_STARTED
    });

    updateRecruitmentOutcome(testAppId, RECRUITMENT_OUTCOMES.APPLIED, 'Candidate submitted portal');
    let app = getApplication(testAppId);
    assert.strictEqual(app.recruitment_outcome, RECRUITMENT_OUTCOMES.APPLIED);
    assert.ok(app.recruitment_outcome_at);

    updateRecruitmentOutcome(testAppId, RECRUITMENT_OUTCOMES.RESPONDED, 'Recruiter sent initial screen email');
    app = getApplication(testAppId);
    assert.strictEqual(app.recruitment_outcome, RECRUITMENT_OUTCOMES.RESPONDED);

    updateRecruitmentOutcome(testAppId, RECRUITMENT_OUTCOMES.INTERVIEW, 'Technical round scheduled');
    app = getApplication(testAppId);
    assert.strictEqual(app.recruitment_outcome, RECRUITMENT_OUTCOMES.INTERVIEW);

    const events = getApplicationEvents(testAppId);
    const outcomeEvents = events.filter(e => e.event_type === 'recruitment_outcome_change');
    assert.strictEqual(outcomeEvents.length, 3);
});

test('updateRecruitmentOutcome rejects invalid/unknown outcome', () => {
    const testAppId = 'app_m3e_outcome_test';
    assert.throws(() => {
        updateRecruitmentOutcome(testAppId, 'UNKNOWN_STATUS_VALUE');
    }, /Invalid recruitment outcome/);
});

test('updateRecruitmentOutcome suppresses duplicate no-op outcome transitions', () => {
    const testAppId = 'app_m3e_outcome_test';
    const eventsBefore = getApplicationEvents(testAppId).length;

    // Transitioning to same outcome (INTERVIEW) again
    updateRecruitmentOutcome(testAppId, RECRUITMENT_OUTCOMES.INTERVIEW);

    const eventsAfter = getApplicationEvents(testAppId).length;
    assert.strictEqual(eventsAfter, eventsBefore);
});

// ── 4. Repository Operations & Constraints ────────────────────────────────────
console.log('\n--- 4. Repository Operations & Constraints ---');

test('createApplication creates application and emits initial APPLICATION_CREATED event', () => {
    const createJobId = 'job_m3e_create_repo_job';
    db.prepare(`
        INSERT INTO job_postings (id, company_id, title, location, job_url, status, source)
        VALUES (?, 'comp_m3e_test', 'Senior Systems Engineer', 'Remote, US', 'https://m3etest.example.com/jobs/repo_create', 'OPEN', 'TEST')
        ON CONFLICT(id) DO UPDATE SET status = excluded.status
    `).run(createJobId);

    const appId = 'app_m3e_repo_create_1';
    const returnedId = createApplication({
        id: appId,
        job_id: createJobId,
        company_id: 'comp_m3e_test',
        initial_state: APPLICATION_STATES.NOT_STARTED,
        source_origin: 'TEST_SUITE'
    });

    assert.strictEqual(returnedId, appId);
    const app = getApplication(appId);
    assert.strictEqual(app.id, appId);
    assert.strictEqual(app.state, APPLICATION_STATES.NOT_STARTED);
    assert.strictEqual(app.recruitment_outcome, null);

    const events = getApplicationEvents(appId);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].event_type, 'application_created');
    assert.strictEqual(events[0].new_state, APPLICATION_STATES.NOT_STARTED);
});

test('createApplication enforces active-attempt duplication protection', () => {
    // Attempt to create another active application for job_m3e_create_repo_job while app_m3e_repo_create_1 is active
    assert.throws(() => {
        createApplication({
            id: 'app_m3e_duplicate_conflict',
            job_id: 'job_m3e_create_repo_job',
            company_id: 'comp_m3e_test'
        });
    }, /Active application already exists/);
});

test('associateResumeVersion links verified resume version and logs audit event', () => {
    const appId = 'app_m3e_repo_create_1';
    associateResumeVersion(appId, 'res_m3e_test_1');

    const app = getApplication(appId);
    assert.strictEqual(app.resume_version_id, 'res_m3e_test_1');

    const events = getApplicationEvents(appId);
    const resumeEvent = events.find(e => e.event_type === 'resume_associated');
    assert.ok(resumeEvent);
    assert.strictEqual(JSON.parse(resumeEvent.payload_json).resumeVersionId, 'res_m3e_test_1');
});

test('associateResumeVersion throws if resume version does not exist', () => {
    const appId = 'app_m3e_repo_create_1';
    assert.throws(() => {
        associateResumeVersion(appId, 'res_nonexistent_999');
    }, /Resume version not found/);
});

test('recordApplicationEvent suppresses duplicate events via idempotency_key', () => {
    const appId = 'app_m3e_repo_create_1';
    const key = `idem_key_unique_${Date.now()}`;

    const id1 = recordApplicationEvent({
        application_id: appId,
        event_type: 'CUSTOM_AUDIT_PROBE',
        to_state: APPLICATION_STATES.NOT_STARTED,
        idempotency_key: key
    });
    assert.strictEqual(id1, true);

    const id2 = recordApplicationEvent({
        application_id: appId,
        event_type: 'CUSTOM_AUDIT_PROBE',
        to_state: APPLICATION_STATES.NOT_STARTED,
        idempotency_key: key
    });
    assert.strictEqual(id2, false);
});

test('reconcileSubmissionOutcome handles UNCERTAIN_OUTCOME recovery cleanly', () => {
    const testAppId = 'app_m3e_uncertain_rec';
    createApplication({
        id: testAppId,
        job_id: 'job_m3e_workflow_1',
        company_id: 'comp_m3e_test',
        initial_state: APPLICATION_STATES.NOT_STARTED
    });

    updateApplicationState(testAppId, APPLICATION_STATES.DRAFTING);
    updateApplicationState(testAppId, APPLICATION_STATES.PORTAL_OPENED);
    updateApplicationState(testAppId, APPLICATION_STATES.FORM_FILLING);
    updateApplicationState(testAppId, APPLICATION_STATES.READY_FOR_REVIEW);
    updateApplicationState(testAppId, APPLICATION_STATES.SUBMISSION_APPROVED);
    updateApplicationState(testAppId, APPLICATION_STATES.SUBMITTING);
    updateApplicationState(testAppId, APPLICATION_STATES.UNCERTAIN_OUTCOME);

    // Reconcile as successfully submitted via external portal receipt
    const recResult = reconcileSubmissionOutcome(
        testAppId,
        {
            outcome: APPLICATION_STATES.CONFIRMED,
            notes: 'Confirmed via automated portal verification receipt',
            confirmationReference: 'CONF-REC-112233'
        }
    );

    assert.strictEqual(recResult.success, true);
    assert.strictEqual(recResult.newState, APPLICATION_STATES.CONFIRMED);

    const reconciledApp = getApplication(testAppId);
    assert.strictEqual(reconciledApp.state, APPLICATION_STATES.CONFIRMED);
    assert.strictEqual(reconciledApp.confirmation_reference, 'CONF-REC-112233');
});

// ── 5. Tracker Export Projections ─────────────────────────────────────────────
console.log('\n--- 5. Tracker Export Projections ---');

test('exportApplicationsMarkdown produces valid markdown table with canonical columns', () => {
    const { markdown: exportedMd } = exportApplicationsMarkdown();
    assert.ok(exportedMd.includes('# Applications Tracker'));
    assert.ok(exportedMd.includes('| # | Date | Company | Role | Score | Status | PDF | Report | Notes |'));
    assert.ok(exportedMd.includes('|---|------|---------|------|-------|--------|-----|--------|-------|'));
});

test('exportApplicationsMarkdown excludes evaluated-only opportunities without applications', () => {
    const { markdown: exportedMd } = exportApplicationsMarkdown();
    // job_m3e_eval_only_1 is evaluated only with 2.0/5 score, never applied
    // It must NOT appear as a row in applications.md
    assert.strictEqual(exportedMd.includes('Junior Evaluated Only'), false);
});

test('exportApplicationsMarkdown excludes automated test fixtures and unsubmitted pipeline leads', () => {
    const { markdown: exportedMd } = exportApplicationsMarkdown();
    assert.strictEqual(exportedMd.includes('app_test_'), false);
    assert.strictEqual(exportedMd.includes('app_crash_'), false);
    assert.strictEqual(exportedMd.includes('app_fixture_'), false);
    assert.strictEqual(exportedMd.includes('app_pipe_'), false);
});

test('exportApplicationsMarkdown preserves verified score, notes, and report formatting', () => {
    const { markdown: exportedMd } = exportApplicationsMarkdown();
    // Check known production row in applications.md (Fello)
    assert.ok(exportedMd.includes('Fello'));
    assert.ok(exportedMd.includes('4.6/5'));
    assert.ok(exportedMd.includes('[001](reports/fello-mern-developer.md)'));
});

// ── 6. Full Integration: Milestone 3B/3C/3D to SQLite Tracking ────────────────
console.log('\n--- 6. Integration: Execution Engine to Canonical Tracking ---');

test('Evaluated opportunities in SQLite do not automatically become applications', () => {
    const evaluatedPostings = db.prepare(`
        SELECT jp.id, jp.title
        FROM job_postings jp
        JOIN job_evaluation_runs er ON er.job_id = jp.id
        WHERE jp.id = 'job_m3e_eval_only_1'
    `).all();

    assert.strictEqual(evaluatedPostings.length, 1);

    const appForEvaluated = db.prepare(`
        SELECT id FROM applications WHERE job_id = 'job_m3e_eval_only_1'
    `).all();

    assert.strictEqual(appForEvaluated.length, 0); // No application row automatically fabricated!
});

test('Milestone 3D application submission confirmation updates execution state to CONFIRMED and outcome to APPLIED', () => {
    const jobId = 'job_m3e_e2e_submit_job';
    db.prepare(`
        INSERT INTO job_postings (id, company_id, title, location, job_url, status, source)
        VALUES (?, 'comp_m3e_test', 'Staff Platform Engineer', 'Remote, Worldwide', 'https://m3etest.example.com/jobs/e2e', 'OPEN', 'TEST')
        ON CONFLICT(id) DO UPDATE SET status = excluded.status
    `).run(jobId);

    const appId = 'app_m3e_e2e_submit_1';
    createApplication({
        id: appId,
        job_id: jobId,
        company_id: 'comp_m3e_test',
        initial_state: APPLICATION_STATES.NOT_STARTED
    });

    // Walk through execution engine steps
    updateApplicationState(appId, APPLICATION_STATES.DRAFTING);
    updateApplicationState(appId, APPLICATION_STATES.PORTAL_OPENED);
    updateApplicationState(appId, APPLICATION_STATES.FORM_FILLING);
    updateApplicationState(appId, APPLICATION_STATES.READY_FOR_REVIEW);
    updateApplicationState(appId, APPLICATION_STATES.SUBMISSION_APPROVED);
    updateApplicationState(appId, APPLICATION_STATES.SUBMITTING);
    updateApplicationState(appId, APPLICATION_STATES.CONFIRMED);

    // Confirmation event with reference
    updateApplicationExecution(appId, {
        confirmation_reference: 'CONF-SUBMIT-888999',
        submitted_at: new Date().toISOString()
    });

    // Update recruitment outcome to APPLIED
    updateRecruitmentOutcome(appId, RECRUITMENT_OUTCOMES.APPLIED, 'Submission confirmed by execution engine');

    const completedApp = getApplicationWithDetails(appId);
    assert.strictEqual(completedApp.state, APPLICATION_STATES.CONFIRMED);
    assert.strictEqual(completedApp.recruitment_outcome, RECRUITMENT_OUTCOMES.APPLIED);
    assert.strictEqual(completedApp.confirmation_reference, 'CONF-SUBMIT-888999');
    assert.ok(completedApp.submitted_at);
    assert.strictEqual(completedApp.company_name, 'Milestone3E Test Corp');
    assert.strictEqual(completedApp.job_title, 'Staff Platform Engineer');
});

// ── 7. Batch B: Unified Pipeline Integration & Safety Hardening ───────────────
console.log('\n--- 7. Batch B: Unified Pipeline Integration & Safety Hardening ---');

function getDatabaseFingerprint(database) {
    const tables = [
        'job_postings',
        'job_snapshots',
        'source_scans',
        'duplicate_suggestions',
        'job_evaluation_runs',
        'companies',
        'applications',
        'application_events'
    ];
    const fp = {};
    for (const t of tables) {
        const rows = database.prepare(`SELECT * FROM ${t} ORDER BY rowid ASC`).all();
        fp[t] = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
    }
    return fp;
}

await asyncTest('Dry-Run Immutability: runUnifiedPipeline guarantees zero persistent mutations across all tables', async () => {
    const beforeState = getDatabaseFingerprint(db);

    const res = await runUnifiedPipeline({
        dryRun: true,
        limit: 5,
        crawl: false,
        scan: false,
        verify: true,
        dedup: true,
        evaluate: true,
        companyId: 'comp_m3e_test'
    });

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.dryRun, true);
    assert.strictEqual(res.stages.evaluation?.dryRun, true);

    const afterState = getDatabaseFingerprint(db);
    assert.deepStrictEqual(afterState, beforeState, 'Database state must be byte-for-byte identical after dry-run');
});

await asyncTest('Duplicate Matching: Same company/title with different locations are both evaluated (not suppressed)', async () => {
    db.prepare(`
        INSERT INTO job_postings (id, company_id, title, location, job_url, status, source)
        VALUES
            ('job_m3e_loc_sf', 'comp_m3e_test', 'Senior Systems Architect', 'San Francisco, CA', 'https://m3etest.example.com/loc/sf', 'active', 'greenhouse'),
            ('job_m3e_loc_chi', 'comp_m3e_test', 'Senior Systems Architect', 'Chicago, IL', 'https://m3etest.example.com/loc/chi', 'active', 'greenhouse')
        ON CONFLICT(id) DO UPDATE SET title = excluded.title
    `).run();

    const dups = findCrossSourceDuplicates(getJob('job_m3e_loc_chi'));
    assert.strictEqual(dups.length, 0, 'Different locations must not produce duplicate suggestions');

    const evalRes = await evaluateBatch({ companyId: 'comp_m3e_test', forceReeval: true });
    const sfResult = evalRes.results.find(r => r.jobId === 'job_m3e_loc_sf');
    const chiResult = evalRes.results.find(r => r.jobId === 'job_m3e_loc_chi');

    assert.ok(sfResult && !sfResult.isDuplicate, 'SF job must be evaluated');
    assert.ok(chiResult && !chiResult.isDuplicate, 'Chicago job must be evaluated');
});

await asyncTest('Duplicate Matching: Same company/title with different remote scopes are both evaluated (not suppressed)', async () => {
    db.prepare(`
        INSERT INTO job_postings (id, company_id, title, location, remote_type, job_url, status, source)
        VALUES
            ('job_m3e_rem_onsite', 'comp_m3e_test', 'DevOps Specialist', 'Bengaluru, India', 'onsite', 'https://m3etest.example.com/rem/onsite', 'active', 'greenhouse'),
            ('job_m3e_rem_remote', 'comp_m3e_test', 'DevOps Specialist', 'Bengaluru, India', 'remote', 'https://m3etest.example.com/rem/remote', 'active', 'greenhouse')
        ON CONFLICT(id) DO UPDATE SET title = excluded.title
    `).run();

    const dups = findCrossSourceDuplicates(getJob('job_m3e_rem_remote'));
    assert.strictEqual(dups.length, 0, 'Different remote scopes must not produce duplicate suggestions');

    const evalRes = await evaluateBatch({ companyId: 'comp_m3e_test', forceReeval: true });
    const onsiteResult = evalRes.results.find(r => r.jobId === 'job_m3e_rem_onsite');
    const remoteResult = evalRes.results.find(r => r.jobId === 'job_m3e_rem_remote');

    assert.ok(onsiteResult && !onsiteResult.isDuplicate, 'Onsite role must be evaluated');
    assert.ok(remoteResult && !remoteResult.isDuplicate, 'Remote role must be evaluated');
});

await asyncTest('Duplicate Matching: Distinct requisition IDs from same source are not merged', async () => {
    db.prepare(`
        INSERT INTO job_postings (id, company_id, title, location, source, source_job_id, job_url, status)
        VALUES
            ('job_m3e_req_101', 'comp_m3e_test', 'Data Pipeline Engineer', 'Bengaluru, India', 'greenhouse', 'REQ-101', 'https://m3etest.example.com/req/101', 'active'),
            ('job_m3e_req_102', 'comp_m3e_test', 'Data Pipeline Engineer', 'Bengaluru, India', 'greenhouse', 'REQ-102', 'https://m3etest.example.com/req/102', 'active')
        ON CONFLICT(id) DO UPDATE SET title = excluded.title
    `).run();

    const dups = findCrossSourceDuplicates(getJob('job_m3e_req_102'));
    assert.strictEqual(dups.length, 0, 'Distinct requisition IDs from same source must not produce duplicate suggestion');
});

await asyncTest('Duplicate Matching: Unresolved suggestion (resolved = 0) does NOT suppress evaluation', async () => {
    db.prepare(`
        INSERT INTO job_postings (id, company_id, title, location, remote_type, job_url, status, source)
        VALUES
            ('job_m3e_sugg_orig', 'comp_m3e_test', 'Core Infrastructure Dev', 'Bengaluru, India', 'hybrid', 'https://m3etest.example.com/gh/infra', 'active', 'greenhouse'),
            ('job_m3e_sugg_copy', 'comp_m3e_test', 'Core Infrastructure Dev', 'Bengaluru, India', 'hybrid', 'https://m3etest.example.com/crawl/infra', 'active', 'crawl')
        ON CONFLICT(id) DO UPDATE SET title = excluded.title
    `).run();

    // Insert an unconfirmed suggestion (resolved = 0)
    db.prepare(`
        INSERT INTO duplicate_suggestions (original_job_id, duplicate_job_id, confidence, reasons, resolved)
        VALUES ('job_m3e_sugg_orig', 'job_m3e_sugg_copy', 0.95, 'High confidence match', 0)
        ON CONFLICT(original_job_id, duplicate_job_id) DO UPDATE SET resolved = 0
    `).run();

    const evalRes = await evaluateBatch({ companyId: 'comp_m3e_test', forceReeval: true });
    const origResult = evalRes.results.find(r => r.jobId === 'job_m3e_sugg_orig');
    const copyResult = evalRes.results.find(r => r.jobId === 'job_m3e_sugg_copy');

    assert.ok(origResult && !origResult.isDuplicate, 'Original job must be evaluated');
    assert.ok(copyResult && !copyResult.isDuplicate, 'Unconfirmed suggested duplicate must NOT be suppressed');
    assert.strictEqual(copyResult.skipped, false);
});

await asyncTest('Duplicate Matching: Confirmed duplicate (resolved = 1) suppresses duplicate while keeping canonical evaluated', async () => {
    // Resolve previous suggestion as CONFIRMED_DUPLICATE
    const suggestionRow = db.prepare(`
        SELECT id FROM duplicate_suggestions
        WHERE original_job_id = 'job_m3e_sugg_orig' AND duplicate_job_id = 'job_m3e_sugg_copy'
    `).get();

    assert.ok(suggestionRow);
    resolveDuplicateSuggestion(suggestionRow.id, { decision: 'CONFIRMED_DUPLICATE', notes: 'Verified identical posting across ATS and crawl' });

    const evalRes = await evaluateBatch({ companyId: 'comp_m3e_test', forceReeval: true });
    const origResult = evalRes.results.find(r => r.jobId === 'job_m3e_sugg_orig');
    const copyResult = evalRes.results.find(r => r.jobId === 'job_m3e_sugg_copy');

    assert.ok(origResult && !origResult.isDuplicate, 'Original canonical job must be evaluated');
    assert.ok(copyResult && copyResult.isDuplicate, 'Confirmed duplicate must be suppressed');
    assert.strictEqual(copyResult.skipped, true);
    assert.strictEqual(copyResult.canonicalJobId, 'job_m3e_sugg_orig');
});

await asyncTest('Verification Gating: Newly discovered job, verification succeeds -> eligible for evaluation', async () => {
    const jobId = 'job_m3e_vg_disc_succ';
    db.prepare(`
        INSERT INTO job_postings (id, company_id, title, location, description, job_url, status, source)
        VALUES (?, 'comp_m3e_test', 'Software Engineer (Backend)', 'Bengaluru, India', 'Node.js, PostgreSQL, Docker developer', 'https://m3etest.example.com/vg/1', 'discovered', 'greenhouse')
        ON CONFLICT(id) DO UPDATE SET title = excluded.title
    `).run(jobId);

    const mockFetch = async () => ({
        status: 200,
        url: 'https://m3etest.example.com/vg/1',
        text: async () => '<html><body><h1>Software Engineer</h1><button>Apply Online</button></body></html>'
    });

    const vRes = await verifySingleJob(getJob(jobId), { fetchFn: mockFetch });
    assert.strictEqual(vRes.outcome, 'ACTIVE');

    const updatedJob = getJob(jobId);
    assert.strictEqual(updatedJob.status, 'active');
    assert.ok(isJobVerifiedActive(updatedJob));

    const evalRes = await evaluateJob(jobId, { requireVerifiedActive: true });
    assert.strictEqual(evalRes.recommendation, 'APPLY');
    assert.strictEqual(evalRes.isVerifiedActive, true);
});

await asyncTest('Verification Gating: Newly discovered job, verification returns ERROR -> not application-eligible', async () => {
    const jobId = 'job_m3e_vg_disc_err';
    db.prepare(`
        INSERT INTO job_postings (id, company_id, title, location, description, job_url, status, source)
        VALUES (?, 'comp_m3e_test', 'Software Engineer (Backend)', 'Bengaluru, India', 'Node.js, PostgreSQL developer', 'https://m3etest.example.com/vg/2', 'discovered', 'greenhouse')
        ON CONFLICT(id) DO UPDATE SET title = excluded.title
    `).run(jobId);

    const mockFetch = async () => {
        throw new Error('Connection timed out (ETIMEDOUT)');
    };

    const vRes = await verifySingleJob(getJob(jobId), { fetchFn: mockFetch });
    assert.strictEqual(vRes.outcome, 'ERROR');

    const updatedJob = getJob(jobId);
    assert.strictEqual(updatedJob.status, 'discovered'); // Status unchanged
    assert.strictEqual(isJobVerifiedActive(updatedJob), false);

    const evalRes = await evaluateJob(jobId, { requireVerifiedActive: true });
    assert.notStrictEqual(evalRes.recommendation, 'APPLY', 'Unverified error job must NOT receive APPLY');
    assert.strictEqual(evalRes.recommendation, 'UNKNOWN');
    assert.strictEqual(evalRes.isVerifiedActive, false);
});

await asyncTest('Verification Gating: Newly discovered job, verification returns UNKNOWN (429/bot) -> not application-eligible', async () => {
    const jobId = 'job_m3e_vg_disc_unk';
    db.prepare(`
        INSERT INTO job_postings (id, company_id, title, location, description, job_url, status, source)
        VALUES (?, 'comp_m3e_test', 'Software Engineer (Backend)', 'Bengaluru, India', 'Node.js, PostgreSQL developer', 'https://m3etest.example.com/vg/3', 'discovered', 'greenhouse')
        ON CONFLICT(id) DO UPDATE SET title = excluded.title
    `).run(jobId);

    const mockFetch = async () => ({
        status: 429,
        url: 'https://m3etest.example.com/vg/3',
        text: async () => 'Too Many Requests'
    });

    const vRes = await verifySingleJob(getJob(jobId), { fetchFn: mockFetch });
    assert.strictEqual(vRes.outcome, 'UNKNOWN');

    const updatedJob = getJob(jobId);
    assert.strictEqual(isJobVerifiedActive(updatedJob), false);

    const evalRes = await evaluateJob(jobId, { requireVerifiedActive: true });
    assert.notStrictEqual(evalRes.recommendation, 'APPLY');
    assert.strictEqual(evalRes.isVerifiedActive, false);
});

await asyncTest('Verification Gating: Previously active job, latest verification fails -> not application-eligible', async () => {
    const jobId = 'job_m3e_vg_act_fail';
    // Previously active job verified 5 days ago
    db.prepare(`
        INSERT INTO job_postings (id, company_id, title, location, description, job_url, status, source, last_verified_at, verification_method)
        VALUES (?, 'comp_m3e_test', 'Software Engineer (Backend)', 'Bengaluru, India', 'Node.js developer', 'https://m3etest.example.com/vg/4', 'active', 'greenhouse', datetime('now', '-5 days'), 'http_probe:active')
        ON CONFLICT(id) DO UPDATE SET status = 'active'
    `).run(jobId);

    // Latest verification attempt fails with HTTP 500
    const mockFetch = async () => ({
        status: 500,
        url: 'https://m3etest.example.com/vg/4',
        text: async () => 'Internal Server Error'
    });

    const vRes = await verifySingleJob(getJob(jobId), { fetchFn: mockFetch });
    assert.strictEqual(vRes.outcome, 'ERROR');

    const updatedJob = getJob(jobId);
    assert.strictEqual(updatedJob.status, 'active'); // Temporary error preserves active status
    assert.strictEqual(isJobVerifiedActive(updatedJob), false, 'Failed latest verification must not inherit eligibility');

    const evalRes = await evaluateJob(jobId, { requireVerifiedActive: true });
    assert.notStrictEqual(evalRes.recommendation, 'APPLY', 'Latest verification failure blocks APPLY');
    assert.strictEqual(evalRes.recommendation, 'UNKNOWN');
});

await asyncTest('Verification Gating: Previously active job, latest verification succeeds -> eligible for evaluation', async () => {
    const jobId = 'job_m3e_vg_act_succ';
    db.prepare(`
        INSERT INTO job_postings (id, company_id, title, location, description, job_url, status, source, last_verified_at, verification_method)
        VALUES (?, 'comp_m3e_test', 'Software Engineer (Backend)', 'Bengaluru, India', 'Node.js developer', 'https://m3etest.example.com/vg/5', 'active', 'greenhouse', datetime('now', '-5 days'), 'http_probe:active')
        ON CONFLICT(id) DO UPDATE SET status = 'active'
    `).run(jobId);

    const mockFetch = async () => ({
        status: 200,
        url: 'https://m3etest.example.com/vg/5',
        text: async () => '<html><body><button>Apply Now</button></body></html>'
    });

    const vRes = await verifySingleJob(getJob(jobId), { fetchFn: mockFetch });
    assert.strictEqual(vRes.outcome, 'ACTIVE');

    const updatedJob = getJob(jobId);
    assert.strictEqual(isJobVerifiedActive(updatedJob), true);

    const evalRes = await evaluateJob(jobId, { requireVerifiedActive: true });
    assert.strictEqual(evalRes.recommendation, 'APPLY');
    assert.strictEqual(evalRes.isVerifiedActive, true);
});

await asyncTest('Verification Gating: One failed job does not stop unrelated verified jobs in pipeline', async () => {
    const scopedCompanyId = 'comp_m3e_vg_multi';
    const failJobId = 'job_m3e_vg_multi_fail';
    const passJobId = 'job_m3e_vg_multi_pass';

    db.prepare(`
        INSERT INTO companies (id, name, ats_type, policy_status)
        VALUES (?, 'M3E VG Multi Co', 'greenhouse', 'permitted')
        ON CONFLICT(id) DO UPDATE SET policy_status = 'permitted'
    `).run(scopedCompanyId);

    db.prepare(`
        INSERT INTO job_postings (id, company_id, title, location, description, job_url, status, source)
        VALUES
            (?, ?, 'Software Engineer', 'Bengaluru, India', 'Node.js developer', 'https://m3etest.example.com/vg/multi_fail', 'discovered', 'career_page'),
            (?, ?, 'Software Engineer', 'Bengaluru, India', 'Node.js developer', 'https://m3etest.example.com/vg/multi_pass', 'discovered', 'career_page')
        ON CONFLICT(id) DO UPDATE SET
            company_id = excluded.company_id,
            title = excluded.title,
            source = excluded.source,
            status = 'discovered'
    `).run(failJobId, scopedCompanyId, passJobId, scopedCompanyId);

    const multiMockFetch = async (url) => {
        if (url.includes('multi_fail')) {
            throw new Error('Connection reset by peer');
        }
        return {
            status: 200,
            url,
            text: async () => '<html><body><h1>Software Engineer</h1><p>We are hiring a software engineer in Bengaluru. Work on Node.js and PostgreSQL.</p><button>Apply Online</button></body></html>'
        };
    };

    try {
        const pipelineRes = await runUnifiedPipeline({
            crawl: false,
            scan: false,
            verify: true,
            dedup: false,
            evaluate: true,
            limit: 20,
            companyId: scopedCompanyId,
            fetchFn: multiMockFetch,
            forceReeval: true
        });

        assert.strictEqual(pipelineRes.success, true);

        // Regression: the intended eligible job must actually be included in the evaluation batch
        const evalResults = pipelineRes.stages.evaluation?.results || [];
        const passEval = evalResults.find(r => r.jobId === passJobId);
        assert.ok(passEval, 'Passing job must be included in the pipeline evaluation batch');

        // Passing job was verified and enters eligibleForApplication despite the sibling failure
        const passEligible = pipelineRes.eligibleForApplication.find(j => j.jobId === passJobId);
        assert.ok(passEligible, 'Passing job must enter eligibleForApplication');

        // Failing job was not active and does not enter eligibleForApplication
        const failEligible = pipelineRes.eligibleForApplication.find(j => j.jobId === failJobId);
        assert.strictEqual(failEligible, undefined, 'Failing job must NOT enter eligibleForApplication');
    } finally {
        db.prepare('DELETE FROM job_evaluations WHERE job_id IN (?, ?)').run(failJobId, passJobId);
        db.prepare('DELETE FROM job_postings WHERE company_id = ?').run(scopedCompanyId);
        db.prepare('DELETE FROM companies WHERE id = ?').run(scopedCompanyId);
    }
});

// Cleanup
cleanupFixtures();
closeDb();
cleanupTestDb();
delete process.env.JOB_AGENT_DB_PATH;

// Summary
console.log('\n====================================================');
console.log(`📊 Milestone 3E Test Results: ${passedCount} PASSED, ${failedCount} FAILED`);
console.log('====================================================');

if (failedCount > 0) {
    process.exit(1);
} else {
    process.exit(0);
}
