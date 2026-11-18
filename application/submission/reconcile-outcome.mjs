/**
 * application/submission/reconcile-outcome.mjs — Uncertain Outcome Reconciliation
 *
 * Implements Milestone 3D Part 13:
 *   - Safely reconciles applications in UNCERTAIN_OUTCOME
 *   - Prevents blind automated resubmissions or duplicate applications
 */

import {
    getApplication,
    getDb,
    updateApplicationState,
    updateApplicationExecution,
    updateRecruitmentOutcome,
    runInTransaction,
    APPLICATION_STATES,
    RECRUITMENT_OUTCOMES
} from '../../db/repo.mjs';
import { exportApplicationsMarkdown } from '../../tracking/export-tracker.mjs';

/**
 * Scans for applications left in SUBMITTING across process restarts.
 * Because the process terminated mid-submission, the external outcome is ambiguous:
 * transitions them to UNCERTAIN_OUTCOME so they cannot be blindly resubmitted
 * and require explicit reconciliation.
 */
export function recoverInterruptedSubmissions(options = {}) {
    const { logger = null } = options;
    const db = getDb();
    const interrupted = db.prepare(`
        SELECT id, updated_at FROM applications
        WHERE state = '${APPLICATION_STATES.SUBMITTING}'
    `).all();

    for (const app of interrupted) {
        if (logger) logger(`[Recovery] Found interrupted application in SUBMITTING: ${app.id}`);
        updateApplicationState(app.id, APPLICATION_STATES.UNCERTAIN_OUTCOME, {
            actor: 'system',
            eventType: 'interrupted_submission_detected',
            message: 'Application was left in SUBMITTING by an interrupted process. Transitioned to UNCERTAIN_OUTCOME for reconciliation.',
            payload: { previousState: APPLICATION_STATES.SUBMITTING }
        });
        updateApplicationExecution(app.id, {
            error_details: 'Process interrupted during external submission action'
        });
    }

    return interrupted.map(a => a.id);
}

/**
 * Reconciles an application currently in UNCERTAIN_OUTCOME (or interrupted SUBMITTING).
 */
export function reconcileSubmissionOutcome(applicationId, {
    outcome, // 'CONFIRMED' or 'READY_FOR_REVIEW' or 'DRAFTING'
    confirmationReference = null,
    notes = null,
    actor = 'user'
}) {
    const app = getApplication(applicationId);
    if (!app) {
        throw new Error(`Application not found: ${applicationId}`);
    }

    if (app.state === APPLICATION_STATES.SUBMITTING) {
        // Auto-recover interrupted SUBMITTING to UNCERTAIN_OUTCOME before applying target reconciliation outcome
        updateApplicationState(applicationId, APPLICATION_STATES.UNCERTAIN_OUTCOME, {
            actor: 'system',
            eventType: 'interrupted_submission_detected',
            message: 'Interrupted SUBMITTING application identified during reconciliation. Transitioned to UNCERTAIN_OUTCOME.',
            payload: { previousState: APPLICATION_STATES.SUBMITTING }
        });
    } else if (app.state !== APPLICATION_STATES.UNCERTAIN_OUTCOME) {
        throw new Error(`Cannot reconcile application in state "${app.state}". Reconciliation only applies to UNCERTAIN_OUTCOME or interrupted SUBMITTING.`);
    }

    const validOutcomes = [
        APPLICATION_STATES.CONFIRMED,
        APPLICATION_STATES.READY_FOR_REVIEW,
        APPLICATION_STATES.DRAFTING
    ];

    if (!validOutcomes.includes(outcome)) {
        throw new Error(`Invalid reconciliation outcome "${outcome}". Must be one of: ${validOutcomes.join(', ')}`);
    }

    // Perform atomic transaction: State transition + Recruitment Outcome + Submission Receipt
    runInTransaction(() => {
        updateApplicationState(applicationId, outcome, {
            actor,
            eventType: 'outcome_reconciled',
            message: `Manual outcome reconciliation to ${outcome}: ${notes || 'No notes provided'}`,
            payload: { outcome, confirmationReference, notes }
        });

        const executionUpdates = {
            notes: notes ? `${app.notes || ''} [Reconciliation: ${notes}]`.trim() : app.notes
        };

        if (outcome === APPLICATION_STATES.CONFIRMED) {
            executionUpdates.confirmation_reference = confirmationReference;
            executionUpdates.submitted_at = new Date().toISOString();

            updateRecruitmentOutcome(applicationId, RECRUITMENT_OUTCOMES.APPLIED, {
                actor,
                reason: `Reconciled to CONFIRMED: ${notes || 'Manual reconciliation'}`
            });
        }

        updateApplicationExecution(applicationId, executionUpdates);
    });

    // Post-commit: Regenerate canonical markdown projection idempotently
    if (outcome === APPLICATION_STATES.CONFIRMED) {
        try {
            exportApplicationsMarkdown();
        } catch (exportErr) {
            console.error(`[Tracker Export Warning] Failed to regenerate applications.md: ${exportErr.message}`);
        }
    }

    return {
        success: true,
        applicationId,
        previousState: APPLICATION_STATES.UNCERTAIN_OUTCOME,
        newState: outcome,
        confirmationReference
    };
}
