/**
 * test-wellfound-adapter.mjs — Wellfound Adapter Test Suite
 *
 * Verifies Deliverable 6 (Portal 3 in sequence):
 * 1. Missing session returns AUTHENTICATION_REQUIRED with concrete forensic block details.
 * 2. Expired session returns SESSION_EXPIRED.
 * 3. Cloudflare challenge returns BLOCKED_BY_CHALLENGE fail-closed.
 * 4. Authenticated GraphQL payload parsing & normalization.
 * 5. Matching pipeline evaluation.
 */

import assert from 'assert';
import path from 'path';
import fs from 'fs';
import { WellfoundAdapter } from './discovery/adapters/wellfound-adapter.mjs';
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

console.log('=== Running Wellfound Adapter Tests ===\n');

const tempVaultDir = path.resolve('scratch/test-wellfound-sessions');
if (fs.existsSync(tempVaultDir)) {
    fs.rmSync(tempVaultDir, { recursive: true, force: true });
}
fs.mkdirSync(tempVaultDir, { recursive: true });

const mockVault = new SessionVault(tempVaultDir);

// Test 1: Missing session
await itAsync('Missing session returns AUTHENTICATION_REQUIRED with forensic block info', async () => {
    const adapter = new WellfoundAdapter({ vault: mockVault });
    const result = await adapter.fetchJobs();

    assert.strictEqual(result.status, 'AUTHENTICATION_REQUIRED');
    assert.strictEqual(result.authenticated, false);
    assert.strictEqual(result.requiresInteractiveLogin, true);
    assert.ok(result.forensicEvidence, 'Should contain forensic evidence');
    assert.strictEqual(result.forensicEvidence.httpStatus, 403);
});

// Test 2: Expired session in vault
await itAsync('Expired session returns AUTHENTICATION_REQUIRED', async () => {
    mockVault.saveSession('wellfound', {
        expiresAt: new Date(Date.now() - 3600000).toISOString(),
        cookies: [{ name: '_angellist', value: 'token', expires: Math.floor(Date.now() / 1000) - 3600 }]
    });

    const adapter = new WellfoundAdapter({ vault: mockVault });
    const result = await adapter.fetchJobs();
    assert.strictEqual(result.status, 'AUTHENTICATION_REQUIRED');
});

// Test 3: Cloudflare Turnstile challenge page
await itAsync('Turnstile Security Check returns BLOCKED_BY_CHALLENGE fail-closed', async () => {
    mockVault.saveSession('wellfound', {
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        cookies: [{ name: '_angellist', value: 'token123' }]
    });

    const mockFetch = async () => ({
        status: 403,
        ok: false,
        text: async () => '<title>Security Check | Wellfound</title><script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script>'
    });

    const adapter = new WellfoundAdapter({ vault: mockVault, fetchFn: mockFetch });
    const result = await adapter.fetchJobs();

    assert.strictEqual(result.status, 'BLOCKED_BY_CHALLENGE');
    assert.strictEqual(result.requiresInteractiveLogin, true);
    assert.strictEqual(result.jobs.length, 0);
});

// Test 4: Authenticated GraphQL parsing
it('Parses authenticated GraphQL response into normalized jobs', () => {
    const samplePayload = {
        data: {
            talentJobSearch: {
                listings: [
                    {
                        id: 'wf_555',
                        title: 'Founding Engineer (Full Stack)',
                        slug: 'founding-engineer-full-stack-555',
                        startup: { name: 'HyperScale AI' },
                        location: 'Remote',
                        remote: true,
                        pitch: 'Early-stage startup building AI agent infrastructure. Looking for React and Node.js engineers.'
                    }
                ]
            }
        }
    };

    const adapter = new WellfoundAdapter({ vault: mockVault });
    const jobs = adapter.parseResponse(samplePayload);

    assert.strictEqual(jobs.length, 1);
    assert.strictEqual(jobs[0].title, 'Founding Engineer (Full Stack)');
    assert.strictEqual(jobs[0].company_name, 'HyperScale AI');
    assert.strictEqual(jobs[0].remote_type, 'remote');
    assert.strictEqual(jobs[0].job_url, 'https://wellfound.com/jobs/founding-engineer-full-stack-555');
    assert.strictEqual(jobs[0].source, 'wellfound');
    assert.strictEqual(jobs[0].source_job_id, 'wellfound_wf_555');
});

// Test 5: Matching pipeline on Wellfound job
it('Wellfound normalized jobs evaluate against matching engine', () => {
    const adapter = new WellfoundAdapter({ vault: mockVault });
    const jobs = adapter.parseResponse({
        jobs: [
            {
                id: 'wf_999',
                title: 'Backend Engineer',
                companyName: 'CloudFlow',
                location: 'Remote',
                remote: true,
                pitch: 'Node.js and PostgreSQL backend engineering.'
            }
        ]
    });

    const mockFacts = [
        { category: 'work_authorization', identifier: 'work_authorization_india', value: 'Authorized to work in India', verified: true },
        { category: 'skill', identifier: 'nodejs', value: 'Node.js', verified: true },
        { category: 'skill', identifier: 'postgresql', value: 'PostgreSQL', verified: true }
    ];

    const evaluation = evaluateJobOffer(jobs[0], mockFacts, []);
    assert.ok(evaluation, 'Evaluation should exist');
    assert.strictEqual(typeof evaluation.finalScore, 'number');
});

// Cleanup scratch
if (fs.existsSync(tempVaultDir)) {
    fs.rmSync(tempVaultDir, { recursive: true, force: true });
}

console.log(`\nWellfound Adapter Test Summary: ${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
