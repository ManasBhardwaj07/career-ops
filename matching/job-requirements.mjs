/**
 * matching/job-requirements.mjs — Multi-Tier Job Requirement Analyzer & Flexible Fit Evaluator
 *
 * Implements Part D & Part F of Flexible Job-Fit Architecture:
 *   - 6-Tier requirement categorization:
 *       1. HARD_ELIGIBILITY (Legal, location, degree knockouts, 3+ yrs experience)
 *       2. MANDATORY_TECHNICAL (Core primary technical demands)
 *       3. PREFERRED_TECHNICAL ("Nice to have", "plus", "preferred")
 *       4. TRANSFERABLE_SKILLS (Adjacent verified experience that transfers)
 *       5. BONUS_SKILLS (Secondary tools/libraries)
 *       6. LOW_IMPORTANCE_KEYWORDS (Generic buzzwords)
 *   - Realistic partial-fit scoring: retains worthwhile partial-fit jobs without hard-rejecting
 *   - Actionable skill gap strategies (partial fit, candidate confirmation, proposed project)
 *   - Zero Fabrication (R16): missing skills are NEVER claimed without verified evidence
 */

import { CANDIDATE_SKILL_REGISTRY, SKILL_CLASSIFICATIONS, findSkill } from './evidence-model.mjs';

export const REQUIREMENT_TIERS = Object.freeze({
    HARD_ELIGIBILITY: 'HARD_ELIGIBILITY',
    MANDATORY_TECHNICAL: 'MANDATORY_TECHNICAL',
    PREFERRED_TECHNICAL: 'PREFERRED_TECHNICAL',
    TRANSFERABLE_SKILLS: 'TRANSFERABLE_SKILLS',
    BONUS_SKILLS: 'BONUS_SKILLS',
    LOW_IMPORTANCE_KEYWORDS: 'LOW_IMPORTANCE_KEYWORDS'
});

export const APPLICATION_STRATEGIES = Object.freeze({
    APPLY_STRONG_FIT: 'APPLY_STRONG_FIT',
    APPLY_PARTIAL_FIT: 'APPLY_PARTIAL_FIT',
    PURSUE_WITH_CONFIRMATION: 'PURSUE_WITH_CONFIRMATION',
    PROPOSE_PROJECT_IMPROVEMENT: 'PROPOSE_PROJECT_IMPROVEMENT',
    DO_NOT_APPLY_LOW_FIT: 'DO_NOT_APPLY_LOW_FIT',
    REJECT_HARD_KNOCKOUT: 'REJECT_HARD_KNOCKOUT'
});

/**
 * Known transferable adjacency mappings:
 * When a JD asks for targetSkill, verified sourceSkills provide partial transferable credit.
 */
export const TRANSFERABLE_ADJACENCIES = [
    {
        target: 'Python',
        transferableSources: ['Node.js', 'TypeScript', 'SQL', 'REST APIs'],
        rationale: 'Backend architecture, concurrency, database modeling, and REST APIs transfer readily to Python backend ecosystems.'
    },
    {
        target: 'FastAPI',
        transferableSources: ['Express.js', 'REST APIs', 'TypeScript'],
        rationale: 'High-performance asynchronous request handling, schema validation, and REST API design in Express/Node transfer to FastAPI.'
    },
    {
        target: 'Golang',
        transferableSources: ['C++', 'Node.js', 'Distributed Systems'],
        rationale: 'Systems programming, memory safety concepts, and asynchronous worker concurrency transfer to Go.'
    },
    {
        target: 'Kubernetes',
        transferableSources: ['Docker', 'Azure', 'AWS EC2/S3'],
        rationale: 'Production containerization, ephemeral sandboxing, and cloud VM orchestration transfer directly to Kubernetes pod concepts.'
    },
    {
        target: 'RAG (Retrieval-Augmented Generation)',
        transferableSources: ['PostgreSQL', 'Redis', 'LLM-Assisted Engineering'],
        rationale: 'Database indexing, Redis caching, and LLM test-generation pipelines provide strong transferable foundations for RAG architectures.'
    },
    {
        target: 'GraphQL',
        transferableSources: ['REST APIs', 'PostgreSQL', 'Prisma ORM'],
        rationale: 'Relational data modeling, query optimization, and schema-driven API contracts transfer to GraphQL.'
    }
];

/**
 * Extracts and normalizes experience requirements from job text and title.
 * Distinguishes mandatory minimum requirements, preferred experience, and entry-level/fresher roles.
 */
export function extractExperienceRequirement(fullText = '', title = '') {
    const clean = `${title}. ${fullText}`
        .replace(/&lt;\/(?:li|p|div|h\d)&gt;|<\/(?:li|p|div|h\d)>|<br\s*\/?>|&lt;br\s*\/?&gt;/gi, '. ')
        .replace(/&lt;[^&]*?&gt;|<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    const isSeniorTitle = /\b(sr\.?|senior|staff|principal|lead|director|vp|head of)\b/i.test(title || '') ||
        /\b(?:engineer|sde|developer|architect)\s*(?:-|\s)?(?:ii|iii|iv|2|3|4)\b/i.test(title || '');

    const isFresher = /\b(?:fresher|freshers\s+welcome|entry[- ]level|college\s+grad(?:uate)?|graduate\s+engineer\s+trainee|0\s*(?:-|to)\s*[12]\s*years?)\b/i.test(clean);

    const expRegexes = [
        /(?:experience\s*[:\s]+(?:of\s+)?|minimum\s+(?:of\s+)?|at\s+least\s+)(\d+)\s*(?:-|to|\+)?\s*(\d+)?\s*\+?\s*years?/i,
        /(\d+)\s*(?:-|to)\s*(\d+)\s*\+?\s*years?(?:\s+(?:of|in))?\s+(?:(?:relevant|professional|full[- ]?time|software|industry|work|full[- ]?stack|backend|frontend|engineering|development|hands[- ]on)\s+)*(?:experience|engineering|systems|development|software)?/i,
        /(\d+)\s*\+\s*years?(?:\s+(?:of|in))?\s+(?:(?:relevant|professional|full[- ]?time|software|industry|work|full[- ]?stack|backend|frontend|engineering|development|hands[- ]on)\s+)*(?:experience|engineering|systems|development|software)?/i,
        /\b(?:require|requires|required)\s*[:\s]+.*?(\d+)\+?\s*years?/i
    ];

    let match = null;
    for (const r of expRegexes) {
        match = clean.match(r);
        if (match) break;
    }

    if (!match && !isSeniorTitle) {
        return {
            minYears: isFresher ? 0 : null,
            maxYears: isFresher ? 1 : null,
            isFresher,
            isSeniorTitle: false,
            isPreferred: false,
            raw: null
        };
    }

    const minYears = isSeniorTitle ? Math.max(match ? parseInt(match[1], 10) : 3, 3) : (match ? parseInt(match[1], 10) : null);
    const maxYears = match && match[2] ? parseInt(match[2], 10) : minYears;

    let isPreferred = isFresher;
    if (match) {
        const matchIndex = match.index || 0;
        const startBound = Math.max(0, clean.lastIndexOf('.', matchIndex) + 1);
        const nextDot = clean.indexOf('.', matchIndex + match[0].length);
        const endBound = nextDot === -1 ? clean.length : nextDot;
        const sentence = clean.slice(startBound, endBound).toLowerCase();

        isPreferred = sentence.includes('preferred') ||
                      sentence.includes('is a plus') ||
                      sentence.includes('nice to have') ||
                      sentence.includes('bonus') ||
                      sentence.includes('good to have') ||
                      isFresher;
    }

    return {
        minYears,
        maxYears,
        isFresher,
        isSeniorTitle,
        isPreferred,
        raw: match ? match[0] : (isSeniorTitle ? title : null)
    };
}

/**
 * Analyzes a job posting across all 6 requirement tiers.
 */
export function analyzeJobRequirements(job) {
    if (!job) {
        return {
            hardKnockouts: [],
            mandatorySkills: [],
            preferredSkills: [],
            transferableSkills: [],
            missingGaps: [],
            disclaimedSkills: [],
            experienceAnalysis: null
        };
    }

    const title = (job.title || '').toLowerCase();
    const desc = (job.description || '').toLowerCase();
    const fullText = `${title} ${desc}`;

    // 1. Check Hard Eligibility Knockouts
    const hardKnockouts = [];

    // Mandatory US / Citizenship Knockout without sponsorship
    if (/\b(u\.?s\.?\s*citizen|citizenship required|green card|permanent resident)\b/i.test(fullText) ||
        fullText.includes('authorized to work in the us with no visa sponsorship') ||
        fullText.includes('no visa sponsorship')) {
        hardKnockouts.push({
            gate: 'citizenship_authorization',
            reason: 'Job strictly requires US citizenship or US permanent residency without sponsorship.'
        });
    }

    // Senior / Staff / Principal & Mandatory Minimum Experience Check
    // Candidate actual experience: ~7 months (0.58 years) across verified employment
    const experienceAnalysis = extractExperienceRequirement(desc, job.title);

    if (experienceAnalysis.isSeniorTitle) {
        hardKnockouts.push({
            gate: 'seniority_threshold',
            reason: `Role seniority (${job.title}) exceeds candidate early-career profile (~7 months experience).`
        });
    } else if (experienceAnalysis.minYears !== null && !experienceAnalysis.isPreferred) {
        // Mandatory minimum experience requirement: 3+ years is a hard knockout for ~7 months
        if (experienceAnalysis.minYears >= 3) {
            hardKnockouts.push({
                gate: 'seniority_threshold',
                reason: `Job requires mandatory minimum of ${experienceAnalysis.minYears}+ years experience; candidate early-career profile has ~7 months verified employment.`
            });
        }
    }

    // Explicit advanced degree knockout
    if (fullText.includes('phd required') || fullText.includes('ph.d. required') || fullText.includes('doctorate required')) {
        hardKnockouts.push({
            gate: 'degree_knockout',
            reason: 'Role strictly mandates a PhD / Doctorate degree.'
        });
    }

    // Foreign on-site presence without sponsorship
    const location = (job.location || '').toLowerCase();
    const isIndia = location.includes('india') || location.includes('bengaluru') || location.includes('bangalore') ||
                    location.includes('mumbai') || location.includes('delhi') || location.includes('hyderabad') ||
                    location.includes('pune') || location.includes('chennai') || location.includes('noida') || location.includes('gurugram');
    const isRemote = location.includes('remote') || (job.remote_type && job.remote_type !== 'onsite');
    if (!isIndia && !isRemote) {
        hardKnockouts.push({
            gate: 'location_authorization',
            reason: `Foreign on-site location (${job.location}) requires in-country work authorization candidate does not hold.`
        });
    }

    // 2. Identify Skills in Job Description
    const detectedSkills = [];
    for (const skill of CANDIDATE_SKILL_REGISTRY) {
        const isMentioned = skill.aliases.some(alias => {
            if (alias instanceof RegExp) return alias.test(fullText);
            return fullText.includes(String(alias).toLowerCase());
        });

        if (isMentioned) {
            // Check if context indicates preferred vs mandatory
            const isPreferred = fullText.includes(`nice to have: ${skill.canonical.toLowerCase()}`) ||
                                fullText.includes(`plus: ${skill.canonical.toLowerCase()}`) ||
                                fullText.includes(`preferred: ${skill.canonical.toLowerCase()}`) ||
                                fullText.includes(`bonus: ${skill.canonical.toLowerCase()}`);

            detectedSkills.push({
                ...skill,
                requirementTier: isPreferred ? REQUIREMENT_TIERS.PREFERRED_TECHNICAL : REQUIREMENT_TIERS.MANDATORY_TECHNICAL
            });
        }
    }

    const mandatorySkills = detectedSkills.filter(s => s.requirementTier === REQUIREMENT_TIERS.MANDATORY_TECHNICAL);
    const preferredSkills = detectedSkills.filter(s => s.requirementTier === REQUIREMENT_TIERS.PREFERRED_TECHNICAL);

    // 3. Evaluate Verified vs Gaps
    const verifiedMandatory = mandatorySkills.filter(s => s.classification === SKILL_CLASSIFICATIONS.VERIFIED);
    const missingMandatory = mandatorySkills.filter(s => s.classification !== SKILL_CLASSIFICATIONS.VERIFIED);
    const disclaimedSkills = detectedSkills.filter(s => s.classification === SKILL_CLASSIFICATIONS.EXPLICITLY_DISCLAIMED);

    // 4. Evaluate Transferable Skills for Missing Requirements
    const transferableSkills = [];
    for (const missing of missingMandatory) {
        const adjacency = TRANSFERABLE_ADJACENCIES.find(a => a.target.toLowerCase() === missing.canonical.toLowerCase());
        if (adjacency) {
            const supportingVerified = adjacency.transferableSources.filter(src => {
                const s = findSkill(src);
                return s && s.classification === SKILL_CLASSIFICATIONS.VERIFIED;
            });
            if (supportingVerified.length > 0) {
                transferableSkills.push({
                    targetSkill: missing.canonical,
                    transferableFrom: supportingVerified,
                    rationale: adjacency.rationale
                });
            }
        }
    }

    return {
        hardKnockouts,
        mandatorySkills,
        preferredSkills,
        verifiedMandatory,
        missingMandatory,
        transferableSkills,
        disclaimedSkills,
        experienceAnalysis
    };
}

/**
 * Calculates flexible job-fit score and determines application strategy.
 */
export function evaluateFlexibleJobFit(job, options = {}) {
    const analysis = analyzeJobRequirements(job);

    // 1. Hard Eligibility Knockout Check
    if (analysis.hardKnockouts.length > 0) {
        return {
            eligible: false,
            matchScore: 0.0,
            strategy: APPLICATION_STRATEGIES.REJECT_HARD_KNOCKOUT,
            recommendation: 'DO_NOT_APPLY',
            analysis,
            reason: `Hard eligibility condition failed: ${analysis.hardKnockouts[0].reason}`,
            retained: false
        };
    }

    // Explicitly disclaimed technologies deal-breaker check
    if (analysis.disclaimedSkills.length > 0) {
        return {
            eligible: false,
            matchScore: 0.1,
            strategy: APPLICATION_STRATEGIES.DO_NOT_APPLY_LOW_FIT,
            recommendation: 'DO_NOT_APPLY',
            analysis,
            reason: `Role centers on explicitly disclaimed technologies: ${analysis.disclaimedSkills.map(s => s.canonical).join(', ')}`,
            retained: false
        };
    }

    const totalMandatory = analysis.mandatorySkills.length;
    const verifiedCount = analysis.verifiedMandatory.length;
    const transferableCount = analysis.transferableSkills.length;
    const totalPreferred = analysis.preferredSkills.length;
    const verifiedPreferred = analysis.preferredSkills.filter(s => s.classification === SKILL_CLASSIFICATIONS.VERIFIED).length;

    // 2. Score Computation
    let matchScore = 0.50; // Baseline for general software engineering role

    if (totalMandatory > 0) {
        const mandatoryRatio = verifiedCount / totalMandatory;
        // Transferable skills credit up to 50% for missing mandatory items
        const transferableRatio = totalMandatory > 0 ? (transferableCount / totalMandatory) * 0.50 : 0.0;
        const preferredRatio = totalPreferred > 0 ? (verifiedPreferred / totalPreferred) : (analysis.missingMandatory.length === 0 ? 1.0 : 0.0);

        matchScore = (mandatoryRatio * 0.65) + (transferableRatio * 0.20) + (preferredRatio * 0.15);
    } else {
        // If no specific stack mentioned, rely on verified preferred
        if (totalPreferred > 0) {
            matchScore = 0.50 + ((verifiedPreferred / totalPreferred) * 0.30);
        }
    }

    matchScore = Math.max(0.0, Math.min(1.0, Math.round(matchScore * 100) / 100));

    // 3. Strategy Determination with Seniority & Experience Normalization
    let strategy = APPLICATION_STRATEGIES.DO_NOT_APPLY_LOW_FIT;
    let recommendation = 'DO_NOT_APPLY';
    let retained = false;

    const exp = analysis.experienceAnalysis || {};
    const hasExpGap = exp.minYears !== null && exp.minYears >= 1 && !exp.isFresher;
    const isPreferredHighExp = exp.minYears !== null && exp.minYears >= 3 && exp.isPreferred;

    if (isPreferredHighExp) {
        // Preferred 3+ or 5+ years experience: candidate has ~7 months; downgrade from strong fit to low fit
        matchScore = Math.min(matchScore, 0.45);
        strategy = APPLICATION_STRATEGIES.DO_NOT_APPLY_LOW_FIT;
        recommendation = 'DO_NOT_APPLY';
        retained = false;
    } else if (hasExpGap) {
        // 1-2 years experience required vs candidate's ~7 months:
        // Capped so it can NEVER receive APPLY_STRONG_FIT, but preserves opportunistic partial fit!
        matchScore = Math.min(matchScore, 0.68);
        strategy = APPLICATION_STRATEGIES.APPLY_PARTIAL_FIT;
        recommendation = 'CONSIDER';
        retained = true;
    } else if (matchScore >= 0.70 && analysis.missingMandatory.length === 0) {
        strategy = APPLICATION_STRATEGIES.APPLY_STRONG_FIT;
        recommendation = 'APPLY';
        retained = true;
    } else if (matchScore >= 0.50 || (analysis.verifiedMandatory.length > 0 && analysis.transferableSkills.length > 0)) {
        // Worthwhile partial fit: retain opportunity, do not falsely reject!
        strategy = APPLICATION_STRATEGIES.APPLY_PARTIAL_FIT;
        recommendation = 'CONSIDER';
        retained = true;
    } else if (analysis.missingMandatory.length > 0 && analysis.transferableSkills.length === 0) {
        strategy = APPLICATION_STRATEGIES.PROPOSE_PROJECT_IMPROVEMENT;
        recommendation = 'DO_NOT_APPLY';
        retained = false;
    }

    return {
        eligible: true,
        matchScore,
        strategy,
        recommendation,
        retained,
        analysis,
        reason: `Evaluated ${totalMandatory} mandatory requirements (${verifiedCount} verified, ${transferableCount} transferable); score: ${matchScore}`
    };
}
