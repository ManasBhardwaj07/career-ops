/**
 * discovery/adapters/index.mjs — Universal Discovery Adapter Registry
 *
 * Exports all ATS Board Adapters and Public Job Feed Providers.
 */

import { RemoteOkAdapter, fetchRemoteOkJobs, parseRemoteOkResponse, REMOTEOK_API_ENDPOINT } from './remoteok.mjs';
import { HimalayasAdapter, fetchHimalayasJobs, parseHimalayasResponse, HIMALAYAS_API_ENDPOINT } from './himalayas.mjs';
import { RemotiveAdapter, fetchRemotiveJobs, parseRemotiveResponse, REMOTIVE_API_ENDPOINT, REMOTIVE_MAX_REQUESTS_PER_DAY, REMOTIVE_MIN_POLL_INTERVAL_MS } from './remotive.mjs';
import {
    JobicyAdapter,
    fetchJobicyJobs,
    parseJobicyResponse,
    checkJobicyJobStatuses,
    mapJobicyStatusToVerificationOutcome,
    normalizeJobicyStatusValue,
    JOBICY_PRIMARY_ENDPOINT,
    JOBICY_STATUS_ENDPOINT,
    JOBICY_POLL_INTERVAL_MS
} from './jobicy.mjs';
import { WeworkremotelyAdapter, fetchWwrJobs, parseWwrRss, parseWwrJson, WWR_DEFAULT_RSS_FEED } from './weworkremotely.mjs';
import { AdzunaAdapter, fetchAdzunaJobs, hasAdzunaCredentials, ADZUNA_BASE_ENDPOINT } from './adzuna.mjs';
import {
    discoverHnHiringThreads,
    fetchHnThreadComments,
    parseHnHiringComment,
    fetchHackerNewsHiringJobs,
    HN_ALGOLIA_BASE
} from './hackernews.mjs';
import {
    fetchYcStartupJobs,
    parseYcProfileHtml,
    discoverCareerAndAtsFromWebsite,
    detectAtsFromUrl,
    validateYcPublicUrl,
    YC_DIRECTORY_BASE
} from './yc.mjs';
import { InternshalaAdapter, fetchInternshalaJobs, INTERNSHALA_API_ENDPOINT } from './internshala-adapter.mjs';
import { HiristAdapter, fetchHiristJobs, HIRIST_SEARCH_ENDPOINT } from './hirist-adapter.mjs';
import { JobSpyAdapter, fetchJobSpyJobs } from './jobspy-adapter.mjs';
import { CutshortAdapter, fetchCutshortJobs, CUTSHORT_BASE_URL, CUTSHORT_OPPORTUNITIES_ENDPOINT } from './cutshort-adapter.mjs';
import { InstahyreAdapter, fetchInstahyreJobs, INSTAHYRE_BASE_URL, INSTAHYRE_PUBLIC_SEARCH_URL } from './instahyre-adapter.mjs';
import { WellfoundAdapter, fetchWellfoundJobs, WELLFOUND_BASE_URL, WELLFOUND_GRAPHQL_ENDPOINT } from './wellfound-adapter.mjs';
import { AmazonJobsAdapter, fetchAmazonJobs, AMAZON_JOBS_BASE_URL, AMAZON_JOBS_SEARCH_ENDPOINT } from './amazon-jobs.mjs';
import { BreezyAdapter, fetchBreezyJobs } from './breezy.mjs';
import { PinpointAdapter, fetchPinpointJobs } from './pinpoint.mjs';
import { JoobleAdapter, fetchJoobleJobs, JOOBLE_BASE_ENDPOINT } from './jooble.mjs';
import { ATS_CATALOG, detectAtsFromUrl as detectAtsFromCatalogUrl } from '../ats-catalog.mjs';
import { DIRECT_JOB_BOARDS_REGISTRY, getJobBoardDetails, getAllJobBoards, getJobBoardsByStatus } from '../job-boards-registry.mjs';
import { employerRegistry, EmployerRegistry } from '../employer-registry.mjs';
import { sessionVault, SessionVault } from '../sessions/session-vault.mjs';
import { sourceQuarantine } from '../source-quarantine.mjs';

export {
    InternshalaAdapter,
    fetchInternshalaJobs,
    HiristAdapter,
    fetchHiristJobs,
    JobSpyAdapter,
    fetchJobSpyJobs,
    CutshortAdapter,
    fetchCutshortJobs,
    CUTSHORT_BASE_URL,
    CUTSHORT_OPPORTUNITIES_ENDPOINT,
    InstahyreAdapter,
    fetchInstahyreJobs,
    INSTAHYRE_BASE_URL,
    INSTAHYRE_PUBLIC_SEARCH_URL,
    WellfoundAdapter,
    fetchWellfoundJobs,
    WELLFOUND_BASE_URL,
    WELLFOUND_GRAPHQL_ENDPOINT,
    AmazonJobsAdapter,
    fetchAmazonJobs,
    AMAZON_JOBS_BASE_URL,
    AMAZON_JOBS_SEARCH_ENDPOINT,
    BreezyAdapter,
    fetchBreezyJobs,
    PinpointAdapter,
    fetchPinpointJobs,
    JoobleAdapter,
    fetchJoobleJobs,
    JOOBLE_BASE_ENDPOINT,
    ATS_CATALOG,
    detectAtsFromCatalogUrl,
    DIRECT_JOB_BOARDS_REGISTRY,
    getJobBoardDetails,
    getAllJobBoards,
    getJobBoardsByStatus,
    employerRegistry,
    EmployerRegistry,
    sessionVault,
    SessionVault,
    sourceQuarantine
};

export { GreenhouseAdapter, fetchGreenhouseJobs, parseGreenhouseResponse } from './greenhouse.mjs';
export { LeverAdapter, fetchLeverJobs, parseLeverResponse } from './lever.mjs';
export { AshbyAdapter, fetchAshbyJobs, parseAshbyResponse } from './ashby.mjs';
export { SmartRecruitersAdapter, fetchSmartRecruitersJobs, parseSmartRecruitersResponse } from './smartrecruiters.mjs';
export { WorkdayAdapter, fetchWorkdayJobs, parseWorkdayResponse } from './workday.mjs';
export { WorkableAdapter, fetchWorkableJobs, parseWorkableResponse } from './workable.mjs';
export { RecruiteeAdapter, fetchRecruiteeJobs, parseRecruiteeResponse } from './recruitee.mjs';

// Phase 4C Batch 1 Public Feeds & REST APIs
export {
    RemoteOkAdapter,
    fetchRemoteOkJobs,
    parseRemoteOkResponse,
    HimalayasAdapter,
    fetchHimalayasJobs,
    parseHimalayasResponse,
    RemotiveAdapter,
    fetchRemotiveJobs,
    parseRemotiveResponse,
    JobicyAdapter,
    fetchJobicyJobs,
    parseJobicyResponse,
    checkJobicyJobStatuses,
    mapJobicyStatusToVerificationOutcome,
    normalizeJobicyStatusValue,
    JOBICY_PRIMARY_ENDPOINT,
    JOBICY_STATUS_ENDPOINT,
    JOBICY_POLL_INTERVAL_MS,
    WeworkremotelyAdapter,
    fetchWwrJobs,
    parseWwrRss,
    parseWwrJson,
    AdzunaAdapter,
    fetchAdzunaJobs,
    hasAdzunaCredentials,
    // Phase 4C Batch 2 Startup Ecosystem & Employer Discovery
    discoverHnHiringThreads,
    fetchHnThreadComments,
    parseHnHiringComment,
    fetchHackerNewsHiringJobs,
    fetchYcStartupJobs,
    parseYcProfileHtml,
    discoverCareerAndAtsFromWebsite,
    detectAtsFromUrl,
    validateYcPublicUrl
};

export const STARTUP_ECOSYSTEM_PROVIDERS = {
    HACKERNEWS: 'hackernews',
    YC: 'yc'
};

export const STARTUP_ECOSYSTEM_REGISTRY = {
    [STARTUP_ECOSYSTEM_PROVIDERS.HACKERNEWS]: {
        provider: STARTUP_ECOSYSTEM_PROVIDERS.HACKERNEWS,
        displayName: 'Hacker News (Who is Hiring)',
        endpoint: `${HN_ALGOLIA_BASE}/search_by_date?tags=story,author_whoishiring`,
        fetcher: fetchHackerNewsHiringJobs,
        minPollIntervalMs: 60 * 60 * 1000,
        maxRequestsPerDay: 24,
        requiresCredentials: false
    },
    [STARTUP_ECOSYSTEM_PROVIDERS.YC]: {
        provider: STARTUP_ECOSYSTEM_PROVIDERS.YC,
        displayName: 'Y Combinator (Public Directory)',
        endpoint: `${YC_DIRECTORY_BASE}/companies`,
        fetcher: fetchYcStartupJobs,
        minPollIntervalMs: 60 * 60 * 1000,
        maxRequestsPerDay: 24,
        requiresCredentials: false
    }
};

export const PUBLIC_FEED_PROVIDERS = {
    REMOTEOK: 'remoteok',
    HIMALAYAS: 'himalayas',
    REMOTIVE: 'remotive',
    JOBICY: 'jobicy',
    WEWORKREMOTELY: 'weworkremotely',
    ADZUNA: 'adzuna',
    INTERNSHALA: 'internshala',
    HIRIST: 'hirist',
    JOBSPY: 'jobspy',
    CUTSHORT: 'cutshort',
    INSTAHYRE: 'instahyre',
    WELLFOUND: 'wellfound',
    AMAZON_JOBS: 'amazon_jobs',
    JOOBLE: 'jooble'
};

/**
 * Operational feed registry consumed by scan-sqlite.mjs and discovery tooling.
 * Encapsulates rate limits, terms metadata, and fetchers for each public provider.
 */
export const PUBLIC_FEED_REGISTRY = {
    [PUBLIC_FEED_PROVIDERS.REMOTEOK]: {
        provider: PUBLIC_FEED_PROVIDERS.REMOTEOK,
        displayName: 'Remote OK',
        endpoint: REMOTEOK_API_ENDPOINT,
        fetcher: fetchRemoteOkJobs,
        minPollIntervalMs: 60 * 60 * 1000, // 1 hour recommended cache window
        maxRequestsPerDay: 24,
        requiresCredentials: false,
        attribution: 'Powered by Remote OK (https://remoteok.com) — follow link required'
    },
    [PUBLIC_FEED_PROVIDERS.HIMALAYAS]: {
        provider: PUBLIC_FEED_PROVIDERS.HIMALAYAS,
        displayName: 'Himalayas',
        endpoint: HIMALAYAS_API_ENDPOINT,
        fetcher: fetchHimalayasJobs,
        minPollIntervalMs: 60 * 60 * 1000, // Daily refresh / polite caching
        maxRequestsPerDay: 24,
        requiresCredentials: false,
        attribution: 'Powered by Himalayas (https://himalayas.app) — original applicationLink preserved'
    },
    [PUBLIC_FEED_PROVIDERS.REMOTIVE]: {
        provider: PUBLIC_FEED_PROVIDERS.REMOTIVE,
        displayName: 'Remotive',
        endpoint: REMOTIVE_API_ENDPOINT,
        fetcher: fetchRemotiveJobs,
        minPollIntervalMs: REMOTIVE_MIN_POLL_INTERVAL_MS, // 6 hours
        maxRequestsPerDay: REMOTIVE_MAX_REQUESTS_PER_DAY, // Max 4 requests/day
        requiresCredentials: false,
        attribution: 'Powered by Remotive (https://remotive.com) — 24h delay applies'
    },
    [PUBLIC_FEED_PROVIDERS.JOBICY]: {
        provider: PUBLIC_FEED_PROVIDERS.JOBICY,
        displayName: 'Jobicy',
        endpoint: JOBICY_PRIMARY_ENDPOINT,
        statusEndpoint: JOBICY_STATUS_ENDPOINT,
        fetcher: fetchJobicyJobs,
        minPollIntervalMs: JOBICY_POLL_INTERVAL_MS, // Once per hour
        maxRequestsPerDay: 24,
        requiresCredentials: false,
        attribution: 'Powered by Jobicy (https://jobicy.com)'
    },
    [PUBLIC_FEED_PROVIDERS.WEWORKREMOTELY]: {
        provider: PUBLIC_FEED_PROVIDERS.WEWORKREMOTELY,
        displayName: 'We Work Remotely',
        endpoint: WWR_DEFAULT_RSS_FEED,
        fetcher: fetchWwrJobs,
        minPollIntervalMs: 60 * 60 * 1000,
        maxRequestsPerDay: 24,
        requiresCredentials: false,
        attribution: 'Powered by We Work Remotely (https://weworkremotely.com)'
    },
    [PUBLIC_FEED_PROVIDERS.ADZUNA]: {
        provider: PUBLIC_FEED_PROVIDERS.ADZUNA,
        displayName: 'Adzuna India',
        endpoint: ADZUNA_BASE_ENDPOINT,
        fetcher: fetchAdzunaJobs,
        hasCredentials: hasAdzunaCredentials,
        minPollIntervalMs: 60 * 60 * 1000,
        maxRequestsPerDay: 24,
        requiresCredentials: true,
        attribution: 'Powered by Adzuna (https://www.adzuna.in)'
    },
    [PUBLIC_FEED_PROVIDERS.INTERNSHALA]: {
        provider: PUBLIC_FEED_PROVIDERS.INTERNSHALA,
        displayName: 'Internshala',
        endpoint: INTERNSHALA_API_ENDPOINT,
        fetcher: fetchInternshalaJobs,
        minPollIntervalMs: 60 * 60 * 1000,
        maxRequestsPerDay: 24,
        requiresCredentials: false,
        attribution: 'Powered by Internshala (https://internshala.com)'
    },
    [PUBLIC_FEED_PROVIDERS.HIRIST]: {
        provider: PUBLIC_FEED_PROVIDERS.HIRIST,
        displayName: 'Hirist',
        endpoint: HIRIST_SEARCH_ENDPOINT,
        fetcher: fetchHiristJobs,
        minPollIntervalMs: 60 * 60 * 1000,
        maxRequestsPerDay: 24,
        requiresCredentials: false,
        attribution: 'Powered by Hirist (https://www.hirist.tech)'
    },
    [PUBLIC_FEED_PROVIDERS.JOBSPY]: {
        provider: PUBLIC_FEED_PROVIDERS.JOBSPY,
        displayName: 'JobSpy (Naukri/Indeed Bridge)',
        endpoint: 'scripts/jobspy-ingest.py',
        fetcher: fetchJobSpyJobs,
        minPollIntervalMs: 60 * 60 * 1000,
        maxRequestsPerDay: 24,
        requiresCredentials: false,
        attribution: 'Powered by python-jobspy'
    },
    [PUBLIC_FEED_PROVIDERS.CUTSHORT]: {
        provider: PUBLIC_FEED_PROVIDERS.CUTSHORT,
        displayName: 'Cutshort',
        endpoint: CUTSHORT_OPPORTUNITIES_ENDPOINT,
        fetcher: fetchCutshortJobs,
        minPollIntervalMs: 60 * 60 * 1000,
        maxRequestsPerDay: 24,
        requiresCredentials: true,
        attribution: 'Cutshort (Session Vault / Human Checkpoint Required)'
    },
    [PUBLIC_FEED_PROVIDERS.INSTAHYRE]: {
        provider: PUBLIC_FEED_PROVIDERS.INSTAHYRE,
        displayName: 'Instahyre',
        endpoint: INSTAHYRE_PUBLIC_SEARCH_URL,
        fetcher: fetchInstahyreJobs,
        minPollIntervalMs: 60 * 60 * 1000,
        maxRequestsPerDay: 24,
        requiresCredentials: false,
        attribution: 'Instahyre (Hybrid Public Search & Session Vault)'
    },
    [PUBLIC_FEED_PROVIDERS.WELLFOUND]: {
        provider: PUBLIC_FEED_PROVIDERS.WELLFOUND,
        displayName: 'Wellfound',
        endpoint: WELLFOUND_GRAPHQL_ENDPOINT,
        fetcher: fetchWellfoundJobs,
        minPollIntervalMs: 60 * 60 * 1000,
        maxRequestsPerDay: 24,
        requiresCredentials: true,
        attribution: 'Wellfound (Session Vault / Turnstile WAF Gated)'
    },
    [PUBLIC_FEED_PROVIDERS.AMAZON_JOBS]: {
        provider: PUBLIC_FEED_PROVIDERS.AMAZON_JOBS,
        displayName: 'Amazon & AWS Jobs',
        endpoint: AMAZON_JOBS_SEARCH_ENDPOINT,
        fetcher: fetchAmazonJobs,
        minPollIntervalMs: 60 * 60 * 1000,
        maxRequestsPerDay: 24,
        requiresCredentials: false,
        attribution: 'Powered by Amazon Jobs (https://www.amazon.jobs)'
    },
    [PUBLIC_FEED_PROVIDERS.JOOBLE]: {
        provider: PUBLIC_FEED_PROVIDERS.JOOBLE,
        displayName: 'Jooble',
        endpoint: JOOBLE_BASE_ENDPOINT,
        fetcher: fetchJoobleJobs,
        minPollIntervalMs: 60 * 60 * 1000,
        maxRequestsPerDay: 24,
        requiresCredentials: true,
        attribution: 'Powered by Jooble (https://jooble.org)'
    }
};
