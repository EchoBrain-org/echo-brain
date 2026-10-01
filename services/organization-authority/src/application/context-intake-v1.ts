import {
  assertSourceAdmissionScopeV1, assertSourceEnvelopeV1, canonicalSourceContentV1,
  sourceContentSha256V1, sourceItemIdV1,
  type AdapterOperationContext, type SourceAdapterIdentityV1, type SourceAdmissionScopeV1,
  type SourceAdmissionStoreV1, type SourceEnvelopeV1,
} from '@echo-brain/organization-processing/core';

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
  readonly source_type: 'document' | 'note' | 'message' | 'ticket' | 'meeting' | 'activity' | 'task' | 'decision';
  readonly truth_status: 'source_observation';
  readonly label: string;
  readonly provenance: { readonly origin_ref: string; readonly observed_at: string };
  readonly representation: ContextRepresentationV1;
  readonly observations: readonly ContextObservationV1[];
}
export type ContextCaptureEnvelopeV1 = SourceEnvelopeV1<ContextCaptureContentV1>;
export interface RetainedContextCaptureV1 {
  readonly source: ContextCaptureEnvelopeV1;
  readonly scope: SourceAdmissionScopeV1;
  /** Existing admission's immutable manifest commitment, excluding capture time. */
  readonly revision_sha256: string;
}
export interface ContextCaptureReadPortV1 {
  list(input: { readonly organization_id: string; readonly limit?: number }): readonly RetainedContextCaptureV1[];
}
export interface ContextIntakePolicyV1 {
  readonly disposition: 'retained' | 'request_only';
  readonly scope: SourceAdmissionScopeV1;
  readonly permitted_representations: readonly ContextRepresentationV1['kind'][];
}
/** Trusted Authority composition owns this port, independently of read grants. */
export interface ContextIntakeAuthorityV1 {
  select(source: ContextCaptureEnvelopeV1): ContextIntakePolicyV1;
  requireCurrent(source: ContextCaptureEnvelopeV1, policy: ContextIntakePolicyV1): void;
}

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

export function assertContextCaptureEnvelopeV1(value: unknown, identity: SourceAdapterIdentityV1): asserts value is ContextCaptureEnvelopeV1 {
  plainData(value);
  // Check the smaller capability bound before the existing 32 MiB gate.
  const encoded = canonicalSourceContentV1(value);
  if (Buffer.byteLength(encoded, 'utf8') > CONTEXT_CAPTURE_LIMITS_V1.envelope_bytes) throw new Error('Context envelope exceeds its bound');
  assertSourceEnvelopeV1(value, identity);
  if (value.item.adapter.kind !== 'source' || value.item.source_id !== sourceItemIdV1(identity, value.item.external_id)) throw new Error('Context source identity is not canonical');
  // V1 owns its typed retained bytes; external artifact/derived-output custody is deferred.
  if (value.revision.artifact_refs.length !== 0 || value.revision.representation_refs.length !== 0 || value.revision.contributor !== undefined) throw new Error('Context V1 does not accept artifact, derived or identity claims');
  const content = object(value.content, ['schema_version', 'kind', 'source_type', 'truth_status', 'label', 'provenance', 'representation', 'observations'], 'Context capture');
  if (content.schema_version !== 1 || content.kind !== 'echo-context-capture-v1' || content.truth_status !== 'source_observation' ||
      typeof content.source_type !== 'string' || !['document', 'note', 'message', 'ticket', 'meeting', 'activity', 'task', 'decision'].includes(content.source_type)) throw new Error('Context capture contract is unsupported');
  text(content.label, 200, 'Context label');
  const provenance = object(content.provenance, ['origin_ref', 'observed_at'], 'Context provenance');
  text(provenance.origin_ref, 2048, 'Context origin'); timestamp(provenance.observed_at);
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
    for (const value of representation.passages) {
      const passage = object(value, ['id', 'source_anchor', 'start', 'end', 'text'], 'Context passage');
      text(passage.id, 128, 'Context anchor id'); text(passage.source_anchor, 512, 'Context source anchor');
      if (anchors.has(passage.id)) throw new Error('Context anchor identities must be unique');
      anchors.add(passage.id);
      if (typeof passage.text !== 'string' || passage.text.trim() === '' || Buffer.byteLength(passage.text, 'utf8') > CONTEXT_CAPTURE_LIMITS_V1.passage_bytes ||
          !Number.isSafeInteger(passage.start) || !Number.isSafeInteger(passage.end) || Number(passage.start) < 0 || Number(passage.end) <= Number(passage.start) || Number(passage.end) - Number(passage.start) !== passage.text.length) throw new Error('Context passage is unbounded or unanchored');
      if (representation.kind === 'full_snapshot' && (Number(passage.end) > (representation.text as string).length || (representation.text as string).slice(Number(passage.start), Number(passage.end)) !== passage.text)) throw new Error('Context passage does not match its snapshot');
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

/** Shared gate. Request-only policy cannot accidentally fall through to storage. */
export async function intakeContextBatchV1(options: {
  readonly identity: SourceAdapterIdentityV1;
  readonly sources: readonly unknown[];
  readonly authority: ContextIntakeAuthorityV1;
  /** Retained composition must repeat requireCurrent atomically with admission. */
  readonly store?: SourceAdmissionStoreV1;
  readonly context?: AdapterOperationContext;
}): Promise<readonly { readonly source: ContextCaptureEnvelopeV1; readonly policy: ContextIntakePolicyV1; readonly admission: 'admitted' | 'duplicate' | 'request_only' }[]> {
  options.context?.signal.throwIfAborted();
  if (!Array.isArray(options.sources) || options.sources.length > CONTEXT_CAPTURE_LIMITS_V1.batch) throw new Error('Context batch exceeds its bound');
  // Validate raw closed fields before JSON snapshotting can erase undefined extras.
  for (const source of options.sources) assertContextCaptureEnvelopeV1(source, options.identity);
  const sources = freeze(JSON.parse(canonicalSourceContentV1(options.sources)) as ContextCaptureEnvelopeV1[]);
  const policies: ContextIntakePolicyV1[] = [];
  const revisions = new Map<string, string>();
  const bindings = new Map<string, string>();
  for (const source of sources) {
    assertContextCaptureEnvelopeV1(source, options.identity);
    const raw = options.authority.select(source);
    plainData(raw);
    object(raw, ['disposition', 'scope', 'permitted_representations'], 'Context Authority policy');
    assertSourceAdmissionScopeV1(raw.scope);
    if (!['retained', 'request_only'].includes(raw.disposition) || raw.scope.analysis_policy !== 'on_request' ||
        !Array.isArray(raw.permitted_representations) || raw.permitted_representations.length < 1 || raw.permitted_representations.length > 3 ||
        raw.permitted_representations.some(kind => !['pointer', 'excerpt', 'full_snapshot'].includes(kind)) ||
        new Set(raw.permitted_representations).size !== raw.permitted_representations.length ||
        !raw.permitted_representations.includes(source.content.representation.kind)) throw new Error('Context retention is not authorized');
    const policy = freeze(JSON.parse(canonicalSourceContentV1(raw)) as ContextIntakePolicyV1);
    if (policy.disposition === 'retained' && options.store === undefined) throw new Error('Retained context requires an admission store');
    const key = canonicalSourceContentV1([policy.scope.organization_id, source.item.source_id, source.revision.revision_id]);
    const { captured_at: _captured, ...immutable } = source.revision;
    const hash = sourceContentSha256V1(immutable);
    if (revisions.has(key) && revisions.get(key) !== hash) throw new Error('Context batch contains immutable revision conflicts');
    revisions.set(key, hash);
    const bindingKey = canonicalSourceContentV1([policy.scope.organization_id, source.item.source_id]);
    const binding = canonicalSourceContentV1(policy.scope);
    if (bindings.has(bindingKey) && bindings.get(bindingKey) !== binding) throw new Error('Context batch contains custody conflicts');
    bindings.set(bindingKey, binding);
    options.authority.requireCurrent(source, policy); policies.push(policy);
  }
  const results = [];
  for (const [index, source] of sources.entries()) {
    options.context?.signal.throwIfAborted();
    const policy = policies[index]!;
    options.authority.requireCurrent(source, policy);
    const admission = policy.disposition === 'request_only' ? 'request_only' as const :
      await options.store!.admitSourceRevision({ source, scope: policy.scope }, options.context);
    options.context?.signal.throwIfAborted();
    results.push({ source, policy, admission });
  }
  return results;
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
