import { describe, expect, it } from 'vitest';
import {
  assertCaptureBindingsV1, assertCaptureClassificationV1, assertCaptureDeriveOutputV1, assertCaptureDeriveSnapshotV1,
  assertContextCaptureEnvelopeV2, captureAnnotationIdV1, captureRevisionRefV1, captureSnapshotSha256V1, sourceContentSha256V1,
  type CaptureAnnotationV1, type CaptureDeriveSnapshotV1, type ContextCaptureContentV2,
} from '../../src/core/index.js';
import { CAPTURE_IDENTITY, CAPTURE_SPAN, captureBindings, captureClassification, captureContent, captureSource } from '../fixtures/context-capture-v2.js';

function snapshot(): CaptureDeriveSnapshotV1 {
  const source = captureSource();
  const annotation: CaptureAnnotationV1 = { schema_version: 1, kind: 'echo-capture-annotation-v1', ...captureBindings(), classification: captureClassification(source) };
  const body = { schema_version: 1, kind: 'echo-capture-derive-snapshot-v1', organization_id: annotation.scope.organization_id, project_id: annotation.project_id,
    inputs: [{ source, annotation, annotation_representation_id: captureAnnotationIdV1(captureRevisionRefV1(source), annotation) }] } as const;
  return { ...body, snapshot_sha256: captureSnapshotSha256V1(body) };
}
describe('capture foundation contracts', () => {
  it('keeps immutable identity across repolls and separates binding changes from source revisions', () => {
    const first = captureSource(); const repoll = captureSource({ captured_at: '2026-10-03T01:00:00.000Z' });
    expect(repoll.revision.revision_id).toBe(first.revision.revision_id);
    expect(repoll.revision.content_sha256).toBe(first.revision.content_sha256);
    const selected = snapshot(); const original = selected.snapshot_sha256;
    const entry = selected.inputs[0]!;
    const changed = { ...entry.annotation, people: [] };
    const updated = { ...selected, inputs: [{ ...entry, annotation: changed, annotation_representation_id: captureAnnotationIdV1(captureRevisionRefV1(first), changed) }] };
    expect(captureSnapshotSha256V1(updated)).not.toBe(original);
    expect(updated.inputs[0]!.source.revision.revision_id).toBe(first.revision.revision_id);
  });
  it.each([
    ['altered quote', (c: Record<string, unknown>) => { c.actions = [{ id: 'a1', kind: 'completed', evidence: { ...CAPTURE_SPAN, quote: 'invented' } }]; }],
    ['dangling passage', (c: Record<string, unknown>) => { c.actions = [{ id: 'a1', kind: 'assigned', evidence: { ...CAPTURE_SPAN, passage_id: 'absent' } }]; }],
    ['unknown actor', (c: Record<string, unknown>) => { c.actions = [{ id: 'a1', kind: 'completed', evidence: CAPTURE_SPAN, source_actor_ref: 'stranger' }]; }],
    ['duplicate action', (c: Record<string, unknown>) => { c.actions = [c.actions, c.actions].flat(); }],
    ['approval claim', (c: Record<string, unknown>) => { c.approved = true; }],
    ['pointer observations', (c: Record<string, unknown>) => { c.representation = { kind: 'pointer', pointer: 'fixture://handoff' }; }],
  ])('rejects %s', (_name, change) => {
    const content = structuredClone(captureContent()) as unknown as Record<string, unknown>; change(content);
    expect(() => captureSource({ content: content as unknown as ContextCaptureContentV2 })).toThrow();
  });
  it('preserves speaker and reporter metadata without pretending it was quoted', () => {
    const content = captureContent(); if (content.lifecycle !== 'present') throw new Error('fixture');
    const actors = [
      { source_actor_ref: 'provider:speaker', role: 'speaker' as const, attribution: { source_anchor: 'segments[0].speaker', passage_ids: ['p1'] } },
      { source_actor_ref: 'provider:reporter', role: 'reporter' as const, attribution: { source_anchor: 'fields.reporter', passage_ids: [] } },
    ];
    expect(() => captureSource({ content: { ...content, actors, actions: [] } })).not.toThrow();
    for (const passage_ids of [[], ['missing'], ['p1', 'p1']]) {
      expect(() => captureSource({ content: { ...content, actors: [{ ...actors[0]!, attribution: { source_anchor: 'speaker', passage_ids } }], actions: [] } })).toThrow(/attribution/);
    }
    expect(() => captureSource({ content: { ...content, actors: [{ ...actors[0]!, evidence: CAPTURE_SPAN }] as unknown as typeof actors, actions: [] } })).toThrow(/unknown field/);
  });
  it('accepts only body-free explicit tombstones with predecessor and observed source time', () => {
    const content: ContextCaptureContentV2 = { schema_version: 2, kind: 'echo-context-capture-v2', lifecycle: 'deleted', label: 'Deleted handoff',
      provenance: { origin_ref: 'fixture://handoff', source_updated_at: '2026-10-03T01:00:00.000Z' }, deletion: 'explicit_upstream_tombstone' };
    const prior = captureSource().revision.revision_id;
    expect(() => captureSource({ content, previous_revision_id: prior })).not.toThrow();
    expect(() => captureSource({ content })).toThrow(/predecessor/);
    expect(() => captureSource({ content: { ...content, actions: [] } as ContextCaptureContentV2, previous_revision_id: prior })).toThrow(/unknown field/);
  });
  it('rejects forged immutable revision identities and executable provider objects', () => {
    const source = captureSource();
    expect(() => assertContextCaptureEnvelopeV2({ ...source, revision: { ...source.revision, revision_id: 'arbitrary' } }, CAPTURE_IDENTITY)).toThrow(/canonical/);
    const content = captureContent(); Object.defineProperty(content, 'label', { get() { throw new Error('getter ran'); }, enumerable: true });
    expect(() => captureSource({ content })).toThrow(/non-data/);
  });
  it.each(['principal_id', 'membership_id', 'identity_link_ref'])('requires the %s identity witness field', field => {
    const bindings = structuredClone(captureBindings()); delete (bindings.people[0] as unknown as Record<string, unknown>)[field];
    expect(() => assertCaptureBindingsV1(bindings, captureSource())).toThrow();
  });
  it('rejects coerced project and decision types, swapped classifier inputs and mismatched decisions', () => {
    const source = captureSource(); const classification = captureClassification();
    expect(() => assertCaptureBindingsV1({ ...captureBindings(), project_id: [captureBindings().project_id] }, source)).toThrow();
    expect(() => assertCaptureClassificationV1({ ...classification, decision: ['skip'], reason: 'noise' }, source)).toThrow();
    expect(() => assertCaptureClassificationV1({ ...classification, input: captureRevisionRefV1(captureSource({ external_id: 'other' })) }, source)).toThrow();
    expect(() => assertCaptureClassificationV1({ ...classification, reason: 'source_deleted' }, source)).toThrow();
  });
  it('validates exact evidence and output commitments without permitting approval fields', () => {
    const selected = snapshot(); assertCaptureDeriveSnapshotV1(selected);
    const source = selected.inputs[0]!.source;
    const body = { schema_version: 1, kind: 'echo-capture-derive-output-v1', input_snapshot_sha256: selected.snapshot_sha256,
      producer: captureClassification().producer, method: 'inferred', output_schema: 'echo-capture-facts-v1',
      facts: [{ pillar: 'action', text: 'The handoff appears complete.', evidence: [{ source_id: source.item.source_id, revision_id: source.revision.revision_id, span: CAPTURE_SPAN }] }] };
    const output = { ...body, output_sha256: sourceContentSha256V1(body) };
    expect(() => assertCaptureDeriveOutputV1(output, selected)).not.toThrow();
    expect(() => assertCaptureDeriveOutputV1({ ...output, approved: true }, selected)).toThrow();
    expect(() => assertCaptureDeriveOutputV1({ ...output, output_sha256: '0'.repeat(64) }, selected)).toThrow(/digest/);
    expect(() => assertCaptureDeriveOutputV1({ ...output, input_snapshot_sha256: '0'.repeat(64) }, selected)).toThrow();
    const changed = { ...body, facts: [{ ...body.facts[0]!, evidence: [{ source_id: source.item.source_id, revision_id: 'unselected', span: CAPTURE_SPAN }] }] };
    expect(() => assertCaptureDeriveOutputV1({ ...changed, output_sha256: sourceContentSha256V1(changed) }, selected)).toThrow(/outside/);
  });
});
