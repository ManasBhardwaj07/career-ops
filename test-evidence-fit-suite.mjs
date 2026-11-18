/**
 * test-evidence-fit-suite.mjs — Comprehensive 12-Scenario Evidence & Flexible Fit Regression Suite
 *
 * Implements Part I and Part H.5 of the Flexible Job-Fit Architecture:
 *   - Strict test isolation using disposable SQLite database (never touches data/job_agent.db).
 *   - Verifies canonical database SHA-256 before and after the run.
 *   - Tests all 12 candidate evidence and flexible fit scenarios.
 *   - Tests resume version attachment integrity and tamper rejection (Part H.5).
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// ── Environment Isolation ──────────────────────────────────────────────────
const ISOLATED_DB_PATH = path.resolve('data/test_evidence_fit.db');
process.env.CAREER_OPS_TEST = '1';
process.env.JOB_AGENT_DB_PATH = ISOLATED_DB_PATH;

if (fs.existsSync(ISOLATED_DB_PATH)) {
    fs.unlinkSync(ISOLATED_DB_PATH);
}

const CANONICAL_DB_PATH = path.resolve('data/job_agent.db');
function getFileHash(filePath) {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(content).digest('hex').toUpperCase();
}
const CANONICAL_HASH_BEFORE = getFileHash(CANONICAL_DB_PATH);
const CANONICAL_SIZE_BEFORE = fs.existsSync(CANONICAL_DB_PATH) ? fs.statSync(CANONICAL_DB_PATH).size : null;

// ── Dynamic Imports ─────────────────────────────────────────────────────────
const {
    CANDIDATE_SKILL_REGISTRY,
    SKILL_CLASSIFICATIONS,
    EVIDENCE_SOURCE_TYPES,
    findSkill,
    getClaimableSkills,
    registerCandidateSkill
} = await import('./matching/evidence-model.mjs');

const {
    REQUIREMENT_TIERS,
    APPLICATION_STRATEGIES,
    analyzeJobRequirements,
    evaluateFlexibleJobFit
} = await import('./matching/job-requirements.mjs');

const {
    generateLatexResume,
    calculatePdfHash,
    verifyResumeIntegrity,
    VERIFIED_FACTS_CORPUS
} = await import('./resume/generate-latex-resume.mjs');

const { getDb, closeDb } = await import('./db/db.mjs');
const { runMigrations } = await import('./db/migrate.js');
const {
    upsertCompany,
    upsertJobPosting,
    insertResumeVersion,
    getResumeVersion
} = await import('./db/repo.mjs');

// Initialize isolated DB
const isolatedDb = getDb();
runMigrations(isolatedDb);

let totalPassed = 0;
let totalFailed = 0;

function runTest(name, fn) {
    try {
        fn();
        console.log(`  ✓ PASS: ${name}`);
        totalPassed++;
    } catch (err) {
        console.error(`  ✗ FAIL: ${name}`);
        console.error(`    ${err.message}`);
        totalFailed++;
    }
}

async function runTestAsync(name, fn) {
    try {
        await fn();
        console.log(`  ✓ PASS: ${name}`);
        totalPassed++;
    } catch (err) {
        console.error(`  ✗ FAIL: ${name}`);
        console.error(`    ${err.message}`);
        totalFailed++;
    }
}

console.log('\n================================================================');
console.log('  CAREER-OPS: EVIDENCE MODEL & FLEXIBLE JOB-FIT TEST SUITE');
console.log('================================================================\n');

// ── Scenario 1: Strong Fit ───────────────────────────────────────────────────
runTest('Scenario 1: Strong fit — All important technical requirements verified', () => {
    const job = {
        id: 'job-scen-1',
        title: 'Full Stack Engineer',
        location: 'Bengaluru, India',
        remote_type: 'hybrid',
        description: `
            We are looking for a Full Stack Engineer proficient in:
            - Node.js and TypeScript for microservice backends
            - React for modern web frontends
            - PostgreSQL for relational persistence
            - Docker for containerized deployment
        `
    };

    const fit = evaluateFlexibleJobFit(job);
    assert.strictEqual(fit.eligible, true, 'Job must be eligible');
    assert.strictEqual(fit.strategy, APPLICATION_STRATEGIES.APPLY_STRONG_FIT, 'Strategy must be APPLY_STRONG_FIT');
    assert.strictEqual(fit.recommendation, 'APPLY', 'Recommendation must be APPLY');
    assert.ok(fit.matchScore >= 0.70, `Match score (${fit.matchScore}) must be >= 0.70`);
    assert.strictEqual(fit.retained, true, 'Job must be retained');
    assert.strictEqual(fit.analysis.missingMandatory.length, 0, 'No mandatory skills should be missing');
});

// ── Scenario 2: Partial Fit ──────────────────────────────────────────────────
runTest('Scenario 2: Partial fit — Several core skills verified, one mandatory skill missing (Python backend)', () => {
    const job = {
        id: 'job-scen-2',
        title: 'Backend Software Engineer',
        location: 'Bengaluru, India',
        remote_type: 'remote',
        description: `
            Seeking a Backend Software Engineer with:
            - Python backend microservices
            - Node.js and TypeScript
            - PostgreSQL database optimization
            - Docker and AWS deployment
        `
    };

    const fit = evaluateFlexibleJobFit(job);
    assert.strictEqual(fit.eligible, true, 'Job must remain eligible under flexible partial fit');
    assert.strictEqual(fit.strategy, APPLICATION_STRATEGIES.APPLY_PARTIAL_FIT, 'Strategy must be APPLY_PARTIAL_FIT');
    assert.strictEqual(fit.recommendation, 'CONSIDER', 'Recommendation must be CONSIDER');
    assert.ok(fit.matchScore >= 0.50, `Match score (${fit.matchScore}) must be >= 0.50`);
    assert.strictEqual(fit.retained, true, 'Opportunity must be retained, not falsely rejected');

    // Verify Python is identified as missing mandatory, but transferable skills from Node/TS provide partial credit
    const missingPython = fit.analysis.missingMandatory.find(s => s.canonical === 'Python');
    assert.ok(missingPython, 'Python must be recorded in missingMandatory');
    const transferCredit = fit.analysis.transferableSkills.find(t => t.targetSkill === 'Python');
    assert.ok(transferCredit, 'Transferable skills must provide credit for Python from Node/TS/Postgres');

    // Tailoring simulation: Python is NOT in claimable skills
    const claimable = getClaimableSkills().map(s => s.canonical.toLowerCase());
    assert.strictEqual(claimable.includes('python'), false, 'Python must NEVER be fabricated into claimable skills');
});

// ── Scenario 3: Preferred Skill Missing ──────────────────────────────────────
runTest('Scenario 3: Preferred skill missing — Mandatory verified, nice-to-have missing', () => {
    const job = {
        id: 'job-scen-3',
        title: 'Senior Backend Developer', // Note: test title vs content
        // Let's use early-career title so hard knockout doesn't trigger
        title: 'Software Engineer - Backend',
        location: 'Bengaluru, India',
        remote_type: 'hybrid',
        description: `
            Requirements:
            - Node.js, TypeScript, PostgreSQL (mandatory)
            Preferred: GraphQL, Next.js (nice to have)
        `
    };

    const fit = evaluateFlexibleJobFit(job);
    assert.strictEqual(fit.eligible, true, 'Job must be eligible');
    assert.strictEqual(fit.strategy, APPLICATION_STRATEGIES.APPLY_STRONG_FIT, 'Strategy should remain APPLY_STRONG_FIT');
    assert.strictEqual(fit.retained, true, 'Job must be retained');
    assert.strictEqual(fit.analysis.missingMandatory.length, 0, 'No mandatory skills are missing');
});

// ── Scenario 4: Skill Supported by Employment ────────────────────────────────
runTest('Scenario 4: Skill supported by employment, not project (Appium at Synthetic TechCorp)', () => {
    registerCandidateSkill({
        canonical: 'Appium',
        category: 'devops',
        classification: SKILL_CLASSIFICATIONS.VERIFIED,
        evidenceSources: [
            {
                type: EVIDENCE_SOURCE_TYPES.WORK_EXPERIENCE,
                title: 'Mobile UI Test Automation',
                entity: 'Synthetic TechCorp',
                reference: 'cv.md:EXPERIENCE:Synthetic TechCorp:bullet-1',
                description: 'Engineered automated mobile test framework'
            }
        ]
    });

    const appium = findSkill('Appium');
    assert.ok(appium, 'Appium must be found in candidate registry');
    assert.strictEqual(appium.classification, SKILL_CLASSIFICATIONS.VERIFIED, 'Appium must be VERIFIED');

    // Check evidence source is WORK_EXPERIENCE at Synthetic TechCorp
    const workEvidence = appium.evidenceSources.find(e => e.type === EVIDENCE_SOURCE_TYPES.WORK_EXPERIENCE);
    assert.ok(workEvidence, 'Appium must have WORK_EXPERIENCE evidence');
    assert.strictEqual(workEvidence.entity, 'Synthetic TechCorp', 'Evidence must be grounded in Synthetic TechCorp');
    assert.ok(workEvidence.reference.includes('Synthetic TechCorp'), 'Reference must link to Synthetic TechCorp experience');
});

// ── Scenario 5: No Project or Employment Evidence ────────────────────────────
runTest('Scenario 5: No project or employment evidence (Kubernetes & Golang)', () => {
    const k8s = findSkill('Kubernetes');
    assert.ok(k8s, 'Kubernetes must be found in candidate registry');
    assert.strictEqual(k8s.classification, SKILL_CLASSIFICATIONS.UNVERIFIED, 'Kubernetes must be UNVERIFIED');
    assert.strictEqual(k8s.evidenceSources.length, 0, 'Kubernetes must have zero verified evidence sources');

    const golang = findSkill('Golang');
    assert.ok(golang, 'Golang must be found in candidate registry');
    assert.strictEqual(golang.classification, SKILL_CLASSIFICATIONS.UNVERIFIED, 'Golang must be UNVERIFIED');
    assert.strictEqual(golang.evidenceSources.length, 0, 'Golang must have zero verified evidence sources');

    // Ensure neither appears in claimable skills
    const claimable = getClaimableSkills().map(s => s.canonical);
    assert.strictEqual(claimable.includes('Kubernetes'), false, 'Kubernetes must NOT be claimable');
    assert.strictEqual(claimable.includes('Golang'), false, 'Golang must NOT be claimable');
});

// ── Scenario 6: Candidate Explicitly Confirms Skill ──────────────────────────
runTest('Scenario 6: Candidate explicitly confirms previously unverified skill', () => {
    const prevK8s = findSkill('Kubernetes');
    assert.strictEqual(prevK8s.classification, SKILL_CLASSIFICATIONS.UNVERIFIED);

    // Candidate confirms skill with self-attested proof
    const updated = registerCandidateSkill({
        canonical: 'Kubernetes',
        category: 'cloud',
        aliases: [/\b(kubernetes|k8s)\b/i],
        classification: SKILL_CLASSIFICATIONS.VERIFIED,
        proficiency: 'intermediate',
        evidenceSources: [
            {
                type: EVIDENCE_SOURCE_TYPES.SELF_ATTESTED,
                title: 'CKA Certification & Lab Cluster',
                entity: 'Candidate Self-Attestation',
                reference: 'user-confirmed:2026-11-15',
                description: 'Configured multi-node k3s cluster with ingress and persistent volumes.'
            }
        ],
        lastVerifiedDate: '2026-11-15'
    });

    assert.strictEqual(updated.classification, SKILL_CLASSIFICATIONS.VERIFIED);
    const claimableNow = getClaimableSkills().map(s => s.canonical);
    assert.ok(claimableNow.includes('Kubernetes'), 'Kubernetes must now be claimable after explicit confirmation');

    // Revert for subsequent test purity
    registerCandidateSkill({
        canonical: 'Kubernetes',
        category: 'cloud',
        aliases: [/\b(kubernetes|k8s)\b/i],
        classification: SKILL_CLASSIFICATIONS.UNVERIFIED,
        proficiency: 'beginner',
        evidenceSources: [],
        lastVerifiedDate: null
    });
});

// ── Scenario 7: Candidate Explicitly Disclaims a Skill ───────────────────────
runTest('Scenario 7: Candidate explicitly disclaims a skill (Spring Boot / .NET)', () => {
    const spring = findSkill('Spring Boot');
    assert.ok(spring, 'Spring Boot must be in registry');
    assert.strictEqual(spring.classification, SKILL_CLASSIFICATIONS.EXPLICITLY_DISCLAIMED);

    const job = {
        id: 'job-scen-7',
        title: 'Java Spring Boot Developer',
        location: 'Bengaluru, India',
        remote_type: 'onsite',
        description: `
            We require an enterprise Java developer with 2 years of Spring Boot, Spring Data JPA, and Microservices.
        `
    };

    const fit = evaluateFlexibleJobFit(job);
    assert.strictEqual(fit.eligible, false, 'Job must NOT be eligible due to disclaimed core technology');
    assert.strictEqual(fit.strategy, APPLICATION_STRATEGIES.DO_NOT_APPLY_LOW_FIT, 'Strategy must be DO_NOT_APPLY_LOW_FIT');
    assert.strictEqual(fit.recommendation, 'DO_NOT_APPLY', 'Recommendation must be DO_NOT_APPLY');
    assert.strictEqual(fit.retained, false, 'Must NOT be retained');
    assert.ok(fit.reason.includes('explicitly disclaimed'), 'Reason must explicitly cite disclaimed technologies');
});

// ── Scenario 8: Candidate is Learning a Skill ────────────────────────────────
runTest('Scenario 8: Candidate is learning a skill (FastAPI) — Never claimed on resume', () => {
    const fastapi = findSkill('FastAPI');
    assert.ok(fastapi, 'FastAPI must be found in registry');
    assert.strictEqual(fastapi.classification, SKILL_CLASSIFICATIONS.LEARNING);

    // Learning skills MUST NOT appear in claimable skills
    const claimable = getClaimableSkills().map(s => s.canonical);
    assert.strictEqual(claimable.includes('FastAPI'), false, 'FastAPI must NOT be claimable on resume');
});

// ── Scenario 9: New Project Proposed But Not Built ───────────────────────────
runTest('Scenario 9: New project proposed but not built (PROPOSED status) — Not claimable', () => {
    const proposedProject = {
        id: 'proj-event-streaming',
        name: 'EventFlow Kafka Stream Processor',
        status: 'PROPOSED',
        targetSkills: ['Apache Kafka', 'Event-Driven Architecture'],
        verifiedArtifacts: []
    };

    assert.strictEqual(proposedProject.status, 'PROPOSED', 'Project is not yet built');
    assert.strictEqual(proposedProject.verifiedArtifacts.length, 0, 'No artifacts exist');

    // Ensure proposed project skills are NOT registered as VERIFIED
    for (const skill of proposedProject.targetSkills) {
        const found = findSkill(skill);
        const isVerified = Boolean(found && found.classification === SKILL_CLASSIFICATIONS.VERIFIED);
        assert.strictEqual(isVerified, false, `Proposed skill ${skill} must NOT be verified`);
    }
});

// ── Scenario 10: New Project Built and Verified ──────────────────────────────
runTest('Scenario 10: New project built and verified — Evidence registered & claimable', () => {
    // Simulate completing a new portfolio project with verified artifacts
    const builtProject = {
        id: 'proj-synthetic-runner',
        name: 'Synthetic Engine',
        status: 'COMPLETED',
        verifiedArtifacts: ['https://github.com/candidate/synthetic-project', 'https://synthetic-project.example.test']
    };

    // Skills associated with portfolio projects: Redis, Docker Sandboxes, BullMQ
    const redis = findSkill('Redis');
    assert.ok(redis, 'Redis skill exists');
    assert.strictEqual(redis.classification, SKILL_CLASSIFICATIONS.VERIFIED);
    const projEvidence = redis.evidenceSources.find(e => e.type === EVIDENCE_SOURCE_TYPES.PROJECT);
    assert.ok(projEvidence, 'Redis has verified evidence grounded in portfolio project');

    const claimable = getClaimableSkills().map(s => s.canonical);
    assert.ok(claimable.includes('Redis'), 'Redis is claimable on resumes');
});

// ── Scenario 11: Mixed Full-Stack and AI Requirements ────────────────────────
runTest('Scenario 11: Mixed Full-Stack and AI requirements (React, Node.js + RAG/LLM)', () => {
    const job = {
        id: 'job-scen-11',
        title: 'Full Stack AI Application Engineer',
        location: 'Bengaluru, India',
        remote_type: 'hybrid',
        description: `
            Looking for a Software Engineer to build AI-driven web apps:
            - React, TypeScript, Node.js, and PostgreSQL
            - RAG (Retrieval-Augmented Generation) pipelines and vector databases
        `
    };

    const fit = evaluateFlexibleJobFit(job);
    assert.strictEqual(fit.eligible, true, 'Job must be eligible under partial fit');
    assert.strictEqual(fit.strategy, APPLICATION_STRATEGIES.APPLY_PARTIAL_FIT, 'Strategy must be APPLY_PARTIAL_FIT');
    assert.strictEqual(fit.retained, true, 'Job should be retained, not discarded');

    // Candidate has verified LLM-assisted testing and speech-to-text in employment history,
    // but RAG is recognized as an unverified gap.
    const missingRAG = fit.analysis.missingMandatory.find(s => s.canonical.includes('RAG'));
    assert.ok(missingRAG, 'RAG must be flagged as a mandatory skill gap');

    // But transferable skills (PostgreSQL + Redis + LLM-Assisted Engineering) provide bridge
    const transfer = fit.analysis.transferableSkills.find(t => t.targetSkill.includes('RAG'));
    assert.ok(transfer, 'Transferable skills must provide a bridge for RAG');

    // Grounding check: RAG is NEVER fabricated into claimable skills
    const claimable = getClaimableSkills().map(s => s.canonical.toLowerCase());
    assert.strictEqual(claimable.includes('rag (retrieval-augmented generation)'), false);
});

// ── Scenario 12: Genuine Hard Eligibility Failure ────────────────────────────
runTest('Scenario 12: Genuine hard eligibility failure (US Citizenship without sponsorship)', () => {
    const job = {
        id: 'job-scen-12-us',
        title: 'Software Engineer',
        location: 'San Francisco, CA',
        remote_type: 'onsite',
        description: `
            Must be a U.S. Citizen with active security clearance. No visa sponsorship provided.
        `
    };

    const fit = evaluateFlexibleJobFit(job);
    assert.strictEqual(fit.eligible, false, 'Job must fail hard eligibility');
    assert.strictEqual(fit.matchScore, 0.0, 'Match score must be 0.0');
    assert.strictEqual(fit.strategy, APPLICATION_STRATEGIES.REJECT_HARD_KNOCKOUT);
    assert.strictEqual(fit.recommendation, 'DO_NOT_APPLY');
    assert.strictEqual(fit.retained, false);
    assert.ok(fit.analysis.hardKnockouts.length > 0, 'Hard knockout must be registered');
    assert.strictEqual(fit.analysis.hardKnockouts[0].gate, 'citizenship_authorization');
});

runTest('Scenario 12b: Genuine hard eligibility failure (Seniority threshold: 5+ years / Staff)', () => {
    const job = {
        id: 'job-scen-12-sr',
        title: 'Staff Software Engineer - Infrastructure',
        location: 'Bengaluru, India',
        remote_type: 'hybrid',
        description: `
            Looking for a Staff Software Engineer with 7+ years of experience leading distributed systems.
        `
    };

    const fit = evaluateFlexibleJobFit(job);
    assert.strictEqual(fit.eligible, false, 'Job must fail hard seniority eligibility');
    assert.strictEqual(fit.matchScore, 0.0, 'Match score must be 0.0');
    assert.strictEqual(fit.strategy, APPLICATION_STRATEGIES.REJECT_HARD_KNOCKOUT);
    assert.strictEqual(fit.retained, false);
    assert.strictEqual(fit.analysis.hardKnockouts[0].gate, 'seniority_threshold');
});

// ── Scenario 13 / Part H.5: Resume Attachment Integrity & Tamper Rejection ───
await runTestAsync('Part H.5: Attachment Integrity & Tamper Rejection', async () => {
    // 1. Create company and job in isolated DB
    const compId = 'comp-integ-1';
    upsertCompany({
        id: compId,
        name: 'Integrity Tech Labs',
        domain: 'integritylabs.test',
        careers_url: 'https://integritylabs.test/careers'
    });

    const jobId = 'job-integ-1';
    upsertJobPosting({
        id: jobId,
        company_id: compId,
        title: 'Full Stack Engineer',
        external_id: 'integ-101',
        job_url: 'https://integritylabs.test/jobs/integ-101',
        source: 'greenhouse',
        description: 'Full stack development with Node.js, React, and PostgreSQL.',
        location: 'Bengaluru, India'
    });

    // 2. Generate and compile a real PDF via generateLatexResume
    const outDir = path.resolve('scratch/test_integrity_evidence');
    const result = await generateLatexResume({
        job: { id: jobId, title: 'Full Stack Engineer', description: 'Node.js, React, and PostgreSQL' },
        outputDir: outDir,
        dryRun: false
    });

    assert.strictEqual(result.compiled, true, 'Resume must compile successfully');
    assert.ok(result.resumeVersionId, 'Resume version must be inserted into isolated DB');

    // 3. Retrieve registered resume_version record from isolated DB
    const rv = getResumeVersion(result.resumeVersionId);
    assert.ok(rv, 'Resume version record must exist in DB');
    assert.ok(rv.tailoring_facts_json, 'tailoring_facts_json must exist');

    const facts = JSON.parse(rv.tailoring_facts_json);
    assert.ok(facts.pdf_sha256, 'pdf_sha256 must be registered in tailoring_facts_json');

    // 4. Verify legitimate byte-identical file passes verification
    const verifySuccess = verifyResumeIntegrity(rv, result.pdfPath);
    assert.strictEqual(verifySuccess.verified, true, 'Byte-identical PDF must pass integrity check');
    assert.strictEqual(verifySuccess.hash, facts.pdf_sha256, 'Hash must match registered SHA-256');

    // 5. Tamper test: create a mutated copy of the PDF and verify it throws integrity error
    const tamperedPdfPath = path.resolve(outDir, 'tampered_resume.pdf');
    const pdfBytes = fs.readFileSync(result.pdfPath);
    // Flip one byte near the end
    const tamperedBytes = Buffer.from(pdfBytes);
    tamperedBytes[tamperedBytes.length - 10] = tamperedBytes[tamperedBytes.length - 10] ^ 0xFF;
    fs.writeFileSync(tamperedPdfPath, tamperedBytes);

    assert.throws(
        () => verifyResumeIntegrity(rv, tamperedPdfPath),
        /Resume integrity violation/,
        'Tampered PDF must trigger Resume integrity violation error'
    );
});

// ── Canonical DB Integrity Verification ──────────────────────────────────────
runTest('Canonical DB Invariant: data/job_agent.db remains 100% byte-identical', () => {
    closeDb();
    const CANONICAL_HASH_AFTER = getFileHash(CANONICAL_DB_PATH);
    const CANONICAL_SIZE_AFTER = fs.statSync(CANONICAL_DB_PATH).size;

    assert.strictEqual(
        CANONICAL_HASH_AFTER,
        CANONICAL_HASH_BEFORE,
        `Canonical DB hash altered! Before: ${CANONICAL_HASH_BEFORE}, After: ${CANONICAL_HASH_AFTER}`
    );
    assert.strictEqual(CANONICAL_SIZE_AFTER, CANONICAL_SIZE_BEFORE, `Canonical DB size must remain unchanged: was ${CANONICAL_SIZE_BEFORE}, now ${CANONICAL_SIZE_AFTER}`);
    console.log(`    Canonical DB Hash: ${CANONICAL_HASH_AFTER} (${CANONICAL_SIZE_AFTER} bytes) [VERIFIED UNTOUCHED]`);
});

console.log('\n----------------------------------------------------------------');
console.log(`Test Execution Finished: ${totalPassed} Passed, ${totalFailed} Failed.`);
console.log('----------------------------------------------------------------\n');

if (totalFailed > 0) {
    process.exit(1);
}
