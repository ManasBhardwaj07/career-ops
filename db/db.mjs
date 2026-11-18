#!/usr/bin/env node

/**
 * db/db.mjs — Shared database connection module for career-ops.
 *
 * Single source of truth for the SQLite connection. All runtime code
 * (scanners, migration scripts, repo layer) imports from here rather than
 * constructing DatabaseSync directly, so PRAGMA setup, migration ordering,
 * and WAL checkpointing stay consistent.
 *
 * Uses Node.js built-in `node:sqlite` (DatabaseSync) — zero native deps,
 * works on Node 24.12 without any install.
 *
 * Exposes:
 *   getDb()                    — lazy singleton connection
 *   closeDb()                  — close the singleton (WAL checkpoint)
 *   resetDb()                  — close + reopen (test helper)
 *   backupDb(destPath)         — atomic backup via node:sqlite backup()
 *   runInTransaction(fn)       — explicit BEGIN/COMMIT/ROLLBACK wrapper
 *   withPragmas(db)            — apply WAL pragmas to a fresh connection
 */

import { existsSync, mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { backup } from 'node:sqlite';
import { DatabaseSync } from 'node:sqlite';

// ── Configuration ────────────────────────────────────────────────────

export function getDbPath() {
    const defaultPath = resolve(process.cwd(), 'data', 'job_agent.db');
    const target = process.env.JOB_AGENT_DB_PATH ? resolve(process.cwd(), process.env.JOB_AGENT_DB_PATH) : defaultPath;
    if (process.env.CAREER_OPS_TEST === '1' && target === defaultPath) {
        throw new Error(`FAIL-CLOSED: Test mode active (CAREER_OPS_TEST=1) refused connection to canonical database: ${target}`);
    }
    return target;
}

export const DB_PATH = getDbPath();

// ── PRAGMA setup ─────────────────────────────────────────────────────
//
// IMPORTANT: these MUST run outside any transaction. `synchronous` and
// `journal_mode` are no-ops (or errors) once a transaction is open, so
// callers that open a transaction must apply pragmas first, then BEGIN.

export const PRAGMAS = [
    'PRAGMA foreign_keys = ON',
    'PRAGMA journal_mode = WAL',
    'PRAGMA synchronous = FULL',
    'PRAGMA busy_timeout = 5000',
];

export function withPragmas(db) {
    for (const p of PRAGMAS) {
        db.exec(p);
    }
    return db;
}

// ── Connection singleton ─────────────────────────────────────────────

let _db = null;

/**
 * Get the shared database connection, creating it on first call.
 * Idempotent: subsequent calls return the same instance.
 */
export function getDb() {
    if (_db) return _db;

    const path = getDbPath();
    mkdirSync(dirname(path), { recursive: true });
    _db = new DatabaseSync(path);
    withPragmas(_db);
    return _db;
}

/**
 * Close the singleton. WAL is checkpointed on close.
 * After this, getDb() will reopen a fresh connection.
 */
export function closeDb() {
    if (_db) {
        _db.close();
        _db = null;
    }
}

/**
 * Close and reopen the singleton. Used by tests to verify that
 * committed state survives a connection cycle.
 */
export function resetDb() {
    closeDb();
    return getDb();
}

// ── Backup ───────────────────────────────────────────────────────────

/**
 * Atomically back up the database to destPath.
 *
 * node:sqlite's backup() copies the live database into a standalone file
 * (WAL checkpointed, no sidecar files needed). The destination is a
 * fully openable SQLite database on its own.
 */
export async function backupDb(destPath) {
    const db = getDb();
    mkdirSync(dirname(destPath), { recursive: true });
    await backup(db, destPath);
    return destPath;
}

// ── Transactions ─────────────────────────────────────────────────────

let _txDepth = 0;

/**
 * Run a function inside an explicit transaction.
 *
 * Supports nested calls cleanly via SQLite SAVEPOINTs.
 * Outer call executes BEGIN / COMMIT / ROLLBACK.
 * Inner calls execute SAVEPOINT / RELEASE / ROLLBACK TO.
 */
export function runInTransaction(fn) {
    const db = getDb();
    _txDepth++;
    const savepoint = `sp_${_txDepth}`;
    if (_txDepth === 1) {
        db.exec('BEGIN');
    } else {
        db.exec(`SAVEPOINT ${savepoint}`);
    }

    try {
        const result = fn(db);
        if (_txDepth === 1) {
            db.exec('COMMIT');
        } else {
            db.exec(`RELEASE SAVEPOINT ${savepoint}`);
        }
        _txDepth--;
        return result;
    } catch (err) {
        try {
            if (_txDepth === 1) {
                db.exec('ROLLBACK');
            } else {
                db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
            }
        } catch (rollbackErr) {
            rollbackErr.cause = err;
            _txDepth = 0;
            throw rollbackErr;
        } finally {
            _txDepth = Math.max(0, _txDepth - 1);
        }
        throw err;
    }
}
