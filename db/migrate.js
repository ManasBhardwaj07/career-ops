#!/usr/bin/env node

/**
 * migrate.js — Run migrations and verify schema
 * Ensures the database is at the latest version.
 *
 * Uses Node.js built-in `node:sqlite` (DatabaseSync) — no native deps.
 *
 * Iterates every db/migrations/*.sql file in numeric order. Each
 * migration must be idempotent (IF NOT EXISTS / INSERT OR IGNORE) so a
 * re-run is a no-op. Migrations already applied are skipped via the
 * schema_migrations ledger.
 *
 * Usage:
 *   node db/migrate.js
 */

import { readFileSync, readdirSync } from 'fs';
import { join, dirname, basename, resolve } from 'path';
import { fileURLToPath } from 'url';
import { getDb, closeDb } from './db.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function runMigrations(targetDb = null, { quiet = false } = {}) {
    const db = targetDb || getDb();

    // R11 Fail-closed guard: Migration against canonical database requires ALLOW_CANONICAL_MIGRATION=1
    const canonicalPath = resolve(process.cwd(), 'data', 'job_agent.db');
    try {
        const dbList = db.prepare('PRAGMA database_list').all();
        const mainFile = dbList.find(d => d.name === 'main')?.file;
        if (mainFile && resolve(mainFile) === canonicalPath && process.env.ALLOW_CANONICAL_MIGRATION !== '1') {
            throw new Error('FAIL-CLOSED (R11): Migration against canonical database requires ALLOW_CANONICAL_MIGRATION=1');
        }
    } catch (e) {
        if (e.message.startsWith('FAIL-CLOSED (R11)')) {
            throw e;
        }
    }
    const migrationsDir = join(__dirname, 'migrations');

    const files = readdirSync(migrationsDir)
        .filter(f => f.endsWith('.sql'))
        .sort();

    const applied = [];
    const skipped = [];

    for (const name of files) {
        const version = name.split('_')[0];

        // Skip if already applied (ledger is created by 002+)
        let alreadyApplied = false;
        try {
            const row = db.prepare(
                'SELECT 1 FROM schema_migrations WHERE version = ?'
            ).get(version);
            alreadyApplied = !!row;
        } catch {
            // Table doesn't exist yet; this is the first migration run
        }
        if (alreadyApplied) {
            if (!quiet) console.log(`  · ${name} (already applied)`);
            skipped.push(name);
            continue;
        }

        const sql = readFileSync(join(migrationsDir, name), 'utf-8');
        try {
            db.exec(sql);
            if (!quiet) console.log(`  ✓ ${name}`);
            applied.push(name);
        } catch (e) {
            console.error(`  ✗ ${name}:`, e.message);
            throw e;
        }
    }

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    const ledger = db.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all();

    return { applied, skipped, tables: tables.map(t => t.name), ledger };
}

if (process.argv[1] && (process.argv[1].endsWith('migrate.js') || process.argv[1].endsWith('migrate.mjs'))) {
    console.log('Running migrations...');
    try {
        const res = runMigrations();
        console.log('\nTables:', res.tables.join(', '));
        console.log('\nApplied migrations:', res.ledger.map(l => `${l.version} (${l.name})`).join(', ') || '(none)');
        console.log('\nMigration complete.');
    } finally {
        closeDb();
    }
}
