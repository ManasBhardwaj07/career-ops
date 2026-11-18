/**
 * application/adapters/greenhouse-apply.mjs — Greenhouse Application Adapter
 *
 * Implements Milestone 3D Part 6:
 *   - Greenhouse-specific field mapping, resume upload, validation and submission
 */

import { BaseApplyAdapter } from './base.mjs';

export class GreenhouseApplyAdapter extends BaseApplyAdapter {
    constructor(options = {}) {
        super('greenhouse', options);
    }

    async match(page, url) {
        const u = (url || '').toLowerCase();
        if (u.includes('greenhouse.io')) return true;
        if (page) {
            return page.evaluate(() => Boolean(document.querySelector('#grnhse_app, form#application_form')));
        }
        return false;
    }

    async findSubmitButton(page) {
        if (!page) return null;
        return page.evaluate(() => {
            const btn = document.querySelector('#submit_app, input[type="submit"]#submit_app') ||
                        Array.from(document.querySelectorAll('button[type="submit"], button')).find(b => {
                            const txt = (b.innerText || '').toLowerCase().trim();
                            return txt === 'submit application' || txt === 'submit';
                        });
            if (!btn) return null;
            return {
                selector: btn.id ? `#${CSS.escape(btn.id)}` : 'button[type="submit"]',
                text: btn.innerText?.trim() || btn.value || 'Submit Application',
                disabled: Boolean(btn.disabled || btn.getAttribute('aria-disabled') === 'true')
            };
        });
    }

    async detectConfirmation(page) {
        const standard = await super.detectConfirmation(page);
        if (standard) return standard;

        return page.evaluate(() => {
            const confEl = document.querySelector('#application_confirmation, .application-confirmation');
            if (confEl) {
                return {
                    confirmed: true,
                    matchedPhrase: confEl.innerText.trim(),
                    confirmationReference: null,
                    url: window.location.href
                };
            }
            return null;
        });
    }
}
