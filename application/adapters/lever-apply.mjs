/**
 * application/adapters/lever-apply.mjs — Lever Application Adapter
 *
 * Implements Milestone 3D Part 6:
 *   - Lever-specific field mapping, resume upload, validation and submission
 */

import { BaseApplyAdapter } from './base.mjs';

export class LeverApplyAdapter extends BaseApplyAdapter {
    constructor(options = {}) {
        super('lever', options);
    }

    async match(page, url) {
        const u = (url || '').toLowerCase();
        if (u.includes('jobs.lever.co') || u.includes('lever.co')) return true;
        if (page) {
            return page.evaluate(() => Boolean(document.querySelector('form#application-form, .application-form, a[href*="lever.co"]')));
        }
        return false;
    }

    async findSubmitButton(page) {
        if (!page) return null;
        return page.evaluate(() => {
            const btn = document.querySelector('#btn-submit, .template-btn-submit, .postings-btn-submit') ||
                        Array.from(document.querySelectorAll('button')).find(b => {
                            const txt = (b.innerText || '').toLowerCase().trim();
                            return txt === 'submit application' || txt === 'submit';
                        });
            if (!btn) return null;
            return {
                selector: btn.id ? `#${CSS.escape(btn.id)}` : '.template-btn-submit',
                text: btn.innerText?.trim() || 'Submit Application',
                disabled: Boolean(btn.disabled || btn.getAttribute('aria-disabled') === 'true')
            };
        });
    }

    async detectConfirmation(page) {
        const standard = await super.detectConfirmation(page);
        if (standard) return standard;

        return page.evaluate(() => {
            const url = window.location.href;
            if (url.includes('/thanks') || document.querySelector('.application-confirmation')) {
                return {
                    confirmed: true,
                    matchedPhrase: 'Lever thank you page reached',
                    confirmationReference: null,
                    url
                };
            }
            return null;
        });
    }
}
