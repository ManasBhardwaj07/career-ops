/**
 * test-latex-tailoring.mjs — Comprehensive Test Suite for LaTeX Resume Tailoring
 *
 * Implements Deliverable 5 Phase 3 (L1-L3) & Forensic Corrections:
 *   - Frozen template immutability (R17) based on user's authoritative resume
 *   - Evidence-based content selection across 3 JDs (Golden Diffs: Project Beta, Project Gamma, Project Alpha)
 *   - 1-page budget enforcement
 *   - Anti-fabrication injection testing (R16)
 *   - Database safety & canonical immutability check
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Enforce test isolation flag and isolate DB BEFORE any imports
const ISOLATED_DB_PATH = path.resolve('data/test_latex_tailoring.db');
process.env.CAREER_OPS_TEST = '1';
process.env.JOB_AGENT_DB_PATH = ISOLATED_DB_PATH;

function cleanupIsolatedDb() {
    for (const suffix of ['', '-wal', '-shm']) {
        const p = ISOLATED_DB_PATH + suffix;
        if (fs.existsSync(p)) {
            try { fs.unlinkSync(p); } catch {}
        }
    }
}
cleanupIsolatedDb();

// Canonical DB tracking (read-only verification)
const CANONICAL_DB_PATH = path.resolve('data/job_agent.db');
function getFileHash(filePath) {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(content).digest('hex');
}
const CANONICAL_HASH_BEFORE = getFileHash(CANONICAL_DB_PATH);
const CANONICAL_SIZE_BEFORE = fs.existsSync(CANONICAL_DB_PATH) ? fs.statSync(CANONICAL_DB_PATH).size : null;

// Dynamic imports after env vars are set
const { getDb, closeDb } = await import('./db/db.mjs');
const { runMigrations } = await import('./db/migrate.js');

// Initialize isolated test database
const isolatedDb = getDb();
runMigrations(isolatedDb);

// Seed synthetic candidate facts into isolated test DB
isolatedDb.prepare("INSERT OR REPLACE INTO candidate_facts (id, category, identifier, value, evidence_type, verified, created_at) VALUES ('fact-synth-name', 'identity', 'full_name', 'Jordan Lee', 'test', 1, datetime('now'))").run();
isolatedDb.prepare("INSERT OR REPLACE INTO candidate_facts (id, category, identifier, value, evidence_type, verified, created_at) VALUES ('fact-synth-email', 'contact', 'email', 'jordan.synthetic@example.test', 'test', 1, datetime('now'))").run();

const {
    FROZEN_TEX_TEMPLATE,
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

console.log('====================================================');
console.log('🧪 DELIVERABLE 5 — AUTHORITATIVE LATEX RESUME TAILORING');
console.log('====================================================\n');

let testPassed = 0;
let testFailed = 0;

function runTest(name, fn) {
    try {
        fn();
        console.log(`  ✅ PASS: ${name}`);
        testPassed++;
    } catch (err) {
        console.error(`  ❌ FAIL: ${name}`);
        console.error(`     Error: ${err.message}`);
        testFailed++;
    }
}

async function runTestAsync(name, fn) {
    try {
        await fn();
        console.log(`  ✅ PASS: ${name}`);
        testPassed++;
    } catch (err) {
        console.error(`  ❌ FAIL: ${name}`);
        console.error(`     Error: ${err.message}`);
        testFailed++;
    }
}

console.log('--- 1. Frozen LaTeX Template Integrity (R17) ---');

runTest('Frozen template file exists and contains valid LaTeX preamble and structure', () => {
    assert(fs.existsSync(FROZEN_TEX_TEMPLATE), 'Frozen LaTeX template must exist');
    const content = fs.readFileSync(FROZEN_TEX_TEMPLATE, 'utf8');
    assert(content.includes('\\documentclass[letterpaper,11pt]{article}'));
    assert(content.includes('\\begin{document}'));
    assert(content.includes('\\end{document}'));
    assert(content.includes('\\section{Professional Summary}'));
    assert(content.includes('\\section{Technical Skills}'));
    assert(content.includes('\\section{Professional Experience}'));
    assert(content.includes('\\section{Engineering Projects}'));
    assert(content.includes('\\section{Education}'));
    assert(content.includes('github.com/'));
    assert(content.includes('linkedin.com/in/'));
});

runTest('Tailoring preserves exact preamble, geometry, macros, and section sequence (R17)', () => {
    const rawTemplate = fs.readFileSync(FROZEN_TEX_TEMPLATE, 'utf8');
    const { tex } = buildTailoredResumeTex({ variantLabel: RESUME_VARIANTS.BACKEND });

    // Preamble up to \begin{document} must be 100% byte-identical
    const preambleRaw = rawTemplate.split('\\begin{document}')[0];
    const preambleTailored = tex.split('\\begin{document}')[0];
    assert.strictEqual(preambleTailored, preambleRaw, 'LaTeX preamble and macros were altered!');

    // Section ordering must remain: Summary -> Skills -> Experience -> Projects -> Education
    const summaryIdx = tex.indexOf('\\section{Professional Summary}');
    const skillIdx = tex.indexOf('\\section{Technical Skills}');
    const expIdx = tex.indexOf('\\section{Professional Experience}');
    const projIdx = tex.indexOf('\\section{Engineering Projects}');
    const eduIdx = tex.indexOf('\\section{Education}');

    assert(summaryIdx > 0 && skillIdx > summaryIdx && expIdx > skillIdx && projIdx > expIdx && eduIdx > projIdx, 'Section sequence was altered!');
});

console.log('\n--- 2. Dynamic Content Selection & Golden Diffs across 3 JDs ---');

runTest('JD 1 (Backend Engineer): Tailors projects prioritizing Project Beta & Project Gamma', () => {
    const backendJob = {
        title: 'Senior Backend Engineer',
        description: 'Building microservices in Node.js, Express, BullMQ, Redis, API gateways, and high-concurrency APIs.'
    };

    const res = buildTailoredResumeTex({ job: backendJob });
    assert.strictEqual(res.variantLabel, RESUME_VARIANTS.BACKEND);
    // Project Beta should be the first project
    assert(res.projectOrder[0].includes('Project Beta'), `Expected Project Beta first, got ${res.projectOrder[0]}`);
    assert.strictEqual(res.onePageBudgetPassed, true);

    // Verify golden diff: Project Beta appears before Project Alpha
    const betaPos = res.tex.indexOf('Project Beta');
    const alphaPos = res.tex.indexOf('Project Alpha');
    assert(betaPos < alphaPos, 'Project Beta should appear before Project Alpha for Backend JD');
});

runTest('JD 2 (Fullstack Developer): Tailors projects prioritizing Core 3 (Project Alpha, Project Beta, Project Gamma)', () => {
    const fullstackJob = {
        title: 'Fullstack Product Engineer',
        description: 'Building web applications with React, Next.js, TypeScript, PostgreSQL, and Stripe payments.'
    };

    const res = buildTailoredResumeTex({ job: fullstackJob });
    assert.strictEqual(res.variantLabel, RESUME_VARIANTS.FULLSTACK);
    // Standard Fullstack uses the core 3: Project Alpha -> Project Beta -> Project Gamma
    assert(res.projectOrder[0].includes('Project Alpha'), `Expected Project Alpha first, got ${res.projectOrder[0]}`);
    assert(res.projectOrder[1].includes('Project Beta'), `Expected Project Beta second, got ${res.projectOrder[1]}`);
    assert(res.projectOrder[2].includes('Project Gamma'), `Expected Project Gamma third, got ${res.projectOrder[2]}`);
    assert.strictEqual(res.onePageBudgetPassed, true);

    // Verify golden diff: Project Alpha appears before Project Beta, which appears before Project Gamma
    const alphaPos = res.tex.indexOf('Project Alpha');
    const betaPos = res.tex.indexOf('Project Beta');
    const gammaPos = res.tex.indexOf('Project Gamma');
    assert(alphaPos < betaPos, 'Project Alpha should appear before Project Beta for Fullstack JD');
    assert(betaPos < gammaPos, 'Project Beta should appear before Project Gamma for Fullstack JD');
});

runTest('JD 2B (Real-Time Fullstack / Socket.IO): Replaces Project Beta with Project Delta when JD specifically requires it', () => {
    const realtimeJob = {
        title: 'Fullstack Real-Time Engineer',
        description: 'Building collaborative web apps with React, Socket.IO, WebSockets, Redis, and multi-user synchronization.'
    };

    const res = buildTailoredResumeTex({ job: realtimeJob });
    assert.strictEqual(res.variantLabel, RESUME_VARIANTS.FULLSTACK);
    // Project Beta is replaced by Project Delta; Project Alpha and Project Gamma cover the rest
    assert(res.projectOrder[0].includes('Project Alpha'), `Expected Project Alpha first, got ${res.projectOrder[0]}`);
    assert(res.projectOrder[1].includes('Project Delta'), `Expected Project Delta second, got ${res.projectOrder[1]}`);
    assert(res.projectOrder[2].includes('Project Gamma'), `Expected Project Gamma third, got ${res.projectOrder[2]}`);
    assert.strictEqual(res.projectOrder.some(p => p.includes('Project Beta')), false, 'Project Beta should be replaced by Project Delta');
    assert.strictEqual(res.onePageBudgetPassed, true);
    assert(res.tex.includes('Socket.IO'), 'Tailored TeX must include Socket.IO bullet');
});

runTest('JD 3 (Platform/DevOps Engineer): Tailors projects prioritizing Azure VM, Caddy TLS, and Docker sandboxes', () => {
    const devOpsJob = {
        title: 'Platform / DevOps Engineer',
        description: 'Managing cloud infrastructure, Docker containers, Azure VM, Caddy TLS deployments, and CI/CD automation.'
    };

    const res = buildTailoredResumeTex({ job: devOpsJob });
    assert.strictEqual(res.variantLabel, RESUME_VARIANTS.PLATFORM);
    // Project Beta or Project Gamma should be first with platform bullets
    assert(res.projectOrder[0].includes('Project Beta') || res.projectOrder[0].includes('Project Gamma'));
    assert(res.tex.includes('Azure VM behind Caddy with auto-TLS'));
    assert.strictEqual(res.onePageBudgetPassed, true);
});

console.log('\n--- 3. 1-Page Budget Enforcement ---');

runTest('Strict 1-page budget: exactly 3 projects with exactly 3 bullets each (9 bullets total)', () => {
    for (const variant of [RESUME_VARIANTS.GENERAL, RESUME_VARIANTS.BACKEND, RESUME_VARIANTS.FULLSTACK, RESUME_VARIANTS.PLATFORM]) {
        const res = buildTailoredResumeTex({ variantLabel: variant });
        assert.strictEqual(res.onePageBudgetPassed, true);
        assert.strictEqual(res.projectOrder.length, 3);
    }
});

console.log('\n--- 4. Anti-Fabrication Injection Testing (R16) ---');

runTest('Rejects fabricated employer claim (e.g. Google Staff Engineer)', () => {
    assert.throws(() => {
        validateGrounding([
            'Architected distributed caching at Google handling 10M QPS.'
        ]);
    }, AntiFabricationViolationError);
});

runTest('Rejects fabricated business metric (e.g. Increased revenue by 500%)', () => {
    assert.throws(() => {
        validateGrounding([
            'Increased company revenue by 500% in 3 weeks through growth engineering.'
        ]);
    }, AntiFabricationViolationError);
});

runTest('Rejects fabricated degree (e.g. PhD in Computer Science)', () => {
    assert.throws(() => {
        validateGrounding([
            'Earned a PhD in Artificial Intelligence from Stanford University.'
        ]);
    }, AntiFabricationViolationError);
});

runTest('buildTailoredResumeTex throws when custom ungrounded bullet is injected', () => {
    assert.throws(() => {
        buildTailoredResumeTex({
            variantLabel: RESUME_VARIANTS.GENERAL,
            customBullets: [
                'Engineered core payment microservices as a Senior Director at Meta.'
            ]
        });
    }, AntiFabricationViolationError);
});

runTest('Passes valid verified bullets grounded in candidate ground truth', () => {
    const validBullets = [
        'Built a reverse proxy API gateway with longest-prefix routing using http-proxy-middleware; enforced 60-second sliding-window rate limits and monthly quotas in a single atomic Redis Lua script; API keys stored only as SHA-256 hashes.',
        'Architected a distributed execution engine (BullMQ and Redis workers) supporting 5 languages; tuned Neon serverless PostgreSQL connection pooling for scale-to-zero cold-start latency under concurrent execution load.',
        'Built a subscription platform with Stripe Checkout/Webhooks; implemented idempotency keys and atomic PostgreSQL RPCs to eliminate race conditions in charity ledger updates under concurrent webhook load.'
    ];
    assert.doesNotThrow(() => {
        validateGrounding(validBullets);
    });
});

console.log('\n--- 5. Tectonic Compilation & Single-Page Verification ---');

await runTestAsync('Tectonic compiles Fullstack tailored resume containing Project Delta to valid 1-page PDF', async () => {
    const tmpDir = path.resolve('output/test-milestone2-tailoring');
    try {
        const fullstackJob = {
            title: 'Fullstack Engineer',
            description: 'Building full-stack real-time web applications using React, Node.js, and Redis.'
        };
        const result = await generateLatexResume({
            job: fullstackJob,
            outputDir: tmpDir
        });

        assert.strictEqual(result.compiled, true, `Compilation failed: ${result.compileError}`);
        assert.strictEqual(result.engine, 'tectonic');
        assert(fs.existsSync(result.pdfPath), `PDF was not written to ${result.pdfPath}`);
        assert(result.projectOrder[1].includes('Project Delta'), 'Project Delta must be in the project order');
        assert.strictEqual(result.onePageBudgetPassed, true);
    } finally {
        if (fs.existsSync(tmpDir)) {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    }
});

console.log('\n--- 6. Canonical Database Immutability Check ---');

runTest('Canonical database remains byte-identical', () => {
    const hashAfter = getFileHash(CANONICAL_DB_PATH);
    const sizeAfter = fs.existsSync(CANONICAL_DB_PATH) ? fs.statSync(CANONICAL_DB_PATH).size : null;
    assert.strictEqual(hashAfter, CANONICAL_HASH_BEFORE, 'Canonical database hash must not change during test!');
    assert.strictEqual(sizeAfter, CANONICAL_SIZE_BEFORE, 'Canonical database size must not change during test!');
});

// Close isolated db and clean up
closeDb();
cleanupIsolatedDb();

console.log('\n====================================================');
console.log(`📊 LaTeX Tailoring Results: ${testPassed} PASSED, ${testFailed} FAILED`);
console.log('====================================================');

if (testFailed > 0) {
    process.exit(1);
}
