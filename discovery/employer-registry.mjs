/**
 * discovery/employer-registry.mjs — Verified Employer Registry Manager
 *
 * Exposes the structured, verified employer registry (141+ employers) across:
 * - Indian IT Services (TCS, Infosys, Wipro, HCLTech, Tech Mahindra, LTIMindtree, etc.)
 * - Global IT Services & Consulting (Accenture, IBM, DXC, Deloitte, EY, PwC, etc.)
 * - Product and Enterprise Technology (Microsoft, Amazon, Google, Cisco, Oracle, etc.)
 * - Hardware & Semiconductors (Intel, NVIDIA, AMD, Qualcomm, etc.)
 * - FinTech & Financial Institutions (JPMorgan, Goldman Sachs, Morgan Stanley, etc.)
 * - Indian Startups & Unicorns (Flipkart, Swiggy, Zomato, PhonePe, Razorpay, etc.)
 *
 * Conforms to Rule 16: Zero fake records or fabricated career URLs.
 */

import fs from 'fs';
import path from 'path';

export const EMPLOYER_REGISTRY_PATH = path.resolve('data/employer_registry.json');

export class EmployerRegistry {
    constructor(registryPath = EMPLOYER_REGISTRY_PATH) {
        this.registryPath = registryPath;
        this._employers = null;
        this._byId = new Map();
        this._byDomain = new Map();
        this._byName = new Map();
    }

    _load() {
        if (this._employers) return;

        if (!fs.existsSync(this.registryPath)) {
            this._employers = [];
            return;
        }

        try {
            const raw = fs.readFileSync(this.registryPath, 'utf8');
            this._employers = JSON.parse(raw);
        } catch {
            this._employers = [];
        }

        for (const emp of this._employers) {
            if (emp.id) this._byId.set(emp.id.toLowerCase(), emp);
            if (emp.domain) this._byDomain.set(emp.domain.toLowerCase(), emp);
            if (emp.name) {
                this._byName.set(emp.name.toLowerCase(), emp);
            }
            if (Array.isArray(emp.aliases)) {
                for (const alias of emp.aliases) {
                    if (alias) this._byName.set(alias.toLowerCase(), emp);
                }
            }
        }
    }

    getAllEmployers() {
        this._load();
        return [...this._employers];
    }

    getEmployerById(id) {
        this._load();
        if (!id) return null;
        return this._byId.get(String(id).toLowerCase()) || null;
    }

    findEmployerByDomain(domain) {
        this._load();
        if (!domain) return null;
        const clean = String(domain).toLowerCase().replace(/^www\./, '');
        return this._byDomain.get(clean) || null;
    }

    findEmployerByName(name) {
        this._load();
        if (!name) return null;
        const clean = String(name).toLowerCase().trim();
        if (this._byName.has(clean)) {
            return this._byName.get(clean);
        }
        // Substring / fuzzy match
        for (const [key, emp] of this._byName.entries()) {
            if (key.includes(clean) || clean.includes(key)) {
                return emp;
            }
        }
        return null;
    }

    getEmployersByAts(atsType) {
        this._load();
        if (!atsType) {
            return this._employers.filter(e => !e.ats_type || e.ats_type === 'unknown');
        }
        const target = String(atsType).toLowerCase();
        return this._employers.filter(e => String(e.ats_type).toLowerCase() === target);
    }

    getEmployersByRegion(region) {
        this._load();
        const target = String(region).toLowerCase();
        return this._employers.filter(e =>
            (Array.isArray(e.hiring_regions) && e.hiring_regions.some(r => r.toLowerCase().includes(target))) ||
            (e.country && e.country.toLowerCase() === target)
        );
    }

    getEmployersByIndustry(industry) {
        this._load();
        const target = String(industry).toLowerCase();
        return this._employers.filter(e =>
            e.industry && e.industry.toLowerCase().includes(target)
        );
    }

    getRegistryStats() {
        this._load();
        const total = this._employers.length;
        const withCareerUrl = this._employers.filter(e => e.career_url && e.career_url.trim().length > 0).length;
        const atsBreakdown = {};
        const industryBreakdown = {};

        for (const e of this._employers) {
            const ats = e.ats_type || 'unknown';
            atsBreakdown[ats] = (atsBreakdown[ats] || 0) + 1;
            const ind = e.industry || 'Other';
            industryBreakdown[ind] = (industryBreakdown[ind] || 0) + 1;
        }

        return {
            total,
            withCareerUrl,
            withoutCareerUrl: total - withCareerUrl,
            atsBreakdown,
            industryBreakdown
        };
    }
}

export const employerRegistry = new EmployerRegistry();
