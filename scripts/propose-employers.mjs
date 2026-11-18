#!/usr/bin/env node

/**
 * scripts/propose-employers.mjs — Employer Registry Growth Helper
 *
 * Implements Deliverable 5 Phase 4 (D5):
 *   - Discovers high-frequency tech employers from recent postings
 *   - Identifies candidate companies not yet tracked in portals.yml
 *   - Infers ATS provider (Greenhouse, Lever, Ashby, Workable, etc.) from job URLs
 *   - Emits structured YAML proposals ready for review into portals.yml
 */

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import yaml from 'js-yaml';
import { getDb, closeDb } from '../db/repo.mjs';

const PORTALS_PATH = resolve('portals.yml');

/**
 * Extracts ATS provider and board name from a job URL.
 */
export function inferAtsFromUrl(url) {
    if (!url) return null;
    const lower = url.toLowerCase();

    if (lower.includes('greenhouse.io') || lower.includes('boards.greenhouse.io')) {
        const match = url.match(/greenhouse\.io\/(?:embed\/job_board\?for=)?([^/?#]+)/i);
        return { ats: 'greenhouse', board: match ? match[1] : null };
    }
    if (lower.includes('lever.co') || lower.includes('jobs.lever.co')) {
        const match = url.match(/lever\.co\/([^/?#]+)/i);
        return { ats: 'lever', board: match ? match[1] : null };
    }
    if (lower.includes('ashbyhq.com') || lower.includes('jobs.ashbyhq.com')) {
        const match = url.match(/ashbyhq\.com\/([^/?#]+)/i);
        return { ats: 'ashby', board: match ? match[1] : null };
    }
    if (lower.includes('workable.com') || lower.includes('apply.workable.com')) {
        const match = url.match(/workable\.com\/([^/?#]+)/i);
        return { ats: 'workable', board: match ? match[1] : null };
    }
    if (lower.includes('smartrecruiters.com')) {
        const match = url.match(/smartrecruiters\.com\/([^/?#]+)/i);
        return { ats: 'smartrecruiters', board: match ? match[1] : null };
    }

    return null;
}

/**
 * Finds untracked employers from job postings.
 */
export function proposeEmployers({ db = null, minPostings = 1 } = {}) {
    // 1. Load tracked companies from portals.yml
    let trackedNames = new Set();
    if (existsSync(PORTALS_PATH)) {
        try {
            const config = yaml.load(readFileSync(PORTALS_PATH, 'utf8'));
            if (config && Array.isArray(config.tracked_companies)) {
                for (const c of config.tracked_companies) {
                    if (c.name) trackedNames.add(c.name.toLowerCase().trim());
                    if (Array.isArray(c.aliases)) {
                        for (const a of c.aliases) trackedNames.add(a.toLowerCase().trim());
                    }
                }
            }
        } catch {}
    }

    // 2. Query jobs for candidate companies
    const database = db || getDb();
    let jobs = [];
    try {
        jobs = database.prepare(`
            SELECT company_name, job_url, title
            FROM job_postings
            WHERE company_name IS NOT NULL AND company_name != '' AND company_name != 'Confidential'
        `).all();
    } catch {
        // Fallback for isolated tests without initialized job_postings table
        jobs = [];
    }

    // 3. Aggregate company counts and URL samples
    const companyStats = new Map();
    for (const j of jobs) {
        const name = j.company_name.trim();
        const norm = name.toLowerCase();

        if (trackedNames.has(norm)) continue; // Already tracked

        if (!companyStats.has(name)) {
            companyStats.set(name, {
                name,
                count: 0,
                urls: [],
                titles: []
            });
        }

        const stat = companyStats.get(name);
        stat.count += 1;
        if (stat.urls.length < 3) stat.urls.push(j.job_url);
        if (stat.titles.length < 3) stat.titles.push(j.title);
    }

    // 4. Build proposals
    const proposals = [];
    for (const [name, stat] of companyStats.entries()) {
        if (stat.count < minPostings) continue;

        let inferred = null;
        for (const u of stat.urls) {
            inferred = inferAtsFromUrl(u);
            if (inferred) break;
        }

        proposals.push({
            name,
            postings_count: stat.count,
            sample_titles: stat.titles,
            ats_provider: inferred?.ats || 'direct_crawler',
            board_identifier: inferred?.board || null,
            sample_url: stat.urls[0] || null,
            yaml_snippet: `  - name: "${name}"\n    enabled: true\n    careers_url: "${stat.urls[0] || ''}"${inferred ? `\n    ats: "${inferred.ats}"` : ''}`
        });
    }

    // Sort by postings count descending
    proposals.sort((a, b) => b.postings_count - a.postings_count);

    return proposals;
}

// CLI execution
if (process.argv[1] && process.argv[1].endsWith('propose-employers.mjs')) {
    const proposals = proposeEmployers();
    console.log(`Found ${proposals.length} proposed employers to add to portals.yml:\n`);
    for (const p of proposals.slice(0, 10)) {
        console.log(p.yaml_snippet);
        console.log('');
    }
}
