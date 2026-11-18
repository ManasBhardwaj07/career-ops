/**
 * resume/select-variant.mjs — Resume Variant Selection & Reuse Strategy
 *
 * Implements Part 2 of Milestone 3C:
 * Determines whether an existing resume variant is sufficient or if
 * tailored bullet selection is justified based on job requirements and verified evidence.
 */

import { getLatestResumeVersionForJob, getResumeVersionsByVariant } from '../db/repo.mjs';

export const RESUME_VARIANTS = {
    GENERAL: 'general',
    BACKEND: 'backend',
    FULLSTACK: 'fullstack',
    FRONTEND: 'frontend',
    PLATFORM: 'platform'
};

/**
 * Determines the most relevant resume variant for a given job.
 */
export function determineVariant(job = null, evaluationRun = null) {
    if (!job) return RESUME_VARIANTS.GENERAL;

    const title = (job.title || '').toLowerCase();
    const desc = (job.description || '').toLowerCase();

    // 1. Title-first heuristic
    if (/\b(platform|devops|infrastructure|site reliability|sre)\b/i.test(title)) {
        return RESUME_VARIANTS.PLATFORM;
    }
    if (/\b(full[- ]?stack|fullstack|mern)\b/i.test(title)) {
        return RESUME_VARIANTS.FULLSTACK;
    }
    if (/\b(frontend|react|ui|web client)\b/i.test(title)) {
        return RESUME_VARIANTS.FRONTEND;
    }
    if (/\b(backend|api|database|microservice|distributed)\b/i.test(title)) {
        return RESUME_VARIANTS.BACKEND;
    }

    // 2. Evaluation run evidence check (if available)
    if (evaluationRun?.tier3_breakdown_json) {
        try {
            const breakdown = typeof evaluationRun.tier3_breakdown_json === 'string'
                ? JSON.parse(evaluationRun.tier3_breakdown_json)
                : evaluationRun.tier3_breakdown_json;

            let backendMatches = 0;
            let frontendMatches = 0;

            for (const item of breakdown) {
                if (item.matchStatus === 'MATCHED') {
                    if (['nodejs', 'postgresql', 'redis', 'websockets', 'rest-apis'].includes(item.requirement)) {
                        backendMatches++;
                    }
                    if (['react', 'typescript', 'nextjs', 'javascript'].includes(item.requirement)) {
                        frontendMatches++;
                    }
                }
            }

            if (backendMatches > frontendMatches && backendMatches >= 2) {
                return RESUME_VARIANTS.BACKEND;
            }
            if (frontendMatches > backendMatches && frontendMatches >= 2) {
                return RESUME_VARIANTS.FRONTEND;
            }
        } catch {}
    }

    // 3. Description keyword fallback
    if (/\b(docker|kubernetes|aws|ci\/cd|infrastructure)\b/i.test(desc) && !/\breact\b/i.test(desc)) {
        return RESUME_VARIANTS.PLATFORM;
    }
    if (/\b(react|frontend|css|ui)\b/i.test(desc) && !/\b(backend|database|sql)\b/i.test(desc)) {
        return RESUME_VARIANTS.FRONTEND;
    }
    if (/\b(backend|sql|postgres|redis|api)\b/i.test(desc) && !/\breact\b/i.test(desc)) {
        return RESUME_VARIANTS.BACKEND;
    }

    return RESUME_VARIANTS.GENERAL;
}

/**
 * Checks if an existing resume variant can be reused for the job.
 *
 * Rules:
 * - If a resume was already generated for this exact jobId, reuse it.
 * - If a general/master resume exists and the target role is a balanced Software Engineer, reuse it.
 * - Tailoring is only justified when specific bullet ordering or emphasis is required.
 */
export function checkResumeReuse(jobId = null, variantLabel = RESUME_VARIANTS.GENERAL, options = {}) {
    const { forceRegenerate = false } = options;
    if (forceRegenerate) {
        return { reuse: false, reason: 'Force regeneration requested' };
    }

    // Check 1: Exact job match
    if (jobId) {
        const existingForJob = getLatestResumeVersionForJob(jobId);
        if (existingForJob) {
            return {
                reuse: true,
                existingVersion: existingForJob,
                reason: `Reusing existing tailored resume version ${existingForJob.id} for job ${jobId}`
            };
        }
        return {
            reuse: false,
            reason: `No existing tailored resume for job ${jobId}; generation required`
        };
    }

    // Check 2: Matching master variant exists (when no specific jobId requested)
    const existingVariants = getResumeVersionsByVariant(variantLabel);
    const masterVariant = existingVariants.find(v => !v.job_id);
    if (masterVariant) {
        return {
            reuse: true,
            existingVersion: masterVariant,
            reason: `Reusing existing ${variantLabel} master resume version ${masterVariant.id}`
        };
    }

    return {
        reuse: false,
        reason: 'No matching reusable resume version found; generation required'
    };
}
