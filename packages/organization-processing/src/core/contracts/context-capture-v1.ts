import {
  assertSourceEnvelopeV1,
  canonicalSourceContentV1,
  sourceContentSha256V1,
  sourceItemIdV1,
} from '../processing/source-admission.js';
import type { SourceAdapterIdentityV1, SourceEnvelopeV1 } from './source.js';
import {
  assertContextStructuredPayloadV1,
  type ContextStructuredPayloadV1,
  type ContextStructuredSourceTypeV1,
} from './context-structured-payload-v1.js';

export const CONTEXT_CAPTURE_LIMITS_V1 = Object.freeze({
  envelope_bytes: 256 * 1024, snapshot_bytes: 128 * 1024, excerpt_bytes: 32 * 1024,
  passage_bytes: 4096, anchors: 32, observations: 32, batch: 100,
});

export interface ContextPassageV1 {
  readonly id: string;
  readonly source_anchor: string;
  /** Exact JavaScript string offsets in the observed source, never model offsets. */
  readonly start: number;
  readonly end: number;
  readonly text: string;
}
export type ContextRepresentationV1 =
  | { readonly kind: 'pointer'; readonly pointer: string }
  | { readonly kind: 'excerpt'; readonly passages: readonly ContextPassageV1[] }
  | { readonly kind: 'full_snapshot'; readonly text: string; readonly passages: readonly ContextPassageV1[] };
export interface ContextObservationV1 {
  readonly kind: 'references' | 'activity';
  readonly anchor_id: string;
  readonly target: { readonly source_id: string; readonly revision_id: string };
  readonly occurred_at: string;
}
/** No policy, memberships or approved truth can originate in this adapter value. */
export interface ContextCaptureContentV1 {
  readonly schema_version: 1;
  readonly kind: 'echo-context-capture-v1';
  readonly source_type: ContextStructuredSourceTypeV1;
  readonly truth_status: 'source_observation';
  readonly label: string;
  /** Source time is stable for this revision; the read/poll time is revision.captured_at. */
  readonly provenance: { readonly origin_ref: string; readonly source_updated_at?: string };
  readonly payload: ContextStructuredPayloadV1;
  readonly representation: ContextRepresentationV1;
  readonly observations: readonly ContextObservationV1[];
}
export type ContextCaptureEnvelopeV1 = SourceEnvelopeV1<ContextCaptureContentV1>;

function object(value: unknown, allowed: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error(`${label} must be a plain object`);
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some(key => !allowed.includes(key))) throw new Error(`${label} has an unknown field`);
  return result;
}
function text(value: unknown, maximum: number, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '' || Buffer.byteLength(value, 'utf8') > maximum || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(value)) throw new Error(`${label} must be bounded text`);
}
function timestamp(value: unknown): void {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error('Context timestamp must be canonical UTC');
}

/** Reject executable/accessor values before snapshotting adapter-owned data. */
function plainData(value: unknown, depth = 0): void {
  if (depth > 64) throw new Error('Context data exceeds its depth bound');
  if (value === null || typeof value !== 'object') return;
  if (Object.getOwnPropertySymbols(value).length !== 0) throw new Error('Context data has symbol fields');
  const array = Array.isArray(value);
  if (!array && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('Context data must be plain');
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (array && key === 'length') continue;
    if (!('value' in descriptor) || !descriptor.enumerable || (array && !/^(0|[1-9][0-9]*)$/.test(key))) throw new Error('Context data has non-data fields');
    plainData(descriptor.value, depth + 1);
  }
}
export interface BuildContextCaptureEnvelopeInputV1 {
  readonly identity: SourceAdapterIdentityV1;
  readonly external_id: string;
  /** Observation time, intentionally excluded from the immutable revision identity. */
  readonly captured_at: string;
  readonly content: ContextCaptureContentV1;
  readonly previous_revision_id?: string;
}

/**
 * Builds a provider-neutral source envelope. The revision identity commits to
 * capture content and predecessor, never poll time or adapter implementation version.
 */
export function buildContextCaptureEnvelopeV1(input: BuildContextCaptureEnvelopeInputV1): ContextCaptureEnvelopeV1 {
  plainData(input);
  const sourceId = sourceItemIdV1(input.identity, input.external_id);
  const contentSha256 = sourceContentSha256V1(input.content);
  const revisionId = `context:${sourceContentSha256V1({
    content: input.content,
    ...(input.previous_revision_id === undefined ? {} : { previous_revision_id: input.previous_revision_id }),
  })}`;
  const envelope: ContextCaptureEnvelopeV1 = {
    item: {
      schema_version: 1,
      source_id: sourceId,
      adapter: input.identity,
      external_id: input.external_id,
    },
    revision: {
      schema_version: 1,
      source_id: sourceId,
      revision_id: revisionId,
      captured_at: input.captured_at,
      content_sha256: contentSha256,
      artifact_refs: [],
      representation_refs: [],
      ...(input.previous_revision_id === undefined ? {} : { previous_revision_id: input.previous_revision_id }),
    },
    content: input.content,
  };
  assertContextCaptureEnvelopeV1(envelope, input.identity);
  return JSON.parse(canonicalSourceContentV1(envelope)) as ContextCaptureEnvelopeV1;
}

export function assertContextCaptureEnvelopeV1(value: unknown, identity: SourceAdapterIdentityV1): asserts value is ContextCaptureEnvelopeV1 {
  plainData(value);
  // Check the smaller capability bound before the existing 32 MiB gate.
  const encoded = canonicalSourceContentV1(value);
  if (Buffer.byteLength(encoded, 'utf8') > CONTEXT_CAPTURE_LIMITS_V1.envelope_bytes) throw new Error('Context envelope exceeds its bound');
  assertSourceEnvelopeV1(value, identity);
  if (value.item.adapter.kind !== 'source' || value.item.source_id !== sourceItemIdV1(identity, value.item.external_id)) throw new Error('Context source identity is not canonical');
  // V1 owns its typed retained bytes; external artifact/derived-output custody is deferred.
  if (value.revision.artifact_refs.length !== 0 || value.revision.representation_refs.length !== 0 || value.revision.contributor !== undefined) throw new Error('Context V1 does not accept artifact, derived or identity claims');
  const content = object(value.content, ['schema_version', 'kind', 'source_type', 'truth_status', 'label', 'provenance', 'payload', 'representation', 'observations'], 'Context capture');
  if (content.schema_version !== 1 || content.kind !== 'echo-context-capture-v1' || content.truth_status !== 'source_observation' ||
      typeof content.source_type !== 'string' || !['document', 'note', 'message', 'ticket', 'meeting', 'activity', 'task', 'decision'].includes(content.source_type)) throw new Error('Context capture contract is unsupported');
  text(content.label, 200, 'Context label');
  const provenance = object(content.provenance, ['origin_ref', 'source_updated_at'], 'Context provenance');
  text(provenance.origin_ref, 2048, 'Context origin');
  if (provenance.source_updated_at !== undefined) timestamp(provenance.source_updated_at);
  assertContextStructuredPayloadV1(content.payload, content.source_type as ContextStructuredSourceTypeV1);
  const representation = object(content.representation, ['kind', 'pointer', 'text', 'passages'], 'Context representation');
  const anchors = new Set<string>();
  if (representation.kind === 'pointer') {
    if (representation.text !== undefined || representation.passages !== undefined) throw new Error('A pointer cannot contain answer text');
    text(representation.pointer, 2048, 'Context pointer');
  } else {
    if (!['excerpt', 'full_snapshot'].includes(String(representation.kind)) || representation.pointer !== undefined) throw new Error('Context representation is unsupported');
    if (!Array.isArray(representation.passages) || representation.passages.length < 1 || representation.passages.length > CONTEXT_CAPTURE_LIMITS_V1.anchors) throw new Error('Context anchors exceed their bound');
    if (representation.kind === 'full_snapshot') {
      if (typeof representation.text !== 'string' || representation.text.trim() === '' || Buffer.byteLength(representation.text, 'utf8') > CONTEXT_CAPTURE_LIMITS_V1.snapshot_bytes) throw new Error('Context snapshot exceeds its bound');
    } else if (representation.text !== undefined) throw new Error('An excerpt cannot retain a full snapshot');
    let bytes = 0;
    const excerpts: Pick<ContextPassageV1, 'source_anchor' | 'start' | 'end' | 'text'>[] = [];
    for (const value of representation.passages) {
      const passage = object(value, ['id', 'source_anchor', 'start', 'end', 'text'], 'Context passage');
      text(passage.id, 128, 'Context anchor id'); text(passage.source_anchor, 512, 'Context source anchor');
      if (anchors.has(passage.id)) throw new Error('Context anchor identities must be unique');
      anchors.add(passage.id);
      if (typeof passage.text !== 'string' || passage.text.trim() === '' || Buffer.byteLength(passage.text, 'utf8') > CONTEXT_CAPTURE_LIMITS_V1.passage_bytes ||
          !Number.isSafeInteger(passage.start) || !Number.isSafeInteger(passage.end) || Number(passage.start) < 0 || Number(passage.end) <= Number(passage.start) || Number(passage.end) - Number(passage.start) !== passage.text.length) throw new Error('Context passage is unbounded or unanchored');
      if (representation.kind === 'full_snapshot' && (Number(passage.end) > (representation.text as string).length || (representation.text as string).slice(Number(passage.start), Number(passage.end)) !== passage.text)) throw new Error('Context passage does not match its snapshot');
      if (representation.kind === 'excerpt') {
        const start = Number(passage.start);
        const end = Number(passage.end);
        for (const previous of excerpts) {
          if (previous.source_anchor !== passage.source_anchor) continue;
          const overlapStart = Math.max(previous.start, start);
          const overlapEnd = Math.min(previous.end, end);
          if (overlapStart < overlapEnd &&
              previous.text.slice(overlapStart - previous.start, overlapEnd - previous.start) !== passage.text.slice(overlapStart - start, overlapEnd - start)) {
            throw new Error('Context excerpts conflict at the same source anchor');
          }
        }
        excerpts.push({ source_anchor: passage.source_anchor, start, end, text: passage.text });
      }
      bytes += Buffer.byteLength(passage.text, 'utf8');
    }
    if (representation.kind === 'excerpt' && bytes > CONTEXT_CAPTURE_LIMITS_V1.excerpt_bytes) throw new Error('Context excerpts exceed their bound');
  }
  if (!Array.isArray(content.observations) || content.observations.length > CONTEXT_CAPTURE_LIMITS_V1.observations) throw new Error('Context observations exceed their bound');
  const observed = new Set<string>();
  for (const value of content.observations) {
    const observation = object(value, ['kind', 'anchor_id', 'target', 'occurred_at'], 'Context observation');
    if (observation.kind !== 'references' && observation.kind !== 'activity') throw new Error('Context observation kind is unsupported');
    text(observation.anchor_id, 128, 'Context observation anchor');
    if (!anchors.has(observation.anchor_id)) throw new Error('Context observation lacks a source anchor');
    const target = object(observation.target, ['source_id', 'revision_id'], 'Context observation target');
    if (typeof target.source_id !== 'string' || !/^source:[a-f0-9]{64}$/.test(target.source_id)) throw new Error('Context target identity is invalid');
    text(target.revision_id, 512, 'Context target revision'); timestamp(observation.occurred_at);
    const key = canonicalSourceContentV1(observation);
    if (observed.has(key)) throw new Error('Context observations must be unique');
    observed.add(key);
  }
}
