/**
 * application/detection/classify-fields.mjs — Form Field Semantic Classifier
 *
 * Implements Milestone 3D Part 7:
 *   - Semantic classification of detected form fields
 *   - Flags sensitive, legal, demographic and work-auth fields requiring human confirmation
 */

export const FIELD_CLASSIFICATIONS = {
    FIRST_NAME: 'first_name',
    LAST_NAME: 'last_name',
    FULL_NAME: 'full_name',
    EMAIL: 'email',
    PHONE: 'phone',
    LOCATION: 'location',
    LINKEDIN: 'linkedin',
    GITHUB: 'github',
    PORTFOLIO: 'portfolio',
    CURRENT_COMPANY: 'current_company',
    EDUCATION_SCHOOL: 'education_school',
    EDUCATION_DEGREE: 'education_degree',
    GRADUATION_DATE: 'graduation_date',
    SKILLS: 'skills',
    RESUME: 'resume',
    COVER_LETTER: 'cover_letter',
    WORK_AUTHORIZATION: 'work_authorization',
    VISA_SPONSORSHIP: 'visa_sponsorship',
    SALARY: 'salary',
    LEGAL_ATTESTATION: 'legal_attestation',
    EEO_GENDER: 'eeo_gender',
    EEO_RACE: 'eeo_race',
    EEO_VETERAN: 'eeo_veteran',
    EEO_DISABILITY: 'eeo_disability',
    NOTICE_PERIOD: 'notice_period',
    TOTAL_EXPERIENCE: 'total_experience',
    CUSTOM: 'custom'
};

export const SENSITIVE_CLASSIFICATIONS = [
    FIELD_CLASSIFICATIONS.WORK_AUTHORIZATION,
    FIELD_CLASSIFICATIONS.VISA_SPONSORSHIP,
    FIELD_CLASSIFICATIONS.SALARY,
    FIELD_CLASSIFICATIONS.LEGAL_ATTESTATION,
    FIELD_CLASSIFICATIONS.EEO_GENDER,
    FIELD_CLASSIFICATIONS.EEO_RACE,
    FIELD_CLASSIFICATIONS.EEO_VETERAN,
    FIELD_CLASSIFICATIONS.EEO_DISABILITY
];

/**
 * Classifies a detected form field from its metadata.
 */
export function classifyField(rawField) {
    const textToMatch = [
        rawField.label || '',
        rawField.name || '',
        rawField.id || '',
        rawField.placeholder || '',
        rawField.ariaLabel || '',
        rawField.autocomplete || ''
    ].join(' ').toLowerCase();

    const type = (rawField.type || 'text').toLowerCase();

    // 1. File Upload (Resume / Cover Letter)
    if (type === 'file') {
        if (textToMatch.includes('cover') || textToMatch.includes('letter')) {
            return { classification: FIELD_CLASSIFICATIONS.COVER_LETTER, confidence: 0.9, isSensitive: false };
        }
        return { classification: FIELD_CLASSIFICATIONS.RESUME, confidence: 0.95, isSensitive: false };
    }

    // 2. Sensitive / Legal / Work Auth questions (MANDATORY HUMAN CONFIRMATION)
    if (
        textToMatch.includes('authorized to work') ||
        textToMatch.includes('work authorization') ||
        textToMatch.includes('legal right to work') ||
        textToMatch.includes('legally authorized') ||
        textToMatch.includes('eligible to work')
    ) {
        return { classification: FIELD_CLASSIFICATIONS.WORK_AUTHORIZATION, confidence: 0.95, isSensitive: true };
    }

    if (
        textToMatch.includes('sponsorship') ||
        textToMatch.includes('visa sponsorship') ||
        textToMatch.includes('require visa') ||
        textToMatch.includes('will you now or in the future require') ||
        textToMatch.includes('immigration sponsorship')
    ) {
        return { classification: FIELD_CLASSIFICATIONS.VISA_SPONSORSHIP, confidence: 0.95, isSensitive: true };
    }

    if (
        textToMatch.includes('salary') ||
        textToMatch.includes('compensation') ||
        textToMatch.includes('expected pay') ||
        textToMatch.includes('desired salary')
    ) {
        return { classification: FIELD_CLASSIFICATIONS.SALARY, confidence: 0.9, isSensitive: true };
    }

    if (
        textToMatch.includes('certify') ||
        textToMatch.includes('attest') ||
        textToMatch.includes('consent') ||
        textToMatch.includes('terms and conditions') ||
        textToMatch.includes('acknowledge') ||
        textToMatch.includes('agree to the')
    ) {
        return { classification: FIELD_CLASSIFICATIONS.LEGAL_ATTESTATION, confidence: 0.85, isSensitive: true };
    }

    // Demographic / EEO questions
    if (textToMatch.includes('gender') || textToMatch.includes('sex')) {
        return { classification: FIELD_CLASSIFICATIONS.EEO_GENDER, confidence: 0.9, isSensitive: true };
    }
    if (textToMatch.includes('race') || textToMatch.includes('ethnicity') || textToMatch.includes('hispanic')) {
        return { classification: FIELD_CLASSIFICATIONS.EEO_RACE, confidence: 0.9, isSensitive: true };
    }
    if (textToMatch.includes('veteran') || textToMatch.includes('military')) {
        return { classification: FIELD_CLASSIFICATIONS.EEO_VETERAN, confidence: 0.9, isSensitive: true };
    }
    if (textToMatch.includes('disability') || textToMatch.includes('handicap')) {
        return { classification: FIELD_CLASSIFICATIONS.EEO_DISABILITY, confidence: 0.9, isSensitive: true };
    }

    // 3. Contact & Identity Information
    if (
        type === 'email' ||
        textToMatch.includes('email') ||
        textToMatch.includes('e-mail')
    ) {
        return { classification: FIELD_CLASSIFICATIONS.EMAIL, confidence: 0.95, isSensitive: false };
    }

    if (
        type === 'tel' ||
        textToMatch.includes('phone') ||
        textToMatch.includes('mobile') ||
        textToMatch.includes('cell') ||
        textToMatch.includes('telephone')
    ) {
        return { classification: FIELD_CLASSIFICATIONS.PHONE, confidence: 0.95, isSensitive: false };
    }

    if (
        textToMatch.includes('first name') ||
        textToMatch.includes('given name') ||
        rawField.autocomplete === 'given-name' ||
        rawField.name === 'first_name' ||
        rawField.name === 'firstname'
    ) {
        return { classification: FIELD_CLASSIFICATIONS.FIRST_NAME, confidence: 0.95, isSensitive: false };
    }

    if (
        textToMatch.includes('last name') ||
        textToMatch.includes('family name') ||
        textToMatch.includes('surname') ||
        rawField.autocomplete === 'family-name' ||
        rawField.name === 'last_name' ||
        rawField.name === 'lastname'
    ) {
        return { classification: FIELD_CLASSIFICATIONS.LAST_NAME, confidence: 0.95, isSensitive: false };
    }

    if (
        (textToMatch.includes('full name') || textToMatch.includes('candidate name') || textToMatch.includes('your name') || rawField.name === 'name' || rawField.name === '_systemfield_name' || /^\s*name\s*$/i.test(rawField.label || '')) &&
        !textToMatch.includes('first') && !textToMatch.includes('last') && !textToMatch.includes('company')
    ) {
        return { classification: FIELD_CLASSIFICATIONS.FULL_NAME, confidence: 0.9, isSensitive: false };
    }

    // Total Experience & Seniority Questions
    if (
        /\b(?:total|years\s+of|work|relevant)?\s*experience\b/i.test(textToMatch) ||
        /\bhow\s+many\s+years\b/i.test(textToMatch)
    ) {
        return { classification: FIELD_CLASSIFICATIONS.TOTAL_EXPERIENCE, confidence: 0.9, isSensitive: false };
    }

    if (
        /\b(?:location|current\s+location|city|address|postal|zip)\b/i.test(textToMatch) ||
        rawField.autocomplete === 'address-level2' ||
        rawField.autocomplete === 'address-line1'
    ) {
        return { classification: FIELD_CLASSIFICATIONS.LOCATION, confidence: 0.85, isSensitive: false };
    }

    // 4. Social & Portfolio Links
    if (textToMatch.includes('linkedin')) {
        return { classification: FIELD_CLASSIFICATIONS.LINKEDIN, confidence: 0.95, isSensitive: false };
    }
    if (textToMatch.includes('github')) {
        return { classification: FIELD_CLASSIFICATIONS.GITHUB, confidence: 0.95, isSensitive: false };
    }
    if (textToMatch.includes('portfolio') || textToMatch.includes('website') || textToMatch.includes('personal site')) {
        return { classification: FIELD_CLASSIFICATIONS.PORTFOLIO, confidence: 0.9, isSensitive: false };
    }

    // 5. Employment & Education History
    if (textToMatch.includes('current company') || textToMatch.includes('current employer')) {
        return { classification: FIELD_CLASSIFICATIONS.CURRENT_COMPANY, confidence: 0.85, isSensitive: false };
    }
    if (textToMatch.includes('school') || textToMatch.includes('university') || textToMatch.includes('college')) {
        return { classification: FIELD_CLASSIFICATIONS.EDUCATION_SCHOOL, confidence: 0.85, isSensitive: false };
    }
    if (textToMatch.includes('degree') || textToMatch.includes('major') || textToMatch.includes('field of study')) {
        return { classification: FIELD_CLASSIFICATIONS.EDUCATION_DEGREE, confidence: 0.85, isSensitive: false };
    }
    if (textToMatch.includes('graduation') || textToMatch.includes('grad year') || textToMatch.includes('end date')) {
        return { classification: FIELD_CLASSIFICATIONS.GRADUATION_DATE, confidence: 0.85, isSensitive: false };
    }
    if (textToMatch.includes('notice period') || textToMatch.includes('availability') || textToMatch.includes('start date')) {
        return { classification: FIELD_CLASSIFICATIONS.NOTICE_PERIOD, confidence: 0.8, isSensitive: false };
    }

    return { classification: FIELD_CLASSIFICATIONS.CUSTOM, confidence: 0.3, isSensitive: false };
}
