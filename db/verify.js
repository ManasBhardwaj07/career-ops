#!/usr/bin/env node

/**
 * verify.js — Verify database PRAGMA settings and schema integrity.
 *
 * Uses Node.js built-in `node:sqlite` (DatabaseSync) — no native deps.
 *
 * Usage:
 *   node db/verify.js
 */

import { existsSync } from 'fs';
import { getDb, closeDb } from './db.mjs';

const DB_PATH = process.env.JOB_AGENT_DB_PATH || 'data/job_agent.db';

if (!existsSync(DB_PATH)) {
    console.error(`Database not found at ${DB_PATH}`);
    process.exit(1);
}

const db = getDb();

const tests = [
    ['foreign_keys', () => db.prepare('PRAGMA foreign_keys').get().foreign_keys === 1],
    ['journal_mode=WAL', () => db.prepare('PRAGMA journal_mode').get().journal_mode === 'wal'],
    ['synchronous', () => {
        const v = db.prepare('PRAGMA synchronous').get().synchronous;
        return v === 1 || v === 2;
    }],
    ['busy_timeout', () => parseInt(db.prepare('PRAGMA busy_timeout').get().timeout) >= 5000],
];

console.log('Database Verification:');
let failures = 0;
for (const [name, passed] of tests) {
    const ok = passed();
    console.log(`  ${ok ? '✓' : '✗'} ${name}`);
    if (!ok) failures++;
}

// Schema integrity
const result = db.prepare('PRAGMA integrity_check').all();
const integrity = result.map((r) => r.integrity_check).join('; ') || 'ok';
console.log(`  integrity_check: ${integrity}`);
if (integrity !== 'ok') failures++;

// Migration ledger
let ledger = [];
try {
    ledger = db.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all();
} catch {
    // table doesn't exist yet
}
console.log(`  migrations: ${ledger.map(l => l.version).join(', ') || '(none)'}`);

closeDb();
process.exit(failures > 0 ? 1 : 0);
