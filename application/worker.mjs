/**
 * application/worker.mjs — Application Queue Consumer & Standing Execution Engine
 *
 * Implements:
 *   - Concurrency-safe atomic database-backed leasing (application_leases)
 *   - Execution of queued applications (NOT_STARTED -> DRAFTING -> FORM_FILLING)
 *   - Human checkpoint preservation (NEEDS_USER_INPUT)
 *   - Automated standing authorization evaluation and gated auto-submission
 *   - Quota enforcement, crash recovery, and uncertain outcome protection
 */

import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import {
    getDb,
    runInTransaction,
    getApplication,
    getJob,
    getCompany,
    getSourcePolicy,
    updateApplicationState,
    updateRecruitmentOutcome,
    createSubmissionAuthorization,
    APPLICATION_STATES,
    RECRUITMENT_OUTCOMES
} from '../db/repo.mjs';
import { runApplicationWorkflow, resumeApplicationWorkflow } from './apply.mjs';
import {
    evaluateStandingAuthorization,
    getStandingPolicyConfig,
    STANDING_DECISIONS,
    DEFAULT_STANDING_POLICY
} from './submission/standing-policy.mjs';
import { computeApplicationPayloadDigest } from './submission/policy.mjs';

/**
 * Verifies application_leases table exists in current database.
 * Fail-closed: does not perform runtime DDL; requires migrations.
 */
export function ensureLeasesTable(dbInstance = null) {
    const db = dbInstance || getDb();
    const row = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='application_leases'").get();
    if (!row) {
        throw new Error('FAIL-CLOSED (R11): Missing required table application_leases. Run database migrations (`ALLOW_CANONICAL_MIGRATION=1 node db/migrate.js`) before running application worker.');
    }
}

import {
    OPERATIONAL_APPLICATION_FILTER_SQL,
    isSyntheticApplication,
    HISTORICAL_SYNTHETIC_FIXTURE_IDS,
    SYNTHETIC_ID_PREFIXES
} from './fixtures.mjs';

export {
    OPERATIONAL_APPLICATION_FILTER_SQL,
    isSyntheticApplication,
    HISTORICAL_SYNTHETIC_FIXTURE_IDS,
    SYNTHETIC_ID_PREFIXES
};

/**
 * Computes daily submission quota usage
 */
export function getDailyQuotaUsage({ dateString = null, dbInstance = null } = {}) {
    const db = dbInstance || getDb();
    const targetDate = dateString || new Date().toISOString().slice(0, 10);

    const query = `
        SELECT
            COUNT(CASE WHEN a.state = 'CONFIRMED' THEN 1 END) as confirmed,
            COUNT(CASE WHEN a.state = 'SUBMITTING' THEN 1 END) as submitting,
            COUNT(CASE WHEN a.state = 'SUBMISSION_APPROVED' THEN 1 END) as approved,
            COUNT(CASE WHEN a.state = 'UNCERTAIN_OUTCOME' THEN 1 END) as uncertain,
            COUNT(CASE WHEN a.state = 'READY_FOR_REVIEW' THEN 1 END) as prepared
        FROM applications a
        WHERE date(coalesce(a.submitted_at, a.updated_at, a.created_at)) = date(?)
          AND ${OPERATIONAL_APPLICATION_FILTER_SQL}
    `;
    const row = db.prepare(query).get(targetDate) || {};

    const confirmed = row.confirmed || 0;
    const submitting = row.submitting || 0;
    const approved = row.approved || 0;
    const uncertain = row.uncertain || 0;
    const prepared = row.prepared || 0;

    // Daily counted toward quota = confirmed + in-progress + approved + uncertain
    const current = confirmed + submitting + approved + uncertain;

    return {
        date: targetDate,
        current,
        confirmed,
        in_flight: submitting + approved,
        uncertain,
        prepared
    };
}

/**
 * Claims the next eligible application atomically using database leases
 */
export function claimNextApplication({
    workerId = `worker_${process.pid}_${Math.random().toString(36).slice(2, 6)}`,
    leaseDurationSeconds = 300,
    dbInstance = null
} = {}) {
    const db = dbInstance || getDb();
    ensureLeasesTable(db);

    return runInTransaction((txDb) => {
        // Query NOT_STARTED applications originating from pipeline-handoff (excluding synthetic test fixtures)
        const query = `
            SELECT a.id, a.job_id, a.company_id, a.score, a.created_at
            FROM applications a
            LEFT JOIN application_leases l ON a.id = l.application_id
            WHERE a.state = 'NOT_STARTED'
              AND (
                l.application_id IS NULL
                OR l.status IN ('RELEASED', 'EXPIRED')
                OR l.lease_expires_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
              )
              AND ${OPERATIONAL_APPLICATION_FILTER_SQL}
            ORDER BY a.score DESC, a.created_at ASC
            LIMIT 1
        `;
        const candidate = txDb.prepare(query).get();
        if (!candidate) return null;

        const leaseQuery = `
            INSERT INTO application_leases (
                application_id, worker_id, claimed_at, lease_expires_at, attempt_count, status, last_heartbeat_at
            ) VALUES (
                ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+' || ? || ' seconds'),
                1, 'PROCESSING', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            )
            ON CONFLICT(application_id) DO UPDATE SET
                worker_id = excluded.worker_id,
                claimed_at = excluded.claimed_at,
                lease_expires_at = excluded.lease_expires_at,
                attempt_count = application_leases.attempt_count + 1,
                status = 'PROCESSING',
                last_heartbeat_at = excluded.last_heartbeat_at
            WHERE application_leases.lease_expires_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
               OR application_leases.status IN ('RELEASED', 'EXPIRED')
        `;
        const result = txDb.prepare(leaseQuery).run(candidate.id, workerId, leaseDurationSeconds);

        if (result.changes === 0) {
            // Another worker claimed the row concurrently
            return null;
        }

        const lease = txDb.prepare('SELECT * FROM application_leases WHERE application_id = ?').get(candidate.id);
        const application = txDb.prepare('SELECT * FROM applications WHERE id = ?').get(candidate.id);

        return {
            workerId,
            application,
            lease
        };
    });
}

/**
 * Releases or updates a lease
 */
export function releaseLease(applicationId, { status = 'RELEASED', errorMessage = null, dbInstance = null } = {}) {
    const db = dbInstance || getDb();
    ensureLeasesTable(db);
    db.prepare(`
        UPDATE application_leases
        SET status = ?, error_message = ?, last_heartbeat_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE application_id = ?
    `).run(status, errorMessage, applicationId);
}

/**
 * Renews an active lease
 */
export function renewLease(applicationId, { workerId, additionalSeconds = 300, dbInstance = null } = {}) {
    const db = dbInstance || getDb();
    ensureLeasesTable(db);
    const result = db.prepare(`
        UPDATE application_leases
        SET lease_expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+' || ? || ' seconds'),
            last_heartbeat_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE application_id = ? AND worker_id = ? AND status = 'PROCESSING'
    `).run(additionalSeconds, applicationId, workerId);
    return result.changes > 0;
}

/**
 * Recovers expired leases and safely handles crashed/abandoned work
 */
export function recoverExpiredLeases({ dbInstance = null, maxAttempts = 3 } = {}) {
    const db = dbInstance || getDb();
    ensureLeasesTable(db);

    const expiredRows = db.prepare(`
        SELECT l.*, a.state, a.job_id
        FROM application_leases l
        JOIN applications a ON l.application_id = a.id
        WHERE l.status = 'PROCESSING'
          AND l.lease_expires_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    `).all();

    const recovered = [];

    for (const row of expiredRows) {
        // Inspect current application state to determine safe recovery action
        if (row.state === APPLICATION_STATES.CONFIRMED) {
            // Submission actually succeeded before crash
            db.prepare("UPDATE application_leases SET status = 'COMPLETED' WHERE application_id = ?").run(row.application_id);
            recovered.push({ applicationId: row.application_id, action: 'MARK_COMPLETED', state: row.state });
        } else if (row.state === APPLICATION_STATES.UNCERTAIN_OUTCOME) {
            // Never blindly retry uncertain submissions
            db.prepare("UPDATE application_leases SET status = 'UNCERTAIN' WHERE application_id = ?").run(row.application_id);
            recovered.push({ applicationId: row.application_id, action: 'HOLD_UNCERTAIN', state: row.state });
        } else if (row.state === APPLICATION_STATES.SUBMITTING) {
            // CRITICAL SAFETY (R11/R13): Process entered SUBMITTING before lease expiry.
            // External submission may have been triggered. Never blindly retry. Transition to UNCERTAIN_OUTCOME.
            updateApplicationState(row.application_id, APPLICATION_STATES.UNCERTAIN_OUTCOME, {
                actor: 'worker_recovery',
                eventType: 'lease_expired_submitting',
                message: 'Lease expired while in SUBMITTING state. External submission may have occurred; transitioned to UNCERTAIN_OUTCOME for manual reconciliation.',
                payload: { previousState: APPLICATION_STATES.SUBMITTING, workerId: row.worker_id, attemptCount: row.attempt_count }
            });
            db.prepare("UPDATE application_leases SET status = 'UNCERTAIN', error_message = 'Lease expired in SUBMITTING state; held for outcome reconciliation' WHERE application_id = ?").run(row.application_id);
            recovered.push({ applicationId: row.application_id, action: 'HELD_UNCERTAIN_FROM_SUBMITTING', state: APPLICATION_STATES.UNCERTAIN_OUTCOME });
        } else if (row.state === APPLICATION_STATES.SUBMISSION_APPROVED) {
            // Worker crashed after approval but before submitting was initiated.
            // Submit button was never clicked. Safely revert to READY_FOR_REVIEW for human re-review.
            updateApplicationState(row.application_id, APPLICATION_STATES.READY_FOR_REVIEW, {
                actor: 'worker_recovery',
                eventType: 'lease_expired_approved_reset',
                message: 'Lease expired in SUBMISSION_APPROVED before submission action started. Safely reverted to READY_FOR_REVIEW.'
            });
            db.prepare("UPDATE application_leases SET status = 'RELEASED' WHERE application_id = ?").run(row.application_id);
            recovered.push({ applicationId: row.application_id, action: 'REVERT_READY_FOR_REVIEW', state: APPLICATION_STATES.READY_FOR_REVIEW });
        } else if (row.state === APPLICATION_STATES.NEEDS_USER_INPUT || row.state === APPLICATION_STATES.AUTHENTICATION_REQUIRED) {
            // Human checkpoint reached
            db.prepare("UPDATE application_leases SET status = 'RELEASED' WHERE application_id = ?").run(row.application_id);
            recovered.push({ applicationId: row.application_id, action: 'HOLD_CHECKPOINT', state: row.state });
        } else if (row.state === APPLICATION_STATES.READY_FOR_REVIEW) {
            // Prepared but unsubmitted
            db.prepare("UPDATE application_leases SET status = 'RELEASED' WHERE application_id = ?").run(row.application_id);
            recovered.push({ applicationId: row.application_id, action: 'HOLD_READY_FOR_REVIEW', state: row.state });
        } else {
            // Ordinary pre-submission states (NOT_STARTED, DRAFTING, PORTAL_OPENED, FORM_FILLING)
            if (row.attempt_count < maxAttempts) {
                // Reset state to NOT_STARTED for safe retry
                updateApplicationState(row.application_id, APPLICATION_STATES.NOT_STARTED, {
                    actor: 'worker_recovery',
                    eventType: 'lease_expired_reset',
                    message: `Lease expired on attempt ${row.attempt_count}; resetting to NOT_STARTED for retry`
                });
                db.prepare("UPDATE application_leases SET status = 'RELEASED' WHERE application_id = ?").run(row.application_id);
                recovered.push({ applicationId: row.application_id, action: 'RESET_NOT_STARTED', state: 'NOT_STARTED' });
            } else {
                // Exhausted max attempts
                db.prepare("UPDATE application_leases SET status = 'FAILED', error_message = 'Exhausted maximum retry attempts' WHERE application_id = ?").run(row.application_id);
                recovered.push({ applicationId: row.application_id, action: 'EXHAUSTED_RETRIES', state: row.state });
            }
        }
    }

    return {
        totalInspected: expiredRows.length,
        recovered
    };
}

/**
 * Processes a single claimed application through preparation, standing policy evaluation, and gated submission
 */
export async function processQueuedApplication(applicationId, {
    workerId = `worker_${process.pid}`,
    standingPolicyOverrides = {},
    options = {},
    dryRun = false,
    logger = (msg) => console.log(msg)
} = {}) {
    const app = getApplication(applicationId);
    if (!app) {
        throw new Error(`Application not found: ${applicationId}`);
    }

    const job = getJob(app.job_id);
    if (!job || job.status !== 'active') {
        logger(`Job ${app.job_id} is no longer active (status: ${job?.status || 'missing'}). Marking recruitment outcome DISCARDED.`);
        updateRecruitmentOutcome(applicationId, RECRUITMENT_OUTCOMES.DISCARDED, {
            actor: 'worker',
            message: `Associated job is no longer active (status: ${job?.status || 'missing'})`
        });
        releaseLease(applicationId, { status: 'TERMINATED', errorMessage: 'Job no longer active' });
        return {
            applicationId,
            status: app.state,
            outcome: RECRUITMENT_OUTCOMES.DISCARDED,
            reason: 'Job no longer active'
        };
    }

    const company = job.company_id ? getCompany(job.company_id) : null;
    const sourcePolicy = company?.id ? getSourcePolicy(company.id) : null;

    logger(`\n[Worker:${workerId}] Processing application ${applicationId} for job ${job.id} (${job.title})`);

    // ── 1. Run Application Preparation Workflow ─────────────────────────────
    let workflowResult = null;
    try {
        workflowResult = await runApplicationWorkflow(job.id, {
            ...options,
            dryRun,
            headless: options.headless !== false,
            logger
        });
    } catch (workflowErr) {
        logger(`[Worker:${workerId}] Preparation workflow failed: ${workflowErr.message}`);
        releaseLease(applicationId, { status: 'FAILED', errorMessage: workflowErr.message });
        throw workflowErr;
    }

    const updatedApp = getApplication(applicationId);

    // ── 2. Handle Human Attention Checkpoint ─────────────────────────────────
    if (updatedApp.state === APPLICATION_STATES.NEEDS_USER_INPUT || updatedApp.state === APPLICATION_STATES.AUTHENTICATION_REQUIRED) {
        logger(`[Worker:${workerId}] Application halted at human checkpoint: ${updatedApp.state}`);
        releaseLease(applicationId, { status: 'RELEASED' });
        return {
            applicationId,
            status: updatedApp.state,
            decision: STANDING_DECISIONS.PREPARE_AND_PAUSE,
            message: `Application halted for human intervention (${updatedApp.state})`,
            workflowResult
        };
    }

    if (updatedApp.state !== APPLICATION_STATES.READY_FOR_REVIEW) {
        logger(`[Worker:${workerId}] Application reached non-submittable state: ${updatedApp.state}`);
        releaseLease(applicationId, { status: 'RELEASED' });
        return {
            applicationId,
            status: updatedApp.state,
            workflowResult
        };
    }

    // ── 3. Evaluate Standing Authorization Policy ───────────────────────────
    const policyConfig = getStandingPolicyConfig();
    const activePolicy = { ...policyConfig, ...standingPolicyOverrides };

    const dailyUsage = getDailyQuotaUsage();
    const standingEvaluation = evaluateStandingAuthorization({
        application: updatedApp,
        job,
        company,
        sourcePolicy,
        dailyQuotaUsage: { current: dailyUsage.current, max: activePolicy.max_daily_submissions },
        policyOverrides: activePolicy,
        dryRun
    });

    logger(`[Worker:${workerId}] Standing Policy Decision: ${standingEvaluation.decision} — ${standingEvaluation.reason}`);

    // If standing policy does NOT approve auto-submit, pause safely at READY_FOR_REVIEW
    if (standingEvaluation.decision !== STANDING_DECISIONS.AUTO_SUBMIT) {
        releaseLease(applicationId, { status: 'PAUSED_FOR_REVIEW' });
        return {
            applicationId,
            status: APPLICATION_STATES.READY_FOR_REVIEW,
            decision: standingEvaluation.decision,
            reason: standingEvaluation.reason,
            checks: standingEvaluation.checks,
            workflowResult
        };
    }

    // ── 4. Issue Cryptographic Standing Authorization Token ──────────────────
    if (!updatedApp.review_packet_path || !existsSync(updatedApp.review_packet_path)) {
        throw new Error('Authorized review packet missing from disk prior to submission');
    }
    const packetContent = readFileSync(updatedApp.review_packet_path, 'utf8');
    const packetHash = createHash('sha256').update(packetContent).digest('hex');
    const payloadDigest = computeApplicationPayloadDigest(updatedApp);

    const authId = createSubmissionAuthorization({
        scope: 'single',
        application_id: applicationId,
        max_applications: 1,
        authorized_by: 'standing_policy',
        packet_hash: packetHash,
        resume_version_id: updatedApp.resume_version_id,
        payload_digest: payloadDigest
    });

    logger(`[Worker:${workerId}] Standing authorization token issued: ${authId}`);

    // ── 5. Execute Submission via Approved Submission Path ───────────────────
    logger(`[Worker:${workerId}] Submitting application ${applicationId}...`);
    let submissionResult = null;
    try {
        submissionResult = await resumeApplicationWorkflow(applicationId, {
            ...options,
            submit: true,
            dryRun,
            headless: options.headless !== false,
            logger
        });
    } catch (submitErr) {
        logger(`[Worker:${workerId}] Submission execution error: ${submitErr.message}`);
        const appAfterSubmit = getApplication(applicationId);
        if (appAfterSubmit?.state === APPLICATION_STATES.UNCERTAIN_OUTCOME) {
            releaseLease(applicationId, { status: 'UNCERTAIN', errorMessage: submitErr.message });
        } else {
            releaseLease(applicationId, { status: 'FAILED', errorMessage: submitErr.message });
        }
        throw submitErr;
    }

    const finalApp = getApplication(applicationId);
    if (finalApp.state === APPLICATION_STATES.CONFIRMED) {
        releaseLease(applicationId, { status: 'COMPLETED' });
        logger(`[Worker:${workerId}] 🎉 Application ${applicationId} successfully CONFIRMED! Receipt: ${finalApp.confirmation_reference || 'N/A'}`);
    } else if (finalApp.state === APPLICATION_STATES.UNCERTAIN_OUTCOME) {
        releaseLease(applicationId, { status: 'UNCERTAIN' });
        logger(`[Worker:${workerId}] ⚠️ Application ${applicationId} transitioned to UNCERTAIN_OUTCOME.`);
    } else {
        releaseLease(applicationId, { status: 'RELEASED' });
    }

    return {
        applicationId,
        status: finalApp.state,
        outcome: finalApp.recruitment_outcome,
        confirmationReference: finalApp.confirmation_reference,
        submissionResult
    };
}

/**
 * Runs one worker cycle: claims 1 eligible application and processes it.
 * Provides per-application exception isolation to prevent crashing batch runners.
 */
export async function runWorkerCycle({
    workerId = `worker_${process.pid}_${Math.random().toString(36).slice(2, 6)}`,
    standingPolicyOverrides = {},
    options = {},
    dryRun = false,
    logger = (msg) => console.log(msg)
} = {}) {
    const claim = claimNextApplication({ workerId });
    if (!claim) {
        logger(`[Worker:${workerId}] No eligible NOT_STARTED applications available in queue.`);
        return {
            claimed: false,
            processed: 0
        };
    }

    logger(`[Worker:${workerId}] Claimed application ${claim.application.id} (Score: ${claim.application.score})`);

    const cycleOptions = typeof options === 'function'
        ? options(claim.application.id, claim)
        : (options.perJob?.[claim.application.id] ? { ...options, ...options.perJob[claim.application.id] } : options);

    let result = null;
    let cycleError = null;

    try {
        result = await processQueuedApplication(claim.application.id, {
            workerId,
            standingPolicyOverrides,
            options: cycleOptions,
            dryRun,
            logger
        });
    } catch (err) {
        cycleError = err;
        logger(`[Worker:${workerId}] Error processing application ${claim.application.id}: ${err.message}`);

        const currentApp = getApplication(claim.application.id);
        const currentState = currentApp ? currentApp.state : null;

        // Ensure safe lease handling
        if (currentState === APPLICATION_STATES.SUBMITTING || currentState === APPLICATION_STATES.UNCERTAIN_OUTCOME) {
            releaseLease(claim.application.id, {
                status: 'UNCERTAIN',
                errorMessage: `Cycle failed in uncertain state: ${err.message}`
            });
        } else if (currentState === APPLICATION_STATES.CONFIRMED) {
            releaseLease(claim.application.id, { status: 'COMPLETED' });
        } else if (
            currentState === APPLICATION_STATES.NEEDS_USER_INPUT ||
            currentState === APPLICATION_STATES.READY_FOR_REVIEW ||
            currentState === APPLICATION_STATES.AUTHENTICATION_REQUIRED
        ) {
            releaseLease(claim.application.id, {
                status: 'RELEASED',
                errorMessage: `Paused at checkpoint: ${err.message}`
            });
        } else {
            // General failure in pre-submission (e.g. navigation timeout, malformed DOM)
            releaseLease(claim.application.id, {
                status: 'FAILED',
                errorMessage: `Cycle execution error: ${err.message}`
            });
        }
    }

    const finalApp = getApplication(claim.application.id);

    return {
        claimed: true,
        processed: 1,
        applicationId: claim.application.id,
        success: !cycleError,
        error: cycleError ? cycleError.message : null,
        status: finalApp ? finalApp.state : null,
        outcome: finalApp ? finalApp.recruitment_outcome : null,
        result
    };
}

/**
 * Runs a bounded batch of applications with fault isolation
 */
export async function runWorkerBatch({
    workerId = `worker_${process.pid}_${Math.random().toString(36).slice(2, 6)}`,
    batchSize = 5,
    standingPolicyOverrides = {},
    options = {},
    dryRun = false,
    logger = (msg) => console.log(msg)
} = {}) {
    logger(`[Worker:${workerId}] Starting worker batch (limit: ${batchSize})...`);
    const results = [];

    for (let i = 0; i < batchSize; i++) {
        try {
            const cycle = await runWorkerCycle({
                workerId,
                standingPolicyOverrides,
                options,
                dryRun,
                logger
            });
            if (!cycle.claimed) break;
            results.push(cycle);
        } catch (fatalErr) {
            logger(`[Worker:${workerId}] Fatal error in cycle loop: ${fatalErr.message}`);
            results.push({
                claimed: false,
                processed: 0,
                fatalError: fatalErr.message
            });
            break;
        }
    }

    const succeeded = results.filter(r => r.success && r.status === APPLICATION_STATES.CONFIRMED).length;
    const prepared = results.filter(r => r.status === APPLICATION_STATES.READY_FOR_REVIEW).length;
    const paused = results.filter(r => r.status === APPLICATION_STATES.NEEDS_USER_INPUT || r.status === APPLICATION_STATES.AUTHENTICATION_REQUIRED).length;
    const uncertain = results.filter(r => r.status === APPLICATION_STATES.UNCERTAIN_OUTCOME).length;
    const failed = results.filter(r => (!r.success && r.status !== APPLICATION_STATES.UNCERTAIN_OUTCOME && r.status !== APPLICATION_STATES.NEEDS_USER_INPUT && r.status !== APPLICATION_STATES.READY_FOR_REVIEW) || r.fatalError).length;

    logger(`[Worker:${workerId}] Batch finished: processed ${results.length} application(s). Confirmed: ${succeeded}, Prepared: ${prepared}, Paused: ${paused}, Uncertain: ${uncertain}, Failed: ${failed}`);
    return {
        workerId,
        totalProcessed: results.length,
        succeeded,
        prepared,
        paused,
        uncertain,
        failed,
        results
    };
}

/**
 * Inspects queue status
 */
export function inspectQueue({ dbInstance = null } = {}) {
    const db = dbInstance || getDb();
    const hasLeases = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='application_leases'").get());

    const query = hasLeases
        ? `
            SELECT a.id, a.job_id, a.company_id, a.state, a.score, a.created_at, l.status as lease_status, l.worker_id, l.lease_expires_at
            FROM applications a
            LEFT JOIN application_leases l ON a.id = l.application_id
            WHERE a.state IN ('NOT_STARTED', 'NEEDS_USER_INPUT', 'READY_FOR_REVIEW')
              AND ${OPERATIONAL_APPLICATION_FILTER_SQL}
            ORDER BY a.score DESC, a.created_at ASC
        `
        : `
            SELECT a.id, a.job_id, a.company_id, a.state, a.score, a.created_at, NULL as lease_status, NULL as worker_id, NULL as lease_expires_at
            FROM applications a
            WHERE a.state IN ('NOT_STARTED', 'NEEDS_USER_INPUT', 'READY_FOR_REVIEW')
              AND ${OPERATIONAL_APPLICATION_FILTER_SQL}
            ORDER BY a.score DESC, a.created_at ASC
        `;

    const queued = db.prepare(query).all();

    const activeLeases = hasLeases
        ? db.prepare(`
            SELECT * FROM application_leases
            WHERE status = 'PROCESSING' AND lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          `).all()
        : [];

    const quota = getDailyQuotaUsage({ dbInstance: db });

    return {
        queuedTotal: queued.length,
        activeLeasesCount: activeLeases.length,
        dailyQuota: quota,
        queued,
        activeLeases
    };
}

export { resumeApplicationFromCheckpoint } from './apply.mjs';
