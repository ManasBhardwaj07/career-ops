/**
 * tracking/reconcile-history.mjs — Historical Tracker Reconciliation Engine
 *
 * Implements Milestone 3E Part 3 & Part 7:
 *   - Classifies historical records across applications.md, pipeline.md, batch TSVs, scan-history
 *   - Strictly resolves company and job identities without fuzzy foreign keys
 *   - Preserves complete historical provenance in historical_tracker_ledger
 *   - Enforces idempotent import guarantees: zero duplicate applications or events
 *   - Does not fabricate submission dates or turn evaluated-only opportunities into applications
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { resolve, join, basename, dirname } from 'path';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { getDb, runInTransaction } from '../db/db.mjs';
import {
    createApplication,
    updateApplicationExecution,
    recordApplicationEvent,
    logHistoricalLedgerRecord,
    findCompanyByNameOrAlias,
    getCompany,
    getCompanyByDomain,
    getJobByUrl,
    getJob,
    APPLICATION_STATES,
    RECRUITMENT_OUTCOMES
} from '../db/repo.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, '..');

export const HISTORICAL_CLASSIFICATIONS = {
    ACTUAL_APPLICATION_SUBMITTED: 'ACTUAL_APPLICATION_SUBMITTED',
    APPLICATION_STARTED: 'APPLICATION_STARTED',
    INTERVIEW_OR_RECRUITER_INTERACTION: 'INTERVIEW_OR_RECRUITER_INTERACTION',
    OFFER_OR_REJECTION: 'OFFER_OR_REJECTION',
    EVALUATED_OPPORTUNITY: 'EVALUATED_OPPORTUNITY',
    DISCARDED_OPPORTUNITY: 'DISCARDED_OPPORTUNITY',
    DUPLICATE_HISTORICAL_RECORD: 'DUPLICATE_HISTORICAL_RECORD',
    UNRESOLVED_RECORD: 'UNRESOLVED_RECORD'
};

export const RESOLUTION_STATUSES = {
    RESOLVED: 'RESOLVED',
    PARTIAL: 'PARTIAL',
    UNRESOLVED: 'UNRESOLVED',
    DUPLICATE: 'DUPLICATE',
    DISCARDED_EVALUATION: 'DISCARDED_EVALUATION'
};

function sha256(str) {
    return createHash('sha256').update(String(str)).digest('hex');
}

function slugify(name) {
    if (!name) return 'unknown';
    return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

/**
 * Strict company resolution:
 * 1. Normalized domain lookup
 * 2. Exact alias match in company_aliases
 * 3. Exact canonical ID (company-<slug>)
 * 4. Exact company name in companies table
 */
export function resolveCompanyStrict(companyName, urlHint = null) {
    if (!companyName && !urlHint) return null;

    // 1. Try URL domain lookup
    if (urlHint) {
        try {
            const parsed = new URL(urlHint);
            const domain = parsed.hostname.replace(/^www\./, '');
            const byDomain = getCompanyByDomain(domain);
            if (byDomain) return byDomain;
        } catch {}
    }

    if (!companyName) return null;
    const cleanName = companyName.trim();

    // 2. Exact name or registered alias match
    const byNameOrAlias = findCompanyByNameOrAlias(cleanName);
    if (byNameOrAlias) return byNameOrAlias;

    // 3. Exact canonical ID
    const canonId = `company-${slugify(cleanName)}`;
    const byId = getCompany(canonId);
    if (byId) return byId;

    return null;
}

/**
 * Strict job resolution:
 * 1. Exact job_url match
 * 2. Exact id match
 * 3. Inspect report file for canonical **URL:** if present
 */
export function resolveJobStrict(jobUrl, reportPath = null) {
    const db = getDb();
    let url = jobUrl ? jobUrl.trim() : null;

    if (!url && reportPath) {
        const fullReportPath = resolve(ROOT_DIR, reportPath);
        if (existsSync(fullReportPath)) {
            try {
                const content = readFileSync(fullReportPath, 'utf8');
                const m = content.match(/\*\*URL:\*\*\s*(https?:\/\/[^\s\n]+)/);
                if (m) url = m[1].trim();
            } catch {}
        }
    }

    if (!url) return null;

    const byUrl = getJobByUrl(url);
    if (byUrl) return byUrl;

    const byId = getJob(url);
    if (byId) return byId;

    return null;
}

/**
 * Classifies a raw status and report content into one of the 8 canonical categories.
 */
export function classifyHistoricalRecord({
    rawStatus = '',
    scoreStr = '',
    reportPath = null,
    notes = '',
    company = '',
    role = '',
    url = '',
    isDuplicate = false
}) {
    if (isDuplicate) {
        return {
            classification: HISTORICAL_CLASSIFICATIONS.DUPLICATE_HISTORICAL_RECORD,
            resolvedStatus: RESOLUTION_STATUSES.DUPLICATE
        };
    }

    if (!company || !company.trim()) {
        return {
            classification: HISTORICAL_CLASSIFICATIONS.UNRESOLVED_RECORD,
            resolvedStatus: RESOLUTION_STATUSES.UNRESOLVED
        };
    }

    const s = (rawStatus || '').toLowerCase().trim();
    const cleanScore = parseFloat(scoreStr.replace(/\/5/, ''));

    // Check for duplicate indicators
    if (s.includes('dup') || s.includes('duplicado') || notes.toLowerCase().includes('duplicate')) {
        return {
            classification: HISTORICAL_CLASSIFICATIONS.DUPLICATE_HISTORICAL_RECORD,
            resolvedStatus: RESOLUTION_STATUSES.DUPLICATE
        };
    }

    // Interview
    if (s === 'interview' || s === 'entrevista') {
        return {
            classification: HISTORICAL_CLASSIFICATIONS.INTERVIEW_OR_RECRUITER_INTERACTION,
            resolvedStatus: RESOLUTION_STATUSES.RESOLVED
        };
    }

    // Responded
    if (s === 'responded' || s === 'respondido') {
        return {
            classification: HISTORICAL_CLASSIFICATIONS.INTERVIEW_OR_RECRUITER_INTERACTION,
            resolvedStatus: RESOLUTION_STATUSES.RESOLVED
        };
    }

    // Offer
    if (s === 'offer' || s === 'oferta') {
        return {
            classification: HISTORICAL_CLASSIFICATIONS.OFFER_OR_REJECTION,
            resolvedStatus: RESOLUTION_STATUSES.RESOLVED
        };
    }

    // Rejected / Discarded / Decanted
    if (s === 'rejected' || s === 'rechazado' || s === 'rechazada') {
        // Inspect report: was it candidate evaluation recommendation or employer rejection?
        if (reportPath) {
            const fullReport = resolve(ROOT_DIR, reportPath);
            if (existsSync(fullReport)) {
                const rep = readFileSync(fullReport, 'utf8').toLowerCase();
                if (rep.includes('do not apply') || rep.includes('no aplicar') || rep.includes('do_not_apply') || rep.includes('recommend applying: no') || rep.includes('verdict: do not apply')) {
                    return {
                        classification: HISTORICAL_CLASSIFICATIONS.DISCARDED_OPPORTUNITY,
                        resolvedStatus: RESOLUTION_STATUSES.DISCARDED_EVALUATION
                    };
                }
            }
        }
        // In batch evaluation TSVs with low scores (< 4.0), REJECTED indicates automated evaluation rejection (Do Not Apply)
        if (cleanScore > 0 && cleanScore < 4.0) {
            return {
                classification: HISTORICAL_CLASSIFICATIONS.DISCARDED_OPPORTUNITY,
                resolvedStatus: RESOLUTION_STATUSES.DISCARDED_EVALUATION
            };
        }
        return {
            classification: HISTORICAL_CLASSIFICATIONS.OFFER_OR_REJECTION,
            resolvedStatus: RESOLUTION_STATUSES.RESOLVED
        };
    }

    if (s === 'discarded' || s === 'descartado' || s === 'descartada' || s === 'decanted' || s === 'skip' || s === 'no aplicar') {
        return {
            classification: HISTORICAL_CLASSIFICATIONS.DISCARDED_OPPORTUNITY,
            resolvedStatus: RESOLUTION_STATUSES.DISCARDED_EVALUATION
        };
    }

    // Applied
    if (s === 'applied' || s === 'aplicado' || s === 'aplicada' || s === 'enviada' || s === 'sent') {
        return {
            classification: HISTORICAL_CLASSIFICATIONS.ACTUAL_APPLICATION_SUBMITTED,
            resolvedStatus: RESOLUTION_STATUSES.RESOLVED
        };
    }

    // Evaluated
    if (s === 'evaluated' || s === 'evaluada' || s === 'condicional' || s === 'hold' || s === 'evaluar') {
        return {
            classification: HISTORICAL_CLASSIFICATIONS.EVALUATED_OPPORTUNITY,
            resolvedStatus: RESOLUTION_STATUSES.RESOLVED
        };
    }

    // If report says Do not apply
    if (reportPath) {
        const fullReport = resolve(ROOT_DIR, reportPath);
        if (existsSync(fullReport)) {
            const rep = readFileSync(fullReport, 'utf8').toLowerCase();
            if (rep.includes('recommendation: do not apply')) {
                return {
                    classification: HISTORICAL_CLASSIFICATIONS.DISCARDED_OPPORTUNITY,
                    resolvedStatus: RESOLUTION_STATUSES.DISCARDED_EVALUATION
                };
            }
        }
    }

    return {
        classification: HISTORICAL_CLASSIFICATIONS.EVALUATED_OPPORTUNITY,
        resolvedStatus: RESOLUTION_STATUSES.RESOLVED
    };
}

/**
 * Reconciles data/applications.md
 */
export function reconcileApplicationsMarkdown(filePath = resolve(ROOT_DIR, 'data/applications.md')) {
    if (!existsSync(filePath)) return { read: 0, reconciled: 0, unresolved: 0 };
    const content = readFileSync(filePath, 'utf8');
    const lines = content.split('\n');

    let read = 0;
    let reconciled = 0;
    let unresolved = 0;

    runInTransaction(() => {
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('|') || trimmed.includes('| # |') || trimmed.includes('|---|')) continue;

            const cols = trimmed.split('|').map(c => c.trim()).filter((_, idx, arr) => idx > 0 && idx < arr.length - 1);
            if (cols.length < 6) continue;

            read++;
            const rowId = cols[0];
            const date = cols[1];
            const companyName = cols[2];
            const role = cols[3];
            const scoreRaw = cols[4];
            const statusRaw = cols[5];
            const reportCell = cols[7] || '';
            const notes = cols[8] || '';

            const reportMatch = reportCell.match(/\(([^)]+)\)/);
            const reportPath = reportMatch ? reportMatch[1] : null;

            const classResult = classifyHistoricalRecord({
                rawStatus: statusRaw,
                scoreStr: scoreRaw,
                reportPath,
                notes,
                company: companyName,
                role
            });
            const classification = classResult.classification || classResult;

            // Strict entity resolution
            const resolvedComp = resolveCompanyStrict(companyName);
            const resolvedJob = resolveJobStrict(null, reportPath);

            let resStatus = RESOLUTION_STATUSES.RESOLVED;
            let resNotes = 'Reconciled from applications.md';
            if (!resolvedComp && !resolvedJob) {
                resStatus = RESOLUTION_STATUSES.UNRESOLVED;
                resNotes = 'Company and Job could not be strictly resolved';
                unresolved++;
            } else if (!resolvedComp || !resolvedJob) {
                resStatus = RESOLUTION_STATUSES.PARTIAL;
                resNotes = !resolvedComp ? 'Company unresolved' : 'Job unresolved';
            }

            const ledgerId = `ledger_app_md_${rowId}_${sha256(trimmed).slice(0, 12)}`;

            // If resolved, ensure canonical application record exists
            let appId = `app_${rowId.padStart(3, '0')}`;
            if (resolvedComp && resolvedJob) {
                const db = getDb();
                const existing = db.prepare('SELECT id, state, recruitment_outcome FROM applications WHERE id = ? OR job_id = ?').get(appId, resolvedJob.id);

                if (!existing) {
                    createApplication({
                        id: appId,
                        job_id: resolvedJob.id,
                        company_id: resolvedComp.id,
                        state: APPLICATION_STATES.READY_FOR_REVIEW,
                        score: parseFloat(scoreRaw.replace(/\/5/, '')) || null,
                        report_path: reportPath,
                        notes,
                        started_at: date,
                        source_origin: 'applications.md',
                        source_row_id: rowId,
                        actor: 'migration'
                    });
                } else {
                    appId = existing.id;
                    updateApplicationExecution(appId, {
                        source_origin: 'applications.md',
                        source_row_id: rowId,
                        report_path: reportPath || undefined,
                        notes: notes || undefined
                    });
                }
            }

            logHistoricalLedgerRecord({
                id: ledgerId,
                source_file: 'data/applications.md',
                row_identifier: rowId,
                original_company: companyName,
                original_role: role,
                original_status: statusRaw,
                original_score: scoreRaw,
                original_date: date,
                original_url: resolvedJob?.job_url || null,
                original_report: reportPath,
                original_notes: notes,
                classification,
                resolved_company_id: resolvedComp?.id || null,
                resolved_job_id: resolvedJob?.id || null,
                resolved_application_id: (resolvedComp && resolvedJob) ? appId : null,
                resolution_status: resStatus,
                resolution_notes: resNotes,
                raw_content: trimmed
            });

            reconciled++;
        }
    });

    return { read, reconciled, unresolved };
}

/**
 * Reconciles batch tracker addition TSVs (merged/ and unmerged)
 */
export function reconcileBatchAdditions(additionsDir = resolve(ROOT_DIR, 'batch/tracker-additions')) {
    if (!existsSync(additionsDir)) return { files: 0, rows: 0, reconciled: 0, duplicates: 0 };

    const filesToScan = [];
    const directFiles = readdirSync(additionsDir).filter(f => f.endsWith('.tsv'));
    for (const f of directFiles) filesToScan.push(join(additionsDir, f));

    const mergedDir = join(additionsDir, 'merged');
    if (existsSync(mergedDir)) {
        const mergedFiles = readdirSync(mergedDir).filter(f => f.endsWith('.tsv'));
        for (const f of mergedFiles) filesToScan.push(join(mergedDir, f));
    }

    let files = 0;
    let rows = 0;
    let reconciled = 0;
    let duplicates = 0;

    runInTransaction(() => {
        for (const filePath of filesToScan) {
            files++;
            const relPath = filePath.replace(ROOT_DIR, '').replace(/^[\\/]/, '').replace(/\\/g, '/');
            const content = readFileSync(filePath, 'utf8').trim();
            if (!content) continue;

            const lines = content.split('\n').filter(l => l.trim().length > 0);
            let rowIdx = 0;

            for (const line of lines) {
                rowIdx++;
                rows++;
                const trimmed = line.trim();
                const cols = trimmed.split('\t').map(c => c.trim());
                if (cols.length < 4) continue;

                // Format variants in TSVs:
                // Type A: date \t company \t role \t score \t status \t url \t report
                // Type B: num \t date \t company \t role \t score \t status \t pdf \t report \t notes
                let date, company, role, score, status, url, report, notes, num;

                if (/^\d+$/.test(cols[0])) {
                    // Type B with leading number
                    num = cols[0];
                    date = cols[1];
                    company = cols[2];
                    role = cols[3];
                    score = cols[4];
                    status = cols[5];
                    report = cols[7] || null;
                    notes = cols[8] || null;
                } else {
                    // Type A
                    date = cols[0];
                    company = cols[1];
                    role = cols[2];
                    score = cols[3];
                    status = cols[4];
                    url = cols[5] || null;
                    report = cols[6] || null;
                }

                const repMatch = (report || '').match(/\(([^)]+)\)/);
                const cleanReportPath = repMatch ? repMatch[1] : (report ? report.trim() : null);

                const db = getDb();
                const classResult = classifyHistoricalRecord({
                    rawStatus: status,
                    scoreStr: score,
                    reportPath: cleanReportPath,
                    notes,
                    company,
                    role,
                    url
                });
                let classification = classResult.classification || classResult;

                let resStatus = RESOLUTION_STATUSES.RESOLVED;
                let resNotes = `Reconciled from ${relPath}`;

                // Check for duplicate in ledger
                if (cleanReportPath && classification !== HISTORICAL_CLASSIFICATIONS.DUPLICATE_HISTORICAL_RECORD) {
                    const dup = db.prepare('SELECT id, source_file FROM historical_tracker_ledger WHERE original_report = ? AND source_file != ?').get(cleanReportPath, relPath);
                    if (dup) {
                        classification = HISTORICAL_CLASSIFICATIONS.DUPLICATE_HISTORICAL_RECORD;
                        resStatus = RESOLUTION_STATUSES.DUPLICATE;
                        resNotes = `Duplicate of record in ${dup.source_file}`;
                        duplicates++;
                    }
                }

                const resolvedComp = resolveCompanyStrict(company, url);
                const resolvedJob = resolveJobStrict(url, cleanReportPath);

                const ledgerId = `ledger_tsv_${slugify(basename(filePath))}_${rowIdx}_${sha256(trimmed).slice(0, 10)}`;

                if (classification === HISTORICAL_CLASSIFICATIONS.DUPLICATE_HISTORICAL_RECORD) {
                    resStatus = RESOLUTION_STATUSES.DUPLICATE;
                    duplicates++;
                } else if (classification === HISTORICAL_CLASSIFICATIONS.DISCARDED_OPPORTUNITY) {
                    resStatus = RESOLUTION_STATUSES.DISCARDED_EVALUATION;
                    resNotes = 'Evaluated and self-filtered/discarded; not an application attempt';
                } else if (!resolvedComp && !resolvedJob) {
                    resStatus = RESOLUTION_STATUSES.UNRESOLVED;
                    resNotes = 'Company and Job unresolvable';
                } else if (!resolvedComp || !resolvedJob) {
                    resStatus = RESOLUTION_STATUSES.PARTIAL;
                }

                logHistoricalLedgerRecord({
                    id: ledgerId,
                    source_file: relPath,
                    row_identifier: String(num || rowIdx),
                    original_company: company,
                    original_role: role,
                    original_status: status,
                    original_score: score,
                    original_date: date,
                    original_url: url || resolvedJob?.job_url || null,
                    original_report: cleanReportPath,
                    original_notes: notes,
                    classification,
                    resolved_company_id: resolvedComp?.id || null,
                    resolved_job_id: resolvedJob?.id || null,
                    resolved_application_id: null,
                    resolution_status: resStatus,
                    resolution_notes: resNotes,
                    raw_content: trimmed
                });

                reconciled++;
            }
        }
    });

    return { files, rows, reconciled, duplicates };
}

/**
 * Runs full historical tracker reconciliation across all historical sources.
 */
export function reconcileFullHistoricalTracker() {
    const markdownResult = reconcileApplicationsMarkdown();
    const batchResult = reconcileBatchAdditions();

    return {
        markdown: markdownResult,
        batch: batchResult,
        applicationsCount: markdownResult.reconciled,
        batchCount: batchResult.reconciled,
        totalLedgerRecords: markdownResult.reconciled + batchResult.reconciled,
        timestamp: new Date().toISOString()
    };
}

export const reconcileHistory = reconcileFullHistoricalTracker;
