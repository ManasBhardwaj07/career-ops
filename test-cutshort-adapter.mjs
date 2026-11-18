/**
 * test-cutshort-adapter.mjs — Cutshort Portal Adapter Verification
 *
 * Verifies Deliverable 6 (Portal 1 in sequence):
 * 1. Handles missing session cleanly (AUTHENTICATION_REQUIRED, no destructive error).
 * 2. Handles expired session cleanly (SESSION_EXPIRED).
 * 3. Handles Cloudflare Turnstile block safely (BLOCKED_BY_CHALLENGE, fail-closed).
 * 4. Normalizes valid authenticated response into standard career-ops jobs.
 * 5. Passes normalized jobs through matching guards.
 */

import assert from 'assert';
import path from 'path';
import fs from 'fs';
import { CutshortAdapter } from './discovery/adapters/cutshort-adapter.mjs';
import { SessionVault } from './discovery/sessions/session-vault.mjs';
import { evaluateJobOffer } from './matching/pipeline.mjs';

let passed = 0;
let failed = 0;

function it(desc, fn) {
    try {
        fn();
        console.log(`  ✓ ${desc}`);
        passed++;
    } catch (err) {
        console.error(`  ✗ ${desc}`);
        console.error(err);
        failed++;
    }
}

async function itAsync(desc, fn) {
    try {
        await fn();
        console.log(`  ✓ ${desc}`);
        passed++;
    } catch (err) {
        console.error(`  ✗ ${desc}`);
        console.error(err);
        failed++;
    }
}

console.log('=== Running Cutshort Adapter Tests ===\n');

// Use temp directory for isolated session testing
const tempVaultDir = path.resolve('scratch/test-cutshort-sessions');
if (fs.existsSync(tempVaultDir)) {
    fs.rmSync(tempVaultDir, { recursive: true, force: true });
}
fs.mkdirSync(tempVaultDir, { recursive: true });

const mockVault = new SessionVault(tempVaultDir);

// Test 1: Missing session
await itAsync('Missing session returns AUTHENTICATION_REQUIRED cleanly', async () => {
    const adapter = new CutshortAdapter({ vault: mockVault });
    const result = await adapter.fetchJobs();
    assert.strictEqual(result.status, 'AUTHENTICATION_REQUIRED');
    assert.strictEqual(result.authenticated, false);
    assert.strictEqual(result.requiresInteractiveLogin, true);
    assert.strictEqual(result.jobs.length, 0);
});

// Test 2: Expired session in vault
await itAsync('Expired session returns AUTHENTICATION_REQUIRED without fetching', async () => {
    mockVault.saveSession('cutshort', {
        expiresAt: new Date(Date.now() - 3600000).toISOString(),
        cookies: [{ name: 'cutshort_authentication', value: 'expired_token', expires: Math.floor(Date.now() / 1000) - 3600 }]
    });

    const adapter = new CutshortAdapter({ vault: mockVault });
    const result = await adapter.fetchJobs();
    assert.strictEqual(result.status, 'AUTHENTICATION_REQUIRED');
    assert.strictEqual(result.jobs.length, 0);
});

// Test 3: Upstream returns 401 Unauthorized
await itAsync('Upstream 401 returns SESSION_EXPIRED', async () => {
    mockVault.saveSession('cutshort', {
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        cookies: [{ name: 'cutshort_authentication', value: 'some_token', expires: Math.floor(Date.now() / 1000) + 86400 }]
    });

    const mockFetch = async () => ({
        status: 401,
        ok: false,
        text: async () => 'Unauthorized'
    });

    const adapter = new CutshortAdapter({ vault: mockVault, fetchFn: mockFetch });
    const result = await adapter.fetchJobs();
    assert.strictEqual(result.status, 'SESSION_EXPIRED');
    assert.strictEqual(result.requiresInteractiveLogin, true);
    assert.strictEqual(result.jobs.length, 0);
});

// Test 4: Upstream returns Cloudflare Turnstile challenge page
await itAsync('Cloudflare Turnstile challenge returns BLOCKED_BY_CHALLENGE fail-closed', async () => {
    const mockFetch = async () => ({
        status: 200,
        ok: true,
        text: async () => '<!DOCTYPE html><html><script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script><title>Unauth page loaded</title></html>'
    });

    const adapter = new CutshortAdapter({ vault: mockVault, fetchFn: mockFetch });
    const result = await adapter.fetchJobs();
    assert.strictEqual(result.status, 'BLOCKED_BY_CHALLENGE');
    assert.strictEqual(result.requiresInteractiveLogin, true);
    assert.strictEqual(result.jobs.length, 0);
});

// Test 5: Valid authenticated response parses and normalizes properly
await itAsync('Valid authenticated payload is parsed and normalized correctly', async () => {
    const mockOpportunities = {
        opportunities: [
            {
                id: 'cs_101',
                title: 'Backend Engineer - Node.js',
                companyName: 'NexGen FinTech',
                location: 'Bengaluru, India',
                workplaceType: 'remote',
                type: 'full-time',
                slug: 'backend-engineer-node-js-cs101',
                description: 'Looking for a Node.js / TypeScript developer with 1 year experience in PostgreSQL and microservices.',
                eligibility: 'Open to India'
            },
            {
                id: 'cs_102',
                title: 'Full Stack Developer',
                company: { name: 'HealthSync Labs' },
                locations: ['Delhi NCR', 'Remote'],
                locationType: 'hybrid',
                url: 'https://cutshort.io/job/full-stack-healthsync',
                jd: 'React, Node.js, Next.js, and Docker experience required.'
            }
        ]
    };

    const mockFetch = async () => ({
        status: 200,
        ok: true,
        text: async () => JSON.stringify(mockOpportunities)
    });

    const adapter = new CutshortAdapter({ vault: mockVault, fetchFn: mockFetch });
    const result = await adapter.fetchJobs();

    assert.strictEqual(result.status, 'SUCCESS');
    assert.strictEqual(result.authenticated, true);
    assert.strictEqual(result.jobs.length, 2);

    const job1 = result.jobs[0];
    assert.strictEqual(job1.title, 'Backend Engineer - Node.js');
    assert.strictEqual(job1.company_name, 'NexGen FinTech');
    assert.strictEqual(job1.remote_type, 'remote');
    assert.strictEqual(job1.source, 'cutshort');
    assert.strictEqual(job1.source_job_id, 'cutshort_cs_101');
    assert.strictEqual(job1.job_url, 'https://cutshort.io/job/backend-engineer-node-js-cs101');

    const job2 = result.jobs[1];
    assert.strictEqual(job2.title, 'Full Stack Developer');
    assert.strictEqual(job2.company_name, 'HealthSync Labs');
    assert.strictEqual(job2.remote_type, 'hybrid');
    assert.strictEqual(job2.job_url, 'https://cutshort.io/job/full-stack-healthsync');
});

// Test 6: Matching pipeline works on Cutshort jobs
it('Cutshort normalized jobs evaluate against matching engine', () => {
    const adapter = new CutshortAdapter({ vault: mockVault });
    const normalized = adapter.parseResponse({
        jobs: [
            {
                id: 'cutshort_sde',
                title: 'Software Engineer - Backend',
                companyName: 'Acme Software',
                location: 'Remote, India',
                slug: 'sde-backend-acme',
                description: 'Join our engineering team building Node.js, Express, React, and PostgreSQL backends.'
            }
        ]
    });

    assert.strictEqual(normalized.length, 1);
    const mockFacts = [
        { category: 'work_authorization', identifier: 'work_authorization_india', value: 'Authorized to work in India', verified: true },
        { category: 'skill', identifier: 'nodejs', value: 'Node.js', verified: true },
        { category: 'skill', identifier: 'react', value: 'React', verified: true }
    ];
    const evaluation = evaluateJobOffer(normalized[0], mockFacts, []);
    assert.ok(evaluation, 'Evaluation should exist');
    assert.strictEqual(typeof evaluation.finalScore, 'number');
    assert.ok(evaluation.recommendation, 'Recommendation should exist');
});

// Clean up scratch
if (fs.existsSync(tempVaultDir)) {
    fs.rmSync(tempVaultDir, { recursive: true, force: true });
}

console.log(`\nCutshort Adapter Test Summary: ${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
