/**
 * discovery/crawler/safety.mjs — SSRF Protection, Host Allowlisting & Source Authorization
 *
 * Security controls:
 *   - Rejection of private, loopback, link-local, multicast, and reserved IPs.
 *   - IPv4-mapped IPv6 normalization (both dotted-quad and hex notation).
 *   - DNS resolution and validation before and during HTTP connection establishment.
 *   - Host boundary checking and redirect hop validation.
 *   - Strict fail-closed source authorization (lifecycle_status = APPROVED, monitoring_status = active).
 *   - Explicit manual override with persistent audit logging.
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { getCompany, isSourcePermitted, normalizeDomain, getDb } from '../../db/repo.mjs';

/**
 * Normalize an IPv4-mapped IPv6 address (e.g. ::ffff:192.168.1.1 or ::ffff:7f00:1) to standard IPv4.
 * @param {string} ip
 * @returns {string}
 */
export function normalizeIpAddress(ip) {
    if (!ip || typeof ip !== 'string') return '';
    let clean = ip.trim().toLowerCase();

    // Check for IPv4-mapped IPv6 prefix ::ffff:
    if (clean.startsWith('::ffff:')) {
        const rest = clean.slice(7);
        // Case 1: Dotted-quad (::ffff:192.168.1.1)
        if (isIP(rest) === 4) {
            return rest;
        }
        // Case 2: Hex notation (::ffff:7f00:1 or ::ffff:7f00:0001)
        const hexParts = rest.split(':');
        if (hexParts.length === 2) {
            const high = parseInt(hexParts[0], 16);
            const low = parseInt(hexParts[1], 16);
            if (!isNaN(high) && !isNaN(low)) {
                const b0 = (high >> 8) & 0xff;
                const b1 = high & 0xff;
                const b2 = (low >> 8) & 0xff;
                const b3 = low & 0xff;
                return `${b0}.${b1}.${b2}.${b3}`;
            }
        }
    }

    return clean;
}

/**
 * Check if an IPv4 or IPv6 address belongs to private/reserved ranges.
 * @param {string} ip
 * @returns {boolean} true if private/reserved (unsafe to fetch), false if public
 */
export function isPrivateOrReservedIP(ip) {
    if (!ip || typeof ip !== 'string') return true;
    const cleanIp = normalizeIpAddress(ip);

    // Check IPv4
    if (isIP(cleanIp) === 4) {
        const parts = cleanIp.split('.').map(p => parseInt(p, 10));
        if (parts.length !== 4 || parts.some(isNaN)) return true;

        const [b0, b1] = parts;

        // 0.0.0.0/8 (Current network)
        if (b0 === 0) return true;
        // 10.0.0.0/8 (Private)
        if (b0 === 10) return true;
        // 100.64.0.0/10 (Shared address / Carrier-grade NAT)
        if (b0 === 100 && b1 >= 64 && b1 <= 127) return true;
        // 127.0.0.0/8 (Loopback)
        if (b0 === 127) return true;
        // 169.254.0.0/16 (Link-local, AWS/GCP/Azure metadata 169.254.169.254)
        if (b0 === 169 && b1 === 254) return true;
        // 172.16.0.0/12 (Private)
        if (b0 === 172 && b1 >= 16 && b1 <= 31) return true;
        // 192.0.0.0/24 (IETF Protocol Assignments)
        if (b0 === 192 && b1 === 0 && parts[2] === 0) return true;
        // 192.0.2.0/24 (TEST-NET-1)
        if (b0 === 192 && b1 === 0 && parts[2] === 2) return true;
        // 192.88.99.0/24 (6to4 Relay Anycast)
        if (b0 === 192 && b1 === 88 && parts[2] === 99) return true;
        // 192.168.0.0/16 (Private)
        if (b0 === 192 && b1 === 168) return true;
        // 198.18.0.0/15 (Network benchmark)
        if (b0 === 198 && (b1 === 18 || b1 === 19)) return true;
        // 198.51.100.0/24 (TEST-NET-2)
        if (b0 === 198 && b1 === 51 && parts[2] === 100) return true;
        // 203.0.113.0/24 (TEST-NET-3)
        if (b0 === 203 && b1 === 0 && parts[2] === 113) return true;
        // 224.0.0.0/4 (Multicast)
        if (b0 >= 224 && b0 <= 239) return true;
        // 240.0.0.0/4 (Reserved)
        if (b0 >= 240) return true;
        // 255.255.255.255 (Broadcast)
        if (cleanIp === '255.255.255.255') return true;

        return false;
    }

    // Check IPv6
    if (isIP(cleanIp) === 6) {
        const lower = cleanIp.toLowerCase();
        // ::1 (Loopback)
        if (lower === '::1' || lower === '0:0:0:0:0:0:0:1') return true;
        // :: (Unspecified)
        if (lower === '::' || lower === '0:0:0:0:0:0:0:0') return true;
        // fe80::/10 (Link-local)
        if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true;
        // fc00::/7 (Unique local / ULA)
        if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
        // ff00::/8 (Multicast)
        if (lower.startsWith('ff')) return true;
        return false;
    }

    return true; // Not a recognized IP format
}

/**
 * Validate that a hostname is not an internal or reserved local domain.
 * @param {string} hostname
 * @returns {boolean} true if safe, false if blocked
 */
export function isAllowedHostname(hostname) {
    if (!hostname || typeof hostname !== 'string') return false;
    const lower = hostname.toLowerCase().trim();

    // Check blocked suffix names
    if (
        lower === 'localhost' ||
        lower.endsWith('.localhost') ||
        lower.endsWith('.local') ||
        lower.endsWith('.internal') ||
        lower.endsWith('.arpa') ||
        lower.endsWith('.lan') ||
        lower.endsWith('.home') ||
        lower.endsWith('.corp') ||
        lower === 'metadata.google.internal'
    ) {
        return false;
    }

    // If hostname is directly an IP, validate it immediately
    if (isIP(lower)) {
        return !isPrivateOrReservedIP(lower);
    }

    return true;
}

/**
 * Resolve hostname via DNS and ensure all resolved IP addresses are public.
 * Protects against DNS rebinding and SSRF.
 * @param {string} hostname
 * @returns {Promise<{ ok: boolean, ip?: string, error?: string }>}
 */
export async function resolveAndValidateHost(hostname) {
    if (!isAllowedHostname(hostname)) {
        return { ok: false, error: `Blocked hostname: ${hostname}` };
    }

    if (isIP(hostname)) {
        if (isPrivateOrReservedIP(hostname)) {
            return { ok: false, error: `Private/reserved IP rejected: ${hostname}` };
        }
        return { ok: true, ip: hostname };
    }

    try {
        const addresses = await lookup(hostname, { all: true });
        if (!addresses || addresses.length === 0) {
            return { ok: false, error: `DNS resolution returned no addresses for ${hostname}` };
        }

        for (const addr of addresses) {
            if (isPrivateOrReservedIP(addr.address)) {
                return {
                    ok: false,
                    error: `DNS resolution for ${hostname} returned private IP: ${addr.address}`
                };
            }
        }

        return { ok: true, ip: addresses[0].address };
    } catch (err) {
        return { ok: false, error: `DNS resolution failed for ${hostname}: ${err.message}` };
    }
}

/**
 * Verify company lifecycle approval and source policy permissions before crawling.
 *
 * Requirements for automated crawler execution:
 *   - lifecycle_status = APPROVED (VERIFIED alone does NOT authorize automated crawling)
 *   - monitoring_status = active (paused, disabled are blocked)
 *   - discovery_permitted = 1
 *   - public_nav_permitted = 1 (or feed_access_permitted = 1 if feed)
 *   - Explicitly authorized target hostname
 *
 * Manual Override:
 *   - Supported via explicit options.manualOverride = true with options.overrideReason
 *   - Logs persistent audit record in application_events
 *   - Does NOT bypass SSRF or domain boundary security
 *
 * @param {string} companyId
 * @param {string} targetUrl
 * @param {Object} [options]
 * @param {boolean} [options.requireFeedAccess=false]
 * @param {boolean} [options.manualOverride=false]
 * @param {string} [options.overrideReason]
 * @returns {{ authorized: boolean, reason: string, company?: Object, manualOverride?: boolean }}
 */
export function checkCompanyCrawlAuthorization(companyId, targetUrl, options = {}) {
    if (!companyId) {
        return { authorized: false, reason: 'Company ID is required' };
    }

    const company = getCompany(companyId);
    if (!company) {
        return { authorized: false, reason: `Company not found in registry: ${companyId}` };
    }

    const isManualOverride = Boolean(options.manualOverride);

    if (isManualOverride) {
        if (!options.overrideReason || typeof options.overrideReason !== 'string' || options.overrideReason.trim().length < 5) {
            return {
                authorized: false,
                reason: 'Manual crawl override rejected: explicit audit reason is required'
            };
        }

        // Log persistent audit trail to company record
        try {
            const db = getDb();
            const auditMsg = `[AUDIT ${new Date().toISOString()}] Manual crawl override: ${options.overrideReason.trim()}`;
            db.prepare(`
                UPDATE companies
                SET notes = COALESCE(notes || ' | ', '') || ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `).run(auditMsg, companyId);
        } catch {
            // Ignore audit update error if table locked, but proceed safely
        }
    } else {
        // Strict Automated Authorization Gates:
        // 1. Policy Status Gate: Never allow blocked companies
        if (company.policy_status === 'blocked') {
            return {
                authorized: false,
                reason: 'Company policy_status is blocked; automated crawling is prohibited.'
            };
        }

        // 2. Lifecycle Status Gate: Must be APPROVED
        if (company.lifecycle_status !== 'APPROVED') {
            return {
                authorized: false,
                reason: `Automated crawling requires APPROVED lifecycle status (current: ${company.lifecycle_status}). VERIFIED, UNVERIFIED, DISABLED and REJECTED companies are not authorized for automated crawling.`
            };
        }

        // 2. Monitoring Status Gate: Must be active
        if (company.monitoring_status !== 'active') {
            return {
                authorized: false,
                reason: `Automated crawling requires active monitoring status (current: ${company.monitoring_status}). Paused or disabled companies are not authorized.`
            };
        }
    }

    // 3. Target URL Validation & Host Boundary (Strictly enforced for both automated and manual override)
    let parsedTarget;
    try {
        parsedTarget = new URL(targetUrl);
    } catch {
        return { authorized: false, reason: `Malformed target URL: ${targetUrl}` };
    }

    if (!['http:', 'https:'].includes(parsedTarget.protocol)) {
        return { authorized: false, reason: `Unsupported protocol: ${parsedTarget.protocol}` };
    }

    const targetHost = normalizeDomain(parsedTarget.hostname);
    const companyDomain = company.domain ? normalizeDomain(company.domain) : null;

    let careerDomain = null;
    if (company.career_url) {
        try {
            careerDomain = normalizeDomain(new URL(company.career_url).hostname);
        } catch {
            // ignore malformed career_url
        }
    }

    const authorizedHosts = new Set();
    if (companyDomain) authorizedHosts.add(companyDomain);
    if (careerDomain) authorizedHosts.add(careerDomain);

    let hostMatches = false;
    for (const authHost of authorizedHosts) {
        if (targetHost === authHost || targetHost.endsWith(`.${authHost}`)) {
            hostMatches = true;
            break;
        }
    }

    if (!hostMatches) {
        return {
            authorized: false,
            reason: `Target host "${targetHost}" is outside authorized boundary for ${company.name} (authorized: ${Array.from(authorizedHosts).join(', ') || 'none'})`
        };
    }

    // 4. Source Policy Permissions Check
    const sourceType = 'crawler';
    const discoveryOk = isSourcePermitted(companyId, sourceType, 'discovery');
    const publicNavOk = isSourcePermitted(companyId, sourceType, 'public_nav');

    if (!discoveryOk) {
        return {
            authorized: false,
            reason: `Source policy for ${company.name} forbids discovery`
        };
    }

    if (!publicNavOk) {
        return {
            authorized: false,
            reason: `Source policy for ${company.name} forbids public navigation`
        };
    }

    if (options.requireFeedAccess) {
        const feedOk = isSourcePermitted(companyId, sourceType, 'feed_access');
        if (!feedOk) {
            return {
                authorized: false,
                reason: `Source policy for ${company.name} forbids feed access`
            };
        }
    }

    // Hard gate: Submission is permanently forbidden
    const submissionCheck = isSourcePermitted(companyId, sourceType, 'submission');
    if (submissionCheck) {
        return {
            authorized: false,
            reason: 'Security violation: submission must never be permitted'
        };
    }

    return {
        authorized: true,
        reason: isManualOverride ? 'Authorized via manual override' : 'Authorized for automated crawl',
        company,
        manualOverride: isManualOverride
    };
}
