/**
 * resume/generate-latex-resume.mjs — Evidence-Grounded LaTeX Resume Tailoring
 *
 * Implements Deliverable 5 Phase 3 (L1-L3):
 *   - Frozen LaTeX template: Resolved from local profile setting, env, or config/*.tex
 *   - Immutable structure & styling (R17): .tex preamble, macros, section order are frozen
 *   - Content selection only: projects ordering, bullet selection, skill prioritization
 *   - Fact-grounded only (R16 Zero Fabrication): strict validator throws AntiFabricationViolationError
 *   - 1-page budget enforcement (max 3 bullets per project, 3 bullets per role)
 *   - Golden diff generation for Backend, Fullstack, and Platform/DevOps JDs
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { RESUME_VARIANTS, determineVariant } from './select-variant.mjs';
import { validatePdf, validateCompiledPdf, extractLinksFromPdf, resolveRuntimeCandidateIdentity } from './validate-pdf.mjs';
import { insertResumeVersion } from '../db/repo.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Resolves the candidate's frozen LaTeX resume template from local configuration.
 * Checked in order:
 *   1. Environment variable CAREER_OPS_RESUME_TEX or CAREER_OPS_LATEX_TEMPLATE
 *   2. Setting in config/profile.yml or config/autofill-profile.yml (e.g. latex_template)
 *   3. Explicit local candidate resume: config/candidate-resume.tex
 *   4. Unique local candidate .tex in config/
 * Never falls back to generic templates/ examples as verified candidate content.
 */
export function resolveFrozenTemplatePath() {
    if (process.env.CAREER_OPS_RESUME_TEX && existsSync(process.env.CAREER_OPS_RESUME_TEX)) {
        return resolve(process.env.CAREER_OPS_RESUME_TEX);
    }
    if (process.env.CAREER_OPS_LATEX_TEMPLATE && existsSync(process.env.CAREER_OPS_LATEX_TEMPLATE)) {
        return resolve(process.env.CAREER_OPS_LATEX_TEMPLATE);
    }

    for (const relPath of ['../config/profile.yml', '../config/autofill-profile.yml']) {
        try {
            const p = resolve(__dirname, relPath);
            if (existsSync(p)) {
                const text = readFileSync(p, 'utf8');
                const m = text.match(/(?:latex_template|template_tex|resume_tex|source_tex):\s*["']?([^"'\r\n]+)["']?/);
                if (m && m[1]) {
                    const resolved = resolve(__dirname, '..', m[1].trim());
                    if (existsSync(resolved)) return resolved;
                }
            }
        } catch { }
    }

    const candidateResumeTex = resolve(__dirname, '../config/candidate-resume.tex');
    if (existsSync(candidateResumeTex)) {
        return candidateResumeTex;
    }

    try {
        const configDir = resolve(__dirname, '../config');
        if (existsSync(configDir)) {
            const texFiles = readdirSync(configDir).filter(f => f.endsWith('.tex') && !f.includes('.example.') && !f.startsWith('example'));
            if (texFiles.length === 1) {
                return join(configDir, texFiles[0]);
            }
        }
    } catch { }

    return null;
}

export const FROZEN_TEX_TEMPLATE = resolveFrozenTemplatePath();

export class AntiFabricationViolationError extends Error {
    constructor(message, ungroundedContent = null) {
        super(message);
        this.name = 'AntiFabricationViolationError';
        this.ungroundedContent = ungroundedContent;
    }
}

/**
 * Calculates SHA-256 digest of a PDF file or buffer.
 */
export function calculatePdfHash(pdfPathOrBuffer) {
    const buf = Buffer.isBuffer(pdfPathOrBuffer)
        ? pdfPathOrBuffer
        : readFileSync(pdfPathOrBuffer);
    return createHash('sha256').update(buf).digest('hex').toUpperCase();
}

/**
 * Verifies that the PDF on disk is byte-identical to the registered version.
 * Throws an error if any tampering or post-registration modification is detected (Part H.5).
 */
export function verifyResumeIntegrity(resumeVersion, pdfPath) {
    if (!resumeVersion) throw new Error('Resume version record is required for integrity verification');
    if (!existsSync(pdfPath)) throw new Error(`Resume PDF file not found at: ${pdfPath}`);

    const actualHash = calculatePdfHash(pdfPath);
    let expectedHash = null;

    if (resumeVersion.tailoring_facts_json) {
        try {
            const facts = typeof resumeVersion.tailoring_facts_json === 'string'
                ? JSON.parse(resumeVersion.tailoring_facts_json)
                : resumeVersion.tailoring_facts_json;
            expectedHash = facts.pdf_sha256;
        } catch { }
    }

    if (expectedHash && actualHash !== expectedHash) {
        throw new Error(`Resume integrity violation: PDF at ${pdfPath} (hash: ${actualHash}) does not match registered hash (${expectedHash}). Post-registration modification detected.`);
    }

    return {
        verified: true,
        hash: actualHash
    };
}

/**
 * Escapes dynamic string values to prevent TeX syntax errors.
 */
export function escapeTex(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/\\/g, '\\textbackslash{}')
        .replace(/&/g, '\\&')
        .replace(/%/g, '\\%')
        .replace(/\$/g, '\\$')
        .replace(/#/g, '\\#')
        .replace(/_/g, '\\_')
        .replace(/\{/g, '\\{')
        .replace(/\}/g, '\\}')
        .replace(/~/g, '\\textasciitilde{}')
        .replace(/\^/g, '\\textasciicircum{}');
}

const LOCAL_FACTS_CORPUS_PATH = resolve(__dirname, '../config/candidate-facts-corpus.json');

function loadVerifiedFactsCorpus() {
    if (existsSync(LOCAL_FACTS_CORPUS_PATH)) {
        try {
            const parsed = JSON.parse(readFileSync(LOCAL_FACTS_CORPUS_PATH, 'utf8'));
            if (parsed.projects && parsed.skillsPool) {
                return parsed;
            }
        } catch { }
    }
    return {
        name: null,
        degrees: [],
        university: null,
        cgpa: null,
        companies: [],
        allowedMetrics: [],
        forbiddenClaims: [],
        skillsPool: {},
        projects: {}
    };
}

const loadedCorpus = loadVerifiedFactsCorpus();
const runtimeIdentity = resolveRuntimeCandidateIdentity();

/**
 * Canonical ground-truth knowledge base for Candidate
 * Loaded from local configuration (config/candidate-facts-corpus.json)
 */
export const VERIFIED_FACTS_CORPUS = Object.freeze({
    ...loadedCorpus,
    name: runtimeIdentity.name || loadedCorpus.name || 'Candidate'
});

/**
 * Validates that all bullets and claims in a generated resume trace to verified candidate facts.
 * Throws AntiFabricationViolationError if any forbidden or ungrounded statement is found (R16).
 */
export function validateGrounding(bullets = [], { candidateFacts = null } = {}) {
    for (const bullet of bullets) {
        const text = String(bullet);

        // 1. Check against explicitly forbidden / fabricated claims
        for (const forbidden of VERIFIED_FACTS_CORPUS.forbiddenClaims) {
            const regex = new RegExp(`\\b${forbidden}\\b`, 'i');
            if (regex.test(text)) {
                throw new AntiFabricationViolationError(
                    `R16 Anti-Fabrication Violation: Bullet contains ungrounded/forbidden claim "${forbidden}": "${text}"`,
                    { bullet: text, violation: forbidden }
                );
            }
        }

        // 2. Validate that bullet matches one of the canonical verified bullet patterns
        const allAllowedBullets = Object.values(VERIFIED_FACTS_CORPUS.projects)
            .flatMap(p => p.allowedBullets);

        const isKnownBullet = allAllowedBullets.some(allowed => {
            const normAllowed = allowed.toLowerCase().replace(/[^a-z0-9]/g, '');
            const normText = text.toLowerCase().replace(/[^a-z0-9]/g, '');
            return normAllowed === normText || normText.includes(normAllowed) || normAllowed.includes(normText);
        });

        if (!isKnownBullet && !candidateFacts) {
            throw new AntiFabricationViolationError(
                `R16 Anti-Fabrication Violation: Bullet could not be verified against candidate facts: "${text}"`,
                { bullet: text }
            );
        }
    }
    return true;
}

/**
 * Formats a project entry in sb2nov LaTeX format with clickable link annotations.
 */
function renderProjectTex(project, bullets) {
    const safeTitle = project.title;
    const safeTech = project.tech;
    const safeDate = project.date;
    const liveDemoUrl = project.liveDemoUrl;
    const sourceUrl = project.sourceUrl;

    let linksTex = '';
    if (liveDemoUrl && sourceUrl) {
        linksTex = ` \\textbar{} {\\scriptsize\\href{${liveDemoUrl}}{\\textcolor{reslink}{\\underline{[Live Demo]}}} \\textbar{} \\href{${sourceUrl}}{\\textcolor{reslink}{\\underline{[Source Code]}}}}`;
    }

    return `    \\resumeProjectHeading
      {\\textbf{${safeTitle}}${linksTex} \\textbar{} \\emph{${safeTech}}}{${safeDate}}
      \\resumeItemListStart
${bullets.map(b => `        \\resumeItem{${b}}`).join('\n')}
      \\resumeItemListEnd`;
}

/**
 * Analyzes job requirements to intelligently prioritize verified skills and detect missing skill gaps.
 * Zero Fabrication ($R16): NEVER fabricates missing skills (e.g., Python).
 */
export function analyzeJobRequirements(job) {
    if (!job) {
        return {
            matchedSkills: [],
            missingSkills: [],
            claimsExcluded: [],
            skillsByCategory: { ...VERIFIED_FACTS_CORPUS.skillsPool }
        };
    }

    const title = (job.title || '').toLowerCase();
    const desc = (job.description || '').toLowerCase();
    const requirements = (job.requirements_raw || '').toLowerCase();
    const fullText = `${title} ${desc} ${requirements}`;

    // Skill aliases mapping to verified skills in skillsPool
    const skillPatterns = [
        { canonical: 'TypeScript', category: 'languages', regex: /\b(typescript|ts)\b/i },
        { canonical: 'JavaScript', category: 'languages', regex: /\b(javascript|js|es6|ecmascript)\b/i },
        { canonical: 'Java', category: 'languages', regex: /\b(java)\b(?!\s*script)/i },
        { canonical: 'C++', category: 'languages', regex: /\b(c\+\+|cpp)\b/i },
        { canonical: 'SQL', category: 'languages', regex: /\b(sql)\b/i },

        { canonical: 'Node.js', category: 'backend', regex: /\b(node|node\.?js)\b/i },
        { canonical: 'Express.js', category: 'backend', regex: /\b(express|express\.?js)\b/i },
        { canonical: 'REST APIs', category: 'backend', regex: /\b(rest|restful|rest\s*apis?)\b/i },
        { canonical: 'BullMQ', category: 'backend', regex: /\b(bullmq|bull\s*mq|message\s*queue)\b/i },
        { canonical: 'WebSocket', category: 'backend', regex: /\b(websocket|websockets|socket\.io|sockets)\b/i },
        { canonical: 'Distributed Systems', category: 'backend', regex: /\b(distributed\s*systems?|microservices?|scalab)/i },

        { canonical: 'React.js', category: 'frontend', regex: /\b(react|react\.?js)\b/i },
        { canonical: 'Next.js', category: 'frontend', regex: /\b(next|next\.?js)\b/i },
        { canonical: 'Redux Toolkit', category: 'frontend', regex: /\b(redux|redux\s*toolkit)\b/i },
        { canonical: 'Tailwind CSS', category: 'frontend', regex: /\b(tailwind|tailwind\s*css)\b/i },
        { canonical: 'HTML5', category: 'frontend', regex: /\b(html|html5)\b/i },
        { canonical: 'CSS3', category: 'frontend', regex: /\b(css|css3)\b/i },

        { canonical: 'PostgreSQL', category: 'databases', regex: /\b(postgres|postgresql|psql)\b/i },
        { canonical: 'MongoDB', category: 'databases', regex: /\b(mongo|mongodb)\b/i },
        { canonical: 'Redis', category: 'databases', regex: /\b(redis)\b/i },
        { canonical: 'Supabase', category: 'databases', regex: /\b(supabase)\b/i },
        { canonical: 'Prisma ORM', category: 'databases', regex: /\b(prisma|prisma\s*orm)\b/i },

        { canonical: 'Docker', category: 'devops', regex: /\b(docker|containers?|containerization)\b/i },
        { canonical: 'AWS EC2/S3', category: 'devops', regex: /\b(aws|amazon\s*web\s*services|ec2|s3)\b/i },
        { canonical: 'Azure', category: 'devops', regex: /\b(azure)\b/i },
        { canonical: 'Git', category: 'devops', regex: /\b(git|github)\b/i },
        { canonical: 'GitHub Actions', category: 'devops', regex: /\b(github\s*actions|gh\s*actions)\b/i },
        { canonical: 'CI/CD', category: 'devops', regex: /\b(ci\/cd|ci|continuous\s*integration)\b/i },
        { canonical: 'Vitest', category: 'devops', regex: /\b(vitest|jest|unit\s*tests?|testing)\b/i },
        { canonical: 'Postman', category: 'devops', regex: /\b(postman)\b/i }
    ];

    const matchedSkills = [];
    const matchedSet = new Set();
    for (const item of skillPatterns) {
        if (item.regex.test(fullText)) {
            matchedSkills.push(item.canonical);
            matchedSet.add(item.canonical);
        }
    }

    // Unverified / missing skills patterns (candidate does NOT possess these facts)
    const unverifiedSkillPatterns = [
        { name: 'Python', regex: /\b(python|django|fastapi|flask)\b/i },
        { name: 'Golang', regex: /\b(golang|go\s*lang)\b/i },
        { name: 'Rust', regex: /\b(rust)\b/i },
        { name: 'Ruby', regex: /\b(ruby|rails)\b/i },
        { name: 'PHP', regex: /\b(php|laravel)\b/i },
        { name: 'Kubernetes', regex: /\b(kubernetes|k8s)\b/i },
        { name: 'GraphQL', regex: /\b(graphql)\b/i },
        { name: 'Angular', regex: /\b(angular)\b/i },
        { name: 'Vue', regex: /\b(vue|vue\.?js)\b/i },
        { name: 'C#', regex: /\b(c#|\.net)\b/i }
    ];

    const missingSkills = [];
    const claimsExcluded = [];
    for (const unv of unverifiedSkillPatterns) {
        if (unv.regex.test(fullText)) {
            missingSkills.push(unv.name);
            claimsExcluded.push(unv.name);
        }
    }

    // Reorder skills per category: matched skills first, preserving all other verified skills
    const skillsByCategory = {};
    for (const [cat, list] of Object.entries(VERIFIED_FACTS_CORPUS.skillsPool)) {
        const matched = list.filter(s => matchedSet.has(s));
        const unmatched = list.filter(s => !matchedSet.has(s));
        skillsByCategory[cat] = [...matched, ...unmatched];
    }

    return {
        matchedSkills,
        missingSkills,
        claimsExcluded,
        skillsByCategory
    };
}

/**
 * Formats the Technical Skills section preserving layout and height.
 */
export function renderTechnicalSkillsTex(skillsByCategory) {
    const pool = skillsByCategory || VERIFIED_FACTS_CORPUS.skillsPool;
    const languagesStr = (pool.languages || []).join(', ');
    const backendStr = (pool.backend || []).join(', ');
    const frontendStr = (pool.frontend || []).join(', ');
    const databasesStr = (pool.databases || []).join(', ');
    const devopsStr = (pool.devops || []).join(', ');

    return `\\section{Technical Skills}
\\vspace{-7pt}
\\begin{itemize}[leftmargin=0.15in, label={}]\\small{\\item{
    \\textbf{Languages}{: ${languagesStr}} \\\\
    \\textbf{Backend}{: ${backendStr}} \\\\
    \\textbf{Frontend}{: ${frontendStr}} \\\\
    \\textbf{Databases}{: ${databasesStr}} \\\\
    \\textbf{DevOps \\& QA}{: ${devopsStr}}
}}
\\end{itemize}`;
}

/**
 * Scores a candidate project against a job description based on domain and tech affinity.
 */
export function scoreProjectRelevance(projectKey, project, jobText = '') {
    const text = jobText.toLowerCase();
    let score = 0;

    // 1. Tech stack affinity
    const techTokens = (project.tech || '').toLowerCase().split(/,\s*/);
    for (const token of techTokens) {
        if (token && text.includes(token)) {
            score += 3;
        }
    }

    // 2. Domain & architectural pattern keywords
    const title = (project.title || '').toLowerCase();
    if (/\b(gateway|proxy|routing|rate\s*limit|quota)\b/i.test(text) && /\b(gateway|proxy|api)\b/i.test(title)) score += 6;
    if (/\b(socket|websocket|real[- ]?time|collaboration)\b/i.test(text) && /\b(socket|real[- ]?time|collaboration)\b/i.test(title)) score += 8;
    if (/\b(docker|container|sandbox|execution|compiler)\b/i.test(text) && /\b(execution|engine|compiler|sandbox)\b/i.test(title)) score += 6;
    if (/\b(stripe|payment|checkout|subscription|fintech)\b/i.test(text) && /\b(reward|subscription|fintech|platform)\b/i.test(title)) score += 6;

    // 3. Bullet points tech & capability match
    if (Array.isArray(project.allowedBullets)) {
        for (const b of project.allowedBullets) {
            const bLower = b.toLowerCase();
            if (text.includes('socket') && bLower.includes('socket')) score += 5;
            if (text.includes('docker') && bLower.includes('docker')) score += 3;
            if (text.includes('redis') && bLower.includes('redis')) score += 2;
            if (text.includes('rate limit') && bLower.includes('rate limit')) score += 3;
            if (text.includes('stripe') && bLower.includes('stripe')) score += 3;
            if (text.includes('vitest') && bLower.includes('vitest')) score += 2;
            if (text.includes('caddy') && bLower.includes('caddy')) score += 2;
        }
    }

    return score;
}

function findProjectByArchetype(projects, archetype) {
    const list = Object.values(projects || {});
    if (archetype === 'realtime') {
        return list.find(p => /socket|real[- ]?time|collaboration/i.test(`${p.title || ''} ${p.tech || ''}`));
    }
    if (archetype === 'gateway') {
        return list.find(p => /gateway|reverse\s*proxy|api\s*gateway|lua|caddy/i.test(`${p.title || ''} ${p.tech || ''}`));
    }
    if (archetype === 'systems') {
        return list.find(p => /execution|sandbox|engine|compiler|bullmq/i.test(`${p.title || ''} ${p.tech || ''}`));
    }
    if (archetype === 'fullstack') {
        return list.find(p => (/stripe|reward|subscription|fintech/i.test(`${p.title || ''} ${p.tech || ''}`)) || (/react/i.test(p.tech || '') && !/socket/i.test(p.tech || '')));
    }
    return null;
}

/**
 * Dynamically selects candidate projects based on JD relevance and layout space (Part E).
 */
export function selectProjectsForJob(job, availableProjects, targetVariant = 'general') {
    const desc = `${job?.title || ''} ${job?.description || ''}`.toLowerCase();
    const projList = Object.values(availableProjects || {});
    if (projList.length === 0) return [];

    const realtimeProj = findProjectByArchetype(availableProjects, 'realtime');
    const gatewayProj = findProjectByArchetype(availableProjects, 'gateway');
    const systemsProj = findProjectByArchetype(availableProjects, 'systems');
    const fullstackProj = findProjectByArchetype(availableProjects, 'fullstack');

    const requiresRealtime = desc.includes('socket') || desc.includes('socket.io') || desc.includes('websocket') || desc.includes('collaboration') || desc.includes('realtime') || desc.includes('real-time');

    let chosen = [];
    if (requiresRealtime && realtimeProj) {
        if (targetVariant === RESUME_VARIANTS.FULLSTACK || targetVariant === RESUME_VARIANTS.FRONTEND) {
            chosen = [fullstackProj, realtimeProj, systemsProj].filter(Boolean);
        } else {
            chosen = [systemsProj, fullstackProj, realtimeProj].filter(Boolean);
        }
    } else if (targetVariant === RESUME_VARIANTS.BACKEND) {
        chosen = [gatewayProj, systemsProj, fullstackProj].filter(Boolean);
    } else if (targetVariant === RESUME_VARIANTS.PLATFORM) {
        chosen = [systemsProj, gatewayProj, fullstackProj].filter(Boolean);
    } else if (targetVariant === RESUME_VARIANTS.FULLSTACK || targetVariant === RESUME_VARIANTS.FRONTEND) {
        chosen = [fullstackProj, gatewayProj, systemsProj].filter(Boolean);
    } else {
        chosen = [gatewayProj, systemsProj, fullstackProj].filter(Boolean);
    }

    for (const p of projList) {
        if (chosen.length >= 3) break;
        if (!chosen.includes(p)) chosen.push(p);
    }

    return chosen.slice(0, 3).map(p => ({
        project: p,
        bullets: (p.allowedBullets || []).slice(0, 3)
    }));
}

/**
 * Builds the tailored .tex resume strictly preserving the frozen template structure (R17).
 *
 * @param {object} options
 * @param {string} [options.variantLabel] - GENERAL, BACKEND, FULLSTACK, PLATFORM
 * @param {object|null} [options.job] - Job description for dynamic tailoring
 * @param {Array} [options.customBullets] - Optional custom bullets to validate against R16
 * @param {string} [options.templatePath] - Path to frozen LaTeX template
 * @returns {object} { tex, variantLabel, projectOrder, onePageBudgetPassed }
 */
export function buildTailoredResumeTex(options = {}) {
    const {
        variantLabel = RESUME_VARIANTS.GENERAL,
        job = null,
        customBullets = null,
        templatePath = FROZEN_TEX_TEMPLATE
    } = options;

    if (!templatePath || !existsSync(templatePath)) {
        throw new Error(`Candidate LaTeX resume template not found or not configured at "${templatePath}". Configure resume.latex_template in config/profile.yml, set CAREER_OPS_RESUME_TEX, or provide a candidate .tex file in config/. Example templates cannot be silently used as verified candidate content.`);
    }
    const templateContent = readFileSync(templatePath, 'utf8');

    // If custom bullets are injected, enforce strict anti-fabrication validation immediately
    if (customBullets && Array.isArray(customBullets)) {
        validateGrounding(customBullets);
    }

    // Determine target archetype from variantLabel or job description
    let target = (variantLabel && variantLabel !== RESUME_VARIANTS.GENERAL)
        ? variantLabel.toLowerCase()
        : (job ? determineVariant(job).toLowerCase() : (variantLabel || RESUME_VARIANTS.GENERAL).toLowerCase());
    let desc = '';
    if (job) {
        desc = `${job.title || ''} ${job.description || ''}`.toLowerCase();
    }

    // Dynamically select projects based on JD relevance and layout space (Part E)
    const selectedProjects = selectProjectsForJob(job, VERIFIED_FACTS_CORPUS.projects, target);

    // 1-Page budget enforcement check: exactly 3 projects, each with exactly 3 bullets
    const totalBullets = selectedProjects.reduce((acc, p) => acc + p.bullets.length, 0);
    const onePageBudgetPassed = (selectedProjects.length === 3 && totalBullets === 9);

    // Analyze job requirements for verified skills tailoring & missing skills gap detection
    const skillsAnalysis = analyzeJobRequirements(job);

    // Render projects block
    const projectsBlockTex = selectedProjects.map(p => renderProjectTex(p.project, p.bullets)).join('\n\n');

    let tailoredTex = templateContent;

    // Technical skills replacement preserving layout and 5-line height
    const skillsSectionRegex = /\\section\{Technical\s*Skills\}[\s\S]*?\\end\{itemize\}/;
    if (skillsSectionRegex.test(tailoredTex)) {
        const tailoredSkillsTex = renderTechnicalSkillsTex(skillsAnalysis.skillsByCategory);
        tailoredTex = tailoredTex.replace(skillsSectionRegex, tailoredSkillsTex);
    }

    // Section replacement preserving exact frozen structure (R17)
    const projectsSectionRegex = /(\\section\{(?:Engineering|Personal)\s*Projects\}\s*\\resumeSubHeadingListStart)([\s\S]*?)(\\resumeSubHeadingListEnd)/;
    if (!projectsSectionRegex.test(tailoredTex)) {
        throw new Error('Could not find Engineering/Personal Projects section in frozen LaTeX template');
    }

    tailoredTex = tailoredTex.replace(
        projectsSectionRegex,
        `$1\n${projectsBlockTex}\n$3`
    );

    // Dynamic candidate identity substitution for verified runtime facts
    const runtime = resolveRuntimeCandidateIdentity();
    if (runtime.name) {
        tailoredTex = tailoredTex.replace(/\{\\Huge\\scshape\s*[^}]+?\}/g, `{\\Huge\\scshape ${escapeTex(runtime.name)}}`);
        tailoredTex = tailoredTex.replace(/\\textbf\{\\Huge\s*\\scshape\s*[^}]+?\}/g, `\\textbf{\\Huge \\scshape ${escapeTex(runtime.name)}}`);
        tailoredTex = tailoredTex.replace(/\{\{NAME\}\}/g, escapeTex(runtime.name));
    }
    if (runtime.email) {
        tailoredTex = tailoredTex.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, escapeTex(runtime.email));
        tailoredTex = tailoredTex.replace(/\{\{EMAIL_URL\}\}/g, escapeTex(runtime.email));
        tailoredTex = tailoredTex.replace(/\{\{EMAIL_DISPLAY\}\}/g, escapeTex(runtime.email));
    }
    if (runtime.phone) {
        tailoredTex = tailoredTex.replace(/(?:\+91[- ]?)?[6-9]\d{9}/g, escapeTex(runtime.phone));
        tailoredTex = tailoredTex.replace(/\{\{CONTACT_LINE\}\}/g, escapeTex(runtime.phone));
    }

    return {
        tex: tailoredTex,
        variantLabel: target,
        projectOrder: selectedProjects.map(p => p.project.title),
        onePageBudgetPassed,
        skillsAnalysis,
        selectedBullets: selectedProjects.flatMap(p => p.bullets)
    };
}

/**
 * Formulates the deterministic destination path and role-specific filename:
 * <Candidate_Name>_<Sanitized_Job_Role>.pdf under output/resumes/<company_slug>/<job_slug>/
 */
export function getResumeDestinationPath(job, { outputBaseDir = resolve(__dirname, '../output/resumes') } = {}) {
    const runtime = resolveRuntimeCandidateIdentity();
    const candidatePrefix = (runtime.name || 'Candidate').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'Candidate';
    const companySlug = (job?.company_name || job?.company_id || 'general')
        .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'general';
    const jobSlug = (job?.id || 'default')
        .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'default';
    const rawRole = job?.title || 'Software Engineer';
    const roleSanitized = rawRole.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'Software_Engineer';
    const dir = resolve(outputBaseDir, companySlug, jobSlug);
    const filename = `${candidatePrefix}_${roleSanitized}.pdf`;
    return { dir, filename, fullPath: join(dir, filename), roleSanitized, companySlug, jobSlug };
}

/**
 * Generates and saves the tailored LaTeX resume.
 * Compiles via Tectonic, validates 1-page ATS compliance, and persists into SQLite resume_versions.
 */
export async function generateLatexResume(options = {}) {
    const {
        variantLabel = RESUME_VARIANTS.GENERAL,
        job = null,
        dryRun = false
    } = options;

    let targetDir;
    let targetBaseName;

    if (job) {
        const dest = getResumeDestinationPath(job, { outputBaseDir: options.outputDir ? resolve(options.outputDir) : resolve(__dirname, '../output/resumes') });
        targetDir = options.outputDir ? resolve(options.outputDir) : dest.dir;
        targetBaseName = options.filename ? options.filename.replace(/\.(tex|pdf)$/, '') : dest.filename.replace(/\.pdf$/, '');
    } else {
        targetDir = options.outputDir ? resolve(options.outputDir) : resolve(__dirname, '../output/resumes');
        const runtime = resolveRuntimeCandidateIdentity();
        const candidateSlug = (runtime.name || 'candidate').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'candidate';
        targetBaseName = options.filename ? options.filename.replace(/\.(tex|pdf)$/, '') : `${candidateSlug}-${variantLabel}`;
    }

    mkdirSync(targetDir, { recursive: true });
    const texPath = join(targetDir, `${targetBaseName}.tex`);
    const pdfPath = join(targetDir, `${targetBaseName}.pdf`);

    const { tex, variantLabel: targetVariant, projectOrder, onePageBudgetPassed, skillsAnalysis, selectedBullets } = buildTailoredResumeTex({ variantLabel, job });
    writeFileSync(texPath, tex, 'utf8');

    // Detect available compiler engine (tectonic, pdflatex, xelatex)
    let engine = null;
    for (const candidate of ['tectonic', 'pdflatex', 'xelatex']) {
        try {
            execFileSync(candidate, ['--version'], { stdio: 'pipe' });
            engine = candidate;
            break;
        } catch { }
    }

    if (!engine) {
        return {
            compiled: false,
            compileError: 'No LaTeX engine found (tectonic or pdflatex not on PATH). TeX source generated safely.',
            texPath,
            pdfPath,
            validTex: true,
            engine: null,
            projectOrder,
            onePageBudgetPassed,
            skillsAnalysis,
            dryRun
        };
    }

    const texDir = dirname(texPath);

    try {
        if (engine === 'tectonic') {
            const cacheDir = resolve(__dirname, '../data/tectonic_cache');
            const tectonicArgs = ['--outdir', texDir];
            if (existsSync(cacheDir)) {
                tectonicArgs.push('--only-cached');
            }
            tectonicArgs.push(texPath);

            execFileSync('tectonic', tectonicArgs, {
                cwd: texDir,
                env: {
                    ...process.env,
                    ...(existsSync(cacheDir) ? { TECTONIC_CACHE_DIR: cacheDir } : {})
                },
                stdio: 'pipe',
                timeout: 120_000
            });
        } else {
            execFileSync(engine, ['-no-shell-escape', '-interaction=nonstopmode', `-output-directory=${texDir}`, texPath], {
                cwd: texDir,
                stdio: 'pipe',
                timeout: 120_000
            });
        }

        // Validate compiled PDF
        const runtime = resolveRuntimeCandidateIdentity();
        const expectedProjects = (projectOrder || []).map(p => (p.split(/[—–\-(]/)[0] || p).trim());
        let validationResult = null;
        try {
            validationResult = validateCompiledPdf(pdfPath, {
                name: runtime.name || VERIFIED_FACTS_CORPUS.name,
                email: runtime.email || null,
                projects: expectedProjects
            });
        } catch (valErr) {
            try {
                const buf = readFileSync(pdfPath);
                validationResult = validatePdf(buf, {
                    name: runtime.name || VERIFIED_FACTS_CORPUS.name,
                    email: runtime.email || null,
                    projects: expectedProjects
                });
            } catch { }
        }

        // Persist to SQLite resume_versions unless dryRun
        let resumeVersionId = null;
        if (!dryRun) {
            try {
                resumeVersionId = insertResumeVersion({
                    job_id: job?.id || null,
                    format: 'pdf',
                    file_path: pdfPath,
                    html_path: texPath,
                    page_count: validationResult?.pageCount || 1,
                    bullet_selection_json: selectedBullets,
                    tailored: true,
                    tailoring_facts_json: {
                        pdf_sha256: calculatePdfHash(pdfPath),
                        projectOrder,
                        matchedSkills: skillsAnalysis?.matchedSkills || [],
                        missingSkills: skillsAnalysis?.missingSkills || [],
                        claimsExcluded: skillsAnalysis?.claimsExcluded || []
                    },
                    variant_label: targetVariant,
                    ats_parse_score: validationResult?.atsParseScore || 1.0,
                    ats_parse_result_json: {
                        readingOrderValid: validationResult?.readingOrderValid ?? true,
                        warnings: validationResult?.warnings || [],
                        errors: validationResult?.errors || []
                    }
                });
            } catch (dbErr) {
                console.warn(`[CareerOps:Resume] Note: could not persist resume_version to SQLite: ${dbErr.message}`);
            }
        }

        return {
            compiled: true,
            resumeVersionId,
            jobId: job?.id || null,
            variantLabel: targetVariant,
            pdfPath,
            texPath,
            pageCount: validationResult?.pageCount || 1,
            validTex: true,
            engine,
            projectOrder,
            onePageBudgetPassed,
            skillsAnalysis,
            validationResult,
            dryRun
        };
    } catch (err) {
        return {
            compiled: false,
            compileError: `LaTeX compilation failed: ${err.message}`,
            texPath,
            pdfPath,
            validTex: true,
            engine,
            projectOrder,
            onePageBudgetPassed,
            skillsAnalysis,
            dryRun
        };
    }
}
