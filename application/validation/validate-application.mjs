/**
 * application/validation/validate-application.mjs — Application Form Validator
 *
 * Implements Milestone 3D Part 11:
 *   - Verifies required field completion
 *   - Validates email and phone formats
 *   - Ensures verified resume is attached
 *   - Checks for in-page validation errors
 */

/**
 * Validates the completed form state before proceeding to review.
 */
export async function validateApplication(page, {
    mappedFields = [],
    resumeAttached = false,
    adapter = null
} = {}) {
    const errors = [];
    const warnings = [];

    // 1. Check required fields
    for (const field of mappedFields) {
        if (field.required) {
            if (field.type === 'file') {
                if (!resumeAttached) {
                    errors.push(`Required file upload (${field.label || 'Resume'}) is not attached`);
                }
            } else if (!field.mappedValue || field.status !== 'mapped') {
                errors.push(`Required field "${field.label || field.name || field.classification}" has no verified answer`);
            }
        }

        // Format checks
        if (field.classification === 'email' && field.mappedValue) {
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            if (!emailRegex.test(field.mappedValue)) {
                errors.push(`Invalid email format: "${field.mappedValue}"`);
            }
        }

        if (field.classification === 'phone' && field.mappedValue) {
            const cleanPhone = field.mappedValue.replace(/[\s\-\(\)\+]/g, '');
            if (cleanPhone.length < 8 || cleanPhone.length > 15) {
                warnings.push(`Phone number "${field.mappedValue}" has non-standard length`);
            }
        }

        if (field.isSensitive && field.status === 'needs_user_input') {
            warnings.push(`Sensitive question "${field.label}" requires explicit human verification`);
        }
    }

    // 2. In-page DOM validation if page provided
    if (page) {
        try {
            const domCheck = adapter ? await adapter.validateForm(page) : await page.evaluate(() => {
                const invalidEls = Array.from(document.querySelectorAll('input:invalid, select:invalid, textarea:invalid'));
                return {
                    valid: invalidEls.length === 0,
                    inputErrors: invalidEls.map(el => ({ name: el.name || el.id, msg: el.validationMessage }))
                };
            });

            if (!domCheck.valid && domCheck.inputErrors) {
                domCheck.inputErrors.forEach(err => {
                    errors.push(`DOM validation failed for ${err.name}: ${err.msg}`);
                });
            }
        } catch {}
    }

    return {
        valid: errors.length === 0,
        errors,
        warnings,
        canProceedToReview: errors.length === 0
    };
}
