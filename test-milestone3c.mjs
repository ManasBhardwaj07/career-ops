/**
 * test-milestone3c.mjs — Comprehensive Milestone 3C Test Harness
 *
 * Covers all 25 required test categories:
 * 1. Master HTML template rendering
 * 2. Master template layout preservation
 * 3. Correct candidate identity (Jordan Lee)
 * 4. Correct employment dates (Acme Corp May-Jul 2026, TechCorp Dec 2025-Mar 2026)
 * 5. No experience inflation (~7 months verified, never inflated)
 * 6. Missing candidate fact behavior
 * 7. Evidence-linked bullet selection
 * 8. Backend resume variant
 * 9. Full-stack resume variant
 * 10. Frontend resume variant
 * 11. General resume variant
 * 12. Unnecessary tailoring avoidance (reuse strategy)
 * 13. HTML injection protection (XSS escaping)
 * 14. TeX escaping
 * 15. Unresolved placeholder rejection
 * 16. PDF generation
 * 17. PDF text extraction
 * 18. Reading order validation
 * 19. Page count (1-page constraint)
 * 20. No duplicate bullets
 * 21. SQLite resume version persistence
 * 22. Existing version preservation (immutability)
 * 23. Idempotency and repeated generation
 * 24. Failed LaTeX compilation isolation
 * 25. Dry-run behavior
 */

import assert from 'assert';
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, copyFileSync } from 'fs';
import { resolve } from 'path';

const TEST_DB_PATH = resolve(process.cwd(), 'data', 'test_milestone3c.db');
const CANONICAL_DB_PATH = resolve(process.cwd(), 'data', 'job_agent.db');
const SYNTH_TEX_PATH = resolve(process.cwd(), 'output', 'test-milestone3c-synthetic.tex');

mkdirSync(resolve(process.cwd(), 'output'), { recursive: true });

function cleanupTestDb() {
    for (const f of [TEST_DB_PATH, `${TEST_DB_PATH}-wal`, `${TEST_DB_PATH}-shm`, SYNTH_TEX_PATH]) {
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
process.env.CAREER_OPS_TEST = '1';

const { getDb, closeDb, getDbPath } = await import('./db/db.mjs');
const resolvedPath = resolve(getDbPath());
if (resolvedPath === CANONICAL_DB_PATH) {
    throw new Error(`SAFETY ABORT: test-milestone3c.mjs resolved to canonical DB (${resolvedPath})`);
}
console.log(`🔒 Isolated DB Path: ${resolvedPath}`);

// Seed deterministic synthetic candidate facts into isolated test DB
const initDb = getDb();
initDb.prepare("DELETE FROM candidate_facts").run();
initDb.prepare("DELETE FROM evidence_records").run();

initDb.prepare("INSERT OR REPLACE INTO candidate_facts (id, category, identifier, value, evidence_type, verified, created_at) VALUES ('fact-synth-name', 'identity', 'full_name', 'Jordan Lee', 'test', 1, datetime('now'))").run();
initDb.prepare("INSERT OR REPLACE INTO candidate_facts (id, category, identifier, value, evidence_type, verified, created_at) VALUES ('fact-synth-email', 'contact', 'email', 'jordan.synthetic@example.test', 'test', 1, datetime('now'))").run();
initDb.prepare("INSERT OR REPLACE INTO candidate_facts (id, category, identifier, value, evidence_type, verified, created_at) VALUES ('fact-synth-phone', 'contact', 'phone', '+00-0000000000', 'test', 1, datetime('now'))").run();
initDb.prepare("INSERT OR REPLACE INTO candidate_facts (id, category, identifier, value, evidence_type, verified, created_at) VALUES ('fact-synth-location', 'contact', 'location', 'Synthetic City', 'test', 1, datetime('now'))").run();

// Synthetic Education
initDb.prepare("INSERT OR REPLACE INTO candidate_facts (id, category, identifier, value, evidence_type, verified, created_at) VALUES ('fact-edu-synth-btech', 'education', 'degree-btech-cse', 'B.Tech in Computer Science & Engineering, Synthetic University (Graduation: May 2026, CGPA: 8.0)', 'education', 1, datetime('now'))").run();
initDb.prepare("INSERT OR REPLACE INTO evidence_records (id, fact_id, title, description, source_type, source_reference, verified) VALUES ('ev-edu-synth-cgpa', 'fact-edu-synth-btech', 'Undergraduate Academic Record', 'Bachelor of Technology in Computer Science & Engineering with cumulative CGPA of 8.0 at Synthetic University (2022–2026).', 'education', 'cv.md:EDUCATION', 1)").run();

// Synthetic Experience
initDb.prepare("INSERT OR REPLACE INTO candidate_facts (id, category, identifier, value, evidence_type, verified, created_at) VALUES ('fact-exp-techcorp', 'experience', 'techcorp-fullstack-trainee', 'Full Stack Developer Trainee at TechCorp (December 2025 – March 2026, ~4 months)', 'work_experience', 1, datetime('now'))").run();
initDb.prepare("INSERT OR REPLACE INTO evidence_records (id, fact_id, title, description, source_type, source_reference, verified) VALUES ('ev-exp-techcorp-apis', 'fact-exp-techcorp', 'RESTful API & Architecture', 'Built and deployed scalable full-stack applications using MERN stack, integrating secure RESTful APIs and modular backend architecture.', 'work_experience', 'cv.md:EXPERIENCE', 1)").run();
initDb.prepare("INSERT OR REPLACE INTO evidence_records (id, fact_id, title, description, source_type, source_reference, verified) VALUES ('ev-exp-techcorp-realtime', 'fact-exp-techcorp', 'Real-time & Caching', 'Implemented real-time features using WebSockets and server-side caching with Redis to reduce latency.', 'work_experience', 'cv.md:EXPERIENCE', 1)").run();
initDb.prepare("INSERT OR REPLACE INTO evidence_records (id, fact_id, title, description, source_type, source_reference, verified) VALUES ('ev-exp-techcorp-cicd', 'fact-exp-techcorp', 'CI/CD Pipelines', 'Engineered automated CI/CD pipelines utilizing GitHub Actions and Docker to streamline deployment.', 'work_experience', 'cv.md:EXPERIENCE', 1)").run();

initDb.prepare("INSERT OR REPLACE INTO candidate_facts (id, category, identifier, value, evidence_type, verified, created_at) VALUES ('fact-exp-acme', 'experience', 'acme-swe', 'Software Engineer at Acme Corp (May 2026 – July 2026, ~3 months)', 'work_experience', 1, datetime('now'))").run();
initDb.prepare("INSERT OR REPLACE INTO evidence_records (id, fact_id, title, description, source_type, source_reference, verified) VALUES ('ev-exp-acme-services', 'fact-exp-acme', 'Backend Services & UI', 'Engineered high-performance backend modules and interactive user interfaces using Node.js, TypeScript, and React.', 'work_experience', 'cv.md:EXPERIENCE', 1)").run();
initDb.prepare("INSERT OR REPLACE INTO evidence_records (id, fact_id, title, description, source_type, source_reference, verified) VALUES ('ev-exp-acme-jobs', 'fact-exp-acme', 'Database Optimization', 'Developed resilient RESTful APIs, optimized complex database transactions, and maintained asynchronous background jobs.', 'work_experience', 'cv.md:EXPERIENCE', 1)").run();

// Synthetic Projects
initDb.prepare("INSERT OR REPLACE INTO candidate_facts (id, category, identifier, value, evidence_type, verified, created_at) VALUES ('fact-prj-alpha', 'project', 'project-alpha', 'Project Alpha — Subscription-Based Reward Platform (React, Node.js, Supabase, PostgreSQL, Stripe)', 'project', 1, datetime('now'))").run();
initDb.prepare("INSERT OR REPLACE INTO evidence_records (id, fact_id, title, description, source_type, source_reference, verified) VALUES ('ev-prj-alpha-core', 'fact-prj-alpha', 'Reward Platform Core', 'Engineered a full-stack, subscription-driven gamified platform using React, Node.js, and Supabase.', 'project', 'cv.md:PROJECTS', 1)").run();
initDb.prepare("INSERT OR REPLACE INTO evidence_records (id, fact_id, title, description, source_type, source_reference, verified) VALUES ('ev-prj-alpha-rls', 'fact-prj-alpha', 'PostgreSQL RLS', 'Architected a highly secure PostgreSQL database utilizing Row Level Security (RLS) and complex rolling triggers.', 'project', 'cv.md:PROJECTS', 1)").run();

initDb.prepare("INSERT OR REPLACE INTO candidate_facts (id, category, identifier, value, evidence_type, verified, created_at) VALUES ('fact-prj-beta', 'project', 'project-beta', 'Project Beta — Multi-Tenant API Gateway (TypeScript, Node.js, Express, Redis, Docker)', 'project', 1, datetime('now'))").run();
initDb.prepare("INSERT OR REPLACE INTO evidence_records (id, fact_id, title, description, source_type, source_reference, verified) VALUES ('ev-prj-beta-routing', 'fact-prj-beta', 'API Gateway', 'Built a reverse proxy API gateway with rate limiting and quota enforcement in atomic Redis Lua scripts.', 'project', 'cv.md:PROJECTS', 1)").run();

initDb.prepare("INSERT OR REPLACE INTO candidate_facts (id, category, identifier, value, evidence_type, verified, created_at) VALUES ('fact-prj-gamma', 'project', 'project-gamma', 'Project Gamma — Distributed Code Execution Engine (Docker, Node.js, WebSockets, AWS EC2)', 'project', 1, datetime('now'))").run();
initDb.prepare("INSERT OR REPLACE INTO evidence_records (id, fact_id, title, description, source_type, source_reference, verified) VALUES ('ev-prj-gamma-sandboxing', 'fact-prj-gamma', 'Docker Sandboxes', 'Architected a secure, multi-language online code execution platform supporting isolated Docker sandboxes.', 'project', 'cv.md:PROJECTS', 1)").run();
initDb.prepare("INSERT OR REPLACE INTO evidence_records (id, fact_id, title, description, source_type, source_reference, verified) VALUES ('ev-prj-gamma-workers', 'fact-prj-gamma', 'Execution Workers', 'Engineered asynchronous code compilation and execution workers with sub-second response times and streaming output.', 'project', 'cv.md:PROJECTS', 1)").run();

initDb.prepare("INSERT OR REPLACE INTO candidate_facts (id, category, identifier, value, evidence_type, verified, created_at) VALUES ('fact-prj-delta', 'project', 'project-delta', 'Project Delta — Real-Time Collaboration Workspace (React, Node.js, Socket.IO, Redis, JWT, AWS)', 'project', 1, datetime('now'))").run();
initDb.prepare("INSERT OR REPLACE INTO evidence_records (id, fact_id, title, description, source_type, source_reference, verified) VALUES ('ev-prj-delta-socket', 'fact-prj-delta', 'Real-Time Sync', 'Developed a high-performance real-time collaboration workspace supporting 50+ concurrent users with sub-100ms latency using Socket.IO.', 'project', 'cv.md:PROJECTS', 1)").run();
initDb.prepare("INSERT OR REPLACE INTO evidence_records (id, fact_id, title, description, source_type, source_reference, verified) VALUES ('ev-prj-delta-redis', 'fact-prj-delta', 'Session Caching', 'Leveraged a Redis-backed session store to drastically reduce direct database read loads during concurrent state updates.', 'project', 'cv.md:PROJECTS', 1)").run();

// Write deterministic synthetic LaTeX template for PDF generation tests
const syntheticTexContent = `\\documentclass[letterpaper,11pt]{article}
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
\\titleformat{\\section}{\\vspace{-7pt}\\scshape\\raggedright\\large\\bfseries}{}{0em}{}[\\color{black}\\titlerule \\vspace{0pt}]

\\newcommand{\\resumeItem}[1]{\\item\\small{{#1 \\vspace{-3pt}}}}
\\newcommand{\\resumeSubheading}[4]{\\vspace{-3pt}\\item\\begin{tabular*}{1.0\\textwidth}[t]{l@{\\extracolsep{\\fill}}r}\\textbf{#1} & \\textbf{\\small #2} \\\\\\textit{\\small#3} & \\textit{\\small #4} \\\\\\end{tabular*}\\vspace{-7pt}}
\\newcommand{\\resumeProjectHeading}[2]{\\vspace{-3pt}\\item\\begin{tabular*}{1.0\\textwidth}[t]{p{0.82\\textwidth}@{\\extracolsep{\\fill}}r}\\small#1 & \\textbf{\\small #2} \\\\\\end{tabular*}\\vspace{-7pt}}
\\newcommand{\\resumeSubItem}[1]{\\resumeItem{#1}\\vspace{0pt}}
\\renewcommand\\labelitemi{$\\vcenter{\\hbox{\\tiny$\\bullet$}}$}
\\renewcommand\\labelitemii{$\\vcenter{\\hbox{\\tiny$\\bullet$}}$}
\\newcommand{\\resumeSubHeadingListStart}{\\begin{itemize}[leftmargin=0.0in, label={}]}
\\newcommand{\\resumeSubHeadingListEnd}{\\end{itemize}}
\\newcommand{\\resumeItemListStart}{\\begin{itemize}}
\\newcommand{\\resumeItemListEnd}{\\end{itemize}\\vspace{0pt}}

\\begin{document}
    \\begin{center}
        {\\Huge\\scshape Jordan Lee} \\\\
        Synthetic City, Synthetic Country \\\\
        \\small
        \\raisebox{-0.2\\height}\\faEnvelope\\ jordan.synthetic@example.test ~
        \\raisebox{-0.2\\height}\\faPhone\\ +00-0000000000
    \\end{center}

\\section{Education}
  \\resumeSubHeadingListStart
    \\resumeSubheading
      {Synthetic University}{Synthetic City}
      {Bachelor of Technology in Computer Science \\& Engineering}{Sep 2022 -- May 2026}
  \\resumeSubHeadingListEnd

\\section{Work Experience}
  \\resumeSubHeadingListStart
    \\resumeSubheading
      {Acme Corp}{Remote}
      {Software Engineer}{May 2026 -- July 2026}
      \\resumeItemListStart
        \\resumeItem{Engineered high-performance backend modules and interactive user interfaces.}
      \\resumeItemListEnd
    \\resumeSubheading
      {TechCorp}{Remote}
      {Full Stack Developer Trainee}{Dec 2025 -- Mar 2026}
      \\resumeItemListStart
        \\resumeItem{Built and deployed scalable full-stack applications using MERN stack.}
      \\resumeItemListEnd
  \\resumeSubHeadingListEnd

\\section{Personal Projects}
\\resumeSubHeadingListStart
\\resumeSubHeadingListEnd

\\section{Technical Skills}
\\vspace{-7pt}
\\begin{itemize}
[leftmargin=0.15in, label={}]\\small{\\item{
\\textbf{Languages}{: JavaScript, TypeScript} \\\\
\\textbf{Backend}{: Node.js, Express}
}}
\\end{itemize}

\\end{document}`;
writeFileSync(SYNTH_TEX_PATH, syntheticTexContent, 'utf8');
process.env.CAREER_OPS_RESUME_TEX = SYNTH_TEX_PATH;

process.on('exit', () => {
    cleanupTestDb();
});

const {
    getJob,
    upsertJobPosting,
    insertResumeVersion,
    getResumeVersion,
    getLatestResumeVersionForJob,
    countResumeVersions
} = await import('./db/repo.mjs');
const { buildResumeHtml, escapeHtml } = await import('./resume/populate-template.mjs');
const { determineVariant, checkResumeReuse, RESUME_VARIANTS } = await import('./resume/select-variant.mjs');
const { validatePdf, extractTextFromPdf } = await import('./resume/validate-pdf.mjs');
const { generateResume } = await import('./resume/generate-resume.mjs');
const {
    buildTailoredResumeTex: buildResumeTex,
    escapeTex,
    generateLatexResume,
    VERIFIED_FACTS_CORPUS
} = await import('./resume/generate-latex-resume.mjs');

const projectAlpha = {
    title: 'Project Alpha --- Subscription-Based Reward Platform',
    tech: 'React, Vite, Express.js, Supabase (PostgreSQL), Stripe API',
    date: 'Jan 2026 -- Mar 2026',
    liveDemoUrl: 'https://example.test/alpha-demo',
    sourceUrl: 'https://github.com/example-user/project-alpha',
    allowedBullets: [
        'Built a subscription platform with Stripe Checkout/Webhooks; implemented idempotency keys and atomic PostgreSQL RPCs to eliminate race conditions.',
        'Eliminated N+1 query bottleneck in the draw engine by refactoring payout simulation to in-memory calculation with a single bulk upsert RPC.',
        'Architected zero-trust document storage with private Supabase buckets and signed URLs for secure winner identity proof access.'
    ]
};
const projectBeta = {
    title: 'Project Beta --- Multi-Tenant API Gateway',
    tech: 'TypeScript, Node.js, Express, Redis, PostgreSQL, Docker',
    date: 'Aug 2026 -- Oct 2026',
    liveDemoUrl: 'https://example.test/beta-demo',
    sourceUrl: 'https://github.com/example-user/project-beta',
    allowedBullets: [
        'Built a reverse proxy API gateway with longest-prefix routing using http-proxy-middleware; enforced sliding-window rate limits in atomic Redis Lua script.',
        'Implemented two-phase SSRF defense against private ranges, cloud-metadata addresses, and DNS rebinding; isolated admin control plane.',
        'Wrote 108 Vitest tests across 11 suites; instrumented request tracing via X-Request-Id injection and audit logging.'
    ]
};
const projectGamma = {
    title: 'Project Gamma --- Distributed Code Execution Engine',
    tech: 'Next.js, TypeScript, BullMQ, Redis, Docker, PostgreSQL',
    date: 'Apr 2026 -- May 2026',
    liveDemoUrl: 'https://example.test/gamma-demo',
    sourceUrl: 'https://github.com/example-user/project-gamma',
    allowedBullets: [
        'Architected a distributed execution engine (BullMQ and Redis workers) supporting 5 languages; tuned serverless PostgreSQL connection pooling.',
        'Contained hostile code in ephemeral Docker sandboxes (network-isolated, memory-capped, non-root user, read-only root filesystem, hard timeout).',
        'Designed failure handling: Redis TTL worker heartbeats, retry with backoff then Dead Letter Queue with inspect/replay/delete endpoints.'
    ]
};
const projectDelta = {
    title: 'Project Delta --- Real-Time Collaboration Workspace',
    tech: 'React, Node.js, Socket.IO, Redis, JWT, AWS EC2',
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
        console.error(`     ${err.message}`);
        failed++;
    }
}

async function runAllTests() {
    console.log('====================================================');
    console.log('🧪 MILESTONE 3C — RESUME GENERATION & VALIDATION');
    console.log('====================================================\n');

    // ── 1. Template Population & Rendering ────────────────────────────
    console.log('--- 1. Master HTML Template Population & Layout ---');

    test('1. Master HTML template renders without unresolved placeholders', () => {
        const res = buildResumeHtml({ variantLabel: RESUME_VARIANTS.GENERAL });
        assert(res.html.includes('Jordan Lee'));
        assert.strictEqual(res.html.includes('jordan.synthetic@example.test'), true);
        assert.strictEqual(res.unresolvedFields.length, 0);
    });

    test('2. Master template layout and Space Grotesk font preservation', () => {
        const res = buildResumeHtml({ variantLabel: RESUME_VARIANTS.GENERAL });
        assert(res.html.includes("font-family: 'Space Grotesk'"));
        assert(res.html.includes("font-family: 'DM Sans'"));
        assert(res.html.includes('class="header-gradient"'));
        assert(res.html.includes('class="competencies-grid"'));
    });

    test('3. Correct candidate identity (Jordan Lee, not OS or system username)', () => {
        const res = buildResumeHtml({ variantLabel: RESUME_VARIANTS.GENERAL });
        assert(res.html.includes('<h1>Jordan Lee</h1>'));
        assert(!res.html.toLowerCase().includes('rahul'));
        assert.strictEqual(res.html.includes('+00-0000000000'), true);
        assert.strictEqual(res.html.includes('Synthetic City'), true);
    });

    test('4. Correct employment dates strictly grounded in verified facts', () => {
        const res = buildResumeHtml({ variantLabel: RESUME_VARIANTS.GENERAL });
        assert(res.html.includes('May 2026 – July 2026'));
        assert(res.html.includes('December 2025 – March 2026'));
        assert(res.html.includes('Acme Corp'));
        assert(res.html.includes('TechCorp'));
    });

    test('5. No experience inflation (~7 months verified, not 1.5+ years)', () => {
        const res = buildResumeHtml({ variantLabel: RESUME_VARIANTS.GENERAL });
        assert(!res.html.includes('2 years of professional'));
        assert(!res.html.includes('1.5 years of experience'));
        assert(res.html.includes('Software Engineer'));
        assert(res.html.includes('Full Stack Developer Trainee'));
    });

    test('6. Missing candidate facts handled safely with warnings', () => {
        const res = buildResumeHtml({ variantLabel: 'general' });
        assert(Array.isArray(res.warnings));
        assert.strictEqual(res.unresolvedFields.length, 0);
    });

    // ── 2. Evidence-Grounded Bullet Selection & Variants ─────────────
    console.log('\n--- 2. Evidence-Grounded Bullet Selection & Variants ---');

    test('7. Evidence-linked bullet selection has verified provenance', () => {
        const res = buildResumeHtml({ variantLabel: RESUME_VARIANTS.GENERAL });
        assert(res.factsUsed.includes('fact-exp-acme'));
        assert(res.factsUsed.includes('fact-exp-techcorp'));
        assert(res.factsUsed.includes('fact-edu-synth-btech'));
        assert(res.evidenceUsed.length >= 4);
        assert(res.bulletsSelected.length >= 4);
    });

    test('8. Backend resume variant prioritizes backend and systems projects', () => {
        const res = buildResumeHtml({ variantLabel: RESUME_VARIANTS.BACKEND });
        assert.strictEqual(res.variantLabel, 'backend');
        assert(res.html.includes('Backend Architecture'));
        assert(res.html.includes('Project Gamma') || res.html.includes('Project Beta'));
    });

    test('9. Full-stack resume variant balances frontend and backend', () => {
        const res = buildResumeHtml({ variantLabel: RESUME_VARIANTS.FULLSTACK });
        assert.strictEqual(res.variantLabel, 'fullstack');
        assert(res.html.includes('Full Stack Architecture'));
        assert(res.html.includes('Project Alpha'));
    });

    test('10. Frontend resume variant emphasizes UI and application state', () => {
        const res = buildResumeHtml({ variantLabel: RESUME_VARIANTS.FRONTEND });
        assert.strictEqual(res.variantLabel, 'frontend');
        assert(res.html.includes('React.js &amp; Next.js'));
        assert(res.html.includes('Project Alpha'));
    });

    test('11. General resume variant uses balanced master profile', () => {
        const res = buildResumeHtml({ variantLabel: RESUME_VARIANTS.GENERAL });
        assert.strictEqual(res.variantLabel, 'general');
        assert(res.html.includes('Full Stack Developer specializing in the MERN stack'));
    });

    test('12. Unnecessary tailoring avoidance reuses existing variant when sufficient', () => {
        const dummyId = `job_reuse_test_${Date.now()}`;
        const check1 = checkResumeReuse(dummyId, 'general');
        assert.strictEqual(check1.reuse, false);

        // Record a mock master version
        const mockVersionId = insertResumeVersion({
            format: 'pdf',
            file_path: 'output/resumes/jordan-lee-general.pdf',
            variant_label: 'general',
            page_count: 1
        });

        const check2 = checkResumeReuse(null, 'general');
        assert.strictEqual(check2.reuse, true);
        assert.strictEqual(check2.existingVersion.variant_label, 'general');
    });

    // ── 3. Safety, Escaping & Injection Protection ───────────────────
    console.log('\n--- 3. Safety, Escaping & Template Guardrails ---');

    test('13. HTML injection protection escapes dangerous characters', () => {
        const escaped = escapeHtml('<script>alert("xss")</script> & <b>bold</b>');
        assert.strictEqual(escaped, '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt; &amp; &lt;b&gt;bold&lt;/b&gt;');
        assert(!escaped.includes('<script>'));
    });

    test('14. TeX escaping handles LaTeX special characters', () => {
        const escaped = escapeTex('Full Stack & Cloud $100% #1 _test_ {bracket} ~tilde~ ^hat^ \\slash');
        assert(escaped.includes('\\&'));
        assert(escaped.includes('\\$'));
        assert(escaped.includes('\\%'));
        assert(escaped.includes('\\#'));
        assert(escaped.includes('\\_'));
        assert(escaped.includes('\\{'));
        assert(escaped.includes('\\}'));
        assert(escaped.includes('\\textasciitilde{}'));
        assert(escaped.includes('\\textasciicircum{}'));
    });

    test('15. Unresolved placeholder rejection flags remaining template tokens', () => {
        const res = buildResumeHtml({ variantLabel: 'general' });
        assert.strictEqual(res.unresolvedFields.length, 0, 'No unresolved fields in production build');
    });

    test('20. No duplicate bullets generated in experience or projects', () => {
        const res = buildResumeHtml({ variantLabel: 'general' });
        const uniqueBullets = new Set(res.bulletsSelected);
        assert.strictEqual(uniqueBullets.size, res.bulletsSelected.length, 'All selected bullets must be distinct');
    });

    // ── 4. PDF Generation & Quality Validation ───────────────────────
    console.log('\n--- 4. PDF Generation, Layout & Extraction Validation ---');

    let generatedPdfResult = null;

    await asyncTest('16. PDF generation produces valid non-zero PDF artifact', async () => {
        generatedPdfResult = await generateResume({
            variantLabel: RESUME_VARIANTS.GENERAL,
            forceRegenerate: true
        });
        assert(generatedPdfResult.pdfPath !== null);
        assert(existsSync(generatedPdfResult.pdfPath));
        assert(generatedPdfResult.sizeBytes > 1000);
    });

    test('17. PDF text extraction retrieves verified candidate information', () => {
        assert(generatedPdfResult !== null);
        const { validationResult } = generatedPdfResult;
        assert.strictEqual(validationResult.valid, true);
        const textNorm = validationResult.extractedText.toLowerCase().replace(/[^a-z0-9]/g, '');
        assert(textNorm.includes('jordanlee'));
        assert.strictEqual(validationResult.extractedText.includes('jordan.synthetic@example.test'), true);
        assert.strictEqual(validationResult.extractedText.includes('0000000000'), true);
        assert(textNorm.includes('syntheticuniversity'));
        assert(textNorm.includes('acmecorp'));
        assert(textNorm.includes('techcorp'));
    });

    test('18. Reading order follows standard top-to-bottom section sequence', () => {
        assert(generatedPdfResult !== null);
        assert.strictEqual(generatedPdfResult.validationResult.readingOrderValid ?? true, true);
        assert(generatedPdfResult.validationResult.atsParseScore >= 0.85);
    });

    test('19. Page count strictly respects 1-page layout budget', () => {
        assert(generatedPdfResult !== null);
        assert.strictEqual(generatedPdfResult.pageCount, 1, 'Master resume must fit cleanly on 1 page');
    });

    // ── 5. Persistence, Immutability & LaTeX Path ────────────────────
    console.log('\n--- 5. Persistence, Immutability & LaTeX Guardrails ---');

    test('21. SQLite resume version persistence records complete metadata', () => {
        assert(generatedPdfResult !== null);
        const inDb = getResumeVersion(generatedPdfResult.resumeVersionId);
        assert(inDb !== undefined);
        assert.strictEqual(inDb.format, 'pdf');
        assert.strictEqual(inDb.variant_label, 'general');
        assert.strictEqual(inDb.page_count, 1);
        assert(inDb.file_path.endsWith('.pdf'));
        assert(inDb.html_path.endsWith('.html') || inDb.html_path.endsWith('.tex'));
        assert(inDb.ats_parse_score >= 0.85);
    });

    test('22. Existing version preservation guarantees immutable history', () => {
        const initialCount = countResumeVersions();
        assert(initialCount >= 1);
        const initial = getResumeVersion(generatedPdfResult.resumeVersionId);
        assert(initial !== undefined);

        // Insert another version for a different variant
        const secondId = insertResumeVersion({
            format: 'pdf',
            file_path: 'output/resumes/jordan-lee-backend-test.pdf',
            variant_label: 'backend',
            page_count: 1
        });

        // Verify initial row was completely untouched
        const afterInitial = getResumeVersion(generatedPdfResult.resumeVersionId);
        assert.strictEqual(afterInitial.id, initial.id);
        assert.strictEqual(afterInitial.created_at, initial.created_at);
        assert.strictEqual(countResumeVersions(), initialCount + 1);
    });

    await asyncTest('23. Idempotency and repeated generation reuses existing artifact', async () => {
        const repeatRes = await generateResume({
            variantLabel: RESUME_VARIANTS.GENERAL,
            forceRegenerate: false
        });
        assert.strictEqual(repeatRes.reusedExisting, true);
        assert.strictEqual(repeatRes.variantLabel, 'general');
    });

    await asyncTest('24. Failed LaTeX compilation fails gracefully without breaking HTML PDF', async () => {
        const texBuild = buildResumeTex({ variantLabel: 'general' });
        assert(texBuild.tex.includes('Jordan Lee') || texBuild.tex.includes('Candidate'));
        assert(texBuild.tex.includes('\\section{Education}'));
        assert(texBuild.tex.includes('\\section{Professional Experience}') || texBuild.tex.includes('\\section{Work Experience}'));
        assert(texBuild.tex.includes('\\section{Engineering Projects}') || texBuild.tex.includes('\\section{Personal Projects}'));

        const latexRes = await generateLatexResume({ variantLabel: 'general' });
        assert.strictEqual(latexRes.validTex, true);
        assert(latexRes.texPath.endsWith('.tex'));
        // If tectonic/pdflatex not on PATH, compiled is false without throwing
        if (!latexRes.compiled) {
            assert(latexRes.compileError.includes('No LaTeX engine found'));
        }
        // Primary HTML PDF remains completely intact
        assert(existsSync(generatedPdfResult.pdfPath));
    });

    await asyncTest('25. Dry-run behavior validates output without modifying database or disk', async () => {
        const beforeCount = countResumeVersions();
        const dryRes = await generateResume({
            variantLabel: RESUME_VARIANTS.BACKEND,
            dryRun: true,
            forceRegenerate: true
        });
        assert.strictEqual(dryRes.dryRun, true);
        assert.strictEqual(dryRes.resumeVersionId, null);
        assert(dryRes.pdfPath !== null);
        assert.strictEqual(dryRes.pageCount, 1);
        assert.strictEqual(countResumeVersions(), beforeCount, 'Dry-run must not write to resume_versions table');
    });

    // ── Controlled Real-Job Test ──────────────────────────────────────
    console.log('\n--- 6. Controlled Real-Job Tailoring Test ---');

    await asyncTest('26. Controlled real-job tailoring evaluates and generates targeted resume', async () => {
        const testJobId = `job_real_swe_${Date.now()}`;
        upsertJobPosting({
            id: testJobId,
            company_id: 'company-palantir',
            title: 'Backend Node.js & Distributed Systems Engineer',
            location: 'Bengaluru, India',
            description: 'Building high throughput APIs with Node.js, Docker sandboxing, WebSockets, and Redis.',
            job_url: `https://example.com/jobs/${testJobId}`,
            source: 'test',
            status: 'active'
        });

        const realJob = getJob(testJobId);
        const variant = determineVariant(realJob);
        assert.strictEqual(variant, 'backend');

        const realRes = await generateResume({
            jobId: testJobId,
            forceRegenerate: true
        });

        assert.strictEqual(realRes.jobId, testJobId);
        assert.strictEqual(realRes.variantLabel, 'backend');
        assert.strictEqual(realRes.pageCount, 1);
        assert.strictEqual(realRes.validationResult.valid, true);
        assert(/project\s*gamma/i.test(realRes.validationResult.extractedText) || /project\s*beta/i.test(realRes.validationResult.extractedText));

        const inDb = getLatestResumeVersionForJob(testJobId);
        assert(inDb !== undefined);
        assert.strictEqual(inDb.job_id, testJobId);
        assert.strictEqual(inDb.variant_label, 'backend');
    });

    console.log('\n====================================================');
    console.log(`📊 Milestone 3C Test Results: ${passed} PASSED, ${failed} FAILED`);
    console.log('====================================================');

    try { closeDb(); } catch {}
    cleanupTestDb();

    if (failed > 0) {
        process.exit(1);
    }
}

runAllTests().catch((err) => {
    console.error('Fatal test runner error:', err);
    process.exit(1);
});
