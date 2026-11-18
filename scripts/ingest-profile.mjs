#!/usr/bin/env node

/**
 * scripts/ingest-profile.mjs — Ingest verified candidate profile into SQLite
 *
 * Populates:
 *   - candidate_facts (Skills, Experience, Education, Projects)
 *   - evidence_records (Detailed verifiable proof points linked to facts)
 *   - candidate_answers (Pre-verified screening question answers)
 *
 * Idempotent: safe to run repeatedly.
 * Reads candidate-specific data from ignored local configuration (config/candidate-facts-corpus.json).
 * In test mode or when synthetic fixtures are requested, uses deterministic synthetic profiles.
 */

import { existsSync, readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getDb, closeDb, runInTransaction } from '../db/db.mjs';
import {
    upsertCandidateFact,
    insertEvidenceRecord,
    upsertCandidateAnswer,
    confirmCandidateAnswer,
    countCandidateFacts
} from '../db/repo.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function ingestProfile(options = {}) {
    console.log('Ingesting verified candidate facts and evidence ledger into SQLite...\n');

    const countsBefore = countCandidateFacts();
    const useSynthetic = Boolean(options.useSynthetic || process.env.CAREER_OPS_TEST);

    let corpus = options.corpusData || null;
    const localCorpusPath = resolve(__dirname, '../config/candidate-facts-corpus.json');

    if (!useSynthetic && !corpus) {
        if (existsSync(localCorpusPath)) {
            try {
                corpus = JSON.parse(readFileSync(localCorpusPath, 'utf8'));
            } catch (err) {
                console.warn(`Failed to parse ${localCorpusPath}: ${err.message}`);
            }
        }
    }

    if (!useSynthetic && !corpus) {
        console.warn('Candidate facts corpus not found at config/candidate-facts-corpus.json. Skipping candidate data ingestion.');
        return {
            countsBefore,
            countsAfter: countsBefore,
            status: 'missing-configuration',
            warning: 'Candidate facts corpus not configured.'
        };
    }

    runInTransaction(() => {
        // ── 0. Legal Work Authorization ───────────────────────────────────
        const authFactId = 'fact-auth-india';
        upsertCandidateFact({
            id: authFactId,
            category: 'work_authorization',
            identifier: 'work_authorization_india',
            value: 'Citizen of India legally authorized to work full-time without employer sponsorship',
            evidence_type: 'self-attested',
            evidence_url: 'candidate_answers:ans-work_authorization_india',
            verified: true
        });

        insertEvidenceRecord({
            id: 'ev-auth-india-citizenship',
            fact_id: authFactId,
            title: 'Indian Work Authorization and Citizenship Confirmation',
            description: 'Candidate confirmed Indian citizenship and permanent legal authorization to work full-time in India without employer sponsorship.',
            source_type: 'self-attested',
            source_reference: 'candidate_answers:ans-work_authorization_india',
            verified: true
        });

        if (useSynthetic) {
            // ── 1. Synthetic Education ─────────────────────────────────────
            const eduFactId = 'fact-edu-synth-btech';
            upsertCandidateFact({
                id: eduFactId,
                category: 'education',
                identifier: 'degree-btech-cse',
                value: 'B.Tech in Computer Science & Engineering, Synthetic University (Graduation: May 2026, CGPA: 8.0)',
                evidence_type: 'education',
                evidence_url: 'cv.md:EDUCATION',
                verified: true
            });

            insertEvidenceRecord({
                id: 'ev-edu-synth-cgpa',
                fact_id: eduFactId,
                title: 'Undergraduate Academic Record',
                description: 'Bachelor of Technology in Computer Science & Engineering with cumulative CGPA of 8.0 at Synthetic University (2022–2026).',
                source_type: 'education',
                source_reference: 'cv.md:EDUCATION:Synthetic University',
                verified: true
            });

            // ── 2. Synthetic Professional Experience ───────────────────────
            const expTechCorpId = 'fact-exp-techcorp';
            upsertCandidateFact({
                id: expTechCorpId,
                category: 'experience',
                identifier: 'techcorp-fullstack-trainee',
                value: 'Full Stack Developer Trainee at TechCorp (December 2025 – March 2026, ~4 months)',
                evidence_type: 'work_experience',
                evidence_url: 'cv.md:EXPERIENCE:TechCorp',
                verified: true
            });

            insertEvidenceRecord({
                id: 'ev-exp-techcorp-apis',
                fact_id: expTechCorpId,
                title: 'RESTful API & Modular Architecture',
                description: 'Built and deployed scalable full-stack applications using MERN stack, integrating secure RESTful APIs and modular backend architecture.',
                source_type: 'work_experience',
                source_reference: 'cv.md:EXPERIENCE:TechCorp:bullet-1',
                verified: true
            });

            insertEvidenceRecord({
                id: 'ev-exp-techcorp-realtime',
                fact_id: expTechCorpId,
                title: 'Real-time WebSockets & Redis Cache',
                description: 'Implemented real-time features using WebSockets and server-side caching with Redis to reduce latency.',
                source_type: 'work_experience',
                source_reference: 'cv.md:EXPERIENCE:TechCorp:bullet-2',
                verified: true
            });

            insertEvidenceRecord({
                id: 'ev-exp-techcorp-cicd',
                fact_id: expTechCorpId,
                title: 'CI/CD & Cloud Deployment',
                description: 'Engineered automated CI/CD pipelines utilizing GitHub Actions and Docker to streamline testing and deployment directly to AWS.',
                source_type: 'work_experience',
                source_reference: 'cv.md:EXPERIENCE:TechCorp:bullet-3',
                verified: true
            });

            const expAcmeId = 'fact-exp-acme';
            upsertCandidateFact({
                id: expAcmeId,
                category: 'experience',
                identifier: 'acme-swe',
                value: 'Software Engineer at Acme Corp (May 2026 – July 2026, ~3 months)',
                evidence_type: 'work_experience',
                evidence_url: 'cv.md:EXPERIENCE:Acme Corp',
                verified: true
            });

            insertEvidenceRecord({
                id: 'ev-exp-acme-services',
                fact_id: expAcmeId,
                title: 'Backend Services & Responsive Frontend',
                description: 'Engineered high-performance backend modules and interactive user interfaces using Node.js, TypeScript, and React.',
                source_type: 'work_experience',
                source_reference: 'cv.md:EXPERIENCE:Acme Corp:bullet-1',
                verified: true
            });

            insertEvidenceRecord({
                id: 'ev-exp-acme-jobs',
                fact_id: expAcmeId,
                title: 'Resilient APIs & Database Optimization',
                description: 'Developed resilient RESTful APIs, optimized complex database transactions, and maintained asynchronous background jobs.',
                source_type: 'work_experience',
                source_reference: 'cv.md:EXPERIENCE:Acme Corp:bullet-2',
                verified: true
            });

            // ── 3. Synthetic Projects ──────────────────────────────────────
            const prjAlphaId = 'fact-prj-alpha';
            upsertCandidateFact({
                id: prjAlphaId,
                category: 'project',
                identifier: 'project-alpha',
                value: 'Project Alpha — Subscription-Based Reward Platform (React, Node.js, Supabase, PostgreSQL, Stripe)',
                evidence_type: 'project',
                evidence_url: 'cv.md:PROJECTS:Project Alpha',
                verified: true
            });

            insertEvidenceRecord({
                id: 'ev-prj-alpha-rls',
                fact_id: prjAlphaId,
                title: 'PostgreSQL RLS & Rolling Triggers',
                description: 'Architected secure PostgreSQL database with Row Level Security (RLS) and rolling triggers for automated reward tiering.',
                source_type: 'project',
                source_reference: 'cv.md:PROJECTS:Project Alpha:bullet-2',
                verified: true
            });

            const prjBetaId = 'fact-prj-beta';
            upsertCandidateFact({
                id: prjBetaId,
                category: 'project',
                identifier: 'project-beta',
                value: 'Project Beta — Multi-Tenant API Gateway (TypeScript, Node.js, Express, Redis, PostgreSQL, Docker)',
                evidence_type: 'project',
                evidence_url: 'cv.md:PROJECTS:Project Beta',
                verified: true
            });

            insertEvidenceRecord({
                id: 'ev-prj-beta-sandboxing',
                fact_id: prjBetaId,
                title: 'API Gateway Routing & Rate Limiting',
                description: 'Built reverse proxy API gateway with rate limiting and quota enforcement in atomic Redis Lua scripts.',
                source_type: 'project',
                source_reference: 'cv.md:PROJECTS:Project Beta:bullet-1',
                verified: true
            });

            const prjGammaId = 'fact-prj-gamma';
            upsertCandidateFact({
                id: prjGammaId,
                category: 'project',
                identifier: 'project-gamma',
                value: 'Project Gamma — Distributed Code Execution Engine (Docker, Node.js, WebSockets, AWS EC2)',
                evidence_type: 'project',
                evidence_url: 'cv.md:PROJECTS:Project Gamma',
                verified: true
            });

            insertEvidenceRecord({
                id: 'ev-prj-gamma-sandboxing',
                fact_id: prjGammaId,
                title: 'Docker Sandboxing & Sub-Second Execution',
                description: 'Architected secure multi-language code execution engine in isolated Docker sandboxes with CPU/memory limits and streaming output.',
                source_type: 'project',
                source_reference: 'cv.md:PROJECTS:Project Gamma:bullet-1',
                verified: true
            });

            const prjDeltaId = 'fact-prj-delta';
            upsertCandidateFact({
                id: prjDeltaId,
                category: 'project',
                identifier: 'project-delta',
                value: 'Project Delta — Real-Time Collaboration Workspace (React, Node.js, Socket.IO, Redis, JWT, AWS)',
                evidence_type: 'project',
                evidence_url: 'cv.md:PROJECTS:Project Delta',
                verified: true
            });

            insertEvidenceRecord({
                id: 'ev-prj-delta-socket',
                fact_id: prjDeltaId,
                title: 'Sub-100ms Real-Time Synchronization',
                description: 'Supported 50+ concurrent users with sub-100ms synchronization latency using Socket.IO and Redis-backed session caching.',
                source_type: 'project',
                source_reference: 'cv.md:PROJECTS:Project Delta:bullet-1',
                verified: true
            });
        } else {
            // ── Dynamic Ingestion from local candidate corpus ──────────────
            if (corpus.university && corpus.degrees) {
                const eduFactId = 'fact-edu-main';
                upsertCandidateFact({
                    id: eduFactId,
                    category: 'education',
                    identifier: 'degree-main',
                    value: `${corpus.degrees[0]}, ${corpus.university} (Graduation: May 2026, CGPA: ${corpus.cgpa || ''})`,
                    evidence_type: 'education',
                    evidence_url: 'cv.md:EDUCATION',
                    verified: true
                });

                insertEvidenceRecord({
                    id: 'ev-edu-main-record',
                    fact_id: eduFactId,
                    title: 'Undergraduate Academic Record',
                    description: `${corpus.degrees[0]} at ${corpus.university} (CGPA: ${corpus.cgpa || ''}).`,
                    source_type: 'education',
                    source_reference: `cv.md:EDUCATION:${corpus.university}`,
                    verified: true
                });
            }

            if (Array.isArray(corpus.companies)) {
                for (let i = 0; i < corpus.companies.length; i++) {
                    const comp = corpus.companies[i];
                    const expId = `fact-exp-${comp.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
                    upsertCandidateFact({
                        id: expId,
                        category: 'experience',
                        identifier: `exp-${comp.toLowerCase().replace(/[^a-z0-9]/g, '')}`,
                        value: `Software Engineer at ${comp}`,
                        evidence_type: 'work_experience',
                        evidence_url: `cv.md:EXPERIENCE:${comp}`,
                        verified: true
                    });

                    insertEvidenceRecord({
                        id: `ev-exp-${i}-record`,
                        fact_id: expId,
                        title: `${comp} Work Experience`,
                        description: `Verified software engineering contribution at ${comp}.`,
                        source_type: 'work_experience',
                        source_reference: `cv.md:EXPERIENCE:${comp}`,
                        verified: true
                    });
                }
            }

            if (corpus.projects && typeof corpus.projects === 'object') {
                for (const [key, p] of Object.entries(corpus.projects)) {
                    const prjId = `fact-prj-${key.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
                    upsertCandidateFact({
                        id: prjId,
                        category: 'project',
                        identifier: `project-${key}`,
                        value: `${p.title || key} (${p.tech || ''})`,
                        evidence_type: 'project',
                        evidence_url: `cv.md:PROJECTS:${key}`,
                        verified: true
                    });

                    if (Array.isArray(p.allowedBullets)) {
                        for (let bi = 0; bi < p.allowedBullets.length; bi++) {
                            insertEvidenceRecord({
                                id: `ev-prj-${key}-${bi}`,
                                fact_id: prjId,
                                title: `${p.title || key} - Bullet ${bi + 1}`,
                                description: p.allowedBullets[bi],
                                source_type: 'project',
                                source_reference: `cv.md:PROJECTS:${key}:bullet-${bi + 1}`,
                                verified: true
                            });
                        }
                    }
                }
            }
        }

        // ── 4. Core Skills ───────────────────────────────────────────────
        const skills = [
            { key: 'typescript', name: 'TypeScript', cat: 'language' },
            { key: 'javascript', name: 'JavaScript (ES6+)', cat: 'language' },
            { key: 'nodejs', name: 'Node.js & Express', cat: 'backend' },
            { key: 'react', name: 'React.js', cat: 'frontend' },
            { key: 'nextjs', name: 'Next.js', cat: 'frontend' },
            { key: 'react-native', name: 'React Native', cat: 'frontend' },
            { key: 'postgresql', name: 'PostgreSQL', cat: 'database' },
            { key: 'mongodb', name: 'MongoDB', cat: 'database' },
            { key: 'redis', name: 'Redis (Caching & Queues)', cat: 'database' },
            { key: 'docker', name: 'Docker & Docker Compose', cat: 'devops' },
            { key: 'aws', name: 'AWS (EC2, S3)', cat: 'devops' },
            { key: 'websockets', name: 'WebSockets & Socket.IO', cat: 'backend' },
            { key: 'rest-apis', name: 'RESTful API Architecture', cat: 'backend' },
            { key: 'ci-cd', name: 'GitHub Actions & CI/CD', cat: 'devops' }
        ];

        for (const sk of skills) {
            upsertCandidateFact({
                id: `fact-skill-${sk.key}`,
                category: 'skill',
                identifier: sk.key,
                value: sk.name,
                evidence_type: 'work_experience',
                evidence_url: `cv.md:TECHNICAL SKILLS:${sk.name}`,
                verified: true
            });
        }

        // ── 5. Candidate Screening Answers (Answer Bank) ─────────────────
        const answers = [
            {
                key: 'work_authorization_india',
                question: 'Are you legally authorized to work in India?',
                answer: 'Yes, I am a citizen of India and legally authorized to work full-time without requiring sponsorship.',
                context: 'Work authorization'
            },
            {
                key: 'notice_period',
                question: 'What is your notice period or earliest availability?',
                answer: 'Immediate joiner. I have no notice period and can start immediately upon offer confirmation.',
                context: 'Availability'
            },
            {
                key: 'graduation_date',
                question: 'When is your graduation date?',
                answer: useSynthetic
                    ? 'May 2026 (Bachelor of Technology in Computer Science & Engineering from Synthetic University).'
                    : `May 2026 (Bachelor of Technology in Computer Science & Engineering from ${corpus?.university || 'University'}).`,
                context: 'Education timing'
            },
            {
                key: 'years_of_experience',
                question: 'How many years of professional software engineering experience do you have?',
                answer: useSynthetic
                    ? 'Approximately 7 months of professional hands-on software development experience (Full Stack Developer Trainee at TechCorp from Dec 2025–Mar 2026, and Software Engineer at Acme Corp from May–Jul 2026).'
                    : 'Approximately 7 months of professional hands-on software development experience across trainee and software engineering roles.',
                context: 'Experience level'
            },
            {
                key: 'preferred_locations',
                question: 'What are your preferred work locations?',
                answer: 'Open to Bengaluru, Pune, Hyderabad, and Remote India positions.',
                context: 'Location flexibility'
            },
            {
                key: 'salary_expectations',
                question: 'What are your compensation expectations?',
                answer: 'Targeting competitive compensation aligned with role scope and growth opportunity.',
                context: 'Compensation'
            },
            {
                key: 'primary_tech_stack',
                question: 'What is your primary technology stack?',
                answer: 'TypeScript/JavaScript, Node.js, Express, React, PostgreSQL, Redis, Docker, and AWS.',
                context: 'Technical expertise'
            }
        ];

        for (const ans of answers) {
            upsertCandidateAnswer({
                id: `ans-${ans.key}`,
                question_key: ans.key,
                question_text: ans.question,
                answer_value: ans.answer,
                context: ans.context,
                source: 'verified_profile',
                confidence: 1.0
            });
            if (ans.key === 'work_authorization_india') {
                confirmCandidateAnswer(ans.key);
            }
        }
    });

    const countsAfter = countCandidateFacts();
    console.log(`Candidate facts ingested: Before: ${countsBefore} -> After: ${countsAfter}`);
    console.log('Candidate facts and evidence ledger successfully written.\n');

    closeDb();
    return { countsBefore, countsAfter };
}

if (process.argv[1]?.endsWith('ingest-profile.mjs')) {
    ingestProfile();
}
