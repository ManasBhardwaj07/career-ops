/**
 * discovery/adapters/base.mjs — Base Discovery Adapter Utilities & Normalization
 *
 * Provides shared normalization, remote-work detection, employment-type detection,
 * retry fetch logic, and standard data contracts across all ATS adapters.
 */

export function detectRemoteType(title = '', location = '', workplaceType = '') {
    const t = title || '';
    const loc = location || '';
    const wp = workplaceType || '';
    const text = `${t} ${loc} ${wp}`.toLowerCase();

    if (wp.toLowerCase().includes('hybrid') || text.includes('hybrid') || text.includes('flexible')) {
        return 'hybrid';
    }

    if (
        wp.toLowerCase().includes('remote') ||
        text.includes('remote') ||
        text.includes('work from home') ||
        text.includes('wfh') ||
        text.includes('anywhere') ||
        text.includes('telecommute')
    ) {
        return 'remote';
    }

    if (loc && loc.trim().length > 0) {
        return 'onsite';
    }

    return null;
}

export function detectEmploymentType(title = '', commitment = '', employmentType = '') {
    const text = `${title} ${commitment} ${employmentType}`.toLowerCase();

    if (text.includes('intern') || text.includes('trainee') || text.includes('co-op')) {
        return 'internship';
    }
    if (text.includes('contract') || text.includes('contractor') || text.includes('freelance') || text.includes('temp')) {
        return 'contract';
    }
    if (text.includes('part-time') || text.includes('part time') || text.includes('parttime')) {
        return 'part-time';
    }
    if (text.includes('full-time') || text.includes('full time') || text.includes('fulltime') || text.includes('permanent')) {
        return 'full-time';
    }

    return null;
}

/**
 * Standardized ATS Job Contract
 */
export function createNormalizedJob({
    id,
    company_id,
    company_name,
    title,
    location = null,
    remote_type = null,
    applicant_eligibility = null,
    employment_type = null,
    job_url,
    apply_url = null,
    employer_career_url = null,
    description = null,
    source,
    source_job_id = null,
    source_updated_at = null,
    published_at = null,
    discovered_at = null,
    last_seen_at = null,
    raw = null
}) {
    if (!title || !job_url) {
        throw new Error('Normalized job requires at least title and job_url');
    }

    const cleanTitle = title.trim();
    const cleanUrl = job_url.trim();
    const effectiveApplyUrl = (apply_url || cleanUrl).trim();
    const pubAt = published_at || source_updated_at;

    return {
        id: id || cleanUrl,
        company_id,
        company_name: company_name || null,
        title: cleanTitle,
        location: location?.trim() || null,
        remote_type: remote_type || detectRemoteType(cleanTitle, location || ''),
        applicant_eligibility: applicant_eligibility?.trim() || null,
        employment_type: employment_type || detectEmploymentType(cleanTitle, '', ''),
        job_url: cleanUrl,
        apply_url: effectiveApplyUrl,
        employer_career_url: employer_career_url || null,
        description: description?.trim() || null,
        source: source || 'unknown',
        source_job_id: source_job_id ? String(source_job_id).trim() : null,
        source_updated_at: pubAt ? new Date(pubAt).toISOString() : null,
        published_at: pubAt ? new Date(pubAt).toISOString() : null,
        discovered_at: discovered_at || new Date().toISOString(),
        last_seen_at: last_seen_at || new Date().toISOString(),
        raw: raw || null,
        raw_json: raw ? (typeof raw === 'string' ? raw : JSON.stringify(raw)) : null
    };
}

export async function fetchWithRetry(url, options = {}, { retries = 2, backoffMs = 500, timeoutMs = 10000, fetchFn = fetch } = {}) {
    let lastError = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        try {
            const res = await fetchFn(url, {
                ...options,
                signal: controller.signal,
                headers: {
                    'User-Agent': 'CareerOpsBot/1.0 (+https://github.com/santifer/career-ops)',
                    'Accept': 'application/json, text/html, */*',
                    ...(options.headers || {})
                }
            });

            clearTimeout(timer);

            if (!res.ok) {
                // Do not retry 404 or 403
                if (res.status === 404 || res.status === 403) {
                    throw new Error(`HTTP ${res.status}: ${res.statusText}`);
                }
                throw new Error(`HTTP ${res.status}: ${res.statusText}`);
            }

            return res;
        } catch (err) {
            clearTimeout(timer);
            lastError = err;
            if (attempt < retries && !err.message.includes('HTTP 404') && !err.message.includes('HTTP 403')) {
                await new Promise(r => setTimeout(r, backoffMs * Math.pow(2, attempt)));
            }
        }
    }

    throw lastError || new Error(`Failed to fetch ${url} after ${retries} retries`);
}
