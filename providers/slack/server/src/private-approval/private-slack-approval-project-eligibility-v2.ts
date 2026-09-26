/** Server-owned project choices for a frozen private-approval card. */
import type Database from "better-sqlite3";
import type { PrivateSlackApprovalReviewerV1 } from "./resolve-private-slack-approval-reviewer-target-v1.js";
import type { PrivateSlackApprovalEligibleProjectV2 } from "./private-slack-approval-block-kit-card-v2.js";

export interface PrivateSlackApprovalProjectEligibilityInputV2 {
  readonly database: Database.Database;
  readonly organization_id: string;
  readonly reviewer: PrivateSlackApprovalReviewerV1;
}

/**
 * This is deliberately an Authority-local read, not the Person list API: card
 * staging has an exact verified reviewer binding but no bearer session to
 * borrow. The returned rows are the immutable eligibility snapshot displayed
 * and committed by the V2 card.
 */
export function listPrivateSlackApprovalEligibleProjectsV2(
  input: PrivateSlackApprovalProjectEligibilityInputV2,
): readonly PrivateSlackApprovalEligibleProjectV2[] {
  const rows = input.database.prepare(`SELECT project.project_id, grant.project_membership_id, project.name
    FROM authority_project_memberships_v1 AS grant
    JOIN authority_projects_v1 AS project
      ON project.organization_id=grant.organization_id AND project.project_id=grant.project_id
    JOIN authority_memberships AS membership
      ON membership.organization_id=grant.organization_id
     AND membership.principal_id=grant.principal_id
     AND membership.membership_id=grant.membership_id
     AND membership.membership_type=grant.membership_type
    WHERE grant.organization_id=? AND grant.principal_id=? AND grant.membership_id=? AND grant.membership_type=?
      AND grant.status='active' AND membership.status='active'
    ORDER BY grant.project_id ASC, grant.project_membership_id ASC
    LIMIT 101`).all(
    input.organization_id,
    input.reviewer.principal_id,
    input.reviewer.membership_id,
    input.reviewer.membership_type,
  ) as readonly PrivateSlackApprovalEligibleProjectV2[];
  return Object.freeze(rows.map((row) => Object.freeze({
    project_id: row.project_id,
    project_membership_id: row.project_membership_id,
    name: row.name,
  })));
}
