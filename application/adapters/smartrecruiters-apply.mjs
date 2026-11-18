/**
 * application/adapters/smartrecruiters-apply.mjs — SmartRecruiters Application Adapter
 *
 * Implements Milestone 3D Part 6:
 *   - SmartRecruiters-specific field mapping and form filling
 */

import { BaseApplyAdapter } from './base.mjs';

export class SmartRecruitersApplyAdapter extends BaseApplyAdapter {
    constructor(options = {}) {
        super('smartrecruiters', options);
    }

    async match(page, url) {
        const u = (url || '').toLowerCase();
        if (u.includes('smartrecruiters.com')) return true;
        if (page) {
            return page.evaluate(() => Boolean(document.querySelector('form#apply-form, [data-test*="smartrecruiters"]')));
        }
        return false;
    }
}
