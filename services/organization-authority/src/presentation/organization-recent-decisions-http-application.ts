import type { OrganizationRecentDecisionsRequestV1 } from '@echo-brain/organization-api';
import type { PreparedOrganizationRecentDecisionsResponse } from '../application/recent-decisions.js';

/** The pre-serialized permission-pilot read exposed to the HTTP adapter. */
export interface OrganizationRecentDecisionsHttpApplication {
  recentDecisions(
    request: OrganizationRecentDecisionsRequestV1,
  ): PreparedOrganizationRecentDecisionsResponse;
}
