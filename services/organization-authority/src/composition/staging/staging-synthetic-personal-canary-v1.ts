import type Database from 'better-sqlite3';
import {
  readStagingSyntheticCheckpointV1, STAGING_SYNTHETIC_CANARY_MEETING_ID_V1, STAGING_SYNTHETIC_TOOL_ID_V1,
} from '@echo-brain/provider-synthetic-demo/staging-synthetic-personal-meeting-provider-v1';
import type { MeetingIntakePersonV1, MeetingIntakeSettingV1 } from '../../adapters/persistence/sqlite/person-meeting-intake-v1.js';
import { queuePersonMeetingsV1, type createPersonMeetingRuntimeV1 } from '../person-meeting-runtime-v1.js';
import type { StagingSyntheticCanaryOutcomeV1 } from '../organization-authority-runtime.js';

export type { StagingSyntheticCanaryOutcomeV1 };
const MAXIMUM_PASSES = 5;

/** The single active owner of this Authority's organization holds the staging synthetic source. */
export function stagingSyntheticOwnerV1(database: Database.Database): MeetingIntakePersonV1 {
  const owners = database.prepare(`SELECT membership.organization_id, membership.principal_id, membership.membership_id
      FROM authority_memberships AS membership
      JOIN authority_metadata AS metadata ON metadata.organization_id = membership.organization_id
     WHERE membership.membership_type = 'owner' AND membership.status = 'active'
     ORDER BY membership.membership_id`).all() as MeetingIntakePersonV1[];
  if (owners.length !== 1) throw new Error('The staging synthetic source requires exactly one active owner');
  return owners[0]!;
}

/** Setup finalize: ensures the owner's synthetic source and queues the fixture meetings into it. */
export function queueStagingSyntheticMeetingsV1(
  input: Omit<Parameters<typeof queuePersonMeetingsV1>[0], 'person'>,
): Promise<MeetingIntakeSettingV1> {
  return queuePersonMeetingsV1({ ...input, person: stagingSyntheticOwnerV1(input.database) });
}

function canaryQueued(database: Database.Database, sourceKey: string): boolean {
  const row = database.prepare('SELECT cursor FROM authority_live_source_progress_v2 WHERE source_key = ?').get(sourceKey) as { cursor: string } | undefined;
  if (row === undefined) throw new Error('The staging synthetic source has no progress');
  return readStagingSyntheticCheckpointV1(row.cursor).manual.includes(STAGING_SYNTHETIC_CANARY_MEETING_ID_V1);
}

/** Ensures the owner's synthetic source, queues the canary meeting, runs one processing pass, reports the proposal. */
export async function runStagingSyntheticPersonalCanaryV1(input: {
  readonly database: Database.Database;
  readonly runtime: ReturnType<typeof createPersonMeetingRuntimeV1>;
  readonly signal: AbortSignal;
}): Promise<StagingSyntheticCanaryOutcomeV1> {
  const { database, runtime, signal } = input;
  signal.throwIfAborted();
  const setting = await runtime.queue({ person: stagingSyntheticOwnerV1(database), tool_id: STAGING_SYNTHETIC_TOOL_ID_V1,
    meeting_ids: [STAGING_SYNTHETIC_CANARY_MEETING_ID_V1], signal });
  // Passes are shared with other people's sources and earlier fixture imports, so allow a few.
  for (let pass = 0; pass < MAXIMUM_PASSES && canaryQueued(database, setting.source_key); pass++) {
    await runtime.processing.pollAndStageAdmittedMeetings(signal);
  }
  signal.throwIfAborted();
  if (canaryQueued(database, setting.source_key)) throw new Error('The staging synthetic canary meeting is still queued');
  // A rerun of the same canary revision reuses its frozen proposal, so this row is stable.
  const proposal = database.prepare(`SELECT candidate.disposition, outbox.approval_id, outbox.state
      FROM authority_live_source_candidates_v2 AS candidate
      JOIN authority_live_source_admission_v2 AS admission ON admission.semantic_input_sha256 = candidate.admission_semantic_input_sha256
      LEFT JOIN authority_live_approval_outbox_v2 AS outbox ON outbox.candidate_id = candidate.candidate_id
     WHERE admission.source_key = ? AND json_extract(candidate.meeting_json, '$.id') = ?
     ORDER BY candidate.created_at DESC, candidate.candidate_id DESC LIMIT 1`).get(setting.source_key, STAGING_SYNTHETIC_CANARY_MEETING_ID_V1) as
    { readonly disposition: string; readonly approval_id: string | null; readonly state: string | null } | undefined;
  if (proposal === undefined) throw new Error('The staging synthetic canary meeting was not processed');
  if (proposal.disposition !== 'actionable') return { kind: 'not_actionable', approval_id: null };
  return { kind: proposal.state === 'staged' ? 'staged' : 'not_staged', approval_id: proposal.approval_id };
}
