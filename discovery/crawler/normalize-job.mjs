/**
 * discovery/crawler/normalize-job.mjs — Normalizes Crawled Job Postings to Canonical Contract
 */

import { detectRemoteType, detectEmploymentType } from '../adapters/base.mjs';

/**
 * Build a canonical NormalizedJob object from crawled data.
 *
 * @param {Object} raw
 * @param {string} raw.company_id
 * @param {string} raw.title
 * @param {string} [raw.description]
 * @param {string} raw.url
 * @param {string|null} [raw.source_job_id]
 * @param {string|null} [raw.location]
 * @param {string|null} [raw.remote_type]
 * @param {string|null} [raw.applicant_eligibility]
 * @param {string|null} [raw.employment_type]
 * @param {string|null} [raw.source_updated_at]
 * @param {number} [raw.confidence=0.95]
 * @param {string} [raw.extraction_method='json_ld']
 * @param {boolean} [raw.needs_review=false]
 * @param {Object} [raw.raw_payload]
 * @returns {Object}
 */
export function normalizeCrawledJob(raw) {
    if (!raw.company_id) throw new Error('company_id is required');
    if (!raw.title) throw new Error('title is required');
    if (!raw.url) throw new Error('url is required');

    const cleanTitle = raw.title.trim();
    const cleanDesc = (raw.description || '').trim();

    // Use explicit remote_type if provided by structured data; otherwise detect from title/description
    const remoteType = raw.remote_type || detectRemoteType(cleanTitle, raw.location, null, cleanDesc);

    // Use explicit employment_type if provided; otherwise detect
    const employmentType = raw.employment_type || detectEmploymentType(cleanTitle, null, cleanDesc);

    return {
        id: raw.id || raw.url.trim(),
        company_id: raw.company_id,
        source: 'career_page',
        source_job_id: raw.source_job_id ? String(raw.source_job_id).trim() : null,
        title: cleanTitle,
        description: cleanDesc,
        job_url: raw.url.trim(),
        location: raw.location ? raw.location.trim() : null,
        remote_type: remoteType || null,
        applicant_eligibility: raw.applicant_eligibility ? raw.applicant_eligibility.trim() : null,
        employment_type: employmentType || null,
        source_updated_at: raw.source_updated_at || null,
        raw_json: JSON.stringify({
            source_payload: raw.raw_payload || {},
            crawler_meta: {
                confidence: raw.confidence ?? 0.95,
                extraction_method: raw.extraction_method || 'json_ld',
                needs_review: raw.needs_review || false,
                extracted_at: new Date().toISOString()
            }
        })
    };
}
