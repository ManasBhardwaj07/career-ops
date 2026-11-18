/**
 * application/detection/detect-portal.mjs — Application Portal Classification
 *
 * Implements Milestone 3D Part 6:
 *   - Detects ATS / career portal platform (Greenhouse, Lever, Ashby, Workday, SmartRecruiters, Generic)
 *   - Uses multi-signal heuristics: URL pattern, DOM identifiers, form classes, metadata
 */

export const PORTAL_TYPES = {
    GREENHOUSE: 'greenhouse',
    LEVER: 'lever',
    ASHBY: 'ashby',
    WORKDAY: 'workday',
    SMARTRECRUITERS: 'smartrecruiters',
    GENERIC: 'generic'
};

/**
 * Detects the application portal type from URL and page DOM.
 */
export async function detectApplicationPortal(url, page = null) {
    const urlLower = (url || '').toLowerCase();

    // 1. URL pattern heuristics (highest confidence)
    if (urlLower.includes('greenhouse.io')) {
        return {
            type: PORTAL_TYPES.GREENHOUSE,
            confidence: 0.95,
            reason: 'URL matches Greenhouse domain'
        };
    }

    if (urlLower.includes('jobs.lever.co') || urlLower.includes('lever.co')) {
        return {
            type: PORTAL_TYPES.LEVER,
            confidence: 0.95,
            reason: 'URL matches Lever domain'
        };
    }

    if (urlLower.includes('jobs.ashbyhq.com') || urlLower.includes('ashbyhq.com')) {
        return {
            type: PORTAL_TYPES.ASHBY,
            confidence: 0.95,
            reason: 'URL matches Ashby domain'
        };
    }

    if (urlLower.includes('myworkdayjobs.com') || urlLower.includes('workday.com')) {
        return {
            type: PORTAL_TYPES.WORKDAY,
            confidence: 0.95,
            reason: 'URL matches Workday domain'
        };
    }

    if (urlLower.includes('smartrecruiters.com')) {
        return {
            type: PORTAL_TYPES.SMARTRECRUITERS,
            confidence: 0.95,
            reason: 'URL matches SmartRecruiters domain'
        };
    }

    // 2. DOM heuristics if page is provided
    if (page) {
        try {
            const domSignals = await page.evaluate(() => {
                const hasGrnhse = Boolean(
                    document.querySelector('#grnhse_app') ||
                    document.querySelector('form#application_form') ||
                    document.querySelector('[data-mapped="greenhouse"]') ||
                    document.querySelector('iframe[src*="greenhouse"]')
                );

                const hasLever = Boolean(
                    document.querySelector('form#application-form') ||
                    document.querySelector('.application-form') ||
                    document.querySelector('.posting-headline') ||
                    document.querySelector('a[href*="lever.co"]')
                );

                const hasAshby = Boolean(
                    document.querySelector('[class*="ashby"]') ||
                    document.querySelector('iframe[src*="ashbyhq"]') ||
                    document.querySelector('[data-ashby]')
                );

                const hasWorkday = Boolean(
                    document.querySelector('[data-automation-id*="workday"]') ||
                    document.querySelector('[data-automation-id="jobApplication"]')
                );

                const hasSmartRecruiters = Boolean(
                    document.querySelector('form#apply-form') ||
                    document.querySelector('[data-test*="smartrecruiters"]')
                );

                return { hasGrnhse, hasLever, hasAshby, hasWorkday, hasSmartRecruiters };
            });

            if (domSignals.hasGrnhse) {
                return { type: PORTAL_TYPES.GREENHOUSE, confidence: 0.85, reason: 'DOM contains Greenhouse signature elements' };
            }
            if (domSignals.hasLever) {
                return { type: PORTAL_TYPES.LEVER, confidence: 0.85, reason: 'DOM contains Lever signature elements' };
            }
            if (domSignals.hasAshby) {
                return { type: PORTAL_TYPES.ASHBY, confidence: 0.85, reason: 'DOM contains Ashby signature elements' };
            }
            if (domSignals.hasWorkday) {
                return { type: PORTAL_TYPES.WORKDAY, confidence: 0.85, reason: 'DOM contains Workday signature elements' };
            }
            if (domSignals.hasSmartRecruiters) {
                return { type: PORTAL_TYPES.SMARTRECRUITERS, confidence: 0.85, reason: 'DOM contains SmartRecruiters signature elements' };
            }
        } catch {}
    }

    // 3. Fallback to generic portal
    return {
        type: PORTAL_TYPES.GENERIC,
        confidence: 0.50,
        reason: 'Generic HTML form / career portal'
    };
}
