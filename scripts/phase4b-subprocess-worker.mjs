/**
 * scripts/phase4b-subprocess-worker.mjs
 *
 * Dedicated isolated worker script spawned by test-phase4b-e2e.mjs
 * to verify genuine independent-process execution, answer recording,
 * workflow resumption, and crash recovery.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { chromium } from 'playwright';
import {
    getDb,
    getApplication,
    getJob,
    getSubmissionAuthorization,
    APPLICATION_STATES
} from '../db/repo.mjs';
import { recordUserAnswer } from '../application/autofill/answer-mapper.mjs';

import { resumeApplicationWorkflow } from '../application/apply.mjs';
import { submitApplication } from '../application/submission/submit.mjs';
import { getAdapterForPortal } from '../application/adapters/index.mjs';
import { PORTAL_TYPES } from '../application/detection/detect-portal.mjs';

const mode = process.argv[2];

async function main() {
    if (mode === 'resume_process_b') {
        const appId = process.argv[3];
        const questionKey = process.argv[4];
        const answerValue = process.argv[5];
        const reviewPacketsDir = process.argv[6];
        const allowedOrigin = process.argv[7];
        const htmlFilePath = process.argv[8];
        if (!appId || !questionKey) {
            console.error('Missing required arguments for resume_process_b');
            process.exit(1);
        }

        console.log(`[Process B] Booted in independent process (PID ${process.pid}) for app: ${appId}`);

        // 1. Record application-scoped user answer
        recordUserAnswer({
            applicationId: appId,
            questionKey,
            answerValue,
            confirmedByUser: 1,
            confidence: 1.0,
            source: 'user_input'
        });
        console.log(`[Process B] Recorded answer for ${questionKey} = ${answerValue}`);

        // Read HTML content if passed via file
        let htmlContent = null;
        if (htmlFilePath && existsSync(htmlFilePath)) {
            htmlContent = readFileSync(htmlFilePath, 'utf8');
        }

        // 2. Resume workflow from SQLite checkpoint
        const resumeResult = await resumeApplicationWorkflow(appId, {
            headless: true,
            htmlContent,
            reviewPacketsDir,
            allowedLocalOrigins: allowedOrigin ? [allowedOrigin] : [],
            logger: (msg) => console.log(`[Process B:Resume] ${msg}`)
        });

        console.log(`[Process B] Workflow resume result state: ${resumeResult.status}`);
        if (resumeResult.status === APPLICATION_STATES.READY_FOR_REVIEW) {
            console.log('[Process B] SUCCESS: Reached READY_FOR_REVIEW');
            process.exit(0);
        } else {
            console.error(`[Process B] Unexpected resume state: ${resumeResult.status}`);
            process.exit(2);
        }

    } else if (mode === 'submit_in_flight_crash') {
        const appId = process.argv[3];
        const jobId = process.argv[4];
        const compId = process.argv[5];
        const authId = process.argv[6];
        const portalUrl = process.argv[7];
        const allowedOrigin = process.argv[8];
        const htmlFilePath = process.argv[9];
        const signalFilePath = process.argv[10];
        console.log(`[Process C:CrashWorker] Booted in independent process (PID ${process.pid}) for app: ${appId}`);

        const app = getApplication(appId);
        const job = getJob(jobId);
        const auth = getSubmissionAuthorization(authId);
        const adapter = getAdapterForPortal(PORTAL_TYPES.GREENHOUSE);

        const browser = await chromium.launch({ headless: true });
        const page = await browser.newPage();

        await page.route('**/*', async (route) => {
            const req = route.request();
            if (req.method() === 'POST' && req.url().includes('/crash')) {
                console.log('[Process C:CrashWorker] In-flight POST dispatched to /crash. Signaling parent and holding response pending...');
                if (signalFilePath) {
                    writeFileSync(signalFilePath, JSON.stringify({ pid: process.pid, inFlight: true, timestamp: Date.now() }), 'utf8');
                }
                // Intentionally do NOT call route.fulfill() — keep request in-flight indefinitely
                await new Promise(() => {}); // never fulfills
                return;
            }
            return route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>OK</h1>' });
        });

        if (htmlFilePath && existsSync(htmlFilePath)) {
            const html = readFileSync(htmlFilePath, 'utf8');
            await page.setContent(html);
        } else if (portalUrl) {
            await page.goto(portalUrl);
        }

        console.log('[Process C:CrashWorker] Initiating submitApplication against mock crash endpoint...');

        // This will POST to the mock crash endpoint which pauses the response.
        // The parent process will SIGKILL this worker during the in-flight POST.
        try {
            await submitApplication(page, {
                application: app,
                job,
                company: { id: compId },
                adapter,
                authorization: auth,
                validationResult: { valid: true },
                logger: (msg) => console.log(`[Process C:Submit] ${msg}`)
            });
            console.log('[Process C:CrashWorker] Submission finished normally (not killed)');
            process.exit(0);
        } catch (err) {
            console.error(`[Process C:CrashWorker] Threw error: ${err.message}`);
            process.exit(1);
        } finally {
            await browser.close().catch(() => {});
        }

    } else {
        console.error(`Unknown mode: ${mode}`);
        process.exit(1);
    }
}

main().catch(err => {
    console.error('[Worker Fatal Error]', err);
    process.exit(1);
});
