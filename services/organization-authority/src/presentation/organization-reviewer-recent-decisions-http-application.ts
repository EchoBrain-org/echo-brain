import type { OrganizationReviewerRecentDecisionsRequestV1 } from '@echo-brain/organization-api';
import type { PreparedReviewerRecentDecisionsResponse } from '../application/reviewer-recent-decisions.js';

export interface OrganizationReviewerRecentDecisionsHttpApplication {
  reviewerRecentDecisions(
    request: OrganizationReviewerRecentDecisionsRequestV1,
  ): PreparedReviewerRecentDecisionsResponse;
}
