/**
 * discovery/adapters/yc.mjs — Compliant Y Combinator Public Profile & Employer Discovery Connector
 *
 * Strictly limited to publicly accessible YC company profiles (`ycombinator.com/companies/<slug>`),
 * public sitemaps/directories permitted by `robots.txt`, official employer websites, and public ATS endpoints.
 *
 * Explicitly prohibits:
 *   - `workatastartup.com` scraping or authenticated application endpoints
 *   - Undocumented/private YC APIs or anti-bot / CAPTCHA bypasses
 *   - Treating a YC company profile as a job posting
 *
 * Flow:
 *   Public YC profile -> validate official domain -> acquire career page (robots + SSRF checked) ->
 *   detect & validate ATS board -> register employer via `company-resolver.mjs` ->
 *   fetch live vacancies via existing ATS adapters -> `upsertJobPosting()` + `findCrossSourceDuplicates()`
 */

import { safeFetch } from '../crawler/fetch.mjs';
import { getRobotsForUrl, RobotsParser } from '../crawler/robots.mjs';
import { isAllowedHostname } from '../crawler/safety.mjs';
import { fetchGreenhouseJobs, extractBoard as extractGreenhouseBoard } from './greenhouse.mjs';
import { fetchLeverJobs, extractCompany as extractLeverBoard } from './lever.mjs';
import { fetchAshbyJobs, extractBoard as extractAshbyBoard } from './ashby.mjs';
import { fetchWorkdayJobs, extractWorkdayConfig } from './workday.mjs';
import { fetchSmartRecruitersJobs, extractCompanyIdentifier as extractSmartRecruitersBoard } from './smartrecruiters.mjs';
import { fetchWorkableJobs, extractAccount as extractWorkableAccount } from './workable.mjs';
import { fetchRecruiteeJobs, extractCompany as extractRecruiteeCompany } from './recruitee.mjs';
import {
    ingestSearchLead,
    resolveLead,
    upsertJobPosting,
    findCrossSourceDuplicates,
    createSourceScan,
    updateSourceScan,
    getCompany,
    createCompany,
    updateCompany,
    isSourcePermitted,
    claimAtsValidationScan
} from '../../db/repo.mjs';
import {
    resolveCompanyIdentity,
    registerCompanyCareerSurface,
    extractOfficialDomain,
    isThirdPartyPlatformDomain
} from '../leads/company-resolver.mjs';
import { decodeHtmlEntities } from './hackernews.mjs';

export const YC_DIRECTORY_BASE = 'https://www.ycombinator.com';
export const YC_SITEMAP_URL = 'https://www.ycombinator.com/companies/sitemap.xml';
export const YC_FEED_COMPANY_ID = 'feed-yc-directory';

const BLOCKED_YC_HOSTS = ['workatastartup.com'];
const BLOCKED_YC_PATH_PREFIXES = ['/login', '/signin', '/signup', '/auth', '/api/', '/internal/'];
const SOCIAL_OR_NON_WEBSITE_HOSTS = [
    'ycombinator.com',
    'workatastartup.com',
    'news.ycombinator.com',
    'linkedin.com',
    'twitter.com',
    'x.com',
    'github.com',
    'gitlab.com',
    'facebook.com',
    'instagram.com',
    'youtube.com',
    'youtu.be',
    'crunchbase.com',
    'angel.co',
    'wellfound.com',
    'techcrunch.com'
];

/**
 * Verify a YC URL obeys strict public-access compliance rules.
 */
export function validateYcPublicUrl(rawUrl) {
    let parsed;
    try {
        parsed = new URL(rawUrl);
    } catch {
        return { allowed: false, reason: `Malformed YC URL: ${rawUrl}` };
    }

    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        return { allowed: false, reason: `Unsupported protocol: ${parsed.protocol}` };
    }

    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    if (BLOCKED_YC_HOSTS.some(h => host === h || host.endsWith(`.${h}`))) {
        return {
            allowed: false,
            reason: `Blocked YC host "${host}": Work at a Startup is login-gated and excluded by policy`
        };
    }

    if (host !== 'ycombinator.com') {
        return {
            allowed: false,
            reason: `Unexpected YC host "${host}": only public ycombinator.com pages are allowed`
        };
    }

    const lowerPath = parsed.pathname.toLowerCase();
    if (BLOCKED_YC_PATH_PREFIXES.some(prefix => lowerPath.startsWith(prefix))) {
        return {
            allowed: false,
            reason: `Blocked YC path "${parsed.pathname}": auth/internal endpoints are excluded by policy`
        };
    }

    if (lowerPath.endsWith('/apply')) {
        return {
            allowed: false,
            reason: `Blocked YC path "${parsed.pathname}": application submission endpoints are prohibited`
        };
    }

    const isAllowedPublicRoute =
        lowerPath.startsWith('/companies/') ||
        lowerPath === '/companies' ||
        /^\/(?:companies\/)?sitemap.*\.xml$/i.test(lowerPath);

    if (!isAllowedPublicRoute) {
        return {
            allowed: false,
            reason: `Path "${parsed.pathname}" is outside public YC company directory/sitemap routes`
        };
    }

    return { allowed: true, url: parsed.toString() };
}

async function checkRobotsPermission(targetUrl, { fetcher = null, fetchFn = null, timeoutMs = 8000 } = {}) {
    const parsed = new URL(targetUrl);

    if (!fetcher && !fetchFn) {
        const res = await getRobotsForUrl(targetUrl, { timeoutMs });
        const verdict = res.parser.isAllowed(parsed.pathname + parsed.search);
        return {
            allowed: res.ok ? verdict.allowed : false,
            reason: res.ok ? verdict.reason : (res.reason || 'robots.txt disallowed')
        };
    }

    const robotsUrl = `${parsed.origin}/robots.txt`;
    try {
        const txt = await performCompliantHttpGet(robotsUrl, { fetcher, fetchFn, timeoutMs, skipRobots: true });
        const parser = new RobotsParser(txt || '');
        const verdict = parser.isAllowed(parsed.pathname + parsed.search);
        return { allowed: verdict.allowed, reason: verdict.reason };
    } catch (err) {
        if (err && (err.status === 404 || /HTTP 404/i.test(err.message))) {
            return { allowed: true, reason: 'robots.txt returned 404 (allowed)' };
        }
        return { allowed: false, reason: `robots.txt check failed closed: ${err.message}` };
    }
}

async function performCompliantHttpGet(targetUrl, {
    fetcher = null,
    fetchFn = null,
    timeoutMs = 10000,
    skipRobots = false
} = {}) {
    const parsed = new URL(targetUrl);
    if (!isAllowedHostname(parsed.hostname)) {
        throw new Error(`SSRF protection blocked unsafe hostname: ${parsed.hostname}`);
    }

    if (!skipRobots) {
        const robots = await checkRobotsPermission(targetUrl, { fetcher, fetchFn, timeoutMs });
        if (!robots.allowed) {
            const err = new Error(`Blocked by robots.txt for ${targetUrl}: ${robots.reason}`);
            err.code = 'ROBOTS_DISALLOWED';
            throw err;
        }
    }

    if (typeof fetcher === 'function') {
        const result = await fetcher(targetUrl, { timeoutMs });
        if (typeof result === 'string') return result;
        if (result && result.status >= 400) {
            const err = new Error(`HTTP ${result.status} fetching ${targetUrl}`);
            err.status = result.status;
            throw err;
        }
        return result?.text ?? '';
    }

    if (typeof fetchFn === 'function') {
        const res = await fetchFn(targetUrl, {
            headers: {
                'User-Agent': 'CareerOpsJobBot/1.0 (+public-job-discovery)',
                'Accept': 'text/html,application/xml,application/json;q=0.9,*/*;q=0.8'
            }
        });
        if (!res.ok) {
            const err = new Error(`HTTP ${res.status} fetching ${targetUrl}`);
            err.status = res.status;
            throw err;
        }
        return await res.text();
    }

    const res = await safeFetch(targetUrl, {
        timeoutMs,
        maxRedirects: 3,
        rateLimitMs: 350
    });
    return res.text;
}

/**
 * Detect supported ATS provider + board identifier directly from a URL.
 */
export function detectAtsFromUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return null;
    let parsed;
    try {
        parsed = new URL(rawUrl);
    } catch {
        return null;
    }

    const host = parsed.hostname.toLowerCase();

    if (host.includes('greenhouse.io')) {
        let board = null;
        if (parsed.searchParams.get('for')) {
            board = parsed.searchParams.get('for');
        } else {
            try {
                board = extractGreenhouseBoard(rawUrl);
            } catch {
                board = null;
            }
        }
        if (board && !['embed', 'job_board', 'jobs'].includes(board.toLowerCase())) {
            return {
                atsType: 'greenhouse',
                boardIdentifier: board,
                boardUrl: `https://boards.greenhouse.io/${board}`
            };
        }
    }

    if (host === 'jobs.lever.co' || host === 'jobs.eu.lever.co') {
        try {
            const company = extractLeverBoard(rawUrl);
            if (company) {
                return {
                    atsType: 'lever',
                    boardIdentifier: company,
                    boardUrl: `https://jobs.lever.co/${company}`
                };
            }
        } catch {
            return null;
        }
    }

    if (host === 'jobs.ashbyhq.com') {
        try {
            const board = extractAshbyBoard(rawUrl);
            if (board) {
                return {
                    atsType: 'ashby',
                    boardIdentifier: board,
                    boardUrl: `https://jobs.ashbyhq.com/${board}`
                };
            }
        } catch {
            return null;
        }
    }

    if (host.endsWith('.myworkdayjobs.com') || host.endsWith('.myworkdaysite.com')) {
        try {
            extractWorkdayConfig(rawUrl);
            return {
                atsType: 'workday',
                boardIdentifier: rawUrl,
                boardUrl: rawUrl
            };
        } catch {
            return null;
        }
    }

    if (host === 'jobs.smartrecruiters.com') {
        try {
            const companyId = extractSmartRecruitersBoard(rawUrl);
            if (companyId) {
                return {
                    atsType: 'smartrecruiters',
                    boardIdentifier: companyId,
                    boardUrl: `https://jobs.smartrecruiters.com/${companyId}`
                };
            }
        } catch {
            return null;
        }
    }

    if (host === 'apply.workable.com' || host === 'www.workable.com') {
        try {
            const account = extractWorkableAccount(rawUrl);
            if (account) {
                return {
                    atsType: 'workable',
                    boardIdentifier: account,
                    boardUrl: `https://apply.workable.com/${account}`
                };
            }
        } catch {
            return null;
        }
    }

    if (host.endsWith('.recruitee.com')) {
        try {
            const slug = extractRecruiteeCompany(rawUrl);
            if (slug) {
                return {
                    atsType: 'recruitee',
                    boardIdentifier: slug,
                    boardUrl: `https://${slug}.recruitee.com`
                };
            }
        } catch {
            return null;
        }
    }

    return null;
}

function isSocialOrExcludedUrl(rawUrl) {
    let host;
    try {
        host = new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, '');
    } catch {
        return true;
    }
    return SOCIAL_OR_NON_WEBSITE_HOSTS.some(s => host === s || host.endsWith(`.${s}`));
}

function extractAnchorHrefs(html, baseUrl) {
    const links = [];
    const seen = new Set();
    const re = /<(?:a|iframe)\b[^>]+(?:href|src)=["']([^"']+)["'][^>]*>/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
        const rawHref = decodeHtmlEntities(m[1]).trim();
        if (!rawHref || rawHref.startsWith('#') || /^(?:javascript|mailto|tel):/i.test(rawHref)) continue;
        try {
            const abs = new URL(rawHref, baseUrl).toString();
            if (/^https?:\/\//i.test(abs) && !seen.has(abs)) {
                seen.add(abs);
                links.push(abs);
            }
        } catch {
            // Skip invalid URL
        }
    }
    return links;
}

/**
 * Extract public company metadata from a YC company profile HTML page (`ycombinator.com/companies/<slug>`).
 */
export function parseYcProfileHtml(html, profileUrl) {
    if (!html || typeof html !== 'string') {
        return null;
    }

    const parsedUrl = new URL(profileUrl);
    const pathParts = parsedUrl.pathname.split('/').filter(Boolean);
    const slug = pathParts[1] || '';

    let name = null;
    let websiteUrl = null;
    let batch = null;
    let description = null;
    let industry = null;
    let location = null;
    const careerCandidateUrls = [];
    const atsCandidates = [];

    // 1. Parse Inertia `data-page` JSON if present on public YC company page HTML
    const dataPageMatch = html.match(/data-page=["']([^"']+)["']/i);
    if (dataPageMatch) {
        try {
            const decoded = decodeHtmlEntities(dataPageMatch[1]);
            const pageJson = JSON.parse(decoded);
            const comp = pageJson?.props?.company || pageJson?.props;
            if (comp && typeof comp === 'object') {
                name = comp.name || name;
                websiteUrl = comp.website || websiteUrl;
                batch = comp.batch_name || comp.batch || batch;
                description = comp.long_description || comp.one_liner || description;
                industry = Array.isArray(comp.industries) ? comp.industries.join(', ') : (comp.industry || industry);
                location = comp.all_locations || comp.location || location;
            }
        } catch {
            // Fallback to structured HTML/JSON-LD extraction below
        }
    }

    // 2. Parse JSON-LD `<script type="application/ld+json">`
    const ldMatches = html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
    for (const match of ldMatches) {
        try {
            const json = JSON.parse(match[1]);
            const items = Array.isArray(json) ? json : [json];
            for (const item of items) {
                if (item && (item['@type'] === 'Organization' || item['@type'] === 'Corporation')) {
                    name = name || item.name || null;
                    websiteUrl = websiteUrl || item.url || null;
                    description = description || item.description || null;
                }
            }
        } catch {
            // Ignore non-JSON LD blocks
        }
    }

    // 3. Semantic HTML fallbacks
    if (!name) {
        const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
        if (h1Match) {
            name = decodeHtmlEntities(h1Match[1].replace(/<[^>]+>/g, '')).trim();
        }
    }
    if (!name) {
        const ogTitle = html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i);
        if (ogTitle) {
            name = decodeHtmlEntities(ogTitle[1]).split('|')[0].split(':')[0].trim();
        }
    }
    if (!description) {
        const metaDesc = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i);
        if (metaDesc) {
            description = decodeHtmlEntities(metaDesc[1]).trim();
        }
    }
    if (!batch) {
        const batchMatch = html.match(/\b((?:W|S|F|X)\d{2}|Summer\s+20\d{2}|Winter\s+20\d{2}|Spring\s+20\d{2}|Fall\s+20\d{2})\b/i);
        if (batchMatch) {
            batch = batchMatch[1].trim();
        }
    }

    // 4. Inspect anchor links on public profile for official website, career links, or embedded ATS links
    const links = extractAnchorHrefs(html, profileUrl);
    for (const link of links) {
        const ats = detectAtsFromUrl(link);
        if (ats) {
            atsCandidates.push(ats);
            continue;
        }
        if (/\/(?:careers|jobs|hiring|join)\b/i.test(link) && !link.includes('ycombinator.com') && !link.includes('workatastartup.com')) {
            careerCandidateUrls.push(link);
        }
        if (!websiteUrl && !isSocialOrExcludedUrl(link) && !isThirdPartyPlatformDomain(link)) {
            const parsedLink = new URL(link);
            websiteUrl = `${parsedLink.protocol}//${parsedLink.hostname}${parsedLink.pathname === '/' ? '' : parsedLink.pathname}`.replace(/\/$/, '');
        }
    }

    if (!name && !websiteUrl) {
        return null;
    }

    const officialDomain = extractOfficialDomain(websiteUrl || '');
    return {
        slug,
        name: name ? name.trim() : officialDomain,
        batch,
        description,
        industry,
        location,
        websiteUrl,
        officialDomain,
        ycProfileUrl: profileUrl,
        careerCandidateUrls: Array.from(new Set(careerCandidateUrls)),
        atsCandidates
    };
}

/**
 * Parse public YC company profile URLs from an XML sitemap.
 */
export function parseYcSitemapUrls(xmlText, limit = 50) {
    if (!xmlText || typeof xmlText !== 'string') return [];
    const urls = [];
    const seen = new Set();
    const matches = xmlText.matchAll(/<loc>\s*(https?:\/\/(?:www\.)?ycombinator\.com\/companies\/[a-z0-9-]+)\s*<\/loc>/gi);
    for (const m of matches) {
        const u = m[1].trim();
        if (u.endsWith('/jobs')) continue;
        if (!seen.has(u)) {
            seen.add(u);
            urls.push(u);
            if (urls.length >= limit) break;
        }
    }
    return urls;
}

/**
 * Inspect an official company website (robots + SSRF checked) to locate its `/careers` page
 * and detect any supported ATS board.
 */
export async function discoverCareerAndAtsFromWebsite(websiteUrl, {
    careerHints = [],
    atsHints = [],
    probeCommonPaths = true,
    fetcher = null,
    fetchFn = null,
    timeoutMs = 10000
} = {}) {
    let detectedAts = atsHints.length > 0 ? atsHints[0] : null;
    let careerUrl = careerHints.find(Boolean) || null;
    const errors = [];

    if (!detectedAts && careerUrl) {
        detectedAts = detectAtsFromUrl(careerUrl);
    }

    const visited = new Set();
    const inspectPage = async (pageUrl) => {
        if (!pageUrl || visited.has(pageUrl)) return [];
        visited.add(pageUrl);
        try {
            const html = await performCompliantHttpGet(pageUrl, { fetcher, fetchFn, timeoutMs });
            const links = extractAnchorHrefs(html, pageUrl);
            for (const link of links) {
                const ats = detectAtsFromUrl(link);
                if (ats && !detectedAts) {
                    detectedAts = ats;
                }
                if (!careerUrl && (/\/(?:careers|jobs|openings|work-with-us)\b/i.test(link) || /^(?:careers|jobs)\./i.test(new URL(link).hostname))) {
                    if (!link.includes('workatastartup.com') && !link.includes('ycombinator.com')) {
                        careerUrl = link;
                    }
                }
            }
            return links;
        } catch (err) {
            errors.push(`${pageUrl}: ${err.message}`);
            return [];
        }
    };

    if (!detectedAts && websiteUrl) {
        await inspectPage(websiteUrl);

        if (careerUrl && !detectedAts) {
            await inspectPage(careerUrl);
        }

        if (probeCommonPaths && !detectedAts) {
            let origin;
            try {
                origin = new URL(websiteUrl).origin;
            } catch {
                origin = null;
            }
            if (origin) {
                for (const candidatePath of ['/careers', '/jobs']) {
                    if (detectedAts) break;
                    const candidateUrl = `${origin}${candidatePath}`;
                    if (visited.has(candidateUrl)) continue;
                    try {
                        const html = await performCompliantHttpGet(candidateUrl, { fetcher, fetchFn, timeoutMs });
                        if (html && /<html|<body|careers|jobs|openings|greenhouse|lever|ashby/i.test(html)) {
                            if (!careerUrl) careerUrl = candidateUrl;
                            const links = extractAnchorHrefs(html, candidateUrl);
                            for (const link of links) {
                                const ats = detectAtsFromUrl(link);
                                if (ats) {
                                    detectedAts = ats;
                                    break;
                                }
                            }
                        }
                    } catch {
                        // Ignore missing /careers or /jobs 404 or robots disallow
                    }
                }
            }
        }
    }

    return {
        careerUrl: careerUrl || (detectedAts ? detectedAts.boardUrl : null),
        ats: detectedAts,
        errors
    };
}

/**
 * Fetch and validate jobs from a detected ATS board using the repository's existing ATS adapters.
 */
export async function fetchJobsFromValidatedAts(ats, companyId, companyName, {
    fetchFn = fetch,
    timeoutMs = 10000,
    dryRun = false,
    upsert = false,
    existingScanId = null
} = {}) {
    if (!ats || !ats.atsType || !ats.boardIdentifier) {
        return [];
    }

    const canRecordScan = !dryRun && Boolean(companyId) && Boolean(getCompany(companyId));
    const atsScanId = existingScanId || (canRecordScan
        ? createSourceScan({
            company_id: companyId,
            source_type: ats.atsType,
            started_at: new Date().toISOString()
        })
        : null);

    const opts = { fetchFn, timeoutMs };
    try {
        let res;
        switch (ats.atsType) {
            case 'greenhouse':
                res = await fetchGreenhouseJobs(ats.boardIdentifier, companyId, companyName, opts);
                break;
            case 'lever':
                res = await fetchLeverJobs(ats.boardIdentifier, companyId, companyName, opts);
                break;
            case 'ashby':
                res = await fetchAshbyJobs(ats.boardIdentifier, companyId, companyName, opts);
                break;
            case 'workday':
                res = await fetchWorkdayJobs(ats.boardIdentifier, companyId, companyName, opts);
                break;
            case 'smartrecruiters':
                res = await fetchSmartRecruitersJobs(ats.boardIdentifier, companyId, companyName, opts);
                break;
            case 'workable':
                res = await fetchWorkableJobs(ats.boardIdentifier, companyId, companyName, opts);
                break;
            case 'recruitee':
                res = await fetchRecruiteeJobs(ats.boardIdentifier, companyId, companyName, opts);
                break;
            default:
                if (atsScanId) {
                    updateSourceScan(atsScanId, {
                        completed_at: new Date().toISOString(),
                        total_jobs: 0,
                        errors: 1,
                        is_complete: false,
                        error_details: `Unsupported ATS provider: ${ats.atsType}`
                    });
                }
                return [];
        }

        if (Array.isArray(res)) {
            if (atsScanId) {
                const completedAt = new Date().toISOString();
                updateCompany(companyId, { last_scanned_at: completedAt });
                updateSourceScan(atsScanId, {
                    completed_at: completedAt,
                    total_jobs: res.length,
                    fetched_count: res.length,
                    normalized_count: res.length,
                    is_complete: true
                });
            }
            return res;
        }

        const jobs = Array.isArray(res?.jobs) ? res.jobs : [];
        if (res?.error && jobs.length === 0) {
            throw new Error(res.error);
        }

        let inserted = 0;
        let updated = 0;
        let unchanged = 0;
        let crossSourceDuplicates = 0;

        if (upsert && !dryRun) {
            for (const job of jobs) {
                const up = upsertJobPosting(job);
                if (up.status === 'inserted') inserted++;
                else if (up.status === 'updated') updated++;
                else unchanged++;

                const dupIds = findCrossSourceDuplicates(job);
                if (dupIds.length > 0) crossSourceDuplicates++;
            }
        }

        const completedAt = new Date().toISOString();
        const isComplete = Boolean(res?.isComplete !== false && !res?.error);
        if (atsScanId) {
            updateCompany(companyId, { last_scanned_at: completedAt });
            updateSourceScan(atsScanId, {
                completed_at: completedAt,
                total_jobs: jobs.length,
                new_jobs: inserted,
                duplicate_jobs: updated + unchanged,
                fetched_count: res?.fetchedCount ?? jobs.length,
                normalized_count: res?.normalizedCount ?? jobs.length,
                inserted_count: inserted,
                updated_count: updated,
                unchanged_count: unchanged,
                invalid_count: res?.invalidCount ?? 0,
                duplicate_in_source_count: res?.duplicateInSourceCount ?? 0,
                errors: res?.error ? 1 : 0,
                is_complete: isComplete,
                error_details: res?.error || null
            });
        }

        Object.defineProperty(jobs, '_scanStats', {
            value: {
                scanId: atsScanId,
                inserted,
                updated,
                unchanged,
                crossSourceDuplicates,
                fetchedCount: res?.fetchedCount ?? jobs.length,
                normalizedCount: res?.normalizedCount ?? jobs.length,
                invalidCount: res?.invalidCount ?? 0,
                isComplete
            },
            enumerable: false
        });

        return jobs;
    } catch (err) {
        if (atsScanId) {
            updateSourceScan(atsScanId, {
                completed_at: new Date().toISOString(),
                total_jobs: 0,
                errors: 1,
                is_complete: false,
                error_details: err.message
            });
        }
        throw err;
    }
}

function ensureYcDirectoryCompany() {
    let comp = getCompany(YC_FEED_COMPANY_ID);
    if (!comp) {
        createCompany({
            id: YC_FEED_COMPANY_ID,
            name: 'Y Combinator (Public Directory)',
            domain: 'ycombinator.com',
            website_url: 'https://www.ycombinator.com/companies',
            source_provenance: 'yc_public_directory',
            lifecycle_status: 'MONITORING',
            monitoring_status: 'active',
            policy_status: 'permitted',
            notes: 'Public Y Combinator company profiles (excludes login-gated workatastartup.com)'
        });
        comp = getCompany(YC_FEED_COMPANY_ID);
    }
    return comp;
}

/**
 * Run compliant Y Combinator public company discovery -> career page -> ATS verification -> job ingestion.
 */
export async function fetchYcStartupJobs({
    slugs = [],
    companyUrls = [],
    sitemapUrl = null,
    maxCompanies = 10,
    fetchJobsFromAts = true,
    dryRun = false,
    createMissingCompanies = true,
    fetcher = null,
    fetchFn = null,
    timeoutMs = 10000
} = {}) {
    let scanId = null;
    if (!dryRun) {
        ensureYcDirectoryCompany();
        scanId = createSourceScan({
            company_id: YC_FEED_COMPANY_ID,
            source_type: 'yc',
            started_at: new Date().toISOString()
        });
    }

    const summary = {
        profilesAttempted: 0,
        profilesParsed: 0,
        blockedUrls: 0,
        robotsBlocked: 0,
        companiesResolved: 0,
        companiesCreated: 0,
        ambiguousCompanies: 0,
        atsBoardsValidated: 0,
        jobsFetchedFromAts: 0,
        jobsInserted: 0,
        jobsUpdated: 0,
        jobsUnchanged: 0,
        crossSourceDuplicates: 0,
        discoveredCompanies: [],
        jobs: [],
        errors: []
    };

    try {
        const candidateProfileUrls = [];
        const seenUrls = new Set();
        const addProfileUrl = (u) => {
            if (!u || seenUrls.has(u)) return;
            seenUrls.add(u);
            candidateProfileUrls.push(u);
        };

        for (const u of companyUrls) addProfileUrl(u);
        for (const slug of slugs) {
            const cleanSlug = String(slug).trim().replace(/^\/+|\/+$/g, '');
            if (cleanSlug) addProfileUrl(`${YC_DIRECTORY_BASE}/companies/${cleanSlug}`);
        }

        if (candidateProfileUrls.length < maxCompanies && sitemapUrl) {
            const sitemapCheck = validateYcPublicUrl(sitemapUrl);
            if (!sitemapCheck.allowed) {
                summary.blockedUrls++;
                summary.errors.push(sitemapCheck.reason);
            } else {
                try {
                    const xml = await performCompliantHttpGet(sitemapCheck.url, { fetcher, fetchFn, timeoutMs });
                    const parsedUrls = parseYcSitemapUrls(xml, maxCompanies - candidateProfileUrls.length);
                    for (const u of parsedUrls) addProfileUrl(u);
                } catch (err) {
                    if (err.code === 'ROBOTS_DISALLOWED') summary.robotsBlocked++;
                    summary.errors.push(`YC sitemap failed: ${err.message}`);
                }
            }
        }

        const targets = candidateProfileUrls.slice(0, maxCompanies);

        for (const rawProfileUrl of targets) {
            summary.profilesAttempted++;

            // 1. Strict compliance check (rejects workatastartup.com & non-public/auth endpoints)
            const policyCheck = validateYcPublicUrl(rawProfileUrl);
            if (!policyCheck.allowed) {
                summary.blockedUrls++;
                summary.errors.push(policyCheck.reason);
                continue;
            }

            let html;
            try {
                html = await performCompliantHttpGet(policyCheck.url, { fetcher, fetchFn, timeoutMs });
            } catch (err) {
                if (err.code === 'ROBOTS_DISALLOWED') summary.robotsBlocked++;
                summary.errors.push(`Profile fetch error (${policyCheck.url}): ${err.message}`);
                continue;
            }

            const profile = parseYcProfileHtml(html, policyCheck.url);
            if (!profile || !profile.name) {
                summary.errors.push(`Unable to parse public YC company profile: ${policyCheck.url}`);
                continue;
            }
            summary.profilesParsed++;

            // 2. Discover official career surface & ATS board from employer website
            const careerDiscovery = await discoverCareerAndAtsFromWebsite(profile.websiteUrl, {
                careerHints: profile.careerCandidateUrls,
                atsHints: profile.atsCandidates,
                fetcher,
                fetchFn,
                timeoutMs
            });

            const discoveredRecord = {
                ...profile,
                careerUrl: careerDiscovery.careerUrl,
                ats: careerDiscovery.ats
            };
            summary.discoveredCompanies.push(discoveredRecord);

            if (dryRun) {
                if (fetchJobsFromAts && careerDiscovery.ats) {
                    try {
                        const jobs = await fetchJobsFromValidatedAts(
                            careerDiscovery.ats,
                            `dryrun-${profile.slug || profile.name}`,
                            profile.name,
                            { fetchFn: fetchFn || fetch, timeoutMs }
                        );
                        summary.atsBoardsValidated++;
                        summary.jobsFetchedFromAts += jobs.length;
                        summary.jobs.push(...jobs);
                    } catch (err) {
                        summary.errors.push(`ATS fetch failed for ${profile.name}: ${err.message}`);
                    }
                }
                continue;
            }

            // 3. Resolve company identity conservatively
            const resolution = resolveCompanyIdentity({
                name: profile.name,
                domain: profile.officialDomain,
                websiteUrl: profile.websiteUrl,
                atsType: careerDiscovery.ats?.atsType || null,
                boardIdentifier: careerDiscovery.ats?.boardIdentifier || null,
                createIfMissing: createMissingCompanies,
                sourceProvenance: 'yc_public_profile',
                lifecycleStatus: 'UNVERIFIED',
                monitoringStatus: 'paused',
                notes: profile.batch ? `YC ${profile.batch} (${profile.ycProfileUrl})` : `YC directory (${profile.ycProfileUrl})`
            });

            // Record profile provenance in `source_leads` (never inserted as a job posting!)
            const leadRes = ingestSearchLead({
                provider: 'yc',
                query: 'yc:public_companies',
                rawUrl: profile.ycProfileUrl,
                title: profile.name,
                snippet: profile.description ? profile.description.slice(0, 400) : null,
                companyName: profile.name,
                companyId: resolution.companyId || null,
                providerPayload: {
                    slug: profile.slug,
                    batch: profile.batch,
                    industry: profile.industry,
                    websiteUrl: profile.websiteUrl,
                    officialDomain: profile.officialDomain,
                    careerUrl: careerDiscovery.careerUrl,
                    atsType: careerDiscovery.ats?.atsType || null,
                    boardIdentifier: careerDiscovery.ats?.boardIdentifier || null
                }
            });

            if (resolution.ambiguous || !resolution.companyId) {
                if (resolution.ambiguous) {
                    summary.ambiguousCompanies++;
                    resolveLead(leadRes.leadId, {
                        resolutionStatus: 'pending',
                        notes: `Ambiguous YC company resolution: ${resolution.reason || 'multiple candidates'}`
                    });
                }
                continue;
            }

            summary.companiesResolved++;
            if (resolution.created) summary.companiesCreated++;

            // Register career page & ATS board (valid schema policy source_type)
            if (careerDiscovery.ats) {
                registerCompanyCareerSurface({
                    companyId: resolution.companyId,
                    careerUrl: careerDiscovery.careerUrl,
                    atsType: careerDiscovery.ats.atsType,
                    boardIdentifier: careerDiscovery.ats.boardIdentifier,
                    source: 'yc_public_profile',
                    policySourceType: careerDiscovery.ats.atsType,
                    policyEndpoint: careerDiscovery.ats.boardUrl,
                    notes: `Validated ATS board discovered via YC company website (${profile.ycProfileUrl})`
                });
            } else if (careerDiscovery.careerUrl) {
                registerCompanyCareerSurface({
                    companyId: resolution.companyId,
                    careerUrl: careerDiscovery.careerUrl,
                    source: 'yc_public_profile',
                    policySourceType: 'custom',
                    policyEndpoint: careerDiscovery.careerUrl,
                    notes: `Career page discovered via YC company website (${profile.ycProfileUrl})`
                });
            }

            resolveLead(leadRes.leadId, {
                resolutionStatus: 'unresolvable',
                companyId: resolution.companyId,
                notes: `YC company profile resolved to ${resolution.companyId} (company profile is not a job posting)`
            });

            // 4. Fetch real vacancies via validated ATS endpoint
            if (fetchJobsFromAts && careerDiscovery.ats) {
                let claimedScanId = null;
                if (!dryRun) {
                    const claim = claimAtsValidationScan(
                        resolution.companyId,
                        careerDiscovery.ats.atsType,
                        careerDiscovery.ats.boardIdentifier
                    );
                    if (!claim.permitted) {
                        summary.errors.push(`ATS validation skipped by source policy for ${profile.name} (${careerDiscovery.ats.atsType}): ${claim.reason}`);
                        continue;
                    }
                    claimedScanId = claim.scanId;
                }
                try {
                    const atsJobs = await fetchJobsFromValidatedAts(
                        careerDiscovery.ats,
                        resolution.companyId,
                        resolution.company?.name || profile.name,
                        { fetchFn: fetchFn || fetch, timeoutMs, dryRun, upsert: !dryRun, existingScanId: claimedScanId }
                    );
                    summary.atsBoardsValidated++;
                    summary.jobsFetchedFromAts += atsJobs.length;

                    if (atsJobs._scanStats && !dryRun) {
                        summary.jobsInserted += atsJobs._scanStats.inserted;
                        summary.jobsUpdated += atsJobs._scanStats.updated;
                        summary.jobsUnchanged += atsJobs._scanStats.unchanged;
                        summary.crossSourceDuplicates += atsJobs._scanStats.crossSourceDuplicates;
                    }
                    for (const job of atsJobs) {
                        summary.jobs.push(job);
                    }
                } catch (err) {
                    summary.errors.push(`ATS fetch failed for ${profile.name} (${careerDiscovery.ats.atsType}): ${err.message}`);
                }
            }
        }

        if (!dryRun && scanId) {
            updateSourceScan(scanId, {
                completed_at: new Date().toISOString(),
                total_jobs: summary.jobsFetchedFromAts,
                new_jobs: summary.jobsInserted,
                duplicate_jobs: summary.crossSourceDuplicates + summary.jobsUnchanged,
                errors: summary.errors.length,
                is_complete: true,
                fetched_count: summary.jobsFetchedFromAts,
                normalized_count: summary.jobsFetchedFromAts,
                inserted_count: summary.jobsInserted,
                updated_count: summary.jobsUpdated,
                unchanged_count: summary.jobsUnchanged,
                invalid_count: summary.blockedUrls + summary.robotsBlocked,
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
