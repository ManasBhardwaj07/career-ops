/**
 * db/repo.mjs — Centralized Database Repository Layer for Career-Ops
 *
 * Single, testable ESM data-access layer.
 * All SQL statements are prepared and isolated here.
 *
 * Uses Node.js built-in `node:sqlite` via `db/db.mjs`.
 */

import { createHash } from 'crypto';
import { getDb, closeDb, backupDb, runInTransaction } from './db.mjs';

export { getDb, closeDb, backupDb, runInTransaction };

/* ========== Core DB Operations ========== */

export function initDatabase() {
    return getDb();
}

export function closeDatabase() {
    closeDb();
}

export async function backupDatabase(backupPath) {
    return await backupDb(backupPath);
}

export function verifyIntegrity() {
    const db = getDb();
    const result = db.prepare('PRAGMA integrity_check').all();
    return result[0]?.integrity_check === 'ok';
}

/* ========== Companies & Employer Registry (Milestone 2B) ========== */

export const VALID_LIFECYCLE_TRANSITIONS = {
    DISCOVERED: ['UNVERIFIED', 'REJECTED'],
    UNVERIFIED: ['VERIFIED', 'REJECTED', 'DISABLED'],
    VERIFIED: ['APPROVED', 'DISABLED', 'REJECTED', 'UNVERIFIED'],
    APPROVED: ['MONITORING', 'DISABLED', 'REJECTED', 'VERIFIED'],
    MONITORING: ['APPROVED', 'DISABLED', 'REJECTED'],
    DISABLED: ['APPROVED', 'MONITORING', 'UNVERIFIED', 'REJECTED'],
    REJECTED: ['UNVERIFIED']
};

export function normalizeDomain(input) {
    if (!input || typeof input !== 'string') return null;
    let clean = input.trim().toLowerCase();
    // Remove protocol
    clean = clean.replace(/^[a-z]+:\/\//i, '');
    // Remove basic auth
    clean = clean.replace(/^[^@]+@/, '');
    // Remove port and path
    clean = clean.split(/[/?#:]/)[0];
    // Remove leading/trailing dots
    clean = clean.replace(/^\.+|\.+$/g, '');
    // Strip leading www.
    if (clean.startsWith('www.')) {
        clean = clean.slice(4);
    }
    return clean || null;
}

export function upsertCompany(c) {
    const db = getDb();
    const id = c.id || (c.name ? `company-${c.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')}` : null);
    if (!id) throw new Error('Company requires id or name');
    const domain = c.domain ? normalizeDomain(c.domain) : (c.website_url ? normalizeDomain(c.website_url) : null);

    const existing = db.prepare('SELECT lifecycle_status, monitoring_status, policy_status, source_provenance FROM companies WHERE id = ?').get(id);

    const lifecycleStatus = c.lifecycle_status ?? existing?.lifecycle_status ?? 'UNVERIFIED';
    const monitoringStatus = c.monitoring_status ?? existing?.monitoring_status ?? 'paused';
    const policyStatus = c.policy_status ?? existing?.policy_status ?? 'pending';
    const sourceProvenance = c.source_provenance ?? existing?.source_provenance ?? 'manual';

    const stmt = db.prepare(`
        INSERT INTO companies
        (id, name, domain, career_url, ats_type, board_identifier, last_scanned_at, policy_status, notes,
         website_url, country, industry, size_band, source_provenance, lifecycle_status, monitoring_status,
         last_discovered_at, last_verified_at, parent_company_id, updated_at)
        VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            domain = COALESCE(excluded.domain, companies.domain),
            career_url = COALESCE(excluded.career_url, companies.career_url),
            ats_type = COALESCE(excluded.ats_type, companies.ats_type),
            board_identifier = COALESCE(excluded.board_identifier, companies.board_identifier),
            policy_status = excluded.policy_status,
            notes = COALESCE(excluded.notes, companies.notes),
            last_scanned_at = COALESCE(excluded.last_scanned_at, companies.last_scanned_at),
            website_url = COALESCE(excluded.website_url, companies.website_url),
            country = COALESCE(excluded.country, companies.country),
            industry = COALESCE(excluded.industry, companies.industry),
            size_band = COALESCE(excluded.size_band, companies.size_band),
            source_provenance = excluded.source_provenance,
            lifecycle_status = excluded.lifecycle_status,
            monitoring_status = excluded.monitoring_status,
            last_discovered_at = COALESCE(excluded.last_discovered_at, companies.last_discovered_at),
            last_verified_at = COALESCE(excluded.last_verified_at, companies.last_verified_at),
            parent_company_id = COALESCE(excluded.parent_company_id, companies.parent_company_id),
            updated_at = CURRENT_TIMESTAMP
    `);
    const result = stmt.run(
        c.id, c.name, domain, c.career_url || null,
        c.ats_type || null, c.board_identifier || null,
        c.last_scanned_at || null, policyStatus,
        c.notes || null, c.website_url || null, c.country || null,
        c.industry || null, c.size_band || null, sourceProvenance,
        lifecycleStatus, monitoringStatus,
        c.last_discovered_at || null, c.last_verified_at || null,
        c.parent_company_id || null
    );
    return result.changes;
}

export function createCompany(c) {
    const db = getDb();
    const existing = db.prepare('SELECT id FROM companies WHERE id = ?').get(c.id);
    if (existing) {
        throw new Error(`Company with ID already exists: ${c.id}`);
    }
    const domain = c.domain ? normalizeDomain(c.domain) : null;
    if (domain) {
        const domainExists = db.prepare('SELECT id FROM companies WHERE domain = ?').get(domain);
        if (domainExists) {
            throw new Error(`Company with domain already exists: ${domain} (ID: ${domainExists.id})`);
        }
    }
    upsertCompany(c);
    return c.id;
}

export function updateCompany(id, updates) {
    const db = getDb();
    const comp = db.prepare('SELECT * FROM companies WHERE id = ?').get(id);
    if (!comp) throw new Error(`Company not found: ${id}`);

    const cols = Object.keys(updates).filter(k => k !== 'id');
    if (cols.length === 0) return 0;

    const setClauses = [];
    const params = [];
    for (const k of cols) {
        let v = updates[k];
        if (k === 'domain' && v) v = normalizeDomain(v);
        setClauses.push(`${k} = ?`);
        params.push(v);
    }
    setClauses.push('updated_at = CURRENT_TIMESTAMP');
    params.push(id);

    const stmt = db.prepare(`UPDATE companies SET ${setClauses.join(', ')} WHERE id = ?`);
    const res = stmt.run(...params);
    return res.changes;
}

export function getCompany(id) {
    return getDb().prepare('SELECT * FROM companies WHERE id = ?').get(id);
}

export function getCompanyByDomain(domain) {
    if (!domain) return null;
    const clean = normalizeDomain(domain);
    return getDb().prepare('SELECT * FROM companies WHERE domain = ?').get(clean);
}

export function findCompanyByNameOrAlias(nameOrAlias) {
    if (!nameOrAlias || typeof nameOrAlias !== 'string') return null;
    const db = getDb();
    const clean = nameOrAlias.trim().toLowerCase();

    // 1. Direct name match (case insensitive)
    const direct = db.prepare('SELECT * FROM companies WHERE LOWER(TRIM(name)) = ?').get(clean);
    if (direct) return direct;

    // 2. Alias match
    const aliasRow = db.prepare(`
        SELECT c.* FROM companies c
        JOIN company_aliases a ON c.id = a.company_id
        WHERE LOWER(TRIM(a.alias)) = ?
    `).get(clean);
    if (aliasRow) return aliasRow;

    // 3. Domain match
    const dom = normalizeDomain(clean);
    if (dom && dom.includes('.')) {
        const domRow = db.prepare('SELECT * FROM companies WHERE domain = ?').get(dom);
        if (domRow) return domRow;
    }

    return null;
}

export function registerCareerPage(companyId, careerUrl, source = 'manual') {
    const db = getDb();
    const comp = db.prepare('SELECT id FROM companies WHERE id = ?').get(companyId);
    if (!comp) throw new Error(`Company not found: ${companyId}`);

    db.prepare(`
        UPDATE companies SET
            career_url = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `).run(careerUrl.trim(), companyId);
    return true;
}

export function registerAtsBoard(companyId, atsType, boardIdentifier) {
    const db = getDb();
    const comp = db.prepare('SELECT id FROM companies WHERE id = ?').get(companyId);
    if (!comp) throw new Error(`Company not found: ${companyId}`);

    db.prepare(`
        UPDATE companies SET
            ats_type = ?,
            board_identifier = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `).run(atsType.trim(), boardIdentifier ? boardIdentifier.trim() : null, companyId);
    return true;
}

export function setCompanyLifecycleStatus(companyId, newStatus, reason = '') {
    const db = getDb();
    const comp = db.prepare('SELECT id, lifecycle_status FROM companies WHERE id = ?').get(companyId);
    if (!comp) {
        throw new Error(`Company not found: ${companyId}`);
    }
    const current = comp.lifecycle_status || 'UNVERIFIED';
    if (current === newStatus) return true;

    const allowed = VALID_LIFECYCLE_TRANSITIONS[current] || [];
    if (!allowed.includes(newStatus)) {
        throw new Error(`Invalid lifecycle transition from ${current} to ${newStatus}`);
    }

    const setClauses = ['lifecycle_status = ?', 'updated_at = CURRENT_TIMESTAMP'];
    const params = [newStatus];

    if (reason) {
        setClauses.push("notes = COALESCE(notes || ' | ', '') || ?");
        params.push(reason);
    }
    if (['VERIFIED', 'APPROVED', 'MONITORING'].includes(newStatus)) {
        setClauses.push('last_verified_at = CURRENT_TIMESTAMP');
    }
    if (newStatus === 'MONITORING') {
        setClauses.push("monitoring_status = 'active'");
    } else if (['DISABLED', 'REJECTED'].includes(newStatus)) {
        setClauses.push("monitoring_status = 'disabled'");
    }

    params.push(companyId);
    db.prepare(`UPDATE companies SET ${setClauses.join(', ')} WHERE id = ?`).run(...params);
    return true;
}

export function setMonitoringStatus(companyId, monitoringStatus) {
    const db = getDb();
    const comp = db.prepare('SELECT id FROM companies WHERE id = ?').get(companyId);
    if (!comp) throw new Error(`Company not found: ${companyId}`);

    db.prepare(`
        UPDATE companies SET
            monitoring_status = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `).run(monitoringStatus, companyId);
    return true;
}

export function addCompanyAlias(companyId, alias, source = 'manual') {
    if (!alias || !companyId) return null;
    const db = getDb();
    const cleanAlias = alias.trim();
    const id = `alias_${companyId}_${cleanAlias.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;

    db.prepare(`
        INSERT INTO company_aliases (id, company_id, alias, source, created_at)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(company_id, alias) DO UPDATE SET
            source = excluded.source
    `).run(id, companyId, cleanAlias, source);
    return id;
}

export function getCompanyAliases(companyId) {
    return getDb().prepare('SELECT * FROM company_aliases WHERE company_id = ? ORDER BY alias ASC').all(companyId);
}

export function listUnverifiedCompanies() {
    return getDb().prepare('SELECT * FROM companies WHERE lifecycle_status = "UNVERIFIED" ORDER BY name ASC').all();
}

export function listCompaniesMissingCareerUrl() {
    return getDb().prepare('SELECT * FROM companies WHERE career_url IS NULL ORDER BY name ASC').all();
}

export function listCompaniesMissingAts() {
    return getDb().prepare('SELECT * FROM companies WHERE ats_type IS NULL OR board_identifier IS NULL ORDER BY name ASC').all();
}

export function getRegistryCoverageReport() {
    const db = getDb();
    const total = db.prepare('SELECT count(*) as c FROM companies').get().c;
    const byLifecycle = db.prepare('SELECT lifecycle_status, count(*) as c FROM companies GROUP BY lifecycle_status').all();
    const lifecycleMap = Object.fromEntries(byLifecycle.map(r => [r.lifecycle_status || 'UNVERIFIED', r.c]));

    const withWebsite = db.prepare('SELECT count(*) as c FROM companies WHERE website_url IS NOT NULL').get().c;
    const withCareerUrl = db.prepare('SELECT count(*) as c FROM companies WHERE career_url IS NOT NULL').get().c;
    const withAts = db.prepare('SELECT count(*) as c FROM companies WHERE ats_type IS NOT NULL AND board_identifier IS NOT NULL').get().c;
    const withRecentScan = db.prepare('SELECT count(*) as c FROM companies WHERE last_scanned_at IS NOT NULL').get().c;

    const missingDomain = db.prepare('SELECT count(*) as c FROM companies WHERE domain IS NULL').get().c;
    const missingCareerUrl = db.prepare('SELECT count(*) as c FROM companies WHERE career_url IS NULL').get().c;
    const missingAts = db.prepare('SELECT count(*) as c FROM companies WHERE ats_type IS NULL OR board_identifier IS NULL').get().c;

    const unresolvedJobDuplicates = db.prepare('SELECT count(*) as c FROM duplicate_suggestions WHERE resolved = 0').get().c;

    return {
        total_companies: total,
        verified_companies: lifecycleMap['VERIFIED'] || 0,
        approved_companies: lifecycleMap['APPROVED'] || 0,
        monitoring_companies: lifecycleMap['MONITORING'] || 0,
        unverified_companies: lifecycleMap['UNVERIFIED'] || 0,
        discovered_companies: lifecycleMap['DISCOVERED'] || 0,
        disabled_companies: lifecycleMap['DISABLED'] || 0,
        rejected_companies: lifecycleMap['REJECTED'] || 0,
        with_website_count: withWebsite,
        with_career_url_count: withCareerUrl,
        with_ats_count: withAts,
        recent_scanned_count: withRecentScan,
        missing_domain_count: missingDomain,
        missing_career_url_count: missingCareerUrl,
        missing_ats_count: missingAts,
        unresolved_job_duplicates_count: unresolvedJobDuplicates,
        company_identity_conflicts_count: 0,
        identity_conflicts_count: 0
    };
}

export function getAllCompanies() {
    return getDb().prepare('SELECT * FROM companies ORDER BY name ASC').all();
}

/* ========== Source Policies ========== */

export function upsertSourcePolicy(p) {
    const db = getDb();
    const stmt = db.prepare(`
        INSERT INTO source_policies
        (id, company_id, source_type, endpoint, enabled, policy_approved_at,
         discovery_permitted, public_nav_permitted, feed_access_permitted,
         authenticated_permitted, autofill_permitted, submission_permitted, notes)
        VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            endpoint = excluded.endpoint,
            enabled = excluded.enabled,
            policy_approved_at = excluded.policy_approved_at,
            discovery_permitted = excluded.discovery_permitted,
            public_nav_permitted = excluded.public_nav_permitted,
            feed_access_permitted = excluded.feed_access_permitted,
            authenticated_permitted = excluded.authenticated_permitted,
            autofill_permitted = excluded.autofill_permitted,
            submission_permitted = excluded.submission_permitted,
            notes = excluded.notes
    `);
    const result = stmt.run(
        p.id, p.company_id, p.source_type, p.endpoint,
        p.enabled === false || p.enabled === 0 ? 0 : 1, p.policy_approved_at || null,
        p.discovery_permitted === false || p.discovery_permitted === 0 ? 0 : 1,
        p.public_nav_permitted === false || p.public_nav_permitted === 0 ? 0 : 1,
        p.feed_access_permitted === false || p.feed_access_permitted === 0 ? 0 : 1,
        p.authenticated_permitted ? 1 : 0,
        p.autofill_permitted ? 1 : 0,
        0, // Hard gate: submission_permitted is always 0
        p.notes || null
    );
    return result.changes;
}

export function getEnabledPolicies() {
    return getDb().prepare('SELECT * FROM source_policies WHERE enabled = 1').all();
}

export function getSourcePolicy(companyId, sourceType = null) {
    const db = getDb();
    if (sourceType) {
        return db.prepare('SELECT * FROM source_policies WHERE company_id = ? AND source_type = ?').get(companyId, sourceType);
    }
    return db.prepare('SELECT * FROM source_policies WHERE company_id = ?').get(companyId);
}

function isRecurringMonitoringEligible(company) {
    return Boolean(
        company &&
        ['APPROVED', 'MONITORING'].includes(company.lifecycle_status) &&
        company.monitoring_status === 'active' &&
        company.policy_status === 'permitted'
    );
}

function buildAtsValidationClaimId(companyId, sourceType, boardIdentifier) {
    const normSource = String(sourceType || '').trim().toLowerCase();
    const normBoard = String(boardIdentifier || '').trim().toLowerCase();
    const digest = createHash('sha256')
        .update(`${companyId}|${normSource}|${normBoard}`)
        .digest('hex')
        .slice(0, 24);
    return `atsval_${digest}`;
}

function hasPriorAtsValidationScan(db, companyId, sourceType, boardIdentifier, company) {
    const normSource = String(sourceType || '').trim().toLowerCase();
    const normBoard = boardIdentifier ? String(boardIdentifier).trim().toLowerCase() : '';

    if (normBoard) {
        const claimId = buildAtsValidationClaimId(companyId, normSource, normBoard);
        const exactClaim = db.prepare('SELECT 1 FROM source_scans WHERE id = ? LIMIT 1').get(claimId);
        if (exactClaim) return true;

        const legacyScan = db.prepare(`
            SELECT 1 FROM source_scans
            WHERE company_id = ? AND LOWER(source_type) = ? AND id NOT LIKE 'atsval_%'
            LIMIT 1
        `).get(companyId, normSource);
        if (legacyScan) {
            const companyBoard = company?.board_identifier ? String(company.board_identifier).trim().toLowerCase() : '';
            if (!companyBoard || companyBoard === normBoard) {
                return true;
            }
        }
        return false;
    }

    return Boolean(db.prepare(`
        SELECT 1 FROM source_scans
        WHERE company_id = ? AND LOWER(source_type) = ?
        LIMIT 1
    `).get(companyId, normSource));
}

function checkAtsValidationPolicy(company, policy) {
    if (policy) {
        if (policy.enabled === 0) return false;
        return policy.discovery_permitted === 1 && policy.feed_access_permitted === 1;
    }
    return ['APPROVED', 'MONITORING'].includes(company.lifecycle_status) || company.policy_status === 'permitted';
}

export function isSourcePermitted(companyId, sourceType, action = 'discovery', options = {}) {
    const db = getDb();
    const company = db.prepare('SELECT lifecycle_status, monitoring_status, policy_status, board_identifier FROM companies WHERE id = ?').get(companyId);
    if (!company) return false;

    // Hard gates
    if (['DISABLED', 'REJECTED'].includes(company.lifecycle_status) || company.policy_status === 'blocked') {
        return false;
    }
    if (action === 'submission') {
        return false; // Absolute ethical rule: NEVER automated submission
    }

    const normSource = String(sourceType || '').trim().toLowerCase();
    const policy = db.prepare('SELECT * FROM source_policies WHERE company_id = ? AND LOWER(source_type) = ?').get(companyId, normSource);

    // Recurring source monitoring requires approved lifecycle, active monitoring, and approved policy
    if (action === 'monitoring' || action === 'recurring_scan') {
        if (!isRecurringMonitoringEligible(company)) {
            return false;
        }
        if (policy) {
            if (policy.enabled === 0) return false;
            return policy.discovery_permitted === 1;
        }
        return true;
    }

    // One-time public ATS board validation requires explicit discovery/feed permission and no blocked policy,
    // and is strictly limited to one attempt unless the company is eligible for recurring monitoring.
    if (action === 'ats_validation') {
        if (!checkAtsValidationPolicy(company, policy)) {
            return false;
        }
        if (!isRecurringMonitoringEligible(company)) {
            const boardIdentifier = options?.boardIdentifier ?? null;
            if (hasPriorAtsValidationScan(db, companyId, normSource, boardIdentifier, company)) {
                return false;
            }
        }
        return true;
    }

    if (!policy) {
        // Unknown source policy defaults
        if (company.lifecycle_status === 'APPROVED' || company.lifecycle_status === 'MONITORING' || company.policy_status === 'permitted') {
            return ['discovery', 'public_nav', 'feed_access'].includes(action);
        }
        return false;
    }

    if (policy.enabled === 0) return false;

    switch (action) {
        case 'discovery':
            return policy.discovery_permitted === 1;
        case 'public_nav':
            return policy.public_nav_permitted === 1;
        case 'feed_access':
            return policy.feed_access_permitted === 1;
        case 'authenticated':
            return policy.authenticated_permitted === 1;
        case 'autofill':
            return policy.autofill_permitted === 1;
        default:
            return false;
    }
}

/* ========== Source Scans ========== */

/**
 * Atomically check and claim an ATS validation scan slot in `source_scans`.
 *
 * - For approved, active, permitted companies: creates a normal recurring scan record.
 * - For unverified, paused, or non-monitoring companies: atomically claims at most ONE
 *   validation attempt per (company_id, source_type, board_identifier) using a
 *   deterministic PRIMARY KEY in `source_scans`. Concurrent callers cannot both claim.
 */
export function claimAtsValidationScan(companyId, sourceType, boardIdentifier = null) {
    const normSource = String(sourceType || '').trim().toLowerCase();
    const normBoard = boardIdentifier ? String(boardIdentifier).trim().toLowerCase() : '';

    return runInTransaction((db) => {
        const company = db.prepare(
            'SELECT lifecycle_status, monitoring_status, policy_status, board_identifier FROM companies WHERE id = ?'
        ).get(companyId);

        if (!company) {
            return { permitted: false, scanId: null, isRecurring: false, reason: 'Company not found' };
        }
        if (['DISABLED', 'REJECTED'].includes(company.lifecycle_status) || company.policy_status === 'blocked') {
            return { permitted: false, scanId: null, isRecurring: false, reason: 'ATS validation blocked by company lifecycle or policy' };
        }

        const policy = db.prepare(
            'SELECT * FROM source_policies WHERE company_id = ? AND LOWER(source_type) = ?'
        ).get(companyId, normSource);

        if (!checkAtsValidationPolicy(company, policy)) {
            return { permitted: false, scanId: null, isRecurring: false, reason: 'ATS validation blocked by source policy' };
        }

        const startedAt = new Date().toISOString();
        if (isRecurringMonitoringEligible(company)) {
            const scanId = createSourceScan({
                company_id: companyId,
                source_type: normSource,
                started_at: startedAt
            });
            return { permitted: true, scanId, isRecurring: true, oneTime: false, reason: 'Recurring monitoring permitted' };
        }

        if (hasPriorAtsValidationScan(db, companyId, normSource, normBoard, company)) {
            return { permitted: false, scanId: null, isRecurring: false, oneTime: true, reason: 'One-time ATS validation already attempted for this board' };
        }

        const claimId = normBoard
            ? buildAtsValidationClaimId(companyId, normSource, normBoard)
            : buildAtsValidationClaimId(companyId, normSource, '__default__');

        const info = db.prepare(`
            INSERT OR IGNORE INTO source_scans (
                id, company_id, source_type, started_at, completed_at,
                total_jobs, new_jobs, duplicate_jobs, errors, is_complete, error_details
            ) VALUES (?, ?, ?, ?, NULL, 0, 0, 0, 0, 0, NULL)
        `).run(claimId, companyId, normSource, startedAt);

        if (info.changes === 0) {
            return { permitted: false, scanId: null, isRecurring: false, oneTime: true, reason: 'One-time ATS validation already claimed' };
        }

        return { permitted: true, scanId: claimId, isRecurring: false, oneTime: true, reason: 'One-time ATS validation claimed' };
    });
}

export function createSourceScan(s) {
    const db = getDb();
    const id = s.id || `scan_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const stmt = db.prepare(`
        INSERT INTO source_scans (id, company_id, source_type, started_at, completed_at, total_jobs, new_jobs, duplicate_jobs, errors, is_complete, error_details)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
        id, s.company_id, s.source_type, s.started_at || new Date().toISOString(), s.completed_at || null,
        s.total_jobs || 0, s.new_jobs || 0, s.duplicate_jobs || 0, s.errors || 0, s.is_complete ? 1 : 0, s.error_details || null
    );
    return id;
}

export function updateSourceScan(id, updates) {
    const db = getDb();
    const cols = Object.keys(updates).filter(k => k !== 'id');
    if (cols.length === 0) return;

    const setClause = cols.map(k => `${k} = ?`).join(', ');
    const vals = cols.map(k => {
        const v = updates[k];
        if (typeof v === 'boolean') return v ? 1 : 0;
        return v ?? null;
    });

    const stmt = db.prepare(`UPDATE source_scans SET ${setClause} WHERE id = ?`);
    stmt.run(...vals, id);
}

export function getSourceScan(id) {
    return getDb().prepare('SELECT * FROM source_scans WHERE id = ?').get(id);
}

/* ========== Job Postings & Content Hashing ========== */

export function computeJobContentHash(job) {
    const norm = {
        title: (job.title || '').trim(),
        description: (job.description || '').trim(),
        location: (job.location || '').trim(),
        remote_type: job.remote_type || null,
        employment_type: job.employment_type || null,
        applicant_eligibility: (job.applicant_eligibility || '').trim()
    };
    return createHash('sha256').update(JSON.stringify(norm)).digest('hex');
}

/**
 * Upsert a job posting.
 * Rules:
 *  - First insertion: creates initial snapshot, sets content_hash, content_updated_at, last_seen_at.
 *  - Actual content change: updates job, creates new snapshot, updates content_hash, content_updated_at, last_seen_at.
 *  - Identical repeat scan: no new snapshot, updates only last_seen_at. Preserves original source_updated_at.
 *
 * Returns a result object { status, isNew, contentChanged, snapshotCreated }
 * which evaluates to boolean (isNew) when cast as primitive.
 */
const AUTHORITATIVE_ATS_SOURCES = new Set(['greenhouse', 'lever', 'ashby', 'workday', 'smartrecruiters', 'workable', 'recruitee']);

function pickNewerSourceUpdatedAt(existingTs, incomingTs) {
    if (!incomingTs) return existingTs || null;
    if (!existingTs) return incomingTs;
    const existMs = new Date(existingTs).getTime();
    const incMs = new Date(incomingTs).getTime();
    if (Number.isNaN(incMs)) return existingTs;
    if (Number.isNaN(existMs)) return incomingTs;
    return incMs > existMs ? incomingTs : existingTs;
}

export function upsertJobPosting(j) {
    const db = getDb();
    const hash = j.content_hash || computeJobContentHash(j);
    const existing = db.prepare('SELECT id, content_hash, source, source_job_id, source_updated_at, created_at FROM job_postings WHERE id = ?').get(j.id);

    let status = 'unchanged';
    let isNew = false;
    let contentChanged = false;
    let snapshotCreated = false;

    runInTransaction((txDb) => {
        const now = new Date().toISOString();

        if (!existing) {
            isNew = true;
            status = 'inserted';
            contentChanged = true;

            const stmt = txDb.prepare(`
                INSERT INTO job_postings
                (id, company_id, title, location, remote_type, applicant_eligibility, employment_type, job_url, description, source, source_job_id, source_updated_at, discovered_at, status, content_hash, content_updated_at, last_seen_at, created_at, updated_at)
                VALUES
                (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            `);
            stmt.run(
                j.id, j.company_id, j.title, j.location || null, j.remote_type || null,
                j.applicant_eligibility || null, j.employment_type || null, j.job_url, j.description || null,
                j.source, j.source_job_id || null, j.source_updated_at || null,
                j.discovered_at || now, j.status || 'discovered',
                hash, now, now
            );

            if (j.raw_json) {
                const rawStr = typeof j.raw_json === 'string' ? j.raw_json : JSON.stringify(j.raw_json);
                const snapStmt = txDb.prepare(`
                    INSERT INTO job_snapshots (job_id, raw_json, content_hash, fetched_at)
                    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
                `);
                snapStmt.run(j.id, rawStr, hash);
                snapshotCreated = true;
            }
        } else {
            const existingIsAts = AUTHORITATIVE_ATS_SOURCES.has(existing.source);
            const incomingIsAts = AUTHORITATIVE_ATS_SOURCES.has(j.source);

            // Prevent secondary/discussion sources from overwriting authoritative ATS primary fields
            if (existingIsAts && !incomingIsAts) {
                status = 'unchanged';
                txDb.prepare(`
                    UPDATE job_postings SET last_seen_at = ? WHERE id = ?
                `).run(now, j.id);

                if (j.raw_json) {
                    const dupSnap = txDb.prepare(
                        'SELECT id FROM job_snapshots WHERE job_id = ? AND content_hash = ? LIMIT 1'
                    ).get(j.id, hash);
                    if (!dupSnap) {
                        const rawStr = typeof j.raw_json === 'string' ? j.raw_json : JSON.stringify(j.raw_json);
                        txDb.prepare(`
                            INSERT INTO job_snapshots (job_id, raw_json, content_hash, fetched_at)
                            VALUES (?, ?, ?, CURRENT_TIMESTAMP)
                        `).run(j.id, rawStr, hash);
                        snapshotCreated = true;
                    }
                }
                return;
            }

            contentChanged = existing.content_hash !== hash;

            if (contentChanged) {
                status = 'updated';
                const effectiveUpdatedAt = pickNewerSourceUpdatedAt(existing.source_updated_at, j.source_updated_at);
                const stmt = txDb.prepare(`
                    UPDATE job_postings SET
                        title = ?,
                        location = COALESCE(?, location),
                        remote_type = COALESCE(?, remote_type),
                        applicant_eligibility = COALESCE(?, applicant_eligibility),
                        employment_type = COALESCE(?, employment_type),
                        description = COALESCE(?, description),
                        source = ?,
                        source_job_id = COALESCE(?, source_job_id),
                        source_updated_at = ?,
                        status = COALESCE(?, status),
                        content_hash = ?,
                        content_updated_at = ?,
                        last_seen_at = ?,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                `);
                stmt.run(
                    j.title, j.location || null, j.remote_type || null,
                    j.applicant_eligibility || null, j.employment_type || null,
                    j.description || null, j.source, j.source_job_id || null,
                    effectiveUpdatedAt, j.status || null,
                    hash, now, now, j.id
                );

                if (j.raw_json) {
                    const rawStr = typeof j.raw_json === 'string' ? j.raw_json : JSON.stringify(j.raw_json);
                    const snapStmt = txDb.prepare(`
                        INSERT INTO job_snapshots (job_id, raw_json, content_hash, fetched_at)
                        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
                    `);
                    snapStmt.run(j.id, rawStr, hash);
                    snapshotCreated = true;
                }
            } else {
                status = 'unchanged';
                // Routine refresh: update last_seen_at without creating a snapshot
                // Preserve source_updated_at unless provider supplies a newer timestamp
                const effectiveUpdatedAt = pickNewerSourceUpdatedAt(existing.source_updated_at, j.source_updated_at);
                const stmt = txDb.prepare(`
                    UPDATE job_postings SET
                        last_seen_at = ?,
                        source_updated_at = ?
                    WHERE id = ?
                `);
                stmt.run(now, effectiveUpdatedAt, j.id);
            }
        }
    });

    const result = {
        status,
        isNew,
        contentChanged,
        snapshotCreated
    };
    result[Symbol.toPrimitive] = () => isNew;
    result.valueOf = () => isNew;
    return result;
}

export function getSnapshotsForJob(jobId) {
    return getDb().prepare('SELECT * FROM job_snapshots WHERE job_id = ? ORDER BY id DESC').all(jobId);
}

/**
 * Retrieves full canonical multi-source provenance for a job posting without duplicating records.
 * Combines primary job_postings metadata, snapshot history, source_leads, and source_lead_observations.
 */
export function getJobProvenance(jobId) {
    const db = getDb();
    const job = db.prepare('SELECT * FROM job_postings WHERE id = ?').get(jobId);
    if (!job) return null;

    const snapshots = getSnapshotsForJob(jobId);
    const leads = db.prepare(`
        SELECT * FROM source_leads
        WHERE resolved_job_id = ? OR canonical_url = ?
        ORDER BY first_discovered_at ASC
    `).all(jobId, job.job_url);

    const leadIds = leads.map(l => l.id);
    let observations = [];
    if (leadIds.length > 0) {
        const placeholders = leadIds.map(() => '?').join(',');
        observations = db.prepare(`
            SELECT * FROM source_lead_observations
            WHERE lead_id IN (${placeholders}) OR raw_url = ?
            ORDER BY observed_at ASC, id ASC
        `).all(...leadIds, job.job_url);
    } else {
        observations = db.prepare(`
            SELECT * FROM source_lead_observations
            WHERE raw_url = ?
            ORDER BY observed_at ASC, id ASC
        `).all(job.job_url);
    }

    const sources = new Set();
    if (job.source) sources.add(job.source);
    for (const obs of observations) {
        if (obs.provider) sources.add(obs.provider);
    }

    const urls = new Set();
    if (job.job_url) urls.add(job.job_url);
    for (const l of leads) {
        if (l.canonical_url) urls.add(l.canonical_url);
    }
    for (const obs of observations) {
        if (obs.raw_url) urls.add(obs.raw_url);
        if (obs.provider_payload_json) {
            try {
                const payload = JSON.parse(obs.provider_payload_json);
                if (payload?.permalink) urls.add(payload.permalink);
                if (payload?.applicationUrl) urls.add(payload.applicationUrl);
            } catch { /* ignore */ }
        }
    }
    for (const snap of snapshots) {
        if (snap.raw_json) {
            try {
                const raw = JSON.parse(snap.raw_json);
                if (raw?.permalink) urls.add(raw.permalink);
                if (raw?.jobUrl) urls.add(raw.jobUrl);
                if (raw?.specificJobUrl) urls.add(raw.specificJobUrl);
                if (raw?.applicationUrl) urls.add(raw.applicationUrl);
            } catch { /* ignore */ }
        }
    }

    return {
        jobId: job.id,
        primarySource: job.source,
        primarySourceJobId: job.source_job_id,
        canonicalUrl: job.job_url,
        sources: Array.from(sources),
        originalUrls: Array.from(urls),
        snapshots,
        leads,
        observations
    };
}

export function getJob(id) {
    const db = getDb();
    const job = db.prepare('SELECT * FROM job_postings WHERE id = ?').get(id);
    if (!job) return undefined;
    const raw = db.prepare('SELECT raw_json FROM job_snapshots WHERE job_id = ? ORDER BY id DESC LIMIT 1').get(id);
    return { ...job, raw_json: raw?.raw_json };
}

export function getJobByUrl(url) {
    return getDb().prepare('SELECT * FROM job_postings WHERE job_url = ?').get(url);
}

export function getJobsByFilter(filters = {}) {
    const db = getDb();
    const conditions = [];
    const params = [];

    for (const [key, value] of Object.entries(filters)) {
        if (value !== undefined) {
            conditions.push(`${key} = ?`);
            params.push(value);
        }
    }

    const sql = `SELECT * FROM job_postings ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''} ORDER BY discovered_at DESC`;
    return db.prepare(sql).all(...params);
}

export function countJobs() {
    return getDb().prepare('SELECT count(*) as count FROM job_postings').get().count;
}

/* ========== Candidate Facts & Evidence ========== */

export function upsertCandidateFact(fact) {
    const db = getDb();
    const stmt = db.prepare(`
        INSERT INTO candidate_facts
        (id, category, identifier, value, evidence_type, evidence_url, verified, created_at)
        VALUES
        (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(category, identifier, value) DO UPDATE SET
            evidence_type = excluded.evidence_type,
            evidence_url = excluded.evidence_url,
            verified = excluded.verified
    `);
    stmt.run(
        fact.id, fact.category, fact.identifier, fact.value,
        fact.evidence_type || 'self-attested', fact.evidence_url || null,
        fact.verified ? 1 : 0
    );
    return fact.id;
}

export function getCandidateFacts(category = null) {
    const db = getDb();
    if (category) {
        return db.prepare('SELECT * FROM candidate_facts WHERE category = ? ORDER BY identifier').all(category);
    }
    return db.prepare('SELECT * FROM candidate_facts ORDER BY category, identifier').all();
}

export function countCandidateFacts() {
    return getDb().prepare('SELECT count(*) as count FROM candidate_facts').get().count;
}

export function insertEvidenceRecord(ev) {
    const db = getDb();
    const stmt = db.prepare(`
        INSERT INTO evidence_records (id, fact_id, title, description, source_type, source_reference, verified, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO UPDATE SET
            title = excluded.title,
            description = excluded.description,
            verified = excluded.verified
    `);
    stmt.run(
        ev.id, ev.fact_id, ev.title, ev.description,
        ev.source_type, ev.source_reference, ev.verified ? 1 : 0
    );
    return ev.id;
}

export function getEvidenceForFact(factId) {
    return getDb().prepare('SELECT * FROM evidence_records WHERE fact_id = ?').all(factId);
}

/* ========== Candidate Answers ========== */

export function upsertCandidateAnswer(ans) {
    const db = getDb();
    const stmt = db.prepare(`
        INSERT INTO candidate_answers (id, question_key, question_text, answer_value, context, source, confidence, confirmed_by_user, confirmed_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(question_key) DO UPDATE SET
            question_text = excluded.question_text,
            answer_value = excluded.answer_value,
            context = excluded.context,
            source = excluded.source,
            confidence = excluded.confidence,
            confirmed_by_user = COALESCE(excluded.confirmed_by_user, candidate_answers.confirmed_by_user),
            confirmed_at = COALESCE(excluded.confirmed_at, candidate_answers.confirmed_at),
            updated_at = CURRENT_TIMESTAMP
    `);
    stmt.run(
        ans.id, ans.question_key, ans.question_text, ans.answer_value,
        ans.context || null, ans.source || 'verified_profile', ans.confidence ?? 1.0,
        ans.confirmed_by_user ?? 0, ans.confirmed_at || null
    );
    return ans.id;
}

export function getAnswerByKey(key) {
    return getDb().prepare('SELECT * FROM candidate_answers WHERE question_key = ?').get(key);
}

export function getApplicationsByState(state) {
    return getDb().prepare('SELECT * FROM applications WHERE state = ? ORDER BY updated_at DESC').all(state);
}

/* ========== Applications & Events ========== */

export function upsertApplication(app) {
    const db = getDb();
    const stmt = db.prepare(`
        INSERT INTO applications
        (id, job_id, company_id, resume_version_id, state, score, score_details_json, notes, report_path, started_at, submitted_at, updated_at)
        VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(job_id) DO UPDATE SET
            company_id = excluded.company_id,
            resume_version_id = COALESCE(excluded.resume_version_id, applications.resume_version_id),
            state = excluded.state,
            score = COALESCE(excluded.score, applications.score),
            score_details_json = COALESCE(excluded.score_details_json, applications.score_details_json),
            notes = COALESCE(excluded.notes, applications.notes),
            report_path = COALESCE(excluded.report_path, applications.report_path),
            started_at = COALESCE(excluded.started_at, applications.started_at),
            submitted_at = COALESCE(excluded.submitted_at, applications.submitted_at),
            updated_at = CURRENT_TIMESTAMP
    `);
    stmt.run(
        app.id, app.job_id, app.company_id, app.resume_version_id || null,
        app.state || 'DISCOVERED', app.score || null,
        app.score_details_json || null, app.notes || null,
        app.report_path || null, app.started_at || null, app.submitted_at || null
    );
    return app.id;
}

export function getApplicationByJobId(jobId) {
    return getDb().prepare('SELECT * FROM applications WHERE job_id = ?').get(jobId);
}

export function getApplication(id) {
    return getDb().prepare('SELECT * FROM applications WHERE id = ?').get(id);
}

export function getAllApplications() {
    return getDb().prepare('SELECT * FROM applications ORDER BY created_at DESC').all();
}

export function countApplications() {
    return getDb().prepare('SELECT count(*) as count FROM applications').get().count;
}

export const RECRUITMENT_OUTCOMES = {
    APPLIED: 'APPLIED',
    RESPONDED: 'RESPONDED',
    INTERVIEW: 'INTERVIEW',
    OFFER: 'OFFER',
    REJECTED: 'REJECTED',
    WITHDRAWN: 'WITHDRAWN',
    DISCARDED: 'DISCARDED',
    SKIP: 'SKIP'
};

export function createApplication(app) {
    const db = getDb();
    const id = app.id || `app_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const state = app.state || APPLICATION_STATES.NOT_STARTED;

    // Check if active application already exists for this job
    const existing = db.prepare('SELECT id, state, recruitment_outcome FROM applications WHERE job_id = ?').get(app.job_id);
    if (existing && !app.allowMultipleAttempts) {
        throw new Error(`Active application already exists for job ${app.job_id} (application ID: ${existing.id})`);
    }

    return runInTransaction((db) => {
        db.prepare(`
            INSERT INTO applications
            (id, job_id, company_id, resume_version_id, state, score, score_details_json, notes, report_path,
             started_at, submitted_at, portal_type, portal_url, submission_policy, recruitment_outcome,
             recruitment_outcome_at, source_origin, source_row_id, external_reference, created_at, updated_at)
            VALUES
            (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `).run(
            id,
            app.job_id,
            app.company_id,
            app.resume_version_id || null,
            state,
            app.score || null,
            app.score_details_json ? (typeof app.score_details_json === 'string' ? app.score_details_json : JSON.stringify(app.score_details_json)) : null,
            app.notes || null,
            app.report_path || null,
            app.started_at || null,
            app.submitted_at || null,
            app.portal_type || null,
            app.portal_url || null,
            app.submission_policy || 'MANUAL_REVIEW',
            app.recruitment_outcome || null,
            app.recruitment_outcome_at || null,
            app.source_origin || 'manual',
            app.source_row_id || null,
            app.external_reference || null,
            app.created_at || new Date().toISOString()
        );

        // Record initial event with idempotent key
        const idempotencyKey = app.idempotency_key || `event_init_${id}_${state}`;
        db.prepare(`
            INSERT OR IGNORE INTO application_events
            (application_id, previous_state, new_state, event_type, message, payload_json, actor, idempotency_key, source_origin, created_at)
            VALUES (?, NULL, ?, 'application_created', ?, ?, ?, ?, ?, ?)
        `).run(
            id,
            state,
            app.notes || 'Application initialized',
            null,
            app.actor || 'system',
            idempotencyKey,
            app.source_origin || 'manual',
            app.created_at || new Date().toISOString()
        );

        return id;
    });
}

export const APPLICATION_STATES = {
    NOT_STARTED: 'NOT_STARTED',
    DRAFTING: 'DRAFTING',
    PORTAL_OPENED: 'PORTAL_OPENED',
    FORM_FILLING: 'FORM_FILLING',
    NEEDS_USER_INPUT: 'NEEDS_USER_INPUT',
    AUTHENTICATION_REQUIRED: 'AUTHENTICATION_REQUIRED',
    READY_FOR_REVIEW: 'READY_FOR_REVIEW',
    SUBMISSION_APPROVED: 'SUBMISSION_APPROVED',
    SUBMITTING: 'SUBMITTING',
    CONFIRMED: 'CONFIRMED',
    UNCERTAIN_OUTCOME: 'UNCERTAIN_OUTCOME'
};

export const LEGAL_TRANSITIONS = {
    [APPLICATION_STATES.NOT_STARTED]: [
        APPLICATION_STATES.DRAFTING
    ],
    [APPLICATION_STATES.DRAFTING]: [
        APPLICATION_STATES.PORTAL_OPENED,
        APPLICATION_STATES.NEEDS_USER_INPUT,
        APPLICATION_STATES.NOT_STARTED
    ],
    [APPLICATION_STATES.PORTAL_OPENED]: [
        APPLICATION_STATES.FORM_FILLING,
        APPLICATION_STATES.AUTHENTICATION_REQUIRED,
        APPLICATION_STATES.NEEDS_USER_INPUT,
        APPLICATION_STATES.DRAFTING
    ],
    [APPLICATION_STATES.FORM_FILLING]: [
        APPLICATION_STATES.NEEDS_USER_INPUT,
        APPLICATION_STATES.AUTHENTICATION_REQUIRED,
        APPLICATION_STATES.READY_FOR_REVIEW,
        APPLICATION_STATES.DRAFTING
    ],
    [APPLICATION_STATES.NEEDS_USER_INPUT]: [
        APPLICATION_STATES.FORM_FILLING,
        APPLICATION_STATES.READY_FOR_REVIEW,
        APPLICATION_STATES.DRAFTING
    ],
    [APPLICATION_STATES.AUTHENTICATION_REQUIRED]: [
        APPLICATION_STATES.PORTAL_OPENED,
        APPLICATION_STATES.FORM_FILLING,
        APPLICATION_STATES.DRAFTING
    ],
    [APPLICATION_STATES.READY_FOR_REVIEW]: [
        APPLICATION_STATES.SUBMISSION_APPROVED,
        APPLICATION_STATES.DRAFTING,
        APPLICATION_STATES.NEEDS_USER_INPUT
    ],
    [APPLICATION_STATES.SUBMISSION_APPROVED]: [
        APPLICATION_STATES.SUBMITTING,
        APPLICATION_STATES.READY_FOR_REVIEW
    ],
    [APPLICATION_STATES.SUBMITTING]: [
        APPLICATION_STATES.CONFIRMED,
        APPLICATION_STATES.UNCERTAIN_OUTCOME
    ],
    [APPLICATION_STATES.CONFIRMED]: [],
    [APPLICATION_STATES.UNCERTAIN_OUTCOME]: [
        APPLICATION_STATES.CONFIRMED,
        APPLICATION_STATES.READY_FOR_REVIEW,
        APPLICATION_STATES.DRAFTING
    ]
};

export const EXECUTION_TRANSITIONS = LEGAL_TRANSITIONS;

export function recordApplicationEvent({
    application_id,
    previous_state = null,
    new_state = null,
    to_state = null,
    event_type = 'state_change',
    message = null,
    payload_json = null,
    actor = 'system',
    idempotency_key = null,
    source_origin = 'runtime',
    created_at = null
}) {
    const db = getDb();
    const eventTime = created_at || new Date().toISOString();
    const targetState = new_state ?? to_state ?? null;
    const payloadStr = payload_json ? (typeof payload_json === 'string' ? payload_json : JSON.stringify(payload_json)) : null;

    if (idempotency_key) {
        const stmt = db.prepare(`
            INSERT OR IGNORE INTO application_events
            (application_id, previous_state, new_state, event_type, message, payload_json, actor, idempotency_key, source_origin, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const info = stmt.run(
            application_id, previous_state, targetState, event_type, message,
            payloadStr, actor, idempotency_key, source_origin, eventTime
        );
        return info.changes > 0;
    }

    const stmt = db.prepare(`
        INSERT INTO application_events
        (application_id, previous_state, new_state, event_type, message, payload_json, actor, idempotency_key, source_origin, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
    `);
    stmt.run(
        application_id, previous_state, targetState, event_type, message,
        payloadStr, actor, source_origin, eventTime
    );
    return true;
}

export function updateApplicationState(applicationId, newState, {
    actor = 'system',
    eventType = 'state_change',
    message = null,
    payload = null,
    idempotencyKey = null,
    sourceOrigin = 'runtime',
    eventTime = null
} = {}) {
    const db = getDb();
    const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(applicationId);
    if (!app) {
        throw new Error(`Application not found: ${applicationId}`);
    }

    const currentState = app.state;

    // Allow no-op transition (re-asserting same state)
    if (currentState !== newState) {
        // Handle migration from legacy states like DISCOVERED / DRAFT
        const normalizedCurrent = (currentState === 'DISCOVERED' || currentState === 'DRAFT')
            ? APPLICATION_STATES.NOT_STARTED
            : currentState;

        const allowedNext = LEGAL_TRANSITIONS[normalizedCurrent] || [];
        if (!allowedNext.includes(newState)) {
            throw new Error(`Illegal application state transition from ${currentState} to ${newState}`);
        }
    } else {
        // Re-asserting identical state without message/payload is a no-op: suppress duplicate event
        if (!message && !payload) {
            return true;
        }
    }

    const finalEventTime = eventTime || new Date().toISOString();
    const key = idempotencyKey || (currentState !== newState ? `state_${applicationId}_${currentState}_${newState}_${finalEventTime.slice(0, 19)}` : null);

    return runInTransaction((db) => {
        db.prepare(`
            UPDATE applications
            SET state = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `).run(newState, applicationId);

        if (key) {
            db.prepare(`
                INSERT OR IGNORE INTO application_events
                (application_id, previous_state, new_state, event_type, message, payload_json, actor, idempotency_key, source_origin, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                applicationId,
                currentState,
                newState,
                eventType,
                message,
                payload ? (typeof payload === 'string' ? payload : JSON.stringify(payload)) : null,
                actor,
                key,
                sourceOrigin,
                finalEventTime
            );
        } else {
            db.prepare(`
                INSERT INTO application_events
                (application_id, previous_state, new_state, event_type, message, payload_json, actor, idempotency_key, source_origin, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
            `).run(
                applicationId,
                currentState,
                newState,
                eventType,
                message,
                payload ? (typeof payload === 'string' ? payload : JSON.stringify(payload)) : null,
                actor,
                sourceOrigin,
                finalEventTime
            );
        }

        return true;
    });
}

export function updateRecruitmentOutcome(applicationId, newOutcome, options = {}) {
    const opts = typeof options === 'string' ? { message: options } : (options || {});
    const {
        actor = 'user',
        notes = null,
        outcomeAt = null,
        eventType = 'recruitment_outcome_change',
        message = opts.message || null,
        idempotencyKey = null,
        sourceOrigin = 'runtime'
    } = opts;
    const validOutcomes = Object.values(RECRUITMENT_OUTCOMES);
    if (!validOutcomes.includes(newOutcome)) {
        throw new Error(`Invalid recruitment outcome: ${newOutcome}. Allowed: ${validOutcomes.join(', ')}`);
    }

    const db = getDb();
    const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(applicationId);
    if (!app) {
        throw new Error(`Application not found: ${applicationId}`);
    }

    const currentOutcome = app.recruitment_outcome;
    if (currentOutcome === newOutcome && !notes && !message) {
        return true; // No-op, duplicate suppressed
    }

    const finalOutcomeAt = outcomeAt || new Date().toISOString();
    const key = idempotencyKey || `recruitment_${applicationId}_${newOutcome}_${finalOutcomeAt.slice(0, 10)}`;

    return runInTransaction((db) => {
        db.prepare(`
            UPDATE applications
            SET recruitment_outcome = ?,
                recruitment_outcome_at = ?,
                notes = COALESCE(?, notes),
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `).run(newOutcome, finalOutcomeAt, notes, applicationId);

        db.prepare(`
            INSERT OR IGNORE INTO application_events
            (application_id, previous_state, new_state, event_type, message, payload_json, actor, idempotency_key, source_origin, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            applicationId,
            currentOutcome || app.state,
            newOutcome,
            eventType,
            message || `Recruitment outcome updated to ${newOutcome}`,
            notes ? JSON.stringify({ notes }) : null,
            actor,
            key,
            sourceOrigin,
            finalOutcomeAt
        );

        return true;
    });
}

export function associateResumeVersion(applicationId, resumeVersionId, { actor = 'system', notes = null } = {}) {
    const db = getDb();
    const resume = db.prepare('SELECT id, variant_label, file_path FROM resume_versions WHERE id = ?').get(resumeVersionId);
    if (!resume) {
        throw new Error(`Resume version not found: ${resumeVersionId}`);
    }

    const app = db.prepare('SELECT id, resume_version_id, state FROM applications WHERE id = ?').get(applicationId);
    if (!app) {
        throw new Error(`Application not found: ${applicationId}`);
    }

    return runInTransaction((db) => {
        db.prepare(`
            UPDATE applications
            SET resume_version_id = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `).run(resumeVersionId, applicationId);

        db.prepare(`
            INSERT INTO application_events
            (application_id, previous_state, new_state, event_type, message, payload_json, actor, source_origin, created_at)
            VALUES (?, ?, ?, 'resume_associated', ?, ?, ?, 'runtime', CURRENT_TIMESTAMP)
        `).run(
            applicationId,
            app.state,
            app.state,
            `Associated tailored resume ${resume.variant_label} (${resumeVersionId})`,
            JSON.stringify({ resumeVersionId, variant: resume.variant_label, filePath: resume.file_path, notes }),
            actor
        );

        return true;
    });
}

export function updateApplicationExecution(applicationId, updates = {}) {
    const db = getDb();
    const allowedCols = [
        'portal_type', 'portal_url', 'submission_policy',
        'submission_authorization_id', 'submission_authorized_at', 'submission_authorized_by',
        'execution_metadata_json', 'review_packet_path', 'confirmation_reference',
        'error_details', 'last_active_at', 'started_at', 'submitted_at', 'notes',
        'resume_version_id', 'score', 'score_details_json',
        'recruitment_outcome', 'recruitment_outcome_at', 'source_origin', 'source_row_id', 'external_reference'
    ];

    const setClauses = [];
    const values = [];

    for (const [key, val] of Object.entries(updates)) {
        if (allowedCols.includes(key)) {
            setClauses.push(`${key} = ?`);
            if (val && typeof val === 'object' && key.endsWith('_json')) {
                values.push(JSON.stringify(val));
            } else {
                values.push(val === undefined ? null : val);
            }
        }
    }

    if (setClauses.length === 0) return false;

    setClauses.push('updated_at = CURRENT_TIMESTAMP');
    values.push(applicationId);

    const sql = `UPDATE applications SET ${setClauses.join(', ')} WHERE id = ?`;
    db.prepare(sql).run(...values);
    return true;
}

export function getApplicationEvents(applicationId) {
    return getDb().prepare(`
        SELECT * FROM application_events
        WHERE application_id = ?
        ORDER BY created_at ASC, id ASC
    `).all(applicationId);
}

export function migrateAuthorizationsSchema() {
    const db = getDb();
    const cols = db.prepare("PRAGMA table_info('submission_authorizations')").all().map(c => c.name);
    if (!cols.includes('packet_hash')) {
        db.exec("ALTER TABLE submission_authorizations ADD COLUMN packet_hash TEXT");
    }
    if (!cols.includes('resume_version_id')) {
        db.exec("ALTER TABLE submission_authorizations ADD COLUMN resume_version_id TEXT");
    }
    if (!cols.includes('payload_digest')) {
        db.exec("ALTER TABLE submission_authorizations ADD COLUMN payload_digest TEXT");
    }
}

export function createSubmissionAuthorization({
    id,
    scope = 'single',
    application_id = null,
    max_applications = 1,
    allowed_company_ids = null,
    expires_at = null,
    authorized_by = 'user',
    packet_hash = null,
    resume_version_id = null,
    payload_digest = null
}) {
    migrateAuthorizationsSchema();
    const db = getDb();
    const authId = id || `auth_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    db.prepare(`
        INSERT INTO submission_authorizations
        (id, scope, application_id, max_applications, used_count, allowed_company_ids_json, expires_at, authorized_by, status, packet_hash, resume_version_id, payload_digest, created_at)
        VALUES (?, ?, ?, ?, 0, ?, ?, ?, 'active', ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(
        authId,
        scope,
        application_id,
        max_applications,
        allowed_company_ids ? JSON.stringify(allowed_company_ids) : null,
        expires_at,
        authorized_by,
        packet_hash,
        resume_version_id,
        payload_digest
    );
    return authId;
}

export function getSubmissionAuthorization(id) {
    return getDb().prepare('SELECT * FROM submission_authorizations WHERE id = ?').get(id);
}

export function getValidSubmissionAuthorization(applicationId, companyId = null) {
    const db = getDb();
    // 1. Check exact single application authorization
    const single = db.prepare(`
        SELECT * FROM submission_authorizations
        WHERE application_id = ? AND status = 'active'
    `).get(applicationId);

    if (single) {
        if (single.expires_at && new Date(single.expires_at) < new Date()) {
            db.prepare("UPDATE submission_authorizations SET status = 'expired' WHERE id = ?").run(single.id);
            return null;
        }
        return single;
    }

    // 2. Check active bounded_batch authorization
    const batches = db.prepare(`
        SELECT * FROM submission_authorizations
        WHERE scope = 'bounded_batch' AND status = 'active' AND used_count < max_applications
        ORDER BY created_at DESC
    `).all();

    for (const batch of batches) {
        if (batch.expires_at && new Date(batch.expires_at) < new Date()) {
            db.prepare("UPDATE submission_authorizations SET status = 'expired' WHERE id = ?").run(batch.id);
            continue;
        }
        if (batch.allowed_company_ids_json && companyId) {
            try {
                const allowed = JSON.parse(batch.allowed_company_ids_json);
                if (Array.isArray(allowed) && !allowed.includes(companyId)) {
                    continue;
                }
            } catch {}
        }
        return batch;
    }

    return null;
}

export function useSubmissionAuthorization(id) {
    const db = getDb();
    const auth = db.prepare('SELECT * FROM submission_authorizations WHERE id = ?').get(id);
    if (!auth) return false;

    const newUsed = (auth.used_count || 0) + 1;
    const newStatus = (newUsed >= auth.max_applications) ? 'used' : 'active';

    db.prepare(`
        UPDATE submission_authorizations
        SET used_count = ?, status = ?
        WHERE id = ?
    `).run(newUsed, newStatus, id);

    return true;
}

export function getCandidateAnswers() {
    return getDb().prepare('SELECT * FROM candidate_answers ORDER BY question_key ASC').all();
}

export function confirmCandidateAnswer(idOrKey, confirmedVal = null) {
    const db = getDb();
    db.prepare(`
        UPDATE candidate_answers
        SET confirmed_by_user = 1,
            confirmed_at = CURRENT_TIMESTAMP,
            answer_value = COALESCE(?, answer_value),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ? OR question_key = ?
    `).run(confirmedVal, idOrKey, idOrKey);
}

export function logApplicationEvent(evt) {
    const db = getDb();
    const stmt = db.prepare(`
        INSERT INTO application_events (application_id, previous_state, new_state, event_type, message, payload_json, actor, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);
    const res = stmt.run(
        evt.application_id, evt.previous_state || null, evt.new_state,
        evt.event_type || 'state_change', evt.message || null,
        evt.payload_json ? (typeof evt.payload_json === 'string' ? evt.payload_json : JSON.stringify(evt.payload_json)) : null,
        evt.actor || 'system'
    );
    return res.lastInsertRowid;
}

/* ========== Job Evaluations ========== */

export function upsertJobEvaluation(ev) {
    const db = getDb();
    const id = ev.id || `eval_${String(ev.job_id).replace(/[^a-z0-9]+/gi, '_').slice(-20)}_${Date.now()}`;
    const stmt = db.prepare(`
        INSERT INTO job_evaluations
        (id, job_id, archetype, match_score, recommendation, eval_details_json, evaluated_at)
        VALUES
        (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(job_id) DO UPDATE SET
            archetype = excluded.archetype,
            match_score = excluded.match_score,
            recommendation = excluded.recommendation,
            eval_details_json = excluded.eval_details_json,
            evaluated_at = CURRENT_TIMESTAMP
    `);
    stmt.run(
        id, ev.job_id, ev.archetype || null, ev.match_score ?? null,
        ev.recommendation || 'CONSIDER',
        ev.eval_details_json ? (typeof ev.eval_details_json === 'string' ? ev.eval_details_json : JSON.stringify(ev.eval_details_json)) : null
    );
    return id;
}

export function getJobEvaluation(jobId) {
    return getDb().prepare('SELECT * FROM job_evaluations WHERE job_id = ?').get(jobId);
}

/* ========== Duplicate Suggestions ========== */

export function findCrossSourceDuplicates(job) {
    const db = getDb();
    if (!job.company_id || !job.title) return [];

    const candidates = db.prepare(`
        SELECT id, source, source_job_id, job_url, title, location, remote_type, content_hash, description
        FROM job_postings
        WHERE company_id = ? AND LOWER(TRIM(title)) = LOWER(TRIM(?)) AND id != ?
    `).all(job.company_id, job.title, job.id);

    if (candidates.length === 0) return [];

    const normalize = s => (s || '').toLowerCase().trim().replace(/[^a-z0-9]/g, '');
    const jobLoc = normalize(job.location);
    const jobRemote = (job.remote_type || '').toLowerCase().trim();

    const suggestions = [];
    for (const r of candidates) {
        // 1. Same source with different requisition IDs -> distinct positions
        if (job.source && r.source && job.source === r.source && job.source_job_id && r.source_job_id && job.source_job_id !== r.source_job_id) {
            continue;
        }

        // 2. Different locations (when both specified) -> distinct positions
        const candLoc = normalize(r.location);
        if (jobLoc && candLoc && jobLoc !== candLoc) {
            continue;
        }

        // 3. Different remote scopes (when both specified) -> distinct positions
        const candRemote = (r.remote_type || '').toLowerCase().trim();
        if (jobRemote && candRemote && jobRemote !== candRemote) {
            continue;
        }

        // 4. Materially different descriptions (if both exist and lengths differ substantially)
        if (job.description && r.description && job.description.length > 50 && r.description.length > 50) {
            const minLen = Math.min(job.description.length, r.description.length);
            const maxLen = Math.max(job.description.length, r.description.length);
            if (minLen / maxLen < 0.5) {
                continue;
            }
        }

        try {
            db.prepare(`
                INSERT INTO duplicate_suggestions (original_job_id, duplicate_job_id, confidence, reasons)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(original_job_id, duplicate_job_id) DO NOTHING
            `).run(r.id, job.id, 0.95, `Conservative cross-source duplicate match (${r.source} vs ${job.source})`);
            suggestions.push(r.id);
        } catch {
            // ignore unique constraint
        }
    }
    return suggestions;
}

export function getDuplicateSuggestions() {
    return getDb().prepare('SELECT * FROM duplicate_suggestions ORDER BY created_at DESC').all();
}

/**
 * Resolves a duplicate suggestion with an explicit decision.
 * decision: 'CONFIRMED_DUPLICATE' | 'DISTINCT'
 */
export function resolveDuplicateSuggestion(id, { decision = 'CONFIRMED_DUPLICATE', notes = '' } = {}) {
    const db = getDb();
    const existing = db.prepare('SELECT * FROM duplicate_suggestions WHERE id = ?').get(id);
    if (!existing) return false;

    const prefix = decision === 'CONFIRMED_DUPLICATE' ? '[CONFIRMED_DUPLICATE]' : '[DISTINCT]';
    const updatedReasons = `${prefix} ${notes ? notes + ' | ' : ''}${existing.reasons || ''}`;

    db.prepare(`
        UPDATE duplicate_suggestions
        SET resolved = 1, reasons = ?
        WHERE id = ?
    `).run(updatedReasons, id);

    return true;
}

/**
 * Checks if a job has been confirmed as a duplicate of a canonical posting.
 * Unresolved suggestions (resolved = 0) or suggestions resolved as [DISTINCT] return null.
 * Returns canonical original_job_id if confirmed duplicate, null otherwise.
 */
export function isConfirmedDuplicate(duplicateJobId) {
    if (!duplicateJobId) return null;
    const db = getDb();
    const row = db.prepare(`
        SELECT original_job_id, reasons FROM duplicate_suggestions
        WHERE duplicate_job_id = ? AND resolved = 1
    `).get(duplicateJobId);

    if (!row) return null;
    if (row.reasons && row.reasons.includes('[DISTINCT]')) {
        return null;
    }
    return row.original_job_id;
}

/* ========== Search Leads & Provenance (Milestone 3A) ========== */

const TRACKING_QUERY_PARAMS = new Set([
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
    'ref', 'gh_src', 'lever-source', 'ashby_jid', 'fbclid', 'gclid',
    'trk', 'source', 'campaign', 'src', 'mc_cid', 'mc_eid'
]);

/**
 * Normalizes a raw URL into a canonical URL for lead deduplication.
 * Preserves meaningful query parameters (like job ID) while stripping tracking tokens.
 */
export function normalizeLeadUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return '';
    const trimmed = rawUrl.trim();

    try {
        const u = new URL(trimmed);

        // Normalize protocol to https unless localhost/test
        if (u.protocol === 'http:' && !u.hostname.includes('localhost') && !u.hostname.startsWith('127.')) {
            u.protocol = 'https:';
        }

        // Hostname lowercase
        u.hostname = u.hostname.toLowerCase();

        // Strip fragment
        u.hash = '';

        // Strip tracking params but preserve meaningful params
        const paramsToKeep = [];
        for (const [key, value] of u.searchParams.entries()) {
            if (!TRACKING_QUERY_PARAMS.has(key.toLowerCase())) {
                paramsToKeep.push([key, value]);
            }
        }

        // Sort params deterministically
        paramsToKeep.sort((a, b) => a[0].localeCompare(b[0]));
        u.search = '';
        for (const [k, v] of paramsToKeep) {
            u.searchParams.append(k, v);
        }

        // Normalize trailing slash in pathname (remove unless root '/')
        if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
            u.pathname = u.pathname.slice(0, -1);
        }

        return u.toString();
    } catch {
        return trimmed;
    }
}

/**
 * Ingests a search lead and records an observation record.
 * If canonical URL already exists in source_leads, increments observation_count
 * and links observation without duplicating the lead identity.
 */
export function ingestSearchLead({
    provider,
    query = null,
    rawUrl,
    title = null,
    snippet = null,
    resultRank = 1,
    companyName = null,
    companyId = null,
    providerPayload = null
}) {
    const db = getDb();
    if (!rawUrl) throw new Error('ingestSearchLead requires rawUrl');
    if (!provider) throw new Error('ingestSearchLead requires provider');

    const canonicalUrl = normalizeLeadUrl(rawUrl);
    const cleanTitle = title ? title.trim() : null;
    const cleanCompany = companyName ? companyName.trim() : null;
    const payloadJson = providerPayload ? (typeof providerPayload === 'string' ? providerPayload : JSON.stringify(providerPayload)) : null;

    return runInTransaction(() => {
        let lead = db.prepare('SELECT id, observation_count FROM source_leads WHERE canonical_url = ?').get(canonicalUrl);
        let leadId;
        let isNewLead = false;

        if (lead) {
            leadId = lead.id;
            db.prepare(`
                UPDATE source_leads
                SET observation_count = observation_count + 1,
                    last_observed_at = CURRENT_TIMESTAMP,
                    normalized_title = COALESCE(normalized_title, ?),
                    normalized_company_name = COALESCE(normalized_company_name, ?),
                    company_id = COALESCE(company_id, ?)
                WHERE id = ?
            `).run(cleanTitle ?? null, cleanCompany ?? null, companyId ?? null, leadId ?? null);
        } else {
            leadId = `lead_${createHash('sha256').update(canonicalUrl).digest('hex').slice(0, 16)}`;
            isNewLead = true;
            db.prepare(`
                INSERT INTO source_leads (
                    id, canonical_url, normalized_title, normalized_company_name,
                    company_id, first_discovered_at, last_observed_at, observation_count,
                    resolution_status
                ) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1, 'pending')
            `).run(leadId ?? null, canonicalUrl ?? null, cleanTitle ?? null, cleanCompany ?? null, companyId ?? null);
        }

        const obsId = `obs_${createHash('sha256').update(`${leadId}:${provider}:${rawUrl}:${Date.now()}:${Math.random()}`).digest('hex').slice(0, 16)}`;
        db.prepare(`
            INSERT INTO source_lead_observations (
                id, lead_id, provider, query, raw_url, result_rank, snippet,
                observed_at, provider_payload_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)
        `).run(obsId ?? null, leadId ?? null, provider ?? null, query ?? null, rawUrl ?? null, resultRank ?? 1, snippet ?? null, payloadJson ?? null);

        return {
            leadId,
            observationId: obsId,
            canonicalUrl,
            isNewLead
        };
    });
}

export function getLeadById(id) {
    return getDb().prepare('SELECT * FROM source_leads WHERE id = ?').get(id);
}

export function getLeadByCanonicalUrl(canonicalUrl) {
    return getDb().prepare('SELECT * FROM source_leads WHERE canonical_url = ?').get(canonicalUrl);
}

export function getObservationsForLead(leadId) {
    return getDb().prepare('SELECT * FROM source_lead_observations WHERE lead_id = ? ORDER BY observed_at DESC, rowid DESC').all(leadId);
}

export function listPendingLeads({ limit = 50, offset = 0 } = {}) {
    return getDb().prepare(`
        SELECT * FROM source_leads
        WHERE resolution_status = 'pending'
        ORDER BY last_observed_at DESC
        LIMIT ? OFFSET ?
    `).all(limit, offset);
}

export function resolveLead(leadId, {
    resolutionStatus = 'resolved_job',
    resolvedJobId = null,
    companyId = null,
    notes = null
} = {}) {
    const db = getDb();
    const result = db.prepare(`
        UPDATE source_leads
        SET resolution_status = ?,
            resolved_job_id = COALESCE(?, resolved_job_id),
            company_id = COALESCE(?, company_id),
            resolved_at = CURRENT_TIMESTAMP,
            resolution_notes = ?
        WHERE id = ?
    `).run(resolutionStatus ?? 'resolved_job', resolvedJobId ?? null, companyId ?? null, notes ?? null, leadId ?? null);

    return result.changes > 0;
}

export function countLeads() {
    const row = getDb().prepare('SELECT COUNT(*) as count FROM source_leads').get();
    return row?.count || 0;
}

/* ========== Job Verification & Evaluation Runs (Milestone 3B) ========== */

/**
 * Updates job liveness verification metadata and lifecycle status.
 * If status changes, records an immutable snapshot in job_snapshots.
 */
export function updateJobVerification(jobId, {
    status = null,
    lastVerifiedAt = new Date().toISOString(),
    verificationMethod = 'playwright_liveness',
    recordSnapshot = true
} = {}) {
    const db = getDb();
    if (!jobId) throw new Error('updateJobVerification requires jobId');

    return runInTransaction(() => {
        const existing = db.prepare('SELECT id, status, title, description, location, remote_type, employment_type FROM job_postings WHERE id = ?').get(jobId);
        if (!existing) return false;

        const statusChanged = status && status !== existing.status;
        const newStatus = status || existing.status;

        db.prepare(`
            UPDATE job_postings
            SET status = ?,
                last_verified_at = ?,
                verification_method = ?,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `).run(newStatus, lastVerifiedAt, verificationMethod, jobId);

        if (statusChanged && recordSnapshot) {
            const rawJson = JSON.stringify({
                status: newStatus,
                previousStatus: existing.status,
                verificationMethod,
                title: existing.title,
                location: existing.location,
                description: existing.description
            });
            const snapHash = createHash('sha256').update(rawJson).digest('hex');
            db.prepare(`
                INSERT INTO job_snapshots (job_id, raw_json, content_hash, fetched_at)
                VALUES (?, ?, ?, ?)
            `).run(jobId, rawJson, snapHash, lastVerifiedAt);
        }

        return true;
    });
}

/**
 * Selects candidate jobs for verification based on freshness policy:
 *  1. Newly discovered jobs without verification
 *  2. Stale active jobs (not verified within maxAgeDays)
 *  3. Explicit jobIds or companyId filters
 */
export function getJobsForVerification({
    limit = 50,
    maxAgeDays = 3,
    companyId = null,
    jobIds = null
} = {}) {
    const db = getDb();

    if (Array.isArray(jobIds) && jobIds.length > 0) {
        const placeholders = jobIds.map(() => '?').join(',');
        return db.prepare(`
            SELECT * FROM job_postings
            WHERE id IN (${placeholders})
            ORDER BY last_verified_at ASC NULLS FIRST
            LIMIT ?
        `).all(...jobIds, limit);
    }

    if (companyId) {
        return db.prepare(`
            SELECT * FROM job_postings
            WHERE company_id = ?
              AND (
                  status = 'discovered'
                  OR (status = 'active' AND (last_verified_at IS NULL OR last_verified_at < datetime('now', '-' || ? || ' days')))
              )
            ORDER BY last_verified_at ASC NULLS FIRST
            LIMIT ?
        `).all(companyId, maxAgeDays, limit);
    }

    return db.prepare(`
        SELECT * FROM job_postings
        WHERE status = 'discovered'
           OR (status = 'active' AND (last_verified_at IS NULL OR last_verified_at < datetime('now', '-' || ? || ' days')))
        ORDER BY last_verified_at ASC NULLS FIRST, discovered_at DESC
        LIMIT ?
    `).all(maxAgeDays, limit);
}

/**
 * Inserts an immutable evaluation run record into job_evaluation_runs.
 */
export function insertJobEvaluationRun(run) {
    const db = getDb();
    if (!run.job_id) throw new Error('insertJobEvaluationRun requires job_id');

    const id = run.id || `evalrun_${createHash('sha256').update(`${run.job_id}:${run.eval_version}:${Date.now()}:${Math.random()}`).digest('hex').slice(0, 16)}`;
    const runAt = run.run_at || new Date().toISOString();

    const stmt = db.prepare(`
        INSERT INTO job_evaluation_runs (
            id, job_id, run_at, eval_version, input_hash,
            tier1_passed, tier1_matched_titles,
            tier2_eligibility, tier2_gates_json,
            tier3_match_score, tier3_breakdown_json,
            matched_fact_ids, evidence_ids, missing_evidence_facts,
            recommendation, notes
        ) VALUES (
            ?, ?, ?, ?, ?,
            ?, ?,
            ?, ?,
            ?, ?,
            ?, ?, ?,
            ?, ?
        )
    `);

    stmt.run(
        id,
        run.job_id,
        runAt,
        run.eval_version || '3B.1.0',
        run.input_hash ?? null,
        run.tier1_passed ? 1 : 0,
        run.tier1_matched_titles ? (typeof run.tier1_matched_titles === 'string' ? run.tier1_matched_titles : JSON.stringify(run.tier1_matched_titles)) : null,
        run.tier2_eligibility || 'UNKNOWN',
        run.tier2_gates_json ? (typeof run.tier2_gates_json === 'string' ? run.tier2_gates_json : JSON.stringify(run.tier2_gates_json)) : '[]',
        typeof run.tier3_match_score === 'number' ? run.tier3_match_score : null,
        run.tier3_breakdown_json ? (typeof run.tier3_breakdown_json === 'string' ? run.tier3_breakdown_json : JSON.stringify(run.tier3_breakdown_json)) : null,
        run.matched_fact_ids ? (typeof run.matched_fact_ids === 'string' ? run.matched_fact_ids : JSON.stringify(run.matched_fact_ids)) : null,
        run.evidence_ids ? (typeof run.evidence_ids === 'string' ? run.evidence_ids : JSON.stringify(run.evidence_ids)) : null,
        run.missing_evidence_facts ? (typeof run.missing_evidence_facts === 'string' ? run.missing_evidence_facts : JSON.stringify(run.missing_evidence_facts)) : null,
        run.recommendation || 'UNKNOWN',
        run.notes ?? null
    );

    return id;
}

export function getEffectiveTier2Eligibility(run) {
    if (!run) return null;
    if (run.tier1_passed === 0 || run.tier1_passed === false) {
        return 'NOT_EVALUATED';
    }
    return run.tier2_eligibility || 'UNKNOWN';
}

export function getLatestEvaluationRun(jobId) {
    return getDb().prepare(`
        SELECT * FROM job_evaluation_runs
        WHERE job_id = ?
        ORDER BY run_at DESC, rowid DESC
        LIMIT 1
    `).get(jobId);
}

export function getEvaluationRunsForJob(jobId) {
    return getDb().prepare(`
        SELECT * FROM job_evaluation_runs
        WHERE job_id = ?
        ORDER BY run_at DESC, rowid DESC
    `).all(jobId);
}

export function countEvaluationRuns() {
    const row = getDb().prepare('SELECT COUNT(*) as count FROM job_evaluation_runs').get();
    return row?.count || 0;
}

/**
 * Inserts an immutable resume version record into resume_versions.
 */
export function insertResumeVersion(v) {
    const db = getDb();
    if (!v.file_path) throw new Error('insertResumeVersion requires file_path');

    const id = v.id || `rv_${createHash('sha256').update(`${v.job_id || 'master'}:${v.variant_label || 'general'}:${v.format || 'pdf'}:${Date.now()}:${Math.random()}`).digest('hex').slice(0, 16)}`;
    const createdAt = v.created_at || new Date().toISOString();

    const stmt = db.prepare(`
        INSERT INTO resume_versions (
            id, job_id, format, file_path, page_count,
            bullet_selection_json, created_at, html_path,
            tailored, tailoring_facts_json, variant_label,
            ats_parse_score, ats_parse_result_json
        ) VALUES (
            ?, ?, ?, ?, ?,
            ?, ?, ?,
            ?, ?, ?,
            ?, ?
        )
    `);

    stmt.run(
        id,
        v.job_id ?? null,
        v.format || 'pdf',
        v.file_path,
        typeof v.page_count === 'number' ? v.page_count : null,
        v.bullet_selection_json ? (typeof v.bullet_selection_json === 'string' ? v.bullet_selection_json : JSON.stringify(v.bullet_selection_json)) : null,
        createdAt,
        v.html_path ?? null,
        v.tailored ? 1 : 0,
        v.tailoring_facts_json ? (typeof v.tailoring_facts_json === 'string' ? v.tailoring_facts_json : JSON.stringify(v.tailoring_facts_json)) : null,
        v.variant_label || 'general',
        typeof v.ats_parse_score === 'number' ? v.ats_parse_score : null,
        v.ats_parse_result_json ? (typeof v.ats_parse_result_json === 'string' ? v.ats_parse_result_json : JSON.stringify(v.ats_parse_result_json)) : null
    );

    return id;
}

export function getResumeVersion(id) {
    return getDb().prepare('SELECT * FROM resume_versions WHERE id = ?').get(id);
}

export function getLatestResumeVersionForJob(jobId) {
    return getDb().prepare(`
        SELECT * FROM resume_versions
        WHERE job_id = ?
        ORDER BY created_at DESC, rowid DESC
        LIMIT 1
    `).get(jobId);
}

export function getResumeVersionsForJob(jobId) {
    return getDb().prepare(`
        SELECT * FROM resume_versions
        WHERE job_id = ?
        ORDER BY created_at DESC, rowid DESC
    `).all(jobId);
}

export function getResumeVersionsByVariant(variantLabel) {
    return getDb().prepare(`
        SELECT * FROM resume_versions
        WHERE variant_label = ?
        ORDER BY created_at DESC, rowid DESC
    `).all(variantLabel);
}

export function countResumeVersions() {
    const row = getDb().prepare('SELECT COUNT(*) as count FROM resume_versions').get();
    return row?.count || 0;
}

/* ========== Historical Tracker Ledger (Milestone 3E) ========== */

export function logHistoricalLedgerRecord(entry) {
    const db = getDb();
    const id = entry.id;
    if (!id) throw new Error('Ledger record requires id');

    const stmt = db.prepare(`
        INSERT INTO historical_tracker_ledger
        (id, source_file, row_identifier, original_company, original_role, original_status, original_score,
         original_date, original_url, original_report, original_notes, classification,
         resolved_company_id, resolved_job_id, resolved_application_id, resolution_status, resolution_notes, raw_content, imported_at)
        VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO UPDATE SET
            classification = excluded.classification,
            resolved_company_id = COALESCE(excluded.resolved_company_id, historical_tracker_ledger.resolved_company_id),
            resolved_job_id = COALESCE(excluded.resolved_job_id, historical_tracker_ledger.resolved_job_id),
            resolved_application_id = COALESCE(excluded.resolved_application_id, historical_tracker_ledger.resolved_application_id),
            resolution_status = excluded.resolution_status,
            resolution_notes = COALESCE(excluded.resolution_notes, historical_tracker_ledger.resolution_notes)
    `);

    stmt.run(
        id,
        entry.source_file || entry.sourceFile,
        entry.row_identifier || entry.sourceRowId || entry.rowIdentifier || null,
        entry.original_company || entry.rawCompany || entry.company || null,
        entry.original_role || entry.rawRole || entry.role || null,
        entry.original_status || entry.rawStatus || entry.status || null,
        entry.original_score || entry.rawScore || entry.score || null,
        entry.original_date || entry.rawTimestamp || entry.date || null,
        entry.original_url || entry.rawUrl || entry.url || null,
        entry.original_report || entry.rawReport || entry.report || null,
        entry.original_notes || entry.rawNotes || entry.notes || null,
        entry.classification,
        entry.resolved_company_id || entry.canonicalCompanyId || null,
        entry.resolved_job_id || entry.canonicalJobId || null,
        entry.resolved_application_id || entry.canonicalApplicationId || null,
        entry.resolution_status || entry.resolutionStatus,
        entry.resolution_notes || entry.reconciliationNotes || null,
        entry.raw_content || entry.rawPayload || null
    );

    return id;
}

export function getHistoricalLedger(filter = {}) {
    const db = getDb();
    let sql = 'SELECT * FROM historical_tracker_ledger';
    const params = [];
    const clauses = [];

    if (filter.source_file) {
        clauses.push('source_file = ?');
        params.push(filter.source_file);
    }
    if (filter.classification) {
        clauses.push('classification = ?');
        params.push(filter.classification);
    }
    if (filter.resolution_status) {
        clauses.push('resolution_status = ?');
        params.push(filter.resolution_status);
    }

    if (clauses.length > 0) {
        sql += ' WHERE ' + clauses.join(' AND ');
    }
    sql += ' ORDER BY row_identifier ASC, imported_at ASC';

    return db.prepare(sql).all(...params);
}

export function getHistoricalLedgerSummary() {
    const db = getDb();
    const classifications = db.prepare(`
        SELECT classification, COUNT(*) as count
        FROM historical_tracker_ledger
        GROUP BY classification
    `).all();

    const resolutions = db.prepare(`
        SELECT resolution_status, COUNT(*) as count
        FROM historical_tracker_ledger
        GROUP BY resolution_status
    `).all();

    const total = db.prepare('SELECT COUNT(*) as count FROM historical_tracker_ledger').get().count;

    return {
        total,
        classifications: Object.fromEntries(classifications.map(c => [c.classification, c.count])),
        resolutions: Object.fromEntries(resolutions.map(r => [r.resolution_status, r.count]))
    };
}

export function getApplicationWithDetails(applicationId) {
    const db = getDb();
    return db.prepare(`
        SELECT
            a.*,
            c.name as company_name,
            c.domain as company_domain,
            j.title as job_title,
            j.job_url,
            j.location as job_location,
            rv.variant_label as resume_variant,
            rv.file_path as resume_file_path
        FROM applications a
        LEFT JOIN companies c ON a.company_id = c.id
        LEFT JOIN job_postings j ON a.job_id = j.id
        LEFT JOIN resume_versions rv ON a.resume_version_id = rv.id
        WHERE a.id = ?
    `).get(applicationId);
}
