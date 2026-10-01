import { canonicalSourceContentV1 } from '@echo-brain/organization-processing/core';

export type ContextStructuredSourceTypeV1 =
  | 'document' | 'note' | 'message' | 'ticket' | 'meeting' | 'activity' | 'task' | 'decision';

export type ContextStructuredPayloadV1 =
  | { readonly schema_version: 1; readonly kind: 'document'; readonly media_type: string; readonly language?: string }
  | { readonly schema_version: 1; readonly kind: 'note'; readonly format: 'plain_text' | 'markdown' }
  | { readonly schema_version: 1; readonly kind: 'message'; readonly channel_ref: string; readonly sent_at: string; readonly thread_ref?: string; readonly author_ref?: string }
  | { readonly schema_version: 1; readonly kind: 'ticket'; readonly key: string; readonly status: string; readonly priority?: string; readonly assignee_ref?: string; readonly due_at?: string; readonly labels: readonly string[] }
  | { readonly schema_version: 1; readonly kind: 'meeting'; readonly started_at: string; readonly ended_at?: string; readonly participant_refs: readonly string[] }
  | { readonly schema_version: 1; readonly kind: 'activity'; readonly action: string; readonly occurred_at: string; readonly subject_ref: string; readonly actor_ref?: string }
  | { readonly schema_version: 1; readonly kind: 'task'; readonly status: string; readonly due_at?: string; readonly completed_at?: string; readonly assignee_ref?: string }
  | { readonly schema_version: 1; readonly kind: 'decision'; readonly status: string; readonly decided_at?: string; readonly decider_refs: readonly string[] };

export const CONTEXT_STRUCTURED_PAYLOAD_MAXIMUM_BYTES_V1 = 16 * 1024;
const MAXIMUM_REF_BYTES = 2048;
const MAXIMUM_FIELD_BYTES = 256;
const MAXIMUM_ARRAY_VALUES = 32;

function object(value: unknown, allowed: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error(`${label} must be a plain object`);
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some(key => !allowed.includes(key))) throw new Error(`${label} has an unknown field`);
  return result;
}

function text(value: unknown, maximum: number, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '' || Buffer.byteLength(value, 'utf8') > maximum || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(value)) throw new Error(`${label} must be bounded text`);
}

function timestamp(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error(`${label} must be canonical UTC`);
}

function optionalText(value: unknown, maximum: number, label: string): void {
  if (value !== undefined) text(value, maximum, label);
}

function optionalTimestamp(value: unknown, label: string): void {
  if (value !== undefined) timestamp(value, label);
}

function opaqueList(value: unknown, label: string, maximum = MAXIMUM_REF_BYTES): void {
  if (!Array.isArray(value) || value.length > MAXIMUM_ARRAY_VALUES) throw new Error(`${label} exceeds its bound`);
  const unique = new Set<string>();
  for (const entry of value) {
    text(entry, maximum, label);
    if (unique.has(entry)) throw new Error(`${label} must be unique`);
    unique.add(entry);
  }
}

function assertSourceType(value: unknown): asserts value is ContextStructuredSourceTypeV1 {
  if (typeof value !== 'string' || !['document', 'note', 'message', 'ticket', 'meeting', 'activity', 'task', 'decision'].includes(value)) throw new Error('Context structured payload source type is unsupported');
}

/**
 * Provider metadata only. Opaque refs remain source data and cannot establish
 * a directory identity, membership, permission grant, or durable body copy.
 */
export function assertContextStructuredPayloadV1(value: unknown, sourceType: ContextStructuredSourceTypeV1): asserts value is ContextStructuredPayloadV1 {
  assertSourceType(sourceType);
  const encoded = canonicalSourceContentV1(value);
  if (Buffer.byteLength(encoded, 'utf8') > CONTEXT_STRUCTURED_PAYLOAD_MAXIMUM_BYTES_V1) throw new Error('Context structured payload exceeds its bound');
  const payload = object(value, ['schema_version', 'kind', 'media_type', 'language', 'format', 'channel_ref', 'sent_at', 'thread_ref', 'author_ref', 'key', 'status', 'priority', 'assignee_ref', 'due_at', 'labels', 'started_at', 'ended_at', 'participant_refs', 'action', 'occurred_at', 'subject_ref', 'actor_ref', 'completed_at', 'decided_at', 'decider_refs'], 'Context structured payload');
  if (payload.schema_version !== 1 || payload.kind !== sourceType) throw new Error('Context structured payload kind does not match its source type');
  switch (sourceType) {
    case 'document': {
      object(value, ['schema_version', 'kind', 'media_type', 'language'], 'Context document payload');
      text(payload.media_type, MAXIMUM_FIELD_BYTES, 'Context document media type'); optionalText(payload.language, MAXIMUM_FIELD_BYTES, 'Context document language'); break;
    }
    case 'note': {
      object(value, ['schema_version', 'kind', 'format'], 'Context note payload');
      if (payload.format !== 'plain_text' && payload.format !== 'markdown') throw new Error('Context note format is unsupported'); break;
    }
    case 'message': {
      object(value, ['schema_version', 'kind', 'channel_ref', 'sent_at', 'thread_ref', 'author_ref'], 'Context message payload');
      text(payload.channel_ref, MAXIMUM_REF_BYTES, 'Context message channel'); timestamp(payload.sent_at, 'Context message sent time');
      optionalText(payload.thread_ref, MAXIMUM_REF_BYTES, 'Context message thread'); optionalText(payload.author_ref, MAXIMUM_REF_BYTES, 'Context message author'); break;
    }
    case 'ticket': {
      object(value, ['schema_version', 'kind', 'key', 'status', 'priority', 'assignee_ref', 'due_at', 'labels'], 'Context ticket payload');
      text(payload.key, MAXIMUM_FIELD_BYTES, 'Context ticket key'); text(payload.status, MAXIMUM_FIELD_BYTES, 'Context ticket status'); optionalText(payload.priority, MAXIMUM_FIELD_BYTES, 'Context ticket priority'); optionalText(payload.assignee_ref, MAXIMUM_REF_BYTES, 'Context ticket assignee'); optionalTimestamp(payload.due_at, 'Context ticket due time'); opaqueList(payload.labels, 'Context ticket labels', MAXIMUM_FIELD_BYTES); break;
    }
    case 'meeting': {
      object(value, ['schema_version', 'kind', 'started_at', 'ended_at', 'participant_refs'], 'Context meeting payload');
      timestamp(payload.started_at, 'Context meeting start time');
      const endedAt = payload.ended_at;
      if (endedAt !== undefined) {
        timestamp(endedAt, 'Context meeting end time');
        if (Date.parse(endedAt) < Date.parse(payload.started_at)) throw new Error('Context meeting ends before it starts');
      }
      opaqueList(payload.participant_refs, 'Context meeting participants'); break;
    }
    case 'activity': {
      object(value, ['schema_version', 'kind', 'action', 'occurred_at', 'subject_ref', 'actor_ref'], 'Context activity payload');
      text(payload.action, MAXIMUM_FIELD_BYTES, 'Context activity action'); timestamp(payload.occurred_at, 'Context activity occurrence'); text(payload.subject_ref, MAXIMUM_REF_BYTES, 'Context activity subject'); optionalText(payload.actor_ref, MAXIMUM_REF_BYTES, 'Context activity actor'); break;
    }
    case 'task': {
      object(value, ['schema_version', 'kind', 'status', 'due_at', 'completed_at', 'assignee_ref'], 'Context task payload');
      text(payload.status, MAXIMUM_FIELD_BYTES, 'Context task status'); optionalTimestamp(payload.due_at, 'Context task due time'); optionalTimestamp(payload.completed_at, 'Context task completion time'); optionalText(payload.assignee_ref, MAXIMUM_REF_BYTES, 'Context task assignee'); break;
    }
    case 'decision': {
      object(value, ['schema_version', 'kind', 'status', 'decided_at', 'decider_refs'], 'Context decision payload');
      text(payload.status, MAXIMUM_FIELD_BYTES, 'Context decision status'); optionalTimestamp(payload.decided_at, 'Context decision time'); opaqueList(payload.decider_refs, 'Context decision deciders'); break;
    }
  }
}
