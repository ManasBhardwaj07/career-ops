/**
 * application/adapters/index.mjs — Application Adapter Resolver
 */

import { GreenhouseApplyAdapter } from './greenhouse-apply.mjs';
import { LeverApplyAdapter } from './lever-apply.mjs';
import { AshbyApplyAdapter } from './ashby-apply.mjs';
import { WorkdayApplyAdapter } from './workday-apply.mjs';
import { SmartRecruitersApplyAdapter } from './smartrecruiters-apply.mjs';
import { GenericApplyAdapter } from './generic-apply.mjs';
import { PORTAL_TYPES } from '../detection/detect-portal.mjs';

/**
 * Returns an instance of the appropriate adapter for the portal type.
 */
export function getAdapterForPortal(portalType, options = {}) {
    switch (portalType) {
        case PORTAL_TYPES.GREENHOUSE:
            return new GreenhouseApplyAdapter(options);
        case PORTAL_TYPES.LEVER:
            return new LeverApplyAdapter(options);
        case PORTAL_TYPES.ASHBY:
            return new AshbyApplyAdapter(options);
        case PORTAL_TYPES.WORKDAY:
            return new WorkdayApplyAdapter(options);
        case PORTAL_TYPES.SMARTRECRUITERS:
            return new SmartRecruitersApplyAdapter(options);
        case PORTAL_TYPES.GENERIC:
        default:
            return new GenericApplyAdapter(options);
    }
}
