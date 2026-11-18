/**
 * application/submission/submit.mjs — Controlled Application Submitter
 *
 * Implements Milestone 3D Part 13:
 *   - Verifies all pre-submission gates, state transitions, and authorization
 *   - Updates application state to SUBMISSION_APPROVED and then SUBMITTING
 *   - Triggers submission and confirms outcome
 */

import { canProceedToSubmit } from './policy.mjs';
import { confirmSubmission } from './confirm-submission.mjs';
import {
    updateApplicationState,
    updateApplicationExecution,
    updateRecruitmentOutcome,
    useSubmissionAuthorization,
    runInTransaction,
    APPLICATION_STATES,
    RECRUITMENT_OUTCOMES
} from '../../db/repo.mjs';
import { exportApplicationsMarkdown } from '../../tracking/export-tracker.mjs';

/**
 * Executes controlled submission of an application.
 */
export async function submitApplication(page, {
    application,
    job,
    company = null,
    adapter,
    validationResult = null,
    authorization = null,
    dryRun = false,
    logger = null
} = {}) {
    if (!page) throw new Error('Page required for submitApplication');
    if (!application) throw new Error('Application required for submitApplication');

    // 1. Policy & Authorization Verification
    const policyCheck = canProceedToSubmit({
        application,
        job,
        company,
        validationResult,
        explicitAuthorization: authorization
    });

    if (!policyCheck.allowed) {
        throw new Error(`Cannot submit application: ${policyCheck.reason}`);
    }

    const activeAuth = policyCheck.authorization;

    if (dryRun) {
        if (logger) logger(`[Dry Run] Submission authorized via ${activeAuth.id}, but skipping actual submit action.`);
        return {
            status: 'DRY_RUN_AUTHORIZED',
            authorizationId: activeAuth.id,
            applicationId: application.id
        };
    }

    // 2. State Transition: READY_FOR_REVIEW -> SUBMISSION_APPROVED
    updateApplicationState(application.id, APPLICATION_STATES.SUBMISSION_APPROVED, {
        actor: activeAuth.authorized_by || 'user',
        eventType: 'submission_approved',
        message: `Submission approved under authorization ${activeAuth.id}`,
        payload: { authorizationId: activeAuth.id }
    });

    // 3. Locate & Verify Submit Button (before entering SUBMITTING)
    const submitBtn = await adapter.findSubmitButton(page);
    if (!submitBtn) {
        updateApplicationState(application.id, APPLICATION_STATES.UNCERTAIN_OUTCOME, {
            actor: 'system',
            eventType: 'submit_button_missing',
            message: 'Failed to locate submit button in DOM after approval'
        });
        throw new Error('Submit button could not be located on page');
    }

    if (submitBtn.disabled) {
        updateApplicationState(application.id, APPLICATION_STATES.READY_FOR_REVIEW, {
            actor: 'system',
            eventType: 'submit_button_disabled',
            message: 'Submit button is disabled in DOM; form may be incomplete'
        });
        throw new Error('Submit button is disabled on page');
    }

    // 4. State Transition: SUBMISSION_APPROVED -> SUBMITTING (before clicking Submit!)
    updateApplicationState(application.id, APPLICATION_STATES.SUBMITTING, {
        actor: 'system',
        eventType: 'submitting_started',
        message: 'Final submission action initiated'
    });

    updateApplicationExecution(application.id, {
        submission_authorization_id: activeAuth.id,
        submission_authorized_at: new Date().toISOString(),
        submission_authorized_by: activeAuth.authorized_by || 'user'
    });

    // 5. Pre-submission Authorization Consumption (Crash & Disconnection Safety)
    // The authorization is consumed BEFORE triggering the external side-effect
    // so that an interrupted or ambiguous attempt cannot be replayed without manual reconciliation.
    useSubmissionAuthorization(activeAuth.id);

    try {
        if (logger) logger(`[Submitting] Clicking submit button: ${submitBtn.selector}`);
        await page.click(submitBtn.selector);

        // 6. Confirm Outcome
        const outcome = await confirmSubmission(page, adapter, {
            logger,
            applicationId: application.id
        });

        if (outcome.status === 'CONFIRMED') {
            // Atomic transaction: Execution State + Recruitment Outcome + Submission Receipt
            runInTransaction(() => {
                updateApplicationState(application.id, APPLICATION_STATES.CONFIRMED, {
                    actor: 'system',
                    eventType: 'submission_confirmed',
                    message: 'Submission successfully confirmed by portal receipt',
                    payload: outcome
                });

                updateRecruitmentOutcome(application.id, RECRUITMENT_OUTCOMES.APPLIED, {
                    actor: 'system',
                    reason: 'Confirmed portal submission receipt'
                });

                let existingMeta = {};
                try {
                    existingMeta = application.execution_metadata_json
                        ? (typeof application.execution_metadata_json === 'string' ? JSON.parse(application.execution_metadata_json) : application.execution_metadata_json)
                        : {};
                } catch {}
                if (outcome.receiptScreenshotPath) {
                    existingMeta.receipt_screenshot_path = outcome.receiptScreenshotPath;
                }

                updateApplicationExecution(application.id, {
                    submitted_at: new Date().toISOString(),
                    confirmation_reference: outcome.confirmationReference,
                    portal_url: outcome.finalUrl,
                    execution_metadata_json: existingMeta
                });
            });

            // Post-commit: Regenerate canonical markdown projection idempotently
            try {
                exportApplicationsMarkdown();
            } catch (exportErr) {
                if (logger) logger(`[Tracker Export Warning] Failed to regenerate applications.md: ${exportErr.message}`);
                updateApplicationExecution(application.id, {
                    notes: `${application.notes || ''} [Warning: Tracker export failed: ${exportErr.message}]`.trim()
                });
            }

            return {
                status: APPLICATION_STATES.CONFIRMED,
                confirmationReference: outcome.confirmationReference,
                finalUrl: outcome.finalUrl,
                receiptScreenshotPath: outcome.receiptScreenshotPath || null
            };
        } else {
            let existingMeta = {};
            try {
                existingMeta = application.execution_metadata_json
                    ? (typeof application.execution_metadata_json === 'string' ? JSON.parse(application.execution_metadata_json) : application.execution_metadata_json)
                    : {};
            } catch {}
            if (outcome.receiptScreenshotPath) {
                existingMeta.receipt_screenshot_path = outcome.receiptScreenshotPath;
            }

            // Transition: SUBMITTING -> UNCERTAIN_OUTCOME
            updateApplicationState(application.id, APPLICATION_STATES.UNCERTAIN_OUTCOME, {
                actor: 'system',
                eventType: 'submission_uncertain',
                message: outcome.reason || 'Uncertain submission outcome',
                payload: outcome
            });

            updateApplicationExecution(application.id, {
                error_details: outcome.reason,
                portal_url: outcome.finalUrl,
                execution_metadata_json: existingMeta
            });

            return {
                status: APPLICATION_STATES.UNCERTAIN_OUTCOME,
                reason: outcome.reason,
                finalUrl: outcome.finalUrl,
                receiptScreenshotPath: outcome.receiptScreenshotPath || null
            };
        }
    } catch (err) {
        // Crash / disconnection recovery: guarantee transition to UNCERTAIN_OUTCOME
        updateApplicationState(application.id, APPLICATION_STATES.UNCERTAIN_OUTCOME, {
            actor: 'system',
            eventType: 'submission_crash',
            message: `Crash during submission action: ${err.message}`
        });

        updateApplicationExecution(application.id, {
            error_details: err.message
        });

        return {
            status: APPLICATION_STATES.UNCERTAIN_OUTCOME,
            reason: `In-flight browser crash or network error: ${err.message}`
        };
    }
}
