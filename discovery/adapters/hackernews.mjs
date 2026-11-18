/**
 * discovery/adapters/hackernews.mjs — Hacker News "Who is Hiring" Discovery Connector
 *
 * Uses official public HN endpoints:
 *   - HN Algolia API (`hn.algolia.com/api/v1`) for monthly thread discovery & batched item trees
 *   - HN Firebase API (`hacker-news.firebaseio.com/v0`) as fallback & item fetching
 *
 * Conservative ingestion design:
 *   - Processes top-level comments only (ignores discussion replies, deleted/dead items, and non-job chatter)
 *   - Strips personal emails / PII before storing descriptions or provenance
 *   - Preserves HN comment permalink (`https://news.ycombinator.com/item?id=<id>`) and explicit apply URLs
 *   - Resolves employers via `company-resolver.mjs`, stores lead provenance in `source_leads`,
 *     inserts new postings as `'discovered'`, and checks `findCrossSourceDuplicates()`
 */

import { createHash } from 'node:crypto';
import { createNormalizedJob, detectRemoteType, detectEmploymentType, fetchWithRetry } from './base.mjs';
import { fetchGreenhouseJobs } from './greenhouse.mjs';
import { fetchLeverJobs } from './lever.mjs';
import { fetchAshbyJobs } from './ashby.mjs';
import { fetchWorkdayJobs } from './workday.mjs';
import { fetchSmartRecruitersJobs } from './smartrecruiters.mjs';
import { fetchWorkableJobs, extractAccount as extractWorkableAccount } from './workable.mjs';
import { fetchRecruiteeJobs, extractCompany as extractRecruiteeCompany } from './recruitee.mjs';
import {
    getLeadByCanonicalUrl,
    getObservationsForLead,
    ingestSearchLead,
    resolveLead,
    upsertJobPosting,
    findCrossSourceDuplicates,
    createSourceScan,
    updateSourceScan,
    getCompany,
    createCompany,
    updateCompany,
    getSourcePolicy,
    isSourcePermitted,
    claimAtsValidationScan
} from '../../db/repo.mjs';
import {
    resolveCompanyIdentity,
    registerCompanyCareerSurface,
    extractOfficialDomain,
    isValidEmployerName,
    normalizeCompanyName
} from '../leads/company-resolver.mjs';

export const HN_ALGOLIA_BASE = 'https://hn.algolia.com/api/v1';
export const HN_FIREBASE_BASE = 'https://hacker-news.firebaseio.com/v0';
export const HN_ITEM_URL = (id) => `https://news.ycombinator.com/item?id=${id}`;
export const HN_FEED_COMPANY_ID = 'feed-hackernews-whoishiring';

const TECH_STACK_TERMS = [
    'TypeScript', 'JavaScript', 'Python', 'Go', 'Golang', 'Rust', 'Java', 'Kotlin', 'Scala',
    'C++', 'C#', 'Ruby', 'Elixir', 'Clojure', 'Swift', 'React', 'Next.js', 'Vue', 'Angular',
    'Node.js', 'Django', 'FastAPI', 'Flask', 'Rails', 'Spring', 'PostgreSQL', 'Postgres',
    'MySQL', 'SQLite', 'MongoDB', 'Redis', 'Kafka', 'Kubernetes', 'Docker', 'AWS', 'GCP',
    'Azure', 'Terraform', 'GraphQL', 'gRPC', 'PyTorch', 'TensorFlow', 'LLM', 'RAG'
];

const ROLE_PATTERNS = [
    /\b(?:founding|staff|principal|lead|senior|sr\.?|junior|jr\.?|mid[- ]level|associate)?\s*(?:software|backend|back-end|frontend|front-end|full[- ]?stack|fullstack|platform|infrastructure|infra|systems?|distributed systems?|data|ml|machine learning|ai|applied ai|devops|sre|site reliability|security|mobile|ios|android|embedded|firmware|robotics|product|solutions?|growth|cloud)\s+(?:engineer(?:ing)?|developer|architect|scientist|lead)\b/i,
    /\b(?:swe|sde(?:\s*(?:i|ii|iii|1|2|3))?|sre|devops|eng(?:ineer)?(?:\s*\([^)]+\))?|tech(?:nical)?\s+lead|engineering\s+manager|vp\s+of\s+engineering|cto|head\s+of\s+engineering)\b/i,
    /\b(?:product\s+designer|ux\s+designer|ui\/ux|product\s+manager|technical\s+product\s+manager)\b/i
];

const NON_JOB_PATTERNS = [
    /^\s*(?:for\s+hire|seeking\s+(?:work|role|employment|opportunities)|looking\s+for\s+(?:work|a\s+job|my\s+next\s+role))\b/i,
    /^\s*(?:mods?|meta|question|psa|note|reminder|fyi)\s*:/i,
    /^\s*(?:is\s+anyone|anyone\s+hiring|how\s+(?:do|can)\s+i|where\s+are\s+the)\b/i,
    /^\s*\[?\s*who\s+wants\s+to\s+be\s+hired/i
];

/**
 * Decode common HTML entities and preserve structural newlines from HN comment HTML.
 */
export function decodeHtmlEntities(input) {
    if (!input || typeof input !== 'string') return '';
    return input
        .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&nbsp;/g, ' ');
}

/**
 * Redact email addresses (and mailto: references) so personal recruiter PII is never persisted.
 */
export function redactEmails(text) {
    if (!text || typeof text !== 'string') return '';
    return text
        .replace(/mailto:[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-mailto]')
        .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]');
}

/**
 * Convert HN comment HTML into clean plain lines and extract safe external URLs.
 */
export function extractHnCommentContent(htmlOrText) {
    if (!htmlOrText || typeof htmlOrText !== 'string') {
        return { text: '', lines: [], urls: [] };
    }

    const urls = [];
    const seenUrls = new Set();
    const recordUrl = (raw) => {
        if (!raw || typeof raw !== 'string') return;
        const cleaned = decodeHtmlEntities(raw).trim().replace(/[),.;]+$/, '');
        if (!/^https?:\/\//i.test(cleaned)) return;
        if (cleaned.includes('@') && cleaned.toLowerCase().startsWith('mailto:')) return;
        if (!seenUrls.has(cleaned)) {
            seenUrls.add(cleaned);
            urls.push(cleaned);
        }
    };

    // Extract hrefs first (HN truncates link anchor text with "...", href holds the real URL)
    const withHrefMarkers = htmlOrText.replace(
        /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
        (_, href, label) => {
            recordUrl(href);
            const cleanHref = decodeHtmlEntities(href).trim();
            const cleanLabel = decodeHtmlEntities(label.replace(/<[^>]+>/g, '')).trim();
            if (/^https?:\/\//i.test(cleanHref) && cleanLabel.includes('...')) {
                return ` ${cleanHref} `;
            }
            return ` ${cleanLabel || cleanHref} `;
        }
    );

    const textWithBreaks = decodeHtmlEntities(
        withHrefMarkers
            .replace(/<p\b[^>]*>/gi, '\n')
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<[^>]+>/g, ' ')
    );

    // Also find bare plain-text URLs
    const urlMatches = textWithBreaks.match(/https?:\/\/[^\s<>"'\]]+/gi) || [];
    for (const u of urlMatches) {
        recordUrl(u);
    }

    const sanitizedText = redactEmails(textWithBreaks)
        .split('\n')
        .map(line => line.replace(/[ \t]+/g, ' ').trim())
        .filter(Boolean)
        .join('\n');

    const lines = sanitizedText.split('\n').filter(Boolean);
    return { text: sanitizedText, lines, urls };
}

/**
 * Detect known ATS board / posting URLs from extracted HN URLs.
 */
export function classifyHnUrls(urls = []) {
    let atsType = null;
    let boardIdentifier = null;
    let atsUrl = null;
    let specificJobUrl = null;
    let careersUrl = null;
    let companyWebsite = null;

    for (const rawUrl of urls) {
        let u;
        try {
            u = new URL(rawUrl);
        } catch {
            continue;
        }
        const host = u.hostname.toLowerCase();
        const pathParts = u.pathname.split('/').filter(Boolean);

        if (host.includes('news.ycombinator.com')) continue;

        // Greenhouse
        if (host === 'boards.greenhouse.io' || host === 'job-boards.greenhouse.io' || host === 'job-boards.eu.greenhouse.io') {
            atsType = 'greenhouse';
            boardIdentifier = pathParts[0] || null;
            atsUrl = rawUrl;
            if (pathParts.includes('jobs') && pathParts.length >= 3) {
                specificJobUrl = rawUrl;
            }
            continue;
        }
        // Lever
        if (host === 'jobs.lever.co' || host === 'jobs.eu.lever.co') {
            atsType = 'lever';
            boardIdentifier = pathParts[0] || null;
            atsUrl = rawUrl;
            if (pathParts.length >= 2 && pathParts[1].length >= 8) {
                specificJobUrl = rawUrl;
            }
            continue;
        }
        // Ashby
        if (host === 'jobs.ashbyhq.com') {
            atsType = 'ashby';
            boardIdentifier = pathParts[0] || null;
            atsUrl = rawUrl;
            if (pathParts.length >= 2) {
                specificJobUrl = rawUrl;
            }
            continue;
        }
        // Workday
        if (host.endsWith('.myworkdayjobs.com') || host.endsWith('.myworkdaysite.com')) {
            atsType = 'workday';
            boardIdentifier = rawUrl;
            atsUrl = rawUrl;
            if (u.pathname.includes('/job/')) {
                specificJobUrl = rawUrl;
            }
            continue;
        }
        // SmartRecruiters
        if (host === 'jobs.smartrecruiters.com') {
            atsType = 'smartrecruiters';
            boardIdentifier = pathParts[0] || null;
            atsUrl = rawUrl;
            if (pathParts.length >= 2) {
                specificJobUrl = rawUrl;
            }
            continue;
        }
        // Workable
        if (host === 'apply.workable.com') {
            const account = extractWorkableAccount(rawUrl);
            if (account) {
                atsType = 'workable';
                boardIdentifier = account;
                atsUrl = `https://apply.workable.com/${account}`;
                if (pathParts.includes('j') && pathParts.length >= 3) {
                    specificJobUrl = rawUrl;
                }
                continue;
            }
        }
        // Recruitee
        if (host.endsWith('.recruitee.com')) {
            const slug = extractRecruiteeCompany(rawUrl);
            if (slug) {
                atsType = 'recruitee';
                boardIdentifier = slug;
                atsUrl = `https://${slug}.recruitee.com`;
                if (pathParts[0] === 'o' && pathParts.length >= 2) {
                    specificJobUrl = rawUrl;
                }
                continue;
            }
        }
        // Hosted job boards outside our ATS API adapters (specific vacancy URL only, no fake atsType)
        if (
            (host === 'jobs.gem.com' && pathParts.length >= 2) ||
            (host === 'jobs.rippling.com' && pathParts.includes('jobs') && pathParts.length >= 3) ||
            (host === 'app.dover.com' && pathParts.length >= 3) ||
            (host === 'wellfound.com' && pathParts[0] === 'jobs' && pathParts.length >= 2)
        ) {
            specificJobUrl = specificJobUrl || rawUrl;
            careersUrl = careersUrl || rawUrl;
            continue;
        }
        // Y Combinator jobs (official profile / jobs subpage, NOT login-gated actions)
        if (host === 'www.ycombinator.com' || host === 'ycombinator.com') {
            if (u.pathname.startsWith('/companies/') && u.pathname.includes('/jobs/')) {
                specificJobUrl = specificJobUrl || rawUrl;
            } else if (u.pathname.startsWith('/companies/')) {
                careersUrl = careersUrl || rawUrl;
            }
            continue;
        }

        const officialDom = extractOfficialDomain(rawUrl);
        const isJobSubdomain = /^(?:jobs|careers)\./i.test(host);
        if (/\/(?:careers|jobs|hiring|openings|join|work-with-us)/i.test(u.pathname) || isJobSubdomain || u.searchParams.has('gh_jid')) {
            careersUrl = careersUrl || rawUrl;
            if (
                u.searchParams.has('gh_jid') ||
                /\/(?:jobs|careers|positions|openings|roles)\/[a-z0-9_-]{2,}/i.test(u.pathname) ||
                (isJobSubdomain && pathParts.length >= 1 && !/^(?:jobs|careers|openings|en|home|about)?$/i.test(pathParts[0]))
            ) {
                specificJobUrl = specificJobUrl || rawUrl;
            }
        }
        if (officialDom && !companyWebsite) {
            companyWebsite = `${u.protocol}//${u.hostname}`;
        }
    }

    return {
        atsType,
        boardIdentifier,
        atsUrl,
        specificJobUrl,
        careersUrl,
        companyWebsite
    };
}

function extractTechStack(text) {
    const found = [];
    for (const term of TECH_STACK_TERMS) {
        const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, 'i');
        if (re.test(text)) {
            found.push(term);
        }
    }
    return found;
}

function extractCompensation(text) {
    const match = text.match(
        /(?:[$€£₹]\s?\d{2,3}(?:,\d{3}|\.\d+)?\s*[kKmM]?(?:\s*[-–—to]+\s*[$€£₹]?\s?\d{2,3}(?:,\d{3}|\.\d+)?\s*[kKmM]?)?(?:\s*(?:USD|EUR|GBP|INR|CTC|base|salary|TC|\+\s*equity))?)/i
    );
    return match ? match[0].trim() : null;
}

function extractApplicantEligibility(text) {
    const cues = [];
    const patterns = [
        /\b(?:US|USA|United States|UK|EU|Europe|Canada|India|APAC)\s*(?:only|residents?|work\s+auth(?:orization)?)\b/i,
        /\b(?:visa\s+sponsorship(?:\s+available)?|no\s+visa(?:\s+sponsorship)?|h1b(?:\s+transfer)?)\b/i,
        /\b(?:authorized\s+to\s+work\s+in\s+[A-Za-z\s]{2,20})\b/i,
        /\b(?:UTC[+-]\d{1,2}(?:\s*to\s*UTC[+-]\d{1,2})?|(?:EST|PST|CET|IST)\s+timezone\s*(?:overlap|only)?)\b/i
    ];
    for (const re of patterns) {
        const m = text.match(re);
        if (m) cues.push(m[0].trim());
    }
    return cues.length > 0 ? Array.from(new Set(cues)).join('; ') : null;
}

function extractExperience(text) {
    const m = text.match(/\b(\d+\+?\s*(?:-\s*\d+\s*)?years?(?:\s+of\s+experience)?|new\s+grad|entry[- ]level|senior|staff|principal)\b/i);
    return m ? m[0].trim() : null;
}

function looksLikeLocationSegment(seg) {
    if (!seg || seg.length > 80) return false;
    return /\b(?:remote|hybrid|onsite|on-site|in-person|san francisco|sf|nyc|new york|london|berlin|bengaluru|bangalore|mumbai|hyderabad|delhi|india|austin|seattle|boston|toronto|usa?|uk|eu|europe|singapore|global|worldwide|pst|est|cet|utc)\b/i.test(seg);
}

function looksLikeUrlOnlySegment(seg) {
    return /^https?:\/\/\S+$/i.test(seg.trim());
}

function cleanCompanySegment(seg) {
    if (!seg) return '';
    let s = seg
        .replace(/\(\s*https?:\/\/[^)]+\s*\)/gi, ' ')
        .replace(/https?:\/\/\S+/gi, ' ')
        .replace(/\(\s*(?:YC\s+[WSFX]\d{2}|[WSFX]\d{2})\s*\)/gi, ' ')
        .trim();
    // Handle "Company - Role" when pipes aren't used
    return normalizeCompanyName(s);
}

function findRoleInText(text) {
    for (const pat of ROLE_PATTERNS) {
        const m = text.match(pat);
        if (m) {
            return m[0].replace(/\s+/g, ' ').trim();
        }
    }
    return null;
}

/**
 * Conservatively parse an HN comment into a structured hiring extraction or reject cleanly.
 *
 * @param {object} comment Raw HN comment item (`id`, `parent`, `text`, `time`, `by`, `deleted`, `dead`)
 * @param {object} threadMeta `{ threadId, title, threadUrl, threadTime }`
 */
export function parseHnHiringComment(comment, threadMeta = {}) {
    if (!comment || typeof comment !== 'object' || !comment.id) {
        return { valid: false, rejectReason: 'invalid_comment_object' };
    }
    if (comment.deleted || comment.dead) {
        return { valid: false, rejectReason: 'deleted_or_dead' };
    }
    if (threadMeta.threadId && comment.parent && Number(comment.parent) !== Number(threadMeta.threadId)) {
        return { valid: false, rejectReason: 'discussion_reply' };
    }

    const permalink = HN_ITEM_URL(comment.id);
    const { text, lines, urls } = extractHnCommentContent(comment.text || '');
    if (!text || text.length < 25 || lines.length === 0) {
        return { valid: false, rejectReason: 'empty_or_too_short', permalink };
    }

    for (const pat of NON_JOB_PATTERNS) {
        if (pat.test(text)) {
            return { valid: false, rejectReason: 'non_hiring_comment', permalink };
        }
    }

    const firstLine = lines[0];
    const urlInfo = classifyHnUrls(urls);

    let companyName = null;
    let roleTitle = null;
    let location = null;
    let remoteHint = '';
    let employmentHint = '';
    let compensation = extractCompensation(text);
    const eligibility = extractApplicantEligibility(text);
    const experience = extractExperience(text);
    const techStack = extractTechStack(text);

    const ycMatch = text.match(/\bYC\s+([WSFX]\d{2})\b/i);
    const ycBatch = ycMatch ? ycMatch[1].toUpperCase() : null;

    // Strategy 1: Standard pipe-separated HN Who is Hiring header (`Company | Role | Location | ...`)
    if (firstLine.includes('|')) {
        const segments = firstLine.split('|').map(s => s.trim()).filter(Boolean);
        if (segments.length >= 2) {
            const candidateComp = cleanCompanySegment(segments[0]);
            if (isValidEmployerName(candidateComp) && candidateComp.length <= 80) {
                companyName = candidateComp;
            }
            for (let i = 1; i < segments.length; i++) {
                const seg = segments[i];
                if (looksLikeUrlOnlySegment(seg)) continue;
                const roleMatch = findRoleInText(seg);
                if (!roleTitle && (roleMatch || (!looksLikeLocationSegment(seg) && i === 1 && !/^[$€£₹]/.test(seg) && !/^full[- ]?time|part[- ]?time|contract|intern|onsite|remote|hybrid$/i.test(seg)))) {
                    roleTitle = (roleMatch || seg).replace(/https?:\/\/\S+/g, '').trim();
                    continue;
                }
                if (looksLikeLocationSegment(seg)) {
                    remoteHint = `${remoteHint} ${seg}`.trim();
                    if (!/^(?:remote|onsite|on-site|hybrid)$/i.test(seg)) {
                        location = location ? `${location}; ${seg}` : seg;
                    } else if (!location && /^remote$/i.test(seg)) {
                        location = 'Remote';
                    }
                    continue;
                }
                if (/\b(?:full[- ]?time|part[- ]?time|contract|internship|intern)\b/i.test(seg)) {
                    employmentHint = `${employmentHint} ${seg}`.trim();
                }
                if (!compensation && /^[$€£₹]/.test(seg)) {
                    compensation = seg;
                }
            }
        }
    }

    // Strategy 2: Dash or parens header (`Company (Location) - Role` or `Company is hiring ...`)
    if (!companyName) {
        const dashParts = firstLine.split(/\s+[—–-]\s+/).map(s => s.trim()).filter(Boolean);
        if (dashParts.length >= 2) {
            const candidateComp = cleanCompanySegment(dashParts[0]);
            if (isValidEmployerName(candidateComp) && candidateComp.length <= 60 && !/[.!?]$/.test(candidateComp)) {
                companyName = candidateComp;
                if (!roleTitle) {
                    roleTitle = findRoleInText(dashParts.slice(1).join(' - '));
                }
                if (!location && dashParts.find(looksLikeLocationSegment)) {
                    location = dashParts.find(looksLikeLocationSegment);
                }
            }
        }
    }

    // Strategy 3: "CompanyName is hiring ..." or bulleted roles in body
    if (!companyName) {
        const isHiringMatch = firstLine.match(/^([A-Z][A-Za-z0-9.&' -]{1,50}?)\s+(?:is\s+hiring|are\s+hiring)\b/i);
        if (isHiringMatch && isValidEmployerName(isHiringMatch[1])) {
            companyName = cleanCompanySegment(isHiringMatch[1]);
        }
    }

    if (!roleTitle) {
        roleTitle = findRoleInText(text);
    }

    // Reject conversational/reply text that happens to mention tech words without a company + hiring context
    const hasHiringContext = /\b(?:hiring|openings?|role|roles|position|positions|apply|engineer|developer|designer|manager|careers|jobs)\b/i.test(text);
    if (!hasHiringContext) {
        return { valid: false, rejectReason: 'no_hiring_context', permalink };
    }
    if (!companyName || !isValidEmployerName(companyName)) {
        return { valid: false, rejectReason: 'no_company_detected', permalink };
    }
    if (/^(?:i|we|they|this|that|there|here|anyone|someone|why|how|what)\b/i.test(companyName) && !firstLine.includes('|')) {
        return { valid: false, rejectReason: 'conversational_comment', permalink };
    }
    if (!roleTitle || roleTitle.length < 3 || roleTitle.length > 140) {
        return { valid: false, rejectReason: 'no_role_detected', permalink, companyName };
    }

    // Secondary location scan across full text if header omitted it
    if (!location) {
        const locCue = text.match(/(?:Location|Based in|Office in)\s*:\s*([^\n|]{2,60})/i);
        if (locCue) {
            location = locCue[1].trim();
        }
    }

    const remoteType = detectRemoteType(roleTitle, location || '', `${remoteHint} ${firstLine}`);
    const employmentType = detectEmploymentType(roleTitle, employmentHint, text.slice(0, 350));

    const applicationUrl = urlInfo.specificJobUrl || urlInfo.atsUrl || urlInfo.careersUrl || null;
    const canonicalJobUrl = urlInfo.specificJobUrl || permalink;
    const officialDomain = extractOfficialDomain(urlInfo.companyWebsite || urlInfo.careersUrl || '');
    const commentIsoTime = comment.time ? new Date(comment.time * 1000).toISOString() : (threadMeta.createdAt || null);

    return {
        valid: true,
        commentId: String(comment.id),
        permalink,
        canonicalJobUrl,
        applicationUrl,
        specificJobUrl: urlInfo.specificJobUrl || null,
        companyName,
        ycBatch,
        officialDomain,
        companyWebsite: urlInfo.companyWebsite,
        careersUrl: urlInfo.careersUrl,
        atsType: urlInfo.atsType,
        boardIdentifier: urlInfo.boardIdentifier,
        atsUrl: urlInfo.atsUrl,
        roleTitle: roleTitle.replace(/\s+/g, ' ').trim(),
        location: location || (remoteType === 'remote' ? 'Remote' : null),
        remoteType,
        applicantEligibility: eligibility,
        employmentType,
        experience,
        compensation,
        techStack,
        postedAt: commentIsoTime,
        description: text,
        rawUrls: urls.filter(u => !u.startsWith('mailto:'))
    };
}

/**
 * Compute deterministic content hash for a thread's top-level comment IDs and timestamps.
 */
export function computeHnThreadHash(comments = []) {
    const normalized = comments
        .filter(c => c && c.id)
        .map(c => `${c.id}:${c.time || 0}:${c.deleted ? 1 : 0}:${c.dead ? 1 : 0}`)
        .sort()
        .join('|');
    return createHash('sha256').update(normalized).digest('hex');
}

/**
 * Discover recent monthly "Ask HN: Who is hiring?" threads.
 * Uses HN Algolia API first and falls back to HN Firebase `user/whoishiring`.
 */
export async function discoverHnHiringThreads({
    limit = 2,
    maxAgeDays = 95,
    fetchFn = fetch,
    timeoutMs = 10000
} = {}) {
    const cutoffEpochSec = Math.floor(Date.now() / 1000) - (maxAgeDays * 86400);
    const threads = [];

    // Primary: HN Algolia date-sorted search
    try {
        const algoliaUrl = `${HN_ALGOLIA_BASE}/search_by_date?tags=story,author_whoishiring&hitsPerPage=15`;
        const res = await fetchWithRetry(algoliaUrl, {
            headers: { 'User-Agent': 'CareerOps/1.0 (+job-discovery)' }
        }, { retries: 1, timeoutMs, fetchFn });
        if (res.ok) {
            const data = await res.json();
            const hits = Array.isArray(data?.hits) ? data.hits : [];
            for (const hit of hits) {
                const title = hit.title || '';
                if (!/who\s+is\s+hiring\?/i.test(title)) continue;
                const createdSec = Number(hit.created_at_i || 0);
                if (maxAgeDays && createdSec && createdSec < cutoffEpochSec) continue;
                const threadId = Number(hit.objectID || hit.story_id);
                if (!Number.isFinite(threadId)) continue;
                threads.push({
                    threadId,
                    title,
                    createdAt: createdSec ? new Date(createdSec * 1000).toISOString() : (hit.created_at || null),
                    createdAtSec: createdSec,
                    commentCount: Number(hit.num_comments || 0),
                    threadUrl: HN_ITEM_URL(threadId),
                    via: 'algolia'
                });
            }
        }
    } catch {
        // Fallback below
    }

    // Fallback: HN Firebase API (`user/whoishiring`)
    if (threads.length === 0) {
        const userRes = await fetchWithRetry(`${HN_FIREBASE_BASE}/user/whoishiring.json`, {}, {
            retries: 1, timeoutMs, fetchFn
        });
        if (!userRes.ok) {
            throw new Error(`HN Firebase user lookup failed: HTTP ${userRes.status}`);
        }
        const userJson = await userRes.json();
        const submitted = Array.isArray(userJson?.submitted) ? userJson.submitted.slice(0, 15) : [];
        for (const itemId of submitted) {
            try {
                const itemRes = await fetchWithRetry(`${HN_FIREBASE_BASE}/item/${itemId}.json`, {}, {
                    retries: 1, timeoutMs, fetchFn
                });
                if (!itemRes.ok) continue;
                const item = await itemRes.json();
                if (!item || item.deleted || item.dead) continue;
                if (!/who\s+is\s+hiring\?/i.test(item.title || '')) continue;
                const createdSec = Number(item.time || 0);
                if (maxAgeDays && createdSec && createdSec < cutoffEpochSec) continue;
                threads.push({
                    threadId: Number(item.id),
                    title: item.title,
                    createdAt: createdSec ? new Date(createdSec * 1000).toISOString() : null,
                    createdAtSec: createdSec,
                    commentCount: Array.isArray(item.kids) ? item.kids.length : 0,
                    kids: Array.isArray(item.kids) ? item.kids : [],
                    threadUrl: HN_ITEM_URL(item.id),
                    via: 'firebase'
                });
            } catch {
                // Skip individual failed item
            }
            if (threads.length >= limit) break;
        }
    }

    threads.sort((a, b) => (b.createdAtSec || 0) - (a.createdAtSec || 0));
    return threads.slice(0, limit);
}

/**
 * Fetch top-level comments for an HN Who is Hiring thread.
 * Prefers Algolia `/items/:id` (single HTTP request for tree), falls back to Firebase `/item/:id`.
 */
export async function fetchHnThreadComments(thread, {
    maxComments = 100,
    concurrency = 6,
    fetchFn = fetch,
    timeoutMs = 10000
} = {}) {
    const threadId = typeof thread === 'object' ? Number(thread.threadId || thread.id) : Number(thread);
    if (!Number.isFinite(threadId)) {
        throw new Error('Invalid HN thread ID');
    }

    // Primary: Algolia full item tree
    try {
        const res = await fetchWithRetry(`${HN_ALGOLIA_BASE}/items/${threadId}`, {
            headers: { 'User-Agent': 'CareerOps/1.0 (+job-discovery)' }
        }, { retries: 1, timeoutMs, fetchFn });
        if (res.ok) {
            const tree = await res.json();
            const children = Array.isArray(tree?.children) ? tree.children : [];
            const topLevel = children
                .slice(0, maxComments)
                .map(c => ({
                    id: Number(c.id),
                    parent: Number(c.parent_id || threadId),
                    by: c.author || null,
                    time: Number(c.created_at_i || 0),
                    text: c.text || '',
                    type: c.type || 'comment',
                    deleted: Boolean(c.deleted),
                    dead: Boolean(c.dead)
                }));
            if (topLevel.length > 0 || (Array.isArray(tree?.children) && !Array.isArray(thread?.kids))) {
                return {
                    threadId,
                    title: tree?.title || thread?.title || `HN Thread ${threadId}`,
                    createdAt: tree?.created_at || thread?.createdAt || null,
                    comments: topLevel,
                    via: 'algolia'
                };
            }
        }
    } catch {
        // Fallback to Firebase below
    }

    // Fallback: HN Firebase thread + top-level kids
    let kidIds = Array.isArray(thread?.kids) ? [...thread.kids] : null;
    let title = thread?.title || null;
    let createdAt = thread?.createdAt || null;

    if (!kidIds) {
        const storyRes = await fetchWithRetry(`${HN_FIREBASE_BASE}/item/${threadId}.json`, {}, {
            retries: 1, timeoutMs, fetchFn
        });
        if (!storyRes.ok) {
            throw new Error(`HN Firebase thread ${threadId} fetch failed: HTTP ${storyRes.status}`);
        }
        const story = await storyRes.json();
        kidIds = Array.isArray(story?.kids) ? story.kids : [];
        title = story?.title || title;
        createdAt = story?.time ? new Date(story.time * 1000).toISOString() : createdAt;
    }

    const targetIds = kidIds.slice(0, maxComments);
    const comments = [];
    for (let i = 0; i < targetIds.length; i += concurrency) {
        const batch = targetIds.slice(i, i + concurrency);
        const fetched = await Promise.all(batch.map(async (id) => {
            try {
                const r = await fetchWithRetry(`${HN_FIREBASE_BASE}/item/${id}.json`, {}, {
                    retries: 1, timeoutMs, fetchFn
                });
                if (!r.ok) return null;
                return await r.json();
            } catch {
                return null;
            }
        }));
        for (const item of fetched) {
            if (item && item.id) comments.push(item);
        }
    }

    return {
        threadId,
        title: title || `HN Thread ${threadId}`,
        createdAt,
        comments,
        via: 'firebase'
    };
}

function ensureHnAggregatorCompany() {
    let comp = getCompany(HN_FEED_COMPANY_ID);
    if (!comp) {
        createCompany({
            id: HN_FEED_COMPANY_ID,
            name: 'Hacker News (Who is Hiring)',
            domain: 'news.ycombinator.com',
            website_url: 'https://news.ycombinator.com/submitted?id=whoishiring',
            source_provenance: 'hackernews_connector',
            lifecycle_status: 'MONITORING',
            monitoring_status: 'active',
            policy_status: 'permitted',
            notes: 'Public Hacker News Who is Hiring monthly threads via official Algolia/Firebase APIs'
        });
        comp = getCompany(HN_FEED_COMPANY_ID);
    }
    return comp;
}

function getPreviousThreadHash(threadUrl) {
    const existingLead = getLeadByCanonicalUrl(threadUrl);
    if (!existingLead) return null;
    const obs = getObservationsForLead(existingLead.id);
    for (const row of obs) {
        if (row.provider === 'hackernews:thread' && row.provider_payload_json) {
            try {
                const payload = JSON.parse(row.provider_payload_json);
                if (payload?.threadHash) return payload.threadHash;
            } catch {
                // Ignore malformed historical payload
            }
        }
    }
    return null;
}

async function scanHnDiscoveredAtsBoard(board, { fetchFn = fetch, timeoutMs = 10000 } = {}) {
    const opts = { fetchFn, timeoutMs };
    let res;
    switch (board.atsType) {
        case 'greenhouse':
            res = await fetchGreenhouseJobs(board.boardIdentifier, board.companyId, board.companyName, opts);
            break;
        case 'lever':
            res = await fetchLeverJobs(board.boardIdentifier, board.companyId, board.companyName, opts);
            break;
        case 'ashby':
            res = await fetchAshbyJobs(board.boardIdentifier, board.companyId, board.companyName, opts);
            break;
        case 'workday':
            res = await fetchWorkdayJobs(board.boardIdentifier, board.companyId, board.companyName, opts);
            break;
        case 'smartrecruiters':
            res = await fetchSmartRecruitersJobs(board.boardIdentifier, board.companyId, board.companyName, opts);
            break;
        case 'workable':
            res = await fetchWorkableJobs(board.boardIdentifier, board.companyId, board.companyName, opts);
            break;
        case 'recruitee':
            res = await fetchRecruiteeJobs(board.boardIdentifier, board.companyId, board.companyName, opts);
            break;
        default:
            return { jobs: [], error: `Unsupported ATS provider: ${board.atsType}` };
    }
    const jobs = Array.isArray(res?.jobs) ? res.jobs : [];
    return {
        jobs,
        fetchedCount: res?.fetchedCount ?? jobs.length,
        normalizedCount: res?.normalizedCount ?? jobs.length,
        invalidCount: res?.invalidCount ?? 0,
        duplicateInSourceCount: res?.duplicateInSourceCount ?? 0,
        error: res?.error || null
    };
}

/**
 * Run end-to-end Hacker News Hiring discovery:
 * discover threads -> hash check -> fetch top-level comments -> conservative parse ->
 * company resolution + ATS/career surface registration -> `source_leads` + `job_postings` (`discovered`).
 */
export async function fetchHackerNewsHiringJobs({
    maxThreads = 1,
    maxComments = 100,
    maxAgeDays = 95,
    threadId = null,
    forceRescan = false,
    dryRun = false,
    createMissingCompanies = true,
    scanDiscoveredAts = true,
    fetchFn = fetch,
    timeoutMs = 10000
} = {}) {
    let scanId = null;
    if (!dryRun) {
        ensureHnAggregatorCompany();
        scanId = createSourceScan({
            company_id: HN_FEED_COMPANY_ID,
            source_type: 'hackernews',
            started_at: new Date().toISOString()
        });
    }

    const summary = {
        threadsDiscovered: 0,
        threadsScanned: 0,
        threadsSkippedCached: 0,
        commentsInspected: 0,
        commentsParsed: 0,
        commentsRejected: 0,
        rejectReasons: {},
        leadsCreated: 0,
        jobsInserted: 0,
        jobsUpdated: 0,
        jobsUnchanged: 0,
        crossSourceDuplicates: 0,
        ambiguousCompanies: 0,
        atsBoardsDiscovered: 0,
        atsBoardsRegistered: 0,
        atsBoardsExisting: 0,
        atsBoardsScanned: 0,
        atsJobsFetched: 0,
        atsJobsInserted: 0,
        atsBoardDetails: [],
        jobs: [],
        errors: []
    };

    const discoveredBoardsMap = new Map();

    try {
        const threads = threadId
            ? [{ threadId: Number(threadId), title: `HN Thread ${threadId}`, threadUrl: HN_ITEM_URL(threadId) }]
            : await discoverHnHiringThreads({ limit: maxThreads, maxAgeDays, fetchFn, timeoutMs });

        summary.threadsDiscovered = threads.length;

        for (const thread of threads) {
            const threadData = await fetchHnThreadComments(thread, {
                maxComments,
                fetchFn,
                timeoutMs
            });
            const threadHash = computeHnThreadHash(threadData.comments);
            const threadUrl = HN_ITEM_URL(threadData.threadId);

            if (!dryRun && !forceRescan) {
                const prevHash = getPreviousThreadHash(threadUrl);
                if (prevHash && prevHash === threadHash) {
                    summary.threadsSkippedCached++;
                    continue;
                }
            }

            summary.threadsScanned++;

            for (const comment of threadData.comments) {
                summary.commentsInspected++;
                const parsed = parseHnHiringComment(comment, {
                    threadId: threadData.threadId,
                    title: threadData.title,
                    createdAt: threadData.createdAt
                });

                if (!parsed.valid) {
                    summary.commentsRejected++;
                    summary.rejectReasons[parsed.rejectReason] = (summary.rejectReasons[parsed.rejectReason] || 0) + 1;
                    continue;
                }

                summary.commentsParsed++;

                if (dryRun) {
                    summary.jobs.push(parsed);
                    continue;
                }

                // 1. Resolve employer conservatively using shared resolver
                const resolution = resolveCompanyIdentity({
                    name: parsed.companyName,
                    domain: parsed.officialDomain,
                    websiteUrl: parsed.companyWebsite,
                    atsType: parsed.atsType,
                    boardIdentifier: parsed.boardIdentifier,
                    createIfMissing: createMissingCompanies,
                    sourceProvenance: 'hackernews_whoishiring',
                    lifecycleStatus: 'UNVERIFIED',
                    monitoringStatus: 'paused',
                    notes: parsed.ycBatch ? `Discovered via HN Who is Hiring (YC ${parsed.ycBatch})` : 'Discovered via HN Who is Hiring'
                });

                // 2. Always record raw lead provenance in `source_leads` + `source_lead_observations`
                const leadRes = ingestSearchLead({
                    provider: 'hackernews',
                    query: `hn:thread:${threadData.threadId}`,
                    rawUrl: parsed.canonicalJobUrl,
                    title: `${parsed.companyName} - ${parsed.roleTitle}`,
                    snippet: parsed.description.slice(0, 400),
                    companyName: parsed.companyName,
                    companyId: resolution.companyId || null,
                    providerPayload: {
                        threadId: threadData.threadId,
                        threadTitle: threadData.title,
                        commentId: parsed.commentId,
                        permalink: parsed.permalink,
                        applicationUrl: parsed.applicationUrl,
                        atsType: parsed.atsType,
                        boardIdentifier: parsed.boardIdentifier,
                        compensation: parsed.compensation,
                        techStack: parsed.techStack,
                        ycBatch: parsed.ycBatch
                    }
                });

                if (leadRes.isNewLead) summary.leadsCreated++;

                // Leave ambiguous matches pending without creating bad employer/job links
                if (resolution.ambiguous || !resolution.companyId) {
                    if (resolution.ambiguous) {
                        summary.ambiguousCompanies++;
                        resolveLead(leadRes.leadId, {
                            resolutionStatus: 'pending',
                            notes: `Ambiguous company match from HN: ${resolution.reason || 'multiple candidates'}`
                        });
                    }
                    continue;
                }

                // Register discovered career surface / ATS board (respecting valid `source_policies.source_type`)
                if (parsed.atsType && parsed.boardIdentifier) {
                    summary.atsBoardsDiscovered++;
                    const boardKey = `${resolution.companyId}|${parsed.atsType}|${parsed.boardIdentifier}`;
                    const alreadyHadAts = Boolean(
                        !resolution.created &&
                        resolution.company?.ats_type &&
                        resolution.company.ats_type.toLowerCase() === parsed.atsType.toLowerCase() &&
                        resolution.company.board_identifier &&
                        resolution.company.board_identifier.toLowerCase() === parsed.boardIdentifier.toLowerCase()
                    );
                    if (!discoveredBoardsMap.has(boardKey)) {
                        if (alreadyHadAts) summary.atsBoardsExisting++;
                        else summary.atsBoardsRegistered++;
                    }

                    registerCompanyCareerSurface({
                        companyId: resolution.companyId,
                        careerUrl: parsed.careersUrl || parsed.atsUrl,
                        atsType: parsed.atsType,
                        boardIdentifier: parsed.boardIdentifier,
                        source: 'hackernews',
                        policySourceType: parsed.atsType,
                        policyEndpoint: parsed.atsUrl || `${parsed.atsType}:${parsed.boardIdentifier}`,
                        notes: 'ATS link extracted from HN Who is Hiring comment'
                    });

                    if (!discoveredBoardsMap.has(boardKey)) {
                        discoveredBoardsMap.set(boardKey, {
                            companyId: resolution.companyId,
                            companyName: resolution.company?.name || parsed.companyName,
                            atsType: parsed.atsType,
                            boardIdentifier: parsed.boardIdentifier,
                            atsUrl: parsed.atsUrl,
                            alreadyRegistered: alreadyHadAts,
                            newlyRegistered: !alreadyHadAts,
                            sourcePolicy: getSourcePolicy(resolution.companyId, parsed.atsType) || null
                        });
                    }
                } else if (parsed.careersUrl) {
                    registerCompanyCareerSurface({
                        companyId: resolution.companyId,
                        careerUrl: parsed.careersUrl,
                        source: 'hackernews',
                        policySourceType: 'custom',
                        policyEndpoint: parsed.careersUrl,
                        notes: 'Career page extracted from HN Who is Hiring comment'
                    });
                }

                // 3. Build normalized job posting (starts as 'discovered', never pre-verified active)
                const normalized = createNormalizedJob({
                    id: parsed.canonicalJobUrl,
                    company_id: resolution.companyId,
                    company_name: resolution.company?.name || parsed.companyName,
                    title: parsed.roleTitle,
                    location: parsed.location,
                    remote_type: parsed.remoteType,
                    applicant_eligibility: parsed.applicantEligibility,
                    employment_type: parsed.employmentType,
                    job_url: parsed.canonicalJobUrl,
                    description: parsed.description,
                    source: 'hackernews',
                    source_job_id: parsed.commentId,
                    source_updated_at: parsed.postedAt,
                    raw: {
                        permalink: parsed.permalink,
                        applicationUrl: parsed.applicationUrl,
                        specificJobUrl: parsed.specificJobUrl,
                        careersUrl: parsed.careersUrl,
                        atsType: parsed.atsType,
                        boardIdentifier: parsed.boardIdentifier,
                        compensation: parsed.compensation,
                        experience: parsed.experience,
                        techStack: parsed.techStack,
                        threadId: threadData.threadId,
                        threadTitle: threadData.title
                    }
                });

                const upsertRes = upsertJobPosting(normalized);
                if (upsertRes.status === 'inserted') summary.jobsInserted++;
                else if (upsertRes.status === 'updated') summary.jobsUpdated++;
                else summary.jobsUnchanged++;

                const dupIds = findCrossSourceDuplicates(normalized);
                if (dupIds.length > 0) {
                    summary.crossSourceDuplicates++;
                }

                resolveLead(leadRes.leadId, {
                    resolutionStatus: 'resolved_job',
                    resolvedJobId: normalized.id,
                    companyId: resolution.companyId,
                    notes: `Ingested from HN thread ${threadData.threadId} (comment ${parsed.commentId})`
                });

                summary.jobs.push(normalized);
            }

            // Record thread hash in SQLite via source_leads observation so redundant re-scans skip unchanged threads
            if (!dryRun) {
                const threadLead = ingestSearchLead({
                    provider: 'hackernews:thread',
                    query: 'hn:whoishiring:threads',
                    rawUrl: threadUrl,
                    title: threadData.title,
                    companyId: HN_FEED_COMPANY_ID,
                    providerPayload: {
                        threadId: threadData.threadId,
                        threadHash,
                        commentsInspected: threadData.comments.length,
                        scannedAt: new Date().toISOString()
                    }
                });
                resolveLead(threadLead.leadId, {
                    resolutionStatus: 'unresolvable',
                    companyId: HN_FEED_COMPANY_ID,
                    notes: `HN thread cache checkpoint, not a single job posting (hash=${threadHash.slice(0, 12)})`
                });
            }
        }

        // Scan discovered employer ATS boards via existing ATS adapters (validating & ingesting live roles)
        if (!dryRun && scanDiscoveredAts && discoveredBoardsMap.size > 0) {
            for (const board of discoveredBoardsMap.values()) {
                let boardDetail = {
                    companyId: board.companyId,
                    companyName: board.companyName,
                    atsType: board.atsType,
                    boardIdentifier: board.boardIdentifier,
                    registrationStatus: board.newlyRegistered ? 'newly_registered' : 'existing',
                    sourcePolicyEnabled: board.sourcePolicy ? Boolean(board.sourcePolicy.enabled) : false,
                    sourcePolicyType: board.sourcePolicy?.source_type || board.atsType,
                    scanStatus: 'FAILED',
                    lastSuccessfulScan: null,
                    jobsFetched: 0,
                    jobsInserted: 0,
                    error: null
                };

                const claim = claimAtsValidationScan(board.companyId, board.atsType, board.boardIdentifier);
                if (!claim.permitted) {
                    boardDetail.scanStatus = 'SKIPPED_POLICY';
                    boardDetail.error = claim.reason || 'ATS validation blocked by source policy or company lifecycle';
                    summary.atsBoardDetails.push(boardDetail);
                    continue;
                }

                const atsScanId = claim.scanId;

                try {
                    const atsRes = await scanHnDiscoveredAtsBoard(board, { fetchFn, timeoutMs });
                    const hasFatal = Boolean(atsRes.error) && atsRes.jobs.length === 0;
                    if (hasFatal) {
                        boardDetail.error = atsRes.error;
                        updateSourceScan(atsScanId, {
                            completed_at: new Date().toISOString(),
                            total_jobs: 0,
                            errors: 1,
                            is_complete: false,
                            error_details: atsRes.error
                        });
                    } else {
                        const completedAt = new Date().toISOString();
                        let atsInserted = 0;
                        let atsUpdated = 0;
                        let atsUnchanged = 0;
                        for (const atsJob of atsRes.jobs) {
                            const up = upsertJobPosting(atsJob);
                            if (up.status === 'inserted') {
                                atsInserted++;
                                summary.atsJobsInserted++;
                            } else if (up.status === 'updated') {
                                atsUpdated++;
                            } else {
                                atsUnchanged++;
                            }
                            const dupIds = findCrossSourceDuplicates(atsJob);
                            if (dupIds.length > 0) summary.crossSourceDuplicates++;
                        }
                        summary.atsBoardsScanned++;
                        summary.atsJobsFetched += atsRes.jobs.length;
                        updateCompany(board.companyId, { last_scanned_at: completedAt });
                        updateSourceScan(atsScanId, {
                            completed_at: completedAt,
                            total_jobs: atsRes.jobs.length,
                            new_jobs: atsInserted,
                            duplicate_jobs: atsUpdated + atsUnchanged,
                            fetched_count: atsRes.fetchedCount,
                            normalized_count: atsRes.normalizedCount,
                            inserted_count: atsInserted,
                            updated_count: atsUpdated,
                            unchanged_count: atsUnchanged,
                            invalid_count: atsRes.invalidCount,
                            is_complete: true
                        });
                        boardDetail.scanStatus = 'SUCCESS';
                        boardDetail.lastSuccessfulScan = completedAt;
                        boardDetail.jobsFetched = atsRes.jobs.length;
                        boardDetail.jobsInserted = atsInserted;
                    }
                } catch (err) {
                    boardDetail.error = err.message;
                    updateSourceScan(atsScanId, {
                        completed_at: new Date().toISOString(),
                        total_jobs: 0,
                        errors: 1,
                        is_complete: false,
                        error_details: err.message
                    });
                }

                summary.atsBoardDetails.push(boardDetail);
            }
        }

        if (!dryRun && scanId) {
            updateSourceScan(scanId, {
                completed_at: new Date().toISOString(),
                total_jobs: summary.commentsParsed,
                new_jobs: summary.jobsInserted,
                duplicate_jobs: summary.crossSourceDuplicates + summary.jobsUnchanged,
                errors: summary.errors.length,
                is_complete: true,
                fetched_count: summary.commentsInspected,
                normalized_count: summary.commentsParsed,
                inserted_count: summary.jobsInserted,
                updated_count: summary.jobsUpdated,
                unchanged_count: summary.jobsUnchanged,
                invalid_count: summary.commentsRejected,
                duplicate_in_source_count: summary.crossSourceDuplicates
            });
        }
    } catch (err) {
        summary.errors.push(err.message);
        if (!dryRun && scanId) {
            updateSourceScan(scanId, {
                completed_at: new Date().toISOString(),
                errors: summary.errors.length,
                is_complete: false,
                error_details: err.message
            });
        }
        throw err;
    }

    return summary;
}
