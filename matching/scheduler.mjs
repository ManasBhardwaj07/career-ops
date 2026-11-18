/**
 * matching/scheduler.mjs — Job Matching Orchestrator & Batch Scheduler
 *
 * Implements Milestone 3B Part 6:
 *   - Orchestrates multi-tier matching across active & newly discovered jobs
 *   - Persists evaluation results into job_evaluation_runs
 *   - Provides CLI commands for single-job and batch evaluation
 *   - Supports dry-run execution and failure isolation
 */

import { createHash } from 'crypto';
import { resolve } from 'path';
import { mkdirSync, appendFileSync } from 'fs';
import {
    getJob,
    getCandidateFacts,
    insertJobEvaluationRun,
    getLatestEvaluationRun,
    getEffectiveTier2Eligibility,
    getDb,
    closeDb,
    findCrossSourceDuplicates,
    isConfirmedDuplicate,
    resolveDuplicateSuggestion,
    runInTransaction,
    getApplicationByJobId,
    APPLICATION_STATES
} from '../db/repo.mjs';
import { evaluateJobOffer } from './pipeline.mjs';
import { verifyJobBatch, isJobVerifiedActive } from '../verification/verify-jobs.mjs';
import { runCrawlManager } from '../discovery/crawler/crawl-manager.mjs';
import { runScanner } from '../scan-sqlite.mjs';

const EVAL_VERSION = '3B.1.0';

/**
 * Computes an input fingerprint for idempotency
 */
export function computeEvaluationFingerprint(job, candidateFacts) {
    const jobContent = `${job.title || ''}|${job.location || ''}|${job.remote_type || ''}|${job.description || ''}`;
    const factContent = candidateFacts.map(f => `${f.id}:${f.value}`).sort().join(';');
    return createHash('sha256').update(`${EVAL_VERSION}|${jobContent}|${factContent}`).digest('hex').slice(0, 16);
}

function supportsNotEvaluatedTier2(db) {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'job_evaluation_runs'").get();
    return Boolean(row?.sql && row.sql.includes("'NOT_EVALUATED'"));
}

export { getEffectiveTier2Eligibility };

/**
 * Evaluates a single job by ID and persists result to job_evaluation_runs
 */
export async function evaluateJob(jobId, {
    candidateFacts = null,
    evidenceRecords = null,
    dryRun = false,
    forceReeval = false,
    evalVersion = EVAL_VERSION,
    notes = null,
    requireVerifiedActive = false
} = {}) {
    const job = getJob(jobId);
    if (!job) {
        throw new Error(`Job not found: ${jobId}`);
    }

    const facts = candidateFacts || getCandidateFacts();
    const inputHash = computeEvaluationFingerprint(job, facts);

    const isVerifiedActive = isJobVerifiedActive(job);

    // Check idempotency: if latest evaluation has same fingerprint, skip repeat insert
    if (!forceReeval && !dryRun) {
        const latest = getLatestEvaluationRun(job.id);
        if (latest && latest.input_hash === inputHash) {
            return {
                jobId: job.id,
                evaluationId: latest.id,
                skipped: true,
                tier1Passed: Boolean(latest.tier1_passed),
                tier2Eligibility: getEffectiveTier2Eligibility(latest),
                recommendation: latest.recommendation,
                finalScore: latest.tier3_match_score,
                isVerifiedActive,
                reason: 'Idempotent skip: identical evaluation fingerprint already exists'
            };
        }
    }

    const evalResult = evaluateJobOffer(job, facts, evidenceRecords);

    // Verification Gating: A job must have a successful, sufficiently recent verification result
    // before it can receive an APPLY recommendation
    if (requireVerifiedActive && !isVerifiedActive && evalResult.recommendation === 'APPLY') {
        evalResult.recommendation = 'UNKNOWN';
        evalResult.reason = `Cannot recommend APPLY: job requires successful, recent liveness verification (status: ${job.status}, verification: ${job.verification_method || 'none'})`;
    }

    const tier1Passed = Boolean(evalResult.tier1?.passed);
    const tier2Eligibility = !tier1Passed ? 'NOT_EVALUATED' : (evalResult.tier2?.eligibility || 'UNKNOWN');

    let evaluationId = null;
    if (!dryRun) {
        const db = getDb();
        const schemaAllowsNotEvaluated = supportsNotEvaluatedTier2(db);
        const persistedTier2 = (tier2Eligibility === 'NOT_EVALUATED' && !schemaAllowsNotEvaluated)
            ? 'UNKNOWN'
            : tier2Eligibility;
        const persistedGates = (!tier1Passed && (!evalResult.tier2?.gates || evalResult.tier2.gates.length === 0))
            ? [{ gate: 'tier1_prefilter', outcome: 'NOT_EVALUATED', reason: evalResult.reason }]
            : (evalResult.tier2?.gates || []);

        evaluationId = insertJobEvaluationRun({
            job_id: job.id,
            eval_version: evalVersion || EVAL_VERSION,
            input_hash: inputHash,
            tier1_passed: tier1Passed ? 1 : 0,
            tier1_matched_titles: evalResult.tier1?.matchedKeywords || [],
            tier2_eligibility: persistedTier2,
            tier2_gates_json: persistedGates,
            tier3_match_score: evalResult.tier3?.matchScore ?? null,
            tier3_breakdown_json: evalResult.tier3?.breakdown || [],
            matched_fact_ids: evalResult.tier3?.matchedFactIds || [],
            evidence_ids: evalResult.tier3?.evidenceIds || [],
            missing_evidence_facts: evalResult.tier3?.missingEvidenceFacts || [],
            recommendation: evalResult.recommendation,
            notes: notes || evalResult.reason
        });
    }

    return {
        jobId: job.id,
        evaluationId,
        skipped: false,
        tier1Passed,
        tier2Eligibility,
        recommendation: evalResult.recommendation,
        finalScore: evalResult.finalScore,
        evalResult,
        isVerifiedActive,
        dryRun
    };
}

/**
 * Runs cross-source deduplication across active & discovered postings
 */
export async function deduplicateBatch({ companyId = null, dryRun = false } = {}) {
    const db = getDb();
    let query = `
        SELECT id, company_id, title, source, job_url FROM job_postings
        WHERE status IN ('discovered', 'active')
    `;
    const params = [];
    if (companyId) {
        query += ` AND company_id = ?`;
        params.push(companyId);
    }
    query += ` ORDER BY discovered_at ASC`;
    const jobs = db.prepare(query).all(...params);

    const summary = {
        totalInspected: jobs.length,
        duplicatesFound: 0,
        duplicatePairs: [],
        dryRun
    };

    for (const job of jobs) {
        if (!dryRun) {
            const dups = findCrossSourceDuplicates(job);
            if (dups.length > 0) {
                summary.duplicatesFound += dups.length;
                summary.duplicatePairs.push({ jobId: job.id, duplicateOf: dups });
            }
        } else {
            const rows = db.prepare(`
                SELECT id FROM job_postings
                WHERE company_id = ? AND LOWER(TRIM(title)) = LOWER(TRIM(?)) AND id != ?
            `).all(job.company_id, job.title, job.id);
            if (rows.length > 0) {
                summary.duplicatesFound += rows.length;
                summary.duplicatePairs.push({ jobId: job.id, duplicateOf: rows.map(r => r.id) });
            }
        }
    }

    return summary;
}

/**
 * Evaluates a batch of jobs meeting evaluation criteria
 */
export async function evaluateBatch({
    limit = 20,
    companyId = null,
    dryRun = false,
    forceReeval = false,
    requireVerifiedActive = false
} = {}) {
    const db = getDb();
    const facts = getCandidateFacts();

    let query = `
        SELECT * FROM job_postings
        WHERE status IN ('discovered', 'active')
    `;
    const params = [];

    if (companyId) {
        query += ` AND company_id = ?`;
        params.push(companyId);
    }

    query += ` ORDER BY last_seen_at DESC, discovered_at DESC LIMIT ?`;
    params.push(limit);

    const candidateJobs = db.prepare(query).all(...params);

    const summary = {
        totalEvaluated: 0,
        applyCount: 0,
        considerCount: 0,
        doNotApplyCount: 0,
        unknownCount: 0,
        skippedCount: 0,
        deduplicatedCount: 0,
        errorCount: 0,
        results: [],
        dryRun
    };

    for (const job of candidateJobs) {
        try {
            // Check if this job is a CONFIRMED duplicate of a canonical job
            // Unresolved suggestions (resolved = 0) NEVER suppress evaluation
            const canonicalJobId = isConfirmedDuplicate(job.id);

            if (canonicalJobId && canonicalJobId !== job.id) {
                summary.skippedCount++;
                summary.deduplicatedCount++;
                summary.results.push({
                    jobId: job.id,
                    skipped: true,
                    isDuplicate: true,
                    canonicalJobId,
                    recommendation: 'SKIPPED_DUPLICATE',
                    reason: `Idempotent skip: confirmed duplicate of canonical job ${canonicalJobId}`,
                    isVerifiedActive: false
                });
                continue;
            }

            const res = await evaluateJob(job.id, {
                candidateFacts: facts,
                dryRun,
                forceReeval,
                requireVerifiedActive
            });

            summary.totalEvaluated++;
            summary.results.push(res);

            if (res.skipped) {
                summary.skippedCount++;
            } else if (res.recommendation === 'APPLY') {
                summary.applyCount++;
            } else if (res.recommendation === 'CONSIDER') {
                summary.considerCount++;
            } else if (res.recommendation === 'DO_NOT_APPLY') {
                summary.doNotApplyCount++;
            } else if (res.recommendation === 'UNKNOWN') {
                summary.unknownCount++;
            }
        } catch (err) {
            summary.errorCount++;
            summary.results.push({
                jobId: job.id,
                error: err.message
            });
        }
    }

    return summary;
}

/**
 * Integrates the full Career-Ops pipeline (Milestone 3E Batch B):
 * source scan -> normalized job persistence -> liveness verification -> cross-source deduplication -> eligibility and technical evaluation
 */
export async function runUnifiedPipeline({
    crawl = true,
    scan = false,
    feedsOnly = false,
    includeFeeds = true,
    filterSource = null,
    verify = true,
    dedup = true,
    evaluate = true,
    enqueue = false,
    limit = 20,
    crawlLimit = null,
    maxPagesPerCompany = null,
    companyId = null,
    dryRun = false,
    pilotOnly = false,
    maxAgeDays = 3,
    forceReeval = false,
    timeoutMs = 15000,
    fetchFn = null
} = {}) {
    const startTime = Date.now();
    const pipelineSummary = {
        success: true,
        dryRun,
        stages: {},
        eligibleForApplication: [],
        errors: [],
        durationMs: 0
    };

    // Stage 1: Discovery / Source Scan
    if (crawl || scan) {
        pipelineSummary.stages.discovery = {};

        if (crawl) {
            try {
                const crawlRes = await runCrawlManager({
                    dryRun,
                    limit: companyId ? 1 : (crawlLimit ?? limit),
                    pilotOnly,
                    companyId,
                    maxPagesPerCompany: maxPagesPerCompany ?? 25
                });
                pipelineSummary.stages.discovery.crawl = crawlRes.summary;
            } catch (err) {
                pipelineSummary.errors.push(`Discovery Crawl error: ${err.message}`);
                pipelineSummary.stages.discovery.crawl = { error: err.message };
            }
        }

        if (scan) {
            try {
                const scanRes = await runScanner({
                    dryRun,
                    filterCompany: companyId,
                    filterSource,
                    feedsOnly,
                    includeFeeds,
                    fetchFn,
                    timeoutMs
                });
                pipelineSummary.stages.discovery.scan = scanRes;
            } catch (err) {
                pipelineSummary.errors.push(`Discovery Scan error: ${err.message}`);
                pipelineSummary.stages.discovery.scan = { error: err.message };
            }
        }
    }

    // Stage 2: Liveness Verification
    if (verify) {
        try {
            const verifySummary = await verifyJobBatch({
                limit,
                maxAgeDays,
                companyId,
                dryRun,
                timeoutMs,
                fetchFn
            });
            pipelineSummary.stages.verification = verifySummary;
        } catch (err) {
            pipelineSummary.errors.push(`Verification error: ${err.message}`);
            pipelineSummary.stages.verification = { error: err.message };
        }
    }

    // Stage 3: Cross-Source Deduplication
    if (dedup) {
        try {
            const dedupSummary = await deduplicateBatch({ companyId, dryRun });
            pipelineSummary.stages.deduplication = dedupSummary;
        } catch (err) {
            pipelineSummary.errors.push(`Deduplication error: ${err.message}`);
            pipelineSummary.stages.deduplication = { error: err.message };
        }
    }

    // Stage 4: Eligibility & Fit Evaluation
    if (evaluate) {
        try {
            const evalSummary = await evaluateBatch({
                limit,
                companyId,
                dryRun,
                forceReeval,
                requireVerifiedActive: true
            });
            pipelineSummary.stages.evaluation = evalSummary;

            // Only eligible APPLY results from verified-active jobs may enter application preparation
            if (evalSummary && evalSummary.results) {
                pipelineSummary.eligibleForApplication = evalSummary.results
                    .filter(r => r.recommendation === 'APPLY' && !r.isDuplicate && r.isVerifiedActive)
                    .map(r => ({
                        jobId: r.jobId,
                        evaluationId: r.evaluationId,
                        score: r.finalScore,
                        recommendation: r.recommendation
                    }));
            }
        } catch (err) {
            pipelineSummary.errors.push(`Evaluation error: ${err.message}`);
            pipelineSummary.stages.evaluation = { error: err.message };
        }
    }

    // Stage 5: Application Handoff Enqueue
    if (enqueue) {
        const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const handoffReport = {
            run_id: runId,
            timestamp: new Date().toISOString(),
            eligible_total: pipelineSummary.eligibleForApplication.length,
            enqueued: [],
            skipped_existing: [],
            skipped_anomalies: []
        };

        if (dryRun) {
            for (const item of pipelineSummary.eligibleForApplication) {
                const job = getJob(item.jobId);
                if (!job || job.status !== 'active') {
                    handoffReport.skipped_anomalies.push({
                        jobId: item.jobId,
                        reason: !job ? 'Job not found' : `Job status is ${job.status}`
                    });
                    continue;
                }
                const existing = getApplicationByJobId(item.jobId);
                if (existing) {
                    handoffReport.skipped_existing.push({
                        jobId: item.jobId,
                        applicationId: existing.id,
                        state: existing.state,
                        outcome: existing.recruitment_outcome
                    });
                } else {
                    handoffReport.enqueued.push({
                        jobId: item.jobId,
                        applicationId: `dry_app_${item.jobId}`,
                        score: item.score
                    });
                }
            }
        } else {
            try {
                runInTransaction((db) => {
                    for (const item of pipelineSummary.eligibleForApplication) {
                        const job = getJob(item.jobId);
                        if (!job || job.status !== 'active') {
                            handoffReport.skipped_anomalies.push({
                                jobId: item.jobId,
                                reason: !job ? 'Job not found' : `Job status is ${job.status}`
                            });
                            continue;
                        }

                        // Check if an applications row already exists for this job in ANY state
                        const existing = db.prepare('SELECT id, state, recruitment_outcome FROM applications WHERE job_id = ?').get(item.jobId);
                        if (existing) {
                            handoffReport.skipped_existing.push({
                                jobId: item.jobId,
                                applicationId: existing.id,
                                state: existing.state,
                                outcome: existing.recruitment_outcome
                            });
                            continue;
                        }

                        const appId = `app_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
                        db.prepare(`
                            INSERT INTO applications
                            (id, job_id, company_id, state, score, source_origin, notes, created_at, updated_at)
                            VALUES (?, ?, ?, 'NOT_STARTED', ?, 'pipeline-handoff', 'Enqueued by scheduler handoff', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                        `).run(appId, item.jobId, job.company_id, item.score);

                        db.prepare(`
                            INSERT INTO application_events
                            (application_id, previous_state, new_state, event_type, message, actor, source_origin, created_at)
                            VALUES (?, NULL, 'NOT_STARTED', 'application_created', 'Application record created via scheduler pipeline handoff', 'scheduler', 'pipeline-handoff', CURRENT_TIMESTAMP)
                        `).run(appId);

                        handoffReport.enqueued.push({
                            jobId: item.jobId,
                            applicationId: appId,
                            companyId: job.company_id,
                            score: item.score
                        });
                    }
                });

                // Write log file
                try {
                    const runLogDir = resolve(process.cwd(), 'data', 'runs');
                    mkdirSync(runLogDir, { recursive: true });
                    appendFileSync(resolve(runLogDir, 'handoff.log'), JSON.stringify(handoffReport) + '\n', 'utf8');
                } catch {
                    // Logging error should not fail pipeline
                }

                console.log('[Scheduler:Handoff] Structured Handoff Report:');
                console.log(JSON.stringify(handoffReport, null, 2));

            } catch (enqueueErr) {
                pipelineSummary.errors.push(`Handoff Enqueue error: ${enqueueErr.message}`);
            }
        }

        pipelineSummary.handoff = handoffReport;
    }

    pipelineSummary.durationMs = Date.now() - startTime;
    pipelineSummary.success = pipelineSummary.errors.length === 0;

    return pipelineSummary;
}

// ─── CLI RUNNER ───────────────────────────────────────────────────────────────

if (process.argv[1] && process.argv[1].endsWith('scheduler.mjs')) {
    const args = process.argv.slice(2);
    const dryRun = args.includes('--dry-run');
    const isPipeline = args.includes('--pipeline');
    const verifyFirst = args.includes('--verify');

    const limitIdx = args.indexOf('--limit');
    const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : 20;

    const jobIdx = args.indexOf('--job');
    const targetJobId = jobIdx !== -1 ? args[jobIdx + 1] : null;

    const companyIdx = args.indexOf('--company');
    const targetCompanyId = companyIdx !== -1 ? args[companyIdx + 1] : null;

    const withCrawl = !args.includes('--no-crawl');
    const withScan = args.includes('--scan');
    const withVerify = !args.includes('--no-verify');
    const withDedup = !args.includes('--no-dedup');
    const withEval = !args.includes('--no-eval');
    const withEnqueue = args.includes('--enqueue');
    const pilotOnly = args.includes('--pilot');
    const forceReeval = args.includes('--force-reeval');

    (async () => {
        try {
            console.log('====================================================');
            console.log('🎯 Career-Ops Job Matching & Pipeline Engine');
            console.log('====================================================\n');

            if (isPipeline) {
                console.log('🚀 Running Unified Pipeline: Discovery → Verify → Dedup → Evaluate');
                if (dryRun) console.log('   Mode: DRY-RUN (Zero DB mutations)');
                console.log(`   Options: crawl=${withCrawl}, scan=${withScan}, verify=${withVerify}, dedup=${withDedup}, eval=${withEval}, enqueue=${withEnqueue}, limit=${limit}\n`);

                const result = await runUnifiedPipeline({
                    crawl: withCrawl,
                    scan: withScan,
                    verify: withVerify,
                    dedup: withDedup,
                    evaluate: withEval,
                    enqueue: withEnqueue,
                    limit,
                    companyId: targetCompanyId,
                    dryRun,
                    pilotOnly,
                    forceReeval
                });

                console.log('\n====================================================');
                console.log('📊 Pipeline Execution Summary:');
                console.log(`   Status:       ${result.success ? 'SUCCESS' : 'FAILED'}`);
                console.log(`   Duration:     ${result.durationMs}ms`);
                if (result.stages.discovery) {
                    if (result.stages.discovery.crawl) {
                        const c = result.stages.discovery.crawl;
                        console.log(`   Crawl:        ${c.total_normalized_jobs ?? 0} jobs normalized (${c.total_inserted ?? 0} inserted, ${c.total_unchanged ?? 0} unchanged)`);
                    }
                    if (result.stages.discovery.scan) {
                        const s = result.stages.discovery.scan;
                        console.log(`   Scan:         ${s.normalizedCount ?? 0} jobs normalized (${s.insertedCount ?? 0} inserted)`);
                    }
                }
                if (result.stages.verification) {
                    const v = result.stages.verification;
                    console.log(`   Verification: ${v.totalProcessed ?? 0} checked (${v.activeCount ?? 0} active, ${v.closedCount ?? 0} closed, ${v.expiredCount ?? 0} expired)`);
                }
                if (result.stages.deduplication) {
                    const d = result.stages.deduplication;
                    console.log(`   Deduplication:${d.duplicatesFound ?? 0} cross-source duplicates linked (inspected ${d.totalInspected ?? 0})`);
                }
                if (result.stages.evaluation) {
                    const e = result.stages.evaluation;
                    console.log(`   Evaluation:   ${e.totalEvaluated ?? 0} evaluated (${e.applyCount ?? 0} APPLY, ${e.considerCount ?? 0} CONSIDER, ${e.doNotApplyCount ?? 0} DO_NOT_APPLY, ${e.skippedCount ?? 0} skipped)`);
                }
                console.log(`   Eligible for Application Preparation: ${result.eligibleForApplication.length}`);
                for (const appEligible of result.eligibleForApplication) {
                    console.log(`     - Job ${appEligible.jobId} (Score: ${appEligible.score})`);
                }
                if (result.handoff) {
                    console.log(`   Handoff:      ${result.handoff.enqueued.length} enqueued, ${result.handoff.skipped_existing.length} skipped existing, ${result.handoff.skipped_anomalies.length} anomalies`);
                }
                if (result.errors.length > 0) {
                    console.log('   Errors:');
                    for (const err of result.errors) console.log(`     ⚠️ ${err}`);
                }
                console.log('====================================================');
            } else if (targetJobId) {
                console.log(`🎯 Evaluating single job: ${targetJobId}`);
                const res = await evaluateJob(targetJobId, { dryRun, forceReeval: true });
                console.log('\nEvaluation Result:');
                console.log(JSON.stringify(res, null, 2));
            } else {
                if (verifyFirst) {
                    console.log('🔍 Running job liveness verification pass...');
                    const verifySummary = await verifyJobBatch({ limit, dryRun });
                    console.log(`   Processed: ${verifySummary.totalProcessed} (Active: ${verifySummary.activeCount}, Closed: ${verifySummary.closedCount}, Expired: ${verifySummary.expiredCount}, Unknown: ${verifySummary.unknownCount})\n`);
                }

                console.log(`🚀 Evaluating batch of up to ${limit} jobs...`);
                const summary = await evaluateBatch({ limit, dryRun, forceReeval });
                console.log('\n====================================================');
                console.log('📊 Batch Evaluation Summary:');
                console.log(`   Total Processed: ${summary.totalEvaluated}`);
                console.log(`   APPLY:           ${summary.applyCount}`);
                console.log(`   CONSIDER:        ${summary.considerCount}`);
                console.log(`   DO_NOT_APPLY:    ${summary.doNotApplyCount}`);
                console.log(`   UNKNOWN:         ${summary.unknownCount}`);
                console.log(`   Skipped:         ${summary.skippedCount} (Deduplicated: ${summary.deduplicatedCount})`);
                console.log(`   Errors:          ${summary.errorCount}`);
                console.log('====================================================');
            }
        } finally {
            closeDb();
        }
    })();
}
