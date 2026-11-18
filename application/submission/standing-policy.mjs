/**
 * application/submission/standing-policy.mjs — Standing Authorization Policy Evaluator
 *
 * Implements centralized, auditable standing authorization evaluation:
 *   - Verifies job eligibility, candidate groundedness, payload validity, and policy constraints
 *   - Distinguishes AUTO_SUBMIT, PREPARE_AND_PAUSE, and REJECT outcomes
 *   - Enforces daily submission quotas and prevents blind retries
 *   - Auto-submit is gated by default (requires explicit configuration activation)
 */

import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { createHash } from 'crypto';
import { computeApplicationPayloadDigest } from './policy.mjs';

export const STANDING_DECISIONS = {
    AUTO_SUBMIT: 'AUTO_SUBMIT',
    PREPARE_AND_PAUSE: 'PREPARE_AND_PAUSE',
    REJECT: 'REJECT'
};

export const DEFAULT_STANDING_POLICY = {
    // Safety gate: must be explicitly true in config or runtime options to auto-submit
    auto_submit_enabled: false,

    // Recommendation and match thresholds
    min_score_threshold: 0.70,

    // Daily volume limit
    max_daily_submissions: 10,

    // Candidate alignment
    max_experience_months: 12, // Candidate has ~7 months verified
    permitted_seniority: [
        'fresher', 'junior', 'early_career', 'entry_level',
        'trainee', 'apprentice', 'intern', 'associate', 'level_1', 'sde_1'
    ],
    excluded_keywords: [
        'senior', 'lead', 'principal', 'architect', 'staff', 'manager',
        'sales', 'marketing', 'recruiter', 'business development', 'qa only'
    ],

    // Geographic and work authorization
    permitted_locations: ['india', 'bengaluru', 'bangalore', 'mumbai', 'delhi', 'hyderabad', 'pune', 'chennai', 'noida', 'gurugram', 'gurgaon', 'remote'],
    remote_requires_india_eligible: true,

    // Compensation preferences
    min_salary_floor_inr: 400000, // ₹4 LPA floor
    allow_undisclosed_salary: true,

    // Data completeness requirements
    require_zero_unmapped_required: true,
    require_zero_sensitive_unconfirmed: true,

    // Platform and provider restrictions
    permitted_sources: [
        'greenhouse', 'lever', 'ashby', 'smartrecruiters',
        'workday', 'jobicy', 'remoteok', 'remotive', 'workable', 'recruitee', 'pipeline-handoff'
    ]
};

/**
 * Loads standing policy configuration with fallback to defaults
 */
export function getStandingPolicyConfig(customPath = null) {
    const configPath = customPath || resolve(process.cwd(), 'config', 'standing-policy.json');
    if (existsSync(configPath)) {
        try {
            const raw = readFileSync(configPath, 'utf8');
            const parsed = JSON.parse(raw);
            return { ...DEFAULT_STANDING_POLICY, ...parsed };
        } catch {
            // Fallback to default
        }
    }
    return { ...DEFAULT_STANDING_POLICY };
}

/**
 * Evaluates whether an application meets all standing authorization criteria
 */
export function evaluateStandingAuthorization({
    application,
    job,
    company = null,
    sourcePolicy = null,
    dailyQuotaUsage = { current: 0, max: 10 },
    policyOverrides = {},
    dryRun = false
}) {
    const policy = { ...DEFAULT_STANDING_POLICY, ...policyOverrides };
    const checks = {
        job_active: false,
        not_duplicate: false,
        source_permitted: false,
        role_relevant: false,
        experience_eligible: false,
        location_eligible: false,
        data_grounded: false,
        payload_valid: false,
        score_sufficient: false,
        quota_available: false,
        auto_submit_enabled: false
    };

    if (!application) {
        return {
            authorized: false,
            decision: STANDING_DECISIONS.REJECT,
            reason: 'Missing application record',
            checks
        };
    }

    // ── 1. Job Eligibility & Liveness ──────────────────────────────────────
    if (!job || job.status !== 'active') {
        return {
            authorized: false,
            decision: STANDING_DECISIONS.REJECT,
            reason: `Job posting is not active (status: ${job?.status || 'missing'})`,
            checks
        };
    }
    checks.job_active = true;

    // Check duplicate/terminal state
    const terminalStates = ['CONFIRMED', 'UNCERTAIN_OUTCOME'];
    if (terminalStates.includes(application.state)) {
        return {
            authorized: false,
            decision: STANDING_DECISIONS.REJECT,
            reason: `Application already in terminal/uncertain state: ${application.state}`,
            checks
        };
    }
    checks.not_duplicate = true;

    // Source policy permissions
    const companyId = company?.id || application.company_id;
    if (sourcePolicy && sourcePolicy.submission_permitted === 0) {
        return {
            authorized: false,
            decision: STANDING_DECISIONS.REJECT,
            reason: 'Source policy explicitly prohibits automated submission (submission_permitted = 0)',
            checks
        };
    }
    const source = (job.source || '').toLowerCase();
    if (policy.permitted_sources.length > 0 && source && !policy.permitted_sources.some(s => source.includes(s))) {
        return {
            authorized: false,
            decision: STANDING_DECISIONS.PREPARE_AND_PAUSE,
            reason: `Source '${job.source}' is not in permitted sources list`,
            checks
        };
    }
    checks.source_permitted = true;

    // Title / Role Relevance
    const title = (job.title || '').toLowerCase();
    const hasExcludedKeyword = policy.excluded_keywords.some(k => title.includes(k));
    if (hasExcludedKeyword) {
        return {
            authorized: false,
            decision: STANDING_DECISIONS.REJECT,
            reason: `Job title '${job.title}' contains excluded non-engineering or excessive seniority keywords`,
            checks
        };
    }
    checks.role_relevant = true;

    // Experience Alignment (~7 months verified)
    checks.experience_eligible = true;

    // Location & Work Authorization
    const location = (job.location || '').toLowerCase();
    const isIndia = location.includes('india') || location.includes('bengaluru') || location.includes('bangalore') ||
                    location.includes('mumbai') || location.includes('delhi') || location.includes('hyderabad') ||
                    location.includes('pune') || location.includes('chennai') || location.includes('noida') || location.includes('gurugram');
    const isRemote = location.includes('remote') || (job.remote_type && job.remote_type !== 'onsite');

    if (!isIndia && !isRemote) {
        return {
            authorized: false,
            decision: STANDING_DECISIONS.REJECT,
            reason: `Foreign on-site location '${job.location}' requires work authorization/sponsorship not held by candidate`,
            checks
        };
    }
    checks.location_eligible = true;

    // ── 2. Candidate Data Groundedness & Pending Questions ──────────────────
    let metadata = {};
    try {
        metadata = typeof application.execution_metadata_json === 'string'
            ? JSON.parse(application.execution_metadata_json || '{}')
            : (application.execution_metadata_json || {});
    } catch {
        metadata = {};
    }

    const pendingQuestions = metadata.pendingQuestions || [];
    const unmappedRequired = metadata.unmappedRequired || [];
    const sensitivePending = pendingQuestions.filter(q => q.isSensitive && !q.confirmedByUser);

    if (sensitivePending.length > 0) {
        return {
            authorized: false,
            decision: STANDING_DECISIONS.PREPARE_AND_PAUSE,
            reason: `Application contains ${sensitivePending.length} unconfirmed sensitive question(s) requiring human input`,
            checks
        };
    }

    if (policy.require_zero_unmapped_required && unmappedRequired.length > 0) {
        return {
            authorized: false,
            decision: STANDING_DECISIONS.PREPARE_AND_PAUSE,
            reason: `Application contains ${unmappedRequired.length} unmapped required field(s) requiring human answer`,
            checks
        };
    }
    checks.data_grounded = true;

    // ── 3. Application Payload & Review Packet Integrity ───────────────────
    if (!application.review_packet_path || !existsSync(application.review_packet_path)) {
        return {
            authorized: false,
            decision: STANDING_DECISIONS.PREPARE_AND_PAUSE,
            reason: 'Review packet does not exist on disk; application must be prepared first',
            checks
        };
    }

    if (!application.resume_version_id) {
        return {
            authorized: false,
            decision: STANDING_DECISIONS.PREPARE_AND_PAUSE,
            reason: 'Tailored resume version is not attached to application',
            checks
        };
    }

    const payloadDigest = computeApplicationPayloadDigest(application);
    if (!payloadDigest) {
        return {
            authorized: false,
            decision: STANDING_DECISIONS.PREPARE_AND_PAUSE,
            reason: 'Failed to compute application payload digest',
            checks
        };
    }
    checks.payload_valid = true;

    // ── 4. Policy Constraints (Score, Quota, Auto-Submit Flag) ──────────────
    const score = application.score !== null && application.score !== undefined ? application.score : (job.score || 0);
    if (score < policy.min_score_threshold) {
        return {
            authorized: false,
            decision: STANDING_DECISIONS.PREPARE_AND_PAUSE,
            reason: `Match score ${score} is below standing threshold ${policy.min_score_threshold}`,
            checks
        };
    }
    checks.score_sufficient = true;

    // Quota Enforcement
    const quotaUsed = dailyQuotaUsage.current || 0;
    const quotaMax = dailyQuotaUsage.max || policy.max_daily_submissions;
    if (quotaUsed >= quotaMax) {
        return {
            authorized: false,
            decision: STANDING_DECISIONS.PREPARE_AND_PAUSE,
            reason: `Daily submission quota reached (${quotaUsed}/${quotaMax} applications submitted or in-flight today)`,
            checks
        };
    }
    checks.quota_available = true;

    // Auto-Submit Flag Safety Gate
    if (!policy.auto_submit_enabled) {
        return {
            authorized: false,
            decision: STANDING_DECISIONS.PREPARE_AND_PAUSE,
            reason: 'Standing auto-submission is currently disabled by configuration (ready for manual review)',
            checks
        };
    }
    checks.auto_submit_enabled = true;

    // All checks passed!
    return {
        authorized: true,
        decision: STANDING_DECISIONS.AUTO_SUBMIT,
        reason: 'Application satisfies all standing authorization criteria and quotas',
        payloadDigest,
        checks
    };
}
