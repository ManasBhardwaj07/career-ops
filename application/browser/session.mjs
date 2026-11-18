/**
 * application/browser/session.mjs — Browser Session Management & Authentication Handoff
 *
 * Implements Milestone 3D Part 4:
 *   - Persistent Playwright browser session (`launchPersistentContext`)
 *   - Headful by default for application preparation, headless support for testing
 *   - Isolated local user data directory
 *   - Integration with controlled egress proxy & defense-in-depth security
 *   - Authentication handoff, MFA/CAPTCHA pause, and safe recovery
 */

import { mkdirSync, existsSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';
import { startEgressProxy } from './egress-proxy.mjs';
import { attachBrowserSecurity } from './security.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROFILE_DIR = resolve(__dirname, '../../data/browser_profile');

/**
 * Detects locally installed standard web browsers on Windows / host OS.
 * Prioritizes Google Chrome, then Microsoft Edge.
 */
export function detectInstalledBrowser(preferredBrowser = process.env.CAREER_OPS_BROWSER) {
    const isWin = process.platform === 'win32';
    if (!isWin) {
        return null;
    }

    const chromeCandidates = [
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe')
    ];

    const edgeCandidates = [
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        join(process.env.LOCALAPPDATA || '', 'Microsoft\\Edge\\Application\\msedge.exe')
    ];

    const prefersEdge = preferredBrowser && (preferredBrowser.toLowerCase() === 'edge' || preferredBrowser.toLowerCase() === 'msedge');

    if (prefersEdge) {
        for (const p of edgeCandidates) {
            if (p && existsSync(p)) {
                return {
                    name: 'msedge',
                    channel: 'msedge',
                    executablePath: p
                };
            }
        }
    }

    for (const p of chromeCandidates) {
        if (p && existsSync(p)) {
            return {
                name: 'chrome',
                channel: 'chrome',
                executablePath: p
            };
        }
    }

    for (const p of edgeCandidates) {
        if (p && existsSync(p)) {
            return {
                name: 'msedge',
                channel: 'msedge',
                executablePath: p
            };
        }
    }

    return null;
}

/**
 * Creates and launches a secure, persistent browser session.
 */
export async function createBrowserSession(options = {}) {
    const {
        headless = false,
        profileDir = DEFAULT_PROFILE_DIR,
        enableEgressProxy = true,
        allowedDomains = [],
        allowAllPublicDomains = true,
        allowedLocalOrigins = [],
        logger = null,
        viewport = { width: 1280, height: 900 }
    } = options;

    mkdirSync(profileDir, { recursive: true });

    let egressProxy = null;
    let proxyConfig = undefined;

    if (enableEgressProxy) {
        egressProxy = await startEgressProxy({
            logger: (msg) => { if (logger) logger(`[Egress] ${msg}`); }
        });
        proxyConfig = {
            server: egressProxy.url
        };
    }

    const launchArgs = [
        '--no-default-browser-check',
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage'
    ];

    const preferred = options.browser || options.channel || process.env.CAREER_OPS_BROWSER;
    const detectedBrowser = detectInstalledBrowser(preferred);
    const contextOptions = {
        headless,
        viewport,
        proxy: proxyConfig,
        args: launchArgs,
        acceptDownloads: false,
        serviceWorkers: 'block' // Defense-in-depth: block service workers to guarantee route interception
    };

    if (options.executablePath) {
        contextOptions.executablePath = options.executablePath;
    } else if (options.channel) {
        contextOptions.channel = options.channel === 'edge' ? 'msedge' : options.channel;
    } else if (options.browser === 'edge' || options.browser === 'msedge') {
        contextOptions.channel = 'msedge';
    } else if (!options.useBundledChromium && detectedBrowser?.channel && !headless) {
        contextOptions.channel = detectedBrowser.channel;
    }

    const context = await chromium.launchPersistentContext(profileDir, contextOptions);

    // Tab crash and disconnect resilience
    context.on('page', (p) => {
        p.on('crash', () => {
            if (logger) logger('[Session Error] Page crashed in browser session.');
        });
    });

    // Attach defense-in-depth route security
    const security = await attachBrowserSecurity(context, {
        allowedDomains,
        allowAllPublicDomains,
        allowedLocalOrigins,
        logger: (msg) => { if (logger) logger(`[Security] ${msg}`); }
    });

    const session = {
        context,
        egressProxy,
        security,
        profileDir,
        headless,
        browserInfo: {
            name: contextOptions.channel || detectedBrowser?.name || 'chromium',
            executablePath: contextOptions.executablePath || detectedBrowser?.executablePath || 'bundled',
            channel: contextOptions.channel || null,
            profileDir,
            headless
        },

        /**
         * Opens or retrieves the active page.
         */
        async getPage() {
            const pages = context.pages();
            if (pages.length > 0) return pages[0];
            return context.newPage();
        },

        /**
         * Navigates safely to an application portal.
         */
        async navigate(url, { waitUntil = 'domcontentloaded', timeout = 30000 } = {}) {
            const page = await session.getPage();
            return page.goto(url, { waitUntil, timeout });
        },

        /**
         * Pauses execution for manual user authentication or CAPTCHA resolution.
         */
        async pauseForHumanIntervention(page, {
            reason = 'Manual intervention required',
            checkResolvedFn = null,
            timeoutMs = 300000 // 5 minutes max wait
        } = {}) {
            if (logger) logger(`[Session PAUSE] ${reason}. Please complete in browser window...`);

            const startTime = Date.now();
            while (Date.now() - startTime < timeoutMs) {
                if (checkResolvedFn) {
                    try {
                        const resolved = await checkResolvedFn(page);
                        if (resolved) {
                            if (logger) logger('[Session RESUMED] Human intervention verified resolved.');
                            return { resolved: true, waitedMs: Date.now() - startTime };
                        }
                    } catch {}
                }
                await new Promise((r) => setTimeout(r, 1000));
            }

            return { resolved: false, timedOut: true, waitedMs: timeoutMs };
        },

        /**
         * Shuts down context and egress proxy cleanly.
         */
        async close() {
            try {
                await context.close();
            } catch {}
            if (egressProxy) {
                try {
                    await egressProxy.stop();
                } catch {}
            }
        }
    };

    return session;
}
