/**
 * discovery/crawler/jsonld.mjs — Schema.org JobPosting Extractor
 */

/**
 * Extract all JSON-LD script block texts from raw HTML.
 * @param {string} html
 * @returns {string[]}
 */
export function extractJsonLdBlocks(html) {
    if (!html || typeof html !== 'string') return [];
    const blocks = [];
    const regex = /<script\b[^>]*\btype=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let match;
    while ((match = regex.exec(html)) !== null) {
        const text = match[1].trim();
        if (text) blocks.push(text);
    }
    return blocks;
}

/**
 * Recursively find all nodes with @type === 'JobPosting' in an object or array.
 * @param {any} data
 * @returns {Object[]}
 */
export function findJobPostingNodes(data) {
    if (!data) return [];
    const results = [];

    if (Array.isArray(data)) {
        for (const item of data) {
            results.push(...findJobPostingNodes(item));
        }
        return results;
    }

    if (typeof data === 'object') {
        const type = data['@type'];
        const isJobPosting =
            type === 'JobPosting' ||
            (Array.isArray(type) && type.includes('JobPosting')) ||
            (typeof type === 'string' && type.endsWith('/JobPosting'));

        if (isJobPosting) {
            results.push(data);
        }

        // Check @graph array
        if (data['@graph']) {
            results.push(...findJobPostingNodes(data['@graph']));
        }

        // Recursively inspect child object properties (e.g. nested mainEntity)
        for (const key of Object.keys(data)) {
            if (key !== '@graph' && typeof data[key] === 'object' && data[key] !== null) {
                // Avoid infinite loop on circular refs
                if (key === 'hiringOrganization' || key === 'jobLocation') continue;
                results.push(...findJobPostingNodes(data[key]));
            }
        }
    }

    return results;
}

/**
 * Parse physical location from Schema.org Place / PostalAddress.
 * @param {any} jobLocation
 * @returns {string|null}
 */
export function formatPhysicalLocation(jobLocation) {
    if (!jobLocation) return null;

    if (typeof jobLocation === 'string') {
        return jobLocation.trim() || null;
    }

    if (Array.isArray(jobLocation)) {
        const locs = jobLocation.map(formatPhysicalLocation).filter(Boolean);
        return locs.length > 0 ? locs.join('; ') : null;
    }

    if (typeof jobLocation === 'object') {
        const addr = jobLocation.address || jobLocation;
        if (typeof addr === 'string') return addr.trim() || null;

        const parts = [
            addr.streetAddress,
            addr.addressLocality,
            addr.addressRegion,
            addr.addressCountry?.name || addr.addressCountry,
            addr.postalCode
        ].filter(p => typeof p === 'string' && p.trim().length > 0);

        if (parts.length > 0) {
            return parts.join(', ');
        }
        if (jobLocation.name && typeof jobLocation.name === 'string') {
            return jobLocation.name.trim();
        }
    }

    return null;
}

/**
 * Format applicant location requirements (must be kept separate from physical job location).
 * @param {any} req
 * @returns {string|null}
 */
export function formatApplicantLocationRequirements(req) {
    if (!req) return null;

    if (typeof req === 'string') return req.trim() || null;

    if (Array.isArray(req)) {
        const list = req.map(formatApplicantLocationRequirements).filter(Boolean);
        return list.length > 0 ? list.join(', ') : null;
    }

    if (typeof req === 'object') {
        const name = req.name || req['@name'];
        if (typeof name === 'string' && name.trim()) return name.trim();
        if (req.addressCountry) {
            const country = req.addressCountry.name || req.addressCountry;
            if (typeof country === 'string' && country.trim()) return country.trim();
        }
    }

    return null;
}

/**
 * Determine remote classification:
 * - 'remote': TELECOMMUTE or explicit remote
 * - 'hybrid': explicit hybrid indicator
 * - 'onsite': explicit physical onsite without telecommute
 * - null: unknown / not stated (never invented)
 *
 * @param {Object} node
 * @returns {'remote'|'hybrid'|'onsite'|null}
 */
export function detectRemoteFromJobPosting(node) {
    const locType = typeof node.jobLocationType === 'string' ? node.jobLocationType.toUpperCase() : '';
    const title = typeof node.title === 'string' ? node.title.toLowerCase() : '';
    const desc = typeof node.description === 'string' ? node.description.toLowerCase() : '';
    const workplace = typeof node.workplaceType === 'string' ? node.workplaceType.toUpperCase() : '';

    // Hybrid check (must be explicit)
    if (
        workplace === 'HYBRID' ||
        locType.includes('HYBRID') ||
        /\bhybrid\b/i.test(title) ||
        /\bhybrid (workplace|work|role|schedule|model|arrangement)\b/i.test(desc)
    ) {
        return 'hybrid';
    }

    // Remote check
    if (
        locType === 'TELECOMMUTE' ||
        locType.includes('REMOTE') ||
        workplace === 'REMOTE' ||
        /\bremote\b/i.test(title) ||
        (node.applicantLocationRequirements && !node.jobLocation)
    ) {
        return 'remote';
    }

    // Onsite check
    if (
        workplace === 'ONSITE' ||
        workplace === 'ON_SITE' ||
        locType === 'ONSITE' ||
        /\bon-?site\b/i.test(title)
    ) {
        return 'onsite';
    }

    // If a physical jobLocation exists and no remote indicators are found, return onsite
    if (node.jobLocation && !locType && !/\bremote\b/i.test(desc)) {
        return 'onsite';
    }

    return null;
}

/**
 * Standardize Schema.org employmentType enum.
 * @param {any} empType
 * @returns {'full-time'|'part-time'|'contract'|'internship'|null}
 */
export function detectEmploymentTypeFromJsonLd(empType) {
    if (!empType) return null;

    const val = (Array.isArray(empType) ? empType.join(' ') : String(empType)).toLowerCase();

    if (val.includes('intern') || val.includes('trainee')) return 'internship';
    if (val.includes('contract') || val.includes('temporary') || val.includes('freelance')) return 'contract';
    if (val.includes('part_time') || val.includes('part-time') || val.includes('part time')) return 'part-time';
    if (val.includes('full_time') || val.includes('full-time') || val.includes('full time')) return 'full-time';

    return null;
}

/**
 * Parse structured JobPosting nodes from HTML.
 *
 * @param {string} html
 * @param {string} pageUrl - The URL of the page containing the HTML
 * @returns {Array<{
 *   title: string,
 *   description: string,
 *   url: string,
 *   source_job_id: string|null,
 *   location: string|null,
 *   remote_type: 'remote'|'hybrid'|'onsite'|null,
 *   applicant_eligibility: string|null,
 *   employment_type: 'full-time'|'part-time'|'contract'|'internship'|null,
 *   date_posted: string|null,
 *   valid_through: string|null,
 *   hiring_organization: string|null,
 *   raw_node: Object
 * }>}
 */
export function parseJobPostingsFromJsonLd(html, pageUrl) {
    const blocks = extractJsonLdBlocks(html);
    const jobs = [];

    for (const block of blocks) {
        let parsed;
        try {
            parsed = JSON.parse(block);
        } catch {
            // Malformed JSON-LD: skip without failing the whole crawl
            continue;
        }

        const nodes = findJobPostingNodes(parsed);
        for (const node of nodes) {
            const title = typeof node.title === 'string' ? node.title.trim() : null;
            if (!title) continue;

            const description = typeof node.description === 'string' ? node.description.trim() : '';

            // Job URL: check node.url, directUrl, or fallback to pageUrl
            let jobUrl = pageUrl;
            if (typeof node.url === 'string' && node.url.trim()) {
                jobUrl = node.url.trim();
            }

            // Identifier / source_job_id
            let sourceJobId = null;
            if (node.identifier) {
                if (typeof node.identifier === 'string' || typeof node.identifier === 'number') {
                    sourceJobId = String(node.identifier);
                } else if (typeof node.identifier === 'object' && node.identifier.value) {
                    sourceJobId = String(node.identifier.value);
                }
            }

            const physicalLocation = formatPhysicalLocation(node.jobLocation);
            const applicantEligibility = formatApplicantLocationRequirements(node.applicantLocationRequirements);
            const remoteType = detectRemoteFromJobPosting(node);
            const employmentType = detectEmploymentTypeFromJsonLd(node.employmentType);

            // Hiring org
            let hiringOrg = null;
            if (node.hiringOrganization) {
                if (typeof node.hiringOrganization === 'string') {
                    hiringOrg = node.hiringOrganization;
                } else if (typeof node.hiringOrganization === 'object' && node.hiringOrganization.name) {
                    hiringOrg = String(node.hiringOrganization.name);
                }
            }

            jobs.push({
                title,
                description,
                url: jobUrl,
                source_job_id: sourceJobId,
                location: physicalLocation,
                remote_type: remoteType,
                applicant_eligibility: applicantEligibility,
                employment_type: employmentType,
                date_posted: node.datePosted ? String(node.datePosted) : null,
                valid_through: node.validThrough ? String(node.validThrough) : null,
                hiring_organization: hiringOrg,
                raw_node: node
            });
        }
    }

    return jobs;
}
