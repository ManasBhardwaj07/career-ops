/**
 * discovery/coverage-reporter.mjs — Source Coverage and Operating Metrics Reporter
 *
 * Implements Phase 8:
 * - Total registered employers in registry
 * - Employers with verified career URLs vs unknown ATS
 * - Employers accessible through public ATS APIs vs custom page crawlers
 * - Active board connectors & active API/RSS connectors
 * - Permission-required sources & blocked sources
 * - Jobs discovered per source & deduplication ratios
 * - Operational fetch timing & rate-limit tiers
 */

import { employerRegistry } from './employer-registry.mjs';
import { ATS_CATALOG } from './ats-catalog.mjs';
import { DIRECT_JOB_BOARDS_REGISTRY } from './job-boards-registry.mjs';
import { PUBLIC_FEED_REGISTRY } from './adapters/index.mjs';
import { sourceQuarantine } from './source-quarantine.mjs';
import { getDb } from '../db/db.mjs';

export class CoverageReporter {
    constructor() {
        this.registry = employerRegistry;
    }

    generateReport() {
        const employers = this.registry.getAllEmployers();
        const stats = this.registry.getRegistryStats();

        // Categorize employers by access method
        let publicAtsCount = 0;
        let crawlerCount = 0;
        let unknownAtsCount = 0;

        for (const emp of employers) {
            const ats = emp.ats_type;
            if (!ats || ats === 'unknown' || ats === 'custom_portal') {
                unknownAtsCount++;
                crawlerCount++;
            } else if (ATS_CATALOG[ats] && ATS_CATALOG[ats].implementation_status === 'NATIVE_API_ADAPTER') {
                publicAtsCount++;
            } else {
                crawlerCount++;
            }
        }

        // Job boards breakdown
        const allBoards = Object.values(DIRECT_JOB_BOARDS_REGISTRY);
        const liveBoards = allBoards.filter(b => b.operational_status === 'LIVE_ADAPTER');
        const sessionBoards = allBoards.filter(b => b.operational_status === 'SESSION_GATED');
        const permissionRequiredBoards = allBoards.filter(b => b.operational_status === 'PERMISSION_REQUIRED');

        // Public Feeds breakdown
        const publicFeeds = Object.values(PUBLIC_FEED_REGISTRY);

        // Database stats (if database is connected)
        let dbStats = {
            totalJobPostings: 0,
            postingsBySource: [],
            uniquePostingsCount: 0
        };

        try {
            const db = getDb();
            const total = db.prepare('SELECT count(*) as c FROM job_postings').get();
            dbStats.totalJobPostings = total ? total.c : 0;
            dbStats.postingsBySource = db.prepare('SELECT source, count(*) as c FROM job_postings GROUP BY source ORDER BY c DESC').all();

            // Deduplication estimate based on unique content hash
            const unique = db.prepare('SELECT count(DISTINCT content_hash) as c FROM job_postings').get();
            dbStats.uniquePostingsCount = unique ? unique.c : dbStats.totalJobPostings;
        } catch {
            // Test isolation or non-db context
        }

        // Quarantine stats
        const quarantinedSources = [];
        for (const [key, details] of Object.entries(sourceQuarantine.state.sources || {})) {
            if (details.quarantined) {
                quarantinedSources.push({ source: key, reason: details.quarantineReason });
            }
        }

        return {
            timestamp: new Date().toISOString(),
            employers: {
                totalRegistered: employers.length,
                verifiedCareerUrls: stats.withCareerUrl,
                missingCareerUrls: stats.withoutCareerUrl,
                accessibleViaPublicAtsApi: publicAtsCount,
                accessibleViaCrawler: crawlerCount,
                unknownOrCustomAts: unknownAtsCount,
                industryBreakdown: stats.industryBreakdown,
                atsBreakdown: stats.atsBreakdown
            },
            connectors: {
                totalAtsEnginesCataloged: Object.keys(ATS_CATALOG).length,
                nativeAtsAdapters: Object.values(ATS_CATALOG).filter(a => a.implementation_status === 'NATIVE_API_ADAPTER').length,
                crawlerHandledAtsEngines: Object.values(ATS_CATALOG).filter(a => a.implementation_status === 'CAREER_PAGE_CRAWLER').length,
                publicFeedsActive: publicFeeds.length,
                directJobBoardsTotal: allBoards.length,
                directJobBoardsLive: liveBoards.length,
                directJobBoardsSessionGated: sessionBoards.length,
                directJobBoardsPermissionRequired: permissionRequiredBoards.length
            },
            quarantine: {
                quarantinedSourcesCount: quarantinedSources.length,
                quarantinedSources
            },
            database: dbStats,
            throughputTiers: {
                tier1_high_frequency: 'Every 2-4 hours: Public ATS APIs (Greenhouse, Lever, Ashby, SmartRecruiters, Amazon Jobs, Remotive, Himalayas)',
                tier2_medium_frequency: 'Every 8-12 hours: Hybrid & Session Portals (Instahyre, Cutshort, Wellfound, RemoteOK, WWR, Adzuna)',
                tier3_low_frequency: 'Every 24-48 hours: Enterprise Crawler Pages (TCS, Infosys, Wipro, Accenture, Cisco, IBM, Workday)'
            }
        };
    }
}

export const coverageReporter = new CoverageReporter();
