import type Database from 'better-sqlite3';
import { canonicalJson, canonicalSha256 } from '@echo-brain/federation-protocol';
import { PERSON_HAND_IN_MEETING_ID_V1, PERSON_HAND_IN_TOOL_ID_V1, validatePersonHandInMeetingV1 } from '@echo-brain/organization-api';
import type { ProviderHttpApplicationV1 } from '@echo-brain/organization-authority-kernel/application/ports/provider-http-application-v1';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import { AdapterError, assertCanonicalMeetingDocument, type AdapterConfig, type MeetingDocument, type MeetingSourceAdapter } from '@echo-brain/organization-processing/core';
import type { AdmittedMeetingSourceCursorPolicyV1 } from '@echo-brain/organization-processing/admitted-meeting-processing/admitted-meeting-source-cursor-policy-v1';
import { HAND_IN_SOURCE_ADAPTER_ID_V1, SqlitePersonHandInMeetingsV1, type StoredHandInMeetingV1 } from '../adapters/persistence/sqlite/person-hand-in-meetings-v1.js';
import type { PersonalMeetingCheckpointV1 } from '../adapters/persistence/sqlite/person-meeting-intake-v1.js';
import { meetingIntakePersonV1, type PersonMeetingProviderV1 } from './person-meeting-runtime-v1.js';

export { HAND_IN_SOURCE_ADAPTER_ID_V1 };
/** How a hand-in source's custodian is established: the person handed the meeting in themselves. */
export const HAND_IN_CUSTODIAN_ASSURANCE_V1 = 'person_hand_in';
const VERSION = '1.0.0';
const NORMALIZER_VERSION = 'person-hand-in-meeting-v1';
const CURSOR_PREFIX = 'person-hand-in-meeting-v1:';
/** The meetings API lists at most 50 pending imports. */
const MAXIMUM_PENDING = 50;
/** At most this many transcript blocks; the paragraphs past them share the last one. */
const MAXIMUM_TRANSCRIPT_BLOCKS = 1_000;

/** A hand-in source's checkpoint: only the handed-in meetings waiting to be processed. It never watches anything. */
export type HandInCheckpointV1 = PersonalMeetingCheckpointV1;

function invalidCursor(): never {
  throw new AuthorityOperationError('invalid_request', 'Hand-in meeting checkpoint is invalid');
}

export function readHandInCheckpointV1(cursor: string): HandInCheckpointV1 {
  if (!cursor.startsWith(CURSOR_PREFIX) || Buffer.byteLength(cursor) > 16_384) invalidCursor();
  let value: unknown;
  try { value = JSON.parse(cursor.slice(CURSOR_PREFIX.length)); } catch { invalidCursor(); }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalidCursor();
  const row = value as Record<string, unknown>, { manual } = row;
  if (Object.keys(row).join(',') !== 'manual' || !Array.isArray(manual) || manual.length > MAXIMUM_PENDING ||
      manual.some(id => typeof id !== 'string' || !PERSON_HAND_IN_MEETING_ID_V1.test(id)) || new Set(manual).size !== manual.length) invalidCursor();
  return row as unknown as HandInCheckpointV1;
}

/** A full queue refuses one more meeting until one is processed. */
export function writeHandInCheckpointV1(checkpoint: PersonalMeetingCheckpointV1): string {
  if (checkpoint.manual.length > MAXIMUM_PENDING) throw new AuthorityOperationError('rate_limited', 'Too many handed-in meetings are waiting to be processed');
  const cursor = CURSOR_PREFIX + canonicalJson(checkpoint as never);
  readHandInCheckpointV1(cursor);
  return cursor;
}

const CURSOR_POLICY: AdmittedMeetingSourceCursorPolicyV1 = Object.freeze({
  source_adapter_id: HAND_IN_SOURCE_ADAPTER_ID_V1,
  assert_live_cursor(cursor: string) { readHandInCheckpointV1(cursor); },
});

/** The transcript's paragraphs, split at blank lines, one block each; readers join transcript blocks with a blank line again. */
function paragraphs(text: string): readonly string[] {
  // Each part starts past its separator's whitespace, and the text has none at its ends, so no part is empty.
  const parts = text === '' ? [] : text.split(/\n[^\S\n]*\n\s*/u).map(part => part.trimEnd());
  return parts.length <= MAXIMUM_TRANSCRIPT_BLOCKS ? parts
    : [...parts.slice(0, MAXIMUM_TRANSCRIPT_BLOCKS - 1), parts.slice(MAXIMUM_TRANSCRIPT_BLOCKS - 1).join('\n\n')];
}

/**
 * The meeting a kept hand-in names: its title, time, notes and transcript as handed in, and nothing it did not say. The
 * revision covers the built meeting, so a later normalizer is a new revision rather than a conflicting one.
 */
export function handInMeetingDocumentV1(identity: MeetingSourceAdapter['identity'], stored: StoredHandInMeetingV1): MeetingDocument {
  const { meeting, external_id: id } = stored;
  const transcript = paragraphs(meeting.transcript);
  const body = {
    title: meeting.title, lifecycle: 'completed' as const,
    ...(meeting.started_at === undefined ? {} : { time: { actual_start_at: meeting.started_at,
      ...(meeting.ended_at === undefined ? {} : { actual_end_at: meeting.ended_at }),
      // A whole day is its date at noon UTC, read in UTC, so no reader moves it to another day.
      ...(meeting.all_day === true ? { timezone: 'UTC', all_day: true } : meeting.time_zone === undefined ? {} : { timezone: meeting.time_zone }) } }),
    capture: { state: 'complete' as const, components: [{ kind: 'metadata' as const, state: 'available' as const },
      { kind: 'notes' as const, state: meeting.notes === '' ? 'not_provided' as const : 'available' as const },
      { kind: 'transcript' as const, state: transcript.length === 0 ? 'not_provided' as const : 'available' as const }] },
    participants: [], artifacts: [],
    // A person or another tool's AI may have written it; ECHO knows only that it was brought in from elsewhere.
    content: [
      ...(meeting.notes === '' ? [] : [{ id: `${id}:notes`, kind: 'note' as const, text: meeting.notes, origin: 'imported' as const }]),
      ...transcript.map((text, index) => ({ id: `${id}:transcript:${index}`, kind: 'transcript' as const, text, sequence: index, origin: 'imported' as const })),
    ],
  };
  const document: MeetingDocument = { schema_version: 1, id, ...body, provenance: { source: identity, external_id: id,
    canonical_revision: canonicalSha256({ kind: 'echo-person-hand-in-meeting-v1', body }), observed_at: stored.submitted_at, normalizer_version: NORMALIZER_VERSION } };
  assertCanonicalMeetingDocument(document, identity);
  return document;
}

/**
 * The pasted-meeting source: every member hands meetings in from any tool, with no connection step. A submitted
 * payload is kept in the Authority with its queued import, in one transaction, and the source builds the meeting from
 * it. One source per person; no folders and no browsing.
 */
export function createHandInPersonMeetingProviderV1(options: { readonly database: Database.Database }): PersonMeetingProviderV1 {
  const store = new SqlitePersonHandInMeetingsV1(options.database);
  const initial = () => writeHandInCheckpointV1({ manual: [] });
  const connection_http: ProviderHttpApplicationV1 = Object.freeze({
    routes: [],
    async accept() { throw new AuthorityOperationError('not_found', 'Hand-in meeting route unavailable'); },
  });
  const provider: PersonMeetingProviderV1 = {
    id: PERSON_HAND_IN_TOOL_ID_V1, normalizer_version: NORMALIZER_VERSION, custodian_assurance: HAND_IN_CUSTODIAN_ASSURANCE_V1, submitters: 'members',
    connection_http,
    // A cancelled hand-in's payload goes with its queued import, unless the meeting was already admitted.
    forget: (setting, meetingId) => store.forget(setting.source_key, meetingId),
    // Nothing to watch: only `off` is a watch, and automatic import is never active.
    cursor: Object.freeze({ read: readHandInCheckpointV1, write: writeHandInCheckpointV1, policy: CURSOR_POLICY, initial,
      watch: (checkpoint: PersonalMeetingCheckpointV1, watch: { readonly watch: string }): PersonalMeetingCheckpointV1 => watch.watch === 'off' ? checkpoint : invalidCursor(),
      ready: () => false }),
    // Always linked: handing a meeting in needs no account anywhere else.
    tool: () => ({ tool_id: PERSON_HAND_IN_TOOL_ID_V1, display_name: 'Paste a meeting', availability: 'enabled', personal_status: 'linked',
      external_scope_id: null, external_subject_id: PERSON_HAND_IN_TOOL_ID_V1, organization_setup: null }),
    async open(person, current, signal) {
      signal?.throwIfAborted(); current();
      const identity = { kind: 'meeting-source' as const, adapter_id: HAND_IN_SOURCE_ADAPTER_ID_V1, version: VERSION,
        instance_id: `hand-in-${canonicalSha256(meetingIntakePersonV1(person)).slice(7)}` };
      return {
        identity, custodian: { kind: 'echo-person-hand-in-custodian-v1', person: identity.instance_id }, email: null, workspace: null, current,
        async folders() { return []; },
        async browse() { throw new AuthorityOperationError('not_found', 'Handed-in meetings have no folders'); },
        async preview() { throw new AuthorityOperationError('not_found', 'Handed-in meetings have no preview'); },
        submit(meeting, setting) {
          current();
          if (setting.source_adapter_id !== HAND_IN_SOURCE_ADAPTER_ID_V1 || setting.source_adapter_instance_id !== identity.instance_id) {
            throw new AuthorityOperationError('stale_access_state', 'Meeting source changed');
          }
          return store.save(setting.source_key, validatePersonHandInMeetingV1(meeting));
        },
      };
    },
    source(setting, current) {
      const identity = { kind: 'meeting-source' as const, adapter_id: setting.source_adapter_id, instance_id: setting.source_adapter_instance_id, version: setting.source_adapter_version };
      if (identity.adapter_id !== HAND_IN_SOURCE_ADAPTER_ID_V1 || identity.version !== VERSION) throw new Error('Hand-in meeting source identity differs');
      return {
        identity, requireCurrent: current,
        validateConfig: (config: AdapterConfig) => config.adapter_id === identity.adapter_id && config.instance_id === identity.instance_id
          ? { ok: true, errors: [] } : { ok: false, errors: ['hand-in meeting source identity differs'] },
        healthCheck: async () => ({ status: 'healthy' as const, checked_at: new Date().toISOString(), message: 'handed-in meetings' }),
        async pull(request) {
          current();
          const checkpoint = readHandInCheckpointV1(request.cursor ?? initial());
          const id = checkpoint.manual[0];
          if (id === undefined) return { meetings: [] };
          // Only a hand-in queues an id, together with its payload; an id without one is refused, never skipped.
          const stored = store.get(setting.source_key, id);
          if (stored === undefined) throw new AdapterError('permanently_rejected', 'handed-in meeting is not kept for this source', false);
          current();
          return { meetings: [handInMeetingDocumentV1(identity, stored)], next_cursor: writeHandInCheckpointV1({ ...checkpoint, manual: checkpoint.manual.slice(1) }) };
        },
      };
    },
  };
  return Object.freeze(provider);
}
