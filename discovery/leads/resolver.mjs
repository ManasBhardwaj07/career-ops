/**
 * discovery/leads/resolver.mjs — Lead Resolution & Company Linkage Service
 *
 * Resolves raw search leads from source_leads into canonical employer and job records:
 *   1. Matches domain or company name against Employer Registry
 *   2. Identifies existing job postings or creates normalized records
 *   3. Links source_leads.resolved_job_id while preserving provenance
 *
 * Note: Resolving a lead to a job posting is DISTINCT from job liveness verification.
 * Newly resolved jobs enter job_postings with status = 'discovered'.
 */

import crypto from 'node:crypto';
import {
    getLeadById,
    listPendingLeads,
    resolveLead,
    getJobByUrl,
    getCompanyByDomain,
    findCompanyByNameOrAlias,
    normalizeDomain,
    upsertJobPosting,
    createCompany
} from '../../db/repo.mjs';
import { createNormalizedJob } from '../adapters/base.mjs';

/**
 * Attempts to resolve a single search lead to an employer and job posting.
 *
 * @param {object} lead source_leads database row
 * @param {object} options
 * @param {boolean} options.createMissingCompany Whether to create an UNVERIFIED company stub if unknown
 * @param {Function} options.fetchFn Custom fetch function for page inspection
 * @returns {Promise<{ resolved: boolean, resolutionStatus: string, resolvedJobId: string|null, companyId: string|null }>}
 */
export async function resolveSingleLead(lead, {
    createMissingCompany = false
} = {}) {
    if (!lead || !lead.canonical_url) {
        return { resolved: false, resolutionStatus: 'invalid', resolvedJobId: null, companyId: null };
    }

    let companyId = lead.company_id || null;
    let urlObj;
    try {
        urlObj = new URL(lead.canonical_url);
    } catch {
        resolveLead(lead.id, {
            resolutionStatus: 'unresolvable',
            notes: 'Malformed canonical URL'
        });
        return { resolved: false, resolutionStatus: 'unresolvable', resolvedJobId: null, companyId: null };
    }

    // 1. Resolve Company Identity
    if (!companyId) {
        const domain = normalizeDomain(urlObj.hostname);
        let comp = getCompanyByDomain(domain);

        if (!comp && lead.normalized_company_name) {
            comp = findCompanyByNameOrAlias(lead.normalized_company_name);
        }

        if (comp) {
            companyId = comp.id;
        } else if (createMissingCompany && lead.normalized_company_name) {
            // Create UNVERIFIED stub
            const stubId = `comp_stub_${crypto.randomBytes(6).toString('hex')}`;
            try {
                companyId = createCompany({
                    id: stubId,
                    name: lead.normalized_company_name,
                    domain,
                    website_url: domain ? `https://${domain}` : null,
                    source_provenance: 'search_lead_resolver',
                    lifecycle_status: 'UNVERIFIED',
                    monitoring_status: 'paused'
                });
            } catch {
                // Concurrent/duplicate conflict: re-resolve existing canonical record
                const existing = (domain ? getCompanyByDomain(domain) : null)
                    || findCompanyByNameOrAlias(lead.normalized_company_name);
                if (existing) {
                    companyId = existing.id;
                }
            }
        }
    }

    // 2. Check if Job Posting Already Exists
    const existingJob = getJobByUrl(lead.canonical_url);
    if (existingJob) {
        resolveLead(lead.id, {
            resolutionStatus: 'resolved_job',
            resolvedJobId: existingJob.id,
            companyId: existingJob.company_id || companyId,
            notes: 'Matched to existing canonical job posting URL'
        });
        return {
            resolved: true,
            resolutionStatus: 'resolved_job',
            resolvedJobId: existingJob.id,
            companyId: existingJob.company_id || companyId
        };
    }

    // 3. If Company is known and lead has valid title, register new job posting
    if (companyId && lead.normalized_title) {
        const newJob = createNormalizedJob({
            id: lead.canonical_url,
            company_id: companyId,
            company_name: lead.normalized_company_name || null,
            title: lead.normalized_title,
            job_url: lead.canonical_url,
            source: 'search_lead',
            discovered_at: lead.first_discovered_at
        });

        // Insert as 'discovered' (distinct from verified active)
        const insertRes = upsertJobPosting(newJob);
        const resolvedJobId = insertRes.job ? insertRes.job.id : lead.canonical_url;

        resolveLead(lead.id, {
            resolutionStatus: 'resolved_job',
            resolvedJobId,
            companyId,
            notes: 'Promoted search lead to discovered job posting'
        });

        return {
            resolved: true,
            resolutionStatus: 'resolved_job',
            resolvedJobId,
            companyId
        };
    }

    // Unresolved: still pending company or job details
    return {
        resolved: false,
        resolutionStatus: 'pending',
        resolvedJobId: null,
        companyId
    };
}

/**
 * Batch resolve pending search leads
 */
export async function resolvePendingLeads({
    limit = 50,
    createMissingCompany = false
} = {}) {
    const leads = listPendingLeads({ limit });
    const results = {
        total: leads.length,
        resolved: 0,
        unresolvable: 0,
        pending: 0,
        details: []
    };

    for (const lead of leads) {
        const res = await resolveSingleLead(lead, { createMissingCompany });
        results.details.push({ leadId: lead.id, ...res });
        if (res.resolved) {
            results.resolved++;
        } else if (res.resolutionStatus === 'unresolvable') {
            results.unresolvable++;
        } else {
            results.pending++;
        }
    }

    return results;
}
