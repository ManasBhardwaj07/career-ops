/**
 * discovery/crawler/rss.mjs — RSS 2.0 & Atom Feed Parser for Job Discovery
 */

import { safeFetch } from './fetch.mjs';
import { extractXmlTags, isCandidateJobUrl } from './sitemap.mjs';

/**
 * Unescape standard HTML entities.
 * @param {string} str
 * @returns {string}
 */
export function unescapeHtmlEntities(str) {
    if (!str || typeof str !== 'string') return '';
    return str
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, ' ');
}

/**
 * Sanitize untrusted feed HTML/text string.
 * @param {string} input
 * @returns {string}
 */
export function sanitizeFeedText(input) {
    if (!input || typeof input !== 'string') return '';
    const unescaped = unescapeHtmlEntities(input);
    return unescaped
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
        .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Parse an RSS 2.0 or Atom feed string into normalized entries.
 *
 * @param {string} feedXml
 * @returns {{
 *   feedType: 'rss'|'atom'|'unknown',
 *   title?: string,
 *   entries: Array<{
 *     id: string,
 *     title: string,
 *     url: string,
 *     description: string,
 *     publishedAt: string|null,
 *     updatedAt: string|null
 *   }>
 * }}
 */
export function parseFeedXml(feedXml) {
    if (!feedXml || typeof feedXml !== 'string') {
        return { feedType: 'unknown', entries: [] };
    }

    const isAtom = /<feed[\s>]/i.test(feedXml);
    const isRss = /<rss[\s>]/i.test(feedXml);

    if (!isAtom && !isRss) {
        return { feedType: 'unknown', entries: [] };
    }

    const entries = [];
    const seenUrls = new Set();

    if (isAtom) {
        const feedTitles = extractXmlTags(feedXml, 'title');
        const feedTitle = feedTitles[0] || '';

        const entryRegex = /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi;
        let entryMatch;

        while ((entryMatch = entryRegex.exec(feedXml)) !== null) {
            const block = entryMatch[1];
            const titles = extractXmlTags(block, 'title');
            const title = titles[0] || 'Untitled Job';

            // Atom link can be <link href="..."/> or <link>...</link>
            let url = '';
            const linkHrefMatch = /<link[^>]+href=["']([^"']+)["']/i.exec(block);
            if (linkHrefMatch) {
                url = linkHrefMatch[1];
            } else {
                const textLinks = extractXmlTags(block, 'link');
                url = textLinks[0] || '';
            }

            if (!url || seenUrls.has(url)) continue;
            seenUrls.add(url);

            const ids = extractXmlTags(block, 'id');
            const id = ids[0] || url;

            const summaries = extractXmlTags(block, 'summary');
            const contents = extractXmlTags(block, 'content');
            const rawDesc = summaries[0] || contents[0] || '';
            const description = sanitizeFeedText(rawDesc);

            const published = extractXmlTags(block, 'published');
            const updated = extractXmlTags(block, 'updated');

            entries.push({
                id,
                title: sanitizeFeedText(title),
                url: url.trim(),
                description,
                publishedAt: published[0] || null,
                updatedAt: updated[0] || null
            });
        }

        return { feedType: 'atom', title: feedTitle, entries };
    }

    // Otherwise RSS 2.0
    const channelTitles = extractXmlTags(feedXml, 'title');
    const feedTitle = channelTitles[0] || '';

    const itemRegex = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
    let itemMatch;

    while ((itemMatch = itemRegex.exec(feedXml)) !== null) {
        const block = itemMatch[1];
        const titles = extractXmlTags(block, 'title');
        const title = titles[0] || 'Untitled Job';

        const links = extractXmlTags(block, 'link');
        const url = links[0] || '';

        if (!url || seenUrls.has(url)) continue;
        seenUrls.add(url);

        const guids = extractXmlTags(block, 'guid');
        const id = guids[0] || url;

        const descriptions = extractXmlTags(block, 'description');
        const description = sanitizeFeedText(descriptions[0] || '');

        const pubDates = extractXmlTags(block, 'pubDate');

        entries.push({
            id,
            title: sanitizeFeedText(title),
            url: url.trim(),
            description,
            publishedAt: pubDates[0] || null,
            updatedAt: null
        });
    }

    return { feedType: 'rss', title: feedTitle, entries };
}

/**
 * Fetch and parse an RSS or Atom feed.
 *
 * @param {string} feedUrl
 * @param {Object} [options]
 * @returns {Promise<{
 *   feedType: string,
 *   title?: string,
 *   candidateJobs: Array<{ id: string, title: string, url: string, description: string, publishedAt: string|null }>
 * }>}
 */
export async function fetchFeed(feedUrl, options = {}) {
    const res = await safeFetch(feedUrl, {
        timeoutMs: 8000,
        maxSizeBytes: 2 * 1024 * 1024,
        ...options
    });

    const parsed = parseFeedXml(res.text);
    return {
        feedType: parsed.feedType,
        title: parsed.title,
        candidateJobs: parsed.entries
    };
}
