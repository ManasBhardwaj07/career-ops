/**
 * application/submission/policy.mjs — Submission Authorization Policy
 *
 * Implements Milestone 3D Part 12:
 *   - Enforces default MANUAL_REVIEW policy
 *   - Validates explicit single-application or bounded-batch authorization
 *   - Checks company source policies and job liveness
 */

import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { getValidSubmissionAuthorization, getSourcePolicy } from '../../db/repo.mjs';

export const SUBMISSION_POLICIES = {
    MANUAL_REVIEW: 'MANUAL_REVIEW',
    NEVER: 'NEVER',
    AUTO_SUBMIT_ENABLED: 'AUTO_SUBMIT_ENABLED'
};

/**
 * Computes a deterministic SHA-256 digest of an application's material answers and resume.
 */
export function computeApplicationPayloadDigest(application) {
    if (!application) return null;
    let meta = {};
    try {
        meta = typeof application.execution_metadata_json === 'string'
            ? JSON.parse(application.execution_metadata_json || '{}')
            : (application.execution_metadata_json || {});
    } catch {
        meta = {};
    }
    const completedFields = (meta.completedFields || []).map(f => ({
        name: f.name || f.id || '',
        value: String(f.value || '')
    })).sort((a, b) => a.name.localeCompare(b.name));

    const content = JSON.stringify({
        resume_version_id: application.resume_version_id || null,
        completedFields
    });
    return createHash('sha256').update(content).digest('hex');
}

/**
 * Checks whether an application can legally proceed to submission.
 */
export function canProceedToSubmit({
    application,
    job,
    company = null,
    sourcePolicy = null,
    validationResult = null,
    explicitAuthorization = null
}) {
    if (!application) {
        return { allowed: false, reason: 'No application provided' };
    }

    // 1. Check Job Liveness
    if (job && job.status !== 'active') {
        return { allowed: false, reason: `Job posting is not active (current status: ${job.status})` };
    }

    // 2. Check Submission Policy
    const policy = application.submission_policy || company?.submission_policy || SUBMISSION_POLICIES.MANUAL_REVIEW;
    if (policy === SUBMISSION_POLICIES.NEVER) {
        return { allowed: false, reason: 'Submission policy is set to NEVER for this employer/application' };
    }

    // 3. Check Source Policy permissions (Independent employer restriction enforcement)
    const companyId = company?.id || application.company_id;
    const sp = sourcePolicy || (companyId ? getSourcePolicy(companyId) : null);
    if (sp && sp.submission_permitted === 0) {
        return { allowed: false, reason: 'Source policy explicitly blocks automated submission (submission_permitted = 0)' };
    }

    // 4. Check Form Validation
    if (validationResult && !validationResult.valid) {
        return { allowed: false, reason: `Application form validation failed: ${validationResult.errors?.join('; ') || 'Form has validation errors'}` };
    }

    // 5. Check Explicit Authorization (Single or Bounded Batch)
    const auth = explicitAuthorization || getValidSubmissionAuthorization(application.id, companyId);
    if (!auth) {
        return {
            allowed: false,
            reason: 'MANUAL_REVIEW required: No explicit, active submission authorization found for this application',
            requiresHumanAuthorization: true
        };
    }

    // 6. Check Scope Matching
    if (auth.scope === 'single' && auth.application_id && auth.application_id !== application.id) {
        return { allowed: false, reason: `Submission authorization ${auth.id} is scoped to application ${auth.application_id}, not ${application.id}` };
    }
    if (auth.scope === 'company' && auth.company_id && companyId && auth.company_id !== companyId) {
        return { allowed: false, reason: `Submission authorization ${auth.id} is scoped to company ${auth.company_id}, not ${companyId}` };
    }

    // 7. Check Expiration
    if (auth.expires_at && new Date(auth.expires_at) < new Date()) {
        return { allowed: false, reason: `Submission authorization ${auth.id} has expired` };
    }

    // 8. Check Status & Usage Limits
    if (auth.status && auth.status !== 'active') {
        return { allowed: false, reason: `Submission authorization ${auth.id} is not active (current status: ${auth.status})` };
    }
    if ((auth.used_count || 0) >= (auth.max_applications || 1)) {
        return { allowed: false, reason: `Submission authorization ${auth.id} has already been consumed (usage: ${auth.used_count || 0}/${auth.max_applications || 1})` };
    }

    // 9. Strict Cryptographic & Data Bindings Validation
    // An application-specific authorization is strictly rejected unless all required bindings exist and match:
    //   - packet_hash: SHA-256 hex digest of approved review packet markdown
    //   - resume_version_id: bound tailored resume version ID
    //   - payload_digest: deterministic SHA-256 digest of mapped answers and material fields
    // Legacy or unbound authorizations missing even one required binding must never authorize submission.

    // 9a. Check Review Packet Hash Binding
    if (!auth.packet_hash) {
        return {
            allowed: false,
            reason: `Submission authorization ${auth.id} is invalid: missing required review packet binding (packet_hash). Legacy or unbound authorizations cannot authorize submission. Fresh review and authorization are required.`
        };
    }
    if (!application.review_packet_path || !existsSync(application.review_packet_path)) {
        return {
            allowed: false,
            reason: `Authorized review packet missing from disk (${application.review_packet_path || 'none'}). Re-review and fresh authorization required.`
        };
    }
    const currentPacketContent = readFileSync(application.review_packet_path, 'utf8');
    const currentPacketHash = createHash('sha256').update(currentPacketContent).digest('hex');
    if (currentPacketHash !== auth.packet_hash) {
        return {
            allowed: false,
            reason: 'Review packet has been modified after authorization was granted. Re-review and fresh authorization required.'
        };
    }

    // 9b. Check Resume Version Binding
    if (!auth.resume_version_id) {
        return {
            allowed: false,
            reason: `Submission authorization ${auth.id} is invalid: missing required resume version binding (resume_version_id). Legacy or unbound authorizations cannot authorize submission. Fresh review and authorization are required.`
        };
    }
    if (!application.resume_version_id || auth.resume_version_id !== application.resume_version_id) {
        return {
            allowed: false,
            reason: `Resume version (${application.resume_version_id || 'none'}) differs from authorized resume version (${auth.resume_version_id}). Re-review and fresh authorization required.`
        };
    }

    // 9c. Check Submission Payload / Answers Digest Binding
    if (!auth.payload_digest) {
        return {
            allowed: false,
            reason: `Submission authorization ${auth.id} is invalid: missing required submission payload digest binding (payload_digest). Legacy or unbound authorizations cannot authorize submission. Fresh review and authorization are required.`
        };
    }
    const currentDigest = computeApplicationPayloadDigest(application);
    if (!currentDigest || currentDigest !== auth.payload_digest) {
        return {
            allowed: false,
            reason: 'Application answers or fields have been modified after authorization was granted. Re-review and fresh authorization required.'
        };
    }

    return {
        allowed: true,
        authorization: auth
    };
}
