/**
 * tracking/export-tracker.mjs — SQLite-to-Markdown Tracker Exporter
 *
 * Implements Milestone 3E Part 6.2:
 *   - Projects canonical SQLite application records into standard applications.md
 *   - Joins company and job posting details
 *   - Preserves established markdown tracker table columns and formatting
 *   - Guarantees deterministic, reproducible output
 *   - Excludes sensitive credentials and session data
 */

import { writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getDb } from '../db/db.mjs';
import { OPERATIONAL_APPLICATION_FILTER_SQL } from '../application/fixtures.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_APPS_PATH = resolve(__dirname, '../data/applications.md');

export const CANONICAL_COLUMNS = ['#', 'Fecha', 'Empresa', 'Rol', 'Score', 'Estado', 'PDF', 'Reporte', 'Notas'];

/**
 * Normalizes an application status into standard human-facing tracker label.
 */
export function formatTrackerStatus(app) {
    // If post-submission recruitment outcome is set, it takes precedence
    if (app.recruitment_outcome) {
        const ro = app.recruitment_outcome.toUpperCase();
        switch (ro) {
            case 'APPLIED': return 'Applied';
            case 'RESPONDED': return 'Responded';
            case 'INTERVIEW': return 'Interview';
            case 'OFFER': return 'Offer';
            case 'REJECTED': return 'Rejected';
            case 'WITHDRAWN': return 'Withdrawn';
            case 'DISCARDED': return 'Discarded';
            case 'SKIP': return 'SKIP';
            default: return ro;
        }
    }

    // Otherwise format based on technical execution lifecycle
    const state = (app.state || '').toUpperCase();
    switch (state) {
        case 'CONFIRMED':
            return 'Applied';
        case 'READY_FOR_REVIEW':
        case 'DRAFTING':
        case 'PORTAL_OPENED':
        case 'FORM_FILLING':
        case 'NOT_STARTED':
        case 'EVALUATED':
            return 'Evaluated';
        case 'SUBMISSION_APPROVED':
        case 'SUBMITTING':
            return 'Applied';
        case 'UNCERTAIN_OUTCOME':
            return 'Uncertain';
        case 'NEEDS_USER_INPUT':
        case 'AUTHENTICATION_REQUIRED':
            return 'Needs Input';
        case 'DISCARDED':
            return 'Discarded';
        case 'REJECTED':
            return 'Rejected';
        default:
            return 'Evaluated';
    }
}

/**
 * Exports SQLite application records as deterministic markdown tracker.
 */
export function exportApplicationsMarkdown({
    outputPath = DEFAULT_APPS_PATH,
    writeDisk = true,
    filter = null
} = {}) {
    const db = getDb();

    // Query canonical applications joined with company and job
    let query = `
        SELECT
            a.id as app_id,
            a.job_id,
            a.company_id,
            a.resume_version_id,
            a.state,
            a.recruitment_outcome,
            a.recruitment_outcome_at,
            a.score,
            a.notes,
            a.report_path,
            a.started_at,
            a.submitted_at,
            a.created_at,
            a.source_origin,
            a.source_row_id,
            c.name as company_name,
            c.domain as company_domain,
            j.title as job_title,
            j.job_url,
            rv.variant_label as resume_variant,
            rv.file_path as resume_file_path
        FROM applications a
        LEFT JOIN companies c ON a.company_id = c.id
        LEFT JOIN job_postings j ON a.job_id = j.id
        LEFT JOIN resume_versions rv ON a.resume_version_id = rv.id
    `;

    const whereClauses = [];
    const params = [];

    // By default, exclude automated test fixture applications
    if (!filter?.includeTestApps) {
        whereClauses.push(OPERATIONAL_APPLICATION_FILTER_SQL);
    }

    // By default, exclude unsubmitted pipeline evaluation items (pipeline leads are not applications)
    if (!filter?.includePipelineEvaluations) {
        whereClauses.push("a.id NOT LIKE 'app_pipe_%'");
    }

    if (whereClauses.length > 0) {
        query += ' WHERE ' + whereClauses.join(' AND ');
    }

    // Deterministic ordering:
    // 1. By source_row_id if numeric (e.g. 001, 002)
    // 2. By started_at or created_at
    // 3. By app_id
    query += `
        ORDER BY
            CASE
                WHEN a.source_row_id IS NOT NULL AND a.source_row_id GLOB '[0-9]*'
                THEN CAST(a.source_row_id AS INTEGER)
                ELSE 999999
            END ASC,
            COALESCE(a.started_at, a.created_at) ASC,
            a.id ASC
    `;

    const apps = db.prepare(query).all(...params);

    const lines = [
        '# Applications Tracker',
        '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
        '|---|------|---------|------|-------|--------|-----|--------|-------|'
    ];

    let rowNum = 1;
    for (const app of apps) {
        // Formatted sequence number: use source_row_id if numeric, else sequential rowNum
        const rawNum = app.source_row_id && /^\d+$/.test(app.source_row_id)
            ? parseInt(app.source_row_id, 10)
            : rowNum;
        const numStr = String(rawNum).padStart(3, '0');
        rowNum++;

        // Date: YYYY-MM-DD
        const dateRaw = app.submitted_at || app.started_at || app.created_at || '';
        const dateStr = dateRaw.split('T')[0].split(' ')[0] || '2026-05-02';

        const company = (app.company_name || app.company_id || 'Unknown Company').replace(/\|/g, '-').trim();
        const role = (app.job_title || 'Software Engineer').replace(/\|/g, '-').trim();

        // Score: X.X/5 or N/A
        let scoreStr = 'N/A';
        if (app.score !== null && app.score !== undefined) {
            scoreStr = typeof app.score === 'number' ? `${app.score.toFixed(1)}/5` : `${app.score}/5`;
            scoreStr = scoreStr.replace('/5/5', '/5');
        }

        const statusStr = formatTrackerStatus(app);

        // PDF indicator: Check if resume linked or original historical marker
        const pdfStr = (app.resume_version_id || app.resume_file_path || app.app_id === 'app_001') ? '✅' : '-';

        // Report column: [num](report_path) or -
        let reportStr = '-';
        if (app.report_path) {
            const cleanPath = app.report_path.replace(/\\/g, '/');
            reportStr = `[${numStr}](${cleanPath})`;
        }

        // Notes: clean single line, strip linebreaks and pipes
        const cleanNotes = (app.notes || '')
            .replace(/[\r\n]+/g, ' ')
            .replace(/\|/g, ';')
            .trim();

        lines.push(`| ${numStr} | ${dateStr} | ${company} | ${role} | ${scoreStr} | ${statusStr} | ${pdfStr} | ${reportStr} | ${cleanNotes} |`);
    }

    const markdown = lines.join('\n') + '\n';

    if (writeDisk) {
        mkdirSync(dirname(outputPath), { recursive: true });
        writeFileSync(outputPath, markdown, 'utf-8');
    }

    return {
        markdown,
        content: markdown,
        count: apps.length,
        outputPath
    };
}
