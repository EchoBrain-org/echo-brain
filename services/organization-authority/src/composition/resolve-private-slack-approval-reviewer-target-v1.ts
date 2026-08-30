import {
  resolveCurrentSlackDmApprovalReviewerTargetV1,
  type CurrentSlackDmApprovalReviewerTargetV1,
  type SlackDmApprovalReviewerTargetCoordinatesV1,
} from "@echo-brain/organization-control-plane/clean-runtime-v1";
import type Database from "better-sqlite3";
import { personLoginGrantExpectedEmailSha256 } from "../domain/person-email-binding.js";
import { isCanonicalPersonEmail } from "../domain/person-session-rules.js";
import type { MeetingDocument } from "../processing/core/contracts/meeting.js";

export interface PrivateSlackApprovalReviewerV1 {
  readonly principal_id: string;
  readonly membership_id: string;
  readonly membership_type: "owner" | "employee";
}

/** A current, verified private-approval recipient independent of its meeting provider. */
export interface PrivateSlackApprovalReviewerTargetV1 {
  readonly reviewer: PrivateSlackApprovalReviewerV1;
  readonly slack_target: CurrentSlackDmApprovalReviewerTargetV1;
}

/**
 * The stager supplies a canonical meeting to an owner resolver. The shared
 * proof below intentionally receives only a canonical observed email.
 */
export interface PrivateSlackApprovalReviewerTargetResolverInputV1 {
  readonly meeting: MeetingDocument;
  readonly authority_database: Database.Database;
  readonly control_plane_database: Database.Database;
  readonly coordinates: SlackDmApprovalReviewerTargetCoordinatesV1;
  readonly connection_id: string;
}

export type PrivateSlackApprovalReviewerTargetResolverV1 = (
  input: PrivateSlackApprovalReviewerTargetResolverInputV1,
) => PrivateSlackApprovalReviewerTargetV1 | undefined;

export interface ResolvePrivateSlackApprovalReviewerTargetInputV1
  extends Omit<PrivateSlackApprovalReviewerTargetResolverInputV1, "meeting"> {
  readonly reviewer_email: string;
}

interface AuthorityMetadataRow {
  readonly authority_id: string;
  readonly organization_id: string;
}

type ReviewerRow = PrivateSlackApprovalReviewerV1;

function canonicalEmail(value: string): string | undefined {
  const normalized = value.trim().toLowerCase();
  return isCanonicalPersonEmail(normalized) ? normalized : undefined;
}

/**
 * Resolves the one current membership that is bound to the observed owner
 * through a consumed initial OIDC grant. Ambiguity remains a hard no-target.
 */
function resolveObservedApprovalReviewer(input: {
  readonly authority_database: Database.Database;
  readonly organization_id: string;
  readonly email: string;
}): PrivateSlackApprovalReviewerV1 | undefined {
  const rows = input.authority_database
    .prepare(
      `SELECT DISTINCT membership.principal_id, membership.membership_id,
                       membership.membership_type
         FROM authority_memberships AS membership
         JOIN authority_oidc_identity_bindings AS identity_binding
           ON identity_binding.organization_id = membership.organization_id
          AND identity_binding.principal_id = membership.principal_id
          AND identity_binding.membership_id = membership.membership_id
          AND identity_binding.membership_type = membership.membership_type
         JOIN authority_person_login_grants AS login_grant
           ON login_grant.login_grant_sha256 =
                identity_binding.initial_login_grant_sha256
          AND login_grant.organization_id = identity_binding.organization_id
          AND login_grant.principal_id = identity_binding.principal_id
          AND login_grant.membership_id = identity_binding.membership_id
          AND login_grant.membership_type = identity_binding.membership_type
        WHERE membership.organization_id = ?
          AND membership.status = 'active'
          AND identity_binding.status = 'active'
          AND login_grant.consumed_at = identity_binding.bound_at
          AND login_grant.expected_email_sha256 = ?
          AND (
            (membership.membership_type = 'owner'
             AND membership.employee_email IS NULL
             AND membership.employee_email_sha256 IS NULL)
            OR
            (membership.membership_type = 'employee'
             AND membership.employee_email_sha256 = login_grant.expected_email_sha256)
          )`,
    )
    .all(
      input.organization_id,
      personLoginGrantExpectedEmailSha256(input.email),
    ) as ReviewerRow[];
  if (rows.length !== 1) return undefined;
  const row = rows[0];
  if (
    row === undefined ||
    typeof row.principal_id !== "string" ||
    typeof row.membership_id !== "string" ||
    (row.membership_type !== "owner" && row.membership_type !== "employee")
  ) {
    return undefined;
  }
  return Object.freeze({
    principal_id: row.principal_id,
    membership_id: row.membership_id,
    membership_type: row.membership_type,
  });
}

/**
 * Composes the provider-neutral proof required before private approval
 * delivery. A source adapter establishes the canonical meeting owner; this
 * boundary verifies current Authority membership and the current Control
 * Plane Slack identity link.
 */
export function resolvePrivateSlackApprovalReviewerTargetV1(
  input: ResolvePrivateSlackApprovalReviewerTargetInputV1,
): PrivateSlackApprovalReviewerTargetV1 | undefined {
  const authority = input.authority_database
    .prepare(
      `SELECT authority_id, organization_id
         FROM authority_metadata
        WHERE singleton = 1`,
    )
    .get() as AuthorityMetadataRow | undefined;
  if (
    authority === undefined ||
    authority.authority_id !== input.coordinates.authority_id ||
    authority.organization_id !== input.coordinates.organization_id
  ) {
    return undefined;
  }

  const email = canonicalEmail(input.reviewer_email);
  if (email === undefined) return undefined;
  const reviewer = resolveObservedApprovalReviewer({
    authority_database: input.authority_database,
    organization_id: input.coordinates.organization_id,
    email,
  });
  if (reviewer === undefined) return undefined;

  const slackTarget = resolveCurrentSlackDmApprovalReviewerTargetV1(
    input.control_plane_database,
    input.coordinates,
    input.connection_id,
    reviewer,
  );
  if (slackTarget === undefined) return undefined;

  return Object.freeze({
    reviewer,
    slack_target: slackTarget,
  });
}
