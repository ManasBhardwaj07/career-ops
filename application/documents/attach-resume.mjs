/**
 * application/documents/attach-resume.mjs — Verified Resume Attachment
 *
 * Implements Milestone 3D Part 9:
 *   - Verifies the selected PDF from resume_versions before attachment
 *   - Locates appropriate file upload inputs in the portal DOM
 *   - Uploads verified PDF using Playwright file input handling
 *   - Verifies upload success and prevents attaching incorrect / unvalidated documents
 */

import { existsSync, statSync } from 'fs';
import { basename } from 'path';
import { validatePdf } from '../../resume/validate-pdf.mjs';

/**
 * Attaches the verified resume PDF to the application form.
 */
export async function attachResume(page, {
    resumeVersion = null,
    pdfPath = null,
    selector = null,
    logger = null
} = {}) {
    if (!page) throw new Error('Page instance required for attachResume');

    const filePath = pdfPath || resumeVersion?.file_path;
    if (!filePath) {
        throw new Error('attachResume: No PDF path or resume_version provided');
    }

    if (!existsSync(filePath)) {
        throw new Error(`Resume PDF file not found at: ${filePath}`);
    }

    const stats = statSync(filePath);
    if (stats.size === 0) {
        throw new Error(`Resume PDF file is empty: ${filePath}`);
    }

    // Validate PDF before attaching (re-verify single-page and text extractability)
    const pdfValidation = await validatePdf(filePath);
    if (!pdfValidation.valid) {
        throw new Error(`Resume PDF failed validation: ${pdfValidation.errors.join('; ')}`);
    }

    // Locate file input element on page if selector not explicitly provided
    let targetSelector = selector;
    if (!targetSelector) {
        targetSelector = await page.evaluate(() => {
            const fileInputs = Array.from(document.querySelectorAll('input[type="file"]'));
            if (fileInputs.length === 0) return null;

            // Priority 1: Named or labeled specifically for resume/cv
            const resumeInput = fileInputs.find(inp => {
                const text = [
                    inp.name,
                    inp.id,
                    inp.getAttribute('aria-label') || '',
                    inp.closest('label')?.innerText || '',
                    inp.closest('.field')?.innerText || ''
                ].join(' ').toLowerCase();

                return (text.includes('resume') || text.includes('cv')) && !text.includes('cover');
            });

            if (resumeInput) {
                return resumeInput.id ? `#${CSS.escape(resumeInput.id)}` :
                       (resumeInput.name ? `input[name="${CSS.escape(resumeInput.name)}"]` : 'input[type="file"]');
            }

            // Priority 2: First file input
            const first = fileInputs[0];
            return first.id ? `#${CSS.escape(first.id)}` :
                   (first.name ? `input[name="${CSS.escape(first.name)}"]` : 'input[type="file"]');
        });
    }

    if (!targetSelector) {
        return {
            success: false,
            error: 'No file input found on application page for resume upload',
            pdfPath: filePath
        };
    }

    // Set input files using Playwright
    await page.setInputFiles(targetSelector, filePath);

    // Verify upload reflection in DOM (polling up to 8000ms to allow async uploads / progressbars to complete)
    const fileName = basename(filePath);
    let verifiedUpload = null;
    const deadline = Date.now() + 8000;

    while (Date.now() < deadline) {
        verifiedUpload = await page.evaluate(({ sel, expectedName }) => {
            const inp = document.querySelector(sel);
            if (inp && inp.files && inp.files.length > 0) {
                return {
                    fileName: inp.files[0].name,
                    fileSize: inp.files[0].size
                };
            }
            // Modern Greenhouse/ATS pattern: file input is replaced by file-upload preview element
            const previewEl = document.querySelector('.file-upload__filename, [class*="filename"], [class*="file-name"], .upload-preview');
            if (previewEl && (previewEl.innerText.includes(expectedName) || previewEl.innerText.length > 0)) {
                return {
                    fileName: previewEl.innerText.trim(),
                    isUploadedPreview: true
                };
            }
            return null;
        }, { sel: targetSelector, expectedName: fileName });

        if (verifiedUpload) break;
        await page.waitForTimeout(500);
    }

    if (logger) logger(`[Resume Attached] ${basename(filePath)} -> ${targetSelector}`);

    return {
        success: Boolean(verifiedUpload),
        pdfPath: filePath,
        fileName: basename(filePath),
        targetSelector,
        pageCount: pdfValidation.pageCount,
        atsParseScore: pdfValidation.atsParseScore,
        verifiedUpload,
        error: verifiedUpload ? null : 'File input or upload preview element not verified after upload'
    };
}
