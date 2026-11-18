/**
 * application/browser/security.mjs — Playwright Defense-in-Depth Security
 *
 * Implements Milestone 3D Part 5:
 *   - Playwright route interception layer (defense-in-depth behind egress proxy)
 *   - Scheme restriction (http/https only)
 *   - Redirect destination inspection
 *   - Blocking of private/internal hostnames and cloud metadata IP literals
 *   - WebSocket and resource destination auditing
 */

import { isInternalHostname, isPrivateIPv4 } from './egress-proxy.mjs';

/**
 * Standard allowed third-party services on modern career portals.
 */
export const DEFAULT_ALLOWED_THIRD_PARTY_DOMAINS = [
    'fonts.googleapis.com',
    'fonts.gstatic.com',
    'cdnjs.cloudflare.com',
    'cdn.jsdelivr.net',
    'unpkg.com',
    'challenges.cloudflare.com',
    'www.google.com/recaptcha',
    'www.gstatic.com/recaptcha',
    'hcaptcha.com',
    'newassets.hcaptcha.com',
    'js.stripe.com',
    'm.stripe.network'
];

/**
 * Attaches security routing and validation to a Playwright BrowserContext or Page.
 */
export async function attachBrowserSecurity(contextOrPage, options = {}) {
    const {
        allowedDomains = [],
        allowAllPublicDomains = true, // By default permit public CDN/assets, but strictly block private/metadata
        allowedLocalOrigins = [], // Specifically permitted local test origins (e.g. http://127.0.0.1:port)
        logger = null
    } = options;

    const securityEvents = [];

    function recordViolation(type, url, reason) {
        const evt = { type, url, reason, timestamp: new Date().toISOString() };
        securityEvents.push(evt);
        if (logger) logger(`[BrowserSecurity VIOLATION] ${type}: ${reason} (${url})`);
    }

    // Intercept all network routes in Playwright
    await contextOrPage.route('**/*', async (route) => {
        const req = route.request();
        const urlStr = req.url();

        let parsed;
        try {
            parsed = new URL(urlStr);
        } catch {
            recordViolation('MALFORMED_URL', urlStr, 'Failed to parse URL');
            return route.abort('failed');
        }

        // Specifically permitted local test origins bypass further loopback restrictions
        if (allowedLocalOrigins && allowedLocalOrigins.length > 0) {
            if (allowedLocalOrigins.some(origin => urlStr.startsWith(origin))) {
                return route.continue();
            }
        }

        // 1. Scheme restrictions: only http: and https: (plus data: only for inline images/fonts)
        const scheme = parsed.protocol;
        if (scheme !== 'http:' && scheme !== 'https:') {
            if (scheme === 'data:' && (req.resourceType() === 'image' || req.resourceType() === 'font')) {
                return route.continue();
            }
            recordViolation('FORBIDDEN_SCHEME', urlStr, `Scheme "${scheme}" is not permitted`);
            return route.abort('blockedbyclient');
        }

        const hostname = parsed.hostname;

        // 2. Reject internal/reserved hostnames and loopback/private/metadata IPs
        if (isInternalHostname(hostname)) {
            recordViolation('INTERNAL_DESTINATION', urlStr, `Target hostname "${hostname}" is private/internal`);
            return route.abort('blockedbyclient');
        }

        // 3. Inspect redirects
        const redirectChain = req.redirectedFrom();
        if (redirectChain) {
            const fromUrl = redirectChain.url();
            try {
                const fromParsed = new URL(fromUrl);
                // Disallow cross-scheme downgrade
                if (fromParsed.protocol === 'https:' && parsed.protocol === 'http:') {
                    recordViolation('INSECURE_DOWNGRADE', urlStr, 'HTTPS to HTTP redirect prohibited');
                    return route.abort('blockedbyclient');
                }
            } catch {}
        }

        // 4. Domain allowlist check (if strict domain mode enabled)
        if (!allowAllPublicDomains && allowedDomains.length > 0) {
            const isAllowed = allowedDomains.some(d => {
                const clean = d.toLowerCase();
                return hostname === clean || hostname.endsWith(`.${clean}`);
            });
            const isThirdPartyAllowed = DEFAULT_ALLOWED_THIRD_PARTY_DOMAINS.some(d => hostname.includes(d));

            if (!isAllowed && !isThirdPartyAllowed) {
                recordViolation('DOMAIN_NOT_ALLOWED', urlStr, `Host ${hostname} not in destination allowlist`);
                return route.abort('blockedbyclient');
            }
        }

        return route.continue();
    });

    return {
        securityEvents,
        getViolations() {
            return [...securityEvents];
        }
    };
}
