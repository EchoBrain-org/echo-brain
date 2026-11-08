import { isCanonicalPersonEmail } from "@echo-brain/organization-authority-kernel/shared/person-email-rules";
import type { AdapterIdentity } from "./adapter.js";
import type { DecisionSet, ExtractedSignal } from "./decision.js";
import type {
  MeetingBatch,
  MeetingDocument,
  MeetingParticipant,
  MeetingParticipantIdentity,
} from "./meeting.js";

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function onlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allowlist = new Set(allowed);
  const unexpected = Object.keys(value).find((key) => !allowlist.has(key));
  if (unexpected !== undefined) {
    throw new Error(`${label}.${unexpected} is not part of the canonical shape`);
  }
}

function nonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const milliseconds = new Date(value).getTime();
  return (
    !Number.isNaN(milliseconds) &&
    new Date(milliseconds).toISOString() === value
  );
}

function timestamp(value: unknown, label: string): asserts value is string {
  if (!isCanonicalTimestamp(value)) {
    throw new Error(`${label} must be a canonical UTC timestamp`);
  }
}

function jsonValue(value: unknown, label: string, depth = 0): void {
  if (depth > 32) throw new Error(`${label} exceeds the JSON depth limit`);
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${label} contains a non-finite number`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => jsonValue(item, `${label}[${index}]`, depth + 1));
    return;
  }
  const record = object(value, label);
  for (const [key, item] of Object.entries(record)) {
    jsonValue(item, `${label}.${key}`, depth + 1);
  }
}

function metadata(value: unknown, label: string): void {
  if (value === undefined) return;
  object(value, label);
  jsonValue(value, label);
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 1024 * 1024) {
    throw new Error(`${label} exceeds the safety limit`);
  }
}

function optionalNonEmptyString(value: unknown, label: string): void {
  if (value !== undefined) nonEmptyString(value, label);
}

function oneOf(value: unknown, allowed: readonly string[], label: string): asserts value is string {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new Error(`${label} is invalid`);
  }
}

function optionalTimestamp(value: unknown, label: string): void {
  if (value !== undefined) timestamp(value, label);
}

function array(value: unknown, label: string, maximum: number): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  if (value.length > maximum) throw new Error(`${label} exceeds the safety limit`);
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value)) throw new Error(`${label} must be dense`);
  }
  return value;
}

/** One field's check: its value, its label, and the object that holds it. */
type Check = (value: unknown, label: string, record: Record<string, unknown>) => void;

/**
 * Checks `value` is an object holding only `checks`' keys, then runs each check
 * in order on its field, labelled `<label>.<key>`.
 */
function fields(
  value: unknown,
  label: string,
  checks: Readonly<Record<string, Check>>,
): Record<string, unknown> {
  const record = object(value, label);
  onlyKeys(record, Object.keys(checks), label);
  for (const [key, check] of Object.entries(checks)) check(record[key], `${label}.${key}`, record);
  return record;
}

function optional(check: Check): Check {
  return (value, label, record) => {
    if (value !== undefined) check(value, label, record);
  };
}

const text: Check = (value, label) => nonEmptyString(value, label);
const optionalText: Check = (value, label) => optionalNonEmptyString(value, label);
const optionalAt: Check = (value, label) => optionalTimestamp(value, label);
const json: Check = (value, label) => metadata(value, label);
const flag: Check = (value, label) => {
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean`);
};

function among(...allowed: string[]): (value: unknown, label: string) => void {
  return (value, label) => oneOf(value, allowed, label);
}

/**
 * A dense array of at most `maximum` items, each checked as `<label>[<index>]`;
 * with `key`, an item whose key repeats an earlier one's is refused at once.
 */
function list<T>(maximum: number, check: (item: unknown, label: string) => void, key?: (item: T) => unknown): Check {
  return (value, label) => {
    const seen = new Set<unknown>();
    for (const [index, item] of array(value, label, maximum).entries()) {
      check(item, `${label}[${index}]`);
      if (key === undefined) continue;
      const id = key(item as T);
      if (seen.has(id)) throw new Error(`${label} must be unique`);
      seen.add(id);
    }
  };
}

function record(checks: Readonly<Record<string, Check>>): (value: unknown, label: string) => void {
  return (value, label) => {
    fields(value, label, checks);
  };
}

const PARTICIPANT: Readonly<Record<string, Check>> = {
  id: text,
  display_name: optionalText,
  identities: optional(list(100, record({ kind: among('source', 'email', 'phone', 'other'), value: text }),
    (identity: MeetingParticipantIdentity) => `${identity.kind}:${identity.value}`)),
  roles: optional(list(20, among('organizer', 'host', 'invitee', 'attendee', 'speaker', 'note_taker', 'bot'), (role: string) => role)),
  response_status: optional(among('accepted', 'declined', 'tentative', 'unknown')),
  attendance: optional(among('attended', 'no_show', 'unknown')),
  organization: optional(record({ name: optionalText, domain: optionalText })),
  is_external: optional(flag),
  metadata: json,
};

const CAPTURE: Readonly<Record<string, Check>> = {
  state: among('complete', 'partial', 'processing', 'unavailable', 'deleted'),
  components: list(100, record({
    kind: among('metadata', 'participants', 'agenda', 'summary', 'notes', 'transcript', 'chat', 'recording', 'attachments', 'artifacts', 'other'),
    state: among('available', 'empty', 'pending', 'not_provided', 'forbidden', 'failed'),
    reason: optionalText,
    metadata: json,
  })),
  warnings: optional(list(1_000, (warning, label) => nonEmptyString(warning, label))),
};

const TIMES = ['scheduled_start_at', 'scheduled_end_at', 'actual_start_at', 'actual_end_at'] as const;

/** The four times, then both orders, then the timezone and the all-day flag. */
function meetingTime(value: unknown, label: string): void {
  const time = object(value, label);
  onlyKeys(time, [...TIMES, 'timezone', 'all_day'], label);
  for (const key of TIMES) optionalTimestamp(time[key], `${label}.${key}`);
  for (const which of ['scheduled', 'actual'] as const) {
    const start = time[`${which}_start_at`];
    const end = time[`${which}_end_at`];
    if (typeof start === 'string' && typeof end === 'string' && start > end) throw new Error(`${label} ${which} end precedes its start`);
  }
  optionalNonEmptyString(time['timezone'], `${label}.timezone`);
  if (time['all_day'] !== undefined && typeof time['all_day'] !== 'boolean') throw new Error(`${label}.all_day must be a boolean`);
}

const NON_NEGATIVE_INTEGER: Check = (value, label) => {
  if (value !== undefined && (!Number.isSafeInteger(value) || (value as number) < 0)) {
    throw new Error(`${label} must be a non-negative integer`);
  }
};

/** A content block, against the meeting's participant ids and its running text total. */
function contentBlock(participants: ReadonlyMap<string, MeetingParticipant>, blockIds: Set<string>, total: { bytes: number }): Readonly<Record<string, Check>> {
  const block = (label: string) => label.slice(0, label.lastIndexOf('.'));
  return {
    id: (value, label) => {
      nonEmptyString(value, label);
      if (blockIds.has(value)) throw new Error('meeting content block ids must be unique');
      blockIds.add(value);
    },
    kind: among('summary', 'note', 'agenda', 'transcript', 'caption', 'chat_message', 'chapter', 'provider_action_item', 'provider_decision', 'artifact_text', 'other'),
    text: (value, label) => {
      nonEmptyString(value, label);
      const bytes = Buffer.byteLength(value, 'utf8');
      if (bytes > 4 * 1024 * 1024) throw new Error(`${label} exceeds the safety limit`);
      total.bytes += bytes;
      if (total.bytes > 16 * 1024 * 1024) throw new Error('meeting content text exceeds the aggregate safety limit');
    },
    speaker_participant_id: optional((value, label) => {
      nonEmptyString(value, label);
      if (!participants.has(value)) throw new Error(`${label} does not resolve`);
    }),
    started_at: optionalAt,
    ended_at: (value, label, content) => {
      optionalTimestamp(value, label);
      if (typeof content['started_at'] === 'string' && typeof value === 'string' && content['started_at'] > value) {
        throw new Error(`${block(label)} ends before it starts`);
      }
    },
    sequence: NON_NEGATIVE_INTEGER,
    start_offset_ms: NON_NEGATIVE_INTEGER,
    end_offset_ms: (value, label, content) => {
      NON_NEGATIVE_INTEGER(value, label, content);
      if (typeof content['start_offset_ms'] === 'number' && typeof value === 'number' && content['start_offset_ms'] > value) {
        throw new Error(`${block(label)} offset end precedes its start`);
      }
    },
    language: optionalText,
    confidence: (value, label) => {
      if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1)) {
        throw new Error(`${label} must be between 0 and 1`);
      }
    },
    origin: optional(among('human', 'source_ai', 'imported', 'unknown')),
    source_external_id: optionalText,
    metadata: json,
  };
}

function provenance(expectedSource: (AdapterIdentity & { kind: 'meeting-source' }) | undefined): Check {
  return (value, label) => {
    const result = fields(value, label, {
      source: record({
        kind: (kind, kindLabel) => {
          if (kind !== 'meeting-source') throw new Error(`${kindLabel} must be meeting-source`);
        },
        adapter_id: text,
        instance_id: text,
        version: text,
      }),
      external_id: text,
      canonical_revision: text,
      observed_at: (observed, observedLabel) => timestamp(observed, observedLabel),
      normalizer_version: text,
      source_revision: optionalText,
      source_created_at: optionalAt,
      source_updated_at: optionalAt,
      source_url: optionalText,
      metadata: json,
    });
    const source = result['source'] as Record<string, unknown>;
    if (
      expectedSource !== undefined &&
      (source['adapter_id'] !== expectedSource.adapter_id ||
        source['instance_id'] !== expectedSource.instance_id ||
        source['version'] !== expectedSource.version)
    ) {
      throw new Error('meeting provenance does not match the meeting-source adapter instance');
    }
  };
}

function context(participantsById: ReadonlyMap<string, MeetingParticipant>): Readonly<Record<string, Check>> {
  return {
    owner_participant_id: optional((value, label) => {
      nonEmptyString(value, label);
      const owner = participantsById.get(value);
      if (owner === undefined) throw new Error(`${label} does not resolve`);
      const ownerEmails = (owner.identities ?? []).filter(
        (identity) => identity.kind === 'email' && isCanonicalPersonEmail(identity.value),
      );
      if (ownerEmails.length !== 1) throw new Error(`${label} must resolve to one canonical email identity`);
    }),
    calendar: optional(record({
      event_id: optionalText,
      organizer_participant_id: optional((value, label) => {
        nonEmptyString(value, label);
        if (!participantsById.has(value)) throw new Error(`${label} does not resolve`);
      }),
    })),
    location: optional(record({ kind: optional(among('virtual', 'physical', 'hybrid')), name: optionalText, join_reference: optionalText })),
    scopes: optional(list(1_000, record({
      kind: among('domain', 'team', 'project', 'customer', 'topic'),
      value: text,
      origin: among('source', 'adapter_config'),
    }))),
    labels: optional(list(1_000, (label_, label) => nonEmptyString(label_, label))),
    language: optionalText,
    meeting_type: optionalText,
    metadata: json,
  };
}

const GOVERNANCE: Readonly<Record<string, Check>> = {
  sensitivity: optional(among('public', 'internal', 'confidential', 'restricted')),
  consent: optional(list(100, record({
    purpose: among('recording', 'transcription', 'analysis', 'distribution'),
    status: among('granted', 'denied', 'unknown', 'not_required'),
    recorded_at: optionalAt,
    source_reference: optionalText,
  }))),
  retention_until: optionalAt,
  redaction_state: optional(among('none', 'partial', 'full')),
  metadata: json,
};

export function assertCanonicalMeetingDocument(
  value: unknown,
  expectedSource?: AdapterIdentity & { kind: 'meeting-source' },
): asserts value is MeetingDocument {
  const participantsById = new Map<string, MeetingParticipant>();
  const blockIds = new Set<string>();
  const total = { bytes: 0 };
  fields(value, 'meeting', {
    schema_version: (version, label) => {
      if (version !== 1) throw new Error(`${label} must be 1`);
    },
    id: text,
    title: optionalText,
    description: optionalText,
    lifecycle: optional(among('scheduled', 'active', 'completed', 'cancelled', 'deleted', 'unknown')),
    time: optional(meetingTime),
    capture: record(CAPTURE),
    participants: list(10_000, (item, label) => {
      fields(item, label, PARTICIPANT);
      const participant = item as MeetingParticipant;
      if (participantsById.has(participant.id)) throw new Error('meeting participant ids must be unique');
      participantsById.set(participant.id, participant);
    }),
    // No source sends an artifact: every document carries the empty array.
    artifacts: (artifacts, label) => {
      if (array(artifacts, label, 10_000).length !== 0) throw new Error(`${label} must be empty`);
    },
    content: list(10_000, record(contentBlock(participantsById, blockIds, total))),
    provenance: provenance(expectedSource),
    context: optional(record(context(participantsById))),
    governance: optional(record(GOVERNANCE)),
    extensions: json,
  });
}

export function assertCanonicalMeetingBatch(
  value: unknown,
): asserts value is MeetingBatch {
  const batch = object(value, 'meeting_batch');
  onlyKeys(batch, ['meetings', 'next_cursor'], 'meeting_batch');
  if (!Array.isArray(batch['meetings'])) {
    throw new Error('meeting_batch.meetings must be an array');
  }
  if (batch['meetings'].length > 10_000) {
    throw new Error('meeting_batch.meetings exceeds the safety limit');
  }
  for (let index = 0; index < batch['meetings'].length; index += 1) {
    if (!(index in batch['meetings'])) {
      throw new Error('meeting_batch.meetings must be dense');
    }
    assertCanonicalMeetingDocument(batch['meetings'][index]);
  }
  if (batch['next_cursor'] !== undefined) {
    nonEmptyString(batch['next_cursor'], 'meeting_batch.next_cursor');
    if (batch['next_cursor'].length > 65_536) {
      throw new Error('meeting_batch.next_cursor exceeds the safety limit');
    }
  }
}

function assertSignalArray(
  value: unknown,
  label: string,
  meeting: MeetingDocument,
): ExtractedSignal[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const ids = new Set<string>();
  const blocks = new Map(meeting.content.map((block) => [block.id, block]));
  return value.map((item, index) => {
    const signal = object(item, `${label}[${index}]`);
    nonEmptyString(signal['id'], `${label}[${index}].id`);
    if (ids.has(signal['id'])) throw new Error('signal ids must be unique');
    ids.add(signal['id']);
    if (!['decision', 'action', 'rationale'].includes(String(signal['kind']))) {
      throw new Error(`${label}[${index}].kind is invalid`);
    }
    const capabilityKey =
      signal['kind'] === 'decision'
        ? 'status'
        : signal['kind'] === 'action'
          ? ['owner', 'due_at']
          : 'supports_signal_ids';
    onlyKeys(signal, ['id', 'kind', 'text', 'subject', 'confidence', 'evidence', ...(Array.isArray(capabilityKey) ? capabilityKey : [capabilityKey])], `${label}[${index}]`);
    nonEmptyString(signal['text'], `${label}[${index}].text`);
    if (!(signal['subject'] === null || typeof signal['subject'] === 'string')) {
      throw new Error(`${label}[${index}].subject must be a string or null`);
    }
    if (typeof signal['subject'] === 'string') {
      nonEmptyString(signal['subject'], `${label}[${index}].subject`);
    }
    if (
      !(
        signal['confidence'] === null ||
        (typeof signal['confidence'] === 'number' &&
          Number.isFinite(signal['confidence']) &&
          signal['confidence'] >= 0 &&
          signal['confidence'] <= 1)
      )
    ) {
      throw new Error(`${label}[${index}].confidence must be null or between 0 and 1`);
    }
    if (!Array.isArray(signal['evidence']) || signal['evidence'].length === 0) {
      throw new Error(`${label}[${index}].evidence must not be empty`);
    }
    for (const [evidenceIndex, evidenceValue] of signal['evidence'].entries()) {
      const evidence = object(
        evidenceValue,
        `${label}[${index}].evidence[${evidenceIndex}]`,
      );
      onlyKeys(evidence, ['meeting_id', 'block_id', 'quote', 'started_at', 'ended_at'], `${label}[${index}].evidence[${evidenceIndex}]`);
      if (evidence['meeting_id'] !== meeting.id) {
        throw new Error('signal evidence meeting_id does not match its meeting');
      }
      nonEmptyString(evidence['block_id'], 'signal evidence block_id');
      const block = blocks.get(evidence['block_id']);
      if (block === undefined) {
        throw new Error('signal evidence block_id does not resolve to the meeting');
      }
      if (evidence['quote'] !== undefined) {
        nonEmptyString(evidence['quote'], 'signal evidence quote');
        if (!block.text.includes(evidence['quote'])) {
          throw new Error('signal evidence quote does not resolve to the meeting block');
        }
      }
      optionalTimestamp(evidence['started_at'], 'evidence.started_at');
      optionalTimestamp(evidence['ended_at'], 'evidence.ended_at');
    }
    if (signal['kind'] === 'decision') {
      if (!['proposed', 'decided', 'unresolved'].includes(String(signal['status']))) {
        throw new Error(`${label}[${index}].status is invalid`);
      }
    } else if (signal['kind'] === 'action') {
      if (!(signal['owner'] === null || typeof signal['owner'] === 'string')) {
        throw new Error(`${label}[${index}].owner must be a string or null`);
      }
      if (typeof signal['owner'] === 'string') nonEmptyString(signal['owner'], `${label}[${index}].owner`);
      if (!(signal['due_at'] === null || isCanonicalTimestamp(signal['due_at']))) {
        throw new Error(`${label}[${index}].due_at must be null or canonical timestamp`);
      }
    } else if (
      !Array.isArray(signal['supports_signal_ids']) ||
      signal['supports_signal_ids'].some(
        (supported) => typeof supported !== 'string' || supported.trim() === '',
      )
    ) {
      throw new Error(`${label}[${index}].supports_signal_ids is invalid`);
    }
    return signal as unknown as ExtractedSignal;
  });
}

function assertRationaleLinks(signals: readonly ExtractedSignal[]): void {
  const ids = new Set(signals.map((signal) => signal.id));
  for (const signal of signals) {
    if (
      signal.kind === 'rationale' &&
      signal.supports_signal_ids.some(
        (supported) => supported === signal.id || !ids.has(supported),
      )
    ) {
      throw new Error('rationale links must reference another signal in the same artifact');
    }
  }
}

export function assertCanonicalDecisionSet(
  value: unknown,
  meeting: MeetingDocument,
  expectedProcessor: AdapterIdentity & { kind: 'decision-processor' },
): asserts value is DecisionSet {
  const anything: Check = () => {};
  fields(value, 'decision_set', {
    schema_version: (version, label) => {
      if (version !== 1) throw new Error(`${label} must be 1`);
    },
    meeting_id: (id, _label, decisions) => {
      if (id !== meeting.id || decisions['meeting_revision'] !== meeting.provenance.canonical_revision) {
        throw new Error('decision processor returned a result for a different meeting revision');
      }
    },
    meeting_revision: anything,
    processor: (value, label) => {
      const processor = fields(value, label, { kind: anything, adapter_id: anything, instance_id: anything, version: anything });
      if (
        processor['kind'] !== 'decision-processor' ||
        processor['adapter_id'] !== expectedProcessor.adapter_id ||
        processor['instance_id'] !== expectedProcessor.instance_id ||
        processor['version'] !== expectedProcessor.version
      ) {
        throw new Error('decision processor result identity does not match the configured adapter');
      }
    },
    generated_at: (generatedAt, label) => timestamp(generatedAt, label),
    signals: (signals, label) => assertRationaleLinks(assertSignalArray(signals, label, meeting)),
  });
}
