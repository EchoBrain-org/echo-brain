import {
  assertContextCaptureEnvelopeV1, assertPlainContextObjectV1, CONTEXT_CAPTURE_LIMITS_V1,
  type ContextCaptureContentV1, type ContextPassageV1,
} from './context-capture-v1.js';
import type { SourceAdapterIdentityV1, SourceEnvelopeV1 } from './source.js';
import { assertSourceEnvelopeV1, canonicalSourceContentV1, sourceContentSha256V1, sourceItemIdV1 } from '../processing/source-admission.js';

/** Offsets are relative to the retained passage, not a model-generated location. */
export interface ContextEvidenceSpanV1 {
  readonly passage_id: string;
  readonly start: number;
  readonly end: number;
  readonly quote: string;
}
export type ContextActorObservationV1 = { readonly source_actor_ref: string } & (
  | { readonly role: 'mentioned'; readonly evidence: ContextEvidenceSpanV1 }
  | { readonly role: 'author' | 'speaker' | 'reporter' | 'creator' | 'participant' | 'assignee';
      /** Observed provider metadata, not a quotation or verified Person identity. */
      readonly attribution: { readonly source_anchor: string; readonly passage_ids: readonly string[] } }
);
export interface ContextActionObservationV1 {
  readonly id: string;
  /** Literal source observations. A proposal is never an approved ECHO action. */
  readonly kind: 'proposed' | 'assigned' | 'status_changed' | 'completed';
  readonly evidence: ContextEvidenceSpanV1;
  readonly source_actor_ref?: string;
}
type CaptureBaseV2 = Pick<ContextCaptureContentV1, 'label' | 'provenance'> & {
  readonly schema_version: 2;
  readonly kind: 'echo-context-capture-v2';
};
export type ContextCaptureContentV2 = CaptureBaseV2 & (
  | { readonly lifecycle: 'present'; readonly payload: ContextCaptureContentV1['payload'];
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
  readonly content: ContextCaptureContentV2; readonly previous_revision_id?: string;
}): ContextCaptureEnvelopeV2 {
  assertPlainContextObjectV1(input, ['identity', 'external_id', 'captured_at', 'content', 'previous_revision_id'], 'Context capture input');
  const sourceId = sourceItemIdV1(input.identity, input.external_id);
  const source: ContextCaptureEnvelopeV2 = {
    item: { schema_version: 1, source_id: sourceId, adapter: input.identity, external_id: input.external_id },
    revision: { schema_version: 1, source_id: sourceId, revision_id: revisionId(input.content, input.previous_revision_id),
      captured_at: input.captured_at, content_sha256: sourceContentSha256V1(input.content), artifact_refs: [], representation_refs: [],
      ...(input.previous_revision_id === undefined ? {} : { previous_revision_id: input.previous_revision_id }) },
    content: input.content,
  };
  assertContextCaptureEnvelopeV2(source, input.identity);
  return JSON.parse(canonicalSourceContentV1(source)) as ContextCaptureEnvelopeV2;
}
export function assertContextCaptureEnvelopeV2(value: unknown, identity: SourceAdapterIdentityV1): asserts value is ContextCaptureEnvelopeV2 {
  assertPlainContextObjectV1(value, ['item', 'revision', 'content'], 'Context envelope');
  if (Buffer.byteLength(canonicalSourceContentV1(value)) > CONTEXT_CAPTURE_LIMITS_V1.envelope_bytes) throw new Error('Context envelope exceeds its bound');
  assertSourceEnvelopeV1(value, identity);
  assertPlainContextObjectV1(value.content, ['schema_version', 'kind', 'label', 'provenance', 'lifecycle', 'payload', 'representation', 'actors', 'actions', 'deletion'], 'Context capture');
  const content = value.content as ContextCaptureContentV2;
  if (content.schema_version !== 2 || content.kind !== 'echo-context-capture-v2' || !['present', 'deleted'].includes(content.lifecycle)) throw new Error('Context V2 contract is unsupported');
  if (value.revision.revision_id !== revisionId(content, value.revision.previous_revision_id)) throw new Error('Context revision is not canonical');
  // Reuse V1's exact identity, provenance, payload and passage rules without changing V1 bytes.
  const legacyContent: ContextCaptureContentV1 = { schema_version: 1, kind: 'echo-context-capture-v1', label: content.label, provenance: content.provenance,
    payload: content.lifecycle === 'present' ? content.payload : { schema_version: 1, kind: 'note', format: 'plain_text' },
    representation: content.lifecycle === 'present' ? content.representation : { kind: 'pointer', pointer: content.provenance.origin_ref } };
  assertContextCaptureEnvelopeV1({ ...value, content: legacyContent, revision: { ...value.revision, content_sha256: sourceContentSha256V1(legacyContent) } }, identity);
  if (content.lifecycle === 'deleted') {
    assertPlainContextObjectV1(content, ['schema_version', 'kind', 'label', 'provenance', 'lifecycle', 'deletion'], 'Context tombstone');
    if (content.deletion !== 'explicit_upstream_tombstone' || value.revision.previous_revision_id === undefined || content.provenance.source_updated_at === undefined) throw new Error('Context deletion requires an explicit predecessor and source time');
    return;
  }
  assertPlainContextObjectV1(content, ['schema_version', 'kind', 'label', 'provenance', 'lifecycle', 'payload', 'representation', 'actors', 'actions'], 'Present context');
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
  const actions = new Set<string>();
  for (const action of content.actions) {
    assertPlainContextObjectV1(action, ['id', 'kind', 'evidence', 'source_actor_ref'], 'Context action');
    assertCaptureTextV1(action.id, 'Source action', 128);
    if (!['proposed', 'assigned', 'status_changed', 'completed'].includes(action.kind) || actions.has(action.id)) throw new Error('Context action kind or identity is invalid');
    assertContextEvidenceSpanV1(action.evidence, passages);
    if (action.source_actor_ref !== undefined && !sourceActors.includes(action.source_actor_ref)) throw new Error('Context action has an unknown actor');
    actions.add(action.id);
  }
}
