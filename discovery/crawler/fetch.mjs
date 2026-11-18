/**
 * discovery/crawler/fetch.mjs — Safe HTTP Transport with Socket-Level DNS Pinning & SSRF Hardening
 *
 * Security Guarantees:
 *   - Socket-level DNS lookup validation: eliminates TOCTOU DNS rebinding by validating
 *     every resolved address (A and AAAA) at TCP/TLS connection time.
 *   - The connected socket uses the validated IP while preserving TLS SNI and Host headers.
 *   - Rejection of private, loopback, link-local, multicast, and cloud metadata (169.254.169.254).
 *   - Normalization and validation of IPv4-mapped IPv6 addresses (dotted and hex).
 *   - Hop-by-hop redirect boundary enforcement.
 *   - Response size caps (streaming byte counter) and request timeouts.
 */

import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import { isIP } from 'node:net';
import { isPrivateOrReservedIP, isAllowedHostname } from './safety.mjs';
import { normalizeDomain } from '../../db/repo.mjs';

export class FetchError extends Error {
    constructor(message, code = 'FETCH_ERROR', status = null) {
        super(message);
        this.name = 'FetchError';
        this.code = code;
        this.status = status;
    }
}

export class SSRFBlockedError extends FetchError {
    constructor(message) {
        super(message, 'SSRF_BLOCKED');
        this.name = 'SSRFBlockedError';
    }
}

export class RedirectOutsideBoundaryError extends FetchError {
    constructor(message) {
        super(message, 'REDIRECT_OUTSIDE_BOUNDARY');
        this.name = 'RedirectOutsideBoundaryError';
    }
}

export class FetchTimeoutError extends FetchError {
    constructor(message) {
        super(message, 'FETCH_TIMEOUT');
        this.name = 'FetchTimeoutError';
    }
}

export class FetchSizeExceededError extends FetchError {
    constructor(message) {
        super(message, 'SIZE_EXCEEDED');
        this.name = 'FetchSizeExceededError';
    }
}

export class HttpError extends FetchError {
    constructor(status, statusText, url) {
        super(`HTTP ${status}: ${statusText} for ${url}`, 'HTTP_ERROR', status);
        this.name = 'HttpError';
        this.url = url;
    }
}

const DEFAULT_USER_AGENT = 'CareerOpsJobBot/1.0 (+https://santifer.io/career-ops-bot; contact@santifer.io)';
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_MAX_SIZE_BYTES = 2 * 1024 * 1024; // 2MB
const DEFAULT_MAX_REDIRECTS = 5;

// Per-host rate limiter
const hostLastFetchMap = new Map();

async function applyRateLimit(host, delayMs = 300) {
    if (!host || delayMs <= 0) return;
    const now = Date.now();
    const last = hostLastFetchMap.get(host) || 0;
    const diff = now - last;
    if (diff < delayMs) {
        await new Promise(r => setTimeout(r, delayMs - diff));
    }
    hostLastFetchMap.set(host, Date.now());
}

/**
 * Create a socket lookup function that pins to a validated public IP address
 * and rejects any private, loopback, link-local, or reserved destination.
 *
 * @param {Function} [onAddressPinned]
 * @returns {Function}
 */
export function createPinnedDnsLookup(onAddressPinned) {
    return (hostname, options, callback) => {
        let cb = callback;
        let opts = options;
        if (typeof opts === 'function') {
            cb = opts;
            opts = {};
        }

        if (!isAllowedHostname(hostname)) {
            return cb(new SSRFBlockedError(`Blocked internal/reserved hostname: ${hostname}`));
        }

        if (isIP(hostname)) {
            if (isPrivateOrReservedIP(hostname)) {
                return cb(new SSRFBlockedError(`Direct IP ${hostname} belongs to private/reserved network`));
            }
            if (onAddressPinned) onAddressPinned(hostname, [hostname]);
            const fam = isIP(hostname);
            if (opts && opts.all) {
                return cb(null, [{ address: hostname, family: fam }]);
            }
            return cb(null, hostname, fam);
        }

        dns.lookup(hostname, { all: true }, (err, addresses) => {
            if (err) return cb(err);
            if (!addresses || addresses.length === 0) {
                return cb(new SSRFBlockedError(`DNS resolution returned no addresses for ${hostname}`));
            }

            // Inspect ALL returned A and AAAA addresses
            for (const addr of addresses) {
                if (isPrivateOrReservedIP(addr.address)) {
                    return cb(new SSRFBlockedError(
                        `Destination IP ${addr.address} for host ${hostname} belongs to private/reserved network`
                    ));
                }
            }

            // Filter and pin to verified public addresses
            const verifiedAddresses = addresses.filter(a => !isPrivateOrReservedIP(a.address));
            if (verifiedAddresses.length === 0) {
                return cb(new SSRFBlockedError(`No safe public addresses for ${hostname}`));
            }

            const chosen = verifiedAddresses[0];
            if (onAddressPinned) {
                onAddressPinned(chosen.address, addresses.map(a => a.address));
            }

            if (opts && opts.all) {
                cb(null, verifiedAddresses);
            } else {
                cb(null, chosen.address, chosen.family);
            }
        });
    };
}

/**
 * Execute a single HTTP/HTTPS request with socket-level IP pinning, size caps, and timeouts.
 *
 * @param {string} targetUrl
 * @param {Object} options
 * @returns {Promise<{
 *   statusCode: number,
 *   statusMessage: string,
 *   headers: Object,
 *   body: Buffer,
 *   connectedIp: string|null
 * }>}
 */
function rawPinnedHttpRequest(targetUrl, options) {
    return new Promise((resolve, reject) => {
        let parsed;
        try {
            parsed = new URL(targetUrl);
        } catch {
            return reject(new FetchError(`Malformed URL: ${targetUrl}`, 'INVALID_URL'));
        }

        const isHttps = parsed.protocol === 'https:';
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return reject(new FetchError(`Forbidden protocol: ${parsed.protocol}`, 'FORBIDDEN_PROTOCOL'));
        }

        const hostname = parsed.hostname;
        if (isIP(hostname) && isPrivateOrReservedIP(hostname)) {
            return reject(new SSRFBlockedError(`Direct IP ${hostname} belongs to private/reserved network`));
        }

        let connectedIp = null;
        let allResolvedIps = [];
        const lookupFn = createPinnedDnsLookup((ip, allIps) => {
            connectedIp = ip;
            if (allIps) allResolvedIps = allIps;
        });

        const agentOptions = {
            lookup: lookupFn,
            keepAlive: false
        };

        const agent = isHttps ? new https.Agent(agentOptions) : new http.Agent(agentOptions);
        const port = parsed.port || (isHttps ? 443 : 80);

        const reqOptions = {
            method: 'GET',
            protocol: parsed.protocol,
            host: parsed.hostname,
            port,
            path: parsed.pathname + parsed.search,
            agent,
            headers: {
                'Host': parsed.host,
                'User-Agent': DEFAULT_USER_AGENT,
                'Accept': 'text/html,application/xhtml+xml,application/xml,text/xml,application/ld+json;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Connection': 'close',
                ...(options.headers || {})
            },
            timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS
        };

        // For HTTPS, preserve servername for TLS SNI and certificate validation
        if (isHttps) {
            reqOptions.servername = parsed.hostname;
        }

        const transport = isHttps ? https : http;
        let settled = false;

        const req = transport.request(reqOptions, (res) => {
            const contentLength = res.headers['content-length'];
            const maxBytes = options.maxSizeBytes ?? DEFAULT_MAX_SIZE_BYTES;

            if (contentLength && parseInt(contentLength, 10) > maxBytes) {
                settled = true;
                req.destroy();
                res.destroy();
                return reject(new FetchSizeExceededError(
                    `Content-Length (${contentLength} bytes) exceeds maximum limit (${maxBytes} bytes)`
                ));
            }

            const chunks = [];
            let totalBytes = 0;

            res.on('data', (chunk) => {
                totalBytes += chunk.length;
                if (totalBytes > maxBytes) {
                    settled = true;
                    req.destroy();
                    res.destroy();
                    return reject(new FetchSizeExceededError(
                        `Downloaded body (${totalBytes} bytes) exceeded maximum limit (${maxBytes} bytes)`
                    ));
                }
                chunks.push(chunk);
            });

            res.on('end', () => {
                if (settled) return;
                settled = true;
                const body = Buffer.concat(chunks);
                const socketRemote = res.socket ? res.socket.remoteAddress : null;
                resolve({
                    statusCode: res.statusCode || 200,
                    statusMessage: res.statusMessage || '',
                    headers: res.headers,
                    body,
                    connectedIp,
                    resolvedAddresses: allResolvedIps.length > 0 ? allResolvedIps : (connectedIp ? [connectedIp] : []),
                    socketRemoteAddress: socketRemote
                });
            });

            res.on('error', (err) => {
                if (settled) return;
                settled = true;
                reject(err);
            });
        });

        req.on('timeout', () => {
            if (settled) return;
            settled = true;
            req.destroy();
            reject(new FetchTimeoutError(`Request timed out after ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms for ${targetUrl}`));
        });

        req.on('error', (err) => {
            if (settled) return;
            settled = true;
            if (err.name === 'SSRFBlockedError' || err.code === 'SSRF_BLOCKED') {
                return reject(err);
            }
            if (err.message && err.message.includes('SSRF blocked')) {
                return reject(new SSRFBlockedError(err.message));
            }
            reject(err);
        });

        req.end();
    });
}

/**
 * Safely fetch a resource with socket-level DNS pinning, redirect hop validation, and SSRF hardening.
 *
 * @param {string} urlString
 * @param {Object} [options]
 * @param {number} [options.timeoutMs=10000]
 * @param {number} [options.maxSizeBytes=2097152]
 * @param {string[]} [options.allowedHosts]
 * @param {number} [options.maxRedirects=5]
 * @param {number} [options.rateLimitMs=300]
 * @param {number} [options.retries=1]
 * @param {Object} [options.headers]
 * @returns {Promise<{
 *   text: string,
 *   status: number,
 *   headers: Headers,
 *   finalUrl: string,
 *   connectedIp: string|null
 * }>}
 */
export async function safeFetch(urlString, options = {}) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxSizeBytes = options.maxSizeBytes ?? DEFAULT_MAX_SIZE_BYTES;
    const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
    const allowedHosts = options.allowedHosts ? options.allowedHosts.map(h => normalizeDomain(h)) : null;
    const rateLimitMs = options.rateLimitMs ?? 300;
    const retries = options.retries ?? 1;

    let currentUrl = urlString;
    let redirectCount = 0;

    while (redirectCount <= maxRedirects) {
        let parsedUrl;
        try {
            parsedUrl = new URL(currentUrl);
        } catch {
            throw new FetchError(`Malformed URL: ${currentUrl}`, 'INVALID_URL');
        }

        const normalizedHost = normalizeDomain(parsedUrl.hostname);

        // Host Boundary Check
        if (allowedHosts && allowedHosts.length > 0) {
            const isAllowed = allowedHosts.some(authHost =>
                normalizedHost === authHost || normalizedHost.endsWith(`.${authHost}`)
            );
            if (!isAllowed) {
                throw new RedirectOutsideBoundaryError(
                    `Host "${normalizedHost}" is outside authorized boundary: [${allowedHosts.join(', ')}]`
                );
            }
        }

        // Apply per-host rate limit
        await applyRateLimit(normalizedHost, rateLimitMs);

        let attempt = 0;
        let lastError = null;

        while (attempt <= retries) {
            try {
                const res = await rawPinnedHttpRequest(currentUrl, {
                    timeoutMs,
                    maxSizeBytes,
                    headers: options.headers
                });

                // Check for redirect (301, 302, 303, 307, 308)
                if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
                    const location = res.headers['location'];
                    if (!location) {
                        throw new FetchError(`Redirect status ${res.statusCode} missing Location header`, 'BAD_REDIRECT');
                    }
                    const nextUrl = new URL(location, currentUrl).toString();
                    currentUrl = nextUrl;
                    redirectCount++;
                    break; // Jump to outer loop to validate redirect hop
                }

                if (res.statusCode < 200 || res.statusCode >= 400) {
                    if (res.statusCode >= 500 && attempt < retries) {
                        attempt++;
                        await new Promise(r => setTimeout(r, 500 * attempt));
                        continue;
                    }
                    throw new HttpError(res.statusCode, res.statusMessage, currentUrl);
                }

                // Wrap raw headers into standard Web Headers object for compatibility
                const webHeaders = new Headers();
                for (const [k, v] of Object.entries(res.headers)) {
                    if (Array.isArray(v)) {
                        for (const item of v) webHeaders.append(k, item);
                    } else if (v !== undefined) {
                        webHeaders.set(k, v);
                    }
                }

                return {
                    text: res.body.toString('utf8'),
                    status: res.statusCode,
                    statusCode: res.statusCode,
                    headers: webHeaders,
                    finalUrl: currentUrl,
                    connectedIp: res.connectedIp,
                    resolvedAddresses: res.resolvedAddresses || [],
                    socketRemoteAddress: res.socketRemoteAddress || null
                };
            } catch (err) {
                if (err instanceof SSRFBlockedError || err instanceof RedirectOutsideBoundaryError || err instanceof FetchSizeExceededError) {
                    throw err; // Security/boundary violations must not be retried
                }
                if (err instanceof HttpError && err.status < 500) {
                    throw err; // Client 4xx errors must not be retried
                }
                lastError = err;
                attempt++;
                if (attempt <= retries) {
                    await new Promise(r => setTimeout(r, 500 * attempt));
                }
            }
        }

        if (lastError) {
            if (lastError instanceof FetchError) throw lastError;
            throw new FetchError(`Fetch failed for ${currentUrl}: ${lastError.message}`, 'NETWORK_ERROR');
        }
    }

    throw new FetchError(`Too many redirects (exceeded ${maxRedirects}) for ${urlString}`, 'TOO_MANY_REDIRECTS');
}
