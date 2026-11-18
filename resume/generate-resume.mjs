/**
 * resume/generate-resume.mjs — Evidence-Grounded Resume PDF Generation Engine
 *
 * Implements Part 5 of Milestone 3C:
 * 1. Checks for reusable variants or determines justified tailoring
 * 2. Builds safe HTML document with verified facts and evidence
 * 3. Saves intermediate HTML artifact
 * 4. Renders PDF via Playwright Chromium headless with Space Grotesk fonts
 * 5. Validates PDF layout, page budget, and text extractability
 * 6. Records immutable document record into SQLite resume_versions
 */

import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';
import { insertResumeVersion, getJob } from '../db/repo.mjs';
import { buildResumeHtml } from './populate-template.mjs';
import { checkResumeReuse, RESUME_VARIANTS, determineVariant } from './select-variant.mjs';
import { validatePdf } from './validate-pdf.mjs';
import { getResumeDestinationPath, generateLatexResume } from './generate-latex-resume.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUTPUT_DIR = resolve(__dirname, '../output/resumes');
const FONTS_DIR = resolve(__dirname, '../fonts');

/**
 * Normalizes text for ATS compatibility by replacing non-standard Unicode punctuation.
 */
function normalizeTextForATS(html) {
    const masks = [];
    const masked = html.replace(
        /<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi,
        (match) => {
            const token = `\u0000MASK${masks.length}\u0000`;
            masks.push(match);
            return token;
        }
    );

    let out = '';
    let i = 0;
    while (i < masked.length) {
        const lt = masked.indexOf('<', i);
        if (lt === -1) { out += sanitize(masked.slice(i)); break; }
        out += sanitize(masked.slice(i, lt));
        const gt = masked.indexOf('>', lt);
        if (gt === -1) { out += masked.slice(lt); break; }
        out += masked.slice(lt, gt + 1);
        i = gt + 1;
    }

    return out.replace(/\u0000MASK(\d+)\u0000/g, (_, n) => masks[Number(n)]);

    function sanitize(text) {
        if (!text) return text;
        return text
            .replace(/\u2014/g, '-')
            .replace(/\u2013/g, '-')
            .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
            .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
            .replace(/\u2026/g, '...')
            .replace(/[\u200B\u200C\u200D\u2060\uFEFF]/g, '')
            .replace(/\u00A0/g, ' ');
    }
}

/**
 * Generates an evidence-grounded resume in HTML and PDF formats.
 */
export async function generateResume(options = {}) {
    const {
        jobId = null,
        variantLabel = null,
        tailoringFactIds = null,
        outputDir = DEFAULT_OUTPUT_DIR,
        format = 'a4',
        dryRun = false,
        forceRegenerate = false,
        browserInstance = null
    } = options;

    mkdirSync(outputDir, { recursive: true });

    let job = null;
    if (jobId) {
        job = getJob(jobId);
    }

    const resolvedVariant = variantLabel || determineVariant(job);

    // 1. Check if an existing variant can be reused (avoid unnecessary tailoring)
    if (!forceRegenerate) {
        const reuseCheck = checkResumeReuse(jobId, resolvedVariant, { forceRegenerate });
        if (reuseCheck.reuse && reuseCheck.existingVersion) {
            const v = reuseCheck.existingVersion;
            return {
                resumeVersionId: v.id,
                jobId: v.job_id,
                variantLabel: v.variant_label,
                pdfPath: v.file_path,
                htmlPath: v.html_path,
                pageCount: v.page_count,
                tailored: Boolean(v.tailored),
                reusedExisting: true,
                dryRun,
                reason: reuseCheck.reason
            };
        }
    }

    // 2. Authoritative Engine: Evidence-Grounded LaTeX + Tectonic compilation (1-Page XeTeX)
    // Part H Requirement: One authoritative production generator, NO unvalidated fallback.
    const latexResult = await generateLatexResume({
        variantLabel: resolvedVariant,
        job,
        outputDir,
        dryRun
    });

    if (!latexResult.compiled) {
        throw new Error(`Authoritative LaTeX resume generation failed: ${latexResult.compileError || 'Unknown compilation error'}. Unvalidated fallback is strictly prohibited.`);
    }

    if (latexResult.validationResult && !latexResult.validationResult.valid) {
        const errorList = (latexResult.validationResult.errors || []).join('; ');
        throw new Error(`Authoritative LaTeX resume PDF validation failed: ${errorList}. Unvalidated resume attachment is strictly prohibited.`);
    }

    return {
        resumeVersionId: latexResult.resumeVersionId,
        jobId: latexResult.jobId,
        variantLabel: latexResult.variantLabel,
        pdfPath: latexResult.pdfPath,
        htmlPath: latexResult.texPath,
        texPath: latexResult.texPath,
        pageCount: latexResult.pageCount,
        sizeBytes: latexResult.validationResult?.fileSizeBytes || 0,
        tailored: true,
        factsUsed: latexResult.skillsAnalysis?.matchedSkills || [],
        evidenceUsed: latexResult.projectOrder || [],
        bulletsSelected: latexResult.selectedBullets || [],
        validationResult: latexResult.validationResult,
        reusedExisting: false,
        dryRun
    };
}
