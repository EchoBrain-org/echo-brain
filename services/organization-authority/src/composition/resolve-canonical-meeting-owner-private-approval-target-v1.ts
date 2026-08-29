import { isCanonicalPersonEmail } from "../domain/person-session-rules.js";
import type { MeetingDocument } from "../processing/core/contracts/meeting.js";
import {
  resolvePrivateApprovalTargetV1,
  type PrivateApprovalTargetResolverInputV1,
  type PrivateApprovalTargetV1,
} from "./resolve-private-approval-target-v1.js";

/**
 * Reads only the canonical meeting envelope. An adapter establishes ownership
 * while normalizing source data; composition only turns that proven person
 * identity into the current Authority and Slack delivery target.
 */
export function observeCanonicalMeetingOwnerEmailV1(
  meeting: MeetingDocument,
): string | undefined {
  const ownerParticipantId = meeting.context?.owner_participant_id;
  if (typeof ownerParticipantId !== "string" || ownerParticipantId.length === 0) {
    return undefined;
  }

  const owners = meeting.participants.filter(
    (participant) => participant.id === ownerParticipantId,
  );
  if (owners.length !== 1) return undefined;

  const emails = (owners[0]!.identities ?? [])
    .filter((identity) => identity.kind === "email")
    .map((identity) => identity.value)
    .filter(isCanonicalPersonEmail);
  return emails.length === 1 ? emails[0] : undefined;
}

/**
 * Resolves the canonical meeting owner through the provider-neutral Authority
 * membership and current Slack identity proofs.
 */
export function resolveCanonicalMeetingOwnerPrivateApprovalTargetV1(
  input: PrivateApprovalTargetResolverInputV1,
): PrivateApprovalTargetV1 | undefined {
  const ownerEmail = observeCanonicalMeetingOwnerEmailV1(input.meeting);
  if (ownerEmail === undefined) return undefined;
  return resolvePrivateApprovalTargetV1({
    authority_database: input.authority_database,
    control_plane_database: input.control_plane_database,
    coordinates: input.coordinates,
    connection_id: input.connection_id,
    owner_email: ownerEmail,
  });
}
