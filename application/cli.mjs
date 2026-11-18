#!/usr/bin/env node

/**
 * application/cli.mjs — Application Execution CLI
 *
 * Implements Milestone 3D Part 14:
 *   - Practical CLI commands for applying, reviewing, approving, and reconciling
 *   - Interactive confirmations and transparent packet presentation
 */

import { createHash } from 'crypto';
import { readFileSync, existsSync } from 'fs';
import { runApplicationWorkflow, resumeApplicationWorkflow } from './apply.mjs';
import { recordUserAnswer } from './autofill/answer-mapper.mjs';
import { computeApplicationPayloadDigest } from './submission/policy.mjs';
import { isSyntheticApplication } from './fixtures.mjs';
import {
    getApplication,
    getAllApplications,
    createSubmissionAuthorization,
    getValidSubmissionAuthorization,
    APPLICATION_STATES
} from '../db/repo.mjs';
import { reconcileSubmissionOutcome } from './submission/reconcile-outcome.mjs';

function parseArgs(args) {
    const opts = {};
    for (let i = 0; i < args.length; i++) {
        if (args[i].startsWith('--')) {
            const key = args[i].slice(2);
            const next = args[i + 1];
            if (next && !next.startsWith('--')) {
                opts[key] = next;
                i++;
            } else {
                opts[key] = true;
            }
        }
    }
    return opts;
}

async function main() {
    const command = process.argv[2];
    const rawArgs = process.argv.slice(3);
    const opts = parseArgs(rawArgs);

    switch (command) {
        case 'apply': {
            const jobId = opts.job;
            if (!jobId) {
                console.error('Error: --job <jobId> is required');
                process.exit(1);
            }
            const dryRun = Boolean(opts['dry-run']);
            const headless = opts.headless !== 'false';
            const browser = opts.browser || opts.channel || null;
            const allowConsider = true;
            const userOverrideReason = 'User CLI invocation';
            const keepOpen = !headless;

            try {
                console.log(`Starting application workflow for: ${jobId}`);
                const res = await runApplicationWorkflow(jobId, {
                    dryRun,
                    headless,
                    browser,
                    allowConsider,
                    userOverrideReason,
                    keepOpen,
                    logger: (msg) => console.log(msg)
                });
                console.log('\nWorkflow Result:');
                const { session, ...cleanRes } = res;
                console.log(JSON.stringify(cleanRes, null, 2));

                if (keepOpen && session) {
                    console.log('\n🌟 BROWSER WINDOW IS OPEN ON YOUR SCREEN!');
                    console.log('You can inspect the autofilled form and attached resume.');
                    console.log('Press Ctrl+C or Enter to close the browser session when done...');
                    try {
                        await new Promise((resolve) => process.stdin.once('data', resolve));
                        await session.close();
                    } catch {}
                }
            } catch (err) {
                console.error(`Application workflow failed: ${err.message}`);
                process.exit(1);
            }
            break;
        }

        case 'review': {
            const appId = opts.application || opts.app;
            if (!appId) {
                console.error('Error: --application <applicationId> is required');
                process.exit(1);
            }
            const app = getApplication(appId);
            if (!app) {
                console.error(`Application not found: ${appId}`);
                process.exit(1);
            }

            console.log(`\n=== Application: ${appId} ===`);
            console.log(`State: ${app.state}`);
            console.log(`Job ID: ${app.job_id}`);
            console.log(`Company ID: ${app.company_id}`);
            if (app.review_packet_path && existsSync(app.review_packet_path)) {
                console.log('\n--- Review Packet ---');
                console.log(readFileSync(app.review_packet_path, 'utf8'));
            } else {
                console.log('No review packet generated yet.');
            }
            break;
        }

        case 'approve': {
            const appId = opts.application || opts.app;
            if (!appId) {
                console.error('Error: --application <applicationId> is required');
                process.exit(1);
            }
            const app = getApplication(appId);
            if (!app) {
                console.error(`Application not found: ${appId}`);
                process.exit(1);
            }

            let packetHash = null;
            if (app.review_packet_path && existsSync(app.review_packet_path)) {
                const packetContent = readFileSync(app.review_packet_path, 'utf8');
                packetHash = createHash('sha256').update(packetContent).digest('hex');
            }

            const payloadDigest = computeApplicationPayloadDigest(app);

            const authId = createSubmissionAuthorization({
                scope: 'single',
                application_id: appId,
                max_applications: 1,
                authorized_by: 'user',
                packet_hash: packetHash,
                resume_version_id: app.resume_version_id || null,
                payload_digest: payloadDigest
            });

            console.log(`\nSubmission explicitly authorized!`);
            console.log(`Authorization ID: ${authId}`);
            console.log(`Application ID: ${appId}`);
            if (packetHash) console.log(`Review Packet SHA-256: ${packetHash.slice(0, 16)}...`);
            if (app.resume_version_id) console.log(`Resume Version ID: ${app.resume_version_id}`);
            console.log(`Status: active`);
            break;
        }

        case 'reconcile': {
            const appId = opts.application || opts.app;
            const outcome = opts.outcome ? opts.outcome.toUpperCase() : null;
            const ref = opts.reference || opts.ref || null;
            const notes = opts.notes || null;

            if (!appId || !outcome) {
                console.error('Error: --application <id> and --outcome <CONFIRMED|READY_FOR_REVIEW|DRAFTING> are required');
                process.exit(1);
            }

            try {
                const res = reconcileSubmissionOutcome(appId, {
                    outcome,
                    confirmationReference: ref,
                    notes,
                    actor: 'user'
                });
                console.log(`\nReconciliation Successful:`);
                console.log(JSON.stringify(res, null, 2));
            } catch (err) {
                console.error(`Reconciliation failed: ${err.message}`);
                process.exit(1);
            }
            break;
        }

        case 'list': {
            const stateFilter = opts.state ? opts.state.toUpperCase() : null;
            const allApps = getAllApplications();
            const genuineApps = allApps.filter(a => !isSyntheticApplication(a));
            const filtered = stateFilter ? genuineApps.filter(a => a.state === stateFilter) : genuineApps;
            console.log(`\n=== Operational Applications (${filtered.length} found) ===`);
            for (const a of filtered) {
                console.log(`[${a.state}] ID: ${a.id} | Job: ${a.job_id} | Portal: ${a.portal_type || 'N/A'} | Updated: ${a.updated_at}`);
            }
            break;
        }

        case 'questions': {
            const appId = opts.application || opts.app;
            if (!appId) {
                console.error('Error: --application <applicationId> is required');
                process.exit(1);
            }
            const app = getApplication(appId);
            if (!app) {
                console.error(`Application not found: ${appId}`);
                process.exit(1);
            }
            let meta = {};
            try {
                meta = typeof app.execution_metadata_json === 'string'
                    ? JSON.parse(app.execution_metadata_json || '{}')
                    : (app.execution_metadata_json || {});
            } catch {
                meta = {};
            }
            const pending = meta.pendingQuestions || [];
            console.log(`\n=== Pending Questions for Application: ${appId} (${pending.length} pending) ===`);
            for (const q of pending) {
                console.log(`- Key: ${q.key}`);
                console.log(`  Label: ${q.label}`);
                console.log(`  Type: ${q.type}`);
                if (q.options && q.options.length > 0) {
                    console.log(`  Options: ${JSON.stringify(q.options)}`);
                }
                console.log(`  Required: ${q.required} | Sensitive: ${q.isSensitive}`);
                console.log(`  Status: ${q.status || 'pending'}`);
                console.log('');
            }
            break;
        }

        case 'answer': {
            const appId = opts.application || opts.app;
            const key = opts.key;
            const value = opts.value;
            if (!key || value === undefined) {
                console.error('Error: --key <key> and --value <value> are required');
                process.exit(1);
            }
            try {
                let field = null;
                if (appId) {
                    const app = getApplication(appId);
                    if (app?.execution_metadata_json) {
                        try {
                            const meta = typeof app.execution_metadata_json === 'string'
                                ? JSON.parse(app.execution_metadata_json)
                                : app.execution_metadata_json;
                            field = (meta.pendingQuestions || []).find(q =>
                                (q.key && q.key.toLowerCase() === key.toLowerCase()) ||
                                (q.label && q.label.toLowerCase() === key.toLowerCase())
                            );
                        } catch {}
                    }
                }

                const res = recordUserAnswer({
                    applicationId: appId || null,
                    questionKey: key,
                    questionText: field?.label || key,
                    answerValue: value,
                    field,
                    source: 'user_cli',
                    confirmedByUser: true
                });
                console.log('\nAnswer recorded successfully:');
                console.log(JSON.stringify(res, null, 2));
            } catch (err) {
                console.error(`Failed to record answer: ${err.message}`);
                process.exit(1);
            }
            break;
        }

        case 'resume': {
            const appId = opts.application || opts.app;
            if (!appId) {
                console.error('Error: --application <applicationId> is required');
                process.exit(1);
            }
            const dryRun = Boolean(opts['dry-run']);
            const headless = opts.headless !== 'false';
            try {
                console.log(`Resuming application workflow for: ${appId}`);
                const res = await resumeApplicationWorkflow(appId, {
                    dryRun,
                    headless,
                    logger: (msg) => console.log(msg)
                });
                console.log('\nResume Result:');
                console.log(JSON.stringify(res, null, 2));
            } catch (err) {
                console.error(`Application resume failed: ${err.message}`);
                process.exit(1);
            }
            break;
        }

        case 'submit': {
            const appId = opts.application || opts.app;
            if (!appId) {
                console.error('Error: --application <applicationId> (or --app <appId>) is required');
                process.exit(1);
            }
            const app = getApplication(appId);
            if (!app) {
                console.error(`Application not found: ${appId}`);
                process.exit(1);
            }

            if (app.state !== APPLICATION_STATES.READY_FOR_REVIEW) {
                console.error(`Application ${appId} cannot be submitted from state: ${app.state}. Must be in READY_FOR_REVIEW.`);
                process.exit(1);
            }

            const validAuth = getValidSubmissionAuthorization(appId, app.company_id);
            if (!validAuth) {
                console.error(`Error: No valid, active submission authorization found for application ${appId}. Run 'approve' first.`);
                process.exit(1);
            }

            const headless = opts.headless !== 'false';

            try {
                console.log(`Submitting application: ${appId}`);
                const res = await resumeApplicationWorkflow(appId, {
                    submit: true,
                    headless,
                    logger: (msg) => console.log(msg)
                });
                console.log('\nSubmission Result:');
                console.log(JSON.stringify(res, null, 2));
            } catch (err) {
                console.error(`Submission failed: ${err.message}`);
                process.exit(1);
            }
            break;
        }

        case 'worker': {
            const subCmd = rawArgs[0];
            const workerOpts = parseArgs(rawArgs.slice(1));
            const {
                inspectQueue,
                runWorkerCycle,
                runWorkerBatch,
                recoverExpiredLeases,
                getDailyQuotaUsage
            } = await import('./worker.mjs');

            switch (subCmd) {
                case 'inspect': {
                    const queueInfo = inspectQueue();
                    console.log('\n=== Application Worker Queue ===');
                    console.log(`Total Queued: ${queueInfo.queuedTotal}`);
                    console.log(`Active Leases: ${queueInfo.activeLeasesCount}`);
                    console.log(`Daily Quota: ${queueInfo.dailyQuota.current}/10 (Confirmed: ${queueInfo.dailyQuota.confirmed}, In-Flight: ${queueInfo.dailyQuota.in_flight})`);
                    if (queueInfo.queued.length > 0) {
                        console.log('\n--- Next Queued Applications ---');
                        for (const q of queueInfo.queued.slice(0, 10)) {
                            console.log(`[${q.state}] ID: ${q.id} | Job: ${q.job_id} | Score: ${q.score} | Lease: ${q.lease_status || 'none'}`);
                        }
                    }
                    break;
                }
                case 'cycle': {
                    const autoSubmit = Boolean(workerOpts['auto-submit']);
                    const dryRun = Boolean(workerOpts['dry-run']);
                    const res = await runWorkerCycle({
                        standingPolicyOverrides: { auto_submit_enabled: autoSubmit },
                        dryRun,
                        logger: (msg) => console.log(msg)
                    });
                    console.log('\nWorker Cycle Result:');
                    console.log(JSON.stringify(res, null, 2));
                    break;
                }
                case 'batch': {
                    const limit = parseInt(workerOpts.limit || workerOpts.n || '5', 10);
                    const autoSubmit = Boolean(workerOpts['auto-submit']);
                    const dryRun = Boolean(workerOpts['dry-run']);
                    const res = await runWorkerBatch({
                        batchSize: limit,
                        standingPolicyOverrides: { auto_submit_enabled: autoSubmit },
                        dryRun,
                        logger: (msg) => console.log(msg)
                    });
                    console.log('\nWorker Batch Result:');
                    console.log(JSON.stringify(res, null, 2));
                    break;
                }
                case 'recover': {
                    const res = recoverExpiredLeases();
                    console.log('\nLease Recovery Result:');
                    console.log(JSON.stringify(res, null, 2));
                    break;
                }
                case 'quota': {
                    const quota = getDailyQuotaUsage();
                    console.log('\nDaily Submission Quota:');
                    console.log(JSON.stringify(quota, null, 2));
                    break;
                }
                default: {
                    console.log(`
Worker Commands:
  node application/cli.mjs worker inspect
  node application/cli.mjs worker cycle [--auto-submit] [--dry-run]
  node application/cli.mjs worker batch [--limit <N>] [--auto-submit] [--dry-run]
  node application/cli.mjs worker recover
  node application/cli.mjs worker quota
`);
                    break;
                }
            }
            break;
        }

        default:
            console.log(`
Usage:
  node application/cli.mjs apply --job <jobId> [--dry-run] [--headless]
  node application/cli.mjs list [--state <NEEDS_USER_INPUT|READY_FOR_REVIEW|...>]
  node application/cli.mjs questions --application <appId>
  node application/cli.mjs answer --application <appId> --key <key> --value <value>
  node application/cli.mjs resume --application <appId> [--dry-run] [--headless]
  node application/cli.mjs review --application <appId>
  node application/cli.mjs approve --application <appId>
  node application/cli.mjs submit --app <appId> [--headless]
  node application/cli.mjs worker <inspect|cycle|batch|recover|quota>
  node application/cli.mjs reconcile --application <appId> --outcome <CONFIRMED|READY_FOR_REVIEW> [--reference <ref>]
`);
            break;
    }
}

if (process.argv[1] && process.argv[1].endsWith('cli.mjs')) {
    main().catch(err => {
        console.error(err);
        process.exit(1);
    });
}
