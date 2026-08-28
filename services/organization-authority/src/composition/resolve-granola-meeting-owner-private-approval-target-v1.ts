import {
  resolveCurrentPrivateApprovalSlackTargetV1,
  type CurrentPrivateApprovalSlackTargetV1,
  type PrivateApprovalSlackTargetCoordinatesV1,
} from "@echo-brain/organization-control-plane/clean-runtime-v1";
import type Database from "better-sqlite3";
import type { MeetingDocument } from "../processing/core/contracts/meeting.js";
import { observeGranolaMeetingOwnerV1 } from "./granola-meeting-owner-observation.js";
import {
  resolveGranolaMeetingOwnerAssigneeV1,
  type CleanMeetingOwnerAssigneeV1,
} from "./sqlite-granola-meeting-owner-assignee-resolver.js";

export interface GranolaMeetingOwnerPrivateApprovalTargetV1 {
  readonly assignee: CleanMeetingOwnerAssigneeV1;
  readonly slack_target: CurrentPrivateApprovalSlackTargetV1;
}

export interface ResolveGranolaMeetingOwnerPrivateApprovalTargetInputV1 {
  readonly meeting: MeetingDocument;
  readonly authority_database: Database.Database;
  readonly control_plane_database: Database.Database;
  readonly coordinates: PrivateApprovalSlackTargetCoordinatesV1;
  readonly connection_id: string;
}

interface AuthorityMetadataRow {
  readonly authority_id: string;
  readonly organization_id: string;
}

/**
 * Composes the three evidence-only ownership steps required before private
 * approval delivery: raw Granola organizer observation, current Authority
 * membership resolution, and a current Control Plane Slack identity link.
 *
 * This is intentionally read-only. It does not persist an assignment, open a
 * DM, post a card, or choose an approval policy. Missing or mismatched proof
 * at any boundary is a normal no-target outcome.
 */
export function resolveGranolaMeetingOwnerPrivateApprovalTargetV1(
  input: ResolveGranolaMeetingOwnerPrivateApprovalTargetInputV1,
): GranolaMeetingOwnerPrivateApprovalTargetV1 | undefined {
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

  const observation = observeGranolaMeetingOwnerV1(input.meeting);
  if (observation === undefined) return undefined;

  const assignee = resolveGranolaMeetingOwnerAssigneeV1({
    authority_database: input.authority_database,
    organization_id: input.coordinates.organization_id,
    observation,
  });
  if (assignee === undefined) return undefined;

  const slackTarget = resolveCurrentPrivateApprovalSlackTargetV1(
    input.control_plane_database,
    input.coordinates,
    input.connection_id,
    assignee,
  );
  if (slackTarget === undefined) return undefined;

  return Object.freeze({
    assignee,
    slack_target: slackTarget,
  });
}
