import {
  assertContextRepresentationV1, assertContextStructuredPayloadV1, assertPlainContextObjectV1, CONTEXT_CAPTURE_LIMITS_V1,
  type ContextCaptureContentV1, type ContextPassageV1, type ContextRepresentationV1,
} from './context-capture-v1.js';
import { parseCaptureSourceRefV1 } from './capture-source-ref-v1.js';
import type { SourceAdapterIdentityV1, SourceArtifactReferenceV1, SourceEnvelopeV1 } from './source.js';
import { assertSourceEnvelopeV1, canonicalSourceContentV1, sourceContentSha256V1, sourceItemIdV1 } from '../processing/source-admission.js';
import { isCanonicalTimestamp } from './validation.js';

/** Offsets are relative to the retained passage, not a model-generated location. */
export interface ContextEvidenceSpanV1 {
  readonly passage_id: string;
  readonly start: number;
  readonly end: number;
  readonly quote: string;
}
/** A closed pointer to exact retained typed payload metadata, never an arbitrary JSON path. */
export const CONTEXT_PAYLOAD_FIELDS_V1 = [
  'message.author_ref', 'message.channel_ref', 'message.thread_ref', 'message.sent_at',
  'ticket.key', 'ticket.status', 'ticket.priority', 'ticket.assignee_ref', 'ticket.due_at',
  'meeting.started_at', 'meeting.ended_at', 'note.format', 'document.media_type', 'document.filename', 'document.path',
] as const;
export type ContextPayloadFieldV1 = typeof CONTEXT_PAYLOAD_FIELDS_V1[number];
export type ContextEvidenceAnchorV1 = ContextEvidenceSpanV1 | {
  readonly kind: 'payload_field';
  readonly field: ContextPayloadFieldV1;
};
export type ContextActorObservationV1 = { readonly source_actor_ref: string } & (
  | { readonly role: 'mentioned'; readonly evidence: ContextEvidenceSpanV1 }
  | { readonly role: 'author' | 'speaker' | 'reporter' | 'creator' | 'participant' | 'assignee';
      /** Observed provider metadata, not a quotation or verified Person identity. */
      readonly attribution: { readonly source_anchor: string; readonly passage_ids: readonly string[] } }
);
export interface ContextActionObservationV1 {
  readonly id: string;
  /** Literal source observations. A proposal is never an approved ECHO action. */
  readonly kind: 'proposed' | 'assigned' | 'status_changed' | 'status_observed' | 'completed';
  readonly evidence: ContextEvidenceAnchorV1;
  readonly source_actor_ref?: string;
}
export type ContextStructuredPayloadV2 = ContextCaptureContentV1['payload'] | {
  readonly schema_version: 2; readonly kind: 'document'; readonly media_type: string;
  readonly filename?: string; readonly path?: string;
  /** Descriptor of an already-custodied original; never inline bytes or a new access grant. */
  readonly original_artifact?: SourceArtifactReferenceV1;
};
type CaptureBaseV2 = Pick<ContextCaptureContentV1, 'label'> & {
  readonly provenance: ContextCaptureContentV1['provenance'] & {
    readonly container_ref: string;
    /** Opaque upstream version/ETag, separate from ECHO revision identity; never sorted generically. */
    readonly upstream_version?: string;
  };
  readonly schema_version: 2;
  readonly kind: 'echo-context-capture-v2';
};
export type ContextCaptureContentV2 = CaptureBaseV2 & (
  | { readonly lifecycle: 'present'; readonly payload: ContextStructuredPayloadV2;
      readonly representation: ContextCaptureContentV1['representation'];
      readonly actors: readonly ContextActorObservationV1[]; readonly actions: readonly ContextActionObservationV1[] }
  | { readonly lifecycle: 'deleted'; readonly deletion: 'explicit_upstream_tombstone' }
);
export type ContextCaptureEnvelopeV2 = SourceEnvelopeV1<ContextCaptureContentV2>;

export function assertCaptureTextV1(value: unknown, label: string, maximum = 512): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > maximum || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(value)) throw new Error(`${label} must be bounded text`);
}
export function assertCaptureHashV1(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error('Capture digest is invalid');
}
export function assertContextEvidenceSpanV1(value: unknown, passages: readonly ContextPassageV1[]): asserts value is ContextEvidenceSpanV1 {
  assertPlainContextObjectV1(value, ['passage_id', 'start', 'end', 'quote'], 'Context evidence');
  const span = value as ContextEvidenceSpanV1;
  const passage = passages.find(candidate => candidate.id === span.passage_id);
  if (!passage || !Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end) || span.start < 0 || span.end <= span.start ||
      span.end > passage.text.length || typeof span.quote !== 'string' || !span.quote.trim() || passage.text.slice(span.start, span.end) !== span.quote) throw new Error('Context evidence must match a retained passage');
}
function payloadFieldValue(content: Extract<ContextCaptureContentV2, { lifecycle: 'present' }>, field: ContextPayloadFieldV1): unknown {
  const payload = content.payload;
  switch (field) {
    case 'message.author_ref': return payload.kind === 'message' ? payload.author_ref : undefined;
    case 'message.channel_ref': return payload.kind === 'message' ? payload.channel_ref : undefined;
    case 'message.thread_ref': return payload.kind === 'message' ? payload.thread_ref : undefined;
    case 'message.sent_at': return payload.kind === 'message' ? payload.sent_at : undefined;
    case 'ticket.key': return payload.kind === 'ticket' ? payload.key : undefined;
    case 'ticket.status': return payload.kind === 'ticket' ? payload.status : undefined;
    case 'ticket.priority': return payload.kind === 'ticket' ? payload.priority : undefined;
    case 'ticket.assignee_ref': return payload.kind === 'ticket' ? payload.assignee_ref : undefined;
    case 'ticket.due_at': return payload.kind === 'ticket' ? payload.due_at : undefined;
    case 'meeting.started_at': return payload.kind === 'meeting' ? payload.started_at : undefined;
    case 'meeting.ended_at': return payload.kind === 'meeting' ? payload.ended_at : undefined;
    case 'note.format': return payload.kind === 'note' ? payload.format : undefined;
    case 'document.media_type': return payload.kind === 'document' ? payload.media_type : undefined;
    case 'document.filename': return payload.kind === 'document' ? payload.filename : undefined;
    case 'document.path': return payload.kind === 'document' ? payload.path : undefined;
  }
}
export function assertContextPayloadFieldV1(value: unknown, content: ContextCaptureContentV2): asserts value is ContextPayloadFieldV1 {
  if (content.lifecycle !== 'present' || typeof value !== 'string' || !(CONTEXT_PAYLOAD_FIELDS_V1 as readonly string[]).includes(value) ||
      payloadFieldValue(content, value as ContextPayloadFieldV1) === undefined) throw new Error('Context payload evidence field is invalid for this capture');
}
export function assertContextEvidenceAnchorV1(value: unknown, content: ContextCaptureContentV2): asserts value is ContextEvidenceAnchorV1 {
  assertPlainContextObjectV1(value, ['kind', 'field', 'passage_id', 'start', 'end', 'quote'], 'Context evidence anchor');
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && (value as { kind?: unknown }).kind === 'payload_field') {
    assertPlainContextObjectV1(value, ['kind', 'field'], 'Context payload evidence');
    assertContextPayloadFieldV1((value as { field?: unknown }).field, content);
    return;
  }
  const passages = content.lifecycle === 'present' && content.representation.kind !== 'pointer' ? content.representation.passages : [];
  assertContextEvidenceSpanV1(value, passages);
}
/** Opaque source identities, including structured metadata. These confer no Person identity. */
export function contextSourceActorRefsV2(content: ContextCaptureContentV2): readonly string[] {
  if (content.lifecycle === 'deleted') return [];
  const payload = content.payload;
  const metadata = payload.kind === 'message' ? [payload.author_ref] : payload.kind === 'ticket' ? [payload.assignee_ref] : payload.kind === 'meeting' ? payload.participant_refs : [];
  return [...new Set([...metadata.filter((ref): ref is string => ref !== undefined), ...content.actors.map(actor => actor.source_actor_ref)])].sort();
}
function revisionId(content: ContextCaptureContentV2, previous_revision_id?: string): string {
  return `context:${sourceContentSha256V1({ content, ...(previous_revision_id === undefined ? {} : { previous_revision_id }) })}`;
}
export function buildContextCaptureEnvelopeV2(input: {
  readonly identity: SourceAdapterIdentityV1; readonly external_id: string; readonly captured_at: string;
  readonly content: ContextCaptureContentV2;
  /** Exact previously admitted envelope selected by Authority, never inferred from a poll timestamp. */
  readonly previous?: ContextCaptureEnvelopeV2;
}): ContextCaptureEnvelopeV2 {
  assertPlainContextObjectV1(input, ['identity', 'external_id', 'captured_at', 'content', 'previous'], 'Context capture input');
  const sourceId = sourceItemIdV1(input.identity, input.external_id);
  let predecessor: string | undefined;
  if (input.previous !== undefined) {
    assertContextCaptureEnvelopeV2(input.previous, input.previous.item.adapter);
    if (input.previous.item.source_id !== sourceId) throw new Error('Capture predecessor belongs to a different source');
    // An unchanged poll preserves the original predecessor, not the current revision as a new predecessor.
    predecessor = sourceContentSha256V1(input.content) === input.previous.revision.content_sha256
      ? input.previous.revision.previous_revision_id : input.previous.revision.revision_id;
  }
  const source: ContextCaptureEnvelopeV2 = {
    item: { schema_version: 1, source_id: sourceId, adapter: input.identity, external_id: input.external_id },
    revision: { schema_version: 1, source_id: sourceId, revision_id: revisionId(input.content, predecessor),
      captured_at: input.captured_at, content_sha256: sourceContentSha256V1(input.content), artifact_refs: originalArtifacts(input.content), representation_refs: [],
      ...(predecessor === undefined ? {} : { previous_revision_id: predecessor }) },
    content: input.content,
  };
  assertContextCaptureEnvelopeV2(source, input.identity);
  return JSON.parse(canonicalSourceContentV1(source)) as ContextCaptureEnvelopeV2;
}
function originalArtifacts(content: ContextCaptureContentV2): readonly SourceArtifactReferenceV1[] {
  return content.lifecycle === 'present' && content.payload.kind === 'document' && content.payload.original_artifact !== undefined
    ? [content.payload.original_artifact] : [];
}
function assertScopedRef(value: unknown, container: ReturnType<typeof parseCaptureSourceRefV1>, kinds: readonly string[], sourceId: string): void {
  const ref = parseCaptureSourceRefV1(value);
  // A stable source actor may be federated into this container by the same tool.
  // Local actors and all other source references remain container-tenant local.
  const federatedActor = ref.kind === 'actor' && kinds.includes('actor');
  if (ref.tool !== container.tool || (!federatedActor && ref.tenant !== container.tenant) || !kinds.includes(ref.kind) ||
      (ref.kind === 'local-actor' && (!/^[a-f0-9]{64}\.[a-f0-9]{64}$/.test(ref.id) || ref.id.slice(0, 64) !== sourceId.slice(7)))) throw new Error('Capture reference differs from its source namespace, item or kind');
}
export function assertContextCaptureEnvelopeV2(value: unknown, identity: SourceAdapterIdentityV1): asserts value is ContextCaptureEnvelopeV2 {
  assertPlainContextObjectV1(value, ['item', 'revision', 'content'], 'Context envelope');
  if (Buffer.byteLength(canonicalSourceContentV1(value)) > CONTEXT_CAPTURE_LIMITS_V1.envelope_bytes) throw new Error('Context envelope exceeds its bound');
  assertSourceEnvelopeV1(value, identity);
  assertPlainContextObjectV1(value.content, ['schema_version', 'kind', 'label', 'provenance', 'lifecycle', 'payload', 'representation', 'actors', 'actions', 'deletion'], 'Context capture');
  const content = value.content as ContextCaptureContentV2;
  if (content.schema_version !== 2 || content.kind !== 'echo-context-capture-v2' || !['present', 'deleted'].includes(content.lifecycle)) throw new Error('Context V2 contract is unsupported');
  if (value.revision.revision_id !== revisionId(content, value.revision.previous_revision_id)) throw new Error('Context revision is not canonical');
  if (value.item.adapter.kind !== 'source' || value.item.source_id !== sourceItemIdV1(identity, value.item.external_id) ||
      value.revision.contributor !== undefined || value.revision.representation_refs.length !== 0 || !isCanonicalTimestamp(value.revision.captured_at)) throw new Error('Context V2 source envelope is invalid');
  assertPlainContextObjectV1(content.provenance, ['origin_ref', 'source_updated_at', 'container_ref', 'upstream_version'], 'Capture provenance');
  assertCaptureTextV1(content.label, 'Context label', 200); assertCaptureTextV1(content.provenance.origin_ref, 'Context origin', 2048);
  if (content.provenance.source_updated_at !== undefined && !isCanonicalTimestamp(content.provenance.source_updated_at)) throw new Error('Context source timestamp is invalid');
  const container = parseCaptureSourceRefV1(content.provenance.container_ref);
  if (container.kind !== 'container') throw new Error('Capture requires a container reference');
  if (content.provenance.upstream_version !== undefined) assertCaptureTextV1(content.provenance.upstream_version, 'Upstream version', 256);
  if (canonicalSourceContentV1(value.revision.artifact_refs) !== canonicalSourceContentV1(originalArtifacts(content))) throw new Error('Capture artifact descriptor differs from its envelope');
  const document = content.lifecycle === 'present' && content.payload.kind === 'document' ? content.payload : undefined;
  if (document !== undefined) {
    assertPlainContextObjectV1(document, ['schema_version', 'kind', 'media_type', 'filename', 'path', 'original_artifact'], 'Document payload');
    assertCaptureTextV1(document.media_type, 'Document media type', 256);
    if (document.schema_version !== 2 || !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(document.media_type)) throw new Error('Document media type or version is invalid');
    if (document.filename !== undefined) assertCaptureTextV1(document.filename, 'Document filename', 512);
    if (document.path !== undefined) assertCaptureTextV1(document.path, 'Document source path', 2048);
    if (document.original_artifact !== undefined) {
      assertCaptureTextV1(document.original_artifact.artifact_id, 'Document artifact ID', 2048);
      if (document.original_artifact.media_type !== document.media_type) throw new Error('Document artifact media type differs');
    }
  } else if (content.lifecycle === 'present') {
    assertContextStructuredPayloadV1(content.payload);
  }
  if (content.lifecycle === 'deleted') {
    assertPlainContextObjectV1(content, ['schema_version', 'kind', 'label', 'provenance', 'lifecycle', 'deletion'], 'Context tombstone');
    if (content.deletion !== 'explicit_upstream_tombstone' || value.revision.previous_revision_id === undefined || content.provenance.source_updated_at === undefined) throw new Error('Context deletion requires an explicit predecessor and source time');
    return;
  }
  assertPlainContextObjectV1(content, ['schema_version', 'kind', 'label', 'provenance', 'lifecycle', 'payload', 'representation', 'actors', 'actions'], 'Present context');
  if (typeof content.representation.kind !== 'string' || !['pointer', 'excerpt', 'full_snapshot'].includes(content.representation.kind)) throw new Error('Context representation is unsupported');
  assertContextRepresentationV1(content.representation as ContextRepresentationV1);
  const passages = content.representation.kind === 'pointer' ? [] : content.representation.passages;
  if (!Array.isArray(content.actors) || content.actors.length > 32 || !Array.isArray(content.actions) || content.actions.length > 32) throw new Error('Context observations exceed their bound');
  const actors = new Set<string>();
  for (const actor of content.actors) {
    assertPlainContextObjectV1(actor, ['source_actor_ref', 'role', 'evidence', 'attribution'], 'Context actor');
    assertCaptureTextV1(actor.source_actor_ref, 'Source actor', 2048);
    if (!['mentioned', 'author', 'speaker', 'reporter', 'creator', 'participant', 'assignee'].includes(actor.role)) throw new Error('Context actor role is invalid');
    const key = canonicalSourceContentV1([actor.source_actor_ref, actor.role]);
    if (actors.has(key)) throw new Error('Context actor identities must be unique per role');
    if (actor.role === 'mentioned') {
      assertPlainContextObjectV1(actor, ['source_actor_ref', 'role', 'evidence'], 'Mentioned actor');
      assertContextEvidenceSpanV1(actor.evidence, passages);
    } else {
      assertPlainContextObjectV1(actor, ['source_actor_ref', 'role', 'attribution'], 'Attributed actor');
      assertPlainContextObjectV1(actor.attribution, ['source_anchor', 'passage_ids'], 'Actor attribution');
      assertCaptureTextV1(actor.attribution.source_anchor, 'Actor metadata anchor');
      const ids = actor.attribution.passage_ids;
      if (!Array.isArray(ids) || ids.length > 32 || (actor.role === 'speaker' && ids.length === 0) || new Set(ids).size !== ids.length ||
          ids.some(id => !passages.some(passage => passage.id === id))) throw new Error('Actor attribution must reference retained passages');
    }
    actors.add(key);
  }
  const sourceActors = contextSourceActorRefsV2(content);
  for (const actor of sourceActors) assertScopedRef(actor, container, ['actor', 'local-actor'], value.item.source_id);
  if (content.payload.kind === 'message') {
    if (content.payload.channel_ref !== content.provenance.container_ref) throw new Error('Message channel differs from its capture container');
    if (content.payload.thread_ref !== undefined) assertScopedRef(content.payload.thread_ref, container, ['message'], value.item.source_id);
  }
  const actions = new Set<string>();
  for (const action of content.actions) {
    assertPlainContextObjectV1(action, ['id', 'kind', 'evidence', 'source_actor_ref'], 'Context action');
    assertCaptureTextV1(action.id, 'Source action', 128);
    if (!['proposed', 'assigned', 'status_changed', 'status_observed', 'completed'].includes(action.kind) || actions.has(action.id)) throw new Error('Context action kind or identity is invalid');
    assertContextEvidenceAnchorV1(action.evidence, content);
    if (action.kind === 'status_observed') {
      if (!('kind' in action.evidence) || action.evidence.kind !== 'payload_field' || action.evidence.field !== 'ticket.status') throw new Error('Observed status requires ticket status metadata');
    } else if ('kind' in action.evidence) throw new Error('Only observed status may use payload metadata');
    if (action.source_actor_ref !== undefined && !sourceActors.includes(action.source_actor_ref)) throw new Error('Context action has an unknown actor');
    actions.add(action.id);
  }
}
