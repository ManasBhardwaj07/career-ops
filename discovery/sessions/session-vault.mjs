/**
 * discovery/sessions/session-vault.mjs — Secure Portal Session Vault
 *
 * Manages persistent authenticated session cookies and headers for walled-garden
 * portals (Cutshort, Instahyre, Wellfound).
 *
 * Rules:
 * - Session data is stored strictly in `data/sessions/` which is in .gitignore.
 * - Never logs or exposes auth tokens or sensitive session credentials.
 * - Handles expiration checking and missing-session detection gracefully.
 */

import fs from 'fs';
import path from 'path';

export const SESSION_VAULT_DIR = path.resolve('data/sessions');

export class SessionVault {
    constructor(baseDir = SESSION_VAULT_DIR) {
        this.baseDir = baseDir;
    }

    getSessionDir(portal) {
        const cleanName = String(portal).toLowerCase().replace(/[^a-z0-9_-]/g, '');
        return path.join(this.baseDir, cleanName);
    }

    getSessionPath(portal) {
        return path.join(this.getSessionDir(portal), 'session.json');
    }

    /**
     * Loads session data for a given portal.
     * Returns object or null if not found or corrupted.
     */
    loadSession(portal) {
        const sessionPath = this.getSessionPath(portal);
        if (!fs.existsSync(sessionPath)) {
            return null;
        }

        try {
            const raw = fs.readFileSync(sessionPath, 'utf8');
            const data = JSON.parse(raw);
            return data;
        } catch {
            return null;
        }
    }

    /**
     * Saves session data for a given portal.
     */
    saveSession(portal, sessionData) {
        const dir = this.getSessionDir(portal);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        const payload = {
            portal,
            savedAt: new Date().toISOString(),
            expiresAt: sessionData.expiresAt || null,
            cookies: Array.isArray(sessionData.cookies) ? sessionData.cookies : [],
            headers: sessionData.headers || {},
            metadata: sessionData.metadata || {}
        };

        const sessionPath = this.getSessionPath(portal);
        fs.writeFileSync(sessionPath, JSON.stringify(payload, null, 2), 'utf8');
        return payload;
    }

    /**
     * Clears session data for a given portal.
     */
    clearSession(portal) {
        const sessionPath = this.getSessionPath(portal);
        if (fs.existsSync(sessionPath)) {
            try {
                fs.unlinkSync(sessionPath);
                return true;
            } catch {
                return false;
            }
        }
        return false;
    }

    /**
     * Checks if a valid, unexpired session exists for the portal.
     */
    hasValidSession(portal) {
        const session = this.loadSession(portal);
        if (!session) return false;

        if (!Array.isArray(session.cookies) || session.cookies.length === 0) {
            // If headers has Authorization or token, it might still be valid
            if (!session.headers || (!session.headers.authorization && !session.headers.Authorization)) {
                return false;
            }
        }

        // Check overall session expiry if explicitly set
        if (session.expiresAt) {
            const expTime = new Date(session.expiresAt).getTime();
            if (!isNaN(expTime) && Date.now() >= expTime) {
                return false;
            }
        }

        // Check cookie expiry timestamps if present
        if (Array.isArray(session.cookies)) {
            const nowSec = Math.floor(Date.now() / 1000);
            const authCookies = session.cookies.filter(c => {
                const name = (c.name || '').toLowerCase();
                return name.includes('auth') || name.includes('session') || name.includes('token') || name.includes('id');
            });

            if (authCookies.length > 0) {
                // If all auth cookies are expired, session is expired
                const allExpired = authCookies.every(c => typeof c.expires === 'number' && c.expires > 0 && c.expires < nowSec);
                if (allExpired) {
                    return false;
                }
            }
        }

        return true;
    }

    /**
     * Builds standard cookie header string from session cookies.
     */
    getCookieHeader(portal) {
        const session = this.loadSession(portal);
        if (!session || !Array.isArray(session.cookies) || session.cookies.length === 0) {
            return '';
        }
        return session.cookies
            .filter(c => c && c.name && c.value !== undefined)
            .map(c => `${c.name}=${c.value}`)
            .join('; ');
    }
}

export const sessionVault = new SessionVault();
