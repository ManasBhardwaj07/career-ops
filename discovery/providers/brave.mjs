/**
 * discovery/providers/brave.mjs — Brave Search API WebSearchProvider Implementation
 *
 * Implements the WebSearchProvider contract for broad web search lead discovery:
 *   Endpoint: https://api.search.brave.com/res/v1/web/search
 *   Authentication: X-Subscription-Token header from process.env.BRAVE_SEARCH_API_KEY
 *   Returns: SearchLeadResult containing SearchLeadItem[]
 *
 * Enforces rate limiting, in-memory caching, and strict credential isolation.
 */

import { fetchWithRetry } from '../adapters/base.mjs';
import {
    SearchLeadItem,
    SearchLeadResult,
    ProviderAuthError,
    ProviderRateLimitError,
    ProviderTimeoutError,
    ProviderError,
    validateSearchLeadResult
} from '../interfaces.mjs';

const BRAVE_API_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';

export class BraveSearchProvider {
    constructor({
        apiKey = null,
        cacheTtlMs = 15 * 60 * 1000, // 15-minute query cache
        minRequestIntervalMs = 1000,  // 1 req/sec max to respect free tier
        fetchFn = fetch
    } = {}) {
        this.providerName = 'search:brave';
        this.apiKey = apiKey || process.env.BRAVE_SEARCH_API_KEY || null;
        this.cacheTtlMs = cacheTtlMs;
        this.minRequestIntervalMs = minRequestIntervalMs;
        this.fetchFn = fetchFn;
        this._cache = new Map();
        this._lastRequestTime = 0;
    }

    /**
     * Check if provider is configured with credentials
     */
    isConfigured() {
        return !!(this.apiKey || process.env.BRAVE_SEARCH_API_KEY);
    }

    /**
     * Clear query cache
     */
    clearCache() {
        this._cache.clear();
    }

    /**
     * Search the web for job leads
     *
     * @param {string} query Search terms (e.g. 'site:jobs.lever.co "Full Stack Engineer" "India"')
     * @param {object} options
     * @param {number} options.count Number of results per request (1-20, default 20)
     * @param {number} options.offset Pagination offset (0-9, default 0)
     * @param {string} options.country 2-letter country code (e.g. 'IN', 'US')
     * @param {string} options.searchLang Search language (e.g. 'en')
     * @param {boolean} options.bypassCache Force fresh network request
     * @param {number} options.timeoutMs Request timeout in ms
     * @returns {Promise<SearchLeadResult>}
     */
    async search(query, {
        count = 20,
        offset = 0,
        country = null,
        searchLang = 'en',
        bypassCache = false,
        timeoutMs = 10000
    } = {}) {
        const cleanQuery = (query || '').trim();
        if (!cleanQuery) {
            throw new ProviderError('Search query cannot be empty', { provider: this.providerName });
        }

        const effectiveKey = this.apiKey || process.env.BRAVE_SEARCH_API_KEY;
        if (!effectiveKey) {
            throw new ProviderAuthError(
                'BRAVE_SEARCH_API_KEY is missing. Supply via environment or BraveSearchProvider constructor.',
                { provider: this.providerName }
            );
        }

        const cacheKey = `${cleanQuery}::count=${count}::offset=${offset}::country=${country || ''}`;
        if (!bypassCache && this._cache.has(cacheKey)) {
            const cached = this._cache.get(cacheKey);
            if (Date.now() - cached.timestamp < this.cacheTtlMs) {
                return cached.result;
            }
            this._cache.delete(cacheKey);
        }

        // Rate-limit throttle
        const now = Date.now();
        const elapsed = now - this._lastRequestTime;
        if (elapsed < this.minRequestIntervalMs) {
            await new Promise(r => setTimeout(r, this.minRequestIntervalMs - elapsed));
        }
        this._lastRequestTime = Date.now();

        const safeCount = Math.max(1, Math.min(20, count));
        const safeOffset = Math.max(0, Math.min(9, offset));

        const url = new URL(BRAVE_API_ENDPOINT);
        url.searchParams.set('q', cleanQuery);
        url.searchParams.set('count', String(safeCount));
        url.searchParams.set('offset', String(safeOffset));
        url.searchParams.set('search_lang', searchLang);
        if (country) {
            url.searchParams.set('country', country.toLowerCase());
        }

        const startTime = Date.now();

        try {
            const res = await fetchWithRetry(url.toString(), {
                method: 'GET',
                headers: {
                    'Accept': 'application/json',
                    'Accept-Encoding': 'gzip',
                    'X-Subscription-Token': effectiveKey
                }
            }, {
                timeoutMs,
                fetchFn: this.fetchFn,
                retries: 1
            });

            const durationMs = Date.now() - startTime;
            const json = await res.json();
            const rawResults = Array.isArray(json?.web?.results) ? json.web.results : [];

            const items = [];
            for (let i = 0; i < rawResults.length; i++) {
                const r = rawResults[i];
                if (!r.url) continue;

                const snippet = r.description || (Array.isArray(r.extra_snippets) ? r.extra_snippets.join(' ') : '');
                const rank = (safeOffset * safeCount) + i + 1;

                items.push(new SearchLeadItem({
                    rawUrl: r.url,
                    title: r.title || '',
                    snippet,
                    resultRank: rank,
                    provider: this.providerName,
                    providerPayload: r
                }));
            }

            const result = new SearchLeadResult({
                providerName: this.providerName,
                query: cleanQuery,
                items,
                totalAvailable: json?.web?.total || items.length,
                durationMs,
                error: null
            });

            validateSearchLeadResult(result);
            this._cache.set(cacheKey, { timestamp: Date.now(), result });
            return result;
        } catch (err) {
            const durationMs = Date.now() - startTime;
            if (err.message && err.message.includes('HTTP 429')) {
                throw new ProviderRateLimitError('Brave Search API rate limit exceeded (HTTP 429)', {
                    provider: this.providerName
                });
            }
            if (err.name === 'AbortError' || (err.message && err.message.includes('timeout'))) {
                throw new ProviderTimeoutError(`Brave Search query timed out after ${timeoutMs}ms`, {
                    provider: this.providerName,
                    timeoutMs
                });
            }
            throw new ProviderError(`Brave Search failed: ${err.message}`, {
                provider: this.providerName
            });
        }
    }
}
