/**
 * test-resume-attachment-preview.mjs — Focused regression test for resume upload verification
 *
 * Verifies that attachResume succeeds when:
 *   1. File input retains .files in DOM (standard Lever/Ashby pattern)
 *   2. Modern Greenhouse replaces the file input with .file-upload__filename preview component
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { chromium } from 'playwright';

// Environment isolation
process.env.CAREER_OPS_TEST = '1';
process.env.JOB_AGENT_DB_PATH = 'data/test_attachment_preview.db';

const CANONICAL_DB_PATH = path.resolve('data/job_agent.db');
const hashBefore = crypto.createHash('sha256').update(fs.readFileSync(CANONICAL_DB_PATH)).digest('hex').toUpperCase();

const { attachResume } = await import('./application/documents/attach-resume.mjs');

console.log('\n=== Testing Resume Attachment Verification Logic ===\n');

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

const testPdf = path.resolve('output/resumes/jordan-lee-backend.pdf');

// Test Case 1: Standard file input retaining .files (Lever / Ashby)
await page.setContent(`
  <form id="lever-form">
    <label for="resume-input">Resume/CV</label>
    <input type="file" id="resume-input" name="resume" accept=".pdf">
  </form>
`);

const res1 = await attachResume(page, { pdfPath: testPdf });
assert.strictEqual(res1.success, true, 'Case 1: Must succeed on standard file input');
assert.strictEqual(res1.fileName, 'jordan-lee-backend.pdf');
console.log('  ✓ PASS: Case 1 — Standard file input retaining .files (Lever/Ashby pattern)');

// Test Case 2: Greenhouse pattern — file input replaced by .file-upload__filename preview
await page.setContent(`
  <form id="gh-form">
    <div class="file-upload">
      <div id="upload-label-resume">Resume/CV</div>
      <input type="file" id="resume" class="visually-hidden">
    </div>
  </form>
`);

// Mock Greenhouse replacement behavior on file selection
await page.evaluate(() => {
    const inp = document.querySelector('#resume');
    inp.addEventListener('change', () => {
        const parent = inp.closest('.file-upload');
        inp.remove(); // Greenhouse removes or hides input
        const preview = document.createElement('div');
        preview.className = 'file-upload__filename';
        preview.innerHTML = '<p class="body">jordan-lee-backend.pdf</p>';
        parent.appendChild(preview);
    });
});

const res2 = await attachResume(page, { pdfPath: testPdf });
assert.strictEqual(res2.success, true, 'Case 2: Must succeed when file input is replaced by preview element');
assert.strictEqual(res2.verifiedUpload.isUploadedPreview, true, 'Must identify uploaded preview element');
console.log('  ✓ PASS: Case 2 — Greenhouse pattern with .file-upload__filename preview component');

await browser.close();

// Verify canonical DB untouched
const hashAfter = crypto.createHash('sha256').update(fs.readFileSync(CANONICAL_DB_PATH)).digest('hex').toUpperCase();
assert.strictEqual(hashAfter, hashBefore, 'Canonical DB hash must remain unchanged');
console.log('  ✓ PASS: Canonical DB verified 100% untouched\n');
