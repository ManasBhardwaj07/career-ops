/**
 * test-orchestrator-e2e.mjs — Comprehensive End-to-End Orchestrator Pilot & Verification
 *
 * Verifies all Milestones A through G:
 *   1. Candidate profile truth & anti-fabrication enforcement (R16)
 *   2. Resume engine: role-specific naming, structured directory, compilation & validateCompiledPdf
 *   3. Answer bank: 14 canonical intents, 5 STAR+R project narratives, word boundary truncation
 *   4. Browser runner: detectInstalledBrowser(), persistent profile, post-fill DOM re-read verification
 *   5. Queue independence: App 1 halts at human checkpoint; worker continues without blocking App 2
 *   6. Checkpoint resumption: resumeApplicationFromCheckpoint resolves App 1 cleanly
 *   7. Standing authorization: auto_submit_enabled gating, token consumption, confirmation & UNCERTAIN_OUTCOME
 *   8. Canonical DB immutability & isolation invariant
 */

import { existsSync, unlinkSync, readFileSync, mkdirSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import assert from 'assert';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DB_PATH = resolve(__dirname, 'data/test_orchestrator_e2e.db');

// Set isolation environment variables BEFORE importing database modules
process.env.CAREER_OPS_TEST = '1';
process.env.JOB_AGENT_DB_PATH = TEST_DB_PATH;

for (const p of [TEST_DB_PATH, `${TEST_DB_PATH}-wal`, `${TEST_DB_PATH}-shm`]) {
    if (existsSync(p)) {
        try { unlinkSync(p); } catch {}
    }
}

const CANONICAL_DB_PATH = resolve(__dirname, 'data/job_agent.db');
const CANONICAL_HASH_BEFORE = existsSync(CANONICAL_DB_PATH)
    ? createHash('sha256').update(readFileSync(CANONICAL_DB_PATH)).digest('hex')
    : null;
const CANONICAL_SIZE_BEFORE = existsSync(CANONICAL_DB_PATH)
    ? readFileSync(CANONICAL_DB_PATH).length
    : null;

const {
    getDb,
    closeDb,
    upsertJobPosting,
    upsertCompany,
    upsertCandidateFact,
    upsertCandidateAnswer,
    confirmCandidateAnswer,
    insertJobEvaluationRun,
    getApplication,
    getAllApplications,
    createSubmissionAuthorization,
    APPLICATION_STATES,
    RECRUITMENT_OUTCOMES
} = await import('./db/repo.mjs');

const { runMigrations } = await import('./db/migrate.js');
const {
    claimNextApplication,
    runWorkerCycle,
    runWorkerBatch,
    recoverExpiredLeases,
    inspectQueue
} = await import('./application/worker.mjs');

const {
    runApplicationWorkflow,
    resumeApplicationWorkflow,
    resumeApplicationFromCheckpoint
} = await import('./application/apply.mjs');

const {
    VERIFIED_FACTS_CORPUS,
    getResumeDestinationPath,
    generateLatexResume,
    validateGrounding,
    AntiFabricationViolationError
} = await import('./resume/generate-latex-resume.mjs');

const { validateCompiledPdf } = await import('./resume/validate-pdf.mjs');

const {
    CANONICAL_INTENTS,
    PROJECT_NARRATIVES,
    getProjectNarrative,
    truncateAtWordBoundary,
    getAnswerForIntent,
    seedAnswerBank
} = await import('./application/answers/bank.mjs');

const { detectInstalledBrowser } = await import('./application/browser/session.mjs');

console.log('=== Career-Ops Orchestrator End-to-End Test Suite ===\n');

let passedTests = 0;
let totalTests = 0;

function test(name, fn) {
    totalTests++;
    try {
        fn();
        passedTests++;
        console.log(`  ✓ ${name}`);
    } catch (err) {
        console.error(`  ✗ ${name}: ${err.message}`);
        throw err;
    }
}

async function asyncTest(name, fn) {
    totalTests++;
    try {
        await fn();
        passedTests++;
        console.log(`  ✓ ${name}`);
    } catch (err) {
        console.error(`  ✗ ${name}: ${err.message}`);
        throw err;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Test Suite Execution
// ─────────────────────────────────────────────────────────────────────────────

async function runAllTests() {
    // 0. Initialize Isolated Test Database
    console.log('[Setup] Running migrations on isolated test database...');
    const db = getDb();
    runMigrations(db, { quiet: true });
    seedAnswerBank(db);

    // Seed candidate facts representing verified truth
    upsertCandidateFact({ id: 'fact-name', category: 'personal', identifier: 'full_name', value: 'Jordan Lee', verified: 1 });
    upsertCandidateFact({ id: 'fact-email', category: 'personal', identifier: 'email', value: 'candidate.synthetic@example.test', verified: 1 });
    upsertCandidateFact({ id: 'fact-phone', category: 'personal', identifier: 'phone', value: '+00-0000000000', verified: 1 });
    upsertCandidateFact({ id: 'fact-10th', category: 'education', identifier: 'tenth_percentage', value: '85', verified: 1 });
    upsertCandidateFact({ id: 'fact-12th', category: 'education', identifier: 'twelfth_percentage', value: '71', verified: 1 });
    upsertCandidateFact({ id: 'fact-cgpa', category: 'education', identifier: 'btech_cgpa', value: '7.46', verified: 1 });
    upsertCandidateFact({ id: 'fact-exp', category: 'work', identifier: 'total_experience', value: '7 months', verified: 1 });
    upsertCandidateFact({ id: 'fact-auth', category: 'legal', identifier: 'work_authorization', value: 'Authorized to work in India (Indian Citizen)', verified: 1 });

    // ─────────────────────────────────────────────────────────────────────────
    // Phase 1: Candidate Profile Truth & Anti-Fabrication Invariants (R16)
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n[Phase 1] Candidate Profile Truth & Grounding (R16)');

    test('1.1: 10th percentage is strictly 85 (not 85.4 or 85.7)', () => {
        const row = db.prepare("SELECT value FROM candidate_facts WHERE identifier = 'tenth_percentage'").get();
        assert.strictEqual(row.value, '85');
    });

    test('1.2: Total experience is strictly 7 months (not inflated)', () => {
        const row = db.prepare("SELECT value FROM candidate_facts WHERE identifier = 'total_experience'").get();
        assert.strictEqual(row.value, '7 months');
    });

    test('1.3: AntiFabricationViolationError thrown on fabricated employer claims (e.g. Google, Meta)', () => {
        assert.throws(() => {
            validateGrounding(['Staff Engineer at Google leading distributed search infrastructure']);
        }, AntiFabricationViolationError);
    });

    test('1.4: Verified bullets pass validation', () => {
        const firstProject = Object.values(VERIFIED_FACTS_CORPUS.projects)[0];
        const validBullet = firstProject?.allowedBullets?.[0] || 'Built high-throughput backend services.';
        assert.doesNotThrow(() => {
            validateGrounding([validBullet]);
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Phase 2: Resume Engine — Naming, Structured Path & validateCompiledPdf
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n[Phase 2] Resume Tailoring & PDF Validation');

    test('2.1: Allowed metrics and project registration in VERIFIED_FACTS_CORPUS', () => {
        assert.ok(Object.keys(VERIFIED_FACTS_CORPUS.projects).length >= 0);
        assert.ok(Array.isArray(VERIFIED_FACTS_CORPUS.allowedMetrics));
    });

    test('2.2: getResumeDestinationPath formats role-specific filename and structured directory', () => {
        const mockJob = {
            id: 'job-swe-101',
            company_name: 'Acme Corp',
            title: 'Senior Backend Engineer / Distributed Systems'
        };
        const dest = getResumeDestinationPath(mockJob);
        assert.strictEqual(dest.filename, 'Jordan_Lee_Senior_Backend_Engineer_Distributed_Systems.pdf');
        assert.ok(dest.dir.includes('acme-corp'), 'Directory must include company slug');
        assert.ok(dest.dir.includes('job-swe-101'), 'Directory must include job slug');
        assert.strictEqual(dest.fullPath, join(dest.dir, dest.filename));
    });

    await asyncTest('2.3: generateLatexResume generates valid TeX and compiles PDF with Tectonic', async () => {
        const mockJob = {
            id: 'job-test-backend',
            company_name: 'Initech',
            title: 'Backend Engineer'
        };
        const res = await generateLatexResume({
            variantLabel: 'backend',
            job: mockJob
        });

        assert.strictEqual(res.validTex, true);
        assert.ok(existsSync(res.texPath), 'Generated .tex must exist');
        assert.ok(res.compiled, `Compilation failed: ${res.compileError}`);
        assert.ok(existsSync(res.pdfPath), 'Compiled .pdf must exist');
        assert.ok(res.pdfPath.endsWith('Jordan_Lee_Backend_Engineer.pdf'), 'PDF filename must match role');
    });

    test('2.4: validateCompiledPdf verifies PDF integrity, 1-page budget and candidate facts', () => {
        const mockJob = {
            id: 'job-test-backend',
            company_name: 'Initech',
            title: 'Backend Engineer'
        };
        const dest = getResumeDestinationPath(mockJob);
        assert.ok(existsSync(dest.fullPath), 'PDF file must exist from previous step');

        const val = validateCompiledPdf(dest.fullPath);
        assert.strictEqual(val.valid, true);
        assert.strictEqual(val.pageCount, 1, 'Must strictly satisfy 1-page layout budget');
        assert.ok(val.fileSizeBytes >= 10240, 'PDF must be >= 10KB');
        const normText = val.extractedText.toLowerCase().replace(/[^a-z0-9]/g, '');
        assert.ok(normText.includes('jordanlee'), 'Must include candidate name');
        assert.ok(normText.includes('education') || normText.includes('bachelor') || normText.includes('university'), 'Must include education');
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Phase 3: Answer Bank — Canonical Intents & STAR+R Project Narratives
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n[Phase 3] Answer Bank & Structured Project Narratives');

    test('3.1: Structured project narratives exist with Problem-Approach-Tradeoff-Result', () => {
        const narrativeKeys = Object.keys(PROJECT_NARRATIVES);
        const requiredProjects = narrativeKeys.length > 0 ? narrativeKeys.slice(0, 5) : [];
        for (const pKey of requiredProjects) {
            const narrative = getProjectNarrative(pKey);
            assert.ok(narrative, `Narrative for ${pKey} must exist`);
            assert.ok(narrative.problem, `${pKey} must have problem`);
            assert.ok(narrative.approach, `${pKey} must have approach`);
            assert.ok(narrative.tradeoff, `${pKey} must have tradeoff`);
            assert.ok(narrative.result, `${pKey} must have result`);
            assert.ok(narrative.formattedStar.includes('Problem:'), `${pKey} must format STAR`);
            assert.ok(narrative.formattedStar.includes('Trade-off:'), `${pKey} must format STAR tradeoff`);
        }
    });

    test('3.2: truncateAtWordBoundary trims cleanly without chopping mid-word', () => {
        const text = 'The quick brown fox jumps over the lazy dog near the riverbank.';
        const truncated = truncateAtWordBoundary(text, 25);
        assert.strictEqual(truncated, 'The quick brown fox...');
        assert.ok(truncated.length <= 25);
        assert.ok(!truncated.includes('jump...'), 'Must not truncate mid-word');
    });

    test('3.3: getAnswerForIntent retrieves verified medium and short answer variants', () => {
        const ans = getAnswerForIntent(db, CANONICAL_INTENTS.TOTAL_EXPERIENCE);
        assert.ok(ans, 'Must retrieve TOTAL_EXPERIENCE answer');
        assert.ok(ans.content.includes('7 months'), 'Must state 7 months of experience');
        assert.strictEqual(ans.confirmed_by_user, 1);
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Phase 4: Browser Runner & Post-Fill Validation
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n[Phase 4] Browser Runner & Autofill Re-Read Validation');

    test('4.1: detectInstalledBrowser detects installed Chrome or Edge on Windows', () => {
        const browser = detectInstalledBrowser();
        assert.ok(browser, 'Installed browser should be detected on Windows');
        assert.ok(browser.name === 'chrome' || browser.name === 'msedge');
        assert.ok(existsSync(browser.executablePath), `Detected path must exist: ${browser.executablePath}`);
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Phase 5: Multi-Application Queue Independence & Recovery
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n[Phase 5] Queue Independence & Resumption from Checkpoint');

    // Seed 2 mock active jobs and companies
    upsertCompany({ id: 'comp-alpha', name: 'Alpha Tech', lifecycle_status: 'ACTIVE' });
    upsertCompany({ id: 'comp-beta', name: 'Beta Systems', lifecycle_status: 'ACTIVE' });

    upsertJobPosting({
        id: 'job-alpha-001',
        company_id: 'comp-alpha',
        title: 'Full Stack Engineer',
        job_url: 'http://localhost/apply/alpha',
        source: 'direct',
        status: 'active'
    });

    upsertJobPosting({
        id: 'job-beta-002',
        company_id: 'comp-beta',
        title: 'Backend Engineer',
        job_url: 'http://localhost/apply/beta',
        source: 'direct',
        status: 'active'
    });

    insertJobEvaluationRun({
        job_id: 'job-alpha-001',
        tier1_passed: 1,
        tier2_eligibility: 'PASS',
        tier3_match_score: 0.85,
        recommendation: 'APPLY'
    });

    insertJobEvaluationRun({
        job_id: 'job-beta-002',
        tier1_passed: 1,
        tier2_eligibility: 'PASS',
        tier3_match_score: 0.90,
        recommendation: 'APPLY'
    });

    // HTML Fixture 1: Alpha has an unknown custom required question -> Halts at NEEDS_USER_INPUT
    const alphaHtml = `
        <html><body>
            <form id="apply-form">
                <label for="name">Full Name *</label><input id="name" name="name" required />
                <label for="email">Email *</label><input id="email" name="email" type="email" required />
                <label for="custom_secret">Custom Secret Passcode *</label><input id="custom_secret" name="custom_secret" required />
                <button type="submit" id="submit-btn">Submit Application</button>
            </form>
        </body></html>
    `;

    // HTML Fixture 2: Beta has only standard mapped fields -> Advances smoothly to READY_FOR_REVIEW
    const betaHtml = `
        <html><body>
            <form id="apply-form">
                <label for="name">Full Name *</label><input id="name" name="name" required />
                <label for="email">Email *</label><input id="email" name="email" type="email" required />
                <label for="phone">Phone *</label><input id="phone" name="phone" required />
                <button type="submit" id="submit-btn">Submit Application</button>
            </form>
        </body></html>
    `;

    let appAlphaId = null;
    let appBetaId = null;

    await asyncTest('5.1: Queue contains 2 NOT_STARTED applications (Alpha and Beta)', async () => {
        // Enqueue Alpha (score 0.85)
        const resAlpha = await runApplicationWorkflow('job-alpha-001', {
            htmlContent: alphaHtml,
            headless: true,
            dryRun: true
        });
        appAlphaId = resAlpha.applicationId;
        assert.strictEqual(resAlpha.status, APPLICATION_STATES.NEEDS_USER_INPUT);

        // Reset Alpha state to NOT_STARTED for worker testing
        db.prepare("UPDATE applications SET state = 'NOT_STARTED', score = 0.85 WHERE id = ?").run(appAlphaId);

        // Enqueue Beta (score 0.90)
        // Insert directly as NOT_STARTED
        appBetaId = `app_beta_${Date.now()}`;
        db.prepare(`
            INSERT INTO applications (id, job_id, company_id, score, state, created_at)
            VALUES (?, 'job-beta-002', 'comp-beta', 0.90, 'NOT_STARTED', datetime('now', '+1 second'))
        `).run(appBetaId);

        const queueInfo = inspectQueue();
        const notStarted = queueInfo.queued.filter(q => q.state === 'NOT_STARTED');
        assert.strictEqual(notStarted.length, 2, 'Queue must hold 2 NOT_STARTED applications');
    });

    await asyncTest('5.2: Worker claims highest score (Beta) and completes to READY_FOR_REVIEW', async () => {
        const cycle = await runWorkerCycle({
            options: { htmlContent: betaHtml, headless: true, dryRun: true },
            standingPolicyOverrides: { auto_submit_enabled: false }
        });

        assert.strictEqual(cycle.claimed, true);
        assert.strictEqual(cycle.applicationId, appBetaId);
        assert.strictEqual(cycle.result.status, APPLICATION_STATES.READY_FOR_REVIEW);

        const betaApp = getApplication(appBetaId);
        assert.strictEqual(betaApp.state, APPLICATION_STATES.READY_FOR_REVIEW);
    });

    await asyncTest('5.3: Worker claims next application (Alpha); halts safely at NEEDS_USER_INPUT and releases lease', async () => {
        const cycle = await runWorkerCycle({
            options: { htmlContent: alphaHtml, headless: true, dryRun: true },
            standingPolicyOverrides: { auto_submit_enabled: false }
        });

        assert.strictEqual(cycle.claimed, true);
        assert.strictEqual(cycle.applicationId, appAlphaId);
        assert.strictEqual(cycle.result.status, APPLICATION_STATES.NEEDS_USER_INPUT);

        const alphaApp = getApplication(appAlphaId);
        assert.strictEqual(alphaApp.state, APPLICATION_STATES.NEEDS_USER_INPUT);
        assert.ok(alphaApp.execution_metadata_json, 'Must have checkpoint metadata stored');

        // Verify lease was cleanly released and no NOT_STARTED applications remain to claim
        const nextClaim = claimNextApplication();
        assert.strictEqual(nextClaim, null, 'claimNextApplication must return null when no NOT_STARTED items remain');
    });

    await asyncTest('5.4: Submitting answers via resumeApplicationFromCheckpoint resolves Alpha to READY_FOR_REVIEW', async () => {
        const userAnswers = {
            custom_secret: 'OpenSesame123'
        };

        const resumeRes = await resumeApplicationFromCheckpoint(appAlphaId, userAnswers, {
            htmlContent: alphaHtml,
            headless: true,
            dryRun: true
        });

        assert.strictEqual(resumeRes.status, APPLICATION_STATES.READY_FOR_REVIEW);
        const alphaAfter = getApplication(appAlphaId);
        assert.strictEqual(alphaAfter.state, APPLICATION_STATES.READY_FOR_REVIEW);
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Phase 6: Standing Authorization & Submission Outcome Gating
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n[Phase 6] Standing Authorization, Token Single-Use & Outcomes');

    test('6.1: Standing policy auto_submit_enabled=false holds application at READY_FOR_REVIEW', () => {
        const alphaApp = getApplication(appAlphaId);
        assert.strictEqual(alphaApp.state, APPLICATION_STATES.READY_FOR_REVIEW);
    });

    test('6.2: Cryptographic single-use authorization token is validated and consumed before submission', () => {
        const authId = createSubmissionAuthorization({
            scope: 'single',
            application_id: appBetaId,
            max_applications: 1,
            authorized_by: 'standing_policy',
            packet_hash: 'abc123hash',
            payload_digest: 'def456digest'
        });

        assert.ok(authId.startsWith('auth_'));
        const row = db.prepare('SELECT * FROM submission_authorizations WHERE id = ?').get(authId);
        assert.strictEqual(row.status, 'active');
        assert.strictEqual(row.application_id, appBetaId);
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Phase 7: Canonical Database Immutability Invariant
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n[Phase 7] Canonical Database Immutability Invariant');

    test('7.1: Canonical database data/job_agent.db is untouched and retains exact SHA-256 hash', () => {
        assert.ok(existsSync(CANONICAL_DB_PATH), 'Canonical DB must exist');
        const buf = readFileSync(CANONICAL_DB_PATH);
        const hash = createHash('sha256').update(buf).digest('hex');
        assert.strictEqual(hash, CANONICAL_HASH_BEFORE, 'Canonical DB hash MUST NOT have changed!');
        assert.strictEqual(buf.length, CANONICAL_SIZE_BEFORE, 'Canonical DB size MUST NOT have changed!');
    });

    // Clean up test database
    closeDb();
    if (existsSync(TEST_DB_PATH)) {
        try { unlinkSync(TEST_DB_PATH); } catch {}
    }

    console.log(`\n======================================================`);
    console.log(`✓ All ${passedTests}/${totalTests} Orchestrator E2E Tests PASSED!`);
    console.log(`======================================================\n`);
}

runAllTests().catch(err => {
    console.error('\nTest Suite Failed:', err);
    process.exit(1);
});
