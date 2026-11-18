/**
 * test-employer-registry-m2b.mjs — Integration Test Suite for Milestone 2B
 *
 * Verifies all Milestone 2B criteria:
 *   1. Canonical schema migration 006: extended companies, company_aliases, granular source_policies.
 *   2. Domain normalization (handles protocols, www, ports, paths, subdomains, case).
 *   3. Company creation, updates, and domain conflict prevention.
 *   4. Alias registration, idempotency, and multi-key resolution (name, alias, domain).
 *   5. Parent/subsidiary hierarchy and foreign-key integrity.
 *   6. Career page URL and ATS board registration.
 *   7. Granular source policy permissions and hard ethical submission gate.
 *   8. Lifecycle state machine transitions and automatic side-effects.
 *   9. Seed dataset import and repeat import idempotency.
 *  10. Coverage report calculation accuracy against raw SQL.
 *  11. Persistence across database close/re-open and PRAGMA integrity check.
 */

import { existsSync, unlinkSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const TEST_DB_PATH = resolve(process.cwd(), 'data/test_employer_registry_m2b.db');
const CANONICAL_DB_PATH = resolve(process.cwd(), 'data/job_agent.db');
process.env.JOB_AGENT_DB_PATH = TEST_DB_PATH;

const { getDb, closeDb, getDbPath } = await import('./db/db.mjs');
const resolvedDbPath = resolve(getDbPath());
if (resolvedDbPath === CANONICAL_DB_PATH) {
    throw new Error(`SAFETY ABORT: test-employer-registry-m2b.mjs resolved to canonical DB (${resolvedDbPath})`);
}

const { runMigrations } = await import('./db/migrate.js');
const {
    createCompany,
    updateCompany,
    upsertCompany,
    getCompany,
    getCompanyByDomain,
    findCompanyByNameOrAlias,
    getAllCompanies,
    addCompanyAlias,
    getCompanyAliases,
    registerCareerPage,
    registerAtsBoard,
    setCompanyLifecycleStatus,
    setMonitoringStatus,
    listUnverifiedCompanies,
    listCompaniesMissingCareerUrl,
    listCompaniesMissingAts,
    getRegistryCoverageReport,
    normalizeDomain,
    upsertSourcePolicy,
    isSourcePermitted,
    verifyIntegrity,
    VALID_LIFECYCLE_TRANSITIONS
} = await import('./db/repo.mjs');
const { importCompanies } = await import('./scripts/manage-companies.mjs');

let passedTests = 0;
let failedTests = 0;

function assert(condition, testName, details = '') {
    if (condition) {
        passedTests++;
        console.log(`  [PASS] ${testName}`);
    } else {
        failedTests++;
        console.error(`  [FAIL] ${testName}${details ? ' - ' + details : ''}`);
    }
}

function assertThrows(fn, testName, expectedErrorSubstr = '') {
    try {
        fn();
        failedTests++;
        console.error(`  [FAIL] ${testName} - Expected error was not thrown`);
    } catch (err) {
        if (expectedErrorSubstr && !err.message.includes(expectedErrorSubstr)) {
            failedTests++;
            console.error(`  [FAIL] ${testName} - Error message "${err.message}" did not contain "${expectedErrorSubstr}"`);
        } else {
            passedTests++;
            console.log(`  [PASS] ${testName}`);
        }
    }
}

async function runMilestone2BTests() {
    console.log('===============================================================');
    console.log('       MILESTONE 2B — EMPLOYER REGISTRY TEST SUITE             ');
    console.log('===============================================================\n');

    // 0. Setup clean isolated test database
    if (existsSync(TEST_DB_PATH)) {
        closeDb();
        unlinkSync(TEST_DB_PATH);
    }

    console.log('--- Test Suite 1: Schema Migration & Canonical Structure ---');
    runMigrations();
    const db = getDb();

    // Verify company table columns
    const companyCols = db.prepare('PRAGMA table_info(companies)').all().map(c => c.name);
    assert(companyCols.includes('website_url'), 'companies table has website_url');
    assert(companyCols.includes('country'), 'companies table has country');
    assert(companyCols.includes('industry'), 'companies table has industry');
    assert(companyCols.includes('size_band'), 'companies table has size_band');
    assert(companyCols.includes('source_provenance'), 'companies table has source_provenance');
    assert(companyCols.includes('lifecycle_status'), 'companies table has lifecycle_status');
    assert(companyCols.includes('monitoring_status'), 'companies table has monitoring_status');
    assert(companyCols.includes('parent_company_id'), 'companies table has parent_company_id');
    assert(companyCols.includes('last_verified_at'), 'companies table has last_verified_at');

    // Verify company_aliases table
    const aliasCols = db.prepare('PRAGMA table_info(company_aliases)').all().map(c => c.name);
    assert(aliasCols.includes('id'), 'company_aliases table has id');
    assert(aliasCols.includes('company_id'), 'company_aliases table has company_id');
    assert(aliasCols.includes('alias'), 'company_aliases table has alias');
    assert(aliasCols.includes('source'), 'company_aliases table has source');

    // Verify granular source_policies columns
    const policyCols = db.prepare('PRAGMA table_info(source_policies)').all().map(c => c.name);
    assert(policyCols.includes('discovery_permitted'), 'source_policies has discovery_permitted');
    assert(policyCols.includes('public_nav_permitted'), 'source_policies has public_nav_permitted');
    assert(policyCols.includes('feed_access_permitted'), 'source_policies has feed_access_permitted');
    assert(policyCols.includes('authenticated_permitted'), 'source_policies has authenticated_permitted');
    assert(policyCols.includes('autofill_permitted'), 'source_policies has autofill_permitted');
    assert(policyCols.includes('submission_permitted'), 'source_policies has submission_permitted');

    console.log('\n--- Test Suite 2: Domain Normalization ---');
    assert(normalizeDomain('https://www.example.com') === 'example.com', 'normalizeDomain strips https:// and www.');
    assert(normalizeDomain('http://sub.domain.co.uk:8080/jobs?id=123#ref') === 'sub.domain.co.uk', 'normalizeDomain strips http, port, query, hash');
    assert(normalizeDomain('  HTTPS://WWW.ANTHROPIC.COM/  ') === 'anthropic.com', 'normalizeDomain handles whitespace, uppercase, trailing slash');
    assert(normalizeDomain('palantir.com.') === 'palantir.com', 'normalizeDomain strips trailing dot');
    assert(normalizeDomain(null) === null, 'normalizeDomain returns null for null input');
    assert(normalizeDomain('') === null, 'normalizeDomain returns null for empty string');

    console.log('\n--- Test Suite 3: Company Creation & Domain Conflict Prevention ---');
    createCompany({
        id: 'company-acme',
        name: 'Acme Corp',
        domain: 'https://www.acme.com/about',
        website_url: 'https://acme.com',
        country: 'US',
        industry: 'Robotics',
        size_band: '201-500',
        lifecycle_status: 'UNVERIFIED'
    });

    const acme = getCompany('company-acme');
    assert(acme !== null && acme.name === 'Acme Corp', 'Company created successfully');
    assert(acme.domain === 'acme.com', 'Domain normalized during creation');
    assert(acme.country === 'US' && acme.size_band === '201-500', 'Country and size band stored');

    // Duplicate ID must fail
    assertThrows(() => {
        createCompany({ id: 'company-acme', name: 'Duplicate Acme', domain: 'acme2.com' });
    }, 'Duplicate company ID throws error', 'Company with ID already exists');

    // Duplicate domain must fail
    assertThrows(() => {
        createCompany({ id: 'company-acme-clone', name: 'Clone Acme', domain: 'acme.com' });
    }, 'Duplicate company domain throws error', 'Company with domain already exists');

    // Direct domain lookup
    const foundByDomain = getCompanyByDomain('https://acme.com/jobs');
    assert(foundByDomain && foundByDomain.id === 'company-acme', 'getCompanyByDomain resolves via raw URL');

    console.log('\n--- Test Suite 4: Alias Registration & Resolution ---');
    addCompanyAlias('company-acme', 'Acme Inc', 'manual_test');
    addCompanyAlias('company-acme', 'Acme Industries', 'manual_test');
    // Idempotent add of same alias
    addCompanyAlias('company-acme', 'Acme Inc', 'manual_test');

    const aliases = getCompanyAliases('company-acme');
    assert(aliases.length === 2, 'Duplicate alias registration is idempotent (2 unique aliases)');
    assert(aliases.map(a => a.alias).includes('Acme Inc'), 'Alias Acme Inc registered');

    // Resolution by name
    assert(findCompanyByNameOrAlias('Acme Corp')?.id === 'company-acme', 'Resolves by exact name');
    assert(findCompanyByNameOrAlias('acme corp')?.id === 'company-acme', 'Resolves by lowercase name');
    // Resolution by alias
    assert(findCompanyByNameOrAlias('Acme Inc')?.id === 'company-acme', 'Resolves by alias "Acme Inc"');
    assert(findCompanyByNameOrAlias('acme industries')?.id === 'company-acme', 'Resolves by case-insensitive alias');
    // Resolution by domain
    assert(findCompanyByNameOrAlias('acme.com')?.id === 'company-acme', 'Resolves by domain');

    console.log('\n--- Test Suite 5: Parent / Subsidiary Hierarchy & Foreign Keys ---');
    createCompany({
        id: 'company-parent',
        name: 'Parent Holdings',
        domain: 'parentholdings.com',
        lifecycle_status: 'VERIFIED'
    });

    createCompany({
        id: 'company-sub',
        name: 'Subsidiary Ventures',
        domain: 'subventures.com',
        parent_company_id: 'company-parent',
        lifecycle_status: 'VERIFIED'
    });

    const sub = getCompany('company-sub');
    assert(sub.parent_company_id === 'company-parent', 'Subsidiary correctly links to parent');

    // Invalid parent FK must throw SQLite constraint error
    assertThrows(() => {
        db.prepare(`
            INSERT INTO companies (id, name, domain, parent_company_id)
            VALUES ('company-orphan', 'Orphan Co', 'orphan.com', 'non-existent-parent')
        `).run();
    }, 'Foreign key constraint prevents linking to non-existent parent', 'FOREIGN KEY constraint failed');

    console.log('\n--- Test Suite 6: Career Page & ATS Board Registration ---');
    registerCareerPage('company-acme', 'https://jobs.acme.com');
    const acmeAfterCareer = getCompany('company-acme');
    assert(acmeAfterCareer.career_url === 'https://jobs.acme.com', 'Career URL registered');

    registerAtsBoard('company-acme', 'greenhouse', 'acme');
    const acmeAfterAts = getCompany('company-acme');
    assert(acmeAfterAts.ats_type === 'greenhouse' && acmeAfterAts.board_identifier === 'acme', 'ATS board registered');

    console.log('\n--- Test Suite 7: Granular Source Policies & Ethical Submission Gate ---');
    upsertSourcePolicy({
        id: 'policy-acme-gh',
        company_id: 'company-acme',
        source_type: 'greenhouse',
        endpoint: 'https://boards.greenhouse.io/acme',
        enabled: true,
        discovery_permitted: true,
        public_nav_permitted: true,
        feed_access_permitted: true,
        authenticated_permitted: false,
        autofill_permitted: false,
        submission_permitted: false
    });

    assert(isSourcePermitted('company-acme', 'greenhouse', 'discovery') === true, 'Discovery permitted on active policy');
    assert(isSourcePermitted('company-acme', 'greenhouse', 'public_nav') === true, 'Public nav permitted');
    assert(isSourcePermitted('company-acme', 'greenhouse', 'feed_access') === true, 'Feed access permitted');
    assert(isSourcePermitted('company-acme', 'greenhouse', 'authenticated') === false, 'Authenticated access disallowed');
    assert(isSourcePermitted('company-acme', 'greenhouse', 'autofill') === false, 'Autofill disallowed');
    // Hard gate check
    assert(isSourcePermitted('company-acme', 'greenhouse', 'submission') === false, 'Submission PERMANENTLY blocked');

    // Attempting to pass submission_permitted: true must be forced to false
    upsertSourcePolicy({
        id: 'policy-acme-gh',
        company_id: 'company-acme',
        source_type: 'greenhouse',
        endpoint: 'https://boards.greenhouse.io/acme',
        enabled: true,
        submission_permitted: true // Malicious attempt to enable submission
    });
    const policyRow = db.prepare('SELECT submission_permitted FROM source_policies WHERE id = ?').get('policy-acme-gh');
    assert(policyRow.submission_permitted === 0, 'submission_permitted hard-gate forces 0 in repository');
    assert(isSourcePermitted('company-acme', 'greenhouse', 'submission') === false, 'isSourcePermitted rejects submission even if requested');

    console.log('\n--- Test Suite 8: Lifecycle State Machine Transitions ---');
    // Acme starts UNVERIFIED
    assert(getCompany('company-acme').lifecycle_status === 'UNVERIFIED', 'Acme initial status is UNVERIFIED');

    // UNVERIFIED -> VERIFIED (allowed)
    setCompanyLifecycleStatus('company-acme', 'VERIFIED', 'Domain and career page verified');
    const acmeVerified = getCompany('company-acme');
    assert(acmeVerified.lifecycle_status === 'VERIFIED', 'Transitioned to VERIFIED');
    assert(acmeVerified.last_verified_at !== null, 'last_verified_at set on VERIFIED');

    // VERIFIED -> APPROVED (allowed)
    setCompanyLifecycleStatus('company-acme', 'APPROVED', 'Approved for pipeline targeting');
    assert(getCompany('company-acme').lifecycle_status === 'APPROVED', 'Transitioned to APPROVED');

    // APPROVED -> MONITORING (allowed)
    setCompanyLifecycleStatus('company-acme', 'MONITORING', 'Active scanner target');
    const acmeMonitoring = getCompany('company-acme');
    assert(acmeMonitoring.lifecycle_status === 'MONITORING', 'Transitioned to MONITORING');
    assert(acmeMonitoring.monitoring_status === 'active', 'monitoring_status set to active on MONITORING');

    // MONITORING -> DISABLED (allowed)
    setCompanyLifecycleStatus('company-acme', 'DISABLED', 'Temporarily pausing company');
    const acmeDisabled = getCompany('company-acme');
    assert(acmeDisabled.lifecycle_status === 'DISABLED', 'Transitioned to DISABLED');
    assert(acmeDisabled.monitoring_status === 'disabled', 'monitoring_status set to disabled on DISABLED');

    // DISABLED -> REJECTED (allowed)
    setCompanyLifecycleStatus('company-acme', 'REJECTED', 'Permanent block');
    assert(getCompany('company-acme').lifecycle_status === 'REJECTED', 'Transitioned to REJECTED');

    // REJECTED -> MONITORING (invalid transition - must throw)
    assertThrows(() => {
        setCompanyLifecycleStatus('company-acme', 'MONITORING');
    }, 'Invalid transition REJECTED -> MONITORING throws error', 'Invalid lifecycle transition');

    console.log('\n--- Test Suite 9: Seed Dataset Import & Repeat Idempotency ---');
    const seedPath = resolve(process.cwd(), 'data/seed_companies.json');
    const seedRaw = JSON.parse(readFileSync(seedPath, 'utf8'));
    console.log(`  Importing ${seedRaw.length} seed companies from ${seedPath}...`);

    const importRes1 = importCompanies(seedPath);
    assert(importRes1.totalInFile === seedRaw.length, `First import processed ${seedRaw.length} records`);
    assert(importRes1.created === seedRaw.length, `First import created all ${seedRaw.length} companies`);

    // Verify parent-subsidiary in seed dataset (Blinkit -> Zomato)
    const blinkit = getCompany('company-blinkit');
    assert(blinkit !== null, 'Blinkit exists in database');
    assert(blinkit.parent_company_id === 'company-zomato', 'Blinkit correctly linked to Zomato parent');

    // Verify aliases from seed dataset
    const anthropicAliases = getCompanyAliases('company-anthropic');
    assert(anthropicAliases.map(a => a.alias).includes('Anthropic PBC'), 'Anthropic PBC alias registered from seed');

    // Run Second Import (Idempotency test)
    console.log('  Running second identical import for idempotency check...');
    const importRes2 = importCompanies(seedPath);
    assert(importRes2.created === 0, 'Second import created 0 new companies');
    assert(importRes2.updated === seedRaw.length, `Second import updated existing ${seedRaw.length} companies`);
    assert(importRes2.coverageBefore.total_companies === importRes2.coverageAfter.total_companies, 'Total company count unchanged');

    console.log('\n--- Test Suite 10: Registry Coverage Report Accuracy ---');
    const coverage = getRegistryCoverageReport();

    const sqlTotal = db.prepare('SELECT count(*) as c FROM companies').get().c;
    const sqlWithWebsite = db.prepare('SELECT count(*) as c FROM companies WHERE website_url IS NOT NULL').get().c;
    const sqlWithCareer = db.prepare('SELECT count(*) as c FROM companies WHERE career_url IS NOT NULL').get().c;
    const sqlWithAts = db.prepare('SELECT count(*) as c FROM companies WHERE ats_type IS NOT NULL AND board_identifier IS NOT NULL').get().c;
    const sqlUnverified = db.prepare("SELECT count(*) as c FROM companies WHERE lifecycle_status = 'UNVERIFIED'").get().c;
    const sqlVerified = db.prepare("SELECT count(*) as c FROM companies WHERE lifecycle_status = 'VERIFIED'").get().c;
    const sqlApproved = db.prepare("SELECT count(*) as c FROM companies WHERE lifecycle_status = 'APPROVED'").get().c;

    assert(coverage.total_companies === sqlTotal, `Coverage total matches SQL (${coverage.total_companies} === ${sqlTotal})`);
    assert(coverage.with_website_count === sqlWithWebsite, `Coverage with_website matches SQL (${coverage.with_website_count} === ${sqlWithWebsite})`);
    assert(coverage.with_career_url_count === sqlWithCareer, `Coverage with_career_url matches SQL (${coverage.with_career_url_count} === ${sqlWithCareer})`);
    assert(coverage.with_ats_count === sqlWithAts, `Coverage with_ats matches SQL (${coverage.with_ats_count} === ${sqlWithAts})`);
    assert(coverage.unverified_companies === sqlUnverified, `Coverage unverified matches SQL (${coverage.unverified_companies} === ${sqlUnverified})`);
    assert(coverage.verified_companies === sqlVerified, `Coverage verified matches SQL (${coverage.verified_companies} === ${sqlVerified})`);
    assert(coverage.approved_companies === sqlApproved, `Coverage approved matches SQL (${coverage.approved_companies} === ${sqlApproved})`);

    console.log('\n--- Test Suite 11: Database Persistence & PRAGMA Integrity Check ---');
    closeDb();
    // Re-open via getDb()
    const db2 = getDb();
    const countAfterReopen = db2.prepare('SELECT count(*) as c FROM companies').get().c;
    assert(countAfterReopen === sqlTotal, 'All companies persisted across DB close and re-open');

    const integrity = verifyIntegrity();
    assert(integrity === true, 'Database passes PRAGMA integrity_check');

    const fkCheck = db2.prepare('PRAGMA foreign_key_check').all();
    assert(fkCheck.length === 0, 'Database passes PRAGMA foreign_key_check with 0 violations');

    // Teardown test DB
    closeDb();
    if (existsSync(TEST_DB_PATH)) {
        unlinkSync(TEST_DB_PATH);
    }
    delete process.env.JOB_AGENT_DB_PATH;

    console.log('\n===============================================================');
    console.log(`TOTAL PASSED: ${passedTests}`);
    console.log(`TOTAL FAILED: ${failedTests}`);
    console.log('===============================================================\n');

    if (failedTests > 0) {
        process.exit(1);
    }
}

runMilestone2BTests().catch(err => {
    console.error('Fatal Test Runner Error:', err);
    process.exit(1);
});
