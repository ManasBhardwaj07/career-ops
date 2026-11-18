/**
 * application/apply.mjs — Universal Application Execution Engine
 *
 * Implements Milestone 3D Parts 2, 3, 10, 11, 12, 13:
 *   - Orchestrates end-to-end job application workflow:
 *     1. Liveness & eligibility verification
 *     2. Duplicate application prevention
 *     3. Evidence-grounded resume selection / generation
 *     4. Controlled browser session & network egress protection
 *     5. Portal detection (Greenhouse, Lever, Ashby, Workday, SmartRecruiters, Generic)
 *     6. Multi-signal field detection & semantic classification
 *     7. Verified candidate autofill
 *     8. Validated resume upload
 *     9. Multi-step form progression
 *    10. Mandatory human-input gating for legal/sensitive questions
 *    11. Comprehensive review packet generation
 *    12. Strict submission authorization enforcement (default MANUAL_REVIEW)
 */

import { createHash } from 'crypto';
import { mkdirSync } from 'fs';
import { resolve } from 'path';
import {
    getJob,
    getJobByUrl,
    getCompany,
    upsertCompany,
    upsertJobPosting,
    insertJobEvaluationRun,
    getSourcePolicy,
    getLatestEvaluationRun,
    getEffectiveTier2Eligibility,
    getApplicationByJobId,
    getApplication,
    upsertApplication,
    updateApplicationState,
    updateApplicationExecution,
    getResumeVersion,
    getCandidateFacts,
    getCandidateAnswers,
    upsertCandidateAnswer,
    confirmCandidateAnswer,
    APPLICATION_STATES
} from '../db/repo.mjs';

import { evaluateJobOffer } from '../matching/pipeline.mjs';

import { generateResume } from '../resume/generate-resume.mjs';
import { createBrowserSession } from './browser/session.mjs';
import { detectApplicationPortal } from './detection/detect-portal.mjs';
import { getAdapterForPortal } from './adapters/index.mjs';
import { mapFieldsToCandidateData } from './autofill/answer-mapper.mjs';
import { validateApplication } from './validation/validate-application.mjs';
import { buildReviewPacket } from './review/build-review-packet.mjs';
import { canProceedToSubmit } from './submission/policy.mjs';
import { submitApplication } from './submission/submit.mjs';

function extractCandidateContact(options = {}, candidateFacts = []) {
    const rawName = options.candidateName || candidateFacts.find(f => f.identifier === 'full_name' || f.identifier === 'name' || f.fact_type === 'full_name' || f.fact_type === 'name')?.value || null;
    const rawEmail = options.candidateEmail || candidateFacts.find(f => f.identifier === 'email' || f.identifier === 'contact-email' || f.fact_type === 'email')?.value || null;
    const rawPhone = options.candidatePhone || candidateFacts.find(f => f.identifier === 'phone' || f.identifier === 'contact-phone' || f.fact_type === 'phone')?.value || null;

    const sanitize = (val) => {
        if (!val) return null;
        const lower = String(val).toLowerCase().trim();
        if (lower === 'candidate' || lower === 'candidate name' || lower === 'alex doe' || lower === 'jane smith' || lower.endsWith('@example.com') || lower === '+1-555-0100' || lower === '+1-555-0123') {
            return null;
        }
        return val;
    };

    return {
        candidateName: sanitize(rawName),
        candidateEmail: sanitize(rawEmail),
        candidatePhone: sanitize(rawPhone)
    };
}

/**
 * Runs the complete application execution workflow for a job posting.
 */
export async function runApplicationWorkflow(jobId, options = {}) {
    const {
        headless = true,
        dryRun = false,
        allowConsider = false,
        userOverrideReason = null,
        autoSubmit = false,
        explicitAuthorization = null,
        browserSession = null,
        logger = (msg) => console.log(`[CareerOps:Apply] ${msg}`)
    } = options;

    logger(`Initiating application workflow for job: ${jobId}`);

    // ── 1. Load Job & Verify Active Status ────────────────────────────────────
    let job = getJob(jobId);
    if (!job && typeof jobId === 'string' && (jobId.startsWith('http://') || jobId.startsWith('https://'))) {
        job = getJobByUrl(jobId);
    }

    if (!job && typeof jobId === 'string' && (jobId.startsWith('http://') || jobId.startsWith('https://'))) {
        logger(`Job URL not yet in SQLite. Auto-detecting portal and registering: ${jobId}`);
        const detected = await detectApplicationPortal(jobId);

        let companySlug = 'company';
        let companyName = 'Company';
        try {
            const parsedUrl = new URL(jobId);
            const pathParts = parsedUrl.pathname.split('/').filter(Boolean);
            if (pathParts.length > 0) {
                companySlug = pathParts[0].toLowerCase();
                companyName = companySlug.charAt(0).toUpperCase() + companySlug.slice(1);
            }
        } catch {}

        const compId = `company-${companySlug}`;
        let company = getCompany(compId);
        if (!company) {
            upsertCompany({
                id: compId,
                name: companyName,
                lifecycle_status: 'APPROVED',
                submission_policy: 'MANUAL_REVIEW',
                policy_status: 'permitted'
            });
        }

        upsertJobPosting({
            id: jobId,
            company_id: compId,
            title: 'Software Engineer',
            location: 'India',
            job_url: jobId,
            source: detected.type,
            status: 'active'
        });

        job = getJob(jobId) || getJobByUrl(jobId);
    }

    if (!job) {
        throw new Error(`Job posting not found in SQLite: ${jobId}`);
    }

    if (job.status !== 'active') {
        throw new Error(`Job posting is not active (current status: ${job.status}). Application aborted.`);
    }

    // ── 2. Retrieve Latest Evaluation Run & Check Eligibility ────────────────
    let latestEval = getLatestEvaluationRun(job.id);
    if (!latestEval) {
        logger(`Evaluating candidate fit for job: ${job.id}...`);
        const candidateFacts = getCandidateFacts();
        const evalRes = evaluateJobOffer(job, candidateFacts);
        insertJobEvaluationRun({
            job_id: job.id,
            eval_version: '2.0.0',
            tier1_passed: evalRes.tier1.passed ? 1 : 0,
            tier1_matched_titles: JSON.stringify(evalRes.tier1.matchedKeywords || []),
            tier2_eligibility: evalRes.tier2.eligibility || 'PASS',
            tier2_gates_json: JSON.stringify(evalRes.tier2.gates || []),
            tier3_match_score: evalRes.tier3?.matchScore || 0.8,
            tier3_breakdown_json: JSON.stringify([]),
            recommendation: evalRes.recommendation || 'APPLY',
            notes: evalRes.reason || 'Auto-evaluated on application preparation'
        });
        latestEval = getLatestEvaluationRun(job.id);
    }

    const tier2Eligibility = getEffectiveTier2Eligibility(latestEval);
    const recommendation = latestEval.recommendation;

    if (tier2Eligibility === 'NOT_EVALUATED' && !userOverrideReason) {
        throw new Error(`Job did not pass Tier 1 role screening (Tier 2: NOT_EVALUATED; ${latestEval.notes || 'excluded title'}). Automated application blocked.`);
    }

    if (tier2Eligibility === 'FAIL' && !userOverrideReason) {
        throw new Error(`Candidate is not eligible for this role (Tier 2 Hard Eligibility failed: ${latestEval.notes}). Automated application blocked.`);
    }

    if (recommendation === 'DO_NOT_APPLY' && !userOverrideReason) {
        throw new Error(`Evaluation recommendation is DO_NOT_APPLY. Automated preparation blocked. (Provide explicit userOverrideReason to override).`);
    }

    if (recommendation === 'CONSIDER' && !allowConsider && !userOverrideReason) {
        throw new Error(`Evaluation recommendation is CONSIDER. Preparation requires explicit user selection (allowConsider: true).`);
    }

    // ── 3. Load Company & Source Policy Permissions ───────────────────────────
    const company = job.company_id ? getCompany(job.company_id) : null;
    const sourcePolicy = company ? getSourcePolicy(company.id) : null;

    if (company && (company.lifecycle_status === 'DISABLED' || company.lifecycle_status === 'REJECTED')) {
        throw new Error(`Company ${company.name} is ${company.lifecycle_status}. Applications blocked.`);
    }

    if (sourcePolicy && sourcePolicy.public_nav_permitted === 0) {
        throw new Error(`Public navigation is disallowed by source policy for company ${company?.name || job.company_id}.`);
    }

    // ── 4. Prevent Duplicate Applications ─────────────────────────────────────
    let existingApp = getApplicationByJobId(jobId);
    if (existingApp) {
        const terminalOrActiveStates = [
            APPLICATION_STATES.CONFIRMED,
            APPLICATION_STATES.SUBMITTING,
            APPLICATION_STATES.SUBMISSION_APPROVED
        ];
        if (terminalOrActiveStates.includes(existingApp.state)) {
            logger(`Existing application found in active/confirmed state: ${existingApp.state}. Preventing duplicate.`);
            return {
                applicationId: existingApp.id,
                status: existingApp.state,
                duplicatePrevented: true,
                message: `Application already exists in state ${existingApp.state}`
            };
        }
    }

    // ── 5. Select or Generate Job-Specific Resume ─────────────────────────────
    let resumeVersion = null;
    let resumePath = null;

    // Check if a tailored resume version already exists for this job
    if (existingApp?.resume_version_id) {
        resumeVersion = getResumeVersion(existingApp.resume_version_id);
        if (resumeVersion) resumePath = resumeVersion.file_path;
    }

    if (!resumeVersion) {
        logger('Generating / resolving evidence-grounded tailored resume...');
        const resumeResult = await generateResume({
            jobId,
            dryRun
        });
        resumeVersion = getResumeVersion(resumeResult.resumeVersionId);
        resumePath = resumeResult.pdfPath;
    }

    // ── 6. Create / Update Application Record in SQLite ───────────────────────
    const applicationId = existingApp?.id || `app_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    upsertApplication({
        id: applicationId,
        job_id: jobId,
        company_id: company?.id || job.company_id,
        resume_version_id: resumeVersion?.id || null,
        state: existingApp ? existingApp.state : APPLICATION_STATES.NOT_STARTED,
        notes: userOverrideReason ? `User override: ${userOverrideReason}` : null,
        started_at: new Date().toISOString()
    });

    updateApplicationState(applicationId, APPLICATION_STATES.DRAFTING, {
        actor: userOverrideReason ? 'user' : 'system',
        eventType: 'drafting_started',
        message: 'Application workflow initiated'
    });

    // ── 7. Open Portal in Controlled Browser Session ─────────────────────────
    const session = browserSession || await createBrowserSession({
        headless,
        profileDir: options.profileDir || options.sessionDir || undefined,
        allowedLocalOrigins: options.allowedLocalOrigins || [],
        enableEgressProxy: Boolean(options.enableEgressProxy),
        browser: options.browser,
        channel: options.channel,
        executablePath: options.executablePath,
        logger
    });

    let currentAdapter = null;
    let detectedPortal = null;
    let reviewPacket = null;

    try {
        let portalUrl = job.job_url || job.id;
        const initialDetected = await detectApplicationPortal(portalUrl);
        if (initialDetected.type === 'ashby' && !portalUrl.includes('/application')) {
            portalUrl = portalUrl.replace(/\/$/, '') + '/application';
        } else if (initialDetected.type === 'lever' && !portalUrl.includes('/apply')) {
            portalUrl = portalUrl.replace(/\/$/, '') + '/apply';
        }
        logger(`Navigating to portal URL: ${portalUrl}`);

        updateApplicationState(applicationId, APPLICATION_STATES.PORTAL_OPENED, {
            actor: 'system',
            eventType: 'portal_opened',
            message: `Navigated to ${portalUrl}`
        });

        const page = await session.getPage();
        if (options.htmlContent) {
            await page.setContent(options.htmlContent);
        } else {
            await session.navigate(portalUrl);
            try {
                await page.waitForSelector('input, textarea, select, form', { timeout: 15000 });
            } catch {}
            await page.waitForTimeout(2500);
        }

        // ── 8. Detect Portal Platform & Resolve Adapter ───────────────────────
        detectedPortal = await detectApplicationPortal(portalUrl, page);
        logger(`Detected application platform: ${detectedPortal.type} (confidence: ${detectedPortal.confidence})`);

        currentAdapter = getAdapterForPortal(detectedPortal.type, { logger });

        updateApplicationExecution(applicationId, {
            portal_type: detectedPortal.type,
            portal_url: portalUrl,
            last_active_at: new Date().toISOString()
        });

        // ── 9. Detect Form Fields ─────────────────────────────────────────────
        logger('Scanning DOM for application form fields...');
        const rawFields = await currentAdapter.detectFields(page);
        logger(`Detected ${rawFields.length} interactive form fields`);

        // ── 10. Map Fields to Candidate Facts & Verified Answers ──────────────
        const candidateFacts = getCandidateFacts();
        const candidateAnswers = getCandidateAnswers();

        const fieldMapping = mapFieldsToCandidateData(rawFields, {
            candidateFacts,
            candidateAnswers,
            resumePath,
            applicationId
        });

        logger(`Mapped ${fieldMapping.mappedCount} fields to verified candidate facts`);
        if (fieldMapping.unknownRequiredFields.length > 0) {
            logger(`⚠️ Found ${fieldMapping.unknownRequiredFields.length} unknown required fields`);
        }
        if (fieldMapping.sensitiveFieldsNeedingConfirmation.length > 0) {
            logger(`⚠️ Found ${fieldMapping.sensitiveFieldsNeedingConfirmation.length} sensitive questions needing human confirmation`);
        }

        // ── 11. Populate Supported Fields in DOM ──────────────────────────────
        updateApplicationState(applicationId, APPLICATION_STATES.FORM_FILLING, {
            actor: 'system',
            eventType: 'filling_started',
            message: `Populating ${fieldMapping.mappedCount} mapped fields in DOM`
        });

        const fillResult = await currentAdapter.fill(page, fieldMapping.mappings);
        logger(`Successfully populated ${fillResult.successfulCount} fields in DOM`);

        // ── 12. Attach Resume PDF ─────────────────────────────────────────────
        logger(`Attaching verified resume: ${resumePath}`);
        const resumeAttachResult = await currentAdapter.attachResume(page, {
            resumeVersion,
            pdfPath: resumePath
        });

        if (!resumeAttachResult.success) {
            logger(`⚠️ Resume attachment could not locate file input: ${resumeAttachResult.error}`);
        } else {
            logger(`Resume attached successfully via ${resumeAttachResult.targetSelector}`);
        }

        // ── 13. Mandatory Human Verification Check ────────────────────────────
        if (!fieldMapping.canAutoProceed) {
            updateApplicationState(applicationId, APPLICATION_STATES.NEEDS_USER_INPUT, {
                actor: 'system',
                eventType: 'needs_user_input',
                message: 'Application form contains unmapped required or sensitive questions requiring user answer',
                payload: {
                    unknownRequired: fieldMapping.unknownRequiredFields.map(f => f.field.label || f.field.name),
                    sensitiveNeedingConfirmation: fieldMapping.sensitiveFieldsNeedingConfirmation.map(f => f.field.label || f.field.name)
                }
            });

            const contactInfo = extractCandidateContact(options, candidateFacts);
            reviewPacket = buildReviewPacket({
                applicationId,
                job,
                company,
                portalType: detectedPortal.type,
                portalUrl,
                candidateName: contactInfo.candidateName,
                candidateEmail: contactInfo.candidateEmail,
                candidatePhone: contactInfo.candidatePhone,
                resumeVersion,
                mappedFields: fieldMapping.mappings,
                submissionPolicy: company?.submission_policy || 'MANUAL_REVIEW'
            });

            const pendingQuestions = [];
            const seenKeys = new Set();

            for (const item of fieldMapping.unknownRequiredFields) {
                const key = item.field.name || item.field.id || item.field.label;
                if (!seenKeys.has(key)) {
                    seenKeys.add(key);
                    pendingQuestions.push({
                        key,
                        label: item.field.label || item.field.name || item.field.id,
                        type: item.field.type || 'text',
                        options: item.field.options || [],
                        required: true,
                        isSensitive: Boolean(item.field.isSensitive),
                        reason: item.reason,
                        status: 'pending'
                    });
                }
            }

            for (const item of fieldMapping.sensitiveFieldsNeedingConfirmation) {
                const key = item.field.name || item.field.id || item.field.label;
                if (!seenKeys.has(key)) {
                    seenKeys.add(key);
                    pendingQuestions.push({
                        key,
                        label: item.field.label || item.field.name || item.field.id,
                        type: item.field.type || 'text',
                        options: item.field.options || [],
                        required: Boolean(item.field.required),
                        isSensitive: true,
                        reason: item.reason,
                        status: 'pending'
                    });
                }
            }

            const completedFields = fieldMapping.mappings
                .filter(m => m.status === 'mapped')
                .map(m => ({
                    name: m.name,
                    id: m.id,
                    label: m.label,
                    value: m.mappedValue,
                    selector: m.selector,
                    classification: m.classification
                }));

            const checkpoint = {
                formStep: 1,
                fieldsDetected: rawFields.length,
                fieldsMapped: fieldMapping.mappedCount,
                unknownRequiredCount: fieldMapping.unknownRequiredFields.length,
                completedFields,
                pendingQuestions,
                resumeAttached: resumeAttachResult.success,
                portalUrl,
                portalType: detectedPortal.type,
                lastCheckpointAt: new Date().toISOString()
            };

            let screenshotPath = null;
            try {
                mkdirSync(resolve(process.cwd(), 'output/screenshots'), { recursive: true });
                screenshotPath = resolve(process.cwd(), `output/screenshots/${applicationId}_dryrun.png`);
                await page.screenshot({ path: screenshotPath, fullPage: true });
                logger(`[Screenshot Captured] Saved live dry-run form screenshot to: ${screenshotPath}`);
            } catch (ssErr) {
                logger(`[Screenshot Notice] Could not capture screenshot: ${ssErr.message}`);
            }

            checkpoint.screenshotPath = screenshotPath;

            updateApplicationExecution(applicationId, {
                review_packet_path: reviewPacket.mdPath,
                execution_metadata_json: checkpoint
            });

            return {
                applicationId,
                status: APPLICATION_STATES.NEEDS_USER_INPUT,
                reviewPacketPath: reviewPacket.mdPath,
                screenshotPath,
                canProceedToSubmit: false,
                unknownRequiredFields: fieldMapping.unknownRequiredFields,
                sensitiveFieldsNeedingConfirmation: fieldMapping.sensitiveFieldsNeedingConfirmation,
                checkpoint,
                session
            };
        }

        // ── 14. Handle Multi-Step Progression if present ──────────────────────
        const nextStepResult = await currentAdapter.handleNextStep(page);
        if (nextStepResult.clicked) {
            logger(`Progressed multi-step form: clicked "${nextStepResult.buttonText}"`);
            await page.waitForTimeout(1000);
        }

        // ── 15. Form Validation ───────────────────────────────────────────────
        const validationResult = await validateApplication(page, {
            mappedFields: fieldMapping.mappings,
            resumeAttached: resumeAttachResult.success,
            adapter: currentAdapter
        });

        // ── 16. Generate Review Packet & Transition to READY_FOR_REVIEW ───────
        updateApplicationState(applicationId, APPLICATION_STATES.READY_FOR_REVIEW, {
            actor: 'system',
            eventType: 'ready_for_review',
            message: 'Form fields populated, resume attached, ready for human review'
        });

        const contactInfo = extractCandidateContact(options, candidateFacts);

        reviewPacket = buildReviewPacket({
            applicationId,
            job,
            company,
            portalType: detectedPortal.type,
            portalUrl,
            candidateName: contactInfo.candidateName,
            candidateEmail: contactInfo.candidateEmail,
            candidatePhone: contactInfo.candidatePhone,
            resumeVersion,
            mappedFields: fieldMapping.mappings,
            validationResult,
            submissionPolicy: company?.submission_policy || 'MANUAL_REVIEW',
            authorization: explicitAuthorization,
            outputDir: options.reviewPacketsDir || options.outputDir
        });

        updateApplicationExecution(applicationId, {
            review_packet_path: reviewPacket.mdPath,
            execution_metadata_json: {
                fieldsDetected: rawFields.length,
                fieldsMapped: fieldMapping.mappedCount,
                resumeAttached: resumeAttachResult.success,
                validationPassed: validationResult.valid
            }
        });

        logger(`Generated application review packet: ${reviewPacket.mdPath}`);

        // ── 17. Submission Policy Check ───────────────────────────────────────
        const policyCheck = canProceedToSubmit({
            application: getApplication(applicationId),
            job,
            company,
            sourcePolicy,
            validationResult,
            explicitAuthorization
        });

        if (autoSubmit && policyCheck.allowed) {
            logger('Auto-submit authorized. Proceeding to final submission...');
            const submitResult = await submitApplication(page, {
                application: getApplication(applicationId),
                job,
                company,
                adapter: currentAdapter,
                validationResult,
                authorization: policyCheck.authorization,
                dryRun,
                logger
            });
            return submitResult;
        } else {
            logger(`Default policy requires human review. Stopped at READY_FOR_REVIEW. (Reason: ${policyCheck.reason})`);
            return {
                applicationId,
                status: APPLICATION_STATES.READY_FOR_REVIEW,
                portalType: detectedPortal.type,
                reviewPacketPath: reviewPacket.mdPath,
                validation: validationResult,
                canProceedToSubmit: policyCheck.allowed,
                policyReason: policyCheck.reason,
                session
            };
        }

    } finally {
        if (!browserSession && !options.keepOpen) {
            await session.close();
        }
    }
}

/**
 * Resumes an application workflow that was paused at NEEDS_USER_INPUT.
 * Reconciles newly confirmed candidate answers, resumes form filling,
 * validates the form, and advances to READY_FOR_REVIEW.
 */
export async function resumeApplicationWorkflow(applicationId, options = {}) {
    const {
        headless = true,
        dryRun = false,
        submit = false,
        explicitAuthorization = null,
        browserSession = null,
        logger = (msg) => console.log(`[CareerOps:Resume] ${msg}`)
    } = options;

    logger(`Resuming application: ${applicationId}${submit ? ' [SUBMIT MODE]' : ''}`);

    const app = getApplication(applicationId);
    if (!app) {
        throw new Error(`Application record not found: ${applicationId}`);
    }

    if (submit) {
        if (app.state !== APPLICATION_STATES.READY_FOR_REVIEW) {
            throw new Error(`Application ${applicationId} cannot be submitted from state: ${app.state}. Must be in READY_FOR_REVIEW.`);
        }
    } else {
        const resumableStates = [
            APPLICATION_STATES.NEEDS_USER_INPUT,
            APPLICATION_STATES.PORTAL_OPENED,
            APPLICATION_STATES.FORM_FILLING
        ];
        if (!resumableStates.includes(app.state)) {
            throw new Error(`Application ${applicationId} cannot be resumed from state: ${app.state}. Must be one of: ${resumableStates.join(', ')}`);
        }
    }

    const job = getJob(app.job_id);
    if (!job) {
        throw new Error(`Associated job posting not found: ${app.job_id}`);
    }
    if (job.status !== 'active') {
        throw new Error(`Job posting is no longer active (status: ${job.status}). Continuation aborted.`);
    }

    const company = job.company_id ? getCompany(job.company_id) : null;
    const sourcePolicy = company ? getSourcePolicy(company.id) : null;

    let metadata = {};
    if (app.execution_metadata_json) {
        try {
            metadata = typeof app.execution_metadata_json === 'string'
                ? JSON.parse(app.execution_metadata_json)
                : app.execution_metadata_json;
        } catch {
            metadata = {};
        }
    }

    // Check candidate answers to verify whether all required/sensitive fields have been answered
    const candidateFacts = getCandidateFacts();
    const candidateAnswers = getCandidateAnswers();
    const answersMap = new Map();
    for (const a of candidateAnswers) {
        if (a.confirmed_by_user || a.confidence >= 0.9) {
            answersMap.set(a.question_key.toLowerCase(), a);
            if (a.question_text) answersMap.set(a.question_text.toLowerCase().trim(), a);
        }
    }

    // Check pending questions in checkpoint metadata (only for normal resume)
    if (!submit) {
        const pendingQuestions = Array.isArray(metadata.pendingQuestions) ? metadata.pendingQuestions : [];
        const remainingUnanswered = [];

        for (const pq of pendingQuestions) {
            const key = (pq.key || '').toLowerCase();
            const lbl = (pq.label || '').toLowerCase();
            const hasAnswer = answersMap.has(key) || answersMap.has(lbl);
            if (!hasAnswer && (pq.required || pq.isSensitive)) {
                remainingUnanswered.push(pq);
            }
        }

        if (remainingUnanswered.length > 0) {
            logger(`Cannot advance: ${remainingUnanswered.length} required/sensitive questions remain unanswered`);
            return {
                applicationId,
                status: APPLICATION_STATES.NEEDS_USER_INPUT,
                resumed: false,
                message: `Remaining unanswered questions: ${remainingUnanswered.map(q => q.label || q.key).join(', ')}`,
                remainingQuestions: remainingUnanswered
            };
        }

        // Resume execution: transition to FORM_FILLING
        updateApplicationState(applicationId, APPLICATION_STATES.FORM_FILLING, {
            actor: 'user',
            eventType: 'continuation_resumed',
            message: 'Resuming application filling with confirmed candidate answers'
        });
    }

    let resumeVersion = null;
    let resumePath = null;
    if (app.resume_version_id) {
        resumeVersion = getResumeVersion(app.resume_version_id);
        if (resumeVersion) resumePath = resumeVersion.file_path;
    }

    // If submit mode, pre-flight policy check before launching browser
    let policyCheck = null;
    if (submit) {
        policyCheck = canProceedToSubmit({
            application: app,
            job,
            company,
            sourcePolicy,
            validationResult: null,
            explicitAuthorization
        });
        if (!policyCheck.allowed) {
            throw new Error(`Submission rejected by policy: ${policyCheck.reason}`);
        }
    }

    const session = browserSession || await createBrowserSession({
        headless,
        profileDir: options.profileDir || options.sessionDir || undefined,
        allowedLocalOrigins: options.allowedLocalOrigins || [],
        enableEgressProxy: Boolean(options.enableEgressProxy),
        logger
    });

    let currentAdapter = null;
    let detectedPortal = null;
    let reviewPacket = null;

    try {
        const portalUrl = app.portal_url || job.job_url || job.id;
        const page = await session.getPage();

        if (options.htmlContent) {
            await page.setContent(options.htmlContent);
        } else {
            await session.navigate(portalUrl);
            try {
                await page.waitForSelector('input, textarea, select, form', { timeout: 15000 });
            } catch {}
            await page.waitForTimeout(2500);
        }

        detectedPortal = await detectApplicationPortal(portalUrl, page);
        currentAdapter = getAdapterForPortal(detectedPortal.type, { logger });

        logger('Scanning DOM and mapping with confirmed answers...');
        const rawFields = await currentAdapter.detectFields(page);
        const fieldMapping = mapFieldsToCandidateData(rawFields, {
            candidateFacts,
            candidateAnswers,
            resumePath,
            applicationId
        });

        // Verify that now all required and sensitive fields are mapped
        if (!fieldMapping.canAutoProceed) {
            updateApplicationState(applicationId, APPLICATION_STATES.NEEDS_USER_INPUT, {
                actor: 'system',
                eventType: 'needs_user_input',
                message: 'Portal still has unmapped required fields after DOM re-scan',
                payload: {
                    unknownRequired: fieldMapping.unknownRequiredFields.map(f => f.field.label || f.field.name)
                }
            });
            return {
                applicationId,
                status: APPLICATION_STATES.NEEDS_USER_INPUT,
                resumed: false,
                unknownRequiredFields: fieldMapping.unknownRequiredFields
            };
        }

        // Populate fields in DOM
        logger(`Populating ${fieldMapping.mappedCount} fields in DOM...`);
        const fillResult = await currentAdapter.fill(page, fieldMapping.mappings);
        logger(`Successfully populated ${fillResult.successfulCount} fields`);

        // Attach resume if needed (re-verify on current page DOM if file input is empty)
        const hasUnattachedFileInput = await page.evaluate(() => {
            const fileInputs = Array.from(document.querySelectorAll('input[type="file"]'));
            return fileInputs.length > 0 && fileInputs.some(inp => !inp.files || inp.files.length === 0);
        });

        let resumeAttached = metadata.resumeAttached || false;
        if (resumePath && (hasUnattachedFileInput || !resumeAttached || submit)) {
            logger(`Attaching resume PDF: ${resumePath}`);
            const attachRes = await currentAdapter.attachResume(page, {
                resumeVersion,
                pdfPath: resumePath
            });
            resumeAttached = attachRes.success;
        }

        // Handle multi-step if present
        const nextStepResult = await currentAdapter.handleNextStep(page);
        if (nextStepResult.clicked) {
            logger(`Progressed multi-step form: clicked "${nextStepResult.buttonText}"`);
            await page.waitForTimeout(1000);
        }

        // Validate form
        const validationResult = await validateApplication(page, {
            mappedFields: fieldMapping.mappings,
            resumeAttached,
            adapter: currentAdapter
        });

        if (submit) {
            // === SUBMISSION PATH ===
            if (!validationResult.valid) {
                logger(`Form validation failed: ${validationResult.errors?.join('; ')}`);
                throw new Error(`Application form validation failed: ${validationResult.errors?.join('; ')}`);
            }

            // Live form verification against payload_digest
            const liveCompletedFields = fieldMapping.mappings
                .filter(m => m.status === 'mapped')
                .map(m => ({
                    name: m.name || m.id || '',
                    value: String(m.mappedValue || '')
                }))
                .sort((a, b) => a.name.localeCompare(b.name));

            const livePayloadContent = JSON.stringify({
                resume_version_id: app.resume_version_id || null,
                completedFields: liveCompletedFields
            });
            const livePayloadDigest = createHash('sha256').update(livePayloadContent).digest('hex');

            const activeAuth = policyCheck.authorization;
            if (activeAuth.payload_digest && livePayloadDigest !== activeAuth.payload_digest) {
                logger(`Live form payload digest mismatch: ${livePayloadDigest} vs authorized ${activeAuth.payload_digest}`);
                updateApplicationState(applicationId, APPLICATION_STATES.NEEDS_USER_INPUT, {
                    actor: 'system',
                    eventType: 'submission_verification_failed',
                    message: `Live form payload digest mismatch (${livePayloadDigest} vs ${activeAuth.payload_digest})`
                });
                throw new Error(`Submission verification failed: Live DOM form fields do not match authorized payload digest (${livePayloadDigest} vs ${activeAuth.payload_digest})`);
            }

            logger('Pre-submission live form verification passed. Delegating to submitApplication...');
            const submitResult = await submitApplication(page, {
                application: getApplication(applicationId),
                job,
                company,
                adapter: currentAdapter,
                validationResult,
                authorization: activeAuth,
                dryRun,
                logger
            });

            return submitResult;
        }

        // Transition to READY_FOR_REVIEW
        updateApplicationState(applicationId, APPLICATION_STATES.READY_FOR_REVIEW, {
            actor: 'system',
            eventType: 'ready_for_review',
            message: 'Continuation completed: all fields filled and validated'
        });

        const contactInfo = extractCandidateContact(options, candidateFacts);

        reviewPacket = buildReviewPacket({
            applicationId,
            job,
            company,
            portalType: detectedPortal.type,
            portalUrl,
            candidateName: contactInfo.candidateName,
            candidateEmail: contactInfo.candidateEmail,
            candidatePhone: contactInfo.candidatePhone,
            resumeVersion,
            mappedFields: fieldMapping.mappings,
            validationResult,
            submissionPolicy: company?.submission_policy || 'MANUAL_REVIEW',
            authorization: explicitAuthorization,
            outputDir: options.reviewPacketsDir || options.outputDir
        });

        const updatedCheckpoint = {
            ...metadata,
            formStep: metadata.formStep || 1,
            fieldsDetected: rawFields.length,
            fieldsMapped: fieldMapping.mappedCount,
            completedFields: fieldMapping.mappings.filter(m => m.status === 'mapped').map(m => ({
                name: m.name,
                id: m.id,
                label: m.label,
                value: m.mappedValue
            })),
            pendingQuestions: [],
            resumeAttached,
            validationPassed: validationResult.valid,
            lastCheckpointAt: new Date().toISOString()
        };

        updateApplicationExecution(applicationId, {
            review_packet_path: reviewPacket.mdPath,
            execution_metadata_json: updatedCheckpoint,
            last_active_at: new Date().toISOString()
        });

        logger(`Updated review packet at: ${reviewPacket.mdPath}`);

        const postPolicyCheck = canProceedToSubmit({
            application: getApplication(applicationId),
            job,
            company,
            sourcePolicy,
            validationResult,
            explicitAuthorization
        });

        return {
            applicationId,
            status: APPLICATION_STATES.READY_FOR_REVIEW,
            portalType: detectedPortal.type,
            reviewPacketPath: reviewPacket.mdPath,
            validation: validationResult,
            canProceedToSubmit: postPolicyCheck.allowed,
            policyReason: postPolicyCheck.reason
        };

    } finally {
        if (!browserSession) {
            await session.close();
        }
    }
}

/**
 * Resolves human-attention checkpoint by accepting user answers,
 * confirming them in candidate_answers table, and resuming the application workflow.
 *
 * @param {string} applicationId
 * @param {Array|object} userAnswers - Array of { key, value } or object { [key]: value }
 * @param {object} options
 */
export async function resumeApplicationFromCheckpoint(applicationId, userAnswers = {}, options = {}) {
    const { logger = (msg) => console.log(`[CareerOps:ResumeCheckpoint] ${msg}`) } = options;

    logger(`Resolving human checkpoint for application: ${applicationId}`);

    const app = getApplication(applicationId);
    if (!app) {
        throw new Error(`Application not found: ${applicationId}`);
    }

    // Upsert and confirm user answers
    const answersList = Array.isArray(userAnswers)
        ? userAnswers
        : Object.entries(userAnswers).map(([k, v]) => ({ key: k, value: v }));

    for (const ans of answersList) {
        if (!ans.key) continue;
        const answerId = `ans_user_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        upsertCandidateAnswer({
            id: answerId,
            question_key: ans.key,
            question_text: ans.label || ans.key,
            answer_value: String(ans.value),
            confirmed_by_user: 1,
            confirmed_at: new Date().toISOString()
        });
        confirmCandidateAnswer(ans.key, String(ans.value));
        logger(`Confirmed candidate answer for key: ${ans.key}`);
    }

    // Resume the application workflow
    return resumeApplicationWorkflow(applicationId, {
        ...options,
        logger
    });
}
