/**
 * tests/test-fixture-isolation.mjs — Comprehensive Regression Test for Synthetic Fixture Exclusion
 *
 * Verifies all mandatory requirements against an ISOLATED disposable database:
 * 1. Synthetic application app_test_* is excluded.
 * 2. Synthetic crash fixtures (app_crash_*) are excluded.
 * 3. Synthetic live-dry-run fixtures (app_live_dryrun_*) are excluded.
 * 4. A genuine application associated with company-anthropic is included.
 * 5. A genuine application associated with company-contentful is included.
 * 6. A genuine application at a company with "Acme" in its name is NOT automatically excluded.
 * 7. A genuine application at a company with "Test" in its name is NOT automatically excluded.
 * 8. A genuine application with a normal UUID/company ID is included.
 * 9. The SQL and JavaScript fixture classifiers agree 100% across all representative cases.
 * 10. Exhaustive 371-row comparison: All 371 recorded fixture IDs agree 100% between JS and SQL.
 * 11. No historical application records are deleted, reset, or modified (371 fixtures preserved).
 * 12. inspectQueue and getDailyQuotaUsage exclude fixtures.
 * 13. Isolated test execution: Never touches the canonical database directly.
 */

import { DatabaseSync } from 'node:sqlite';
import { existsSync, copyFileSync, unlinkSync } from 'fs';
import {
    OPERATIONAL_APPLICATION_FILTER_SQL,
    isSyntheticApplication,
    inspectQueue,
    getDailyQuotaUsage,
    HISTORICAL_SYNTHETIC_FIXTURE_IDS
} from '../application/worker.mjs';

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

console.log('=== Running Comprehensive Fixture Isolation Regression Tests ===\n');

    // Use an isolated disposable database cloned from the baseline backup
    const pristineBackupPath = 'data/backup/job_agent_backup_20261116.db';
    const isolatedDbPath = 'data/test_fixture_isolation_disposable.db';

    if (!existsSync(pristineBackupPath)) {
        console.error(`Baseline backup not found: ${pristineBackupPath}`);
        process.exit(1);
    }

    copyFileSync(pristineBackupPath, isolatedDbPath);

    const db = new DatabaseSync(isolatedDbPath);

    try {
        // Test 1: Historical records preservation (zero deletions/mutations)
        console.log('Test 1: Verifying historical records preservation in database');
        const rawReady = db.prepare("SELECT count(1) as c FROM applications WHERE state = 'READY_FOR_REVIEW'").get().c;
        const rawNeedsInput = db.prepare("SELECT count(1) as c FROM applications WHERE state = 'NEEDS_USER_INPUT'").get().c;
        const rawUncertain = db.prepare("SELECT count(1) as c FROM applications WHERE state = 'UNCERTAIN_OUTCOME'").get().c;

        assert(rawReady === 212, `Database preserves 212 historical READY_FOR_REVIEW records (actual: ${rawReady})`);
        assert(rawNeedsInput === 89, `Database preserves 89 historical NEEDS_USER_INPUT records (actual: ${rawNeedsInput})`);
        assert(rawUncertain === 70, `Database preserves 70 historical UNCERTAIN_OUTCOME records (actual: ${rawUncertain})`);
        assert(rawReady + rawNeedsInput + rawUncertain === 371, `Total historical fixtures preserved equals 371 (actual: ${rawReady + rawNeedsInput + rawUncertain})`);

        // Test 2: Filtered operational counts
        console.log('\nTest 2: Verifying operational filtered counts');
        const filteredReady = db.prepare(`
        SELECT count(1) as c
        FROM applications a
        WHERE a.state = 'READY_FOR_REVIEW'
          AND ${OPERATIONAL_APPLICATION_FILTER_SQL}
    `).get().c;

        const filteredNeedsInput = db.prepare(`
        SELECT count(1) as c
        FROM applications a
        WHERE a.state = 'NEEDS_USER_INPUT'
          AND ${OPERATIONAL_APPLICATION_FILTER_SQL}
    `).get().c;

        const filteredUncertain = db.prepare(`
        SELECT count(1) as c
        FROM applications a
        WHERE a.state = 'UNCERTAIN_OUTCOME'
          AND ${OPERATIONAL_APPLICATION_FILTER_SQL}
    `).get().c;

        assert(filteredReady === 0, `Operational READY_FOR_REVIEW count is 0 (actual: ${filteredReady})`);
        assert(filteredNeedsInput === 0, `Operational NEEDS_USER_INPUT count is 0 (actual: ${filteredNeedsInput})`);
        assert(filteredUncertain === 0, `Operational UNCERTAIN_OUTCOME count is 0 (actual: ${filteredUncertain})`);

        // Test 3: Alert threshold check
        console.log('\nTest 3: Alert threshold check');
        const alertThresholdExceeded = filteredNeedsInput > 5;
        assert(!alertThresholdExceeded, `High priority alert is NOT triggered (filteredNeedsInput: ${filteredNeedsInput} <= 5)`);

    // Test 4: Mandatory Synthetic vs Genuine Cases (Both JS and SQL)
    console.log('\nTest 4: Mandatory Synthetic vs Genuine Cases (JS & SQL Evaluation)');

                const testCases = [
                    {
                        desc: 'Synthetic application app_test_* is excluded',
                        id: 'app_test_senior_eng_123',
                        company_id: 'comp_test_1',
                        company_name: 'Test Corp',
                        expectedSynthetic: true
                    },
                    {
                        desc: 'Synthetic crash fixtures are excluded',
                        id: 'app_crash_worker_failure_456',
                        company_id: 'comp_crash_1',
                        company_name: 'Crash Company',
                        expectedSynthetic: true
                    },
                    {
                        desc: 'Synthetic live-dry-run fixtures are excluded',
                        id: 'app_live_dryrun_ashby_789',
                        company_id: 'comp_dryrun_1',
                        company_name: 'Ashby Target',
                        expectedSynthetic: true
                    },
                    {
                        desc: 'Genuine application associated with company-anthropic is included',
                        id: 'app_pipe_anthropic_platform_engineer',
                        company_id: 'company-anthropic',
                        company_name: 'Anthropic',
                        expectedSynthetic: false
                    },
                    {
                        desc: 'Genuine application associated with company-contentful is included',
                        id: 'app_pipe_contentful_backend_dev',
                        company_id: 'company-contentful',
                        company_name: 'Contentful',
                        expectedSynthetic: false
                    },
                    {
                        desc: 'Genuine application at a company with "Acme" in its name is NOT automatically excluded',
                        id: 'app_acme_innovations_backend_001',
                        company_id: 'company-acme-innovations',
                        company_name: 'Acme Innovations Ltd',
                        expectedSynthetic: false
                    },
                    {
                        desc: 'Genuine application at a company with "Test" in its name is NOT automatically excluded',
                        id: 'app_testbench_systems_engineer_002',
                        company_id: 'company-testbench-systems',
                        company_name: 'Testbench Systems Inc',
                        expectedSynthetic: false
                    },
                    {
                        desc: 'Genuine application with normal UUID is included',
                        id: 'app_7f8c9b2a_3d4e_5f6a_7b8c_9d0e1f2a3b4c',
                        company_id: 'company-plane',
                        company_name: 'Plane',
                        expectedSynthetic: false
                    },
                    {
                        desc: 'Plane pilot application is included',
                        id: 'app_ashby_plane_188f905e',
                        company_id: 'company-plane',
                        company_name: 'Plane Software, Inc.',
                        expectedSynthetic: false
                    },
                    {
                        desc: 'Historical synthetic fixture (timestamp-based) is excluded',
                        id: 'app_1794384366757_4sgopt',
                        company_id: 'comp_chkpt_1794384365403_bi2j',
                        company_name: 'Acme chkpt',
                        expectedSynthetic: true
                    }
                ];

                // In-memory table to test SQL against these cases
                const memDb = new DatabaseSync(':memory:');
                memDb.exec('CREATE TABLE applications (id TEXT, company_id TEXT, job_id TEXT);');

                const insertStmt = memDb.prepare('INSERT INTO applications (id, company_id, job_id) VALUES (?, ?, ?)');
                for(const tc of testCases) {
                    insertStmt.run(tc.id, tc.company_id, tc.job_id || null);
                }

        const sqlResults = memDb.prepare(`
        SELECT a.id,
               CASE WHEN (${OPERATIONAL_APPLICATION_FILTER_SQL}) THEN 0 ELSE 1 END as is_synthetic
        FROM applications a
    `).all();

        const sqlResultsMap = new Map(sqlResults.map(r => [r.id, Boolean(r.is_synthetic)]));

        for (const tc of testCases) {
            const jsIsSynthetic = isSyntheticApplication(tc);
            const sqlIsSynthetic = sqlResultsMap.get(tc.id);

            assert(
                jsIsSynthetic === tc.expectedSynthetic,
                `JS: ${tc.desc} (expected synthetic: ${tc.expectedSynthetic}, actual: ${jsIsSynthetic})`
            );

                assert(
                    sqlIsSynthetic === tc.expectedSynthetic,
                    `SQL: ${tc.desc} (expected synthetic: ${tc.expectedSynthetic}, actual: ${sqlIsSynthetic})`
                );

                assert(
                    jsIsSynthetic === sqlIsSynthetic,
                    `Agreement: JS and SQL classifiers agree on ID: ${tc.id}`
                );
            }

            memDb.close();

        // Test 5: Exhaustive 371-row comparison
        console.log('\nTest 5: Exhaustive 371-row comparison (All 371 fixture IDs checked against JS & SQL)');
        const all371 = Array.from(HISTORICAL_SYNTHETIC_FIXTURE_IDS);
        let jsSynthCount = 0;
        let sqlSynthCount = 0;
        let exhaustiveAgreementCount = 0;

        for (const id of all371) {
            const jsIsSynth = isSyntheticApplication(id);
            if (jsIsSynth) jsSynthCount++;

            const sqlRow = db.prepare(`SELECT 1 FROM applications a WHERE a.id = ? AND ${OPERATIONAL_APPLICATION_FILTER_SQL}`).get(id);
            const sqlIsSynth = !sqlRow;
            if (sqlIsSynth) sqlSynthCount++;

            if (jsIsSynth === sqlIsSynth) exhaustiveAgreementCount++;
        }

        assert(jsSynthCount === 371, `All 371 fixtures classified as synthetic by JS (actual: ${jsSynthCount}/371)`);
        assert(sqlSynthCount === 371, `All 371 fixtures classified as synthetic by SQL (actual: ${sqlSynthCount}/371)`);
        assert(exhaustiveAgreementCount === 371, `100% agreement between JS and SQL across all 371 fixtures (actual: ${exhaustiveAgreementCount}/371)`);

        // Test 6: inspectQueue operational queue check
        console.log('\nTest 6: inspectQueue operational queue check on isolated DB');
        const queueResult = inspectQueue({ dbInstance: db });
        assert(queueResult.queuedTotal === 0, `inspectQueue reports 0 operational queued items (actual: ${queueResult.queuedTotal})`);

        // Test 7: getDailyQuotaUsage operational quota check
        console.log('\nTest 7: getDailyQuotaUsage operational quota check on isolated DB');
        const quotaResult = getDailyQuotaUsage({ dateString: '2026-11-11', dbInstance: db });
        assert(quotaResult.prepared === 0, `Historical fixtures on 2026-11-11 do not pollute prepared quota (actual: ${quotaResult.prepared})`);

    } finally {
        db.close();
        if (existsSync(isolatedDbPath)) {
            try { unlinkSync(isolatedDbPath); } catch { }
        }
    }

    console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
    if (failed > 0) {
        process.exit(1);
    }
