/**
 * application/submission/confirm-submission.mjs — Submission Confirmation Detector
 *
 * Implements Milestone 3D Part 13 & Milestone 2:
 *   - Verifies post-submission confirmation from portal response, URL patterns, or DOM text
 *   - Captures receipt full-page screenshot to output/screenshots/<application_id>_confirmation.png
 *   - Classifies outcome into CONFIRMED or UNCERTAIN_OUTCOME
 */

import { mkdirSync } from 'fs';
import { resolve, join } from 'path';

export const URL_CONFIRMATION_PATTERNS = [
    '/thank-you',
    '/thanks',
    '/thank_you',
    '/submitted',
    '/confirmation',
    '/application-received',
    '/apply/success',
    '/success',
    '/applied',
    '/complete'
];

export const DOM_CONFIRMATION_PHRASES = [
    'thank you for applying',
    'application submitted',
    'application received',
    'successfully submitted',
    'your application has been submitted',
    'thanks for applying',
    'we have received your application',
    'application has been received',
    'submission successful'
];

/**
 * Captures post-submission screenshot to output/screenshots
 */
async function capturePostSubmissionScreenshot(page, { applicationId, isConfirmed, outputDir, logger }) {
    if (!page || typeof page.screenshot !== 'function') return null;

    try {
        const targetDir = outputDir ? resolve(outputDir) : resolve(process.cwd(), 'output/screenshots');
        mkdirSync(targetDir, { recursive: true });

        const sanitizedAppId = applicationId
            ? String(applicationId).replace(/[^a-zA-Z0-9_-]/g, '_')
            : `app_${Date.now()}`;
        const suffix = isConfirmed ? 'confirmation' : 'uncertain';
        const screenshotPath = join(targetDir, `${sanitizedAppId}_${suffix}.png`);

        await page.screenshot({ path: screenshotPath, fullPage: true });
        if (logger) logger(`[Receipt Screenshot] Saved to ${screenshotPath}`);
        return screenshotPath;
    } catch (err) {
        if (logger) logger(`[Receipt Screenshot Warning] Failed to capture screenshot: ${err.message}`);
        return null;
    }
}

/**
 * Inspects page following submission action to detect confirmation or ambiguous outcome.
 */
export async function confirmSubmission(page, adapter, {
    timeoutMs = 15000,
    logger = null,
    applicationId = null,
    outputDir = null
} = {}) {
    if (!page) throw new Error('Page required for confirmSubmission');

    const startTime = Date.now();
    let confirmation = null;

    while (Date.now() - startTime < timeoutMs) {
        try {
            // 1. Adapter custom detector (if implemented by specific portal adapter)
            confirmation = adapter ? await adapter.detectConfirmation(page) : null;

            // 2. URL confirmation pattern check
            if (!confirmation) {
                try {
                    const currentUrl = (page.url ? page.url() : '') || '';
                    const lowerUrl = currentUrl.toLowerCase();
                    const matchedPat = URL_CONFIRMATION_PATTERNS.find(pat => lowerUrl.includes(pat));
                    if (matchedPat) {
                        confirmation = {
                            confirmed: true,
                            matchedPhrase: `URL confirmation pattern matched: ${matchedPat}`,
                            url: currentUrl
                        };
                    }
                } catch {}
            }

            // 3. Fallback DOM body text check
            if (!confirmation) {
                confirmation = await page.evaluate((phrases) => {
                    const text = document.body ? document.body.innerText.toLowerCase() : '';
                    for (const phrase of phrases) {
                        if (text.includes(phrase)) {
                            return {
                                confirmed: true,
                                matchedPhrase: phrase,
                                url: window.location.href
                            };
                        }
                    }
                    return null;
                }, DOM_CONFIRMATION_PHRASES);
            }

            if (confirmation && confirmation.confirmed) {
                if (logger) logger(`[Submission CONFIRMED] ${confirmation.matchedPhrase}`);

                const receiptScreenshotPath = await capturePostSubmissionScreenshot(page, {
                    applicationId,
                    isConfirmed: true,
                    outputDir,
                    logger
                });

                return {
                    status: 'CONFIRMED',
                    confirmationReference: confirmation.confirmationReference || null,
                    matchedPhrase: confirmation.matchedPhrase,
                    finalUrl: confirmation.url || (page.url ? page.url() : ''),
                    receiptScreenshotPath
                };
            }
        } catch {}

        await new Promise(r => setTimeout(r, 1000));
    }

    // Ambiguous outcome or timeout
    const currentUrl = page.url ? page.url() : '';
    if (logger) logger(`[Submission UNCERTAIN] Timed out waiting for explicit confirmation. URL: ${currentUrl}`);

    const receiptScreenshotPath = await capturePostSubmissionScreenshot(page, {
        applicationId,
        isConfirmed: false,
        outputDir,
        logger
    });

    return {
        status: 'UNCERTAIN_OUTCOME',
        finalUrl: currentUrl,
        reason: 'Submission triggered but no definitive confirmation receipt was detected within timeout window',
        receiptScreenshotPath
    };
}
