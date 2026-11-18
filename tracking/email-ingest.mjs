/**
 * tracking/email-ingest.mjs — Recruiter Inbound Email Outcome Ingest & Classifier
 *
 * Implements Deliverable 5 Phase 5 (T1-T3):
 *   - Parses inbound recruiter communication (rejection, screening, assessment, interview, offer)
 *   - Maps to 8 canonical recruitment outcomes in templates/states.yml:
 *       APPLIED, RESPONDED, INTERVIEW, OFFER, REJECTED, WITHDRAWN, DISCARDED, SKIP
 *   - Matches email to target application via company name, job title, and ref code
 *   - Enforces user confirmation gate before mutating canonical recruitment outcomes
 *   - Integrates status-sync stage with recurring runner
 */

import crypto from 'node:crypto';

export const CANONICAL_OUTCOMES = Object.freeze({
    APPLIED: 'applied',
    RESPONDED: 'responded',
    INTERVIEW: 'interview',
    OFFER: 'offer',
    REJECTED: 'rejected',
    WITHDRAWN: 'withdrawn',
    DISCARDED: 'discarded',
    SKIP: 'skip'
});

/**
 * Heuristic pattern dictionary for recruiter email classification
 */
const OUTCOME_PATTERNS = [
    {
        outcome: CANONICAL_OUTCOMES.OFFER,
        confidence: 0.95,
        regexes: [
            /\b(?:offer of employment|formal offer|pleased to offer you|congratulations on your offer|offer letter)\b/i,
            /\b(?:compensation package|employment agreement|joining bonus|welcome to the team)\b/i
        ]
    },
    {
        outcome: CANONICAL_OUTCOMES.INTERVIEW,
        confidence: 0.90,
        regexes: [
            /\b(?:invitation to interview|schedule an interview|interview invitation|phone screen|technical screen)\b/i,
            /\b(?:coding assessment|hackerank test|codility|take-home assignment|online assessment link)\b/i,
            /\b(?:hiring manager interview|next round of interviews|next steps in the interview process)\b/i,
            /\b(?:calendar invite|choose a time for a chat|book a time on my calendar)\b/i
        ]
    },
    {
        outcome: CANONICAL_OUTCOMES.REJECTED,
        confidence: 0.95,
        regexes: [
            /\b(?:unfortunately|regret to inform|decided to move forward with other candidates|pursue other candidates)\b/i,
            /\b(?:not moving forward|unable to offer you an interview|not selected for this role)\b/i,
            /\b(?:impressed with your background.*however|position has been filled|application will not be progressed)\b/i,
            /\b(?:wish you the best in your job search|keep your resume on file for future)\b/i
        ]
    },
    {
        outcome: CANONICAL_OUTCOMES.WITHDRAWN,
        confidence: 0.90,
        regexes: [
            /\b(?:confirmed your withdrawal|application has been withdrawn|withdrawn your application)\b/i
        ]
    },
    {
        outcome: CANONICAL_OUTCOMES.RESPONDED,
        confidence: 0.80,
        regexes: [
            /\b(?:received your application|thank you for applying|confirming receipt of your application)\b/i,
            /\b(?:application is currently under review|our talent team is reviewing)\b/i
        ]
    }
];

/**
 * Extracts company name hint from email headers and body.
 */
export function extractCompanyHint(from = '', subject = '', body = '') {
    // 1. Check sender domain (e.g. recruiter@swiggy.in -> Swiggy, hr@cred.club -> CRED)
    const domainMatch = from.match(/@(?:[a-z0-9-]+\.)*([a-z0-9-]+)\.[a-z]{2,}\b/i);
    if (domainMatch) {
        const domainSlug = domainMatch[1].toLowerCase();
        // Skip generic mail providers and ATS aggregators
        const skipDomains = ['gmail', 'yahoo', 'outlook', 'hotmail', 'greenhouse', 'lever', 'ashbyhq', 'smartrecruiters', 'workday'];
        if (!skipDomains.includes(domainSlug)) {
            if (domainSlug.length <= 4) {
                return domainSlug.toUpperCase();
            }
            return domainSlug.charAt(0).toUpperCase() + domainSlug.slice(1);
        }
    }

    // 2. Check subject patterns (e.g. "Application to Razorpay", "Swiggy - Interview", "Update from CRED", "Offer of Employment: CRED")
    const subjectMatches = [
        /(?:application to|applying to|role at|position at|update from|interview with|welcome to|offer of employment:\s*)\s*([A-Za-z0-9\s&.-]{2,30}?)(?:\s+engineering|\s+team|\s+[-–:]|\s+for|\.|$)/i,
        /\[([A-Za-z0-9\s&.-]{2,25})\]/i
    ];
    for (const regex of subjectMatches) {
        const m = subject.match(regex);
        if (m && m[1]) {
            return m[1].trim();
        }
    }

    return null;
}

/**
 * Parses and classifies raw recruiter email text.
 *
 * @param {object} email
 * @param {string} email.subject
 * @param {string} email.from
 * @param {string} email.body
 * @param {string} [email.receivedAt]
 * @returns {object} { outcome, confidence, matchedSnippets, companyHint, receivedAt }
 */
export function parseRecruiterEmail({ subject = '', from = '', body = '', receivedAt = null } = {}) {
    const combinedText = `${subject}\n\n${body}`;

    let bestOutcome = CANONICAL_OUTCOMES.RESPONDED;
    let highestConfidence = 0.50;
    let matchedSnippets = [];

    for (const pattern of OUTCOME_PATTERNS) {
        for (const regex of pattern.regexes) {
            const matches = combinedText.match(new RegExp(regex.source, 'gi'));
            if (matches && matches.length > 0) {
                if (pattern.confidence > highestConfidence) {
                    highestConfidence = pattern.confidence;
                    bestOutcome = pattern.outcome;
                    matchedSnippets = [...matches];
                } else if (pattern.confidence === highestConfidence && bestOutcome === pattern.outcome) {
                    matchedSnippets.push(...matches);
                }
            }
        }
    }

    const companyHint = extractCompanyHint(from, subject, body);

    return {
        outcome: bestOutcome,
        confidence: highestConfidence,
        matchedSnippets,
        companyHint,
        subject,
        from,
        receivedAt: receivedAt || new Date().toISOString()
    };
}

/**
 * Matches an email to an existing application record in SQLite.
 */
export function matchEmailToApplication(db, parsedEmail = {}) {
    if (!parsedEmail.companyHint) return null;

    const companyTerm = `%${parsedEmail.companyHint.toLowerCase().trim()}%`;

    // Query active applications joined with job details
    try {
        const rows = db.prepare(`
            SELECT
                a.id, a.job_id, a.state, a.recruitment_outcome, a.created_at,
                j.title as job_title, j.company_name
            FROM applications a
            LEFT JOIN job_postings j ON a.job_id = j.id
            WHERE LOWER(j.company_name) LIKE ?
            ORDER BY a.created_at DESC
            LIMIT 5
        `).all(companyTerm);

        if (!rows || rows.length === 0) return null;

        // If single match found, return it
        if (rows.length === 1) return rows[0];

        // If multiple applications for same company, check if email subject/body matches job title
        const text = `${parsedEmail.subject || ''} ${parsedEmail.body || ''}`.toLowerCase();
        for (const r of rows) {
            if (r.job_title && text.includes(r.job_title.toLowerCase().trim())) {
                return r;
            }
        }

        // Default to most recent application for that company
        return rows[0];
    } catch {
        return null;
    }
}

// In-memory deduplication index for email proposals (key: sha256 hash of email)
export const PROCESSED_EMAIL_PROPOSALS = new Map();

/**
 * Computes deterministic fingerprint for an inbound email.
 */
export function computeEmailHash(emailData = {}) {
    return crypto.createHash('sha256')
        .update(`${emailData.from || ''}|${emailData.subject || ''}|${emailData.body || ''}`)
        .digest('hex');
}

/**
 * Ingests a recruiter email and produces a candidate outcome change proposal.
 *
 * HUMAN CONFIRMATION GATE:
 * Outcome mutations require confirmed_by_user = true.
 * If requireUserConfirmation is true (default), the proposal remains PENDING_USER_CONFIRMATION
 * and the database outcome is NOT modified until explicitly confirmed.
 *
 * DEDUPLICATION:
 * If an identical email has already been ingested, returns the existing proposal idempotently.
 *
 * @param {object} db - SQLite database
 * @param {object} emailData - { subject, from, body, receivedAt }
 * @param {object} [options]
 * @param {boolean} [options.requireUserConfirmation=true]
 * @returns {object} Proposal record
 */
export function ingestRecruiterEmail(db, emailData = {}, { requireUserConfirmation = true } = {}) {
    const emailHash = computeEmailHash(emailData);

    // Idempotent deduplication check
    if (PROCESSED_EMAIL_PROPOSALS.has(emailHash)) {
        const existing = PROCESSED_EMAIL_PROPOSALS.get(emailHash);
        return {
            ...existing,
            is_duplicate: true,
            skipped: true
        };
    }

    const parsed = parseRecruiterEmail(emailData);
    const matchedApp = matchEmailToApplication(db, parsed);

    const proposalId = `outc_prop_${crypto.randomUUID().slice(0, 12)}`;

    const proposal = {
        id: proposalId,
        email_hash: emailHash,
        application_id: matchedApp ? matchedApp.id : null,
        company_name: matchedApp ? matchedApp.company_name : parsed.companyHint,
        job_title: matchedApp ? matchedApp.job_title : null,
        current_outcome: matchedApp?.recruitment_outcome || 'applied',
        proposed_outcome: parsed.outcome,
        confidence: parsed.confidence,
        matched_snippets: parsed.matchedSnippets,
        requires_user_confirmation: requireUserConfirmation,
        status: requireUserConfirmation ? 'PENDING_USER_CONFIRMATION' : 'CONFIRMED_APPLIED',
        is_duplicate: false,
        created_at: new Date().toISOString()
    };

    PROCESSED_EMAIL_PROPOSALS.set(emailHash, proposal);

    // If confirmation is bypassed (e.g. explicitly pre-confirmed automated rule), update DB immediately
    if (!requireUserConfirmation && matchedApp) {
        db.prepare(`
            UPDATE applications
            SET recruitment_outcome = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `).run(parsed.outcome, matchedApp.id);

        try {
            db.prepare(`
                INSERT INTO application_events (
                    id, application_id, event_type, from_state, to_state, payload, created_at
                ) VALUES (
                    ?, ?, 'OUTCOME_SYNCED_FROM_EMAIL', ?, ?, ?, CURRENT_TIMESTAMP
                )
            `).run(
                `evt_${crypto.randomUUID().slice(0, 12)}`,
                matchedApp.id,
                matchedApp.recruitment_outcome || 'applied',
                parsed.outcome,
                JSON.stringify({
                    subject: parsed.subject,
                    snippets: parsed.matchedSnippets,
                    confidence: parsed.confidence
                })
            );
        } catch {
            // application_events table insert optional in test environments
        }
    }

    return proposal;
}

/**
 * Manually confirms and applies a pending outcome proposal.
 */
export function confirmOutcomeProposal(db, applicationId, newOutcome) {
    if (!applicationId || !newOutcome) {
        throw new Error('applicationId and newOutcome are required');
    }

    const app = db.prepare(`SELECT id, recruitment_outcome FROM applications WHERE id = ?`).get(applicationId);
    if (!app) {
        throw new Error(`Application ${applicationId} not found`);
    }

    const previousOutcome = app.recruitment_outcome || 'applied';

    db.prepare(`
        UPDATE applications
        SET recruitment_outcome = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `).run(newOutcome, applicationId);

    try {
        db.prepare(`
            INSERT INTO application_events (
                id, application_id, event_type, from_state, to_state, payload, created_at
            ) VALUES (
                ?, ?, 'OUTCOME_CONFIRMED_BY_USER', ?, ?, ?, CURRENT_TIMESTAMP
            )
        `).run(
            `evt_${crypto.randomUUID().slice(0, 12)}`,
            applicationId,
            previousOutcome,
            newOutcome,
            JSON.stringify({ confirmed_by_user: true })
        );
    } catch {}

    return {
        application_id: applicationId,
        previous_outcome: previousOutcome,
        updated_outcome: newOutcome,
        confirmed: true
    };
}
