/**
 * test-milestone2-regression.mjs — Milestone 2 Regression & Verification Suite
 *
 * Verifies Milestone 2 (Synthetic E2E & Tailoring Polish):
 *   1. Project Delta integration in buildTailoredResumeTex for Fullstack variant
 *   2. Project Delta selection for Real-Time / WebSocket backend variants
 *   3. 1-page budget enforcement (3 projects, 9 bullets) with Project Delta
 *   4. R16 Anti-fabrication verification on Project Delta claims
 *   5. Real Tectonic compilation of tailored resume containing Project Delta
 *   6. URL confirmation pattern detection in confirmSubmission
 *   7. Expanded DOM text phrase detection in confirmSubmission
 *   8. Post-submission full-page screenshot capture for CONFIRMED outcome
 *   9. Post-submission full-page screenshot capture for UNCERTAIN_OUTCOME
 *  10. submitApplication persisting receipt_screenshot_path in execution_metadata_json
 *  11. Canonical database immutability verification (data/job_agent.db)
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { chromium } from 'playwright';

// Set test isolation environment flags BEFORE importing modules that touch DB
const ISOLATED_DB_PATH = path.resolve('data/test_milestone2_regression.db');
process.env.CAREER_OPS_TEST = '1';
process.env.JOB_AGENT_DB_PATH = ISOLATED_DB_PATH;

if (fs.existsSync(ISOLATED_DB_PATH)) {
    fs.unlinkSync(ISOLATED_DB_PATH);
}

const CANONICAL_DB_PATH = path.resolve('data/job_agent.db');
function getFileHash(filePath) {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(content).digest('hex');
}
const CANONICAL_HASH_BEFORE = getFileHash(CANONICAL_DB_PATH);

// Dynamic imports after setting environment
const {
    buildTailoredResumeTex,
    generateLatexResume,
    validateGrounding,
    AntiFabricationViolationError,
    VERIFIED_FACTS_CORPUS
} = await import('./resume/generate-latex-resume.mjs');
const { RESUME_VARIANTS } = await import('./resume/select-variant.mjs');

// Deterministic synthetic project fixtures: Project Alpha, Beta, Gamma, Delta
const projectAlpha = {
    title: 'Project Alpha --- Subscription-Based Reward Platform',
    tech: 'React, Vite, Framer Motion, Express.js, Supabase (PostgreSQL), Stripe API, Vercel',
    date: 'Jan 2026 -- Mar 2026',
    liveDemoUrl: 'https://example.test/alpha-demo',
    sourceUrl: 'https://github.com/example-user/project-alpha',
    allowedBullets: [
        'Built a subscription platform with Stripe Checkout/Webhooks; implemented idempotency keys and atomic PostgreSQL RPCs to eliminate race conditions in charity ledger updates under concurrent webhook load.',
        'Eliminated N+1 query bottleneck in the draw engine by refactoring payout simulation to in-memory calculation with a single bulk\\_upsert RPC, reducing 2,000 sequential queries to 1.',
        'Architected zero-trust document storage with private Supabase buckets and 1-hour signed URLs for secure winner identity proof access; enforced data isolation via Row Level Security and database triggers.'
    ]
};

const projectBeta = {
    title: 'Project Beta --- Multi-Tenant API Gateway',
    tech: 'TypeScript, Node.js, Express, Redis (Lua), PostgreSQL, Prisma, Next.js, Docker, Azure VM, Caddy',
    date: 'Aug 2026 -- Oct 2026',
    liveDemoUrl: 'https://example.test/beta-demo',
    sourceUrl: 'https://github.com/example-user/project-beta',
    allowedBullets: [
        'Built a reverse proxy API gateway with longest-prefix routing using http-proxy-middleware; enforced 60-second sliding-window rate limits and monthly quotas in a single atomic Redis Lua script; API keys stored only as SHA-256 hashes.',
        'Implemented two-phase SSRF defense (route-time validation plus connection-time IP pinning) against private ranges, cloud-metadata addresses, and DNS rebinding; isolated the admin control plane on an internal Docker network, unreachable from public traffic.',
        'Wrote 108 Vitest tests across 11 suites; instrumented request tracing via X-Request-Id injection and audit logging on the admin control plane; deployed on Azure VM behind Caddy with auto-TLS.'
    ]
};

const projectGamma = {
    title: 'Project Gamma --- Distributed Code Execution Engine',
    tech: 'Next.js, TypeScript, BullMQ, Redis, Docker, PostgreSQL, Prisma ORM, Azure VM',
    date: 'Apr 2026 -- May 2026',
    liveDemoUrl: 'https://example.test/gamma-demo',
    sourceUrl: 'https://github.com/example-user/project-gamma',
    allowedBullets: [
        'Architected a distributed execution engine (BullMQ and Redis workers) supporting 5 languages; tuned Neon serverless PostgreSQL connection pooling for scale-to-zero cold-start latency under concurrent execution load.',
        'Contained hostile code in ephemeral Docker sandboxes (network-isolated, memory-capped, non-root user, read-only root filesystem, hard timeout, bounded output); deterministic verdict aggregation where TIMEOUT outranks WRONG\\_ANSWER.',
        'Designed failure handling: Redis TTL worker heartbeats, retry with backoff then Dead Letter Queue with inspect/replay/delete endpoints, validated by scripted abuse tests (infinite loops, stdout flooding, worker hard-kill).'
    ]
};

const projectDelta = {
    title: 'Project Delta --- Real-Time Collaboration Workspace',
    tech: 'React, Node.js, Socket.IO, Redis, JWT, RBAC, AWS EC2',
    date: 'Jul 2025 -- Sep 2025',
    liveDemoUrl: 'https://example.test/delta-demo',
    sourceUrl: 'https://github.com/example-user/project-delta',
    allowedBullets: [
        'Developed a real-time collaboration workspace supporting 50+ concurrent users with sub-100ms synchronization latency using Socket.IO.',
        'Leveraged a Redis-backed session store to drastically reduce direct database read loads during highly concurrent state updates.',
        'Engineered role-based access control (RBAC) and JWT authentication for secure project and document workspaces on AWS EC2.'
    ]
};

for (const k of Object.keys(VERIFIED_FACTS_CORPUS.projects)) {
    delete VERIFIED_FACTS_CORPUS.projects[k];
}

Object.assign(VERIFIED_FACTS_CORPUS.projects, {
    project_alpha: projectAlpha,
    project_beta: projectBeta,
    project_gamma: projectGamma,
    project_delta: projectDelta
});
const {
    confirmSubmission,
    URL_CONFIRMATION_PATTERNS,
    DOM_CONFIRMATION_PHRASES
} = await import('./application/submission/confirm-submission.mjs');
const { submitApplication } = await import('./application/submission/submit.mjs');
const { getDb, closeDb } = await import('./db/db.mjs');
const { runMigrations } = await import('./db/migrate.js');
const {
    createApplication,
    updateApplicationState,
    updateApplicationExecution,
    createSubmissionAuthorization,
    getSubmissionAuthorization,
    insertResumeVersion,
    APPLICATION_STATES,
    RECRUITMENT_OUTCOMES
} = await import('./db/repo.mjs');
const { computeApplicationPayloadDigest } = await import('./application/submission/policy.mjs');

// Initialize isolated test database
runMigrations(getDb(), { quiet: true });

console.log('====================================================');
console.log('🧪 MILESTONE 2 — REGRESSION & VERIFICATION SUITE');
console.log('====================================================\n');

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`  ✅ PASS: ${name}`);
        passed++;
    } catch (err) {
        console.error(`  ❌ FAIL: ${name}`);
        console.error(`     ${err.message}`);
        failed++;
    }
}

async function asyncTest(name, fn) {
    try {
        await fn();
        console.log(`  ✅ PASS: ${name}`);
        passed++;
    } catch (err) {
        console.error(`  ❌ FAIL: ${name}`);
        console.error(`     ${err.stack || err.message}`);
        failed++;
    }
}

// ── Part 1: Project Delta Resume Tailoring & Budget ─────────────────────────────
console.log('--- 1. Project Delta Resume Tailoring & Budget ---');

test('Fullstack variant default selects Core 3 (Project Alpha -> Project Beta -> Project Gamma)', () => {
    const fullstackJob = {
        title: 'Senior Fullstack Engineer',
        description: 'Building modern product features with React, Next.js, and TypeScript.'
    };
    const res = buildTailoredResumeTex({ job: fullstackJob });
    assert.strictEqual(res.variantLabel, RESUME_VARIANTS.FULLSTACK);
    assert(res.projectOrder[0].includes('Project Alpha'), 'Expected Project Alpha first');
    assert(res.projectOrder[1].includes('Project Beta'), 'Expected Project Beta second');
    assert(res.projectOrder[2].includes('Project Gamma'), 'Expected Project Gamma third');
    assert.strictEqual(res.onePageBudgetPassed, true);
    assert(res.tex.includes('Project Beta --- Multi-Tenant API Gateway'));
});

test('Real-Time / Socket.IO JD replaces Project Beta with Project Delta', () => {
    const realtimeJob = {
        title: 'Fullstack Real-Time Engineer',
        description: 'Building collaborative workspaces using React, Socket.IO, WebSockets, and Redis message channels.'
    };
    const res = buildTailoredResumeTex({ job: realtimeJob });
    assert.strictEqual(res.variantLabel, RESUME_VARIANTS.FULLSTACK);
    // Project Beta is replaced by Project Delta; Project Alpha and Project Gamma cover the rest
    assert(res.projectOrder[0].includes('Project Alpha'), 'Expected Project Alpha first');
    assert(res.projectOrder[1].includes('Project Delta'), 'Expected Project Delta second');
    assert(res.projectOrder[2].includes('Project Gamma'), 'Expected Project Gamma third');
    assert.strictEqual(res.projectOrder.some(p => p.includes('Project Beta')), false, 'Project Beta must be replaced');
    assert.strictEqual(res.onePageBudgetPassed, true);
    assert(res.tex.includes('Project Delta --- Real-Time Collaboration Workspace'));
    assert(res.tex.includes('50+ concurrent users with sub-100ms synchronization latency'));
});

test('Strict 1-page budget enforced for both Core 3 and Project Delta permutations', () => {
    for (const variant of [RESUME_VARIANTS.GENERAL, RESUME_VARIANTS.BACKEND, RESUME_VARIANTS.FULLSTACK, RESUME_VARIANTS.PLATFORM]) {
        const res = buildTailoredResumeTex({ variantLabel: variant });
        assert.strictEqual(res.onePageBudgetPassed, true);
        assert.strictEqual(res.projectOrder.length, 3);
    }
});

test('R16 Grounding Validator accepts verified Project Delta bullets and rejects fabrications', () => {
    const validProjectDeltaBullets = [
        'Developed a real-time collaboration workspace supporting 50+ concurrent users with sub-100ms synchronization latency using Socket.IO.',
        'Leveraged a Redis-backed session store to drastically reduce direct database read loads during highly concurrent state updates.',
        'Engineered role-based access control (RBAC) and JWT authentication for secure project and document workspaces on AWS EC2.'
    ];
    assert.doesNotThrow(() => {
        validateGrounding(validProjectDeltaBullets);
    });

    const fabricatedBullets = [
        'Developed Project Delta serving 1,000,000 active users at Google Cloud.'
    ];
    assert.throws(() => {
        validateGrounding(fabricatedBullets);
    }, AntiFabricationViolationError);
});

await asyncTest('Tectonic compiles Fullstack tailored resume with Project Delta to 1-page PDF', async () => {
    const tmpDir = path.resolve('output/test-milestone2-tectonic');
    try {
        const fullstackJob = {
            title: 'Fullstack Product Engineer',
            description: 'Building real-time fullstack web applications with React, Node.js, and Redis.'
        };
        const result = await generateLatexResume({
            job: fullstackJob,
            outputDir: tmpDir
        });

        assert.strictEqual(result.compiled, true, `Compilation failed: ${result.compileError}`);
        assert.strictEqual(result.engine, 'tectonic');
        assert(fs.existsSync(result.pdfPath));
        assert(result.projectOrder[1].includes('Project Delta'));
        assert.strictEqual(result.onePageBudgetPassed, true);
    } finally {
        if (fs.existsSync(tmpDir)) {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    }
});

// ── Part 2: URL & Text Pattern Confirmation Detection ───────────────────────
console.log('\n--- 2. Confirmation Detection & Receipt Verification ---');

test('URL confirmation patterns cover standard ATS redirect endpoints', () => {
    assert(URL_CONFIRMATION_PATTERNS.includes('/thank-you'));
    assert(URL_CONFIRMATION_PATTERNS.includes('/submitted'));
    assert(URL_CONFIRMATION_PATTERNS.includes('/confirmation'));
    assert(URL_CONFIRMATION_PATTERNS.includes('/application-received'));
    assert(URL_CONFIRMATION_PATTERNS.includes('/success'));
});

test('DOM text phrases cover standard ATS confirmation copy', () => {
    assert(DOM_CONFIRMATION_PHRASES.includes('thank you for applying'));
    assert(DOM_CONFIRMATION_PHRASES.includes('application submitted'));
    assert(DOM_CONFIRMATION_PHRASES.includes('application received'));
    assert(DOM_CONFIRMATION_PHRASES.includes('successfully submitted'));
    assert(DOM_CONFIRMATION_PHRASES.includes('we have received your application'));
});

// ── Part 3: Live Browser Confirmation & Screenshot Capture ──────────────────
console.log('\n--- 3. Browser Confirmation & Receipt Screenshot ---');

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();

await asyncTest('confirmSubmission detects URL redirect pattern and captures receipt screenshot', async () => {
    const page = await context.newPage();
    const screenshotsDir = path.resolve('output/test-milestone2-screenshots');
    try {
        await page.setContent('<html><body><h1>Please wait...</h1></body></html>');
        // Override page.url() to simulate post-submission redirect to a thank-you URL
        page.url = () => 'https://jobs.example.com/apply/thank-you?id=12345';

        const outcome = await confirmSubmission(page, null, {
            timeoutMs: 3000,
            applicationId: 'app_test_url_confirm',
            outputDir: screenshotsDir
        });

        assert.strictEqual(outcome.status, 'CONFIRMED');
        assert(outcome.matchedPhrase.includes('/thank-you'));
        assert(outcome.receiptScreenshotPath, 'receiptScreenshotPath must be populated');
        assert(fs.existsSync(outcome.receiptScreenshotPath), `Screenshot file ${outcome.receiptScreenshotPath} must exist`);
        assert(outcome.receiptScreenshotPath.endsWith('app_test_url_confirm_confirmation.png'));
    } finally {
        await page.close();
        if (typeof dummyPacketPath !== 'undefined' && fs.existsSync(dummyPacketPath)) {
            fs.unlinkSync(dummyPacketPath);
        }
        if (fs.existsSync(screenshotsDir)) {
            fs.rmSync(screenshotsDir, { recursive: true, force: true });
        }
    }
});

await asyncTest('confirmSubmission detects DOM phrase and captures receipt screenshot', async () => {
    const page = await context.newPage();
    const screenshotsDir = path.resolve('output/test-milestone2-screenshots-dom');
    try {
        await page.setContent(`
            <html>
                <body>
                    <h1>Success!</h1>
                    <p>We have received your application. Thank you for your interest.</p>
                </body>
            </html>
        `);

        const outcome = await confirmSubmission(page, null, {
            timeoutMs: 3000,
            applicationId: 'app_test_dom_confirm',
            outputDir: screenshotsDir
        });

        assert.strictEqual(outcome.status, 'CONFIRMED');
        assert.strictEqual(outcome.matchedPhrase, 'we have received your application');
        assert(outcome.receiptScreenshotPath, 'receiptScreenshotPath must be populated');
        assert(fs.existsSync(outcome.receiptScreenshotPath));
        assert(outcome.receiptScreenshotPath.endsWith('app_test_dom_confirm_confirmation.png'));
    } finally {
        await page.close();
        if (typeof dummyPacketPath !== 'undefined' && fs.existsSync(dummyPacketPath)) {
            fs.unlinkSync(dummyPacketPath);
        }
        if (fs.existsSync(screenshotsDir)) {
            fs.rmSync(screenshotsDir, { recursive: true, force: true });
        }
    }
});

await asyncTest('confirmSubmission on timeout produces UNCERTAIN_OUTCOME with uncertain screenshot', async () => {
    const page = await context.newPage();
    const screenshotsDir = path.resolve('output/test-milestone2-screenshots-uncertain');
    try {
        await page.setContent(`
            <html>
                <body>
                    <h1>Processing...</h1>
                    <p>Some random non-confirmation page text.</p>
                </body>
            </html>
        `);

        const outcome = await confirmSubmission(page, null, {
            timeoutMs: 1500,
            applicationId: 'app_test_uncertain',
            outputDir: screenshotsDir
        });

        assert.strictEqual(outcome.status, 'UNCERTAIN_OUTCOME');
        assert(outcome.receiptScreenshotPath, 'Screenshot must be captured even on uncertain outcome');
        assert(fs.existsSync(outcome.receiptScreenshotPath));
        assert(outcome.receiptScreenshotPath.endsWith('app_test_uncertain_uncertain.png'));
    } finally {
        await page.close();
        if (typeof dummyPacketPath !== 'undefined' && fs.existsSync(dummyPacketPath)) {
            fs.unlinkSync(dummyPacketPath);
        }
        if (fs.existsSync(screenshotsDir)) {
            fs.rmSync(screenshotsDir, { recursive: true, force: true });
        }
    }
});

// ── Part 4: Database Metadata Persistence ───────────────────────────────────
console.log('\n--- 4. Database Persistence of Receipt Screenshot ---');

await asyncTest('submitApplication persists receipt_screenshot_path to execution_metadata_json', async () => {
    const db = getDb();

    // Seed company and job
    db.prepare(`
        INSERT INTO companies (id, name, domain, policy_status)
        VALUES ('comp_m2', 'Milestone2 Tech', 'm2.test', 'permitted')
    `).run();

    db.prepare(`
        INSERT INTO job_postings (id, company_id, title, status, job_url, source)
        VALUES ('job_m2', 'comp_m2', 'Full Stack Engineer', 'active', 'https://m2.test/jobs/fullstack', 'test')
    `).run();

    const appId = createApplication({
        job_id: 'job_m2',
        company_id: 'comp_m2',
        state: APPLICATION_STATES.READY_FOR_REVIEW,
        notes: 'M2 test app'
    });

    const resumeId = insertResumeVersion({
        target_role: 'Full Stack Engineer',
        variant_label: 'fullstack',
        source_markdown: '# Resume',
        file_path: 'output/test.pdf'
    });

    const dummyPacketPath = path.resolve('output/test-milestone2-packet.md');
    const dummyPacketContent = '# Review Packet\nJob: Full Stack Engineer\nCompany: Milestone2 Tech';
    fs.mkdirSync(path.dirname(dummyPacketPath), { recursive: true });
    fs.writeFileSync(dummyPacketPath, dummyPacketContent, 'utf8');
    const packetHash = crypto.createHash('sha256').update(dummyPacketContent).digest('hex');

    updateApplicationExecution(appId, {
        resume_version_id: resumeId,
        review_packet_path: dummyPacketPath
    });

    const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId);
    const payloadDigest = computeApplicationPayloadDigest(app);

    const authId = createSubmissionAuthorization({
        scope: 'single',
        application_id: appId,
        max_applications: 1,
        authorized_by: 'user',
        packet_hash: packetHash,
        resume_version_id: resumeId,
        payload_digest: payloadDigest
    });
    const auth = getSubmissionAuthorization(authId);

    // Mock page with submit button and confirmation DOM
    const page = await context.newPage();
    const screenshotsDir = path.resolve('output/test-milestone2-submit-screenshots');

    try {
        await page.setContent(`
            <html>
                <body>
                    <form id="apply-form">
                        <button type="submit" id="submit-btn">Submit Application</button>
                    </form>
                    <script>
                        document.getElementById('apply-form').addEventListener('submit', (e) => {
                            e.preventDefault();
                            document.body.innerHTML = '<h1>Application Submitted</h1><p>Thank you for applying!</p><div id="ref">REF-M2-778899</div>';
                        });
                    </script>
                </body>
            </html>
        `);

        const mockAdapter = {
            findSubmitButton: async (p) => ({ selector: '#submit-btn', disabled: false }),
            detectConfirmation: async (p) => {
                const text = await p.evaluate(() => document.body.innerText);
                if (text.includes('Thank you for applying!')) {
                    return {
                        confirmed: true,
                        matchedPhrase: 'Thank you for applying!',
                        confirmationReference: 'REF-M2-778899',
                        url: p.url()
                    };
                }
                return null;
            }
        };

        const result = await submitApplication(page, {
            application: app,
            job: { id: 'job_m2', title: 'Full Stack Engineer', status: 'active' },
            company: { id: 'comp_m2', name: 'Milestone2 Tech', policy_status: 'permitted' },
            adapter: mockAdapter,
            authorization: auth,
            dryRun: false
        });

        assert.strictEqual(result.status, APPLICATION_STATES.CONFIRMED);
        assert.strictEqual(result.confirmationReference, 'REF-M2-778899');
        assert(result.receiptScreenshotPath, 'receiptScreenshotPath should be returned');
        assert(fs.existsSync(result.receiptScreenshotPath), 'Receipt screenshot file must exist');

        // Check database persistence in execution_metadata_json
        const updatedApp = db.prepare('SELECT * FROM applications WHERE id = ?').get(app.id);
        assert.strictEqual(updatedApp.state, APPLICATION_STATES.CONFIRMED);
        assert.strictEqual(updatedApp.recruitment_outcome, RECRUITMENT_OUTCOMES.APPLIED);
        assert(updatedApp.execution_metadata_json, 'execution_metadata_json must be populated');

        const meta = JSON.parse(updatedApp.execution_metadata_json);
        assert.strictEqual(meta.receipt_screenshot_path, result.receiptScreenshotPath, 'receipt_screenshot_path must be stored in execution_metadata_json');
    } finally {
        await page.close();
        if (typeof dummyPacketPath !== 'undefined' && fs.existsSync(dummyPacketPath)) {
            fs.unlinkSync(dummyPacketPath);
        }
        if (fs.existsSync(screenshotsDir)) {
            fs.rmSync(screenshotsDir, { recursive: true, force: true });
        }
    }
});

await context.close();
await browser.close();
closeDb();

// Clean up isolated test database
if (fs.existsSync(ISOLATED_DB_PATH)) {
    fs.unlinkSync(ISOLATED_DB_PATH);
}

// ── Part 5: Canonical Database Immutability Check ───────────────────────────
console.log('\n--- 5. Canonical Database Safety Verification ---');

test('Canonical database (data/job_agent.db) remains byte-identical', () => {
    const hashAfter = getFileHash(CANONICAL_DB_PATH);
    assert.strictEqual(
        hashAfter,
        CANONICAL_HASH_BEFORE,
        `FATAL: Canonical database was mutated! Before: ${CANONICAL_HASH_BEFORE}, After: ${hashAfter}`
    );
});

console.log('\n====================================================');
console.log(`📊 Milestone 2 Results: ${passed} PASSED, ${failed} FAILED`);
console.log('====================================================');

if (failed > 0) {
    process.exit(1);
}
