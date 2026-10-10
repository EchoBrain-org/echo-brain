import type Database from 'better-sqlite3';
import {
  readStagingSyntheticCheckpointV1, stagingSyntheticCanaryEntryV1, stagingSyntheticCanaryMeetingV1,
  STAGING_SYNTHETIC_CANARY_MEETING_ID_V1, STAGING_SYNTHETIC_TOOL_ID_V1,
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

function queued(database: Database.Database, sourceKey: string, entry: string): boolean {
  const row = database.prepare('SELECT cursor FROM authority_live_source_progress_v2 WHERE source_key = ?').get(sourceKey) as { cursor: string } | undefined;
  if (row === undefined) throw new Error('The staging synthetic source has no progress');
  return readStagingSyntheticCheckpointV1(row.cursor).manual.includes(entry);
}

/**
 * Ensures the owner's synthetic source, queues this release's canary meeting,
 * runs passes over that source only, and reports the proposal for this
 * release's revision.
 */
export async function runStagingSyntheticPersonalCanaryV1(input: {
  readonly database: Database.Database;
  readonly runtime: ReturnType<typeof createPersonMeetingRuntimeV1>;
  readonly release_id: string;
  readonly signal: AbortSignal;
}): Promise<StagingSyntheticCanaryOutcomeV1> {
  const { database, runtime, signal } = input;
  signal.throwIfAborted();
  const entry = stagingSyntheticCanaryEntryV1(input.release_id);
  const revision = stagingSyntheticCanaryMeetingV1(input.release_id).provenance.canonical_revision;
  const setting = await runtime.queue({ person: stagingSyntheticOwnerV1(database), tool_id: STAGING_SYNTHETIC_TOOL_ID_V1, meeting_ids: [entry], signal });
  // Each pass waits for one already running on this source; earlier fixture imports may be ahead, so allow a few.
  for (let pass = 0; pass < MAXIMUM_PASSES && queued(database, setting.source_key, entry); pass++) {
    await runtime.pollAndStageSource(setting.source_key, signal);
  }
  signal.throwIfAborted();
  if (queued(database, setting.source_key, entry)) throw new Error('The staging synthetic canary meeting is still queued');
  // A rerun for the same release reuses its frozen proposal; a later release's canary supersedes it.
  const proposal = database.prepare(`SELECT candidate.disposition, outbox.approval_id, outbox.state
      FROM authority_live_source_candidates_v2 AS candidate
      JOIN authority_live_source_admission_v2 AS admission ON admission.semantic_input_sha256 = candidate.admission_semantic_input_sha256
      LEFT JOIN authority_live_approval_outbox_v2 AS outbox ON outbox.candidate_id = candidate.candidate_id
     WHERE admission.source_key = ? AND json_extract(candidate.meeting_json, '$.id') = ?
       AND json_extract(candidate.meeting_json, '$.provenance.canonical_revision') = ?`).get(setting.source_key, STAGING_SYNTHETIC_CANARY_MEETING_ID_V1, revision) as
    { readonly disposition: string; readonly approval_id: string | null; readonly state: string | null } | undefined;
  if (proposal === undefined) {
    const held = database.prepare('SELECT failure_stage FROM authority_live_source_held_extractions_v1 WHERE source_key = ? AND external_id = ? AND revision_id = ?')
      .pluck().get(setting.source_key, STAGING_SYNTHETIC_CANARY_MEETING_ID_V1, revision) as string | undefined;
    throw new Error(`The staging synthetic canary meeting was not processed${held === undefined ? '' : `; it is held at ${held}`}`);
  }
  if (proposal.disposition !== 'actionable') return { kind: 'not_actionable', approval_id: null };
  return { kind: proposal.state === 'staged' ? 'staged' : 'not_staged', approval_id: proposal.approval_id };
}
