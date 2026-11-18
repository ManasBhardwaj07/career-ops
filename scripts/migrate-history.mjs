#!/usr/bin/env node

/**
 * scripts/migrate-history.mjs — Reconcile historical TSV and Markdown data into SQLite
 *
 * Imports:
 *   - data/scan-history.tsv (1,100+ historical scans)
 *   - data/pipeline.md (URL inbox, pending and processed)
 *   - data/applications.md (Applications tracker)
 *
 * Idempotent: Can be run multiple times safely.
 */

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { getDb, closeDb, runInTransaction } from '../db/db.mjs';
import {
    upsertCompany,
    upsertJobPosting,
    upsertApplication,
    getApplication,
    getApplicationByJobId,
    logApplicationEvent,
    countJobs,
    countApplications
} from '../db/repo.mjs';

function slugify(name) {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function migrateHistory() {
    const db = getDb();
    console.log('Starting historical data migration to SQLite...\n');

    const countsBefore = {
        jobs: countJobs(),
        applications: countApplications(),
    };

    const stats = {
        tsv: { read: 0, imported: 0, skipped: 0, errors: 0 },
        pipeline: { read: 0, imported: 0, skipped: 0, errors: 0 },
        applications: { read: 0, imported: 0, errors: 0 },
        companiesCreated: new Set()
    };

    // ── 1. Import scan-history.tsv ───────────────────────────────────────
    const tsvPath = resolve('data', 'scan-history.tsv');
    if (existsSync(tsvPath)) {
        const content = readFileSync(tsvPath, 'utf-8');
        const lines = content.split('\n').filter(l => l.trim().length > 0);
        const header = lines[0].split('\t');
        console.log(`Processing ${lines.length - 1} records from scan-history.tsv...`);

        runInTransaction(() => {
            for (let i = 1; i < lines.length; i++) {
                stats.tsv.read++;
                const cols = lines[i].split('\t');
                if (cols.length < 5) {
                    stats.tsv.skipped++;
                    continue;
                }

                const url = cols[0].trim();
                const firstSeen = cols[1]?.trim() || new Date().toISOString();
                const portal = cols[2]?.trim() || 'unknown';
                const title = cols[3]?.trim();
                const companyName = cols[4]?.trim() || 'Unknown Company';
                const status = cols[5]?.trim() || 'discovered';

                if (!url || !title) {
                    stats.tsv.skipped++;
                    continue;
                }

                try {
                    const cid = `company-${slugify(companyName)}`;
                    upsertCompany({
                        id: cid,
                        name: companyName,
                        policy_status: 'permitted'
                    });
                    stats.companiesCreated.add(cid);

                    upsertJobPosting({
                        id: url,
                        company_id: cid,
                        title,
                        job_url: url,
                        source: portal,
                        discovered_at: firstSeen,
                        status: status === 'added' ? 'discovered' : status
                    });
                    stats.tsv.imported++;
                } catch (err) {
                    stats.tsv.errors++;
                    console.error(`Error importing TSV row ${i}: ${err.message}`);
                }
            }
        });
    } else {
        console.log('scan-history.tsv not found, skipping.');
    }

    // ── 2. Import pipeline.md ───────────────────────────────────────────
    const pipePath = resolve('data', 'pipeline.md');
    if (existsSync(pipePath)) {
        const content = readFileSync(pipePath, 'utf-8');
        const lines = content.split('\n');
        console.log(`Processing ${lines.length} lines from pipeline.md...`);

        runInTransaction(() => {
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed.startsWith('- [')) continue;
                stats.pipeline.read++;

                try {
                    // Pattern A: Pending: - [ ] URL | Company | Role
                    const pendingMatch = trimmed.match(/^- \[\s\]\s+(https?:\/\/[^\s|]+)\s*\|\s*([^|]+)\s*\|\s*(.+)$/);
                    if (pendingMatch) {
                        const url = pendingMatch[1].trim();
                        const companyName = pendingMatch[2].trim();
                        const title = pendingMatch[3].trim();
                        const cid = `company-${slugify(companyName)}`;

                        upsertCompany({
                            id: cid,
                            name: companyName,
                            policy_status: 'permitted'
                        });
                        stats.companiesCreated.add(cid);

                        upsertJobPosting({
                            id: url,
                            company_id: cid,
                            title,
                            job_url: url,
                            source: 'pipeline-pending',
                            status: 'discovered'
                        });
                        stats.pipeline.imported++;
                        continue;
                    }

                    // Pattern B: Processed: - [x] #NNN | URL | Company | Role | Score | ...
                    const processedMatch = trimmed.match(/^- \[x\]\s+(?:#\d+\s*\|\s*)?(https?:\/\/[^\s|]+)\s*\|\s*([^|]+)\s*\|\s*([^|]+)(?:\|\s*([^|]+))?/);
                    if (processedMatch) {
                        const url = processedMatch[1].trim();
                        const companyName = processedMatch[2].trim();
                        const title = processedMatch[3].trim();
                        const scoreStr = processedMatch[4]?.trim() || '';
                        const cid = `company-${slugify(companyName)}`;

                        upsertCompany({
                            id: cid,
                            name: companyName,
                            policy_status: 'permitted'
                        });
                        stats.companiesCreated.add(cid);

                        upsertJobPosting({
                            id: url,
                            company_id: cid,
                            title,
                            job_url: url,
                            source: 'pipeline-processed',
                            status: 'evaluated'
                        });

                        const scoreVal = parseFloat(scoreStr.replace(/\/5/, ''));
                        if (!isNaN(scoreVal)) {
                            const appId = `app_pipe_${slugify(companyName)}_${slugify(title)}`.substring(0, 50);
                            upsertApplication({
                                id: appId,
                                job_id: url,
                                company_id: cid,
                                state: 'EVALUATED',
                                score: scoreVal,
                                notes: `Imported from pipeline.md (${scoreStr})`
                            });
                        }
                        stats.pipeline.imported++;
                        continue;
                    }

                    stats.pipeline.skipped++;
                } catch (err) {
                    stats.pipeline.errors++;
                    console.error(`Error importing pipeline line: ${err.message}`);
                }
            }
        });
    } else {
        console.log('pipeline.md not found, skipping.');
    }

    // ── 3. Import applications.md ───────────────────────────────────────
    const appPath = resolve('data', 'applications.md');
    if (existsSync(appPath)) {
        const content = readFileSync(appPath, 'utf-8');
        const lines = content.split('\n');
        console.log(`Processing applications.md entries...`);

        runInTransaction(() => {
            for (const line of lines) {
                const trimmed = line.trim();
                // Match markdown table row: | 001 | 2026-05-02 | Fello | MERN Developer | 4.6/5 | Evaluated | ✅ | [001](reports/fello-mern-developer.md) | ...
                if (!trimmed.startsWith('|') || trimmed.includes('| # |') || trimmed.includes('|---|')) continue;

                const cols = trimmed.split('|').map(c => c.trim()).filter((_, idx, arr) => idx > 0 && idx < arr.length - 1);
                if (cols.length < 6) continue;

                stats.applications.read++;
                const appNum = cols[0];
                const date = cols[1];
                const companyName = cols[2];
                const role = cols[3];
                const scoreRaw = cols[4];
                const status = cols[5];
                const reportCell = cols[7] || '';
                const notes = cols[8] || '';

                const score = parseFloat(scoreRaw.replace(/\/5/, '')) || null;
                const cid = `company-${slugify(companyName)}`;
                const reportPathMatch = reportCell.match(/\(([^)]+)\)/);
                const reportPath = reportPathMatch ? reportPathMatch[1] : null;

                // Inspect report for exact URL if available
                let jobUrl = `https://${slugify(companyName)}.careers/${slugify(role)}`;
                if (reportPath && existsSync(reportPath)) {
                    const repContent = readFileSync(reportPath, 'utf-8');
                    const urlMatch = repContent.match(/\*\*URL:\*\*\s*(https?:\/\/[^\s\n]+)/);
                    if (urlMatch) {
                        jobUrl = urlMatch[1].trim();
                    }
                }

                upsertCompany({
                    id: cid,
                    name: companyName,
                    policy_status: 'permitted'
                });
                stats.companiesCreated.add(cid);

                upsertJobPosting({
                    id: jobUrl,
                    company_id: cid,
                    title: role,
                    job_url: jobUrl,
                    source: 'applications.md',
                    discovered_at: date,
                    status: status.toLowerCase()
                });

                const existingApp = getApplicationByJobId(jobUrl);
                let appId = existingApp ? existingApp.id : `app_${appNum.padStart(3, '0')}`;
                const existingWithId = getApplication(appId);
                if (existingWithId && existingWithId.job_id !== jobUrl) {
                    appId = `app_${appNum.padStart(3, '0')}_${slugify(companyName)}`;
                }
                upsertApplication({
                    id: appId,
                    job_id: jobUrl,
                    company_id: cid,
                    state: status.toUpperCase(),
                    score,
                    notes,
                    report_path: reportPath,
                    started_at: date
                });

                // ON CONFLICT(job_id) preserves the existing row's primary key id
                const persistedApp = getApplicationByJobId(jobUrl);
                const resolvedAppId = persistedApp ? persistedApp.id : appId;

                logApplicationEvent({
                    application_id: resolvedAppId,
                    new_state: status.toUpperCase(),
                    event_type: 'historical_import',
                    message: `Imported from applications.md (#${appNum})`
                });

                stats.applications.imported++;
            }
        });
    }

    const countsAfter = {
        jobs: countJobs(),
        applications: countApplications(),
    };

    console.log('\n==================================================');
    console.log('📊 Historical Migration Reconciliation Report');
    console.log('==================================================');
    console.log(`Companies Registered:      ${stats.companiesCreated.size}`);
    console.log(`TSV Rows Read:             ${stats.tsv.read}`);
    console.log(`TSV Jobs Imported:         ${stats.tsv.imported}`);
    console.log(`Pipeline Lines Parsed:     ${stats.pipeline.read}`);
    console.log(`Pipeline Jobs Imported:    ${stats.pipeline.imported}`);
    console.log(`Applications Tracker Apps: ${stats.applications.imported}`);
    console.log(`--------------------------------------------------`);
    console.log(`Total Jobs in DB:          Before: ${countsBefore.jobs} -> After: ${countsAfter.jobs}`);
    console.log(`Total Applications in DB:  Before: ${countsBefore.applications} -> After: ${countsAfter.applications}`);
    console.log('==================================================\n');

    closeDb();
    return { stats, countsBefore, countsAfter };
}

if (process.argv[1]?.endsWith('migrate-history.mjs')) {
    migrateHistory();
}
