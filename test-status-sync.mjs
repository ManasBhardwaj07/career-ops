/**
 * test-status-sync.mjs — Comprehensive Test Suite for Tracking Outcome Feed & Status Sync
 *
 * Implements Deliverable 5 Phase 5:
 *   - Recruiter email outcome classification (T1)
 *   - Application matching via company hints & job titles (T2)
 *   - User confirmation gating before outcome mutation (T3)
 *   - Recurring runner status-sync stage integration
 *   - Canonical database immutability verification
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import {
    CANONICAL_OUTCOMES,
    parseRecruiterEmail,
    extractCompanyHint,
    matchEmailToApplication,
    ingestRecruiterEmail,
    confirmOutcomeProposal
} from './tracking/email-ingest.mjs';

// Enforce test isolation flag
process.env.CAREER_OPS_TEST = '1';

const CANONICAL_DB_PATH = path.resolve('data/job_agent.db');
const TEST_DB_PATH = path.resolve('data/test_status_sync.db');

function getFileHash(filePath) {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(content).digest('hex');
}

const CANONICAL_HASH_BEFORE = getFileHash(CANONICAL_DB_PATH);

console.log('====================================================');
console.log('🧪 DELIVERABLE 5 — TRACKING OUTCOME FEED & STATUS SYNC');
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
    CREATE TABLE job_postings (
        id TEXT PRIMARY KEY,
        company_name TEXT NOT NULL,
        title TEXT NOT NULL,
        job_url TEXT
    );

    CREATE TABLE applications (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        state TEXT NOT NULL,
        recruitment_outcome TEXT NOT NULL DEFAULT 'applied',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE application_events (
        id TEXT PRIMARY KEY,
        application_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        from_state TEXT,
        to_state TEXT,
        payload TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    INSERT INTO job_postings VALUES
    ('job_swiggy_1', 'Swiggy', 'Full Stack Developer', 'https://swiggy.careers/1'),
    ('job_razorpay_1', 'Razorpay', 'Backend Engineer', 'https://razorpay.careers/1'),
    ('job_cred_1', 'CRED', 'Frontend Engineer', 'https://cred.club/1');

    INSERT INTO applications (id, job_id, state, recruitment_outcome) VALUES
    ('app_swiggy', 'job_swiggy_1', 'CONFIRMED', 'applied'),
    ('app_razorpay', 'job_razorpay_1', 'CONFIRMED', 'applied'),
    ('app_cred', 'job_cred_1', 'CONFIRMED', 'interview');
`);

console.log('--- 1. Recruiter Email Classification (T1) ---');

runTest('Classifies rejection email into REJECTED canonical outcome', () => {
    const email = {
        subject: 'Update on your application for Full Stack Developer at Swiggy',
        from: 'talent@swiggy.in',
        body: 'Thank you for your interest in Swiggy. Unfortunately, we have decided to move forward with other candidates whose profiles more closely align with our current needs. We wish you the best in your job search.'
    };

    const res = parseRecruiterEmail(email);
    assert.strictEqual(res.outcome, CANONICAL_OUTCOMES.REJECTED);
    assert(res.confidence >= 0.90);
    assert(res.matchedSnippets.some(s => s.includes('decided to move forward with other candidates')));
    assert.strictEqual(res.companyHint, 'Swiggy');
});

runTest('Classifies interview / assessment invitation into INTERVIEW canonical outcome', () => {
    const email = {
        subject: 'Invitation to Technical Screen - Backend Engineer [Razorpay]',
        from: 'recruiting@razorpay.com',
        body: 'Hi Jordan, We were impressed with your background and would like to schedule an interview with our engineering manager. Please choose a time on my calendar using the link below.'
    };

    const res = parseRecruiterEmail(email);
    assert.strictEqual(res.outcome, CANONICAL_OUTCOMES.INTERVIEW);
    assert(res.confidence >= 0.90);
    assert(res.matchedSnippets.some(s => s.includes('schedule an interview')));
    assert.strictEqual(res.companyHint, 'Razorpay');
});

runTest('Classifies offer letter email into OFFER canonical outcome', () => {
    const email = {
        subject: 'Offer of Employment: CRED Engineering Team',
        from: 'hr@cred.club',
        body: 'Dear Jordan, We are pleased to offer you the position of Software Engineer at CRED. Please find attached your formal offer letter and compensation package.'
    };

    const res = parseRecruiterEmail(email);
    assert.strictEqual(res.outcome, CANONICAL_OUTCOMES.OFFER);
    assert(res.confidence >= 0.95);
    assert(res.matchedSnippets.some(s => s.includes('pleased to offer you') || s.includes('offer letter') || s.includes('Offer of Employment')));
    assert.strictEqual(res.companyHint, 'CRED');
});

runTest('Classifies initial application receipt into RESPONDED canonical outcome', () => {
    const email = {
        subject: 'Thank you for applying to Swiggy',
        from: 'no-reply@swiggy.in',
        body: 'We have received your application for Full Stack Developer. Our team is currently reviewing your profile.'
    };

    const res = parseRecruiterEmail(email);
    assert.strictEqual(res.outcome, CANONICAL_OUTCOMES.RESPONDED);
    assert.strictEqual(res.companyHint, 'Swiggy');
});

console.log('\n--- 2. Application Matching (T2) ---');

runTest('Matches email correctly to target application record in SQLite', () => {
    const email = {
        subject: 'Your application with Swiggy',
        from: 'careers@swiggy.in',
        body: 'Regarding your application for Full Stack Developer.'
    };

    const parsed = parseRecruiterEmail(email);
    const matched = matchEmailToApplication(testDb, parsed);
    assert(matched !== null);
    assert.strictEqual(matched.id, 'app_swiggy');
    assert.strictEqual(matched.company_name, 'Swiggy');
    assert.strictEqual(matched.job_title, 'Full Stack Developer');
});

console.log('\n--- 3. User Confirmation Gating (T3) ---');

runTest('Ingesting email without user confirmation holds proposal in PENDING_USER_CONFIRMATION', () => {
    const email = {
        subject: 'Update from Swiggy',
        from: 'talent@swiggy.in',
        body: 'Unfortunately we have decided to move forward with other candidates.'
    };

    const proposal = ingestRecruiterEmail(testDb, email, { requireUserConfirmation: true });
    assert.strictEqual(proposal.status, 'PENDING_USER_CONFIRMATION');
    assert.strictEqual(proposal.proposed_outcome, CANONICAL_OUTCOMES.REJECTED);
    assert.strictEqual(proposal.application_id, 'app_swiggy');

    // Verify database record has NOT mutated
    const currentApp = testDb.prepare(`SELECT recruitment_outcome FROM applications WHERE id = 'app_swiggy'`).get();
    assert.strictEqual(currentApp.recruitment_outcome, 'applied', 'Database outcome must not mutate without user confirmation!');
});

runTest('Duplicate email ingestion is idempotent and does NOT duplicate proposals', () => {
    const email = {
        subject: 'Update from Swiggy',
        from: 'talent@swiggy.in',
        body: 'Unfortunately we have decided to move forward with other candidates.'
    };

    const duplicateProposal = ingestRecruiterEmail(testDb, email, { requireUserConfirmation: true });
    assert.strictEqual(duplicateProposal.is_duplicate, true);
    assert.strictEqual(duplicateProposal.skipped, true);
});

runTest('Explicit user confirmation applies outcome change and records audit event', () => {
    const res = confirmOutcomeProposal(testDb, 'app_swiggy', CANONICAL_OUTCOMES.REJECTED);
    assert.strictEqual(res.confirmed, true);
    assert.strictEqual(res.updated_outcome, CANONICAL_OUTCOMES.REJECTED);

    // Verify DB updated
    const updatedApp = testDb.prepare(`SELECT recruitment_outcome FROM applications WHERE id = 'app_swiggy'`).get();
    assert.strictEqual(updatedApp.recruitment_outcome, CANONICAL_OUTCOMES.REJECTED);

    // Verify audit event
    const evt = testDb.prepare(`SELECT event_type, from_state, to_state FROM application_events WHERE application_id = 'app_swiggy'`).get();
    assert(evt !== undefined);
    assert.strictEqual(evt.event_type, 'OUTCOME_CONFIRMED_BY_USER');
    assert.strictEqual(evt.to_state, CANONICAL_OUTCOMES.REJECTED);
});

console.log('\n--- 4. Canonical Database Immutability Check ---');

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
console.log(`📊 Status Sync Results: ${testPassed} PASSED, ${testFailed} FAILED`);
console.log('====================================================');

if (testFailed > 0) {
    process.exit(1);
}
