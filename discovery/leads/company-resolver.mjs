/**
 * discovery/leads/company-resolver.mjs — Shared Employer Identity & Registry Resolver
 *
 * Canonical resolution priority for discovered employers across feeds, Hacker News,
 * Y Combinator, and search leads:
 *   1. Normalized official domain (excluding ATS, social, and aggregator hosts)
 *   2. Exact company name (case-insensitive, with safe suffix normalization)
 *   3. Verified aliases in `company_aliases`
 *   4. Parent / acquisition lineage (`parent_company_id`)
 *   5. ATS board identity (`ats_type` + `board_identifier`)
 *
 * Ambiguous matches are never guessed silently; callers receive `ambiguous: true`
 * so corresponding `source_leads` records remain `pending` for human review.
 */

import { createHash } from 'node:crypto';
import {
    getDb,
    normalizeDomain,
    createCompany,
    getCompany,
    registerCareerPage,
    registerAtsBoard,
    upsertSourcePolicy,
    addCompanyAlias
} from '../../db/repo.mjs';

export const VALID_POLICY_SOURCE_TYPES = new Set([
    'greenhouse',
    'lever',
    'ashby',
    'workday',
    'smartrecruiters',
    'workable',
    'recruitee',
    'search',
    'sitemap',
    'crawler',
    'custom'
]);

const THIRD_PARTY_HOST_SUFFIXES = [
    'greenhouse.io',
    'lever.co',
    'ashbyhq.com',
    'myworkdayjobs.com',
    'myworkdaysite.com',
    'smartrecruiters.com',
    'workable.com',
    'recruitee.com',
    'breezy.hr',
    'bamboohr.com',
    'icims.com',
    'taleo.net',
    'jobvite.com',
    'rippling.com',
    'pinpointhq.com',
    'dover.com',
    'wellfound.com',
    'angel.co',
    'ycombinator.com',
    'workatastartup.com',
    'news.ycombinator.com',
    'linkedin.com',
    'github.com',
    'gitlab.com',
    'twitter.com',
    'x.com',
    'notion.site',
    'notion.so',
    'docs.google.com',
    'forms.gle',
    'typeform.com',
    'airtable.com',
    'medium.com',
    'substack.com',
    'youtube.com',
    'youtu.be',
    'vimeo.com',
    'remoteok.com',
    'himalayas.app',
    'remotive.com',
    'jobicy.com',
    'weworkremotely.com'
];

const GENERIC_PLACEHOLDER_NAMES = new Set([
    'stealth',
    'stealth startup',
    'confidential',
    'unknown',
    'n/a',
    'na',
    'tbd',
    'hiring',
    'various',
    'anonymous',
    'company'
]);

const LEGAL_SUFFIX_RE = /(?:,?\s+(?:inc\.?|incorporated|corp\.?|corporation|llc|l\.l\.c\.?|ltd\.?|limited|pvt\.?\s*ltd\.?|pte\.?\s*ltd\.?|gmbh|s\.a\.s\.?|sas|b\.v\.?|bv|co\.?|plc))+$/i;

/**
 * Check if a domain or URL belongs to an ATS host, aggregator, HN, YC, or social/doc site
 * rather than an employer's own official domain.
 */
export function isThirdPartyPlatformDomain(domainOrUrl) {
    const clean = normalizeDomain(domainOrUrl);
    if (!clean || !clean.includes('.')) return true;
    return THIRD_PARTY_HOST_SUFFIXES.some(
        suffix => clean === suffix || clean.endsWith(`.${suffix}`)
    );
}

/**
 * Extract an official employer domain if the URL/domain is valid and not a third-party platform.
 */
export function extractOfficialDomain(domainOrUrl) {
    if (!domainOrUrl || typeof domainOrUrl !== 'string') return null;
    const clean = normalizeDomain(domainOrUrl);
    if (!clean || !clean.includes('.')) return null;
    if (isThirdPartyPlatformDomain(clean)) return null;
    return clean;
}

/**
 * Normalize whitespace and strip YC/HN parenthetical markers for display/matching.
 */
export function normalizeCompanyName(rawName) {
    if (!rawName || typeof rawName !== 'string') return '';
    return rawName
        .replace(/\((?:YC\s+[WSFX]\d{2}|S\d{2}|W\d{2}|acquired\s+by\s+[^)]+|formerly\s+[^)]+)\)/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Strip common corporate legal entity suffixes for normalized matching.
 */
export function stripLegalSuffix(name) {
    const base = normalizeCompanyName(name);
    if (!base) return '';
    const stripped = base.replace(LEGAL_SUFFIX_RE, '').replace(/[,\s]+$/g, '').trim();
    return stripped || base;
}

/**
 * Check whether a name is usable as an employer name (not stealth/placeholder/too short).
 */
export function isValidEmployerName(name) {
    const clean = normalizeCompanyName(name);
    if (!clean || clean.length < 2) return false;
    if (GENERIC_PLACEHOLDER_NAMES.has(clean.toLowerCase())) return false;
    return true;
}

/**
 * Look up companies matching an exact ATS board identity.
 */
export function getCompaniesByAtsBoard(atsType, boardIdentifier) {
    if (!atsType || !boardIdentifier) return [];
    const db = getDb();
    return db.prepare(`
        SELECT * FROM companies
        WHERE LOWER(TRIM(ats_type)) = LOWER(TRIM(?))
          AND LOWER(TRIM(board_identifier)) = LOWER(TRIM(?))
    `).all(atsType, boardIdentifier);
}

function attachParentCompany(company) {
    if (!company || !company.parent_company_id) return null;
    return getCompany(company.parent_company_id) || null;
}

function hasDomainConflict(existingCompany, incomingOfficialDomain) {
    if (!existingCompany || !existingCompany.domain || !incomingOfficialDomain) return false;
    const existingDom = normalizeDomain(existingCompany.domain);
    const incomingDom = normalizeDomain(incomingOfficialDomain);
    if (!existingDom || !incomingDom) return false;
    if (existingDom === incomingDom) return false;
    // Allow subdomain relationships (e.g. jobs.acme.com vs acme.com)
    if (existingDom.endsWith(`.${incomingDom}`) || incomingDom.endsWith(`.${existingDom}`)) {
        return false;
    }
    return true;
}

/**
 * Resolve an employer record against the canonical `companies` + `company_aliases` tables.
 *
 * Resolution priority:
 *   1. Normalized official domain
 *   2. Exact company name (case-insensitive) + safe legal-suffix match
 *   3. Verified aliases (`company_aliases`)
 *   4. Parent / acquisition lineage (`parent_company_id`)
 *   5. ATS board identity (`ats_type` + `board_identifier`)
 */
export function resolveCompanyIdentity({
    name = null,
    aliases = [],
    domain = null,
    websiteUrl = null,
    atsType = null,
    boardIdentifier = null,
    parentCompanyName = null,
    createIfMissing = false,
    sourceProvenance = 'discovery',
    lifecycleStatus = 'UNVERIFIED',
    monitoringStatus = 'paused',
    notes = null
} = {}) {
    const db = getDb();
    const officialDomain = extractOfficialDomain(domain) || extractOfficialDomain(websiteUrl);
    const cleanName = normalizeCompanyName(name);
    const strippedName = stripLegalSuffix(cleanName);

    // 1. Normalized official domain
    if (officialDomain) {
        const domainMatches = db.prepare(
            'SELECT * FROM companies WHERE domain = ?'
        ).all(officialDomain);
        if (domainMatches.length === 1) {
            const company = domainMatches[0];
            return {
                resolved: true,
                created: false,
                ambiguous: false,
                matchType: 'domain',
                company,
                companyId: company.id,
                parentCompany: attachParentCompany(company)
            };
        }
        if (domainMatches.length > 1) {
            return {
                resolved: false,
                created: false,
                ambiguous: true,
                matchType: 'ambiguous_domain',
                reason: `Multiple companies share domain ${officialDomain}`,
                candidates: domainMatches,
                company: null,
                companyId: null,
                parentCompany: null
            };
        }
    }

    // 2. Exact company name (case-insensitive)
    if (cleanName) {
        const exactMatches = db.prepare(
            'SELECT * FROM companies WHERE LOWER(TRIM(name)) = LOWER(TRIM(?))'
        ).all(cleanName);

        if (exactMatches.length > 1) {
            return {
                resolved: false,
                created: false,
                ambiguous: true,
                matchType: 'ambiguous_name',
                reason: `Multiple companies match exact name "${cleanName}"`,
                candidates: exactMatches,
                company: null,
                companyId: null,
                parentCompany: null
            };
        }

        if (exactMatches.length === 1) {
            const company = exactMatches[0];
            if (hasDomainConflict(company, officialDomain)) {
                return {
                    resolved: false,
                    created: false,
                    ambiguous: true,
                    matchType: 'domain_conflict',
                    reason: `Exact name "${cleanName}" matches ${company.id} (${company.domain}), which conflicts with domain ${officialDomain}`,
                    candidates: [company],
                    company: null,
                    companyId: null,
                    parentCompany: null
                };
            }
            return {
                resolved: true,
                created: false,
                ambiguous: false,
                matchType: 'exact_name',
                company,
                companyId: company.id,
                parentCompany: attachParentCompany(company)
            };
        }
    }

    // 3. Verified aliases (`company_aliases`)
    const candidateNames = Array.from(new Set(
        [cleanName, strippedName, ...(Array.isArray(aliases) ? aliases : [])]
            .map(v => (typeof v === 'string' ? v.trim().toLowerCase() : ''))
            .filter(Boolean)
    ));

    if (candidateNames.length > 0) {
        const placeholders = candidateNames.map(() => '?').join(', ');
        const aliasMatches = db.prepare(`
            SELECT DISTINCT c.*
            FROM companies c
            JOIN company_aliases a ON c.id = a.company_id
            WHERE LOWER(TRIM(a.alias)) IN (${placeholders})
        `).all(...candidateNames);

        if (aliasMatches.length > 1) {
            return {
                resolved: false,
                created: false,
                ambiguous: true,
                matchType: 'ambiguous_alias',
                reason: `Multiple companies match alias for "${cleanName || candidateNames[0]}"`,
                candidates: aliasMatches,
                company: null,
                companyId: null,
                parentCompany: null
            };
        }

        if (aliasMatches.length === 1) {
            const company = aliasMatches[0];
            if (hasDomainConflict(company, officialDomain)) {
                return {
                    resolved: false,
                    created: false,
                    ambiguous: true,
                    matchType: 'domain_conflict',
                    reason: `Alias match ${company.id} (${company.domain}) conflicts with domain ${officialDomain}`,
                    candidates: [company],
                    company: null,
                    companyId: null,
                    parentCompany: null
                };
            }
            return {
                resolved: true,
                created: false,
                ambiguous: false,
                matchType: 'alias',
                company,
                companyId: company.id,
                parentCompany: attachParentCompany(company)
            };
        }
    }

    // 3b. Safe legal-suffix stripped match against `companies.name`
    if (strippedName && strippedName.toLowerCase() !== cleanName.toLowerCase()) {
        const allCompanies = db.prepare('SELECT * FROM companies').all();
        const suffixMatches = allCompanies.filter(
            c => stripLegalSuffix(c.name).toLowerCase() === strippedName.toLowerCase()
        );
        if (suffixMatches.length > 1) {
            return {
                resolved: false,
                created: false,
                ambiguous: true,
                matchType: 'ambiguous_normalized_name',
                reason: `Multiple companies match normalized name "${strippedName}"`,
                candidates: suffixMatches,
                company: null,
                companyId: null,
                parentCompany: null
            };
        }
        if (suffixMatches.length === 1) {
            const company = suffixMatches[0];
            if (hasDomainConflict(company, officialDomain)) {
                return {
                    resolved: false,
                    created: false,
                    ambiguous: true,
                    matchType: 'domain_conflict',
                    reason: `Normalized name "${strippedName}" conflicts on domain (${company.domain} vs ${officialDomain})`,
                    candidates: [company],
                    company: null,
                    companyId: null,
                    parentCompany: null
                };
            }
            return {
                resolved: true,
                created: false,
                ambiguous: false,
                matchType: 'normalized_name',
                company,
                companyId: company.id,
                parentCompany: attachParentCompany(company)
            };
        }
    }

    // 4. Parent / acquisition resolution when explicitly named
    let resolvedParent = null;
    if (parentCompanyName && isValidEmployerName(parentCompanyName)) {
        const parentLookup = resolveCompanyIdentity({
            name: parentCompanyName,
            createIfMissing: false
        });
        if (parentLookup.resolved) {
            resolvedParent = parentLookup.company;
            // Check if a unique subsidiary under that parent matches our stripped name or alias
            const children = db.prepare(
                'SELECT * FROM companies WHERE parent_company_id = ?'
            ).all(resolvedParent.id);
            const matchingChildren = children.filter(c =>
                stripLegalSuffix(c.name).toLowerCase() === strippedName.toLowerCase()
            );
            if (matchingChildren.length === 1) {
                return {
                    resolved: true,
                    created: false,
                    ambiguous: false,
                    matchType: 'parent_subsidiary',
                    company: matchingChildren[0],
                    companyId: matchingChildren[0].id,
                    parentCompany: resolvedParent
                };
            }
            if (!cleanName && children.length === 0) {
                return {
                    resolved: true,
                    created: false,
                    ambiguous: false,
                    matchType: 'parent',
                    company: resolvedParent,
                    companyId: resolvedParent.id,
                    parentCompany: attachParentCompany(resolvedParent)
                };
            }
        }
    }

    // 5. ATS board identity (`ats_type` + `board_identifier`)
    if (atsType && boardIdentifier) {
        const atsMatches = getCompaniesByAtsBoard(atsType, boardIdentifier);
        if (atsMatches.length > 1) {
            return {
                resolved: false,
                created: false,
                ambiguous: true,
                matchType: 'ambiguous_ats_board',
                reason: `Multiple companies share ${atsType}:${boardIdentifier}`,
                candidates: atsMatches,
                company: null,
                companyId: null,
                parentCompany: null
            };
        }
        if (atsMatches.length === 1) {
            const company = atsMatches[0];
            if (hasDomainConflict(company, officialDomain)) {
                return {
                    resolved: false,
                    created: false,
                    ambiguous: true,
                    matchType: 'domain_conflict',
                    reason: `ATS board ${atsType}:${boardIdentifier} belongs to ${company.id} (${company.domain}), conflicting with ${officialDomain}`,
                    candidates: [company],
                    company: null,
                    companyId: null,
                    parentCompany: null
                };
            }
            return {
                resolved: true,
                created: false,
                ambiguous: false,
                matchType: 'ats_board',
                company,
                companyId: company.id,
                parentCompany: attachParentCompany(company)
            };
        }
    }

    // 6. Create UNVERIFIED company stub only if requested and identity is sufficiently specific
    if (createIfMissing && (isValidEmployerName(cleanName) || officialDomain)) {
        const displayName = isValidEmployerName(cleanName) ? cleanName : officialDomain;
        const hashSeed = `${officialDomain || ''}|${displayName.toLowerCase()}`;
        const shortHash = createHash('sha256').update(hashSeed).digest('hex').slice(0, 8);
        const slug = displayName
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/(^-|-$)/g, '')
            .slice(0, 40) || 'employer';
        const companyId = `company-${slug}-${shortHash}`;

        try {
            createCompany({
                id: companyId,
                name: displayName,
                domain: officialDomain,
                website_url: officialDomain ? `https://${officialDomain}` : null,
                ats_type: atsType || null,
                board_identifier: boardIdentifier || null,
                parent_company_id: resolvedParent ? resolvedParent.id : null,
                source_provenance: sourceProvenance,
                lifecycle_status: lifecycleStatus,
                monitoring_status: monitoringStatus,
                notes
            });

            if (Array.isArray(aliases)) {
                for (const alias of aliases) {
                    const cleanAlias = normalizeCompanyName(alias);
                    if (cleanAlias && cleanAlias.toLowerCase() !== displayName.toLowerCase()) {
                        addCompanyAlias(companyId, cleanAlias, sourceProvenance);
                    }
                }
            }

            const createdCompany = getCompany(companyId);
            return {
                resolved: true,
                created: true,
                ambiguous: false,
                matchType: 'created',
                company: createdCompany,
                companyId,
                parentCompany: resolvedParent
            };
        } catch {
            // Re-resolve if another call inserted concurrently
            const retry = resolveCompanyIdentity({
                name: cleanName,
                aliases,
                domain: officialDomain,
                atsType,
                boardIdentifier,
                createIfMissing: false
            });
            if (retry.resolved || retry.ambiguous) {
                return retry;
            }
        }
    }

    return {
        resolved: false,
        created: false,
        ambiguous: false,
        matchType: 'unresolved',
        reason: 'No canonical match and creation disabled or insufficient company identity',
        candidates: [],
        company: null,
        companyId: null,
        parentCompany: resolvedParent
    };
}

/**
 * Register a discovered career URL, ATS board, and valid source policy on a company.
 * Enforces the canonical `source_policies.source_type` schema CHECK constraint.
 */
export function registerCompanyCareerSurface({
    companyId,
    careerUrl = null,
    atsType = null,
    boardIdentifier = null,
    source = 'discovery',
    policySourceType = null,
    policyEndpoint = null,
    discoveryPermitted = true,
    publicNavPermitted = true,
    feedAccessPermitted = true,
    enabled = true,
    notes = null
} = {}) {
    if (!companyId) throw new Error('registerCompanyCareerSurface requires companyId');

    if (careerUrl) {
        registerCareerPage(companyId, careerUrl, source);
    }

    if (atsType && boardIdentifier) {
        registerAtsBoard(companyId, atsType, boardIdentifier);
    }

    const effectivePolicyType = policySourceType
        || (atsType && VALID_POLICY_SOURCE_TYPES.has(atsType) ? atsType : 'custom');

    if (!VALID_POLICY_SOURCE_TYPES.has(effectivePolicyType)) {
        throw new Error(`Invalid policy source_type "${effectivePolicyType}"`);
    }

    const endpoint = policyEndpoint || careerUrl || (atsType && boardIdentifier ? `${atsType}:${boardIdentifier}` : null);
    if (endpoint) {
        const policyId = `policy-${companyId}-${effectivePolicyType}`;
        upsertSourcePolicy({
            id: policyId,
            company_id: companyId,
            source_type: effectivePolicyType,
            endpoint,
            enabled,
            discovery_permitted: discoveryPermitted,
            public_nav_permitted: publicNavPermitted,
            feed_access_permitted: feedAccessPermitted,
            notes
        });
    }

    return getCompany(companyId);
}
