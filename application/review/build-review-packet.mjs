/**
 * application/review/build-review-packet.mjs — Application Review Packet Builder
 *
 * Implements Milestone 3D Part 12:
 *   - Builds comprehensive human review packet before submission approval
 *   - Saves review packet as Markdown and JSON artifacts
 */

import { writeFileSync, mkdirSync } from 'fs';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PACKETS_DIR = resolve(__dirname, '../../output/review-packets');

/**
 * Builds and saves a structured human review packet.
 */
export function buildReviewPacket({
    applicationId,
    job,
    company,
    portalType,
    portalUrl,
    candidateName = null,
    candidateEmail = null,
    candidatePhone = null,
    resumeVersion,
    resumeValidation = null,
    mappedFields = [],
    validationResult = null,
    submissionPolicy = 'MANUAL_REVIEW',
    authorization = null,
    outputDir = DEFAULT_PACKETS_DIR
}) {
    mkdirSync(outputDir, { recursive: true });

    const filledFields = mappedFields.filter(m => m.status === 'mapped');
    const unansweredFields = mappedFields.filter(m => m.status !== 'mapped');

    const timestamp = new Date().toISOString();

    const safeCandidate = {
        name: candidateName || '[NOT CONFIGURED]',
        email: candidateEmail || '[NOT CONFIGURED]',
        phone: candidatePhone || '[NOT CONFIGURED]'
    };

    const packetData = {
        applicationId,
        candidate: safeCandidate,
        jobId: job.id,
        jobTitle: job.title,
        jobLocation: job.location,
        companyId: company?.id || job.company_id,
        companyName: company?.name || 'Unknown Employer',
        portalType,
        portalUrl,
        timestamp,
        submissionPolicy,
        authorization: authorization ? {
            id: authorization.id,
            scope: authorization.scope,
            status: authorization.status,
            expiresAt: authorization.expires_at
        } : null,
        resume: {
            versionId: resumeVersion?.id,
            variant: resumeVersion?.variant_label,
            filePath: resumeVersion?.file_path,
            pageCount: resumeVersion?.page_count || 1,
            atsParseScore: resumeVersion?.ats_parse_score || 1.0
        },
        validation: {
            valid: validationResult ? validationResult.valid : true,
            errors: validationResult?.errors || [],
            warnings: validationResult?.warnings || []
        },
        filledFields: filledFields.map(f => ({
            classification: f.classification,
            label: f.label || f.name,
            value: f.mappedValue,
            source: f.source
        })),
        unansweredFields: unansweredFields.map(f => ({
            classification: f.classification,
            label: f.label || f.name,
            required: Boolean(f.required),
            status: f.status,
            reason: f.reason
        }))
    };

    const mdLines = [
        `# Application Review Packet — ${packetData.companyName}: ${packetData.jobTitle}`,
        `**Candidate:** ${safeCandidate.name} (\`${safeCandidate.email}\`, \`${safeCandidate.phone}\`)`,
        `**Application ID:** \`${applicationId}\` | **Timestamp:** ${timestamp}`,
        `**Portal:** ${portalType.toUpperCase()} | **URL:** [${portalUrl}](${portalUrl})`,
        `**Submission Policy:** \`${submissionPolicy}\` | **Authorization:** ${authorization ? `APPROVED (\`${authorization.id}\`)` : 'PENDING USER APPROVAL'}`,
        '',
        '## 1. Resume Document Attachment',
        `- **Version ID:** \`${packetData.resume.versionId || 'N/A'}\``,
        `- **Variant:** \`${packetData.resume.variant || 'default'}\``,
        `- **Page Count:** ${packetData.resume.pageCount} page(s)`,
        `- **File Path:** \`${packetData.resume.filePath || 'N/A'}\``,
        `- **ATS Parse Score:** ${packetData.resume.atsParseScore} / 1.0`,
        '',
        '## 2. Populated Form Fields',
        '| Classification | Field Label | Populated Value | Verified Source |',
        '|---|---|---|---|',
        ...filledFields.map(f =>
            `| \`${f.classification}\` | ${f.label || f.name} | **${f.mappedValue}** | \`${f.source}\` |`
        ),
        '',
        '## 3. Unanswered / Pending Questions',
        unansweredFields.length === 0
            ? '_All detected fields successfully mapped to verified candidate facts._'
            : [
                '| Classification | Field Label | Required | Status | Reason |',
                '|---|---|:---:|---|---|',
                ...unansweredFields.map(f =>
                    `| \`${f.classification}\` | ${f.label || f.name} | ${f.required ? 'YES ⚠️' : 'NO'} | \`${f.status}\` | ${f.reason || 'Unmapped'} |`
                )
            ].join('\n'),
        '',
        '## 4. Validation Status',
        `- **Form Valid:** ${packetData.validation.valid ? 'YES ✅' : 'NO ❌'}`,
        ...(packetData.validation.errors.length > 0
            ? ['### Errors:', ...packetData.validation.errors.map(e => `- ❌ ${e}`)]
            : []),
        ...(packetData.validation.warnings.length > 0
            ? ['### Warnings:', ...packetData.validation.warnings.map(w => `- ⚠️ ${w}`)]
            : [])
    ];

    const mdContent = mdLines.join('\n');
    const mdPath = join(outputDir, `${applicationId}.md`);
    const jsonPath = join(outputDir, `${applicationId}.json`);

    writeFileSync(mdPath, mdContent, 'utf8');
    writeFileSync(jsonPath, JSON.stringify(packetData, null, 2), 'utf8');

    return {
        packetData,
        mdPath,
        jsonPath
    };
}
