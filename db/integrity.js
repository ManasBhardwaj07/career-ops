#!/usr/bin/env node

/**
 * integrity.js — Run PRAGMA integrity_check on the database.
 *
 * Uses Node.js built-in `node:sqlite` (DatabaseSync) via shared db.mjs.
 *
 * Usage:
 *   node db/integrity.js
 */

import { getDb, closeDb } from './db.mjs';

const db = getDb();

console.log('Running integrity check...');
const result = db.prepare('PRAGMA integrity_check').all();
const ok = result.map((r) => r.integrity_check).join('; ') || 'ok';
console.log('  Result:', ok);

closeDb();
process.exit(ok === 'ok' ? 0 : 1);
