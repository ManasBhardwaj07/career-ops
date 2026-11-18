/**
 * application/adapters/generic-apply.mjs — Generic Form Application Adapter
 *
 * Implements Milestone 3D Part 6:
 *   - Universal fallback adapter for arbitrary employer career portals
 */

import { BaseApplyAdapter } from './base.mjs';

export class GenericApplyAdapter extends BaseApplyAdapter {
    constructor(options = {}) {
        super('generic', options);
    }

    async match(page, url) {
        return true; // Universal fallback
    }
}
