import {
  assertCaptureHashV1, assertCaptureTextV1, assertContextCaptureEnvelopeV2,
  assertContextPayloadFieldV1, assertContextEvidenceSpanV1, contextSourceActorRefsV2,
  type ContextCaptureEnvelopeV2, type ContextEvidenceSpanV1, type ContextPayloadFieldV1,
} from './context-capture-v2.js';
import { parseCaptureSourceRefV1 } from './capture-source-ref-v1.js';
import { assertCaptureProjectIdV1 } from './capture-container-scope-v1.js';
import { assertPlainContextObjectV1 } from './context-capture-v1.js';
import { assertSourceAdmissionScopeV1, canonicalSourceContentV1, sourceContentSha256V1 } from '../processing/source-admission.js';
import type { SourceAdmissionScopeV1 } from './source.js';

export interface CaptureRevisionRefV1 {
  readonly source_id: string; readonly revision_id: string; readonly content_sha256: string;
}
export interface CaptureProcessorV1 {
  readonly id: string; readonly version: string; readonly config_sha256: string;
}
export interface CaptureClassificationV1 {
  readonly schema_version: 1; /** Pure local rules only: no provider, network, or model call. */ readonly method: 'local_rules';
  readonly input: CaptureRevisionRefV1; readonly producer: CaptureProcessorV1;
  readonly decision: 'retain' | 'skip' | 'unresolved';
  readonly reason: 'useful' | 'noise' | 'unsupported' | 'needs_review' | 'source_deleted';
}
/** Authority-owned identity witness, not a provider's assertion or a permission grant. */
export interface CapturePersonBindingV1 {
  readonly source_actor_ref: string; readonly principal_id: string; readonly membership_id: string; readonly identity_link_ref: string;
}
export interface CaptureBindingsV1 {
  readonly scope: SourceAdmissionScopeV1;
  readonly project_id: string;
  readonly container_ref: string;
  readonly people: readonly CapturePersonBindingV1[];
}
export interface CaptureAnnotationV1 extends CaptureBindingsV1 {
  readonly schema_version: 1; readonly kind: 'echo-capture-annotation-v1';
  readonly classification: CaptureClassificationV1;
}
export interface CaptureSnapshotSelectionV1 extends CaptureRevisionRefV1 {
  readonly annotation_representation_id: string;
}
/** A bounded, exact historical selection. Current eligibility is checked separately by Authority. */
export interface CaptureDeriveSnapshotV1 {
  readonly schema_version: 1; readonly kind: 'echo-capture-derive-snapshot-v1';
  readonly organization_id: string; readonly project_id: string;
  readonly inputs: readonly { readonly source: ContextCaptureEnvelopeV2; readonly annotation: CaptureAnnotationV1; readonly annotation_representation_id: string }[];
  readonly snapshot_sha256: string;
}
export interface CaptureDerivedFactV1 {
  readonly pillar: 'person' | 'content' | 'action';
  readonly text: string;
  readonly evidence: readonly (
    | { readonly source_id: string; readonly revision_id: string; readonly span: ContextEvidenceSpanV1 }
    | { readonly source_id: string; readonly revision_id: string; readonly field: ContextPayloadFieldV1 }
  )[];
}
/** A derivation is a claim with evidence, never an approval or a new source observation. */
export interface CaptureDeriveOutputV1 {
  readonly schema_version: 1; readonly kind: 'echo-capture-derive-output-v1';
  readonly input_snapshot_sha256: string; readonly producer: CaptureProcessorV1;
  readonly method: 'deterministic' | 'inferred'; readonly output_schema: 'echo-capture-facts-v1';
  readonly facts: readonly CaptureDerivedFactV1[]; readonly output_sha256: string;
}
export const CAPTURE_FOUNDATION_LIMITS_V1 = Object.freeze({ annotation_bytes: 256 * 1024, snapshot_bytes: 8 * 1024 * 1024 });
export const CAPTURE_ANNOTATION_PROCESSOR_V1 = 'echo-capture-annotation-v1';
export function captureRevisionRefV1(source: ContextCaptureEnvelopeV2): CaptureRevisionRefV1 {
  return { source_id: source.item.source_id, revision_id: source.revision.revision_id, content_sha256: source.revision.content_sha256 };
}
function assertProcessor(value: CaptureProcessorV1): void {
  assertPlainContextObjectV1(value, ['id', 'version', 'config_sha256'], 'Capture processor');
  assertCaptureTextV1(value.id, 'Processor id'); assertCaptureTextV1(value.version, 'Processor version'); assertCaptureHashV1(value.config_sha256);
}
export function assertCaptureRevisionRefV1(value: unknown): asserts value is CaptureRevisionRefV1 {
  assertPlainContextObjectV1(value, ['source_id', 'revision_id', 'content_sha256'], 'Capture revision reference');
  const ref = value as CaptureRevisionRefV1;
  assertCaptureTextV1(ref.source_id, 'Source id'); assertCaptureTextV1(ref.revision_id, 'Revision id'); assertCaptureHashV1(ref.content_sha256);
}
export function assertCaptureClassificationV1(value: unknown, source: ContextCaptureEnvelopeV2): asserts value is CaptureClassificationV1 {
  assertPlainContextObjectV1(value, ['schema_version', 'method', 'input', 'producer', 'decision', 'reason'], 'Capture classification');
  const classification = value as CaptureClassificationV1;
  assertCaptureRevisionRefV1(classification.input); assertProcessor(classification.producer);
  const reasons = { retain: ['useful', 'source_deleted'], skip: ['noise', 'unsupported'], unresolved: ['needs_review'] };
  if (classification.schema_version !== 1 || classification.method !== 'local_rules' || typeof classification.decision !== 'string' || !Object.hasOwn(reasons, classification.decision) ||
      !reasons[classification.decision].includes(classification.reason) || canonicalSourceContentV1(classification.input) !== canonicalSourceContentV1(captureRevisionRefV1(source)) ||
      (classification.decision === 'retain' && (classification.reason === 'source_deleted') !== (source.content.lifecycle === 'deleted'))) throw new Error('Classification does not match capture');
}
export function assertCaptureBindingsV1(value: unknown, source: ContextCaptureEnvelopeV2): asserts value is CaptureBindingsV1 {
  assertPlainContextObjectV1(value, ['scope', 'project_id', 'container_ref', 'people'], 'Capture bindings');
  const bindings = value as CaptureBindingsV1;
  assertSourceAdmissionScopeV1(bindings.scope);
  assertCaptureProjectIdV1(bindings.project_id);
  if (parseCaptureSourceRefV1(bindings.container_ref).kind !== 'container' || bindings.container_ref !== source.content.provenance.container_ref) throw new Error('Capture binding differs from its observed container');
  // Foundation does not enable automatic analysis or mint project/directory entries.
  if (bindings.scope.analysis_policy !== 'on_request' ||
      !Array.isArray(bindings.people) || bindings.people.length > 64) throw new Error('Capture project bindings are invalid');
  const actors = contextSourceActorRefsV2(source.content); const seen = new Set<string>();
  for (const person of bindings.people) {
    assertPlainContextObjectV1(person, ['source_actor_ref', 'principal_id', 'membership_id', 'identity_link_ref'], 'Capture person binding');
    for (const value of [person.source_actor_ref, person.principal_id, person.membership_id, person.identity_link_ref]) assertCaptureTextV1(value, 'Person binding', 2048);
    if (parseCaptureSourceRefV1(person.source_actor_ref).kind !== 'actor' || !actors.includes(person.source_actor_ref) || seen.has(person.source_actor_ref)) throw new Error('Person binding has an unknown or duplicate source actor');
    seen.add(person.source_actor_ref);
  }
}
export function assertCaptureAnnotationV1(value: unknown, source: ContextCaptureEnvelopeV2): asserts value is CaptureAnnotationV1 {
  assertPlainContextObjectV1(value, ['schema_version', 'kind', 'scope', 'project_id', 'container_ref', 'people', 'classification'], 'Capture annotation');
  if (Buffer.byteLength(canonicalSourceContentV1(value)) > CAPTURE_FOUNDATION_LIMITS_V1.annotation_bytes) throw new Error('Capture annotation exceeds its bound');
  const annotation = value as CaptureAnnotationV1;
  if (annotation.schema_version !== 1 || annotation.kind !== 'echo-capture-annotation-v1') throw new Error('Capture annotation version is unsupported');
  assertCaptureBindingsV1({ scope: annotation.scope, project_id: annotation.project_id, container_ref: annotation.container_ref, people: annotation.people }, source);
  assertCaptureClassificationV1(annotation.classification, source);
  if (annotation.classification.decision !== 'retain') throw new Error('Only retained captures can have stored annotations');
}
export function captureAnnotationIdV1(source: CaptureRevisionRefV1, annotation: CaptureAnnotationV1): string {
  return `representation:${sourceContentSha256V1({ revision_id: source.revision_id, processor_version: CAPTURE_ANNOTATION_PROCESSOR_V1, content_sha256: sourceContentSha256V1(annotation) })}`;
}
/** Poll timestamps are excluded; exact source revisions and annotations determine the manifest. */
export function captureSnapshotSha256V1(snapshot: Omit<CaptureDeriveSnapshotV1, 'snapshot_sha256'>): string {
  return sourceContentSha256V1({ schema_version: snapshot.schema_version, kind: snapshot.kind, organization_id: snapshot.organization_id, project_id: snapshot.project_id,
    inputs: snapshot.inputs.map(input => ({ ...captureRevisionRefV1(input.source), annotation_representation_id: input.annotation_representation_id })) });
}
export function assertCaptureDeriveSnapshotV1(value: unknown): asserts value is CaptureDeriveSnapshotV1 {
  assertPlainContextObjectV1(value, ['schema_version', 'kind', 'organization_id', 'project_id', 'inputs', 'snapshot_sha256'], 'Capture derive snapshot');
  if (Buffer.byteLength(canonicalSourceContentV1(value)) > CAPTURE_FOUNDATION_LIMITS_V1.snapshot_bytes) throw new Error('Capture snapshot exceeds its byte bound');
  const snapshot = value as CaptureDeriveSnapshotV1;
  if (snapshot.schema_version !== 1 || snapshot.kind !== 'echo-capture-derive-snapshot-v1' || !Array.isArray(snapshot.inputs) || snapshot.inputs.length < 1 || snapshot.inputs.length > 100) throw new Error('Capture snapshot is invalid');
  let previous = '';
  for (const input of snapshot.inputs) {
    assertPlainContextObjectV1(input, ['source', 'annotation', 'annotation_representation_id'], 'Snapshot input');
    assertContextCaptureEnvelopeV2(input.source, input.source.item.adapter); assertCaptureAnnotationV1(input.annotation, input.source);
    const key = canonicalSourceContentV1([input.source.item.source_id, input.source.revision.revision_id]);
    if (key <= previous || input.source.content.lifecycle !== 'present' || input.annotation.scope.organization_id !== snapshot.organization_id || input.annotation.project_id !== snapshot.project_id ||
        captureAnnotationIdV1(captureRevisionRefV1(input.source), input.annotation) !== input.annotation_representation_id) throw new Error('Capture snapshot input is not an exact eligible selection');
    previous = key;
  }
  if (captureSnapshotSha256V1(snapshot) !== snapshot.snapshot_sha256) throw new Error('Capture snapshot digest mismatch');
}
export function assertCaptureDeriveOutputV1(value: unknown, snapshot: CaptureDeriveSnapshotV1): asserts value is CaptureDeriveOutputV1 {
  assertCaptureDeriveSnapshotV1(snapshot);
  assertPlainContextObjectV1(value, ['schema_version', 'kind', 'input_snapshot_sha256', 'producer', 'method', 'output_schema', 'facts', 'output_sha256'], 'Capture derive output');
  const output = value as CaptureDeriveOutputV1;
  assertProcessor(output.producer);
  if (Buffer.byteLength(canonicalSourceContentV1(output)) > 256 * 1024 || output.schema_version !== 1 || output.kind !== 'echo-capture-derive-output-v1' || output.output_schema !== 'echo-capture-facts-v1' ||
      output.input_snapshot_sha256 !== snapshot.snapshot_sha256 || !['deterministic', 'inferred'].includes(output.method) || !Array.isArray(output.facts) || output.facts.length > 100) throw new Error('Capture derive output is invalid');
  for (const fact of output.facts) {
    assertPlainContextObjectV1(fact, ['pillar', 'text', 'evidence'], 'Derived fact'); assertCaptureTextV1(fact.text, 'Derived text', 4096);
    if (!['person', 'content', 'action'].includes(fact.pillar) || !Array.isArray(fact.evidence) || fact.evidence.length < 1 || fact.evidence.length > 32) throw new Error('Derived fact requires bounded evidence');
    for (const evidence of fact.evidence) {
      assertPlainContextObjectV1(evidence, ['source_id', 'revision_id', 'span', 'field'], 'Derived evidence');
      const content = snapshot.inputs.find(input => input.source.item.source_id === evidence.source_id && input.source.revision.revision_id === evidence.revision_id)?.source.content;
      if (!content || content.lifecycle !== 'present') throw new Error('Derived evidence is outside the selected snapshot');
      const record = evidence as Record<string, unknown>;
      const hasSpan = record.span !== undefined;
      const hasField = record.field !== undefined;
      if (hasSpan === hasField) throw new Error('Derived evidence must name one exact anchor');
      if (hasSpan) {
        assertPlainContextObjectV1(evidence, ['source_id', 'revision_id', 'span'], 'Derived span evidence');
        if (content.representation.kind === 'pointer') throw new Error('Derived evidence is outside the selected snapshot');
        assertContextEvidenceSpanV1(record.span, content.representation.passages);
      } else {
        assertPlainContextObjectV1(evidence, ['source_id', 'revision_id', 'field'], 'Derived payload evidence');
        assertContextPayloadFieldV1(record.field, content);
      }
    }
  }
  const { output_sha256: _hash, ...body } = output;
  if (sourceContentSha256V1(body) !== output.output_sha256) throw new Error('Capture derive output digest mismatch');
}
