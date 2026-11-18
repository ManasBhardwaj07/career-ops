/**
 * test-matching-guards.mjs — Comprehensive Test Suite for Matching Guards & Title Taxonomy
 *
 * Implements Deliverable 5 Phase 1 & Forensic Corrections:
 *   - Tier 1 Deterministic Title Screening (Negative Blocklist + QA-Only Exclusion)
 *   - Target Engineering Archetypes (SDE, Backend, Fullstack, Frontend, Platform/DevOps, Freshers)
 *   - Priority Taxonomy Weighting (No positive priority for QA-only roles)
 *   - Defect A Correction: Unspecified stack role receives natural CONSIDER (no artificial 0.75 jump)
 *   - Defect B Correction: QA-only roles fail closed at Tier 1 (R19)
 *   - Canonical Database Immutability Check
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
    titleScreening,
    getPriorityWeightForTitle,
    evaluateJobOffer,
    PRIORITY_TAXONOMY,
    NEGATIVE_TITLE_PATTERNS
} from './matching/pipeline.mjs';

// Enforce test isolation flag
process.env.CAREER_OPS_TEST = '1';

const CANONICAL_DB_PATH = path.resolve('data/job_agent.db');

function getFileHash(filePath) {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(content).digest('hex');
}

const CANONICAL_HASH_BEFORE = getFileHash(CANONICAL_DB_PATH);

console.log('====================================================');
console.log('🧪 DELIVERABLE 5 — MATCHING GUARDS & AUDIT CORRECTIONS');
console.log('====================================================\n');

let testPassed = 0;
let testFailed = 0;

function test(name, fn) {
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

// ── 1. Non-Tech & QA-Only Title Blocklist (Must Fail Tier 1) ───────────────
console.log('--- 1. Non-Tech & QA-Only Title Blocklist (M1 & Defect B) ---');

const BLOCKED_TITLES = [
    'Sales Executive',
    'Business Development Executive (IT)',
    'BDE - Enterprise Software Sales',
    'Content Writer & Copywriter',
    'Digital Marketing Specialist',
    'HR Recruiter / Talent Acquisition',
    'Telecaller - Inbound & Outbound',
    'Customer Support Associate (Voice Process)',
    'Data Entry Operator / Back Office',
    'Accountant / Tally Operator',
    'Operations Executive',
    'Warehouse & Logistics Coordinator',
    // Defect B: QA-only & pure test specialist exclusions
    'SDET',
    'QA Engineer',
    'Quality Assurance Engineer',
    'Test Automation Engineer',
    'Software Engineer in Test'
];

for (const title of BLOCKED_TITLES) {
    test(`Block non-target role: "${title}"`, () => {
        const res = titleScreening({ title, description: '' });
        assert.strictEqual(res.passed, false, `Expected "${title}" to be blocked at Tier 1`);
        assert(res.rejectedKeywords.length > 0, `Expected rejected keywords for "${title}"`);
    });
}

// ── 2. Legitimate Engineering Titles (Must Pass Tier 1) ───────────────────
console.log('\n--- 2. Legitimate Engineering Titles & Freshers (M2/M3) ---');

const LEGITIMATE_TECH = [
    'SDE I',
    'Software Engineer',
    'Full Stack Developer',
    'Backend Engineer',
    'Frontend Developer',
    'Graduate Engineer Trainee',
    'Software Engineer Trainee',
    'Associate Software Engineer',
    'Junior Software Developer',
    'DevOps Engineer',
    'Cloud Engineer',
    'Site Reliability Engineer',
    'Platform Engineer'
];

for (const title of LEGITIMATE_TECH) {
    test(`Pass legitimate engineering title: "${title}"`, () => {
        const res = titleScreening({ title, description: '' });
        assert.strictEqual(res.passed, true, `Expected "${title}" to pass Tier 1 title screening`);
        assert(res.matchedKeywords.length > 0, `Expected matched keywords for "${title}"`);
    });
}

// ── 3. Broader Engineering Role with QA Responsibilities ──────────────────
console.log('\n--- 3. Engineering Roles with Testing Scope ---');

test('Broader Software Engineer role with testing scope in description passes Tier 1', () => {
    const job = {
        title: 'Software Engineer',
        description: 'Design RESTful APIs, write clean TypeScript code, and implement unit and integration testing.'
    };
    const res = titleScreening(job);
    assert.strictEqual(res.passed, true);
    assert(res.matchedKeywords.some(k => k.toLowerCase().includes('software engineer')));
});

// ── 4. Priority Taxonomy Weighting (M2 & Defect B) ─────────────────────────
console.log('\n--- 4. Priority Taxonomy Weighting (M2 & Defect B) ---');

test('Priority taxonomy assigns expected multipliers without QA priority', () => {
    assert.strictEqual(getPriorityWeightForTitle('SDE I'), 1.15);
    assert.strictEqual(getPriorityWeightForTitle('Senior Backend Engineer'), 1.15);
    assert.strictEqual(getPriorityWeightForTitle('Full Stack Developer (MERN)'), 1.15);
    assert.strictEqual(getPriorityWeightForTitle('React Frontend Developer'), 1.10);
    assert.strictEqual(getPriorityWeightForTitle('DevOps & Cloud Engineer'), 1.10);
    // QA-only roles must NOT have priority weighting
    assert.strictEqual(getPriorityWeightForTitle('SDET / Quality Engineer'), 1.0);
    assert.strictEqual(getPriorityWeightForTitle('General Unconventional Title'), 1.0);
});

// ── 5. Defect A: Unspecified Stack Role Remains CONSIDER ───────────────────
console.log('\n--- 5. Unspecified Stack Natural Scoring (Defect A Correction) ---');

test('Unspecified stack role receives natural score (CONSIDER) without artificial 0.75 uplift', () => {
    const job = {
        title: 'Graduate Engineer Trainee',
        location: 'Bengaluru, India',
        workplace_type: 'hybrid',
        applicant_eligibility: 'Open to India',
        description: 'We are hiring fresh engineering graduates for our general technology rotation program.'
    };

    const mockFacts = [
        { category: 'work_authorization', identifier: 'work_authorization_india', value: 'Authorized to work in India', verified: true },
        { category: 'education', identifier: 'college_degree', value: 'B.Tech CSE', verified: true },
        { category: 'skill', identifier: 'javascript', value: 'JavaScript', verified: true },
        { category: 'skill', identifier: 'nodejs', value: 'Node.js', verified: true },
        { category: 'experience', identifier: 'total_months', value: '7', verified: true }
    ];

    const evalResult = evaluateJobOffer(job, mockFacts, []);
    assert.strictEqual(evalResult.tier1.passed, true);
    assert.strictEqual(evalResult.tier2.eligibility, 'PASS');

    // Absence of stack evidence must NOT yield an artificial >= 0.70 APPLY score
    assert(evalResult.tier3.matchScore < 0.70, `Expected matchScore < 0.70, got ${evalResult.tier3.matchScore}`);
    assert.strictEqual(evalResult.recommendation, 'CONSIDER', `Expected CONSIDER recommendation, got ${evalResult.recommendation}`);
});

// ── 6. Non-Tech Block Rejection Guarantee at Tier 1 (R19) ───────────────────
console.log('\n--- 6. Non-Tech Block Rejection Guarantee at Tier 1 (R19) ---');

test('Non-tech role is blocked at Tier 1 and never evaluates Tier 3', () => {
    const nonTechJob = {
        title: 'Sales & Business Development Associate',
        location: 'Bengaluru, India',
        description: 'Requires candidate with strong communication skills and React/Node familiarity.'
    };

    const evalResult = evaluateJobOffer(nonTechJob, [], []);
    assert.strictEqual(evalResult.tier1.passed, false);
    assert.strictEqual(evalResult.tier3, null); // Tier 3 was never evaluated
    assert.strictEqual(evalResult.recommendation, 'DO_NOT_APPLY');
});

// ── 7. Canonical Database Immutability Check ────────────────────────────────
console.log('\n--- 7. Canonical Database Immutability Check ---');

test('Canonical database SHA-256 remains byte-identical', () => {
    const hashAfter = getFileHash(CANONICAL_DB_PATH);
    assert.strictEqual(hashAfter, CANONICAL_HASH_BEFORE, 'Canonical database hash must not change during test!');
});

console.log('\n====================================================');
console.log(`📊 Matching Guards Results: ${testPassed} PASSED, ${testFailed} FAILED`);
console.log('====================================================');

if (testFailed > 0) {
    process.exit(1);
}
