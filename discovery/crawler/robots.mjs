/**
 * discovery/crawler/robots.mjs — Standards-aware RFC 9309 robots.txt Parser & Rule Evaluator
 */

import { safeFetch, HttpError } from './fetch.mjs';

/**
 * Convert a robots.txt path pattern (with * and $) into a RegExp.
 * @param {string} pattern
 * @returns {RegExp}
 */
export function compileRobotsPattern(pattern) {
    if (!pattern || pattern === '/') {
        return /^\//;
    }
    // Escape regex special chars except * and $ (including literal ?)
    let escaped = pattern.replace(/[-[\]{}()+?.,\\^|#\s]/g, '\\$&');
    escaped = escaped.replace(/\*/g, '.*');
    if (escaped.endsWith('\\$')) {
        escaped = escaped.slice(0, -2) + '$';
    }
    return new RegExp(`^${escaped}`);
}

export class RobotsParser {
    constructor(content = '', userAgent = 'CareerOpsJobBot') {
        this.userAgent = userAgent.toLowerCase();
        this.sitemaps = [];
        this.rules = []; // { type: 'allow'|'disallow', pattern: string, regex: RegExp, length: number }
        this.parse(content);
    }

    parse(content) {
        if (!content || typeof content !== 'string') return;

        const lines = content.split(/\r?\n/);
        let currentAgents = [];
        let inRules = false;

        const botSpecificRules = [];
        const genericRules = [];

        for (let line of lines) {
            // Strip comments
            const hashIdx = line.indexOf('#');
            if (hashIdx !== -1) {
                line = line.slice(0, hashIdx);
            }
            line = line.trim();
            if (!line) continue;

            const colonIdx = line.indexOf(':');
            if (colonIdx === -1) continue;

            const field = line.slice(0, colonIdx).trim().toLowerCase();
            const value = line.slice(colonIdx + 1).trim();

            if (field === 'sitemap') {
                if (value) {
                    this.sitemaps.push(value);
                }
                continue;
            }

            if (field === 'user-agent') {
                if (inRules) {
                    // New record/group starts
                    currentAgents = [];
                    inRules = false;
                }
                currentAgents.push(value.toLowerCase());
                continue;
            }

            if (field === 'allow' || field === 'disallow') {
                inRules = true;
                if (currentAgents.length === 0) {
                    continue;
                }

                const matchesSpecific = currentAgents.some(a =>
                    a === this.userAgent || a === 'careeropsjobbot'
                );
                const matchesWildcard = currentAgents.includes('*');

                if (!matchesSpecific && !matchesWildcard) {
                    // Rule applies only to other named user agents
                    continue;
                }

                if (!value && field === 'disallow') {
                    // Empty Disallow: means allow all
                    const rule = {
                        type: 'allow',
                        pattern: '/',
                        regex: /^\//,
                        length: 1
                    };
                    if (matchesSpecific) botSpecificRules.push(rule);
                    else genericRules.push(rule);
                    continue;
                }

                if (value) {
                    const rule = {
                        type: field,
                        pattern: value,
                        regex: compileRobotsPattern(value),
                        length: value.length
                    };

                    if (matchesSpecific) {
                        botSpecificRules.push(rule);
                    } else {
                        genericRules.push(rule);
                    }
                }
            }
        }

        // If specific bot rules were found, they supersede the generic * group
        this.rules = botSpecificRules.length > 0 ? botSpecificRules : genericRules;
    }

    /**
     * Check if a path is allowed by the robots.txt rules.
     * RFC 9309 rule precedence:
     * - The most specific (longest) matching pattern wins.
     * - In a tie between Allow and Disallow of equal length, Allow wins.
     * - If no rule matches, access is allowed.
     *
     * @param {string} urlPath - e.g. "/careers/job-123"
     * @returns {{ allowed: boolean, reason: string, matchedRule?: string }}
     */
    isAllowed(urlPath) {
        if (!urlPath) return { allowed: true, reason: 'Empty path allowed' };

        // Ensure path starts with /
        const path = urlPath.startsWith('/') ? urlPath : `/${urlPath}`;

        let bestMatch = null;

        for (const rule of this.rules) {
            if (rule.regex.test(path)) {
                if (!bestMatch || rule.length > bestMatch.length) {
                    bestMatch = rule;
                } else if (rule.length === bestMatch.length && rule.type === 'allow' && bestMatch.type === 'disallow') {
                    // In a tie, Allow wins
                    bestMatch = rule;
                }
            }
        }

        if (!bestMatch) {
            return {
                allowed: true,
                reason: 'No matching robots.txt rule found, access allowed by default'
            };
        }

        if (bestMatch.type === 'allow') {
            return {
                allowed: true,
                reason: `Allowed by robots.txt rule: Allow: ${bestMatch.pattern}`,
                matchedRule: bestMatch.pattern
            };
        } else {
            return {
                allowed: false,
                reason: `Blocked by robots.txt rule: Disallow: ${bestMatch.pattern}`,
                matchedRule: bestMatch.pattern
            };
        }
    }
}

// In-memory robots cache: domain -> { parser: RobotsParser, expiresAt: number }
const robotsCache = new Map();
const ROBOTS_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Fetch and parse robots.txt for an origin, using cache when available.
 *
 * @param {string} targetUrl
 * @param {Object} [options]
 * @returns {Promise<{ ok: boolean, parser: RobotsParser, reason?: string }>}
 */
export async function getRobotsForUrl(targetUrl, options = {}) {
    let parsed;
    try {
        parsed = new URL(targetUrl);
    } catch {
        return {
            ok: false,
            parser: new RobotsParser(''),
            reason: `Invalid URL: ${targetUrl}`
        };
    }

    const origin = parsed.origin;
    const now = Date.now();
    const cached = robotsCache.get(origin);
    if (cached && cached.expiresAt > now) {
        return { ok: true, parser: cached.parser };
    }

    const robotsUrl = `${origin}/robots.txt`;
    const doFetch = options.fetcher || safeFetch;

    try {
        const res = await doFetch(robotsUrl, {
            timeoutMs: 5000,
            maxSizeBytes: 512 * 1024, // 512KB
            ...options
        });

        const parser = new RobotsParser(res.text);
        robotsCache.set(origin, { parser, expiresAt: now + ROBOTS_CACHE_TTL_MS });
        return { ok: true, parser };
    } catch (err) {
        if (err instanceof HttpError && err.status === 404) {
            // 404 means no robots.txt exists -> full access allowed
            const emptyParser = new RobotsParser('');
            robotsCache.set(origin, { parser: emptyParser, expiresAt: now + ROBOTS_CACHE_TTL_MS });
            return { ok: true, parser: emptyParser, reason: 'robots.txt returned 404 (allowed)' };
        }

        // On 5xx or server/network error, RFC 9309 specifies fail closed
        const disallowAllParser = new RobotsParser('User-agent: *\nDisallow: /');
        return {
            ok: false,
            parser: disallowAllParser,
            reason: `Failed to fetch robots.txt (${err.message}), failing closed per RFC 9309`
        };
    }
}
