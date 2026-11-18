/**
 * discovery/interfaces.mjs — Standardized Provider Interfaces & Common Types
 *
 * Defines contracts for:
 *   - ATSBoardAdapter: First-party employer-hosted ATS feeds
 *   - JobBoardProvider: Multi-employer aggregated job boards
 *   - WebSearchProvider: General web search engines (leads only)
 *
 * Implements Milestone 3A standardized error hierarchy and result validators.
 */

// ─── Error Hierarchy ──────────────────────────────────────────────────────────

export class ProviderError extends Error {
    constructor(message, { provider = 'unknown', statusCode = null, recoverable = false } = {}) {
        super(message);
        this.name = 'ProviderError';
        this.provider = provider;
        this.statusCode = statusCode;
        this.recoverable = recoverable;
    }
}

export class ProviderRateLimitError extends ProviderError {
    constructor(message = 'Rate limit exceeded', { provider, retryAfterMs = 5000 } = {}) {
        super(message, { provider, statusCode: 429, recoverable: true });
        this.name = 'ProviderRateLimitError';
        this.retryAfterMs = retryAfterMs;
    }
}

export class ProviderTimeoutError extends ProviderError {
    constructor(message = 'Provider request timed out', { provider, timeoutMs = 10000 } = {}) {
        super(message, { provider, statusCode: 408, recoverable: true });
        this.name = 'ProviderTimeoutError';
        this.timeoutMs = timeoutMs;
    }
}

export class ProviderAuthError extends ProviderError {
    constructor(message = 'Provider authentication failed or missing credentials', { provider } = {}) {
        super(message, { provider, statusCode: 401, recoverable: false });
        this.name = 'ProviderAuthError';
    }
}

export class InvalidPayloadError extends ProviderError {
    constructor(message = 'Invalid or unparseable payload from provider', { provider, rawPayload = null } = {}) {
        super(message, { provider, statusCode: 422, recoverable: false });
        this.name = 'InvalidPayloadError';
        this.rawPayload = rawPayload;
    }
}

// ─── Result Data Contracts ───────────────────────────────────────────────────

/**
 * Standard Result returned by all ATSBoardAdapter implementations
 */
export class AdapterResult {
    constructor({
        sourceType,
        endpoint = null,
        jobs = [],
        fetchedCount = 0,
        normalizedCount = 0,
        invalidCount = 0,
        duplicateInSourceCount = 0,
        errors = [],
        error = null
    }) {
        this.sourceType = sourceType;
        this.endpoint = endpoint;
        this.jobs = jobs;
        this.total = jobs.length;
        this.fetchedCount = fetchedCount || jobs.length;
        this.normalizedCount = normalizedCount || jobs.length;
        this.invalidCount = invalidCount;
        this.duplicateInSourceCount = duplicateInSourceCount;
        this.errors = errors;
        this.error = error;
    }
}

/**
 * Standard Result returned by all JobBoardProvider implementations
 */
export class JobBoardResult {
    constructor({
        boardIdentifier,
        postings = [],
        fetchedCount = 0,
        errors = []
    }) {
        this.boardIdentifier = boardIdentifier;
        this.postings = postings;
        this.total = postings.length;
        this.fetchedCount = fetchedCount || postings.length;
        this.errors = errors;
    }
}

/**
 * Single Search Lead Item returned by WebSearchProvider
 */
export class SearchLeadItem {
    constructor({
        rawUrl,
        title,
        snippet = '',
        resultRank = 1,
        provider = 'unknown',
        providerPayload = null
    }) {
        if (!rawUrl) throw new Error('SearchLeadItem requires rawUrl');
        this.rawUrl = rawUrl.trim();
        this.title = (title || '').trim();
        this.snippet = (snippet || '').trim();
        this.resultRank = resultRank;
        this.provider = provider;
        this.providerPayload = providerPayload;
    }
}

/**
 * Standard Result returned by all WebSearchProvider implementations
 */
export class SearchLeadResult {
    constructor({
        providerName,
        query,
        items = [],
        totalAvailable = null,
        durationMs = 0,
        error = null
    }) {
        this.providerName = providerName;
        this.query = query;
        this.items = items;
        this.count = items.length;
        this.totalAvailable = totalAvailable;
        this.durationMs = durationMs;
        this.error = error;
    }
}

// ─── Validation Helpers ──────────────────────────────────────────────────────

export function validateAdapterResult(result) {
    if (!result || typeof result !== 'object') {
        throw new InvalidPayloadError('Adapter result must be an object');
    }
    if (!result.sourceType) {
        throw new InvalidPayloadError('Adapter result missing sourceType');
    }
    if (!Array.isArray(result.jobs)) {
        throw new InvalidPayloadError('Adapter result jobs must be an array');
    }

    for (let i = 0; i < result.jobs.length; i++) {
        const job = result.jobs[i];
        if (!job.title || typeof job.title !== 'string') {
            throw new InvalidPayloadError(`Job at index ${i} missing valid title`);
        }
        if (!job.job_url || typeof job.job_url !== 'string') {
            throw new InvalidPayloadError(`Job at index ${i} missing valid job_url`);
        }
        if (!job.company_id) {
            throw new InvalidPayloadError(`Job at index ${i} missing company_id`);
        }
    }

    return true;
}

export function validateSearchLeadResult(result) {
    if (!result || typeof result !== 'object') {
        throw new InvalidPayloadError('SearchLeadResult must be an object');
    }
    if (!result.providerName) {
        throw new InvalidPayloadError('SearchLeadResult missing providerName');
    }
    if (!Array.isArray(result.items)) {
        throw new InvalidPayloadError('SearchLeadResult items must be an array');
    }

    for (let i = 0; i < result.items.length; i++) {
        const item = result.items[i];
        if (!item.rawUrl) {
            throw new InvalidPayloadError(`Search lead item at index ${i} missing rawUrl`);
        }
    }

    return true;
}
