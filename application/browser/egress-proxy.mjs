/**
 * application/browser/egress-proxy.mjs — Controlled Network Egress Proxy
 *
 * Implements Milestone 3D Part 5:
 *   - Controlled egress proxy for Chromium browser traffic
 *   - Socket-level DNS resolution validation & pinning
 *   - Strict blocking of loopback, private (RFC 1918), link-local (169.254/16),
 *     cloud metadata (AWS/GCP/Azure), and IPv6 private/mapped ranges
 *   - Protection against DNS rebinding (validates all resolved A/AAAA records)
 *   - Preserves TLS SNI for legitimate external HTTPS portals & CDNs
 */

import http from 'http';
import net from 'net';
import dns from 'dns';
import { URL } from 'url';

/**
 * Checks if an IPv4 address is in a private, loopback, link-local, or reserved range.
 */
export function isPrivateIPv4(ip) {
    if (!ip || typeof ip !== 'string') return true;
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some(p => isNaN(p) || p < 0 || p > 255)) return true;

    const [a, b, c, d] = parts;

    // 0.0.0.0/8 (Current network)
    if (a === 0) return true;
    // 10.0.0.0/8 (Private)
    if (a === 10) return true;
    // 127.0.0.0/8 (Loopback)
    if (a === 127) return true;
    // 169.254.0.0/16 (Link-local / Cloud metadata: 169.254.169.254)
    if (a === 169 && b === 254) return true;
    // 172.16.0.0/12 (Private: 172.16.0.0 – 172.31.255.255)
    if (a === 172 && b >= 16 && b <= 31) return true;
    // 192.168.0.0/16 (Private)
    if (a === 192 && b === 168) return true;
    // 100.64.0.0/10 (Carrier-grade NAT)
    if (a === 100 && b >= 64 && b <= 127) return true;
    // 192.0.0.0/24 (IETF Protocol Assignments)
    if (a === 192 && b === 0 && c === 0) return true;
    // 192.0.2.0/24 (TEST-NET-1)
    if (a === 192 && b === 0 && c === 2) return true;
    // 198.51.100.0/24 (TEST-NET-2)
    if (a === 198 && b === 51 && c === 100) return true;
    // 203.0.113.0/24 (TEST-NET-3)
    if (a === 203 && b === 0 && c === 113) return true;
    // 224.0.0.0/4 (Multicast)
    if (a >= 224 && a <= 239) return true;
    // 240.0.0.0/4 (Reserved)
    if (a >= 240) return true;
    // Broadcast
    if (a === 255 && b === 255 && c === 255 && d === 255) return true;

    return false;
}

/**
 * Checks if an IPv6 address is in a private, loopback, link-local, or mapped range.
 */
export function isPrivateIPv6(ip) {
    if (!ip || typeof ip !== 'string') return true;
    const clean = ip.toLowerCase().trim();

    // Loopback
    if (clean === '::1' || clean === '0:0:0:0:0:0:0:1') return true;
    // Unspecified
    if (clean === '::' || clean === '0:0:0:0:0:0:0:0') return true;

    // IPv4-mapped IPv6 (::ffff:127.0.0.1 or hex ::ffff:7f00:1)
    if (clean.startsWith('::ffff:')) {
        const rest = clean.slice(7);
        if (rest.includes('.')) {
            return isPrivateIPv4(rest);
        }
        const hexParts = rest.split(':');
        if (hexParts.length === 2) {
            const high = parseInt(hexParts[0], 16);
            const low = parseInt(hexParts[1], 16);
            if (!isNaN(high) && !isNaN(low)) {
                const b1 = (high >> 8) & 0xff;
                const b2 = high & 0xff;
                const b3 = (low >> 8) & 0xff;
                const b4 = low & 0xff;
                return isPrivateIPv4(`${b1}.${b2}.${b3}.${b4}`);
            }
        }
        return true;
    }

    // Link-local (fe80::/10)
    if (clean.startsWith('fe8') || clean.startsWith('fe9') || clean.startsWith('fea') || clean.startsWith('feb')) {
        return true;
    }
    // Unique local (fc00::/7 -> fc00... or fd00...)
    if (clean.startsWith('fc') || clean.startsWith('fd')) {
        return true;
    }

    return false;
}

/**
 * Checks if a hostname is an internal, local, or metadata hostname.
 */
export function isInternalHostname(hostname) {
    if (!hostname || typeof hostname !== 'string') return true;
    const lower = hostname.toLowerCase().trim();

    if (lower === 'localhost' || lower.endsWith('.localhost')) return true;
    if (lower.endsWith('.local') || lower.endsWith('.internal') || lower.endsWith('.lan')) return true;
    if (lower === 'metadata.google.internal' || lower === 'metadata' || lower === 'instance-data') return true;

    // Check if hostname is directly an IP literal
    if (net.isIPv4(lower)) return isPrivateIPv4(lower);
    if (net.isIPv6(lower)) return isPrivateIPv6(lower);

    return false;
}

/**
 * Class representing an egress security violation.
 */
export class EgressSecurityError extends Error {
    constructor(message, reason, target) {
        super(message);
        this.name = 'EgressSecurityError';
        this.reason = reason;
        this.target = target;
    }
}

/**
 * Validates target host, resolves DNS, checks all IP records, and returns pinned IP.
 */
export async function validateHostDns(hostname, options = {}) {
    const { dnsResolver = null, destinationPolicy = null } = options;

    if (isInternalHostname(hostname)) {
        throw new EgressSecurityError(`Host is an internal or reserved name: ${hostname}`, 'INTERNAL_HOSTNAME', hostname);
    }

    if (destinationPolicy && typeof destinationPolicy === 'function') {
        const allowed = destinationPolicy(hostname);
        if (!allowed) {
            throw new EgressSecurityError(`Destination blocked by destination policy: ${hostname}`, 'POLICY_DISALLOWED', hostname);
        }
    }

    // If directly an IP
    if (net.isIPv4(hostname)) {
        if (isPrivateIPv4(hostname)) {
            throw new EgressSecurityError(`Direct private IPv4 forbidden: ${hostname}`, 'PRIVATE_IP', hostname);
        }
        return hostname;
    }
    if (net.isIPv6(hostname)) {
        if (isPrivateIPv6(hostname)) {
            throw new EgressSecurityError(`Direct private IPv6 forbidden: ${hostname}`, 'PRIVATE_IP', hostname);
        }
        return hostname;
    }

    // Perform DNS resolution
    let addresses = [];
    if (dnsResolver) {
        addresses = await dnsResolver(hostname);
    } else {
        const resolve4 = dns.promises.resolve4(hostname).catch(() => []);
        const resolve6 = dns.promises.resolve6(hostname).catch(() => []);
        const [v4, v6] = await Promise.all([resolve4, resolve6]);
        addresses = [...v4, ...v6];
    }

    if (!addresses || addresses.length === 0) {
        throw new EgressSecurityError(`DNS resolution returned no addresses for ${hostname}`, 'DNS_NO_ADDRESS', hostname);
    }

    // Anti-Rebinding Check: Every single resolved IP must be public!
    for (const addr of addresses) {
        if (net.isIPv4(addr) && isPrivateIPv4(addr)) {
            throw new EgressSecurityError(`DNS resolved private IPv4 (${addr}) for ${hostname}`, 'DNS_REBINDING_PRIVATE_IP', hostname);
        }
        if (net.isIPv6(addr) && isPrivateIPv6(addr)) {
            throw new EgressSecurityError(`DNS resolved private IPv6 (${addr}) for ${hostname}`, 'DNS_REBINDING_PRIVATE_IP', hostname);
        }
    }

    // Return first validated address for socket pinning
    return addresses[0];
}

/**
 * Creates and starts a secure egress proxy server.
 */
export async function startEgressProxy(options = {}) {
    const {
        port = 0,
        host = '127.0.0.1',
        dnsResolver = null,
        destinationPolicy = null, // Optional function (domain) => boolean
        logger = null
    } = options;

    const telemetry = {
        connectionsAttempted: 0,
        connectionsAllowed: 0,
        connectionsBlocked: 0,
        blockedReasons: {}
    };

    function log(msg, extra = null) {
        if (logger) logger(msg, extra);
    }

    function recordBlock(reason, target) {
        telemetry.connectionsBlocked++;
        telemetry.blockedReasons[reason] = (telemetry.blockedReasons[reason] || 0) + 1;
        log(`[EgressProxy BLOCKED] ${reason} on ${target}`);
    }

    const server = http.createServer(async (req, res) => {
        telemetry.connectionsAttempted++;
        let targetUrl;
        try {
            targetUrl = new URL(req.url);
        } catch {
            // For relative URLs in proxy requests
            const hostHeader = req.headers.host || '';
            try {
                targetUrl = new URL(`http://${hostHeader}${req.url}`);
            } catch {
                recordBlock('MALFORMED_URL', req.url);
                res.writeHead(400, { 'Content-Type': 'text/plain' });
                return res.end('Malformed URL');
            }
        }

        const targetHostname = targetUrl.hostname;
        const targetPort = targetUrl.port || 80;

        let pinnedIp;
        try {
            pinnedIp = await validateHostDns(targetHostname, { dnsResolver, destinationPolicy });
        } catch (err) {
            recordBlock(err.reason || 'SECURITY_VIOLATION', targetHostname);
            res.writeHead(403, {
                'Content-Type': 'text/plain',
                'X-Blocked-Reason': err.reason || 'EGRESS_BLOCKED'
            });
            return res.end(`Egress blocked: ${err.message}`);
        }

        // Forward HTTP request to pinned IP with original Host header
        const outbound = http.request({
            host: pinnedIp,
            port: targetPort,
            path: targetUrl.pathname + targetUrl.search,
            method: req.method,
            headers: {
                ...req.headers,
                host: targetUrl.host
            }
        }, (outboundRes) => {
            telemetry.connectionsAllowed++;
            res.writeHead(outboundRes.statusCode, outboundRes.headers);
            outboundRes.pipe(res);
        });

        outbound.on('error', (err) => {
            log(`Outbound HTTP error: ${err.message}`);
            if (!res.headersSent) {
                res.writeHead(502, { 'Content-Type': 'text/plain' });
                res.end(`Bad Gateway: ${err.message}`);
            }
        });

        req.pipe(outbound);
    });

    // Handle HTTPS CONNECT tunneling
    server.on('connect', async (req, clientSocket, head) => {
        telemetry.connectionsAttempted++;
        const [targetHost, targetPortStr] = req.url.split(':');
        const targetPort = parseInt(targetPortStr, 10) || 443;

        let pinnedIp;
        try {
            pinnedIp = await validateHostDns(targetHost, { dnsResolver, destinationPolicy });
        } catch (err) {
            recordBlock(err.reason || 'SECURITY_VIOLATION', targetHost);
            clientSocket.write(`HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nX-Blocked-Reason: ${err.reason || 'EGRESS_BLOCKED'}\r\n\r\nBlocked: ${err.message}`);
            clientSocket.destroy();
            return;
        }

        // Establish TCP connection directly to validated, pinned IP
        const outboundSocket = net.connect({ host: pinnedIp, port: targetPort }, () => {
            telemetry.connectionsAllowed++;
            clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (head && head.length > 0) {
                outboundSocket.write(head);
            }
            outboundSocket.pipe(clientSocket);
            clientSocket.pipe(outboundSocket);
        });

        outboundSocket.on('error', (err) => {
            log(`Outbound CONNECT error: ${err.message}`);
            clientSocket.destroy();
        });

        clientSocket.on('error', () => {
            outboundSocket.destroy();
        });
    });

    await new Promise((resolve, reject) => {
        server.listen(port, host, () => resolve());
        server.on('error', reject);
    });

    const addr = server.address();
    const proxyUrl = `http://${host}:${addr.port}`;

    return {
        server,
        port: addr.port,
        host,
        url: proxyUrl,
        telemetry,
        async stop() {
            return new Promise((resolve) => server.close(() => resolve()));
        }
    };
}
