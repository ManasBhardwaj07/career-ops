/**
 * test-instahyre-adapter.mjs — Instahyre Adapter Test Suite
 *
 * Verifies Deliverable 6 (Portal 2 in sequence):
 * 1. Public search HTML parsing & normalization into standard career-ops jobs.
 * 2. Authenticated feed with missing session cleanly returns AUTHENTICATION_REQUIRED.
 * 3. Expired session handling (SESSION_EXPIRED).
 * 4. Challenge / WAF detection (BLOCKED_BY_CHALLENGE, fail-closed).
 * 5. Authenticated JSON feed parsing & normalization.
 * 6. Compatibility with matching pipeline and candidate facts.
 */

import assert from 'assert';
import path from 'path';
import fs from 'fs';
import { InstahyreAdapter } from './discovery/adapters/instahyre-adapter.mjs';
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

console.log('=== Running Instahyre Adapter Tests ===\n');

// Use temp directory for isolated session testing
const tempVaultDir = path.resolve('scratch/test-instahyre-sessions');
if (fs.existsSync(tempVaultDir)) {
    fs.rmSync(tempVaultDir, { recursive: true, force: true });
}
fs.mkdirSync(tempVaultDir, { recursive: true });

const mockVault = new SessionVault(tempVaultDir);

// Test 1: Public search HTML parsing
it('Parses public search HTML into normalized jobs', () => {
    const sampleHtml = `
    <!DOCTYPE html>
    <html>
    <body>
      <div class="results">
        <a href="/job-449050-sde-fullstack-developer-at-gokiwi-bengaluru">SDE Fullstack Developer at GoKiwi</a>
        <a href="/job-387858-backend-engineer-at-razorpay-remote">Backend Engineer at Razorpay</a>
      </div>
    </body>
    </html>
    `;

    const adapter = new InstahyreAdapter({ vault: mockVault });
    const jobs = adapter.parseHtmlListings(sampleHtml);

    assert.strictEqual(jobs.length, 2);
    assert.strictEqual(jobs[0].title, 'Sde Fullstack Developer');
    assert.strictEqual(jobs[0].company_name, 'Gokiwi');
    assert.strictEqual(jobs[0].job_url, 'https://www.instahyre.com/job-449050-sde-fullstack-developer-at-gokiwi-bengaluru');
    assert.strictEqual(jobs[0].source, 'instahyre');
    assert.strictEqual(jobs[0].source_job_id, 'instahyre_449050');

    assert.strictEqual(jobs[1].title, 'Backend Engineer');
    assert.strictEqual(jobs[1].company_name, 'Razorpay');
    assert.strictEqual(jobs[1].remote_type, 'remote');
});

// Test 2: Authenticated-only request with missing session
await itAsync('Missing session with authenticatedOnly returns AUTHENTICATION_REQUIRED', async () => {
    const adapter = new InstahyreAdapter({ vault: mockVault });
    const result = await adapter.fetchJobs({ authenticatedOnly: true });

    assert.strictEqual(result.status, 'AUTHENTICATION_REQUIRED');
    assert.strictEqual(result.authenticated, false);
    assert.strictEqual(result.jobs.length, 0);
});

// Test 3: Authenticated session returns 401
await itAsync('Expired session returns SESSION_EXPIRED', async () => {
    mockVault.saveSession('instahyre', {
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        cookies: [{ name: 'instahyre_session_id', value: 'token123' }]
    });

    const mockFetch = async () => ({
        status: 401,
        ok: false,
        text: async () => 'Unauthorized'
    });

    const adapter = new InstahyreAdapter({ vault: mockVault, fetchFn: mockFetch });
    const result = await adapter.fetchJobs({ authenticatedOnly: true });

    assert.strictEqual(result.status, 'SESSION_EXPIRED');
    assert.strictEqual(result.jobs.length, 0);
});

// Test 4: Challenge page fail-closed
await itAsync('Cloudflare challenge returns BLOCKED_BY_CHALLENGE fail-closed', async () => {
    const mockFetch = async () => ({
        status: 200,
        ok: true,
        text: async () => '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script>'
    });

    const adapter = new InstahyreAdapter({ vault: mockVault, fetchFn: mockFetch });
    const result = await adapter.fetchJobs({ authenticatedOnly: true });

    assert.strictEqual(result.status, 'BLOCKED_BY_CHALLENGE');
    assert.strictEqual(result.jobs.length, 0);
});

// Test 5: Authenticated opportunities JSON parsing
it('Parses authenticated JSON opportunities correctly', () => {
    const samplePayload = {
        opportunities: [
            {
                id: 99101,
                title: 'Software Development Engineer I',
                company_name: 'Zepto',
                location: 'Bengaluru, India',
                workplace_type: 'hybrid',
                description: 'Build low-latency APIs in Go and Node.js.'
            }
        ]
    };

    const adapter = new InstahyreAdapter({ vault: mockVault });
    const jobs = adapter.parseApiResponse(samplePayload);

    assert.strictEqual(jobs.length, 1);
    assert.strictEqual(jobs[0].title, 'Software Development Engineer I');
    assert.strictEqual(jobs[0].company_name, 'Zepto');
    assert.strictEqual(jobs[0].remote_type, 'hybrid');
    assert.strictEqual(jobs[0].job_url, 'https://www.instahyre.com/job-99101');
    assert.strictEqual(jobs[0].source_job_id, 'instahyre_99101');
});

// Test 6: Matching pipeline on Instahyre job
it('Instahyre normalized jobs evaluate against matching engine', () => {
    const adapter = new InstahyreAdapter({ vault: mockVault });
    const jobs = adapter.parseApiResponse({
        jobs: [
            {
                id: 1002,
                title: 'Full Stack Engineer',
                company_name: 'Swiggy',
                location: 'Bengaluru, India',
                workplace_type: 'onsite',
                description: 'Full stack development with Node.js and React.'
            }
        ]
    });

    const mockFacts = [
        { category: 'work_authorization', identifier: 'work_authorization_india', value: 'Authorized to work in India', verified: true },
        { category: 'skill', identifier: 'nodejs', value: 'Node.js', verified: true },
        { category: 'skill', identifier: 'react', value: 'React', verified: true }
    ];

    const evaluation = evaluateJobOffer(jobs[0], mockFacts, []);
    assert.ok(evaluation, 'Evaluation should exist');
    assert.strictEqual(typeof evaluation.finalScore, 'number');
});

// Cleanup scratch
if (fs.existsSync(tempVaultDir)) {
    fs.rmSync(tempVaultDir, { recursive: true, force: true });
}

console.log(`\nInstahyre Adapter Test Summary: ${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
