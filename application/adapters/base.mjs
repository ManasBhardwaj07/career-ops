/**
 * application/adapters/base.mjs — Base Application Adapter Contract
 *
 * Implements Milestone 3D Part 6:
 *   - Common interface for platform-specific and generic application adapters
 */

import { detectFields } from '../detection/detect-fields.mjs';
import { fillApplicationFields } from '../autofill/fill-fields.mjs';
import { attachResume } from '../documents/attach-resume.mjs';

export class BaseApplyAdapter {
    constructor(name, options = {}) {
        this.name = name;
        this.options = options;
    }

    /**
     * Checks if page matches this adapter.
     */
    async match(page, url) {
        return false;
    }

    /**
     * Discovers all form fields on current page.
     */
    async detectFields(page) {
        return detectFields(page);
    }

    /**
     * Populates fields with verified candidate answers.
     */
    async fill(page, mappedFields) {
        return fillApplicationFields(page, mappedFields, this.options);
    }

    /**
     * Uploads candidate resume.
     */
    async attachResume(page, resumeOptions) {
        return attachResume(page, { ...resumeOptions, ...this.options });
    }

    /**
     * Inspects DOM for required fields and validation errors.
     */
    async validateForm(page) {
        return page.evaluate(() => {
            const errors = [];
            const invalidInputs = Array.from(document.querySelectorAll('input:invalid, select:invalid, textarea:invalid'));
            invalidInputs.forEach(inp => {
                errors.push({
                    name: inp.name || inp.id,
                    message: inp.validationMessage || 'Invalid input value'
                });
            });

            const errorBanners = Array.from(document.querySelectorAll('.error, .error-message, [class*="error"], [role="alert"]'));
            const bannerTexts = errorBanners
                .map(b => b.innerText.trim())
                .filter(t => t.length > 0 && t.length < 200);

            return {
                valid: errors.length === 0 && bannerTexts.length === 0,
                inputErrors: errors,
                bannerErrors: bannerTexts
            };
        });
    }

    /**
     * Clicks "Next" / "Continue" on multi-step forms if present.
     */
    async handleNextStep(page) {
        return page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('button, input[type="button"], a.btn'));
            const nextBtn = buttons.find(b => {
                const text = b.innerText.toLowerCase().trim();
                return (text === 'next' || text === 'continue' || text.includes('next step') || text === 'review');
            });

            if (nextBtn && !nextBtn.disabled) {
                nextBtn.click();
                return { clicked: true, buttonText: nextBtn.innerText.trim() };
            }
            return { clicked: false };
        });
    }

    /**
     * Locates submit button.
     */
    async findSubmitButton(page) {
        return page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('button, input[type="submit"]'));
            const submitBtn = buttons.find(b => {
                const text = (b.innerText || b.value || '').toLowerCase().trim();
                const isSubmitType = b.type === 'submit';
                return isSubmitType || text === 'submit' || text === 'submit application' || text === 'apply' || text.includes('submit');
            });

            if (!submitBtn) return null;
            return {
                selector: submitBtn.id ? `#${CSS.escape(submitBtn.id)}` :
                         (submitBtn.name ? `[name="${CSS.escape(submitBtn.name)}"]` : 'button[type="submit"]'),
                text: submitBtn.innerText || submitBtn.value,
                disabled: Boolean(submitBtn.disabled)
            };
        });
    }

    /**
     * Inspects current page for submission confirmation / receipt.
     */
    async detectConfirmation(page) {
        return page.evaluate(() => {
            const rawText = document.body ? document.body.innerText : '';
            const bodyText = rawText.toLowerCase();
            const confirmationPhrases = [
                'thank you for applying',
                'application submitted',
                'application has been submitted',
                'application received',
                'we have received your application',
                'successfully submitted'
            ];

            const foundPhrase = confirmationPhrases.find(p => bodyText.includes(p));
            if (!foundPhrase) return null;

            // Extract potential confirmation reference / ID preserving original casing
            const refMatch = rawText.match(/(?:confirmation|reference|application|submission)(?:\s+(?:reference|number|id|code|#))*\s*[:#]\s*([a-z0-9\-_]{5,40})/i);
            const confirmationRef = refMatch ? refMatch[1].trim() : null;

            return {
                confirmed: true,
                matchedPhrase: foundPhrase,
                confirmationReference: confirmationRef,
                url: window.location.href
            };
        });
    }
}
