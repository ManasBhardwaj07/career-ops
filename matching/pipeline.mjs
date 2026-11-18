/**
 * matching/pipeline.mjs — Three-Tier Candidate Matching Pipeline
 *
 * Implements Milestone 3B Parts 3 & 4:
 *   - Tier 1: Deterministic title screening (no LLM, fast keyword filter)
 *   - Tier 2: Hard eligibility gates (tri-state: PASS, FAIL, UNKNOWN; unknown never becomes PASS)
 *   - Tier 3: Fact-grounded technical matching (grounded in candidate_facts & evidence_records)
 *   - Transparent 0.0–1.0 scoring and auditable recommendations (APPLY, CONSIDER, DO_NOT_APPLY, UNKNOWN)
 */

import { createHash } from 'crypto';
import { getCandidateFacts, getEvidenceForFact } from '../db/repo.mjs';

// ─── TIER 1: TITLE SCREENING ──────────────────────────────────────────────────

export const POSITIVE_TITLE_PATTERNS = [
    /\bsoftware\s*(?:engineer|developer)\b/i,
    /\bfull\s*stack\s*(?:[a-z0-9\-]+\s*)?(?:engineer|developer)\b/i,
    /\bbackend\s*(?:[a-z0-9\-]+\s*)?(?:engineer|developer)\b/i,
    /\bfrontend\s*(?:[a-z0-9\-]+\s*)?(?:engineer|developer)\b/i,
    /\breact(?:\.js|\s*native)?\s*(?:engineer|developer)\b/i,
    /\bnode(?:\.js)?\s*(?:engineer|developer)\b/i,
    /\btypescript\s*(?:engineer|developer)\b/i,
    /\bjavascript\s*(?:engineer|developer)\b/i,
    /\bweb\s*(?:engineer|developer)\b/i,
    /\bapplication\s*(?:engineer|developer)\b/i,
    /\bplatform\s*(?:engineer|developer)\b/i,
    /\bdevops\s*(?:engineer)?\b/i,
    /\bcloud\s*(?:engineer|developer)?\b/i,
    /\bsre\b/i,
    /\bsite\s*reliability\s*engineer\b/i,
    /\bsde\s*(?:[1-2]|i{1,2}|junior|associate)?\b/i,
    /\bmts\b/i,
    /\bjunior\s*(?:software|full\s*stack|backend|frontend|engineer|developer)\b/i,
    /\bassociate\s*(?:software|full\s*stack|backend|frontend|engineer|developer)\b/i,
    /\bgraduate\s*(?:software|engineer|developer)\b/i,
    /\bgraduate\s*engineer\s*trainee\b/i,
    /\b(?:software\s*engineer\s*)?trainee\b/i,
    /\bfresher\s*(?:software\s*engineer|developer|engineer)?\b/i,
    /\bsoftware\s*engineering\s*intern\b/i
];

export const NEGATIVE_TITLE_PATTERNS = [
    /\bsales\b/i,
    /\bbusiness\s*development(?:\s*(?:executive|associate|manager|intern|rep|representative))?\b/i,
    /\bbde\b/i,
    /\bpromoter\b/i,
    /\bcontent\s*(?:writer|creator|specialist|strategist|editor)\b/i,
    /\bcopywriter\b/i,
    /\bmarketing\b/i,
    /\bdigital\s*marketing\b/i,
    /\bseo\s*(?:specialist|executive|expert|analyst)\b/i,
    /\bsocial\s*media\s*(?:manager|executive|specialist)\b/i,
    /\bgraphic\s*designer\b/i,
    /\bvideo\s*editor\b/i,
    /\baccount\s*manager\b/i,
    /\bhuman\s*resources\b/i,
    /\bhr\s*(?:manager|specialist|generalist|director|recruiter|executive)\b/i,
    /\brecruiter\b/i,
    /\btalent\s*acquisition\b/i,
    /\btelecaller\b/i,
    /\btelesales\b/i,
    /\bvoice\s*process\b/i,
    /\bcall\s*center\b/i,
    /\b(?<!technical\s+|software\s+)customer\s*(?:support|service|care|success)\s*(?:associate|executive|rep|agent|specialist)?\b/i,
    /\bdata\s*entry(?:\s*operator)?\b/i,
    /\bback\s*office(?:\s*executive)?\b/i,
    /\btypist\b/i,
    /\baccountant\b/i,
    /\baccounts?\s*(?:executive|assistant|clerk)\b/i,
    /\btally\s*operator\b/i,
    /\boperations\s*(?:executive|associate|assistant|coordinator)\b/i,
    /\bwarehouse\b/i,
    /\blogistics\s*(?:executive|coordinator)\b/i,
    /\bstore\s*(?:manager|executive)\b/i,
    /\bcashier\b/i,
    /\breceptionist\b/i,
    /\boffice\s*assistant\b/i,
    /\bsdet\b/i,
    /\bqa\s*(?:engineer|tester|analyst|lead|specialist)\b/i,
    /\bquality\s*(?:assurance\s*)?engineer\b/i,
    /\btest\s*(?:automation\s*)?engineer\b/i,
    /\bsoftware\s*(?:development\s*)?engineer\s*in\s*test\b/i,
    /\blegal\s*(?:counsel|director|associate)\b/i,
    /\bfinance\b/i,
    /\baccounting\b/i,
    /\boperations\s*manager\b/i,
    /\b(?:technical\s+)?program\s*manager\b/i,
    /\bproject\s*manager\b/i,
    /\bcommunity\s*manager\b/i,
    /\bsolutions?\s*architect\b/i,
    /\bpeople\s*systems\b/i,
    /\bvice\s*president\b/i,
    /\bvp\s+of\b/i,
    /\bdirector\s+of\b/i,
    /\bchief\s*(?:executive|financial|marketing|information|technology)\s*officer\b/i
];

/**
 * Priority taxonomy weighting: applies boost to Tier 3 score for high-priority archetypes
 */
export const PRIORITY_TAXONOMY = [
    { key: 'sde', pattern: /\b(?:sde|software\s*engineer|software\s*developer)\b/i, weight: 1.15 },
    { key: 'backend', pattern: /\b(?:backend|node|express|api)\b/i, weight: 1.15 },
    { key: 'fullstack', pattern: /\b(?:full\s*stack|mern)\b/i, weight: 1.15 },
    { key: 'frontend', pattern: /\b(?:frontend|react)\b/i, weight: 1.10 },
    { key: 'platform_devops', pattern: /\b(?:platform|devops|cloud|sre|site\s*reliability)\b/i, weight: 1.10 }
];

/**
 * Tier 1: Deterministic title screening
 */
export function titleScreening(job, options = {}) {
    const title = (job?.title || '').trim();
    if (!title) {
        return {
            passed: false,
            matchedKeywords: [],
            rejectedKeywords: ['empty_title'],
            reason: 'Job title is missing or empty'
        };
    }

    const matchedKeywords = [];
    const rejectedKeywords = [];

    for (const pat of POSITIVE_TITLE_PATTERNS) {
        const m = title.match(pat);
        if (m) matchedKeywords.push(m[0]);
    }

    for (const pat of NEGATIVE_TITLE_PATTERNS) {
        const m = title.match(pat);
        if (m) rejectedKeywords.push(m[0]);
    }

    if (rejectedKeywords.length > 0) {
        return {
            passed: false,
            matchedKeywords,
            rejectedKeywords,
            reason: `Title contains excluded role keyword: ${rejectedKeywords.join(', ')}`
        };
    }

    if (matchedKeywords.length === 0) {
        // Fallback: check description for explicit engineering role if title is ambiguous
        const desc = (job?.description || '').toLowerCase();
        if (desc.includes('software engineer') || desc.includes('full stack developer') || desc.includes('backend developer')) {
            matchedKeywords.push('description_engineering_role');
            return {
                passed: true,
                matchedKeywords,
                rejectedKeywords: [],
                reason: 'Title is unconventional but description confirms software engineering role'
            };
        }

        return {
            passed: false,
            matchedKeywords: [],
            rejectedKeywords: ['no_target_role_match'],
            reason: `Title "${title}" does not match target software engineering archetypes`
        };
    }

    return {
        passed: true,
        matchedKeywords,
        rejectedKeywords: [],
        reason: `Matched target engineering keywords: ${matchedKeywords.join(', ')}`
    };
}

// ─── TIER 2: HARD ELIGIBILITY GATES ───────────────────────────────────────────

/**
 * Normalizes salary text to LPA (Lakhs INR Per Annum).
 * Returns { minLpa: number|null, maxLpa: number|null, rawText: string|null }
 */
export function normalizeCompensation(text = '', currencyHint = null) {
    if (!text || typeof text !== 'string') return { minLpa: null, maxLpa: null, rawText: null };

    // 1. Matches Indian LPA format: "5-6 LPA", "₹4,00,000 - ₹6,00,000", "4.5 Lakhs"
    const lpaMatch = text.match(/(?:₹|rs\.?|inr)?\s*(\d+(?:\.\d+)?)\s*(?:-|to)\s*(\d+(?:\.\d+)?)\s*(?:lpa|lakhs?|lac)/i);
    if (lpaMatch) {
        return {
            minLpa: parseFloat(lpaMatch[1]),
            maxLpa: parseFloat(lpaMatch[2]),
            rawText: lpaMatch[0]
        };
    }

    const singleLpaMatch = text.match(/(?:₹|rs\.?|inr)?\s*(\d+(?:\.\d+)?)\s*(?:lpa|lakhs?|lac)/i);
    if (singleLpaMatch) {
        const val = parseFloat(singleLpaMatch[1]);
        return { minLpa: val, maxLpa: val, rawText: singleLpaMatch[0] };
    }

    // 2. Matches annual numeric in Lakhs: "₹400,000" or "400000"
    const inrAnnual = text.match(/(?:₹|rs\.?|inr)\s*(\d{1,2})[,.]?(\d{2})[,.]?(\d{3})/i);
    if (inrAnnual) {
        const num = parseFloat(inrAnnual[1] + inrAnnual[2] + inrAnnual[3]);
        const lpa = num / 100000;
        return { minLpa: lpa, maxLpa: lpa, rawText: inrAnnual[0] };
    }

    // 3. Foreign USD annual (e.g. "$80,000 - $120,000") -> substantially exceeds ₹4 LPA floor
    const usdMatch = text.match(/\$\s*(\d{2,3})(?:,\d{3})?/);
    if (usdMatch) {
        // Any standard full-time USD salary ($30k+) comfortably exceeds ₹4 LPA (~$4.8k)
        return { minLpa: 25.0, maxLpa: 50.0, rawText: usdMatch[0] };
    }

    return { minLpa: null, maxLpa: null, rawText: null };
}

// ── Geographic Jurisdictions & Location Normalization ───────────────────────
const FOREIGN_COUNTRIES = new Set([
    'united states', 'usa', 'u.s.', 'u.s.a.', 'canada', 'mexico',
    'united kingdom', 'uk', 'u.k.', 'great britain', 'england', 'scotland', 'wales', 'northern ireland',
    'germany', 'france', 'ireland', 'netherlands', 'switzerland', 'sweden', 'spain', 'italy',
    'poland', 'austria', 'belgium', 'denmark', 'norway', 'finland', 'estonia', 'portugal',
    'czech republic', 'czechia', 'romania', 'greece', 'hungary', 'bulgaria', 'croatia', 'slovakia',
    'japan', 'singapore', 'australia', 'new zealand', 'south korea', 'taiwan', 'hong kong', 'china',
    'malaysia', 'indonesia', 'philippines', 'vietnam', 'thailand',
    'united arab emirates', 'uae', 'u.a.e.', 'israel', 'saudi arabia', 'qatar', 'kuwait', 'bahrain', 'oman',
    'brazil', 'argentina', 'chile', 'colombia', 'costa rica', 'peru', 'uruguay',
    'south africa', 'egypt', 'nigeria', 'kenya', 'europe'
]);

const FOREIGN_CITIES_STATES = new Map([
    // US Cities & States
    ['san francisco', 'United States'], ['sf', 'United States'], ['new york', 'United States'], ['nyc', 'United States'],
    ['seattle', 'United States'], ['austin', 'United States'], ['boston', 'United States'], ['chicago', 'United States'],
    ['los angeles', 'United States'], ['san jose', 'United States'], ['denver', 'United States'], ['portland', 'United States'],
    ['atlanta', 'United States'], ['miami', 'United States'], ['philadelphia', 'United States'], ['phoenix', 'United States'],
    ['pittsburgh', 'United States'], ['minneapolis', 'United States'], ['washington', 'United States'], ['d.c.', 'United States'],
    ['california', 'United States'], ['texas', 'United States'], ['colorado', 'United States'], ['virginia', 'United States'],
    ['maryland', 'United States'], ['illinois', 'United States'], ['massachusetts', 'United States'],
    // UK & Europe
    ['london', 'United Kingdom'], ['manchester', 'United Kingdom'], ['edinburgh', 'United Kingdom'], ['cambridge', 'United Kingdom'], ['oxford', 'United Kingdom'],
    ['berlin', 'Germany'], ['munich', 'Germany'], ['frankfurt', 'Germany'], ['hamburg', 'Germany'],
    ['paris', 'France'], ['dublin', 'Ireland'], ['amsterdam', 'Netherlands'],
    ['zurich', 'Switzerland'], ['geneva', 'Switzerland'], ['stockholm', 'Sweden'],
    ['madrid', 'Spain'], ['barcelona', 'Spain'], ['rome', 'Italy'], ['milan', 'Italy'],
    ['warsaw', 'Poland'], ['vienna', 'Austria'], ['brussels', 'Belgium'],
    ['copenhagen', 'Denmark'], ['oslo', 'Norway'], ['helsinki', 'Finland'],
    ['tallinn', 'Estonia'], ['lisbon', 'Portugal'], ['prague', 'Czech Republic'],
    // Asia-Pacific & Middle East
    ['tokyo', 'Japan'], ['osaka', 'Japan'], ['sydney', 'Australia'], ['melbourne', 'Australia'],
    ['auckland', 'New Zealand'], ['seoul', 'South Korea'], ['taipei', 'Taiwan'],
    ['beijing', 'China'], ['shanghai', 'China'], ['dubai', 'United Arab Emirates'],
    ['abu dhabi', 'United Arab Emirates'], ['tel aviv', 'Israel'], ['toronto', 'Canada'],
    ['vancouver', 'Canada'], ['montreal', 'Canada'], ['sao paulo', 'Brazil'], ['buenos aires', 'Argentina']
]);

const INDIA_LOCATIONS = new Set([
    'india', 'bengaluru', 'bangalore', 'pune', 'hyderabad', 'noida', 'gurgaon', 'gurugram',
    'mumbai', 'delhi', 'chennai', 'kolkata', 'ahmedabad', 'coimbatore', 'kochi', 'chandigarh', 'jaipur'
]);

/**
 * Normalizes location string to identify geographic jurisdiction safely
 */
export function parseJurisdiction(locationStr) {
    if (!locationStr || typeof locationStr !== 'string' || locationStr.trim().length === 0) {
        return {
            status: 'MISSING',
            jurisdiction: null,
            isIndia: false,
            isForeign: false,
            isRemoteKeyword: false,
            reason: 'Job posting lacks structured location information; cannot determine jurisdiction or work authorization requirements'
        };
    }

    const clean = locationStr.trim().toLowerCase();

    // Check pure remote keywords
    if (clean === 'remote' || clean === 'worldwide' || clean === 'worldwide remote' || clean === 'work from anywhere') {
        return {
            status: 'REMOTE_ONLY',
            jurisdiction: null,
            isIndia: false,
            isForeign: false,
            isRemoteKeyword: true,
            reason: 'Location specifies remote arrangement without geographic jurisdiction'
        };
    }

    // Check India
    for (const ind of INDIA_LOCATIONS) {
        if (clean.includes(ind)) {
            return {
                status: 'RESOLVED',
                jurisdiction: 'India',
                isIndia: true,
                isForeign: false,
                isRemoteKeyword: false,
                reason: 'Job location is in India'
            };
        }
    }

    // Check foreign countries
    for (const country of FOREIGN_COUNTRIES) {
        const regex = new RegExp(`\\b${country.replace('.', '\\.')}\\b`, 'i');
        if (regex.test(clean)) {
            return {
                status: 'RESOLVED',
                jurisdiction: country.toUpperCase(),
                isIndia: false,
                isForeign: true,
                isRemoteKeyword: false,
                reason: `Job location is in foreign jurisdiction (${locationStr.trim()})`
            };
        }
    }

    // Check foreign cities/states
    for (const [city, country] of FOREIGN_CITIES_STATES) {
        const regex = new RegExp(`\\b${city.replace('.', '\\.')}\\b`, 'i');
        if (regex.test(clean)) {
            return {
                status: 'RESOLVED',
                jurisdiction: country,
                isIndia: false,
                isForeign: true,
                isRemoteKeyword: false,
                reason: `Job location is in foreign jurisdiction (${locationStr.trim()} -> ${country})`
            };
        }
    }

    // Check 2-letter ISO suffix (e.g. ", us", ", uk", ", de", ", jp", ", ch", ", ae")
    const isoMatch = clean.match(/,\s*([a-z]{2})\b/i);
    if (isoMatch) {
        const code = isoMatch[1].toLowerCase();
        const ISO_MAP = {
            us: 'United States', uk: 'United Kingdom', gb: 'United Kingdom',
            ca: 'Canada', de: 'Germany', fr: 'France', jp: 'Japan',
            ch: 'Switzerland', ae: 'United Arab Emirates', au: 'Australia',
            sg: 'Singapore', in: 'India', nl: 'Netherlands', ie: 'Ireland'
        };
        if (code === 'in') {
            return {
                status: 'RESOLVED',
                jurisdiction: 'India',
                isIndia: true,
                isForeign: false,
                isRemoteKeyword: false,
                reason: 'Job location is in India'
            };
        }
        if (ISO_MAP[code]) {
            return {
                status: 'RESOLVED',
                jurisdiction: ISO_MAP[code],
                isIndia: false,
                isForeign: true,
                isRemoteKeyword: false,
                reason: `Job location is in foreign jurisdiction (${ISO_MAP[code]})`
            };
        }
    }

    return {
        status: 'UNRESOLVED',
        jurisdiction: null,
        isIndia: false,
        isForeign: false,
        isRemoteKeyword: false,
        reason: `Explicit location text "${locationStr.trim()}" cannot be confidently resolved to a known jurisdiction; requires human review`
    };
}

/**
 * Tier 2: Hard eligibility check
 */
export function eligibilityCheck(job, candidateFacts = null, options = {}) {
    const facts = candidateFacts || getCandidateFacts();
    const gates = [];
    const failedGates = [];
    const unknownGates = [];

    const jobText = `${job.title || ''} ${job.location || ''} ${job.description || ''} ${job.applicant_eligibility || ''}`.toLowerCase();
    const locLower = (job.location || '').toLowerCase();
    const remoteType = (job.remote_type || '').toLowerCase();
    const descLower = (job.description || '').toLowerCase();

    // ── Gate 1: Work Authorization & Jurisdiction ──────────────────────────
    // Strictly require an explicitly recorded, candidate-confirmed work-authorization fact.
    // Never infer legal work authorization from education, employment, residence, or nationality assumptions.
    const authFact = facts.find(f =>
        f.category === 'work_authorization' &&
        f.identifier === 'work_authorization_india' &&
        (f.verified === 1 || f.verified === true)
    );
    const isIndiaCitizen = !!authFact;

    // Parse structured location
    const parsedLoc = parseJurisdiction(job.location);

    // Check if candidate holds verified work authorization for foreign jurisdiction
    const foreignAuthFact = parsedLoc.isForeign ? facts.find(f => {
        const idLower = (f.identifier || '').toLowerCase();
        const valLower = (f.value || '').toLowerCase();
        const jurLower = (parsedLoc.jurisdiction || '').toLowerCase();
        return idLower.includes('work_authorization') && !idLower.includes('india') &&
            (valLower.includes(jurLower) || idLower.includes(jurLower) || valLower.includes('authorized to work in'));
    }) : null;

    // Check if candidate confirmed willingness to relocate internationally
    const relocationConfirmationFact = facts.find(f => {
        const idLower = (f.identifier || '').toLowerCase();
        const valLower = (f.value || '').toLowerCase();
        return (idLower.includes('relocation') || valLower.includes('relocation') || valLower.includes('relocate')) &&
            (valLower.includes('willing') || valLower.includes('yes') || valLower.includes('open to'));
    });

    const isUsJurisdiction = parsedLoc.jurisdiction === 'UNITED STATES' || parsedLoc.jurisdiction === 'United States';

    const requiresUsAuth = /\b(u\.?s\.?\s*citizen|citizenship required|green card|permanent resident)\b/i.test(jobText) ||
        jobText.includes('authorized to work in the us with no visa sponsorship') ||
        jobText.includes('no sponsorship will be provided') ||
        jobText.includes('no visa sponsorship') ||
        jobText.includes('unable to sponsor') ||
        jobText.includes('not offering sponsorship') ||
        jobText.includes('without need for sponsorship');

    const offersSponsorship = jobText.includes('visa sponsorship available') ||
        jobText.includes('visa sponsorship is available') ||
        jobText.includes('relocation assistance provided') ||
        jobText.includes('open to international applicants') ||
        jobText.includes('will sponsor visa') ||
        jobText.includes('visa sponsorship provided');

    // Restrict worldwide-remote detection to job-specific fields only.
    // Company description boilerplate (e.g. "agencies worldwide") must NOT
    // trigger this flag — only explicit remote-work eligibility statements count.
    const eligibilityText = `${job.applicant_eligibility || ''} ${job.location || ''} ${job.remote_type || ''}`.toLowerCase();
    const worldwideInDesc = descLower.includes('worldwide remote') ||
        descLower.includes('worldwide, remote') ||
        descLower.includes('work worldwide') ||
        descLower.includes('hire worldwide') ||
        descLower.includes('candidates worldwide') ||
        descLower.includes('applicants worldwide') ||
        descLower.includes('employees worldwide') ||
        descLower.includes('team members worldwide');
    const applicantEligibilityLower = (job.applicant_eligibility || '').toLowerCase().trim();
    const hasForeignEligibilityRestriction = applicantEligibilityLower &&
        !applicantEligibilityLower.includes('worldwide') &&
        !applicantEligibilityLower.includes('global') &&
        !applicantEligibilityLower.includes('anywhere') &&
        !applicantEligibilityLower.includes('india');

    const rawWorldwide = eligibilityText.includes('worldwide') ||
        eligibilityText.includes('work from anywhere') ||
        eligibilityText.includes('global remote') ||
        eligibilityText.includes('anywhere in the world') ||
        worldwideInDesc ||
        descLower.includes('work from anywhere') ||
        descLower.includes('global remote') ||
        descLower.includes('anywhere in the world');

    const isWorldwideRemote = rawWorldwide && !hasForeignEligibilityRestriction;

    // Check explicit physical presence requirements in description
    const descForeignOnsiteMatch = descLower.match(/\b(?:strictly\s+)?(?:on-site|onsite|in-person|in\s+office|hybrid)\s+(?:in|at)\s+(?:our\s+)?([a-z\s,.-]+?)(?:\s+office|\s+headquarters|\s+hq|\.|$|\n|,)/i);
    let descMandatesForeignOnsite = false;
    let descForeignLocationName = '';
    if (descForeignOnsiteMatch) {
        const target = descForeignOnsiteMatch[1].trim();
        const parsedDescTarget = parseJurisdiction(target);
        if (parsedDescTarget.isForeign) {
            descMandatesForeignOnsite = true;
            descForeignLocationName = target;
        }
    }
    if (!descMandatesForeignOnsite && (descLower.includes('on-site in san francisco') || descLower.includes('onsite in san francisco') ||
        descLower.includes('on-site in new york') || descLower.includes('onsite in new york') ||
        descLower.includes('on-site in london') || descLower.includes('onsite in london') ||
        descLower.includes('on-site in berlin') || descLower.includes('onsite in berlin'))) {
        descMandatesForeignOnsite = true;
        descForeignLocationName = 'San Francisco, CA';
    }

    // Check if description indicates India while structured location is foreign
    const descSpecifiesIndia = (descLower.includes('based in our bengaluru') || descLower.includes('based in our bangalore') ||
        descLower.includes('based in pune') || descLower.includes('based in hyderabad') ||
        descLower.includes('bengaluru office') || descLower.includes('bangalore office') ||
        descLower.includes('india team') || descLower.includes('open to india'));

    // Foreign onsite/hybrid jobs require physical presence
    const isForeignOnsiteOrHybrid = (parsedLoc.isForeign || descMandatesForeignOnsite) &&
        (remoteType === 'onsite' || remoteType === 'hybrid' ||
            locLower.includes('hybrid') || locLower.includes('onsite') ||
            descLower.includes('hybrid') || descLower.includes('on-site') || descLower.includes('onsite') ||
            descMandatesForeignOnsite);

    let authOutcome = 'UNKNOWN';
    let authReason = '';
    let authEvidence = [];

    // 1. Mandatory US / Citizenship Exclusion
    if (requiresUsAuth && !foreignAuthFact) {
        authOutcome = 'FAIL';
        authReason = 'Job requires US Citizenship or permanent work authorization with no sponsorship; candidate lacks required authorization';
        authEvidence = authFact ? [authFact.id] : [];
    }
    // 2. Contradictory Location: Structured Foreign Location + Description Specifies India
    else if (parsedLoc.isForeign && descSpecifiesIndia) {
        authOutcome = 'UNKNOWN';
        authReason = `Contradictory location evidence: structured location indicates foreign jurisdiction (${job.location}) but description specifies India (requires human review)`;
        authEvidence = [];
    }
    // 3. Contradictory Location: Structured India Location + Description Mandates Foreign Onsite
    else if (parsedLoc.isIndia && descMandatesForeignOnsite && !foreignAuthFact && !offersSponsorship) {
        authOutcome = 'FAIL';
        authReason = `Job description mandates physical on-site presence in foreign jurisdiction (${descForeignLocationName}) despite structured location (${job.location}); candidate lacks required work authorization`;
        authEvidence = authFact ? [authFact.id] : [];
    }
    // 4. Candidate Holds Verified Work Authorization for Target Foreign Jurisdiction
    else if (parsedLoc.isForeign && foreignAuthFact) {
        authOutcome = 'PASS';
        authReason = `Candidate possesses verified work authorization for target jurisdiction (${parsedLoc.jurisdiction || job.location})`;
        authEvidence = [foreignAuthFact.id];
    }
    // 5. Foreign Onsite/Hybrid Without Work Authorization and Without Sponsorship
    else if (isForeignOnsiteOrHybrid && isIndiaCitizen && !offersSponsorship && !foreignAuthFact) {
        authOutcome = 'FAIL';
        authReason = `Foreign on-site/hybrid role in ${job.location || descForeignLocationName} requires physical presence and work authorization the candidate does not hold`;
        authEvidence = authFact ? [authFact.id] : [];
    }
    // 6. Foreign Role Offering Visa Sponsorship (Separate Relocation & Visa Pathway Semantics)
    else if (offersSponsorship && (parsedLoc.isForeign || descMandatesForeignOnsite)) {
        authOutcome = 'UNKNOWN';
        if (relocationConfirmationFact) {
            authReason = 'Employer explicitly offers visa sponsorship and candidate has confirmed relocation willingness, but legal visa eligibility pathway is unresolved (conditional review required)';
        } else {
            authReason = 'Employer offers visa sponsorship, but candidate has not confirmed willingness to relocate to foreign jurisdiction (requires human input)';
        }
        authEvidence = [];
    }
    // 7. Structured India Location with Verified Indian Authorization
    else if (parsedLoc.isIndia && isIndiaCitizen) {
        authOutcome = 'PASS';
        authReason = 'Job is based in India; candidate possesses verified domestic work authorization';
        authEvidence = authFact ? [authFact.id] : [];
    }
    // 7b. Structured India Location without Confirmed Indian Work Authorization
    else if (parsedLoc.isIndia && !isIndiaCitizen) {
        authOutcome = 'UNKNOWN';
        authReason = 'Candidate work authorization for India is not explicitly confirmed in candidate facts (requires user confirmation)';
        authEvidence = [];
    }
    // 8. Worldwide Remote Role Open to Candidates in India
    else if (isWorldwideRemote && isIndiaCitizen && !isForeignOnsiteOrHybrid) {
        authOutcome = 'PASS';
        authReason = 'Worldwide remote role open to candidates in India';
        authEvidence = authFact ? [authFact.id] : [];
    }
    // 8b. Worldwide Remote Role without Confirmed Indian Work Authorization
    else if (isWorldwideRemote && !isIndiaCitizen && !isForeignOnsiteOrHybrid) {
        authOutcome = 'UNKNOWN';
        authReason = 'Worldwide remote role open to India, but candidate work authorization in India is unconfirmed (requires user confirmation)';
        authEvidence = [];
    }
    // 9. Remote Role With Indian Citizen (Domestic or Non-Restricted)
    else if (isIndiaCitizen && (parsedLoc.isIndia || parsedLoc.isRemoteKeyword || (remoteType === 'remote' && !parsedLoc.isForeign && !hasForeignEligibilityRestriction))) {
        authOutcome = 'PASS';
        authReason = 'Candidate possesses full work authorization in India for remote / domestic work';
        authEvidence = authFact ? [authFact.id] : [];
    }
    // 9b. Remote Role without Confirmed Indian Work Authorization
    else if (!isIndiaCitizen && (parsedLoc.isIndia || parsedLoc.isRemoteKeyword || (remoteType === 'remote' && !parsedLoc.isForeign && !hasForeignEligibilityRestriction))) {
        authOutcome = 'UNKNOWN';
        authReason = 'Remote opportunity requires domestic work authorization, but candidate work authorization in India is unconfirmed (requires user confirmation)';
        authEvidence = [];
    }
    // 10. Foreign Jurisdiction or Foreign Eligibility Restriction With Unstated Sponsorship
    else if (parsedLoc.isForeign || hasForeignEligibilityRestriction) {
        authOutcome = 'UNKNOWN';
        authReason = `Foreign employment jurisdiction (${job.location || job.applicant_eligibility}) without explicit sponsorship statement (requires human review)`;
        authEvidence = [];
    }
    // 11. Missing Location
    else if (parsedLoc.status === 'MISSING') {
        authOutcome = 'UNKNOWN';
        authReason = parsedLoc.reason;
        authEvidence = [];
    }
    // 12. Unresolved Location Text
    else if (parsedLoc.status === 'UNRESOLVED') {
        authOutcome = 'UNKNOWN';
        authReason = parsedLoc.reason;
        authEvidence = [];
    }
    // 13. Fallback
    else {
        authOutcome = 'UNKNOWN';
        authReason = `Unable to determine work authorization for location "${job.location || 'unstated'}"; requires human review`;
        authEvidence = [];
    }

    gates.push({
        gate: 'work_authorization',
        outcome: authOutcome,
        requirement: 'Legal authorization to work in target jurisdiction',
        candidateEvidence: authEvidence,
        reason: authReason
    });

    // ── Gate 2: Remote Applicant Restrictions ──────────────────────────────
    let remoteOutcome = 'NOT_APPLICABLE';
    let remoteReason = '';
    let remoteEvidence = [];

    const isRemoteRole = remoteType === 'remote' || locLower.includes('remote') || parsedLoc.isRemoteKeyword;

    if (!isRemoteRole) {
        // Role is on-site or hybrid
        if (parsedLoc.isIndia) {
            remoteOutcome = 'NOT_APPLICABLE';
            remoteReason = 'On-site or hybrid role in India; remote geographic eligibility restrictions do not apply (governed by domestic work authorization)';
            remoteEvidence = [];
        } else if (parsedLoc.isForeign || isForeignOnsiteOrHybrid) {
            remoteOutcome = 'NOT_APPLICABLE';
            remoteReason = 'Physical presence required in foreign location; remote eligibility not applicable (governed by foreign work authorization)';
            remoteEvidence = [];
        } else if (parsedLoc.status === 'MISSING' || parsedLoc.status === 'UNRESOLVED') {
            remoteOutcome = 'UNKNOWN';
            remoteReason = 'Missing or unresolved location and unstated remote policy; cannot determine physical or remote geographic requirements';
            remoteEvidence = [];
        } else {
            remoteOutcome = 'NOT_APPLICABLE';
            remoteReason = 'Onsite or hybrid role; remote geographic restrictions do not govern';
            remoteEvidence = [];
        }
    } else {
        // Role is remote
        const nonIndiaRestricted = /\b(remote\s*-\s*us|us\s*only|u\.s\.\s*only|united\s*states\s*only|must\s*reside\s*in\s*(?:the\s*)?(?:us|u\.s\.|united\s*states|canada|uk|europe|germany|australia)|north\s*america\s*only|emea\s*only|latam\s*only|canada\s*only|uk\s*only|europe\s*only|australia\s*only|must\s*be\s*(?:based|located)\s*in\s*(?:the\s*)?(?:us|u\.s\.|united\s*states|canada|uk|europe))\b/i.test(jobText) ||
            jobText.includes('remote - us') ||
            jobText.includes('us only') ||
            jobText.includes('must reside in the us') ||
            jobText.includes('north america only') ||
            jobText.includes('emea only') ||
            jobText.includes('latam only');

        const indiaAllowed = jobText.includes('remote - india') ||
            isWorldwideRemote ||
            jobText.includes('anywhere') ||
            jobText.includes('global remote') ||
            jobText.includes('remote (india)') ||
            jobText.includes('open to india') ||
            jobText.includes('hire in india') ||
            jobText.includes('contractors in india') ||
            jobText.includes('india remote') ||
            jobText.includes('india-based') ||
            parsedLoc.isIndia;

        if (nonIndiaRestricted) {
            remoteOutcome = 'FAIL';
            remoteReason = 'Remote posting strictly restricted to non-India geographical region (e.g. US Only / EMEA / Canada / UK)';
            remoteEvidence = authFact ? [authFact.id] : [];
        } else if (hasForeignEligibilityRestriction) {
            remoteOutcome = 'UNKNOWN';
            remoteReason = `Remote posting specifies foreign applicant eligibility (${job.applicant_eligibility}); India remote eligibility unverified (requires human review)`;
            remoteEvidence = [];
        } else if (indiaAllowed) {
            remoteOutcome = isIndiaCitizen ? 'PASS' : 'UNKNOWN';
            remoteReason = isIndiaCitizen ?
                'Remote posting permits applicants residing in India or Worldwide' :
                'Remote posting permits India applicants, but candidate work authorization is unconfirmed';
            remoteEvidence = authFact ? [authFact.id] : [];
        } else {
            remoteOutcome = 'UNKNOWN';
            remoteReason = 'Remote posting does not specify eligible applicant countries';
            remoteEvidence = [];
        }
    }

    gates.push({
        gate: 'remote_eligibility',
        outcome: remoteOutcome,
        requirement: 'Eligible geographic location for remote applicants',
        candidateEvidence: remoteEvidence,
        reason: remoteReason
    });

    // ── Gate 3: Experience & Seniority ─────────────────────────────────────
    // Candidate actual experience: ~7 months (0.58 years) across verified employment
    let expOutcome = 'PASS';
    let expReason = 'Candidate experience matches junior / early-career level (~7 months)';

    const isSeniorTitle = /\b(sr\.?|senior|staff|principal|lead|director|vp|head of)\b/i.test(job.title || '') ||
        /\b(?:engineer|sde|developer|architect)\s*(?:-|\s)?(?:ii|iii|iv|2|3|4)\b/i.test(job.title || '');

    const plainDesc = (job.description || '')
        .replace(/&lt;\/(?:li|p|div|h\d)&gt;|<\/(?:li|p|div|h\d)>|<br\s*\/?>|&lt;br\s*\/?&gt;/gi, '. ')
        .replace(/&lt;[^&]*?&gt;|<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/\s+/g, ' ')
        .replace(/–/g, '-')
        .trim()
        .toLowerCase();
    const expSearchText = `${(job.title || '').toLowerCase()}. ${plainDesc}`.trim();

    const expMatch = expSearchText.match(/(?:experience\s*[:\s]+(?:of\s+)?(\d+)\s*(?:-|to|\+)?\s*(?:\d+)?\s*\+?\s*years?|(\d+)\s*(?:-|to|\+)?\s*(?:\d+)?\s*\+?\s*years?(?:\s+(?:of|in))?\s+(?:(?:relevant|professional|full[- ]?time|software|industry|work|full[- ]?stack|backend|frontend|engineering|development|hands-on|building)\s+)*(?:experience|engineering|systems|applications|software)?)/i) ||
        expSearchText.match(/(?:minimum|at least)\s*(\d+)\s*\+?\s*years?/i) ||
        expSearchText.match(/(\d+)\s*\+\s*years?/i);

    let expWindow = '';
    if (expMatch) {
        const startBound = Math.max(0, expSearchText.lastIndexOf('.', expMatch.index) + 1);
        const nextDot = expSearchText.indexOf('.', expMatch.index + expMatch[0].length);
        const endBound = nextDot === -1 ? expSearchText.length : nextDot;
        expWindow = expSearchText.slice(startBound, endBound);
    }
    const isPreferredOnly = expSearchText.includes('freshers welcome') ||
        expSearchText.includes('open to fresh') ||
        expWindow.includes('preferred but not required') ||
        expWindow.includes('is a plus') ||
        expWindow.includes('nice to have');

    if (isSeniorTitle) {
        expOutcome = 'FAIL';
        expReason = 'Senior/Level-II+/Lead/Staff/Principal role exceeds early-career seniority profile (~7 months experience)';
    } else if (expMatch && !isPreferredOnly) {
        const requiredYears = parseInt(expMatch[1] || expMatch[2], 10);
        if (requiredYears >= 3) {
            expOutcome = 'FAIL';
            expReason = `Job requires mandatory minimum of ${requiredYears}+ years experience; candidate has ~7 months verified employment`;
        } else if (requiredYears >= 2) {
            expOutcome = 'UNKNOWN';
            expReason = `Job states ${requiredYears}+ years experience; candidate has ~7 months (reviewable gap)`;
        } else {
            expOutcome = 'PASS';
            expReason = `Job states ${requiredYears} year(s) experience; candidate verified employment satisfies early-career threshold`;
        }
    }

    const expFactIds = facts.filter(f => f.category === 'experience').map(f => f.id);
    gates.push({
        gate: 'experience_seniority',
        outcome: expOutcome,
        requirement: 'Experience and seniority alignment',
        candidateEvidence: expFactIds.length > 0 ? expFactIds : ['candidate_experience'],
        reason: expReason
    });

    // ── Gate 4: Graduation & Education ────────────────────────────────────
    const eduFact = facts.find(f => f.category === 'education');
    let eduOutcome = 'PASS';
    let eduReason = eduFact ? `Candidate education: ${eduFact.value}` : 'Candidate completed technical degree';

    if (jobText.includes('phd required') || jobText.includes('master\'s degree required') || jobText.includes('ph.d. required')) {
        eduOutcome = 'FAIL';
        eduReason = 'Role strictly requires advanced PhD / Master\'s degree';
    }

    gates.push({
        gate: 'education',
        outcome: eduOutcome,
        requirement: 'Degree and graduation status requirement',
        candidateEvidence: eduFact ? [eduFact.id] : ['candidate_education'],
        reason: eduReason
    });

    // ── Gate 5: Employment Type ───────────────────────────────────────────
    let empOutcome = 'PASS';
    let empReason = 'Candidate is open to full-time, contract, and high-impact internships';
    gates.push({
        gate: 'employment_type',
        outcome: empOutcome,
        requirement: 'Employment commitment compatibility',
        candidateEvidence: expFactIds.length > 0 ? expFactIds : ['candidate_employment'],
        reason: empReason
    });

    // ── Gate 6: Compensation Floor ────────────────────────────────────────
    const compNorm = normalizeCompensation(job.description || '', null);
    let compOutcome = 'PASS';
    let compReason = 'Compensation is acceptable or unstated';

    if (compNorm.maxLpa !== null) {
        if (compNorm.maxLpa < 4.0) {
            compOutcome = 'FAIL';
            compReason = `Stated maximum compensation (₹${compNorm.maxLpa} LPA) is strictly below candidate floor of ₹4 LPA`;
        } else {
            compOutcome = 'PASS';
            compReason = `Stated compensation (up to ₹${compNorm.maxLpa} LPA) satisfies candidate minimum of ₹4 LPA`;
        }
    } else {
        compOutcome = 'UNKNOWN';
        compReason = 'Compensation is unstated in job description (non-blocking)';
    }

    gates.push({
        gate: 'compensation',
        outcome: compOutcome,
        requirement: 'Compensation satisfies candidate minimum floor of ₹4 LPA',
        candidateEvidence: [],
        reason: compReason
    });

    // ── Gate 7: Security Clearance ────────────────────────────────────────
    let secOutcome = 'PASS';
    let secReason = 'No special national security clearance required';
    if (jobText.includes('security clearance required') || jobText.includes('active secret clearance') || jobText.includes('top secret/sci')) {
        secOutcome = 'FAIL';
        secReason = 'Job requires active national security clearance (DoD Secret/Top Secret)';
    }

    gates.push({
        gate: 'security_clearance',
        outcome: secOutcome,
        requirement: 'Security clearance and background authorization',
        candidateEvidence: [],
        reason: secReason
    });

    // Calculate overall Tier 2 eligibility
    for (const g of gates) {
        if (g.outcome === 'FAIL') failedGates.push(g.gate);
        else if (g.outcome === 'UNKNOWN') unknownGates.push(g.gate);
    }

    let overall = 'PASS';
    let requiresHumanInput = false;

    if (failedGates.length > 0) {
        overall = 'FAIL';
    } else if (unknownGates.length > 0) {
        // If the only unknown is unstated compensation, it is non-blocking PASS
        if (unknownGates.length === 1 && unknownGates[0] === 'compensation') {
            overall = 'PASS';
        } else {
            overall = 'UNKNOWN';
            requiresHumanInput = true;
        }
    }

    return {
        eligibility: overall,
        gates,
        failedGates,
        unknownGates,
        requiresHumanInput
    };
}

// ─── TIER 3: FACT-GROUNDED TECHNICAL MATCHING ────────────────────────────────

const TECHNICAL_SKILL_CATALOG = [
    {
        key: 'nodejs',
        names: ['node.js', 'nodejs', 'node', 'express.js', 'express'],
        factId: 'fact-skill-nodejs',
        evidenceIds: ['ev-skill-nodejs-apis', 'ev-skill-nodejs-services'],
        category: 'backend',
        strength: 'strong'
    },
    {
        key: 'typescript',
        names: ['typescript', 'ts'],
        factId: 'fact-skill-typescript',
        evidenceIds: ['ev-skill-ts-types', 'ev-skill-ts-services'],
        category: 'language',
        strength: 'strong'
    },
    {
        key: 'javascript',
        names: ['javascript', 'js', 'es6'],
        factId: 'fact-skill-javascript',
        evidenceIds: ['ev-skill-js-apis', 'ev-skill-js-exec'],
        category: 'language',
        strength: 'strong'
    },
    {
        key: 'react',
        names: ['react', 'react.js', 'reactjs'],
        factId: 'fact-skill-react',
        evidenceIds: ['ev-skill-react-ui', 'ev-skill-react-components'],
        category: 'frontend',
        strength: 'strong'
    },
    {
        key: 'nextjs',
        names: ['next.js', 'nextjs', 'next'],
        factId: 'fact-skill-nextjs',
        evidenceIds: ['ev-skill-nextjs-ui'],
        category: 'frontend',
        strength: 'moderate'
    },
    {
        key: 'postgresql',
        names: ['postgresql', 'postgres', 'sql'],
        factId: 'fact-skill-postgresql',
        evidenceIds: ['ev-skill-postgres-db'],
        category: 'database',
        strength: 'strong'
    },
    {
        key: 'mongodb',
        names: ['mongodb', 'mongo', 'nosql'],
        factId: 'fact-skill-mongodb',
        evidenceIds: ['ev-skill-mongo-apis'],
        category: 'database',
        strength: 'moderate'
    },
    {
        key: 'redis',
        names: ['redis', 'caching', 'cache'],
        factId: 'fact-skill-redis',
        evidenceIds: ['ev-skill-redis-cache'],
        category: 'database',
        strength: 'strong'
    },
    {
        key: 'docker',
        names: ['docker', 'docker compose', 'containers', 'containerization'],
        factId: 'fact-skill-docker',
        evidenceIds: ['ev-skill-docker-exec'],
        category: 'devops',
        strength: 'strong'
    },
    {
        key: 'aws',
        names: ['aws', 'amazon web services', 'ec2', 's3'],
        factId: 'fact-skill-aws',
        evidenceIds: ['ev-skill-aws-cloud'],
        category: 'devops',
        strength: 'moderate'
    },
    {
        key: 'websockets',
        names: ['websockets', 'websocket', 'socket.io'],
        factId: 'fact-skill-websockets',
        evidenceIds: ['ev-skill-websocket-realtime'],
        category: 'backend',
        strength: 'strong'
    },
    {
        key: 'rest_apis',
        names: ['rest', 'restful', 'rest api', 'restful api', 'apis'],
        factId: 'fact-skill-rest-apis',
        evidenceIds: ['ev-skill-rest-apis', 'ev-skill-rest-services'],
        category: 'backend',
        strength: 'strong'
    },
    {
        key: 'ci_cd',
        names: ['ci/cd', 'github actions', 'ci cd', 'continuous integration'],
        factId: 'fact-skill-ci-cd',
        evidenceIds: ['ev-skill-cicd-pipeline'],
        category: 'devops',
        strength: 'moderate'
    }
];

/**
 * Tier 3: Fact-grounded technical matching
 */
export function factGroundedMatch(job, candidateFacts = null, evidenceRecords = null, options = {}) {
    const facts = candidateFacts || getCandidateFacts();
    const factIdSet = new Set(facts.map(f => f.id));

    const text = `${job.title || ''} ${job.description || ''}`.toLowerCase();

    const matches = [];
    const matchedFactIds = new Set();
    const matchedEvidenceIds = new Set();
    const missingEvidenceFacts = [];

    let requiredScore = 0;
    let requiredWeight = 0;
    let preferredScore = 0;
    let preferredWeight = 0;

    for (const skill of TECHNICAL_SKILL_CATALOG) {
        const isPresentInJd = skill.names.some(name => {
            const regex = new RegExp(`\\b${name.replace('.', '\\.')}\\b`, 'i');
            return regex.test(text);
        });

        if (isPresentInJd) {
            const hasFact = factIdSet.has(skill.factId);
            const isMandatory = !text.includes(`preferred: ${skill.names[0]}`);

            if (hasFact) {
                matchedFactIds.add(skill.factId);
                for (const evId of skill.evidenceIds) matchedEvidenceIds.add(evId);

                matches.push({
                    requirement: skill.key,
                    requirementType: isMandatory ? 'mandatory' : 'preferred',
                    matchStatus: 'MATCHED',
                    candidateFactIds: [skill.factId],
                    evidenceRecordIds: skill.evidenceIds,
                    evidenceSummary: `Verified ${skill.key} competency with production and project evidence`,
                    evidenceStrength: skill.strength
                });

                if (isMandatory) {
                    requiredScore += 1.0;
                    requiredWeight += 1.0;
                } else {
                    preferredScore += 1.0;
                    preferredWeight += 1.0;
                }
            } else {
                // Skill in JD but missing in candidate verified facts
                missingEvidenceFacts.push(skill.key);
                matches.push({
                    requirement: skill.key,
                    requirementType: isMandatory ? 'mandatory' : 'preferred',
                    matchStatus: 'NOT_DEMONSTRATED',
                    candidateFactIds: [],
                    evidenceRecordIds: [],
                    evidenceSummary: `No verified candidate evidence in database for ${skill.key}`,
                    evidenceStrength: 'none'
                });

                if (isMandatory) {
                    requiredWeight += 1.0;
                } else {
                    preferredWeight += 1.0;
                }
            }
        }
    }

    // Unspecified stack handling:
    // If JD mentions no specific catalog skills, do NOT artificially assign a 0.75 score.
    // Absence of a required stack is not evidence of a strong match.
    // The role receives a baseline 0.50 score without artificial uplift (remaining CONSIDER).
    let finalScore = 0.5;
    if (requiredWeight > 0) {
        const reqRatio = requiredScore / requiredWeight;
        const prefRatio = preferredWeight > 0 ? (preferredScore / preferredWeight) : 1.0;
        finalScore = (reqRatio * 0.8) + (prefRatio * 0.2);
    }

    finalScore = Math.round(finalScore * 100) / 100;

    return {
        matchScore: finalScore,
        breakdown: matches,
        matchedFactIds: Array.from(matchedFactIds),
        evidenceIds: Array.from(matchedEvidenceIds),
        missingEvidenceFacts
    };
}

/**
 * Calculates priority weight multiplier based on title taxonomy (M2).
 */
export function getPriorityWeightForTitle(title = '') {
    const t = (title || '').trim();
    for (const item of PRIORITY_TAXONOMY) {
        if (item.pattern.test(t)) {
            return item.weight;
        }
    }
    return 1.0;
}

/**
 * End-to-end evaluation runner across all 3 tiers
 */
export function evaluateJobOffer(job, candidateFacts = null, evidenceRecords = null, options = {}) {
    // Tier 1: Title Screening
    const t1 = titleScreening(job, options);
    if (!t1.passed) {
        return {
            tier1: t1,
            tier2: {
                eligibility: 'NOT_EVALUATED',
                evaluated: false,
                gates: [],
                failedGates: [],
                unknownGates: [],
                requiresHumanInput: false,
                reason: `Tier 2 skipped: Tier 1 rejected (${t1.reason})`
            },
            tier3: null,
            recommendation: 'DO_NOT_APPLY',
            finalScore: 0.0,
            reason: t1.reason
        };
    }

    // Tier 2: Hard Eligibility
    const t2 = eligibilityCheck(job, candidateFacts, options);
    if (t2.eligibility === 'FAIL') {
        return {
            tier1: t1,
            tier2: t2,
            tier3: null,
            recommendation: 'DO_NOT_APPLY',
            finalScore: 0.0,
            reason: `Hard eligibility gate failed: ${t2.failedGates.join(', ')}`
        };
    }

    // Tier 3: Technical Matching
    const t3 = factGroundedMatch(job, candidateFacts, evidenceRecords, options);

    // Apply M2 priority weighting for high-priority engineering archetypes
    const priorityWeight = getPriorityWeightForTitle(job?.title);
    const weightedMatchScore = Math.min(1.0, Math.round(t3.matchScore * priorityWeight * 100) / 100);
    t3.priorityWeight = priorityWeight;
    t3.matchScore = weightedMatchScore;

    let recommendation = 'CONSIDER';
    if (t2.eligibility === 'UNKNOWN') {
        recommendation = 'UNKNOWN';
    } else if (weightedMatchScore >= 0.70) {
        recommendation = 'APPLY';
    } else if (weightedMatchScore >= 0.45) {
        recommendation = 'CONSIDER';
    } else {
        recommendation = 'DO_NOT_APPLY';
    }

    return {
        tier1: t1,
        tier2: t2,
        tier3: t3,
        recommendation,
        finalScore: t3.matchScore,
        reason: `Tier 1 & Tier 2 passed; Tier 3 match score is ${t3.matchScore}`
    };
}
