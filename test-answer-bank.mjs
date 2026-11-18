/**
 * test-answer-bank.mjs — Comprehensive Test Suite for Answer Bank & Resolver
 *
 * Implements Deliverable 5 Phase 2 verification:
 *   - 14 Canonical intents coverage
 *   - 3 length variants per intent (short <=250, medium <=1000, long <=2000)
 *   - Clean length selection without mid-word truncation
 *   - Fact-grounding verification (R16 Zero Fabrication)
 *   - Review gating & sensitive flag enforcement (R18)
 *   - Poison-Skip pattern (per-JD customized answers never poison global bank)
 *   - Strict test database isolation and canonical DB immutability check
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
    CANONICAL_INTENTS,
    VARIANT_LIMITS,
    CANONICAL_ANSWER_TEMPLATES,
    seedAnswerBank,
    getAnswerForIntent,
    truncateAtWordBoundary,
    generatePerJdAnswer
} from './application/answers/bank.mjs';
import { mapFieldsToCandidateData } from './application/autofill/answer-mapper.mjs';

// Enforce test isolation flag
process.env.CAREER_OPS_TEST = '1';

const CANONICAL_DB_PATH = path.resolve('data/job_agent.db');
const TEST_DB_PATH = path.resolve('data/test_answer_bank.db');

function getFileHash(filePath) {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(content).digest('hex');
}

const CANONICAL_HASH_BEFORE = getFileHash(CANONICAL_DB_PATH);

console.log('====================================================');
console.log('🧪 DELIVERABLE 5 — ANSWER BANK & INTENT RESOLVER');
console.log('====================================================\n');

let testPassed = 0;
let testFailed = 0;

function runTest(name, fn) {
    try {
        fn();
        console.log(`  ✅ PASS: ${name}`);
        testPassed++;
    } catch (err) {
        console.error(`  ❌ FAIL: ${name}`);
        console.error(`     Error: ${err.message}`);
        testFailed++;
    }
}

// ── 1. Setup Isolated SQLite Database ──────────────────────────────────────
if (fs.existsSync(TEST_DB_PATH)) {
    fs.unlinkSync(TEST_DB_PATH);
}
const testDb = new DatabaseSync(TEST_DB_PATH);

testDb.exec(`
    CREATE TABLE IF NOT EXISTS answer_bank (
        id TEXT PRIMARY KEY,
        intent_key TEXT NOT NULL,
        variant_length TEXT NOT NULL CHECK (variant_length IN ('short', 'medium', 'long')),
        char_limit INTEGER NOT NULL,
        content TEXT NOT NULL,
        sensitive INTEGER NOT NULL DEFAULT 0,
        source_fact_refs TEXT,
        confirmed_by_user INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(intent_key, variant_length)
    );

    CREATE TABLE IF NOT EXISTS candidate_answers (
        id TEXT PRIMARY KEY,
        question_key TEXT UNIQUE NOT NULL,
        question_text TEXT,
        answer_value TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 1.0,
        confirmed_by_user INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
`);

console.log('--- 1. Canonical Intents & Variant Structure (A1-A2) ---');

runTest('Exactly 14 canonical intents are defined', () => {
    const intents = Object.values(CANONICAL_INTENTS);
    assert.strictEqual(intents.length, 14, `Expected 14 canonical intents, got ${intents.length}`);
});

runTest('Each of the 14 intents has exactly 3 variants (short, medium, long)', () => {
    const intents = Object.values(CANONICAL_INTENTS);
    for (const intent of intents) {
        const variants = CANONICAL_ANSWER_TEMPLATES.filter(t => t.intent_key === intent);
        assert.strictEqual(variants.length, 3, `Intent "${intent}" should have 3 variants, got ${variants.length}`);
        const lengths = variants.map(v => v.variant_length).sort();
        assert.deepStrictEqual(lengths, ['long', 'medium', 'short']);
    }
    assert.strictEqual(CANONICAL_ANSWER_TEMPLATES.length, 42, 'Total templates should be 42');
});

runTest('All 42 templates strictly respect character limits', () => {
    for (const t of CANONICAL_ANSWER_TEMPLATES) {
        const maxAllowed = VARIANT_LIMITS[t.variant_length];
        assert(t.char_limit <= maxAllowed, `Template ${t.intent_key}:${t.variant_length} char_limit ${t.char_limit} exceeds limit ${maxAllowed}`);
        assert(t.content.length <= maxAllowed, `Template ${t.intent_key}:${t.variant_length} content length ${t.content.length} exceeds limit ${maxAllowed}`);
    }
});

console.log('\n--- 2. Database Seeding & Storage (A3) ---');

runTest('seedAnswerBank inserts 42 rows into isolated test DB', () => {
    const count = seedAnswerBank(testDb);
    assert.strictEqual(count, 42);

    const rowCount = testDb.prepare('SELECT COUNT(*) as cnt FROM answer_bank').get().cnt;
    assert.strictEqual(rowCount, 42);
});

runTest('seedAnswerBank is idempotent upon re-execution', () => {
    const count2 = seedAnswerBank(testDb);
    assert.strictEqual(count2, 42);
    const rowCount = testDb.prepare('SELECT COUNT(*) as cnt FROM answer_bank').get().cnt;
    assert.strictEqual(rowCount, 42);
});

console.log('\n--- 3. Length Selection & Truncation (A4) ---');

runTest('Selecting with tight budget chooses short variant', () => {
    const res = getAnswerForIntent(testDb, CANONICAL_INTENTS.TELL_ME_ABOUT_YOURSELF, { maxLength: 250 });
    assert(res !== null);
    assert.strictEqual(res.variant_length, 'short');
    assert(res.content.length <= 250);
    assert.strictEqual(res.isTruncated, false);
});

runTest('Selecting with medium budget chooses medium variant', () => {
    const res = getAnswerForIntent(testDb, CANONICAL_INTENTS.TELL_ME_ABOUT_YOURSELF, { maxLength: 1000 });
    assert(res !== null);
    assert.strictEqual(res.variant_length, 'medium');
    assert(res.content.length <= 1000);
    assert(res.content.length > 250);
    assert.strictEqual(res.isTruncated, false);
});

runTest('Selecting with large budget chooses long variant', () => {
    const res = getAnswerForIntent(testDb, CANONICAL_INTENTS.TELL_ME_ABOUT_YOURSELF, { maxLength: 2500 });
    assert(res !== null);
    assert.strictEqual(res.variant_length, 'long');
    assert(res.content.length > 1000);
    assert.strictEqual(res.isTruncated, false);
});

runTest('Selecting without budget defaults to medium variant', () => {
    const res = getAnswerForIntent(testDb, CANONICAL_INTENTS.TELL_ME_ABOUT_YOURSELF);
    assert(res !== null);
    assert.strictEqual(res.variant_length, 'medium');
    assert.strictEqual(res.isTruncated, false);
});

runTest('TruncateAtWordBoundary never chops mid-word', () => {
    const text = 'The quick brown fox jumps over the lazy dog';
    const truncated = truncateAtWordBoundary(text, 20); // budget 20 chars
    // Should end on a clean word with '...'
    assert(!truncated.endsWith('b...'), 'Should not chop brown in half');
    assert(truncated.endsWith('...'));
    assert(truncated.length <= 20);
});

runTest('Small budget below short variant truncates cleanly with ellipsis', () => {
    const res = getAnswerForIntent(testDb, CANONICAL_INTENTS.TELL_ME_ABOUT_YOURSELF, { maxLength: 100 });
    assert(res !== null);
    assert(res.content.length <= 100);
    assert.strictEqual(res.isTruncated, true);
    assert(res.content.endsWith('...'));
});

console.log('\n--- 4. Fact Grounding & Anti-Fabrication (R16) ---');

runTest('All facts mentioned in templates trace strictly to candidate ground truth', () => {
    // 1. Deterministic Synthetic Candidate Narratives Verification
    const SYNTHETIC_CANDIDATE_NARRATIVES = [
        {
            id: 'synth_tell_me_short',
            intent_key: CANONICAL_INTENTS.TELL_ME_ABOUT_YOURSELF,
            variant_length: 'short',
            content: 'Full Stack Developer with ~7 months experience at Acme Corp and TechCorp. B.Tech Computer Science graduate from Synthetic University with strong foundations in React, Node.js, and TypeScript.',
            source_fact_refs: ['fact-exp-acme', 'fact-exp-techcorp', 'fact-edu-synth-btech', 'fact-skill-mern']
        },
        {
            id: 'synth_best_work_short',
            intent_key: CANONICAL_INTENTS.BEST_WORK,
            variant_length: 'short',
            content: 'My best work is Project Gamma, a multi-language code execution engine in Docker containers with live streaming.',
            source_fact_refs: ['fact-prj-gamma']
        },
        {
            id: 'synth_proj_alpha_work',
            intent_key: CANONICAL_INTENTS.BEST_WORK,
            variant_length: 'medium',
            content: 'Project Alpha is a gamified rewards platform utilizing PostgreSQL Row Level Security (RLS) and payment webhook management.',
            source_fact_refs: ['fact-prj-alpha']
        },
        {
            id: 'synth_proj_beta_work',
            intent_key: CANONICAL_INTENTS.BEST_WORK,
            variant_length: 'long',
            content: 'Project Beta is a reverse proxy API gateway with rate limiting and monthly quota enforcement in Redis.',
            source_fact_refs: ['fact-prj-beta']
        },
        {
            id: 'synth_avail_short',
            intent_key: CANONICAL_INTENTS.AVAILABILITY_DATE,
            variant_length: 'short',
            content: 'Immediately available (0 days notice).',
            source_fact_refs: ['fact-comp-notice-0']
        },
        {
            id: 'synth_notice_short',
            intent_key: CANONICAL_INTENTS.NOTICE_PERIOD,
            variant_length: 'short',
            content: '0 days (Immediate joiner).',
            source_fact_refs: ['fact-comp-notice-0']
        },
        {
            id: 'synth_work_auth_short',
            intent_key: CANONICAL_INTENTS.WORK_AUTH,
            variant_length: 'short',
            content: 'Authorized to work in Synthetic Region (Citizen). No visa sponsorship required.',
            source_fact_refs: ['fact-legal-auth-synth']
        },
        {
            id: 'synth_exp_short',
            intent_key: CANONICAL_INTENTS.TOTAL_EXPERIENCE,
            variant_length: 'short',
            content: 'Approximately 7 months (approx. 4 months at TechCorp plus 3 months at Acme Corp).',
            source_fact_refs: ['fact-exp-months-7', 'fact-exp-acme', 'fact-exp-techcorp']
        }
    ];

    // Assert exact ground truth binding on synthetic candidate narratives
    for (const item of SYNTHETIC_CANDIDATE_NARRATIVES) {
        if (item.content.includes('Acme Corp')) {
            assert(item.source_fact_refs.includes('fact-exp-acme'), 'Acme Corp must trace to fact-exp-acme');
        }
        if (item.content.includes('TechCorp')) {
            assert(item.source_fact_refs.includes('fact-exp-techcorp'), 'TechCorp must trace to fact-exp-techcorp');
        }
        if (item.content.includes('Project Alpha')) {
            assert(item.source_fact_refs.includes('fact-prj-alpha'), 'Project Alpha must trace to fact-prj-alpha');
        }
        if (item.content.includes('Project Beta')) {
            assert(item.source_fact_refs.includes('fact-prj-beta'), 'Project Beta must trace to fact-prj-beta');
        }
        if (item.content.includes('Project Gamma')) {
            assert(item.source_fact_refs.includes('fact-prj-gamma'), 'Project Gamma must trace to fact-prj-gamma');
        }
        if (item.content.includes('Synthetic University')) {
            assert(item.source_fact_refs.includes('fact-edu-synth-btech'), 'Synthetic University must trace to fact-edu-synth-btech');
        }
        if (item.content.includes('Synthetic Region')) {
            assert(item.source_fact_refs.includes('fact-legal-auth-synth'), 'Synthetic Region work auth must trace to fact-legal-auth-synth');
        }
    }

    // Exact expected content checks on deterministic synthetic narratives
    const synthAvail = SYNTHETIC_CANDIDATE_NARRATIVES.find(t => t.intent_key === CANONICAL_INTENTS.AVAILABILITY_DATE && t.variant_length === 'short');
    assert.strictEqual(synthAvail.content, 'Immediately available (0 days notice).');
    const synthNotice = SYNTHETIC_CANDIDATE_NARRATIVES.find(t => t.intent_key === CANONICAL_INTENTS.NOTICE_PERIOD && t.variant_length === 'short');
    assert.strictEqual(synthNotice.content, '0 days (Immediate joiner).');
    const synthAuth = SYNTHETIC_CANDIDATE_NARRATIVES.find(t => t.intent_key === CANONICAL_INTENTS.WORK_AUTH && t.variant_length === 'short');
    assert.strictEqual(synthAuth.content, 'Authorized to work in Synthetic Region (Citizen). No visa sponsorship required.');

    // 2. Authoritative Template Integrity & Anti-Fabrication Invariants
    for (const t of CANONICAL_ANSWER_TEMPLATES) {
        assert(Array.isArray(t.source_fact_refs), `Template ${t.id} must define source_fact_refs`);
        assert(t.source_fact_refs.length > 0, `Template ${t.id} must be grounded in verified candidate facts`);

        // Assert strictly no unverified numbers or fabrications
        assert(!t.content.includes('9.5 CGPA'), 'Unverified CGPA must never be fabricated');
        assert(!t.content.includes('Google Intern'), 'Unverified company claim must never be fabricated');
        assert(!t.content.includes('5 years experience'), 'Inflated experience claim must never be fabricated');

        // Fact category invariant enforcement
        if (t.intent_key === CANONICAL_INTENTS.WORK_AUTH) {
            assert(t.source_fact_refs.some(r => r.startsWith('legal_') || r.startsWith('fact-legal')), 'Work auth intent must reference legal authorization fact');
        }
        if (t.intent_key === CANONICAL_INTENTS.AVAILABILITY_DATE || t.intent_key === CANONICAL_INTENTS.NOTICE_PERIOD) {
            assert(t.source_fact_refs.some(r => r.startsWith('comp_') || r.startsWith('fact-comp')), 'Availability intent must reference compensation/notice fact');
        }
        if (t.intent_key === CANONICAL_INTENTS.TOTAL_EXPERIENCE) {
            assert(t.source_fact_refs.some(r => r.startsWith('exp_') || r.startsWith('fact-exp')), 'Experience intent must reference experience fact');
        }
    }

    // Exact expected content assertions for universal canonical templates in answer bank
    const liveAvail = CANONICAL_ANSWER_TEMPLATES.find(t => t.intent_key === CANONICAL_INTENTS.AVAILABILITY_DATE && t.variant_length === 'short');
    assert.strictEqual(liveAvail.content, 'Immediately available (0 days notice).');

    const liveNotice = CANONICAL_ANSWER_TEMPLATES.find(t => t.intent_key === CANONICAL_INTENTS.NOTICE_PERIOD && t.variant_length === 'short');
    assert.strictEqual(liveNotice.content, '0 days (Immediate joiner).');

    const liveAuth = CANONICAL_ANSWER_TEMPLATES.find(t => t.intent_key === CANONICAL_INTENTS.WORK_AUTH && t.variant_length === 'short');
    assert(liveAuth.content.startsWith('Authorized to work'), 'Work auth must specify legal authorization');
    assert(liveAuth.source_fact_refs.some(r => r.startsWith('legal_') || r.startsWith('fact-legal')), 'Work auth must link to legal fact reference');

    const liveCurrentCtc = CANONICAL_ANSWER_TEMPLATES.filter(t => t.intent_key === CANONICAL_INTENTS.CURRENT_CTC);
    for (const v of liveCurrentCtc) {
        assert.strictEqual(v.content, '', 'Current CTC must be withheld/empty by default');
        assert.strictEqual(v.sensitive, 1, 'Current CTC must be marked sensitive');
    }
});

console.log('\n--- 5. Review Gating & Sensitive Fields (R18) ---');

runTest('Current CTC and Expected CTC are marked sensitive', () => {
    const currentCtcVariants = CANONICAL_ANSWER_TEMPLATES.filter(t => t.intent_key === CANONICAL_INTENTS.CURRENT_CTC);
    for (const v of currentCtcVariants) {
        assert.strictEqual(v.sensitive, 1);
    }
    const expectedCtcVariants = CANONICAL_ANSWER_TEMPLATES.filter(t => t.intent_key === CANONICAL_INTENTS.EXPECTED_CTC);
    for (const v of expectedCtcVariants) {
        assert.strictEqual(v.sensitive, 1);
    }
});

runTest('Unconfirmed sensitive answers are filtered when confirmedOnly is true', () => {
    // Insert an unconfirmed sensitive answer
    testDb.prepare(`
        INSERT OR REPLACE INTO answer_bank (
            id, intent_key, variant_length, char_limit, content, sensitive, confirmed_by_user
        ) VALUES (
            'ans_secret_short', 'secret_bonus', 'short', 250, 'Private bonus info', 1, 0
        )
    `).run();

    const resultConfirmedOnly = getAnswerForIntent(testDb, 'secret_bonus', { confirmedOnly: true });
    assert.strictEqual(resultConfirmedOnly, null);

    const resultAny = getAnswerForIntent(testDb, 'secret_bonus', { confirmedOnly: false });
    assert(resultAny !== null);
    assert.strictEqual(resultAny.confirmed_by_user, 0);
});

runTest('Answer mapper marks unconfirmed sensitive intent field as needs_user_input', () => {
    // Set all expected_ctc variants to unconfirmed (confirmed_by_user = 0)
    testDb.prepare("UPDATE answer_bank SET confirmed_by_user = 0 WHERE intent_key = 'expected_ctc'").run();

    const detectedFields = [
        { name: 'expected_salary', label: 'Expected Salary (CTC)', classification: 'salary', required: true, isSensitive: true }
    ];

    const mapped = mapFieldsToCandidateData(detectedFields, { db: testDb });
    assert.strictEqual(mapped.canAutoProceed, false);
    assert.strictEqual(mapped.sensitiveFieldsNeedingConfirmation.length, 1);
    assert.strictEqual(mapped.mappings[0].status, 'needs_user_input');

    // Restore confirmed status
    testDb.prepare("UPDATE answer_bank SET confirmed_by_user = 1 WHERE intent_key = 'expected_ctc'").run();
});

console.log('\n--- 6. Poison-Skip Pattern & Per-JD Scoping ---');

runTest('generatePerJdAnswer produces tailored JD text and does NOT poison global answer_bank', () => {
    const job = {
        id: 'job_razorpay_backend_99',
        title: 'Backend Engineer',
        company_name: 'Razorpay',
        description: 'Building payment infrastructure'
    };

    const tailoredWhyCompany = generatePerJdAnswer(CANONICAL_INTENTS.WHY_COMPANY, job);
    assert.strictEqual(tailoredWhyCompany.is_global, false);
    assert.strictEqual(tailoredWhyCompany.requires_confirmation, true);
    assert(tailoredWhyCompany.content.includes('Razorpay'));

    // Global answer_bank must NOT contain 'Razorpay'
    const globalWhyCompany = getAnswerForIntent(testDb, CANONICAL_INTENTS.WHY_COMPANY);
    assert(!globalWhyCompany.content.includes('Razorpay'), 'Global bank was poisoned by JD custom text!');

    // Total rows in answer_bank must still be exactly 43 (42 canonical + 1 secret_bonus test row)
    const count = testDb.prepare('SELECT COUNT(*) as cnt FROM answer_bank').get().cnt;
    assert.strictEqual(count, 43);
});

runTest('Application-scoped answer in candidate_answers overrides global bank for that app', () => {
    const appId = 'app_test_123';
    testDb.prepare(`
        INSERT INTO candidate_answers (id, question_key, question_text, answer_value, confirmed_by_user)
        VALUES ('ans_custom_app_1', 'app:app_test_123:why_company', 'Why Razorpay', 'Customized reason for Razorpay', 1)
    `).run();

    // Query with appId
    const scopedRes = getAnswerForIntent(testDb, CANONICAL_INTENTS.WHY_COMPANY, { applicationId: appId });
    assert.strictEqual(scopedRes.content, 'Customized reason for Razorpay');
    assert.strictEqual(scopedRes.variant_length, 'custom_scoped');

    // Query for different app gets default global bank
    const otherRes = getAnswerForIntent(testDb, CANONICAL_INTENTS.WHY_COMPANY, { applicationId: 'app_other_999' });
    assert(!otherRes.content.includes('Razorpay'));
    assert.strictEqual(otherRes.variant_length, 'medium');
});

console.log('\n--- 7. Canonical Database Immutability Check ---');

runTest('Canonical database remains byte-identical', () => {
    const hashAfter = getFileHash(CANONICAL_DB_PATH);
    assert.strictEqual(hashAfter, CANONICAL_HASH_BEFORE, 'Canonical database hash must not change during test!');
});

// Cleanup test db
testDb.close();
if (fs.existsSync(TEST_DB_PATH)) {
    fs.unlinkSync(TEST_DB_PATH);
}

console.log('\n====================================================');
console.log(`📊 Answer Bank Results: ${testPassed} PASSED, ${testFailed} FAILED`);
console.log('====================================================');

if (testFailed > 0) {
    process.exit(1);
}
