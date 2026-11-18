/**
 * application/adapters/ashby-apply.mjs — Ashby Application Adapter
 *
 * Implements Milestone 3D Part 6:
 *   - Ashby-specific field mapping, resume upload, validation and submission
 */

import { BaseApplyAdapter } from './base.mjs';

export class AshbyApplyAdapter extends BaseApplyAdapter {
    constructor(options = {}) {
        super('ashby', options);
    }

    async match(page, url) {
        const u = (url || '').toLowerCase();
        if (u.includes('jobs.ashbyhq.com') || u.includes('ashbyhq.com')) return true;
        if (page) {
            return page.evaluate(() => Boolean(document.querySelector('[class*="ashby"], form[class*="ashby"]')));
        }
        return false;
    }

    async findSubmitButton(page) {
        if (!page) return null;
        return page.evaluate(() => {
            const btn = document.querySelector('button.ashby-application-form-submit-button, [data-testid="submit-application"], button[class*="submitButton"]') ||
                        Array.from(document.querySelectorAll('button')).find(b => {
                            const txt = (b.innerText || '').toLowerCase().trim();
                            return txt === 'submit application' || txt === 'submit';
                        });
            if (!btn) return null;
            return {
                selector: 'button.ashby-application-form-submit-button, button[class*="submitButton"]',
                text: btn.innerText?.trim() || 'Submit Application',
                disabled: Boolean(btn.disabled || btn.getAttribute('aria-disabled') === 'true')
            };
        });
    }
}
