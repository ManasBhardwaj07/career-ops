#!/usr/bin/env node

/**
 * backup.js — Atomic backup of the SQLite database.
 *
 * Uses node:sqlite's built-in backup() API, which checkpoints the WAL
 * and writes a fully standalone database file. No sidecar files (WAL/SHM)
 * are needed — the destination opens on its own.
 *
 * Usage:
 *   node db/backup.js [dest-path]
 *   node db/backup.js            # backups/job_agent_YYYY-MM-DD_HH-mm-ss.db
 */

import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { getDb, closeDb, backupDb } from './db.mjs';

const BACKUP_DIR = process.env.JOB_AGENT_BACKUP_DIR || 'backups';

function pad(n) {
    return String(n).padStart(2, '0');
}

const dest = process.argv[2] || (() => {
    const d = new Date();
    const ts = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
    return `${BACKUP_DIR}/job_agent_${ts}.db`;
})();

if (!existsSync(process.env.JOB_AGENT_DB_PATH || 'data/job_agent.db')) {
    if (process.env.JOB_AGENT_DB_PATH && !existsSync(process.env.JOB_AGENT_DB_PATH)) {
        console.error(`Database not found at ${process.env.JOB_AGENT_DB_PATH}`);
        process.exit(1);
    }
}

const db = getDb();
mkdirSync(dirname(dest), { recursive: true });
await backupDb(dest);
closeDb();

console.log(`Backup created at ${dest}`);
