import { canonicalSha256 } from '@echo-brain/federation-protocol';
import type { JsonValue, Sha256Digest } from '../application/contracts.js';

/**
 * Every derived row id is a pure function of log content, under a distinct
 * `kind` so two different node families can never collide. Nothing here reads
 * authority state, wall-clock time, or the derived store itself, so a full
 * rebuild reproduces every id exactly.
 */

export function derivedAtomId(recordHash: string, signalId: string): Sha256Digest {
  return canonicalSha256({
    kind: 'echo-organization-record-atom',
    record_hash: recordHash,
    signal_id: signalId,
  });
}

export function derivedMeetingSnapshotId(
  recordHash: string,
  meetingId: string,
  meetingRevision: string,
): Sha256Digest {
  return canonicalSha256({
    kind: 'echo-organization-record-meeting-snapshot',
    record_hash: recordHash,
    meeting_id: meetingId,
    meeting_revision: meetingRevision,
  });
}

export function derivedParticipantObservationId(
  snapshotId: string,
  participant: JsonValue,
): Sha256Digest {
  return canonicalSha256({
    kind: 'echo-organization-record-participant-observation',
    meeting_snapshot_id: snapshotId,
    participant,
  });
}

export function derivedRejectionId(recordHash: string): Sha256Digest {
  return canonicalSha256({
    kind: 'echo-organization-record-rejection',
    record_hash: recordHash,
  });
}

/** The approval act atoms share. Identifies the human act, not the row. */
export function derivedApprovalGroupId(
  installationId: string,
  idempotencyKey: string,
): Sha256Digest {
  return canonicalSha256({
    kind: 'echo-organization-record-approval-group',
    installation_id: installationId,
    idempotency_key: idempotencyKey,
  });
}
