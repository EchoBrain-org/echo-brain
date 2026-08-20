import type { ApprovalDecision } from '../approval/approval-gate.js';
import type { AdapterIdentity } from './adapter.js';
import type { DecisionSet, ExtractedSignal } from './decision.js';
import type { DecisionBrief, DeliveryEnvelope } from './delivery.js';
import type {
  MeetingBatch,
  MeetingDocument,
  MeetingParticipant,
} from './meeting.js';

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function structurallyEqualJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => structurallyEqualJson(value, right[index]))
    );
  }
  if (
    left === null ||
    right === null ||
    typeof left !== 'object' ||
    typeof right !== 'object'
  ) {
    return false;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] &&
        structurallyEqualJson(leftRecord[key], rightRecord[key]),
    )
  );
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

export function isCanonicalTimestamp(value: unknown): value is string {
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

function participant(value: unknown, label: string): asserts value is MeetingParticipant {
  const record = object(value, label);
  onlyKeys(
    record,
    [
      'id',
      'display_name',
      'identities',
      'roles',
      'response_status',
      'attendance',
      'organization',
      'is_external',
      'metadata',
    ],
    label,
  );
  nonEmptyString(record['id'], `${label}.id`);
  optionalNonEmptyString(record['display_name'], `${label}.display_name`);
  if (record['identities'] !== undefined) {
    const identities = array(record['identities'], `${label}.identities`, 100);
    const seen = new Set<string>();
    for (const [index, value] of identities.entries()) {
      const identity = object(value, `${label}.identities[${index}]`);
      onlyKeys(identity, ['kind', 'value'], `${label}.identities[${index}]`);
      oneOf(
        identity['kind'],
        ['source', 'email', 'phone', 'other'],
        `${label}.identities[${index}].kind`,
      );
      nonEmptyString(identity['value'], `${label}.identities[${index}].value`);
      const key = `${identity['kind']}:${identity['value']}`;
      if (seen.has(key)) throw new Error(`${label}.identities must be unique`);
      seen.add(key);
    }
  }
  if (record['roles'] !== undefined) {
    const roles = array(record['roles'], `${label}.roles`, 20);
    const seen = new Set<string>();
    for (const [index, role] of roles.entries()) {
      oneOf(
        role,
        ['organizer', 'host', 'invitee', 'attendee', 'speaker', 'note_taker', 'bot'],
        `${label}.roles[${index}]`,
      );
      if (seen.has(role)) throw new Error(`${label}.roles must be unique`);
      seen.add(role);
    }
  }
  if (record['response_status'] !== undefined) {
    oneOf(
      record['response_status'],
      ['accepted', 'declined', 'tentative', 'unknown'],
      `${label}.response_status`,
    );
  }
  if (record['attendance'] !== undefined) {
    oneOf(record['attendance'], ['attended', 'no_show', 'unknown'], `${label}.attendance`);
  }
  if (record['organization'] !== undefined) {
    const organization = object(record['organization'], `${label}.organization`);
    onlyKeys(organization, ['name', 'domain'], `${label}.organization`);
    optionalNonEmptyString(organization['name'], `${label}.organization.name`);
    optionalNonEmptyString(organization['domain'], `${label}.organization.domain`);
  }
  if (record['is_external'] !== undefined && typeof record['is_external'] !== 'boolean') {
    throw new Error(`${label}.is_external must be a boolean`);
  }
  metadata(record['metadata'], `${label}.metadata`);
}

function validateCapture(value: unknown): void {
  const capture = object(value, 'meeting.capture');
  onlyKeys(capture, ['state', 'components', 'warnings'], 'meeting.capture');
  oneOf(
    capture['state'],
    ['complete', 'partial', 'processing', 'unavailable', 'deleted'],
    'meeting.capture.state',
  );
  const components = array(capture['components'], 'meeting.capture.components', 100);
  for (const [index, value] of components.entries()) {
    const component = object(value, `meeting.capture.components[${index}]`);
    onlyKeys(
      component,
      ['kind', 'state', 'reason', 'metadata'],
      `meeting.capture.components[${index}]`,
    );
    oneOf(
      component['kind'],
      [
        'metadata',
        'participants',
        'agenda',
        'summary',
        'notes',
        'transcript',
        'chat',
        'recording',
        'attachments',
        'artifacts',
        'other',
      ],
      `meeting.capture.components[${index}].kind`,
    );
    oneOf(
      component['state'],
      ['available', 'empty', 'pending', 'not_provided', 'forbidden', 'failed'],
      `meeting.capture.components[${index}].state`,
    );
    optionalNonEmptyString(component['reason'], `meeting.capture.components[${index}].reason`);
    metadata(component['metadata'], `meeting.capture.components[${index}].metadata`);
  }
  if (capture['warnings'] !== undefined) {
    const warnings = array(capture['warnings'], 'meeting.capture.warnings', 1_000);
    warnings.forEach((warning, index) =>
      nonEmptyString(warning, `meeting.capture.warnings[${index}]`),
    );
  }
}

function validateMeetingTime(value: unknown): void {
  if (value === undefined) return;
  const time = object(value, 'meeting.time');
  onlyKeys(
    time,
    [
      'scheduled_start_at',
      'scheduled_end_at',
      'actual_start_at',
      'actual_end_at',
      'timezone',
      'all_day',
    ],
    'meeting.time',
  );
  for (const key of [
    'scheduled_start_at',
    'scheduled_end_at',
    'actual_start_at',
    'actual_end_at',
  ] as const) {
    optionalTimestamp(time[key], `meeting.time.${key}`);
  }
  if (
    typeof time['scheduled_start_at'] === 'string' &&
    typeof time['scheduled_end_at'] === 'string' &&
    time['scheduled_start_at'] > time['scheduled_end_at']
  ) {
    throw new Error('meeting.time scheduled end precedes its start');
  }
  if (
    typeof time['actual_start_at'] === 'string' &&
    typeof time['actual_end_at'] === 'string' &&
    time['actual_start_at'] > time['actual_end_at']
  ) {
    throw new Error('meeting.time actual end precedes its start');
  }
  optionalNonEmptyString(time['timezone'], 'meeting.time.timezone');
  if (time['all_day'] !== undefined && typeof time['all_day'] !== 'boolean') {
    throw new Error('meeting.time.all_day must be a boolean');
  }
}

export function assertCanonicalMeetingDocument(
  value: unknown,
  expectedSource?: AdapterIdentity & { kind: 'meeting-source' },
): asserts value is MeetingDocument {
  const meeting = object(value, 'meeting');
  onlyKeys(
    meeting,
    [
      'schema_version',
      'id',
      'provenance',
      'capture',
      'participants',
      'content',
      'artifacts',
      'title',
      'description',
      'lifecycle',
      'time',
      'context',
      'governance',
      'extensions',
    ],
    'meeting',
  );
  if (meeting['schema_version'] !== 1) throw new Error('meeting.schema_version must be 1');
  nonEmptyString(meeting['id'], 'meeting.id');
  optionalNonEmptyString(meeting['title'], 'meeting.title');
  optionalNonEmptyString(meeting['description'], 'meeting.description');
  if (meeting['lifecycle'] !== undefined) {
    oneOf(
      meeting['lifecycle'],
      ['scheduled', 'active', 'completed', 'cancelled', 'deleted', 'unknown'],
      'meeting.lifecycle',
    );
  }
  validateMeetingTime(meeting['time']);
  validateCapture(meeting['capture']);

  const participants = array(meeting['participants'], 'meeting.participants', 10_000);
  const participantIds = new Set<string>();
  for (const [index, value] of participants.entries()) {
    participant(value, `meeting.participants[${index}]`);
    if (participantIds.has(value.id)) throw new Error('meeting participant ids must be unique');
    participantIds.add(value.id);
  }

  const artifacts = array(meeting['artifacts'], 'meeting.artifacts', 10_000);
  const artifactIds = new Set<string>();
  for (const [index, value] of artifacts.entries()) {
    const artifact = object(value, `meeting.artifacts[${index}]`);
    onlyKeys(
      artifact,
      [
        'id',
        'kind',
        'availability',
        'title',
        'mime_type',
        'language',
        'external_id',
        'source_url',
        'content_hash',
        'metadata',
      ],
      `meeting.artifacts[${index}]`,
    );
    nonEmptyString(artifact['id'], `meeting.artifacts[${index}].id`);
    if (artifactIds.has(artifact['id'])) throw new Error('meeting artifact ids must be unique');
    artifactIds.add(artifact['id']);
    oneOf(
      artifact['kind'],
      [
        'audio',
        'video',
        'transcript',
        'document',
        'slides',
        'whiteboard',
        'chat',
        'image',
        'attachment',
        'link',
        'raw_payload',
        'other',
      ],
      `meeting.artifacts[${index}].kind`,
    );
    oneOf(
      artifact['availability'],
      ['available', 'pending', 'forbidden', 'missing', 'expired', 'redacted', 'unknown'],
      `meeting.artifacts[${index}].availability`,
    );
    for (const key of [
      'title',
      'mime_type',
      'language',
      'external_id',
      'source_url',
      'content_hash',
    ] as const) {
      optionalNonEmptyString(artifact[key], `meeting.artifacts[${index}].${key}`);
    }
    metadata(artifact['metadata'], `meeting.artifacts[${index}].metadata`);
  }

  const content = array(meeting['content'], 'meeting.content', 10_000);
  const blockIds = new Set<string>();
  let totalTextBytes = 0;
  for (const [index, item] of content.entries()) {
    const block = object(item, `meeting.content[${index}]`);
    onlyKeys(
      block,
      [
        'id',
        'kind',
        'text',
        'artifact_id',
        'author_participant_id',
        'speaker_participant_id',
        'sequence',
        'started_at',
        'ended_at',
        'start_offset_ms',
        'end_offset_ms',
        'language',
        'confidence',
        'origin',
        'source_external_id',
        'metadata',
      ],
      `meeting.content[${index}]`,
    );
    nonEmptyString(block['id'], `meeting.content[${index}].id`);
    if (blockIds.has(block['id'])) throw new Error('meeting content block ids must be unique');
    blockIds.add(block['id']);
    oneOf(
      block['kind'],
      [
        'summary',
        'note',
        'agenda',
        'transcript',
        'caption',
        'chat_message',
        'chapter',
        'provider_action_item',
        'provider_decision',
        'artifact_text',
        'other',
      ],
      `meeting.content[${index}].kind`,
    );
    nonEmptyString(block['text'], `meeting.content[${index}].text`);
    const textBytes = Buffer.byteLength(block['text'], 'utf8');
    if (textBytes > 4 * 1024 * 1024) {
      throw new Error(`meeting.content[${index}].text exceeds the safety limit`);
    }
    totalTextBytes += textBytes;
    if (totalTextBytes > 16 * 1024 * 1024) {
      throw new Error('meeting content text exceeds the aggregate safety limit');
    }
    for (const key of ['author_participant_id', 'speaker_participant_id'] as const) {
      if (block[key] !== undefined) {
        nonEmptyString(block[key], `meeting.content[${index}].${key}`);
        if (!participantIds.has(block[key])) {
          throw new Error(`meeting.content[${index}].${key} does not resolve`);
        }
      }
    }
    if (block['artifact_id'] !== undefined) {
      nonEmptyString(block['artifact_id'], `meeting.content[${index}].artifact_id`);
      if (!artifactIds.has(block['artifact_id'])) {
        throw new Error(`meeting.content[${index}].artifact_id does not resolve`);
      }
    }
    if (block['started_at'] !== undefined) {
      timestamp(block['started_at'], `meeting.content[${index}].started_at`);
    }
    if (block['ended_at'] !== undefined) {
      timestamp(block['ended_at'], `meeting.content[${index}].ended_at`);
    }
    if (
      typeof block['started_at'] === 'string' &&
      typeof block['ended_at'] === 'string' &&
      block['started_at'] > block['ended_at']
    ) {
      throw new Error(`meeting.content[${index}] ends before it starts`);
    }
    for (const key of ['sequence', 'start_offset_ms', 'end_offset_ms'] as const) {
      if (
        block[key] !== undefined &&
        (!Number.isSafeInteger(block[key]) || (block[key] as number) < 0)
      ) {
        throw new Error(`meeting.content[${index}].${key} must be a non-negative integer`);
      }
    }
    if (
      typeof block['start_offset_ms'] === 'number' &&
      typeof block['end_offset_ms'] === 'number' &&
      block['start_offset_ms'] > block['end_offset_ms']
    ) {
      throw new Error(`meeting.content[${index}] offset end precedes its start`);
    }
    optionalNonEmptyString(block['language'], `meeting.content[${index}].language`);
    if (
      block['confidence'] !== undefined &&
      (typeof block['confidence'] !== 'number' ||
        !Number.isFinite(block['confidence']) ||
        block['confidence'] < 0 ||
        block['confidence'] > 1)
    ) {
      throw new Error(`meeting.content[${index}].confidence must be between 0 and 1`);
    }
    if (block['origin'] !== undefined) {
      oneOf(
        block['origin'],
        ['human', 'source_ai', 'imported', 'unknown'],
        `meeting.content[${index}].origin`,
      );
    }
    optionalNonEmptyString(
      block['source_external_id'],
      `meeting.content[${index}].source_external_id`,
    );
    metadata(block['metadata'], `meeting.content[${index}].metadata`);
  }

  const provenance = object(meeting['provenance'], 'meeting.provenance');
  onlyKeys(
    provenance,
    [
      'source',
      'external_id',
      'canonical_revision',
      'observed_at',
      'normalizer_version',
      'source_revision',
      'previous_revision',
      'source_created_at',
      'source_updated_at',
      'source_url',
      'metadata',
    ],
    'meeting.provenance',
  );
  const source = object(provenance['source'], 'meeting.provenance.source');
  onlyKeys(source, ['kind', 'adapter_id', 'instance_id', 'version'], 'meeting.provenance.source');
  if (source['kind'] !== 'meeting-source') {
    throw new Error('meeting.provenance.source.kind must be meeting-source');
  }
  nonEmptyString(source['adapter_id'], 'meeting.provenance.source.adapter_id');
  nonEmptyString(source['instance_id'], 'meeting.provenance.source.instance_id');
  nonEmptyString(source['version'], 'meeting.provenance.source.version');
  nonEmptyString(provenance['external_id'], 'meeting.provenance.external_id');
  nonEmptyString(provenance['canonical_revision'], 'meeting.provenance.canonical_revision');
  timestamp(provenance['observed_at'], 'meeting.provenance.observed_at');
  nonEmptyString(provenance['normalizer_version'], 'meeting.provenance.normalizer_version');
  optionalNonEmptyString(provenance['source_revision'], 'meeting.provenance.source_revision');
  optionalNonEmptyString(provenance['previous_revision'], 'meeting.provenance.previous_revision');
  optionalTimestamp(provenance['source_created_at'], 'meeting.provenance.source_created_at');
  optionalTimestamp(provenance['source_updated_at'], 'meeting.provenance.source_updated_at');
  optionalNonEmptyString(provenance['source_url'], 'meeting.provenance.source_url');
  metadata(provenance['metadata'], 'meeting.provenance.metadata');
  if (
    expectedSource !== undefined &&
    (source['adapter_id'] !== expectedSource.adapter_id ||
      source['instance_id'] !== expectedSource.instance_id ||
      source['version'] !== expectedSource.version)
  ) {
    throw new Error('meeting provenance does not match the meeting-source adapter instance');
  }

  if (meeting['context'] !== undefined) {
    const context = object(meeting['context'], 'meeting.context');
    onlyKeys(
      context,
      ['calendar', 'location', 'scopes', 'labels', 'language', 'meeting_type', 'metadata'],
      'meeting.context',
    );
    if (context['calendar'] !== undefined) {
      const calendar = object(context['calendar'], 'meeting.context.calendar');
      onlyKeys(
        calendar,
        ['event_id', 'series_id', 'recurrence_id', 'organizer_participant_id'],
        'meeting.context.calendar',
      );
      for (const key of ['event_id', 'series_id', 'recurrence_id'] as const) {
        optionalNonEmptyString(calendar[key], `meeting.context.calendar.${key}`);
      }
      if (calendar['organizer_participant_id'] !== undefined) {
        nonEmptyString(
          calendar['organizer_participant_id'],
          'meeting.context.calendar.organizer_participant_id',
        );
        if (!participantIds.has(calendar['organizer_participant_id'])) {
          throw new Error('meeting.context.calendar.organizer_participant_id does not resolve');
        }
      }
    }
    if (context['location'] !== undefined) {
      const location = object(context['location'], 'meeting.context.location');
      onlyKeys(location, ['kind', 'name', 'join_reference'], 'meeting.context.location');
      if (location['kind'] !== undefined) {
        oneOf(location['kind'], ['virtual', 'physical', 'hybrid'], 'meeting.context.location.kind');
      }
      optionalNonEmptyString(location['name'], 'meeting.context.location.name');
      optionalNonEmptyString(location['join_reference'], 'meeting.context.location.join_reference');
    }
    if (context['scopes'] !== undefined) {
      const scopes = array(context['scopes'], 'meeting.context.scopes', 1_000);
      for (const [index, value] of scopes.entries()) {
        const scope = object(value, `meeting.context.scopes[${index}]`);
        onlyKeys(scope, ['kind', 'value', 'origin'], `meeting.context.scopes[${index}]`);
        oneOf(
          scope['kind'],
          ['domain', 'team', 'project', 'customer', 'topic'],
          `meeting.context.scopes[${index}].kind`,
        );
        nonEmptyString(scope['value'], `meeting.context.scopes[${index}].value`);
        oneOf(
          scope['origin'],
          ['source', 'adapter_config'],
          `meeting.context.scopes[${index}].origin`,
        );
      }
    }
    if (context['labels'] !== undefined) {
      const labels = array(context['labels'], 'meeting.context.labels', 1_000);
      labels.forEach((value, index) =>
        nonEmptyString(value, `meeting.context.labels[${index}]`),
      );
    }
    optionalNonEmptyString(context['language'], 'meeting.context.language');
    optionalNonEmptyString(context['meeting_type'], 'meeting.context.meeting_type');
    metadata(context['metadata'], 'meeting.context.metadata');
  }

  if (meeting['governance'] !== undefined) {
    const governance = object(meeting['governance'], 'meeting.governance');
    onlyKeys(
      governance,
      [
        'sensitivity',
        'consent',
        'retention_until',
        'deletion_requested_at',
        'redaction_state',
        'metadata',
      ],
      'meeting.governance',
    );
    if (governance['sensitivity'] !== undefined) {
      oneOf(
        governance['sensitivity'],
        ['public', 'internal', 'confidential', 'restricted'],
        'meeting.governance.sensitivity',
      );
    }
    if (governance['consent'] !== undefined) {
      const consent = array(governance['consent'], 'meeting.governance.consent', 100);
      for (const [index, value] of consent.entries()) {
        const record = object(value, `meeting.governance.consent[${index}]`);
        onlyKeys(
          record,
          ['purpose', 'status', 'recorded_at', 'source_reference'],
          `meeting.governance.consent[${index}]`,
        );
        oneOf(
          record['purpose'],
          ['recording', 'transcription', 'analysis', 'distribution'],
          `meeting.governance.consent[${index}].purpose`,
        );
        oneOf(
          record['status'],
          ['granted', 'denied', 'unknown', 'not_required'],
          `meeting.governance.consent[${index}].status`,
        );
        optionalTimestamp(record['recorded_at'], `meeting.governance.consent[${index}].recorded_at`);
        optionalNonEmptyString(
          record['source_reference'],
          `meeting.governance.consent[${index}].source_reference`,
        );
      }
    }
    optionalTimestamp(governance['retention_until'], 'meeting.governance.retention_until');
    optionalTimestamp(
      governance['deletion_requested_at'],
      'meeting.governance.deletion_requested_at',
    );
    if (governance['redaction_state'] !== undefined) {
      oneOf(
        governance['redaction_state'],
        ['none', 'partial', 'full'],
        'meeting.governance.redaction_state',
      );
    }
    metadata(governance['metadata'], 'meeting.governance.metadata');
  }
  metadata(meeting['extensions'], 'meeting.extensions');
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

interface SignalValidationContext {
  meetingId: string;
  meeting?: MeetingDocument;
  expectedKind?: ExtractedSignal['kind'];
}

function assertSignalArray(
  value: unknown,
  label: string,
  context: SignalValidationContext,
  ids: Set<string>,
): ExtractedSignal[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const blocks =
    context.meeting === undefined
      ? undefined
      : new Map(context.meeting.content.map((block) => [block.id, block]));
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
    onlyKeys(
      signal,
      [
        'id',
        'kind',
        'text',
        'subject',
        'confidence',
        'evidence',
        ...(Array.isArray(capabilityKey) ? capabilityKey : [capabilityKey]),
      ],
      `${label}[${index}]`,
    );
    if (context.expectedKind !== undefined && signal['kind'] !== context.expectedKind) {
      throw new Error(`${label}[${index}] is in the wrong signal collection`);
    }
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
      onlyKeys(
        evidence,
        ['meeting_id', 'block_id', 'quote', 'started_at', 'ended_at'],
        `${label}[${index}].evidence[${evidenceIndex}]`,
      );
      if (evidence['meeting_id'] !== context.meetingId) {
        throw new Error('signal evidence meeting_id does not match its meeting');
      }
      nonEmptyString(evidence['block_id'], 'signal evidence block_id');
      const block = blocks?.get(evidence['block_id']);
      if (blocks !== undefined && block === undefined) {
        throw new Error('signal evidence block_id does not resolve to the meeting');
      }
      if (evidence['quote'] !== undefined) {
        nonEmptyString(evidence['quote'], 'signal evidence quote');
        if (block !== undefined && !block.text.includes(evidence['quote'])) {
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
  const decisions = object(value, 'decision_set');
  onlyKeys(
    decisions,
    [
      'schema_version',
      'meeting_id',
      'meeting_revision',
      'processor',
      'generated_at',
      'signals',
    ],
    'decision_set',
  );
  if (decisions['schema_version'] !== 1) throw new Error('decision_set.schema_version must be 1');
  if (
    decisions['meeting_id'] !== meeting.id ||
    decisions['meeting_revision'] !== meeting.provenance.canonical_revision
  ) {
    throw new Error('decision processor returned a result for a different meeting revision');
  }
  const processor = object(decisions['processor'], 'decision_set.processor');
  onlyKeys(
    processor,
    ['kind', 'adapter_id', 'instance_id', 'version'],
    'decision_set.processor',
  );
  if (
    processor['kind'] !== 'decision-processor' ||
    processor['adapter_id'] !== expectedProcessor.adapter_id ||
    processor['instance_id'] !== expectedProcessor.instance_id ||
    processor['version'] !== expectedProcessor.version
  ) {
    throw new Error('decision processor result identity does not match the configured adapter');
  }
  timestamp(decisions['generated_at'], 'decision_set.generated_at');
  const ids = new Set<string>();
  const signals = assertSignalArray(decisions['signals'], 'decision_set.signals', {
    meetingId: meeting.id,
    meeting,
  }, ids);
  assertRationaleLinks(signals);
}

export interface DecisionBriefValidationContext {
  meeting?: MeetingDocument;
  processor?: AdapterIdentity & { kind: 'decision-processor' };
  decisions?: DecisionSet;
}

export function assertCanonicalDecisionBrief(
  value: unknown,
  context: DecisionBriefValidationContext = {},
): asserts value is DecisionBrief {
  const brief = object(value, 'decision_brief');
  onlyKeys(
    brief,
    [
      'schema_version',
      'id',
      'meeting',
      'decisions',
      'actions',
      'rationales',
      'provenance',
    ],
    'decision_brief',
  );
  if (brief['schema_version'] !== 1) throw new Error('decision_brief.schema_version must be 1');
  nonEmptyString(brief['id'], 'decision_brief.id');
  const meeting = object(brief['meeting'], 'decision_brief.meeting');
  onlyKeys(
    meeting,
    ['id', 'title', 'time', 'participants'],
    'decision_brief.meeting',
  );
  nonEmptyString(meeting['id'], 'decision_brief.meeting.id');
  optionalNonEmptyString(meeting['title'], 'decision_brief.meeting.title');
  if (meeting['time'] !== undefined) {
    validateMeetingTime({ ...object(meeting['time'], 'decision_brief.meeting.time') });
  }
  const briefParticipants = array(
    meeting['participants'],
    'decision_brief.meeting.participants',
    10_000,
  );
  briefParticipants.forEach((item, index) =>
    participant(item, `decision_brief.meeting.participants[${index}]`),
  );
  if (
    context.meeting !== undefined &&
    (meeting['id'] !== context.meeting.id ||
      meeting['title'] !== context.meeting.title ||
      !structurallyEqualJson(meeting['time'], context.meeting.time) ||
      !structurallyEqualJson(
        meeting['participants'],
        context.meeting.participants,
      ))
  ) {
    throw new Error('approved brief meeting snapshot does not match its source meeting');
  }
  const provenance = object(brief['provenance'], 'decision_brief.provenance');
  onlyKeys(
    provenance,
    ['meeting_revision', 'processor', 'generated_at'],
    'decision_brief.provenance',
  );
  nonEmptyString(provenance['meeting_revision'], 'decision_brief.provenance.meeting_revision');
  timestamp(provenance['generated_at'], 'decision_brief.provenance.generated_at');
  const processor = object(provenance['processor'], 'decision_brief.provenance.processor');
  onlyKeys(
    processor,
    ['kind', 'adapter_id', 'instance_id', 'version'],
    'decision_brief.provenance.processor',
  );
  nonEmptyString(processor['adapter_id'], 'decision_brief.provenance.processor.adapter_id');
  nonEmptyString(processor['instance_id'], 'decision_brief.provenance.processor.instance_id');
  nonEmptyString(processor['version'], 'decision_brief.provenance.processor.version');
  if (processor['kind'] !== 'decision-processor') {
    throw new Error('decision_brief.provenance.processor is invalid');
  }
  if (
    context.meeting !== undefined &&
    provenance['meeting_revision'] !== context.meeting.provenance.canonical_revision
  ) {
    throw new Error('approved brief revision does not match its source meeting');
  }
  if (
    context.processor !== undefined &&
    (processor['adapter_id'] !== context.processor.adapter_id ||
      processor['instance_id'] !== context.processor.instance_id ||
      processor['version'] !== context.processor.version)
  ) {
    throw new Error('approved brief processor does not match the configured adapter');
  }
  if (
    context.decisions !== undefined &&
    provenance['generated_at'] !== context.decisions.generated_at
  ) {
    throw new Error('approved brief provenance does not match its decision set');
  }
  const ids = new Set<string>();
  const signalContext = {
    meetingId: meeting['id'],
    ...(context.meeting === undefined ? {} : { meeting: context.meeting }),
  };
  const signals = [
    ...assertSignalArray(brief['decisions'], 'decision_brief.decisions', {
      ...signalContext,
      expectedKind: 'decision',
    }, ids),
    ...assertSignalArray(brief['actions'], 'decision_brief.actions', {
      ...signalContext,
      expectedKind: 'action',
    }, ids),
    ...assertSignalArray(brief['rationales'], 'decision_brief.rationales', {
      ...signalContext,
      expectedKind: 'rationale',
    }, ids),
  ];
  assertRationaleLinks(signals);
}

export function assertCanonicalApprovalDecision(
  value: unknown,
  briefContext: DecisionBriefValidationContext = {},
): asserts value is ApprovalDecision {
  const approval = object(value, 'approval');
  onlyKeys(
    approval,
    [
      'status',
      'reviewed_at',
      'reviewed_by',
      'reason',
      'approved_brief',
    ],
    'approval',
  );
  if (!['pending', 'approved', 'rejected'].includes(String(approval['status']))) {
    throw new Error('approval.status is invalid');
  }
  if (approval['status'] === 'pending') {
    if (
      approval['reviewed_at'] !== null ||
      approval['reviewed_by'] !== null ||
      approval['reason'] !== null ||
      approval['approved_brief'] !== null
    ) {
      throw new Error('pending approval contains resolved fields');
    }
    return;
  }
  timestamp(approval['reviewed_at'], 'approval.reviewed_at');
  nonEmptyString(approval['reviewed_by'], 'approval.reviewed_by');
  if (!(approval['reason'] === null || typeof approval['reason'] === 'string')) {
    throw new Error('approval.reason must be a string or null');
  }
  if (approval['status'] === 'approved') {
    assertCanonicalDecisionBrief(approval['approved_brief'], briefContext);
  } else if (approval['approved_brief'] !== null) {
    throw new Error('rejected approval cannot contain an approved brief');
  }
}

export function assertCanonicalDeliveryEnvelope(
  value: unknown,
): asserts value is DeliveryEnvelope {
  const envelope = object(value, 'delivery_envelope');
  onlyKeys(
    envelope,
    [
      'schema_version',
      'id',
      'idempotency_key',
      'destination',
      'brief',
      'approved_at',
    ],
    'delivery_envelope',
  );
  if (envelope['schema_version'] !== 1) throw new Error('delivery_envelope.schema_version must be 1');
  nonEmptyString(envelope['id'], 'delivery_envelope.id');
  nonEmptyString(envelope['idempotency_key'], 'delivery_envelope.idempotency_key');
  timestamp(envelope['approved_at'], 'delivery_envelope.approved_at');
  const destination = object(envelope['destination'], 'delivery_envelope.destination');
  onlyKeys(
    destination,
    ['adapter_id', 'instance_id', 'external_id', 'metadata'],
    'delivery_envelope.destination',
  );
  nonEmptyString(destination['adapter_id'], 'delivery_envelope.destination.adapter_id');
  nonEmptyString(destination['instance_id'], 'delivery_envelope.destination.instance_id');
  nonEmptyString(destination['external_id'], 'delivery_envelope.destination.external_id');
  metadata(destination['metadata'], 'delivery_envelope.destination.metadata');
  assertCanonicalDecisionBrief(envelope['brief']);
}
