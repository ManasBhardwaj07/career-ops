/**
 * application/adapters/workday-apply.mjs — Workday Application Adapter
 *
 * Implements Milestone 3D Part 6:
 *   - Recognizes Workday candidate portal
 *   - Identifies sign-in / candidate account requirements
 */

import { BaseApplyAdapter } from './base.mjs';

export class WorkdayApplyAdapter extends BaseApplyAdapter {
    constructor(options = {}) {
        super('workday', options);
    }

    async match(page, url) {
        const u = (url || '').toLowerCase();
        if (u.includes('myworkdayjobs.com') || u.includes('workday.com')) return true;
        if (page) {
            return page.evaluate(() => Boolean(document.querySelector('[data-automation-id*="workday"]')));
        }
        return false;
    }

    /**
     * Checks if Workday requires user login / registration before application.
     */
    async requiresAuthentication(page) {
        return page.evaluate(() => {
            const text = document.body ? document.body.innerText.toLowerCase() : '';
            return text.includes('sign in') || text.includes('create account') ||
                   Boolean(document.querySelector('[data-automation-id="signInSubmitButton"], [data-automation-id="createAccountSubmitButton"]'));
        });
    }
}
