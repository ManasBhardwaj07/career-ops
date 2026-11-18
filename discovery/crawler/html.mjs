/**
 * discovery/crawler/html.mjs — Resilient HTML Fallback Parser for Unstructured Career Pages
 */

import { isCandidateJobUrl } from './sitemap.mjs';

/**
 * Extract clean text from HTML string.
 * @param {string} html
 * @returns {string}
 */
export function stripHtmlTags(html) {
    if (!html || typeof html !== 'string') return '';
    return html
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
        .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
        .replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Extract candidate job detail links from a career hub page.
 * @param {string} html
 * @param {string} baseUrl
 * @returns {Array<{ url: string, text: string }>}
 */
export function extractJobLinks(html, baseUrl) {
    if (!html || typeof html !== 'string') return [];
    const results = [];
    const seenUrls = new Set();

    const linkRegex = /<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let match;

    while ((match = linkRegex.exec(html)) !== null) {
        const rawHref = match[1].trim();
        const text = stripHtmlTags(match[2]);

        // Filter out anchors, javascript, mailto, tel
        if (!rawHref || rawHref.startsWith('#') || rawHref.startsWith('javascript:') || rawHref.startsWith('mailto:')) {
            continue;
        }

        let fullUrl;
        try {
            fullUrl = new URL(rawHref, baseUrl).toString();
        } catch {
            continue;
        }

        if (seenUrls.has(fullUrl)) continue;

        // Check if URL looks like a job posting
        if (isCandidateJobUrl(fullUrl) || isCandidateJobUrl(rawHref)) {
            // Ensure link text is meaningful (e.g. not "Read More", "Apply", or empty)
            const cleanText = text.replace(/^(apply|apply now|view job|view details|learn more)\b/i, '').trim();
            seenUrls.add(fullUrl);
            results.push({
                url: fullUrl,
                text: cleanText || text || 'Job Detail'
            });
        }
    }

    return results;
}

/**
 * Inspect an individual HTML page to extract job title and description if it appears to be a job posting.
 *
 * @param {string} html
 * @param {string} pageUrl
 * @returns {{
 *   isJobPosting: boolean,
 *   title: string|null,
 *   description: string|null,
 *   confidence: number,
 *   extraction_method: string,
 *   needs_review: boolean
 * }}
 */
export function parseJobFromHtml(html, pageUrl) {
    if (!html || typeof html !== 'string') {
        return { isJobPosting: false, title: null, description: null, confidence: 0, extraction_method: 'html_fallback', needs_review: true };
    }

    // 1. Title Extraction
    let title = null;

    // Try <h1> first
    const h1Match = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
    if (h1Match) {
        const h1Text = stripHtmlTags(h1Match[1]);
        // Filter out generic headers like "Careers", "Open Positions", "Join Us"
        if (h1Text && !/^(careers|open positions|join our team|work with us|jobs at)\b/i.test(h1Text)) {
            title = h1Text;
        }
    }

    // Fallback to <title>
    if (!title) {
        const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
        if (titleMatch) {
            const rawTitle = stripHtmlTags(titleMatch[1]);
            // Often "Senior Software Engineer - Company Name" or "Company | Job Title"
            const parts = rawTitle.split(/[-–—|•]/);
            if (parts.length > 1) {
                // Heuristic: usually the first or longest non-company part is the title
                title = parts[0].trim();
            } else {
                title = rawTitle;
            }
        }
    }

    // 2. Description Extraction
    let description = null;

    // Try <meta name="description"> or <meta property="og:description">
    const metaDescMatch = /<meta\b[^>]*(?:name|property)=["'](?:description|og:description)["'][^>]*content=["']([^"']+)["']/i.exec(html);
    if (metaDescMatch) {
        description = stripHtmlTags(metaDescMatch[1]);
    }

    // Fallback: look for <main>, <article>, or job-description container
    if (!description || description.length < 50) {
        const bodyContent = html
            .replace(/<header\b[^<]*(?:(?!<\/header>)<[^<]*)*<\/header>/gi, '')
            .replace(/<footer\b[^<]*(?:(?!<\/footer>)<[^<]*)*<\/footer>/gi, '')
            .replace(/<nav\b[^<]*(?:(?!<\/nav>)<[^<]*)*<\/nav>/gi, '');
        const plainBody = stripHtmlTags(bodyContent);
        if (plainBody.length > 100) {
            description = plainBody.slice(0, 1500); // capped excerpt
        }
    }

    // Validation: Is this a genuine job detail page or just a hub/listing?
    const hasApplyButton = /<a\b[^>]*\b(?:href|class|id)=["'][^"']*(?:apply|submit)[^"']*["']/i.test(html) ||
        /\b(apply for this job|apply now|submit application)\b/i.test(html);

    const isJobPosting = Boolean(title && (hasApplyButton || isCandidateJobUrl(pageUrl)));

    return {
        isJobPosting,
        title: title || 'Untitled Opportunity',
        description: description || '',
        confidence: isJobPosting ? 0.6 : 0.2,
        extraction_method: 'html_fallback',
        needs_review: true // HTML fallbacks always flagged for candidate review
    };
}
