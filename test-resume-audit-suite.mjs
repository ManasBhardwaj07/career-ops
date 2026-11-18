/**
 * test-resume-audit-suite.mjs — Comprehensive Resume Pipeline Audit & Validation Suite
 *
 * Validates the complete Career-Ops resume generation pipeline:
 *   1. Truthful and grounded in verified candidate facts (Zero Fabrication - R16).
 *   2. Intelligently tailored to actual job descriptions (prioritizing matching skills, never inventing missing skills like Python).
 *   3. Structurally consistent with original resume (Structural Immutability - R17).
 *   4. Exactly one page (budget enforced and verified via decompressed XeTeX stream inspection).
 *   5. ATS-readable with clean selectable text (verified name, contact, education, employment, projects).
 *   6. Complete with verified contact details and clickable project Live Demo / Source Code links.
 *   7. Compiled successfully into PDF using local Tectonic engine with cached packages.
 *   8. Correctly associated with its application and resume version in SQLite.
 *   9. Zero mutation of the canonical database (data/job_agent.db).
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// ── Environment Isolation & Deterministic Fixtures Setup ──────────────────
const ISOLATED_DB_PATH = path.resolve('data/test_resume_audit.db');
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

// Setup self-contained synthetic LaTeX resume template fixture to isolate test from local candidate files
const SYNTHETIC_TEMPLATE_PATH = path.resolve('output/test_audit/synthetic_resume_template.tex');
fs.mkdirSync(path.dirname(SYNTHETIC_TEMPLATE_PATH), { recursive: true });


const SYNTHETIC_TEMPLATE_CONTENT = `%-------------------------
% Career-Ops Synthetic LaTeX CV Fixture
% License: MIT
%------------------------

\\documentclass[letterpaper,11pt]{article}
\\usepackage{latexsym}
\\usepackage[empty]{fullpage}
\\usepackage{titlesec}
\\usepackage{marvosym}
\\usepackage[usenames,dvipsnames]{color}
\\usepackage{verbatim}
\\usepackage{enumitem}
\\usepackage[hidelinks]{hyperref}
\\definecolor{reslink}{RGB}{0,51,102}
\\usepackage{fancyhdr}
\\usepackage[english]{babel}
\\usepackage{tabularx}
\\usepackage{fontawesome}
\\usepackage{multicol}
\\setlength{\\multicolsep}{-3.0pt}
\\setlength{\\columnsep}{-1pt}
\\ifdefined\\pdfgentounicode
  \\input{glyphtounicode}
  \\pdfgentounicode=1
\\fi
\\pagestyle{fancy}
\\fancyhf{}
\\fancyfoot{}
\\renewcommand{\\headrulewidth}{0pt}
\\renewcommand{\\footrulewidth}{0pt}
\\addtolength{\\oddsidemargin}{-0.6in}
\\addtolength{\\evensidemargin}{-0.5in}
\\addtolength{\\textwidth}{1.19in}
\\addtolength{\\topmargin}{-.7in}
\\addtolength{\\textheight}{1.4in}
\\urlstyle{same}
\\raggedbottom
\\raggedright
\\setlength{\\tabcolsep}{0in}
\\titleformat{\\section}{
  \\vspace{-7pt}\\scshape\\raggedright\\large\\bfseries
}{}{0em}{}[\\color{black}\\titlerule \\vspace{0pt}]

\\newcommand{\\resumeItem}[1]{
  \\item\\small{
    {#1 \\vspace{-3pt}}
  }
}
\\newcommand{\\resumeSubheading}[4]{
  \\vspace{-3pt}\\item
    \\begin{tabular*}{1.0\\textwidth}[t]{l@{\\extracolsep{\\fill}}r}
      \\textbf{#1} & \\textbf{\\small #2} \\\\
      \\textit{\\small#3} & \\textit{\\small #4} \\\\
    \\end{tabular*}\\vspace{-7pt}
}
\\newcommand{\\resumeSubheadingContinue}[2]{
  \\vspace{-3pt}
    \\begin{tabular*}{1.0\\textwidth}[t]{l@{\\extracolsep{\\fill}}r}
      \\textit{\\small#1} & \\textit{\\small #2} \\\\
    \\end{tabular*}\\vspace{-7pt}
}
\\newcommand{\\resumeProjectHeading}[2]{
  \\vspace{-3pt}\\item
    \\begin{tabular*}{1.0\\textwidth}[t]{p{0.82\\textwidth}@{\\extracolsep{\\fill}}r}
      \\small#1 & \\textbf{\\small #2} \\\\
    \\end{tabular*}\\vspace{-7pt}
}
\\newcommand{\\resumeSubItem}[1]{\\resumeItem{#1}\\vspace{0pt}}
\\renewcommand\\labelitemi{$\\vcenter{\\hbox{\\tiny$\\bullet$}}$}
\\renewcommand\\labelitemii{$\\vcenter{\\hbox{\\tiny$\\bullet$}}$}
\\newcommand{\\resumeSubHeadingListStart}{\\begin{itemize}[leftmargin=0.0in, label={}]}
\\newcommand{\\resumeSubHeadingListEnd}{\\end{itemize}}
\\newcommand{\\resumeItemListStart}{\\begin{itemize}[leftmargin=0.15in, topsep=0pt, itemsep=0pt, parsep=0pt]}
\\newcommand{\\resumeItemListEnd}{\\end{itemize}\\vspace{0pt}}

\\begin{document}
    \\begin{center}
        {\\Huge\\scshape Jordan Lee}
        \\\\ \\vspace{2pt} \\textbf{\\large Software Engineer $|$ Full-Stack \\& Backend Systems}
        \\\\ \\vspace{2pt} \\small +00-0000000000 ~|~
        \\href{mailto:jordan.synthetic@example.test}{\\raisebox{-0.2\\height}\\faEnvelope\\ \\underline{jordan.synthetic@example.test}} ~|~
        \\href{https://example.test/profile}{\\raisebox{-0.2\\height}\\faLinkedin\\ \\underline{jordan-lee}} ~|~
        \\href{https://github.com/example-user}{\\raisebox{-0.2\\height}\\faGithub\\ \\underline{example-user}}
    \\end{center}

\\section{Professional Summary}
\\vspace{-4pt}
\\small{Software Engineer specializing in scalable backend systems and production-grade full-stack architectures. Focused on engineering resilient distributed queue pipelines, secure reverse-proxy infrastructure, and high-concurrency transactional workflows.}

\\section{Technical Skills}
\\vspace{-7pt}
\\begin{itemize}[leftmargin=0.15in, label={}]\\small{\\item{
    \\textbf{Languages}{: JavaScript, TypeScript, Java, C++, SQL} \\\\
    \\textbf{Backend}{: Node.js, Express.js, REST APIs, BullMQ, WebSocket, Distributed Systems} \\\\
    \\textbf{Frontend}{: React.js, Next.js, Redux Toolkit, Tailwind CSS, HTML5, CSS3} \\\\
    \\textbf{Databases}{: PostgreSQL, MongoDB, Redis, Supabase, Prisma ORM} \\\\
    \\textbf{DevOps \\& QA}{: Docker, AWS EC2/S3, Azure, Git, GitHub Actions, CI/CD, Vitest, Postman}
}}
\\end{itemize}

\\section{Professional Experience}
  \\resumeSubHeadingListStart
    \\resumeSubheading
      {Acme Corp}{May 2026 -- Jul 2026}
      {Software Engineer}{Remote}
      \\resumeItemListStart
        \\resumeItem{Shipped automated test-generation system producing 250+ tests across 17 screens.}
        \\resumeItem{Built mobile UI test-automation framework on self-hosted AWS EC2 GitHub Actions runner.}
      \\resumeItemListEnd

    \\resumeSubheading
      {TechCorp}{Dec 2025 -- Mar 2026}
      {Full Stack Developer Trainee}{Remote}
      \\resumeItemListStart
        \\resumeItem{Developed full-stack web applications integrating React frontends with secure REST APIs.}
        \\resumeItem{Containerized modular microservices using Docker and implemented automated CI/CD deployment pipelines.}
      \\resumeItemListEnd
  \\resumeSubHeadingListEnd

\\section{Engineering Projects}
\\resumeSubHeadingListStart
    \\resumeProjectHeading
      {\\textbf{Project Alpha --- Subscription-Based Reward Platform} \\textbar{} {\\scriptsize\\href{https://example.test/alpha-demo}{\\textcolor{reslink}{\\underline{[Live Demo]}}} \\textbar{} \\href{https://github.com/example-user/project-alpha}{\\textcolor{reslink}{\\underline{[Source Code]}}}} \\textbar{} \\emph{React, Vite, Express, PostgreSQL}}{Jan 2026 -- Mar 2026}
      \\resumeItemListStart
        \\resumeItem{Built scalable subscription checkout flows with idempotency keys and automated reconciliation.}
      \\resumeItemListEnd
    \\resumeProjectHeading
      {\\textbf{Project Beta --- Multi-Tenant API Gateway} \\textbar{} {\\scriptsize\\href{https://example.test/beta-demo}{\\textcolor{reslink}{\\underline{[Live Demo]}}} \\textbar{} \\href{https://github.com/example-user/project-beta}{\\textcolor{reslink}{\\underline{[Source Code]}}}} \\textbar{} \\emph{TypeScript, Node.js, Express, Redis, PostgreSQL}}{Aug 2026 -- Oct 2026}
      \\resumeItemListStart
        \\resumeItem{Built reverse proxy API gateway with rate limiting and monthly quota enforcement.}
      \\resumeItemListEnd
\\resumeSubHeadingListEnd

\\section{Education}
  \\resumeSubHeadingListStart
    \\resumeSubheading
      {Synthetic University}{Sep 2022 -- May 2026}
      {Bachelor of Technology in Computer Science}{Synthetic City}
  \\resumeSubHeadingListEnd

\\end{document}
`;

fs.writeFileSync(SYNTHETIC_TEMPLATE_PATH, SYNTHETIC_TEMPLATE_CONTENT, 'utf8');
process.env.CAREER_OPS_RESUME_TEX = SYNTHETIC_TEMPLATE_PATH;

// ── Dynamic Imports ─────────────────────────────────────────────────────────
const {
    buildTailoredResumeTex,
    generateLatexResume,
    analyzeJobRequirements,
    validateGrounding,
    AntiFabricationViolationError,
    VERIFIED_FACTS_CORPUS,
    FROZEN_TEX_TEMPLATE
} = await import('./resume/generate-latex-resume.mjs');

const { generateResume } = await import('./resume/generate-resume.mjs');
const { RESUME_VARIANTS } = await import('./resume/select-variant.mjs');
const {
    validatePdf,
    validateCompiledPdf,
    extractLinksFromPdf,
    getPdfPageCount
} = await import('./resume/validate-pdf.mjs');

const { getDb, closeDb } = await import('./db/db.mjs');
const { runMigrations } = await import('./db/migrate.js');
const {
    upsertCompany,
    upsertJobPosting,
    createApplication,
    getApplication,
    getResumeVersion,
    insertResumeVersion
} = await import('./db/repo.mjs');

// Initialize isolated test database
const isolatedDb = getDb();
runMigrations(isolatedDb, { quiet: true });

// Seed deterministic synthetic candidate facts into isolated test DB
isolatedDb.prepare("INSERT OR REPLACE INTO candidate_facts (id, category, identifier, value, evidence_type, verified, created_at) VALUES ('fact-synth-name', 'identity', 'full_name', 'Jordan Lee', 'test', 1, datetime('now'))").run();
isolatedDb.prepare("INSERT OR REPLACE INTO candidate_facts (id, category, identifier, value, evidence_type, verified, created_at) VALUES ('fact-synth-email', 'contact', 'email', 'jordan.synthetic@example.test', 'test', 1, datetime('now'))").run();
isolatedDb.prepare("INSERT OR REPLACE INTO candidate_facts (id, category, identifier, value, evidence_type, verified, created_at) VALUES ('fact-synth-phone', 'contact', 'phone', '+00-0000000000', 'test', 1, datetime('now'))").run();
isolatedDb.prepare("INSERT OR REPLACE INTO candidate_facts (id, category, identifier, value, evidence_type, verified, created_at) VALUES ('fact-synth-location', 'contact', 'location', 'Synthetic City', 'test', 1, datetime('now'))").run();
isolatedDb.prepare("INSERT OR REPLACE INTO candidate_facts (id, category, identifier, value, evidence_type, verified, created_at) VALUES ('fact-synth-edu', 'education', 'degree', 'Bachelor of Technology in Computer Science, Synthetic University', 'test', 1, datetime('now'))").run();
isolatedDb.prepare("INSERT OR REPLACE INTO candidate_facts (id, category, identifier, value, evidence_type, verified, created_at) VALUES ('fact-synth-exp1', 'experience', 'swe', 'Software Engineer at Acme Corp', 'test', 1, datetime('now'))").run();
isolatedDb.prepare("INSERT OR REPLACE INTO candidate_facts (id, category, identifier, value, evidence_type, verified, created_at) VALUES ('fact-synth-exp2', 'experience', 'trainee', 'Full Stack Developer Trainee at TechCorp', 'test', 1, datetime('now'))").run();
isolatedDb.prepare("INSERT OR REPLACE INTO candidate_facts (id, category, identifier, value, evidence_type, verified, created_at) VALUES ('fact-synth-prj1', 'project', 'alpha', 'Project Alpha --- Subscription-Based Reward Platform', 'test', 1, datetime('now'))").run();
isolatedDb.prepare("INSERT OR REPLACE INTO candidate_facts (id, category, identifier, value, evidence_type, verified, created_at) VALUES ('fact-synth-prj2', 'project', 'beta', 'Project Beta --- Multi-Tenant API Gateway', 'test', 1, datetime('now'))").run();
isolatedDb.prepare("INSERT OR REPLACE INTO candidate_facts (id, category, identifier, value, evidence_type, verified, created_at) VALUES ('fact-synth-prj3', 'project', 'gamma', 'Project Gamma --- Distributed Code Execution Engine', 'test', 1, datetime('now'))").run();
isolatedDb.prepare("INSERT OR REPLACE INTO candidate_facts (id, category, identifier, value, evidence_type, verified, created_at) VALUES ('fact-synth-prj4', 'project', 'delta', 'Project Delta --- Real-Time Collaboration Workspace', 'test', 1, datetime('now'))").run();

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

// Configure deterministic synthetic project fixtures and skills on VERIFIED_FACTS_CORPUS
for (const k of Object.keys(VERIFIED_FACTS_CORPUS.projects)) {
    delete VERIFIED_FACTS_CORPUS.projects[k];
}

Object.assign(VERIFIED_FACTS_CORPUS.projects, {
    project_alpha: projectAlpha,
    project_beta: projectBeta,
    project_gamma: projectGamma,
    project_delta: projectDelta
});

if (!VERIFIED_FACTS_CORPUS.skillsPool || Object.keys(VERIFIED_FACTS_CORPUS.skillsPool).length === 0) {
    Object.assign(VERIFIED_FACTS_CORPUS.skillsPool, {
        languages: ['JavaScript', 'TypeScript', 'Java', 'C++', 'SQL'],
        backend: ['Node.js', 'Express.js', 'REST APIs', 'BullMQ', 'WebSocket', 'Distributed Systems'],
        frontend: ['React.js', 'Next.js', 'Redux Toolkit', 'Tailwind CSS', 'HTML5', 'CSS3'],
        databases: ['PostgreSQL', 'MongoDB', 'Redis', 'Supabase', 'Prisma ORM'],
        devops: ['Docker', 'AWS EC2/S3', 'Azure', 'Git', 'GitHub Actions', 'CI/CD', 'Vitest', 'Postman']
    });
}

if (!VERIFIED_FACTS_CORPUS.forbiddenClaims || VERIFIED_FACTS_CORPUS.forbiddenClaims.length === 0) {
    VERIFIED_FACTS_CORPUS.forbiddenClaims.push(
        'Google', 'Meta', 'Amazon', 'Microsoft', 'Apple', 'Netflix',
        'Director', 'VP', 'Principal Engineer', 'PhD', '500%', '10x engineer', '10 years'
    );
}

process.on('exit', () => {
    try {
        closeDb();
    } catch { }
    for (const f of [ISOLATED_DB_PATH, `${ISOLATED_DB_PATH}-wal`, `${ISOLATED_DB_PATH}-shm`, SYNTHETIC_TEMPLATE_PATH]) {
        if (fs.existsSync(f)) {
            try { fs.unlinkSync(f); } catch { }
        }
    }
});

console.log('====================================================');
console.log('🧪 CAREER-OPS — RESUME PIPELINE AUDIT & VALIDATION');
console.log('====================================================\n');

let passed = 0;
let failed = 0;

async function testAsync(name, fn) {
    try {
        await fn();
        console.log(`  ✅ PASS: ${name}`);
        passed++;
    } catch (err) {
        console.error(`  ❌ FAIL: ${name}`);
        console.error(`     Error: ${err.message}`);
        if (err.stack) {
            const firstTrace = err.stack.split('\n').slice(1, 4).join('\n');
            console.error(firstTrace);
        }
        failed++;
    }
}

function test(name, fn) {
    try {
        fn();
        console.log(`  ✅ PASS: ${name}`);
        passed++;
    } catch (err) {
        console.error(`  ❌ FAIL: ${name}`);
        console.error(`     Error: ${err.message}`);
        if (err.stack) {
            const firstTrace = err.stack.split('\n').slice(1, 4).join('\n');
            console.error(firstTrace);
        }
        failed++;
    }
}

// ── 1. Structural Immutability (R17) ─────────────────────────────────────────
console.log('--- 1. Structural Immutability & Template Integrity (R17) ---');

test('Frozen LaTeX template exists and contains valid macros & geometry', () => {
    assert(fs.existsSync(FROZEN_TEX_TEMPLATE), 'Template file must exist');
    const content = fs.readFileSync(FROZEN_TEX_TEMPLATE, 'utf8');
    assert(content.includes('\\documentclass[letterpaper,11pt]{article}'));
    assert(content.includes('\\usepackage[hidelinks]{hyperref}'));
    assert(content.includes('\\definecolor{reslink}{RGB}{0,51,102}'));
    assert(content.includes('\\resumeProjectHeading'));
});

test('Tailored TeX preserves preamble, macros, and section sequence', () => {
    const { tex } = buildTailoredResumeTex({
        variantLabel: RESUME_VARIANTS.BACKEND,
        job: { title: 'Backend Engineer', description: 'Node.js, PostgreSQL' }
    });
    assert(tex.includes('\\documentclass[letterpaper,11pt]{article}'));
    assert(tex.includes('\\section{Professional Summary}'));
    assert(tex.includes('\\section{Technical Skills}'));
    assert(tex.includes('\\section{Professional Experience}'));
    assert(tex.includes('\\section{Engineering Projects}'));
    assert(tex.includes('\\section{Education}'));
});

// ── 2. Test Case A: Full-stack JS/TS ─────────────────────────────────────────
console.log('\n--- 2. Case A: Full-Stack JS/TS Tailoring ---');

await testAsync('Case A (Full-stack): prioritizes Project Alpha, highlights TS/React/Node, compiles 1-page PDF', async () => {
    upsertCompany({ id: 'comp_audit_a', name: 'Audit Comp A' });
    const jobA = {
        id: 'job_audit_case_a',
        company_id: 'comp_audit_a',
        title: 'Senior Full-Stack Engineer',
        description: 'Building modern web applications using TypeScript, React.js, Next.js, Node.js, and PostgreSQL.',
        job_url: 'https://test.audit/jobs/a',
        source: 'test'
    };
    upsertJobPosting(jobA);

    const outDir = path.resolve('output/test_audit/case_a');
    const result = await generateLatexResume({
        job: jobA,
        outputDir: outDir,
        dryRun: false
    });

    assert.strictEqual(result.compiled, true, 'Compilation must succeed');
    assert.strictEqual(result.onePageBudgetPassed, true, 'Must pass 1-page budget');
    assert.strictEqual(result.pageCount, 1, 'Must be exactly 1 page');

    // Project ordering check: Fullstack starts with Project Alpha
    assert(result.projectOrder[0].includes('Project Alpha'), 'First project must be Project Alpha');
    assert(result.projectOrder[1].includes('Project Beta'), 'Second project must be Project Beta');
    assert(result.projectOrder[2].includes('Project Gamma'), 'Third project must be Project Gamma');

    // Skills analysis check
    assert(result.skillsAnalysis.matchedSkills.includes('TypeScript'));
    assert(result.skillsAnalysis.matchedSkills.includes('React.js'));
    assert(result.skillsAnalysis.matchedSkills.includes('Node.js'));

    // PDF validation check
    const val = validateCompiledPdf(result.pdfPath);
    assert.strictEqual(val.valid, true);
    assert.strictEqual(val.pageCount, 1);

    // Links check - exact expected synthetic URL assertions
    const links = extractLinksFromPdf(result.pdfPath);
    assert(links.includes('https://example.test/alpha-demo'), 'Must contain exact primary web demo link');
    assert(links.includes('https://github.com/example-user/project-alpha'), 'Must contain exact project repository link');
    assert(links.includes('https://example.test/beta-demo'), 'Must contain exact service demo link');

    // SQLite persistence check
    assert(result.resumeVersionId, 'Must return persisted resumeVersionId');
    const savedRv = getResumeVersion(result.resumeVersionId);
    assert.strictEqual(savedRv.id, result.resumeVersionId);
    assert.strictEqual(savedRv.job_id, jobA.id);
    assert.strictEqual(savedRv.page_count, 1);
});

// ── 3. Test Case B: Backend Python/Postgres/Docker/AWS (Zero Fabrication R16) ─
console.log('\n--- 3. Case B: Backend Python/Postgres/Docker/AWS (Zero Fabrication) ---');

await testAsync('Case B (Backend): strictly excludes Python, records gap, prioritizes Project Beta & Project Gamma', async () => {
    upsertCompany({ id: 'comp_audit_b', name: 'Audit Comp B' });
    const jobB = {
        id: 'job_audit_case_b',
        company_id: 'comp_audit_b',
        title: 'Backend Systems Engineer',
        description: 'Looking for a Backend Engineer with strong Python, PostgreSQL, Docker, and AWS experience. Fastapi and microservices.',
        job_url: 'https://test.audit/jobs/b',
        source: 'test'
    };
    upsertJobPosting(jobB);

    const outDir = path.resolve('output/test_audit/case_b');
    const result = await generateLatexResume({
        job: jobB,
        outputDir: outDir,
        dryRun: false
    });

    assert.strictEqual(result.compiled, true);
    assert.strictEqual(result.pageCount, 1);

    // CRITICAL: Anti-Fabrication check - Python must NOT be in skills or resume
    assert(result.skillsAnalysis.missingSkills.includes('Python'), 'Python must be flagged in missingSkills');
    assert(result.skillsAnalysis.claimsExcluded.includes('Python'), 'Python must be recorded in claimsExcluded');

    // Inspect the generated .tex
    const texContent = fs.readFileSync(result.texPath, 'utf8');
    assert(!/\bPython\b/i.test(texContent), 'R16 VIOLATION: Python was fabricated in LaTeX resume source!');

    // Inspect the compiled PDF extracted text
    const val = validateCompiledPdf(result.pdfPath);
    assert(!/\bPython\b/i.test(val.extractedText), 'R16 VIOLATION: Python was found in compiled PDF text!');

    // Verified skills tailored correctly
    assert(result.skillsAnalysis.matchedSkills.includes('PostgreSQL'));
    assert(result.skillsAnalysis.matchedSkills.includes('Docker'));
    assert(result.skillsAnalysis.matchedSkills.includes('AWS EC2/S3'));

    // Project ordering check: Backend starts with Project Beta
    assert(result.projectOrder[0].includes('Project Beta'));
    assert(result.projectOrder[1].includes('Project Gamma'));
    assert(result.projectOrder[2].includes('Project Alpha'));
});

// ── 4. Test Case C: Real-Time Socket.IO / Redis (Project Delta Substitution) ───
console.log('\n--- 4. Case C: Real-Time Socket.IO (Selective Project Delta Substitution) ---');

await testAsync('Case C (Real-Time): substitutes Project Beta with Project Delta when JD requires Socket.IO/collaboration', async () => {
    upsertCompany({ id: 'comp_audit_c', name: 'Audit Comp C' });
    const jobC = {
        id: 'job_audit_case_c',
        company_id: 'comp_audit_c',
        title: 'Real-Time Full-Stack Engineer',
        description: 'High-concurrency collaboration workspace requiring Socket.IO, WebSockets, Node.js, and Redis session state.',
        job_url: 'https://test.audit/jobs/c',
        source: 'test'
    };
    upsertJobPosting(jobC);

    const outDir = path.resolve('output/test_audit/case_c');
    const result = await generateLatexResume({
        job: jobC,
        outputDir: outDir,
        dryRun: false
    });

    assert.strictEqual(result.compiled, true);
    assert.strictEqual(result.pageCount, 1);

    // Project Delta substitution check: Project Beta replaced
    const hasProjectDelta = result.projectOrder.some(p => p.includes('Project Delta'));
    const hasProjectBeta = result.projectOrder.some(p => p.includes('Project Beta'));
    assert.strictEqual(hasProjectDelta, true, 'Project Delta must be included');
    assert.strictEqual(hasProjectBeta, false, 'Project Beta must be replaced when JD specifies Socket.IO collaboration');

    // Check project links in PDF - exact expected synthetic URL assertions
    const links = extractLinksFromPdf(result.pdfPath);
    assert(links.includes('https://example.test/delta-demo'), 'Must contain exact live demo link');
    assert(links.includes('https://github.com/example-user/project-delta'), 'Must contain exact project repository link');

    // ATS validation
    const val = validateCompiledPdf(result.pdfPath);
    assert.strictEqual(val.valid, true);
    assert(/project\s*delta/i.test(val.extractedText));
    assert(val.extractedText.toLowerCase().includes('socket.io'));
});

// ── 5. Test Case D: Cloud/Platform Docker/CI/CD/AWS ──────────────────────────
console.log('\n--- 5. Case D: Cloud/Platform Infrastructure Tailoring ---');

await testAsync('Case D (Platform): prioritizes Docker, AWS, CI/CD, Azure, compiles 1-page PDF', async () => {
    upsertCompany({ id: 'comp_audit_d', name: 'Audit Comp D' });
    const jobD = {
        id: 'job_audit_case_d',
        company_id: 'comp_audit_d',
        title: 'Cloud & Infrastructure Platform Engineer',
        description: 'Building robust CI/CD deployment pipelines, containerizing services with Docker, managing AWS and Azure VMs.',
        job_url: 'https://test.audit/jobs/d',
        source: 'test'
    };
    upsertJobPosting(jobD);

    const outDir = path.resolve('output/test_audit/case_d');
    const result = await generateLatexResume({
        job: jobD,
        outputDir: outDir,
        dryRun: false
    });

    assert.strictEqual(result.compiled, true);
    assert.strictEqual(result.pageCount, 1);
    assert.strictEqual(result.variantLabel, RESUME_VARIANTS.PLATFORM);

    assert(result.skillsAnalysis.matchedSkills.includes('Docker'));
    assert(result.skillsAnalysis.matchedSkills.includes('AWS EC2/S3'));
    assert(result.skillsAnalysis.matchedSkills.includes('Azure'));
    assert(result.skillsAnalysis.matchedSkills.includes('CI/CD'));

    const val = validateCompiledPdf(result.pdfPath);
    assert.strictEqual(val.valid, true);
    assert.strictEqual(val.pageCount, 1);
});

// ── 6. Unified Production Application Flow & DB Association ────────────────
console.log('\n--- 6. Unified Application Flow & Resume Association in SQLite ---');

await testAsync('generateResume delegates to LaTeX engine and links to applications table', async () => {
    upsertCompany({ id: 'comp_flow_1', name: 'Flow Comp 1' });
    const jobApp = {
        id: 'job_audit_flow_1',
        company_id: 'comp_flow_1',
        title: 'Backend Systems Developer',
        description: 'Designing high-throughput REST APIs and BullMQ distributed queues with TypeScript.',
        job_url: 'https://test.audit/jobs/flow1',
        source: 'test'
    };
    upsertJobPosting(jobApp);

    // Call generateResume (the same entry point used by application/apply.mjs)
    const resumeRes = await generateResume({
        jobId: jobApp.id,
        dryRun: false
    });

    assert(resumeRes.resumeVersionId, 'Must produce a resumeVersionId');
    assert(resumeRes.pdfPath, 'Must produce a pdfPath');
    assert(resumeRes.pdfPath.endsWith('.pdf'), 'Path must be a PDF');
    assert.strictEqual(resumeRes.pageCount, 1, 'Page count must be 1');

    // Create application associated with this resume version
    const appId = 'app_audit_flow_1';
    createApplication({
        id: appId,
        job_id: jobApp.id,
        company_id: jobApp.company_id,
        resume_version_id: resumeRes.resumeVersionId,
        state: 'DRAFTING',
        notes: 'Resume pipeline audit verification'
    });

    const retrievedApp = getApplication(appId);
    assert.strictEqual(retrievedApp.id, appId);
    assert.strictEqual(retrievedApp.resume_version_id, resumeRes.resumeVersionId);

    const retrievedRv = getResumeVersion(retrievedApp.resume_version_id);
    assert.strictEqual(retrievedRv.id, resumeRes.resumeVersionId);
    assert.strictEqual(retrievedRv.file_path, resumeRes.pdfPath);
});

// ── 7. Anti-Fabrication Hard Assertion (R16) ────────────────────────────────
console.log('\n--- 7. Anti-Fabrication Injections & Forbidden Claims (R16) ---');

test('validateGrounding strictly throws AntiFabricationViolationError on fabricated claims', () => {
    assert.throws(
        () => validateGrounding(['Led engineering at Google for 5 years']),
        AntiFabricationViolationError
    );
    assert.throws(
        () => validateGrounding(['Increased revenue by 500% across all markets']),
        AntiFabricationViolationError
    );
    assert.throws(
        () => validateGrounding(['Received PhD in Computer Science from MIT']),
        AntiFabricationViolationError
    );
});

// ── 8. Canonical Database Immutability Check ─────────────────────────────────
console.log('\n--- 8. Canonical Database Safety Verification ---');

test('Canonical database (data/job_agent.db) hash remains unaltered', () => {
    const hashAfter = getFileHash(CANONICAL_DB_PATH);
    assert.strictEqual(hashAfter, CANONICAL_HASH_BEFORE, 'Canonical database must NOT be modified');
});

// ── Summary ─────────────────────────────────────────────────────────────────
console.log('\n====================================================');
console.log(`📊 Audit Suite Results: ${passed} PASSED, ${failed} FAILED`);
console.log('====================================================');

if (failed > 0) {
    process.exit(1);
} else {
    process.exit(0);
}
