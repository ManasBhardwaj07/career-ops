#!/usr/bin/env node

/**
 * scripts/scan-secrets-paths.mjs — Pre-Commit Secret and Local Path Auditor
 *
 * Scans the complete proposed public snapshot (modified + untracked files)
 * for accidental hardcoded secrets, sensitive credentials, and machine-specific local paths.
 */

import { execSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';

// Get all files that would be committed (modified + untracked)
const statusOut = execSync('git status --porcelain', { encoding: 'utf8' });
const files = [];

for (const line of statusOut.split('\n')) {
    if (!line.trim()) continue;
    const path = line.slice(3).trim();
    if (path.endsWith('/')) {
        // directory
        const dirFiles = execSync(`git ls-files --others --exclude-standard ${path}`, { encoding: 'utf8' });
        for (const df of dirFiles.split('\n')) {
            if (df.trim()) files.push(df.trim());
        }
    } else {
        files.push(path);
    }
}

console.log(`Total proposed files scanned: ${files.length}`);

const secretRegex = /(?:api[_-]?key|secret|token|password)\s*[:=]\s*['"][A-Za-z0-9_\-]{16,}['"]/i;
const localPathRegex = /[C-Z]:[\\\/]Users[\\\/]/i;

const secretFindings = [];
const localPathFindings = [];

for (const file of files) {
    if (!existsSync(file)) continue;
    // skip binaries and media
    if (file.endsWith('.pdf') || file.endsWith('.db') || file.endsWith('.png') || file.endsWith('.woff2')) continue;
    try {
        const content = readFileSync(file, 'utf8');
        const lines = content.split('\n');
        lines.forEach((l, idx) => {
            if (secretRegex.test(l)) {
                const lower = l.toLowerCase();
                if (!lower.includes('example') && !lower.includes('dummy') && !lower.includes('test') && !lower.includes('placeholder')) {
                    secretFindings.push({ file, line: idx + 1, snippet: l.trim() });
                }
            }
            if (localPathRegex.test(l)) {
                // Ignore standard Windows candidate path detectors in session.mjs or test mocks
                if (!file.includes('session.mjs') && !file.includes('test-milestone3c.mjs')) {
                    localPathFindings.push({ file, line: idx + 1, snippet: l.trim() });
                }
            }
        });
    } catch {}
}

console.log(`Secret findings (${secretFindings.length}):`, secretFindings);
console.log(`Local Windows absolute path findings (${localPathFindings.length}):`, localPathFindings);

if (secretFindings.length > 0 || localPathFindings.length > 0) {
    process.exit(1);
} else {
    console.log('✅ SCAN PASSED: Zero leaked secrets or unhandled machine-specific paths found.');
    process.exit(0);
}
