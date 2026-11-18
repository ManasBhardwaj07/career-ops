#!/usr/bin/env node

/**
 * scripts/manage-companies.mjs — Employer Registry Management & Seed Importer
 *
 * Usage:
 *   node scripts/manage-companies.mjs import [path/to/companies.json]
 *   node scripts/manage-companies.mjs list [--unverified] [--missing-career] [--missing-ats] [--json] [--limit <n>]
 *   node scripts/manage-companies.mjs verify <id|domain> [--approve|--reject|--monitor|--verify] [--reason <text>]
 *   node scripts/manage-companies.mjs coverage [--json]
 *   node scripts/manage-companies.mjs add <name> <domain> [--career <url>] [--ats <type>] [--board <id>] [--country <code>]
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { getDb, closeDb, runInTransaction } from '../db/db.mjs';
import {
    upsertCompany,
    createCompany,
    getCompany,
    getCompanyByDomain,
    findCompanyByNameOrAlias,
    getAllCompanies,
    addCompanyAlias,
    getCompanyAliases,
    setCompanyLifecycleStatus,
    setMonitoringStatus,
    listUnverifiedCompanies,
    listCompaniesMissingCareerUrl,
    listCompaniesMissingAts,
    getRegistryCoverageReport,
    normalizeDomain,
    upsertSourcePolicy
} from '../db/repo.mjs';

/**
 * Import companies and aliases from a JSON file.
 * Idempotent: safe to run repeatedly.
 */
export function importCompanies(filePath = 'data/seed_companies.json') {
    const absPath = resolve(process.cwd(), filePath);
    if (!existsSync(absPath)) {
        throw new Error(`Companies seed file not found: ${absPath}`);
    }

    const rawData = readFileSync(absPath, 'utf8');
    const companies = JSON.parse(rawData);

    if (!Array.isArray(companies)) {
        throw new Error(`Invalid format in ${filePath}: root must be an array of company objects`);
    }

    const reportBefore = getRegistryCoverageReport();
    const existingBefore = getAllCompanies();
    const existingIds = new Set(existingBefore.map(c => c.id));

    let createdCount = 0;
    let updatedCount = 0;
    let aliasesCount = 0;
    let policiesCount = 0;

    runInTransaction(() => {
        // Pass 1: Upsert companies (defer parent_company_id to avoid FK issues with out-of-order data)
        for (const item of companies) {
            const isNew = !existingIds.has(item.id);
            if (isNew) {
                createdCount++;
            } else {
                updatedCount++;
            }

            const cleanDomain = item.domain ? normalizeDomain(item.domain) : null;

            upsertCompany({
                id: item.id,
                name: item.name,
                domain: cleanDomain,
                website_url: item.website_url || null,
                career_url: item.career_url || null,
                ats_type: item.ats_type || null,
                board_identifier: item.board_identifier || null,
                country: item.country || null,
                industry: item.industry || null,
                size_band: item.size_band || null,
                source_provenance: item.source_provenance || 'seed_dataset',
                lifecycle_status: item.lifecycle_status || 'VERIFIED',
                monitoring_status: item.monitoring_status || 'paused',
                notes: item.notes || null,
                parent_company_id: null // set in pass 2
            });

            // Register aliases
            if (Array.isArray(item.aliases)) {
                for (const alias of item.aliases) {
                    if (alias && typeof alias === 'string') {
                        addCompanyAlias(item.id, alias.trim(), 'seed_dataset');
                        aliasesCount++;
                    }
                }
            }

            // Register default source policy if ATS is specified
            if (item.ats_type && item.board_identifier) {
                upsertSourcePolicy({
                    id: `policy-${item.id}-${item.ats_type}`,
                    company_id: item.id,
                    source_type: item.ats_type,
                    endpoint: item.career_url || `https://${item.ats_type}.com/${item.board_identifier}`,
                    enabled: item.monitoring_status === 'active' || item.lifecycle_status === 'APPROVED',
                    discovery_permitted: true,
                    public_nav_permitted: true,
                    feed_access_permitted: true,
                    authenticated_permitted: false,
                    autofill_permitted: false,
                    submission_permitted: false,
                    notes: `Default source policy registered for ${item.name} (${item.ats_type})`
                });
                policiesCount++;
            }
        }

        // Pass 2: Set parent_company_id relationships
        for (const item of companies) {
            if (item.parent_company_id) {
                const db = getDb();
                db.prepare(`
                    UPDATE companies
                    SET parent_company_id = ?, updated_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                `).run(item.parent_company_id, item.id);
            }
        }
    });

    const reportAfter = getRegistryCoverageReport();

    return {
        filePath: absPath,
        totalInFile: companies.length,
        created: createdCount,
        updated: updatedCount,
        aliasesRegistered: aliasesCount,
        policiesRegistered: policiesCount,
        coverageBefore: reportBefore,
        coverageAfter: reportAfter
    };
}

/**
 * List companies with optional filtering.
 */
export function listCompanies(options = {}) {
    let list;
    if (options.unverified) {
        list = listUnverifiedCompanies();
    } else if (options.missingCareer) {
        list = listCompaniesMissingCareerUrl();
    } else if (options.missingAts) {
        list = listCompaniesMissingAts();
    } else {
        list = getAllCompanies();
    }

    if (options.limit && options.limit > 0) {
        list = list.slice(0, options.limit);
    }

    return list;
}

/**
 * Verify or transition company lifecycle status.
 */
export function verifyCompany(target, options = {}) {
    if (!target) {
        throw new Error('Target company ID, name or domain is required');
    }

    let company = getCompany(target) || getCompanyByDomain(target) || findCompanyByNameOrAlias(target);
    if (!company) {
        throw new Error(`Company not found matching target: "${target}"`);
    }

    let targetStatus = 'VERIFIED';
    if (options.approve) targetStatus = 'APPROVED';
    if (options.reject) targetStatus = 'REJECTED';
    if (options.monitor) targetStatus = 'MONITORING';
    if (options.disable) targetStatus = 'DISABLED';
    if (options.unverified) targetStatus = 'UNVERIFIED';

    setCompanyLifecycleStatus(company.id, targetStatus, options.reason || 'CLI lifecycle update');

    if (options.monitor) {
        setMonitoringStatus(company.id, 'active');
    } else if (options.pause) {
        setMonitoringStatus(company.id, 'paused');
    }

    const updated = getCompany(company.id);
    const aliases = getCompanyAliases(company.id);

    return {
        company: updated,
        aliases: aliases.map(a => a.alias)
    };
}

/**
 * Return registry coverage metrics.
 */
export function showCoverage() {
    return getRegistryCoverageReport();
}

/**
 * Add a new single company.
 */
export function addCompany(data) {
    if (!data.name) throw new Error('Company name is required');
    if (!data.domain) throw new Error('Company domain is required');

    const cleanDomain = normalizeDomain(data.domain);
    const slug = data.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const id = data.id || `company-${slug}`;

    const createdId = createCompany({
        id,
        name: data.name,
        domain: cleanDomain,
        website_url: data.website_url || `https://${cleanDomain}`,
        career_url: data.career_url || null,
        ats_type: data.ats_type || null,
        board_identifier: data.board_identifier || null,
        country: data.country || null,
        industry: data.industry || null,
        size_band: data.size_band || null,
        source_provenance: 'manual_cli',
        lifecycle_status: data.lifecycle_status || 'VERIFIED',
        monitoring_status: data.monitoring_status || 'paused',
        notes: data.notes || null,
        parent_company_id: data.parent_company_id || null
    });

    if (data.aliases && Array.isArray(data.aliases)) {
        for (const alias of data.aliases) {
            addCompanyAlias(createdId, alias, 'manual_cli');
        }
    }

    return getCompany(createdId);
}

// ── CLI Dispatcher ─────────────────────────────────────────────────────────

function printHelp() {
    console.log(`
Employer Registry Management CLI
Usage:
  node scripts/manage-companies.mjs <command> [options]

Commands:
  import [path]          Import/seed companies from JSON dataset
  list [options]         List registered companies
                         Flags: --unverified, --missing-career, --missing-ats, --json, --limit <n>
  verify <id|domain>     Update company lifecycle status
                         Flags: --approve, --reject, --monitor, --disable, --reason <text>
  coverage               Display employer registry coverage report
                         Flags: --json
  add <name> <domain>    Add a new company manually
                         Flags: --career <url>, --ats <type>, --board <id>, --country <code>, --industry <name>
`);
}

async function main() {
    const args = process.argv.slice(2);
    const cmd = args[0];

    if (!cmd || cmd === '--help' || cmd === '-h') {
        printHelp();
        return;
    }

    try {
        switch (cmd) {
            case 'import': {
                const file = args[1] || 'data/seed_companies.json';
                console.log(`Importing employer dataset from ${file}...`);
                const res = importCompanies(file);
                console.log('\n--- Employer Registry Import Summary ---');
                console.log(`Records in File:       ${res.totalInFile}`);
                console.log(`New Companies:         ${res.created}`);
                console.log(`Updated Companies:     ${res.updated}`);
                console.log(`Aliases Registered:    ${res.aliasesRegistered}`);
                console.log(`Policies Registered:   ${res.policiesRegistered}`);
                console.log(`Total DB Companies:    ${res.coverageBefore.total_companies} -> ${res.coverageAfter.total_companies}`);
                console.log(`Verified / Approved:   ${res.coverageAfter.verified_companies} / ${res.coverageAfter.approved_companies}`);
                console.log(`With Career URLs:      ${res.coverageAfter.with_career_url_count} / ${res.coverageAfter.total_companies}`);
                console.log(`With ATS Boards:       ${res.coverageAfter.with_ats_count} / ${res.coverageAfter.total_companies}`);
                break;
            }

            case 'list': {
                const unverified = args.includes('--unverified');
                const missingCareer = args.includes('--missing-career');
                const missingAts = args.includes('--missing-ats');
                const isJson = args.includes('--json');
                const limitIdx = args.indexOf('--limit');
                const limit = limitIdx !== -1 && args[limitIdx + 1] ? parseInt(args[limitIdx + 1], 10) : 0;

                const results = listCompanies({ unverified, missingCareer, missingAts, limit });

                if (isJson) {
                    console.log(JSON.stringify(results, null, 2));
                } else {
                    console.log(`\nFound ${results.length} companies:\n`);
                    console.log('ID'.padEnd(30) + 'NAME'.padEnd(25) + 'DOMAIN'.padEnd(22) + 'LIFECYCLE'.padEnd(14) + 'ATS');
                    console.log('-'.repeat(100));
                    for (const c of results) {
                        const ats = c.ats_type ? `${c.ats_type}:${c.board_identifier || '-'}` : '-';
                        console.log(
                            (c.id || '-').padEnd(30) +
                            (c.name || '-').slice(0, 24).padEnd(25) +
                            (c.domain || '-').slice(0, 21).padEnd(22) +
                            (c.lifecycle_status || '-').padEnd(14) +
                            ats
                        );
                    }
                }
                break;
            }

            case 'verify': {
                const target = args[1];
                if (!target) {
                    console.error('Error: specify company ID or domain to verify.');
                    process.exit(1);
                }
                const approve = args.includes('--approve');
                const reject = args.includes('--reject');
                const monitor = args.includes('--monitor');
                const disable = args.includes('--disable');
                const reasonIdx = args.indexOf('--reason');
                const reason = reasonIdx !== -1 && args[reasonIdx + 1] ? args[reasonIdx + 1] : '';

                const res = verifyCompany(target, { approve, reject, monitor, disable, reason });
                console.log(`\nUpdated Company [${res.company.id}]:`);
                console.log(`  Name:             ${res.company.name}`);
                console.log(`  Domain:           ${res.company.domain || '(none)'}`);
                console.log(`  Lifecycle Status: ${res.company.lifecycle_status}`);
                console.log(`  Monitoring:       ${res.company.monitoring_status}`);
                console.log(`  Last Verified:    ${res.company.last_verified_at || '(none)'}`);
                console.log(`  Aliases:          ${res.aliases.join(', ') || '(none)'}`);
                break;
            }

            case 'coverage': {
                const isJson = args.includes('--json');
                const rep = showCoverage();
                if (isJson) {
                    console.log(JSON.stringify(rep, null, 2));
                } else {
                    console.log('\n======================================================');
                    console.log('         EMPLOYER REGISTRY COVERAGE REPORT           ');
                    console.log('======================================================');
                    console.log(`Total Companies:              ${rep.total_companies}`);
                    console.log('--- Lifecycle Breakdown ---');
                    console.log(`  Approved:                   ${rep.approved_companies}`);
                    console.log(`  Verified:                   ${rep.verified_companies}`);
                    console.log(`  Monitoring:                 ${rep.monitoring_companies}`);
                    console.log(`  Discovered:                 ${rep.discovered_companies}`);
                    console.log(`  Unverified:                 ${rep.unverified_companies}`);
                    console.log(`  Disabled:                   ${rep.disabled_companies}`);
                    console.log(`  Rejected:                   ${rep.rejected_companies}`);
                    console.log('--- Coverage Metrics ---');
                    console.log(`  With Official Website:      ${rep.with_website_count} (${((rep.with_website_count / rep.total_companies) * 100).toFixed(1)}%)`);
                    console.log(`  With Career Page URL:       ${rep.with_career_url_count} (${((rep.with_career_url_count / rep.total_companies) * 100).toFixed(1)}%)`);
                    console.log(`  With Configured ATS Board:  ${rep.with_ats_count} (${((rep.with_ats_count / rep.total_companies) * 100).toFixed(1)}%)`);
                    console.log(`  With Discovery Scan Runs:   ${rep.recent_scanned_count}`);
                    console.log('--- Actionable Gaps ---');
                    console.log(`  Missing Official Domain:    ${rep.missing_domain_count}`);
                    console.log(`  Missing Career Page URL:    ${rep.missing_career_url_count}`);
                    console.log(`  Missing ATS Board:          ${rep.missing_ats_count}`);
                    console.log(`  Company Identity Conflicts: ${rep.company_identity_conflicts_count ?? 0}`);
                    console.log(`  Job-Level Dup Suggestions:  ${rep.unresolved_job_duplicates_count ?? 0}`);
                    console.log('======================================================\n');
                }
                break;
            }

            case 'add': {
                const name = args[1];
                const domain = args[2];
                if (!name || !domain) {
                    console.error('Error: "add" requires <name> and <domain>');
                    process.exit(1);
                }
                const careerIdx = args.indexOf('--career');
                const atsIdx = args.indexOf('--ats');
                const boardIdx = args.indexOf('--board');
                const countryIdx = args.indexOf('--country');
                const industryIdx = args.indexOf('--industry');

                const newComp = addCompany({
                    name,
                    domain,
                    career_url: careerIdx !== -1 ? args[careerIdx + 1] : null,
                    ats_type: atsIdx !== -1 ? args[atsIdx + 1] : null,
                    board_identifier: boardIdx !== -1 ? args[boardIdx + 1] : null,
                    country: countryIdx !== -1 ? args[countryIdx + 1] : null,
                    industry: industryIdx !== -1 ? args[industryIdx + 1] : null
                });
                console.log(`Successfully added company ${newComp.id} (${newComp.name})`);
                break;
            }

            default:
                console.error(`Unknown command: ${cmd}`);
                printHelp();
                process.exit(1);
        }
    } finally {
        closeDb();
    }
}

if (process.argv[1]?.endsWith('manage-companies.mjs')) {
    main().catch(err => {
        console.error('Fatal CLI Error:', err.message);
        process.exit(1);
    });
}
