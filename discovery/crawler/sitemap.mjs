/**
 * discovery/crawler/sitemap.mjs — Recursive XML Sitemap Discovery & URL Extraction
 */

import { safeFetch } from './fetch.mjs';
import { normalizeDomain } from '../../db/repo.mjs';

/**
 * Extract XML tag contents using resilient regex.
 * @param {string} xml
 * @param {string} tagName
 * @returns {string[]}
 */
export function extractXmlTags(xml, tagName) {
    if (!xml) return [];
    const results = [];
    // Handles <tagName>value</tagName> with optional namespaces or attributes
    const regex = new RegExp(`<(?:[a-zA-Z0-9_-]+:)?${tagName}(?:\\s+[^>]*)?>([\\s\\S]*?)<\\/(?:[a-zA-Z0-9_-]+:)?${tagName}>`, 'gi');
    let match;
    while ((match = regex.exec(xml)) !== null) {
        const val = match[1].trim();
        // Remove CDATA if present
        const clean = val.replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/i, '$1').trim();
        if (clean) results.push(clean);
    }
    return results;
}

/**
 * Test if a URL looks like a candidate job posting or career listing page.
 * @param {string} urlStr
 * @returns {boolean}
 */
export function isCandidateJobUrl(urlStr) {
    if (!urlStr) return false;
    const lower = urlStr.toLowerCase();
    const jobKeywords = [
        '/job/', '/jobs/', '/careers/', '/career/', '/position/', '/positions/',
        '/posting/', '/postings/', '/opening/', '/openings/', '/work-with-us/',
        '/join-us/', '/opportunities/', '/vacancies/', '/vacancy/'
    ];

    // Exclude static assets
    if (/\.(png|jpe?g|gif|svg|pdf|css|js|ico|webp|woff2?)$/i.test(lower)) {
        return false;
    }

    // Match ATS hosted job detail paths (e.g. jobs.lever.co/company/uuid or jobs.ashbyhq.com/company/uuid)
    if (/jobs\.lever\.co\/[^/]+\/[a-f0-9-]+/i.test(lower)) return true;
    if (/jobs\.ashbyhq\.com\/[^/]+\/[a-f0-9-]+/i.test(lower)) return true;
    if (/greenhouse\.io\/[^/]+\/jobs\/\d+/i.test(lower)) return true;

    return jobKeywords.some(kw => lower.includes(kw));
}

/**
 * Parse an XML sitemap or sitemap index string.
 * @param {string} xmlContent
 * @returns {{ isIndex: boolean, sitemaps: string[], urls: Array<{ loc: string, lastmod?: string }> }}
 */
export function parseSitemapXml(xmlContent) {
    if (!xmlContent || typeof xmlContent !== 'string') {
        return { isIndex: false, sitemaps: [], urls: [] };
    }

    // Check if sitemapindex
    const isIndex = /<sitemapindex[\s>]/i.test(xmlContent);

    if (isIndex) {
        const sitemapBlocks = xmlContent.split(/<\/sitemap>/i);
        const sitemaps = [];
        for (const block of sitemapBlocks) {
            const locs = extractXmlTags(block, 'loc');
            if (locs.length > 0) {
                sitemaps.push(locs[0]);
            }
        }
        return { isIndex: true, sitemaps, urls: [] };
    }

    // Otherwise standard urlset
    const urlBlocks = xmlContent.split(/<\/url>/i);
    const urls = [];

    for (const block of urlBlocks) {
        const locs = extractXmlTags(block, 'loc');
        if (locs.length > 0) {
            const lastmods = extractXmlTags(block, 'lastmod');
            urls.push({
                loc: locs[0],
                lastmod: lastmods[0] || null
            });
        }
    }

    return { isIndex: false, sitemaps: [], urls };
}

/**
 * Discover and extract candidate job URLs from sitemaps with recursive index traversal,
 * cycle detection, and strict depth / count bounds.
 *
 * @param {string[]} initialSitemapUrls - Sitemaps discovered via robots.txt or default /sitemap.xml
 * @param {Object} [options]
 * @param {string[]} [options.allowedHosts]
 * @param {number} [options.maxDepth=3]
 * @param {number} [options.maxSitemaps=10]
 * @param {number} [options.maxUrls=500]
 * @param {boolean} [options.filterJobUrlsOnly=true]
 * @returns {Promise<{
 *   candidateUrls: Array<{ url: string, lastmod?: string }>,
 *   sitemapsVisited: string[],
 *   sitemapsFailed: Array<{ url: string, error: string }>,
 *   hitLimits: boolean
 * }>}
 */
export async function crawlSitemaps(initialSitemapUrls, options = {}) {
    const allowedHosts = options.allowedHosts ? options.allowedHosts.map(h => normalizeDomain(h)) : [];
    const maxDepth = options.maxDepth ?? 3;
    const maxSitemaps = options.maxSitemaps ?? 10;
    const maxUrls = options.maxUrls ?? 500;
    const filterJobUrlsOnly = options.filterJobUrlsOnly !== false;

    const fetchFn = typeof options.fetcher === 'function' ? options.fetcher : safeFetch;
    const visitedSitemaps = new Set();
    const candidateUrls = [];
    const candidateUrlSet = new Set();
    const sitemapsFailed = [];
    let hitLimits = false;

    async function processSitemap(sitemapUrl, depth) {
        if (depth > maxDepth || visitedSitemaps.size >= maxSitemaps || candidateUrls.length >= maxUrls) {
            hitLimits = true;
            return;
        }

        if (visitedSitemaps.has(sitemapUrl)) {
            // Cycle detected
            return;
        }

        visitedSitemaps.add(sitemapUrl);

        let parsedUrl;
        try {
            parsedUrl = new URL(sitemapUrl);
        } catch {
            sitemapsFailed.push({ url: sitemapUrl, error: 'Malformed URL' });
            return;
        }

        const host = normalizeDomain(parsedUrl.hostname);
        if (allowedHosts.length > 0 && !allowedHosts.some(ah => host === ah || host.endsWith(`.${ah}`))) {
            sitemapsFailed.push({ url: sitemapUrl, error: `Cross-origin host rejected: ${host}` });
            return;
        }

        try {
            const res = await fetchFn(sitemapUrl, {
                timeoutMs: 8000,
                maxSizeBytes: 2 * 1024 * 1024,
                allowedHosts: allowedHosts.length > 0 ? allowedHosts : undefined
            });

            const parsed = parseSitemapXml(res.text);

            if (parsed.isIndex) {
                for (const subSitemap of parsed.sitemaps) {
                    if (visitedSitemaps.size >= maxSitemaps || candidateUrls.length >= maxUrls) {
                        hitLimits = true;
                        break;
                    }
                    await processSitemap(subSitemap, depth + 1);
                }
            } else {
                for (const item of parsed.urls) {
                    if (candidateUrls.length >= maxUrls) {
                        hitLimits = true;
                        break;
                    }

                    if (candidateUrlSet.has(item.loc)) continue;

                    if (!filterJobUrlsOnly || isCandidateJobUrl(item.loc)) {
                        candidateUrlSet.add(item.loc);
                        candidateUrls.push({
                            url: item.loc,
                            lastmod: item.lastmod
                        });
                    }
                }
            }
        } catch (err) {
            sitemapsFailed.push({ url: sitemapUrl, error: err.message });
        }
    }

    for (const url of initialSitemapUrls) {
        if (visitedSitemaps.size >= maxSitemaps || candidateUrls.length >= maxUrls) {
            hitLimits = true;
            break;
        }
        await processSitemap(url, 1);
    }

    return {
        candidateUrls,
        sitemapsVisited: Array.from(visitedSitemaps),
        sitemapsFailed,
        hitLimits
    };
}
