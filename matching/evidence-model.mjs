/**
 * matching/evidence-model.mjs — Comprehensive Candidate Evidence & Skill Classification Model
 *
 * Implements Part C of the Flexible Job-Fit Architecture:
 *   - Four-tier skill classification: VERIFIED, UNVERIFIED, LEARNING, EXPLICITLY_DISCLAIMED
 *   - Decoupled skill definition from evidence sources (employment, projects, academic, self-attested)
 *   - Transferable skill adjacency mappings
 *   - Zero Fabrication (R16): only VERIFIED skills can ever be claimed on generated resumes
 */

export const SKILL_CLASSIFICATIONS = Object.freeze({
    VERIFIED: 'VERIFIED',
    UNVERIFIED: 'UNVERIFIED',
    LEARNING: 'LEARNING',
    EXPLICITLY_DISCLAIMED: 'EXPLICITLY_DISCLAIMED'
});

export const EVIDENCE_SOURCE_TYPES = Object.freeze({
    WORK_EXPERIENCE: 'work_experience',
    PROJECT: 'project',
    EDUCATION: 'education',
    CERTIFICATION: 'certification',
    SELF_ATTESTED: 'self-attested'
});

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

function loadCandidateSkillRegistry() {
    const localPath = path.join(PROJECT_ROOT, 'config', 'candidate-skill-registry.json');

    let rawData = null;
    if (fs.existsSync(localPath)) {
        try {
            rawData = JSON.parse(fs.readFileSync(localPath, 'utf8'));
        } catch {
            rawData = null;
        }
    }

    if (!Array.isArray(rawData)) {
        return [];
    }

    return rawData.map(skill => {
        const aliases = (skill.aliases || []).map(a => {
            if (a && typeof a === 'object' && a.pattern) {
                return new RegExp(a.pattern, a.flags || 'i');
            }
            if (typeof a === 'string') {
                return a;
            }
            return a;
        });
        return {
            ...skill,
            aliases
        };
    });
}

/**
 * Authoritative evidence registry for candidate skills.
 * Loaded dynamically from config/candidate-skill-registry.json (local candidate data).
 */
export const CANDIDATE_SKILL_REGISTRY = loadCandidateSkillRegistry();

/**
 * Retrieves a skill definition by canonical name or alias.
 */
export function findSkill(query = '') {
    if (!query) return null;
    const qNorm = String(query).toLowerCase().trim();
    return CANDIDATE_SKILL_REGISTRY.find(s => {
        if (s.canonical.toLowerCase() === qNorm) return true;
        return s.aliases.some(alias => {
            if (alias instanceof RegExp) return alias.test(qNorm);
            return String(alias).toLowerCase() === qNorm;
        });
    }) || null;
}

/**
 * Returns all skills that can be legitimately claimed on a resume (strictly VERIFIED).
 */
export function getClaimableSkills() {
    return CANDIDATE_SKILL_REGISTRY.filter(s => s.classification === SKILL_CLASSIFICATIONS.VERIFIED);
}

/**
 * Adds or updates a skill in the candidate registry (supporting candidate confirmation or new project).
 */
export function registerCandidateSkill(skillDef) {
    if (!skillDef || !skillDef.canonical) {
        throw new Error('registerCandidateSkill requires a valid skill definition with canonical name');
    }
    const idx = CANDIDATE_SKILL_REGISTRY.findIndex(s => s.canonical.toLowerCase() === skillDef.canonical.toLowerCase());
    if (idx !== -1) {
        CANDIDATE_SKILL_REGISTRY[idx] = { ...CANDIDATE_SKILL_REGISTRY[idx], ...skillDef };
        return CANDIDATE_SKILL_REGISTRY[idx];
    } else {
        CANDIDATE_SKILL_REGISTRY.push(skillDef);
        return skillDef;
    }
}
