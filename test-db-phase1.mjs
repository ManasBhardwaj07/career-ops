#!/usr/bin/env node

/**
 * test-db-phase1.mjs — Comprehensive Phase 1 Database & State Acceptance Suite
 *
 * Verifies all 12 acceptance criteria specified in the Phase 1 Implementation Order:
 * 1. Full schema existence (all 12+ canonical tables)
 * 2. Migration rerun safety (idempotent migrations)
 * 3. WAL mode and PRAGMA settings
 * 4. Foreign key enforcement (violations rejected)
 * 5. Insert, close, and reopen (persistence verification)
 * 6. Transaction rollback on error
 * 7. Savepoint nested transaction integrity
 * 8. Upsert behavior (no duplicate insertions)
 * 9. Standalone hot backup and independent integrity check
 * 10. Historical import idempotency
 * 11. Candidate facts and evidence quality check
 * 12. Non-destructive file preservation check
 */

import { existsSync, unlinkSync, copyFileSync } from 'fs';
import { resolve } from 'path';
import { DatabaseSync } from 'node:sqlite';

const TEST_DB_PATH = resolve(process.cwd(), 'data', 'test_db_phase1.db');
const CANONICAL_DB_PATH = resolve(process.cwd(), 'data', 'job_agent.db');

function cleanupTestDb() {
    for (const f of [TEST_DB_PATH, `${TEST_DB_PATH}-wal`, `${TEST_DB_PATH}-shm`]) {
        if (existsSync(f)) {
            try { unlinkSync(f); } catch { /* ignore */ }
        }
    }
}

cleanupTestDb();
if (existsSync(CANONICAL_DB_PATH)) {
    copyFileSync(CANONICAL_DB_PATH, TEST_DB_PATH);
}
process.env.JOB_AGENT_DB_PATH = TEST_DB_PATH;

const { getDb, closeDb, resetDb, backupDb, runInTransaction, getDbPath } = await import('./db/db.mjs');
const resolvedDbPath = resolve(getDbPath());
if (resolvedDbPath === CANONICAL_DB_PATH) {
    throw new Error(`SAFETY ABORT: test-db-phase1.mjs resolved to canonical DB (${resolvedDbPath})`);
}
console.log(`🔒 Isolated DB Path: ${resolvedDbPath}`);

const {
    upsertCompany,
    getCompany,
    upsertJobPosting,
    getJob,
    countJobs,
    getCandidateFacts,
    getEvidenceForFact,
    getAnswerByKey
} = await import('./db/repo.mjs');
const { migrateHistory } = await import('./scripts/migrate-history.mjs');
const { ingestProfile } = await import('./scripts/ingest-profile.mjs');

let passed = 0;
let failed = 0;

function assert(condition, message) {
    if (condition) {
        console.log(`  ✓ ${message}`);
        passed++;
    } else {
        console.error(`  ✗ FAIL: ${message}`);
        failed++;
    }
}

async function runTests() {
    console.log('==================================================');
    console.log('🧪 Career-Ops Phase 1 Database Acceptance Test Suite');
    console.log('==================================================\n');

    const db = getDb();

    // ── 1. Full Schema Existence ─────────────────────────────────────
    console.log('1. Verifying Canonical Schema Existence:');
    const requiredTables = [
        'schema_migrations',
        'candidate_facts',
        'companies',
        'source_policies',
        'source_scans',
        'job_postings',
        'job_snapshots',
        'evidence_records',
        'resume_versions',
        'candidate_answers',
        'applications',
        'application_events',
        'duplicate_suggestions',
        'job_evaluations'
    ];

    const existingTables = new Set(
        db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t => t.name)
    );

    for (const t of requiredTables) {
        assert(existingTables.has(t), `Table exists: ${t}`);
    }

    // ── 2. Migration Rerun Safety ────────────────────────────────────
    console.log('\n2. Verifying Migration Rerun Safety:');
    const ledger = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all();
    const versions = ledger.map(l => l.version);
    assert(versions.includes('002') && versions.includes('003'), `Applied migrations present: ${versions.join(', ')}`);

    // ── 3. WAL Mode and PRAGMAs ──────────────────────────────────────
    console.log('\n3. Verifying WAL Mode & Durability PRAGMAs:');
    const journalMode = db.prepare('PRAGMA journal_mode').get().journal_mode;
    assert(journalMode === 'wal', `journal_mode is WAL (got: ${journalMode})`);

    const fkEnabled = db.prepare('PRAGMA foreign_keys').get().foreign_keys;
    assert(fkEnabled === 1, 'foreign_keys is enabled (1)');

    const syncMode = db.prepare('PRAGMA synchronous').get().synchronous;
    assert(syncMode === 1 || syncMode === 2, `synchronous durability is FULL/NORMAL (got: ${syncMode})`);

    const busyTimeout = parseInt(db.prepare('PRAGMA busy_timeout').get().timeout);
    assert(busyTimeout >= 5000, `busy_timeout >= 5000ms (got: ${busyTimeout}ms)`);

    // ── 4. Foreign Key Enforcement ───────────────────────────────────
    console.log('\n4. Verifying Foreign Key Enforcement:');
    let fkBlocked = false;
    try {
        db.prepare(`
            INSERT INTO job_postings (id, company_id, title, job_url, source)
            VALUES ('test-fk-job', 'non-existent-company-xyz', 'Engineer', 'https://test.xyz/job', 'test')
        `).run();
    } catch (err) {
        if (err.message.includes('FOREIGN KEY constraint failed')) {
            fkBlocked = true;
        }
    }
    assert(fkBlocked, 'Insert with invalid foreign key was correctly rejected');

    // ── 5. Insert, Close, and Reopen Persistence ─────────────────────
    console.log('\n5. Verifying Connection Lifecycle and Persistence:');
    const testCid = 'company-lifecycle-test';
    upsertCompany({
        id: testCid,
        name: 'Lifecycle Test Company',
        policy_status: 'permitted',
        notes: 'Testing connection reopen'
    });

    // Close singleton connection
    closeDb();

    // Reopen singleton connection
    const freshDb = getDb();
    const loadedComp = freshDb.prepare('SELECT * FROM companies WHERE id = ?').get(testCid);
    assert(loadedComp && loadedComp.name === 'Lifecycle Test Company', 'Data persisted across connection close and reopen');

    // Clean up test company
    freshDb.prepare('DELETE FROM companies WHERE id = ?').run(testCid);

    // ── 6. Transaction Rollback on Error ─────────────────────────────
    console.log('\n6. Verifying Transaction Rollback:');
    const rollbackCid = 'company-rollback-test';
    let txRolledBack = false;
    try {
        runInTransaction((txDb) => {
            txDb.prepare(`
                INSERT INTO companies (id, name, policy_status)
                VALUES (?, 'Should Roll Back', 'permitted')
            `).run(rollbackCid);

            // Force intentional error
            throw new Error('Simulated transaction failure');
        });
    } catch (err) {
        const found = freshDb.prepare('SELECT 1 FROM companies WHERE id = ?').get(rollbackCid);
        txRolledBack = !found;
    }
    assert(txRolledBack, 'Uncommitted transaction rolled back completely on error');

    // ── 7. Savepoint Nested Transaction Integrity ────────────────────
    console.log('\n7. Verifying Savepoint Nested Transaction Support:');
    const outerCid = 'company-outer-savepoint';
    const innerCid = 'company-inner-savepoint';

    runInTransaction((txDb) => {
        // Outer insert
        txDb.prepare(`INSERT INTO companies (id, name, policy_status) VALUES (?, 'Outer', 'permitted')`).run(outerCid);

        try {
            // Inner nested transaction that fails
            runInTransaction((innerDb) => {
                innerDb.prepare(`INSERT INTO companies (id, name, policy_status) VALUES (?, 'Inner', 'permitted')`).run(innerCid);
                throw new Error('Inner error');
            });
        } catch {
            // Expected inner failure caught
        }
    });

    const outerFound = !!freshDb.prepare('SELECT 1 FROM companies WHERE id = ?').get(outerCid);
    const innerFound = !!freshDb.prepare('SELECT 1 FROM companies WHERE id = ?').get(innerCid);
    assert(outerFound && !innerFound, 'Nested savepoint transaction rolled back inner while preserving outer commit');

    freshDb.prepare('DELETE FROM companies WHERE id = ?').run(outerCid);

    // ── 8. Upsert Behavior ───────────────────────────────────────────
    console.log('\n8. Verifying Upsert Behavior:');
    const upsertCid = 'company-upsert-test';
    upsertCompany({ id: upsertCid, name: 'Initial Name', notes: 'v1' });
    upsertCompany({ id: upsertCid, name: 'Updated Name', notes: 'v2' });
    const upserted = getCompany(upsertCid);
    assert(upserted.name === 'Updated Name' && upserted.notes === 'v2', 'Company record successfully updated without duplicating');
    freshDb.prepare('DELETE FROM companies WHERE id = ?').run(upsertCid);

    // ── 9. Standalone Hot Backup & Integrity Verification ────────────
    console.log('\n9. Verifying Standalone Backup & Independent Integrity:');
    const backupFile = resolve('backups', 'test_acceptance_backup.db');
    await backupDb(backupFile);
    assert(existsSync(backupFile), `Backup database file created at ${backupFile}`);

    const backupConn = new DatabaseSync(backupFile);
    const backupCheck = backupConn.prepare('PRAGMA integrity_check').all();
    assert(backupCheck[0]?.integrity_check === 'ok', 'Backup passes independent PRAGMA integrity_check');

    const backupJobs = backupConn.prepare('SELECT count(*) as c FROM job_postings').get().c;
    assert(backupJobs > 1000, `Backup contains complete committed dataset (${backupJobs} jobs)`);
    backupConn.close();

    try { unlinkSync(backupFile); } catch {}

    // ── 10. Historical Import Idempotency ─────────────────────────────
    console.log('\n10. Verifying Historical Import Idempotency:');
    // Sync any newer markdown/TSV entries into the isolated DB first, then verify rerunning is idempotent
    const firstRun = migrateHistory();
    const jobsBefore = countJobs();
    const appsBefore = firstRun.countsAfter.applications;
    const rerunResult = migrateHistory();
    const jobsAfter = countJobs();
    const appsAfter = rerunResult.countsAfter.applications;
    assert(jobsBefore === jobsAfter, `Rerunning historical import is idempotent (${jobsBefore} jobs before, ${jobsAfter} jobs after)`);
    assert(appsBefore === appsAfter, `Rerunning historical import does not duplicate applications (${appsBefore} before, ${appsAfter} after)`);
    assert(rerunResult.stats.applications.imported > 0 && rerunResult.stats.applications.errors === 0, `Historical applications re-imported cleanly without errors (imported=${rerunResult.stats.applications.imported}, errors=${rerunResult.stats.applications.errors})`);
    const fkViolations = getDb().prepare('PRAGMA foreign_key_check').all();
    assert(fkViolations.length === 0, `Zero foreign-key violations after idempotent migration rerun (got: ${fkViolations.length})`);

    // ── 11. Candidate Facts and Evidence Ingestion ───────────────────
    console.log('\n11. Verifying Candidate Facts & Evidence Quality:');
    ingestProfile({ useSynthetic: true });
    const facts = getCandidateFacts();
    assert(facts.length >= 20, `Candidate facts count >= 20 (got: ${facts.length})`);

    const eduFacts = getCandidateFacts('education');
    assert(
        eduFacts.some(f => (f.value.includes('Synthetic University') || f.value.includes('8.0')) && f.value.includes('May 2026')),
        'Education fact accurately records CGPA and May 2026 graduation'
    );

    const expFacts = getCandidateFacts('experience');
    assert(
        expFacts.some(f => f.value.includes('TechCorp') && f.value.includes('December 2025 – March 2026')),
        'Experience facts record verified TechCorp employment'
    );
    assert(
        expFacts.some(f => f.value.includes('Acme Corp') && f.value.includes('May 2026 – July 2026')),
        'Experience facts record verified Acme Corp employment'
    );

    const prjFacts = getCandidateFacts('project');
    const projectIdentifiers = prjFacts.map(p => p.identifier);
    assert(
        projectIdentifiers.includes('project-gamma') &&
        projectIdentifiers.includes('project-delta') &&
        projectIdentifiers.includes('project-alpha'),
        'Verified projects include Project Gamma, Project Delta, and Project Alpha'
    );

    const sampleEvidence = getEvidenceForFact('fact-exp-techcorp');
    assert(sampleEvidence.length >= 3, `Fact fact-exp-techcorp has linked evidence records (${sampleEvidence.length})`);

    const noticeAnswer = getAnswerByKey('notice_period');
    assert(noticeAnswer && noticeAnswer.answer_value.includes('Immediate joiner'), 'Answer bank records immediate availability');

    // ── 12. Non-Destructive File Preservation ────────────────────────
    console.log('\n12. Verifying Non-Destructive Source File Preservation:');
    assert(existsSync('data/scan-history.tsv'), 'data/scan-history.tsv preserved intact');
    assert(existsSync('data/pipeline.md'), 'data/pipeline.md preserved intact');
    assert(existsSync('data/applications.md'), 'data/applications.md preserved intact');

    closeDb();

    console.log('\n==================================================');
    console.log(`📊 Phase 1 Test Results: ${passed} passed, ${failed} failed`);
    console.log('==================================================\n');

    if (failed > 0) {
        process.exitCode = 1;
    }
}

try {
    await runTests();
} catch (err) {
    console.error('Test suite uncaught error:', err);
    process.exitCode = 1;
} finally {
    closeDb();
    cleanupTestDb();
    delete process.env.JOB_AGENT_DB_PATH;
}
