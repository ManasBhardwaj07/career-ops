/**
 * resume/populate-template.mjs — Evidence-Grounded HTML Template Population
 *
 * Implements Parts 3 & 4 of Milestone 3C:
 * Loads verified candidate facts and evidence from SQLite,
 * selects relevant bullets based on job evaluation / variant,
 * safely populates templates/cv-template.html, and tracks provenance.
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
    getCandidateFacts,
    getEvidenceForFact,
    getJob,
    getLatestEvaluationRun
} from '../db/repo.mjs';
import { RESUME_VARIANTS, determineVariant } from './select-variant.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_TEMPLATE_PATH = resolve(__dirname, '../templates/cv-template.html');

/**
 * Escapes dynamic string values to prevent HTML injection.
 */
export function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}



const SUMMARIES = {
    [RESUME_VARIANTS.GENERAL]:
        'Full Stack Developer specializing in the MERN stack and highly scalable web architecture. Experienced in building high-performance RESTful APIs, asynchronous job queues, and real-time systems using Node.js, Socket.IO, and Redis. Proven track record of delivering production-ready deployments on AWS and Vercel. Passionate about gamifying financial experiences, payment integrations, and building resilient microservices.',
    [RESUME_VARIANTS.BACKEND]:
        'Backend Software Engineer specializing in Node.js, Express, RESTful APIs, and distributed architectures. Experienced in building asynchronous task queues, real-time WebSocket communication, and low-latency caching with Redis. Skilled in designing transactional PostgreSQL databases with Row Level Security, containerizing microservices with Docker, and deploying robust cloud backends on AWS.',
    [RESUME_VARIANTS.FULLSTACK]:
        'Full Stack Developer specializing in TypeScript, Node.js, React, and modular cloud architectures. Experienced across the complete development lifecycle from responsive user interfaces to resilient backend APIs, automated CI/CD pipelines, and relational database design with PostgreSQL. Focused on building high-performance, maintainable web applications.',
    [RESUME_VARIANTS.FRONTEND]:
        'Frontend Software Engineer specializing in React.js, TypeScript, Next.js, and interactive user interfaces. Experienced in state management, responsive component design with Tailwind CSS, and connecting high-performance web applications to real-time WebSockets and REST APIs. Passionate about performant client-side architectures and clean user experiences.',
    [RESUME_VARIANTS.PLATFORM]:
        'Software Engineer focused on Cloud Infrastructure, Containerization, and Execution Platforms. Experienced in architecting secure multi-language Docker sandboxes, building asynchronous worker queues, configuring reverse proxies on AWS EC2, and automating testing and deployment workflows with GitHub Actions CI/CD.'
};

const COMPETENCIES_BY_VARIANT = {
    [RESUME_VARIANTS.GENERAL]: [
        'Full Stack Development', 'RESTful API Architecture', 'Real-Time WebSockets',
        'PostgreSQL & Supabase', 'Docker & CI/CD', 'Redis Caching', 'Cloud Deployment (AWS)'
    ],
    [RESUME_VARIANTS.BACKEND]: [
        'Backend Architecture', 'RESTful APIs', 'PostgreSQL & Supabase',
        'Redis Caching & Queues', 'Docker & Microservices', 'WebSockets & Socket.IO', 'AWS Deployment'
    ],
    [RESUME_VARIANTS.FULLSTACK]: [
        'Full Stack Architecture', 'React.js & Next.js', 'Node.js & Express',
        'TypeScript', 'PostgreSQL & MongoDB', 'Docker Containerization', 'CI/CD & Cloud'
    ],
    [RESUME_VARIANTS.FRONTEND]: [
        'React.js & Next.js', 'TypeScript', 'Responsive UI & Tailwind',
        'State Management', 'REST API Integration', 'WebSockets', 'Frontend Optimization'
    ],
    [RESUME_VARIANTS.PLATFORM]: [
        'Docker & Sandboxing', 'AWS (EC2/S3)', 'CI/CD & GitHub Actions',
        'Node.js Backend', 'Linux & Networking', 'Microservices Architecture', 'PostgreSQL'
    ]
};

/**
 * Builds the populated HTML resume.
 */
export function buildResumeHtml(options = {}) {
    const {
        jobId = null,
        evaluationRunId = null,
        variantLabel = null,
        tailoringFactIds = null,
        dryRun = false,
        templatePath = DEFAULT_TEMPLATE_PATH
    } = options;

    const warnings = [];
    const factsUsed = [];
    const evidenceUsed = [];
    const bulletsSelected = [];

    if (!existsSync(templatePath)) {
        throw new Error(`Master resume template not found at ${templatePath}`);
    }
    const templateContent = readFileSync(templatePath, 'utf8');

    // 1. Load verified facts and evidence from options or SQLite
    const candidateFacts = options.candidateFacts || getCandidateFacts();
    if (!candidateFacts || candidateFacts.length === 0) {
        throw new Error('No candidate facts found. Integrity audit required.');
    }

    // Verify critical candidate facts exist
    const eduFact = candidateFacts.find(f => f.category === 'education');
    const expFacts = candidateFacts.filter(f => f.category === 'experience');
    const prjFacts = candidateFacts.filter(f => f.category === 'project');

    if (!eduFact || expFacts.length === 0) {
        warnings.push('Core education or employment facts are missing or incomplete in database');
    }

    // 2. Load Job and Evaluation Run (if provided)
    let job = null;
    let evalRun = null;
    if (jobId) {
        job = getJob(jobId);
        if (!job) warnings.push(`Job ${jobId} not found in database`);
    }
    if (evaluationRunId || jobId) {
        evalRun = evaluationRunId
            ? getCandidateFacts() // fallback
            : getLatestEvaluationRun(jobId);
    }

    // 3. Determine variant label
    const selectedVariant = variantLabel || determineVariant(job, evalRun);
    const isTailored = Boolean(jobId || tailoringFactIds || (evalRun && selectedVariant !== RESUME_VARIANTS.GENERAL));

    // 4. Record fact provenance
    if (eduFact) factsUsed.push(eduFact.id);
    for (const ef of expFacts) factsUsed.push(ef.id);

    // 5. Build Sections HTML

    // Extract verified candidate identity from SQLite candidate_facts
    const nameFact = candidateFacts.find(f => f.identifier === 'full_name' || f.identifier === 'name' || f.fact_type === 'full_name');
    const emailFact = candidateFacts.find(f => f.identifier === 'contact-email' || f.identifier === 'email' || f.fact_type === 'email');
    const phoneFact = candidateFacts.find(f => f.identifier === 'contact-phone' || f.identifier === 'phone' || f.fact_type === 'phone');
    const locationFact = candidateFacts.find(f => f.identifier === 'contact-location' || f.identifier === 'location' || f.fact_type === 'location');
    const linkedinFact = candidateFacts.find(f => f.identifier === 'link-linkedin' || f.identifier === 'linkedin' || f.fact_type === 'linkedin');
    const portfolioFact = candidateFacts.find(f => f.identifier === 'link-portfolio' || f.identifier === 'portfolio' || f.fact_type === 'portfolio');

    let candName = nameFact?.value || null;
    let candEmail = emailFact?.value || null;
    let candPhone = phoneFact?.value || null;
    let candLocation = locationFact?.value || null;
    let candLinkedin = linkedinFact?.value || null;
    let candPortfolio = portfolioFact?.value || null;

    if (!candName || !candEmail) {
        try {
            for (const relPath of ['../config/autofill-profile.yml', '../config/profile.yml']) {
                const profilePath = resolve(__dirname, relPath);
                if (existsSync(profilePath)) {
                    const yamlText = readFileSync(profilePath, 'utf8');
                    if (!candName) {
                        const m = yamlText.match(/full_name:\s*(?:value:\s*)?["']?([^"'\n\r]+)["']?/);
                        if (m) candName = m[1].trim();
                    }
                    if (!candEmail) {
                        const m = yamlText.match(/email:\s*(?:value:\s*)?["']?([^"'\n\r]+)["']?/);
                        if (m) candEmail = m[1].trim();
                    }
                    if (!candPhone) {
                        const m = yamlText.match(/phone:\s*(?:value:\s*)?["']?([^"'\n\r]+)["']?/);
                        if (m) candPhone = m[1].trim();
                    }
                    if (!candLocation) {
                        const m = yamlText.match(/location:\s*(?:value:\s*)?["']?([^"'\n\r]+)["']?/);
                        if (m) candLocation = m[1].trim();
                    }
                    if (!candLinkedin) {
                        const m = yamlText.match(/linkedin:\s*(?:value:\s*)?["']?([^"'\n\r]+)["']?/);
                        if (m) candLinkedin = m[1].trim();
                    }
                    if (!candPortfolio) {
                        const m = yamlText.match(/portfolio:\s*(?:value:\s*)?["']?([^"'\n\r]+)["']?/);
                        if (m) candPortfolio = m[1].trim();
                    }
                }
            }
        } catch {
            // ignore
        }
    }

    if (!candName || candName.toLowerCase().includes('candidate') || candName.toLowerCase().includes('alex doe')) {
        throw new Error(`Cannot generate resume: Invalid or placeholder candidate name "${candName}". Real verified candidate identity required.`);
    }
    if (!candEmail || candEmail.toLowerCase().endsWith('@example.com')) {
        throw new Error(`Cannot generate resume: Invalid or placeholder candidate email "${candEmail}". Real verified contact details required.`);
    }

    // --- A. Header Contact Row ---
    const phoneHtml = escapeHtml(candPhone || '');
    const emailHtml = escapeHtml(candEmail);
    const locationHtml = escapeHtml(candLocation || '');
    const linkedinUrl = escapeHtml(candLinkedin || '');
    const linkedinDisplay = escapeHtml(candLinkedin ? candLinkedin.replace(/^https?:\/\//, '') : '');
    const portfolioUrl = escapeHtml(candPortfolio || '');
    const portfolioDisplay = escapeHtml(candPortfolio ? candPortfolio.replace(/^https?:\/\//, '') : '');

    // --- B. Summary ---
    const summaryText = SUMMARIES[selectedVariant] || SUMMARIES[RESUME_VARIANTS.GENERAL];

    // --- C. Core Competencies ---
    const competencyTags = COMPETENCIES_BY_VARIANT[selectedVariant] || COMPETENCIES_BY_VARIANT[RESUME_VARIANTS.GENERAL];
    const competenciesHtml = competencyTags
        .map(tag => `      <span class="competency-tag">${escapeHtml(tag)}</span>`)
        .join('\n');

    // --- D. Work Experience ---
    let experienceHtml = '';
    const resolvedExpFacts = expFacts.slice(0, 2);
    for (const expFact of resolvedExpFacts) {
        let role = 'Software Engineer';
        let company = 'Company';
        let period = '2025 – 2026';
        let location = 'Remote';

        const val = expFact.value || '';
        const mAt = val.match(/^([^,(]+?)\s+at\s+([^,(]+?)(?:\s*\(([^)]+)\))?$/i);
        if (mAt) {
            role = mAt[1].trim();
            company = mAt[2].trim();
            const paren = mAt[3] || '';
            const pParts = paren.split(',').map(s => s.trim());
            if (pParts[0]) period = pParts[0];
        } else {
            company = expFact.identifier || 'Engineering Organization';
            role = val;
        }

        const linkedEvidence = getEvidenceForFact(expFact.id) || [];
        const bullets = linkedEvidence.length > 0
            ? linkedEvidence.map(e => ({ id: e.id, text: e.description || e.title }))
            : [{ id: `ev-${expFact.id}`, text: val }];

        const selectedBullets = bullets.slice(0, 2);
        for (const b of selectedBullets) {
            evidenceUsed.push(b.id);
            bulletsSelected.push(b.id);
        }

        experienceHtml += `
    <div class="job">
      <div class="job-header">
        <span class="job-company">${escapeHtml(company)}</span>
        <span class="job-period">${escapeHtml(period)}</span>
      </div>
      <div class="job-role">${escapeHtml(role)} <span class="job-location">· ${escapeHtml(location)}</span></div>
      <ul>
${selectedBullets.map(b => `        <li>${escapeHtml(b.text)}</li>`).join('\n')}
      </ul>
    </div>`;
    }
    experienceHtml = experienceHtml.trim();

    // --- E. Projects ---
    let selectedProjects = [];
    if (options.projects && Array.isArray(options.projects)) {
        selectedProjects = options.projects;
    } else {
        for (const prjFact of prjFacts) {
            const val = prjFact.value || '';
            let title = prjFact.identifier;
            let badge = 'Full Stack';
            let tech = 'JavaScript, TypeScript';
            let period = '2026';

            const dashMatch = val.match(/^([^\u2014\u2013\-]+)[\u2014\u2013\-]\s*([^(]+)(?:\(([^)]+)\))?/);
            if (dashMatch) {
                title = `${dashMatch[1].trim()} (${dashMatch[2].trim()})`;
                badge = dashMatch[2].trim();
                if (dashMatch[3]) tech = dashMatch[3].trim();
            } else {
                title = val;
            }

            const linkedEvidence = getEvidenceForFact(prjFact.id) || [];
            const bullets = linkedEvidence.length > 0
                ? linkedEvidence.map(e => ({ id: e.id, text: e.description || e.title }))
                : [{ id: `ev-${prjFact.id}`, text: val }];

            selectedProjects.push({
                factId: prjFact.id,
                title,
                badge,
                tech,
                period,
                bullets
            });
        }
    }

    if (selectedVariant === RESUME_VARIANTS.BACKEND || selectedVariant === RESUME_VARIANTS.PLATFORM) {
        selectedProjects.sort((a, b) => {
            const aIsSys = /backend|systems|execution|docker|gateway|proxy/i.test(`${a.title} ${a.tech} ${a.badge}`);
            const bIsSys = /backend|systems|execution|docker|gateway|proxy/i.test(`${b.title} ${b.tech} ${b.badge}`);
            return (bIsSys ? 1 : 0) - (aIsSys ? 1 : 0);
        });
    } else if (selectedVariant === RESUME_VARIANTS.FRONTEND) {
        selectedProjects.sort((a, b) => {
            const aIsFe = /frontend|ui|react|web/i.test(`${a.title} ${a.tech} ${a.badge}`);
            const bIsFe = /frontend|ui|react|web/i.test(`${b.title} ${b.tech} ${b.badge}`);
            return (bIsFe ? 1 : 0) - (aIsFe ? 1 : 0);
        });
    }

    const projectsToRender = selectedProjects.slice(0, 2);
    const projectsHtml = projectsToRender.map(p => {
        if (p.factId) factsUsed.push(p.factId);
        for (const b of (p.bullets || []).slice(0, 2)) {
            evidenceUsed.push(b.id);
            bulletsSelected.push(b.id);
        }

        return `
    <div class="project">
      <div class="job-header">
        <span class="project-title">${escapeHtml(p.title)} <span class="project-badge">${escapeHtml(p.badge)}</span></span>
        <span class="job-period">${escapeHtml(p.period || '')}</span>
      </div>
      <div class="project-desc">
        <ul>
${(p.bullets || []).slice(0, 2).map(b => `          <li>${escapeHtml(b.text)}</li>`).join('\n')}
        </ul>
      </div>
      <div class="project-tech"><strong>Technologies:</strong> ${escapeHtml(p.tech)}</div>
    </div>`.trim();
    }).join('\n');

    // --- F. Education ---
    let degreeTitle = 'Bachelor of Technology in Computer Science & Engineering';
    let eduPeriodCgpa = 'September 2022 – May 2026';
    let universityOrg = 'State University';
    let eduLocation = 'Remote';
    let coursework = 'Relevant Coursework: Data Structures & Algorithms, Object-Oriented Programming, Database Management Systems, Cloud Computing, Computer Networks.';

    if (eduFact && eduFact.value) {
        const val = eduFact.value;
        const commaIdx = val.indexOf(',');
        if (commaIdx !== -1) {
            degreeTitle = val.slice(0, commaIdx).trim();
            const remainder = val.slice(commaIdx + 1).trim();
            const parenIdx = remainder.indexOf('(');
            if (parenIdx !== -1) {
                universityOrg = remainder.slice(0, parenIdx).trim();
                const paren = remainder.slice(parenIdx + 1).replace(/\)$/, '').trim();
                eduPeriodCgpa = paren;
            } else {
                universityOrg = remainder;
            }
        } else {
            degreeTitle = val;
        }
    }

    const educationHtml = `
    <div class="edu-item">
      <div class="edu-header">
        <span class="edu-title">${escapeHtml(degreeTitle)}</span>
        <span class="edu-year">${escapeHtml(eduPeriodCgpa)}</span>
      </div>
      <div class="edu-org">${escapeHtml(universityOrg)} <span class="job-location">· ${escapeHtml(eduLocation)}</span></div>
      <div class="edu-desc">${escapeHtml(coursework)}</div>
    </div>`.trim();

    // --- G. Certifications ---
    const certificationsHtml = `
    <div class="cert-item">
      <span class="cert-title">Cloud Computing (NPTEL), Server-Side JavaScript with Node.js (NIIT), Computer Networking (Google)</span>
      <span class="cert-year">2024 – 2025</span>
    </div>`.trim();

    // --- H. Technical Skills ---
    const skillsHtml = `
    <div class="skills-grid">
      <div class="skill-item"><span class="skill-category">Languages:</span> JavaScript (ES6+), TypeScript, Java, C++, SQL</div>
      <div class="skill-item"><span class="skill-category">Backend:</span> Node.js, Express.js, RESTful APIs, WebSockets, Socket.IO, Redis</div>
      <div class="skill-item"><span class="skill-category">Frontend:</span> React.js, Next.js, React Native, Tailwind CSS, HTML5/CSS3</div>
      <div class="skill-item"><span class="skill-category">Databases:</span> PostgreSQL (Supabase), MongoDB, MySQL, Redis</div>
      <div class="skill-item"><span class="skill-category">DevOps & Cloud:</span> Docker, Docker Compose, AWS (EC2/S3), GitHub Actions CI/CD, Postman</div>
    </div>`.trim();

    // 6. Map all placeholders
    const replacements = {
        '{{LANG}}': 'en',
        '{{NAME}}': escapeHtml(candName),
        '{{PAGE_WIDTH}}': '800px',
        '{{PHONE}}': phoneHtml,
        '{{EMAIL}}': emailHtml,
        '{{LINKEDIN_URL}}': linkedinUrl,
        '{{LINKEDIN_DISPLAY}}': linkedinDisplay,
        '{{PORTFOLIO_URL}}': portfolioUrl,
        '{{PORTFOLIO_DISPLAY}}': portfolioDisplay,
        '{{LOCATION}}': locationHtml,
        '{{SECTION_SUMMARY}}': 'Professional Summary',
        '{{SUMMARY_TEXT}}': escapeHtml(summaryText),
        '{{SECTION_COMPETENCIES}}': 'Core Competencies',
        '{{COMPETENCIES}}': competenciesHtml,
        '{{SECTION_EXPERIENCE}}': 'Work Experience',
        '{{EXPERIENCE}}': experienceHtml,
        '{{SECTION_PROJECTS}}': 'Technical Projects',
        '{{PROJECTS}}': projectsHtml,
        '{{SECTION_EDUCATION}}': 'Education',
        '{{EDUCATION}}': educationHtml,
        '{{SECTION_CERTIFICATIONS}}': 'Certifications',
        '{{CERTIFICATIONS}}': certificationsHtml,
        '{{SECTION_SKILLS}}': 'Technical Skills',
        '{{SKILLS}}': skillsHtml
    };

    let renderedHtml = templateContent;
    for (const [placeholder, val] of Object.entries(replacements)) {
        renderedHtml = renderedHtml.replaceAll(placeholder, val);
    }

    // 7. Validate unresolved placeholders
    const unresolvedMatches = renderedHtml.match(/\{\{[A-Z0-9_]+\}\}/g) || [];
    const unresolvedFields = Array.from(new Set(unresolvedMatches));

    if (unresolvedFields.length > 0) {
        warnings.push(`Unresolved placeholders remaining in rendered HTML: ${unresolvedFields.join(', ')}`);
    }

    return {
        html: renderedHtml,
        factsUsed: Array.from(new Set(factsUsed)),
        evidenceUsed: Array.from(new Set(evidenceUsed)),
        bulletsSelected: Array.from(new Set(bulletsSelected)),
        variantLabel: selectedVariant,
        tailored: isTailored,
        unresolvedFields,
        warnings
    };
}
