import { describe, expect, it } from 'vitest';
import {
  assertCaptureDeriveOutputV1, assertCaptureDeriveSnapshotV1, captureAnnotationIdV1, captureRevisionRefV1,
  captureSnapshotSha256V1, sourceContentSha256V1, type CaptureAnnotationV1, type CaptureDeriveSnapshotV1,
  type ContextActionObservationV1, type ContextCaptureContentV2,
} from '../../src/core/index.js';
import { CAPTURE_CONTAINER, captureBindings, captureClassification, captureContent, captureSource } from '../../../../tests/support/context-capture-v2.js';

function pointerTicket(actions: readonly ContextActionObservationV1[] = []): ContextCaptureContentV2 {
  const base = captureContent();
  if (base.lifecycle !== 'present') throw new Error('fixture');
  return {
    ...base,
    provenance: { origin_ref: 'fixture://ticket', container_ref: CAPTURE_CONTAINER },
    payload: { schema_version: 1, kind: 'ticket', key: 'ECHO-1', status: 'in_progress', labels: [] },
    representation: { kind: 'pointer', pointer: 'fixture://ticket' },
    actors: [], actions,
  };
}
function snapshot(source = captureSource({ content: pointerTicket() })): CaptureDeriveSnapshotV1 {
  const annotation: CaptureAnnotationV1 = { schema_version: 1, kind: 'echo-capture-annotation-v1', ...captureBindings(), people: [], classification: captureClassification(source) };
  const body = { schema_version: 1, kind: 'echo-capture-derive-snapshot-v1', organization_id: annotation.scope.organization_id, project_id: annotation.project_id,
    inputs: [{ source, annotation, annotation_representation_id: captureAnnotationIdV1(captureRevisionRefV1(source), annotation) }] } as const;
  return { ...body, snapshot_sha256: captureSnapshotSha256V1(body) };
}

describe('capture metadata evidence', () => {
  it('retains an observed ticket status from pointer-only metadata without inventing a change event', () => {
    const source = captureSource({ content: pointerTicket([{ id: 'status', kind: 'status_observed', evidence: { kind: 'payload_field', field: 'ticket.status' } }]) });
    expect(source.content).toMatchObject({ lifecycle: 'present', representation: { kind: 'pointer' } });
  });
  const invalidMetadataActions: readonly ContextActionObservationV1[] = [
    { id: 'changed', kind: 'status_changed', evidence: { kind: 'payload_field', field: 'ticket.status' } },
    { id: 'observed', kind: 'status_observed', evidence: { kind: 'payload_field', field: 'ticket.key' } },
    { id: 'proposed', kind: 'proposed', evidence: { kind: 'payload_field', field: 'ticket.status' } },
    { id: 'unknown', kind: 'status_observed', evidence: { kind: 'payload_field', field: 'message.author_ref' } },
  ];
  it.each(invalidMetadataActions)('rejects metadata action evidence that cannot mean the action: %j', action => {
    expect(() => captureSource({ content: pointerTicket([action]) })).toThrow();
  });
  it('rejects a non-whitelisted payload path even when the payload has related metadata', () => {
    const forged = { id: 'unknown-path', kind: 'status_observed', evidence: { kind: 'payload_field', field: 'ticket.labels' } } as unknown as ContextActionObservationV1;
    expect(() => captureSource({ content: pointerTicket([forged]) })).toThrow();
  });
  it('allows output facts to cite the exact selected payload field from a pointer capture', () => {
    const selected = snapshot(); assertCaptureDeriveSnapshotV1(selected);
    const source = selected.inputs[0]!.source;
    const body = { schema_version: 1, kind: 'echo-capture-derive-output-v1', input_snapshot_sha256: selected.snapshot_sha256,
      producer: captureClassification(source).producer, method: 'deterministic', output_schema: 'echo-capture-facts-v1',
      facts: [{ pillar: 'action', text: 'ECHO-1 has observed status in_progress.', evidence: [{ source_id: source.item.source_id, revision_id: source.revision.revision_id, field: 'ticket.status' }] }] } as const;
    expect(() => assertCaptureDeriveOutputV1({ ...body, output_sha256: sourceContentSha256V1(body) }, selected)).not.toThrow();
    const changed = { ...body, facts: [{ ...body.facts[0]!, evidence: [{ source_id: source.item.source_id, revision_id: source.revision.revision_id, field: 'message.author_ref' }] }] } as const;
    expect(() => assertCaptureDeriveOutputV1({ ...changed, output_sha256: sourceContentSha256V1(changed) }, selected)).toThrow();
  });
  it('does not allow a pointer capture to cite a made-up quoted span', () => {
    const selected = snapshot(); const source = selected.inputs[0]!.source;
    const body = { schema_version: 1, kind: 'echo-capture-derive-output-v1', input_snapshot_sha256: selected.snapshot_sha256,
      producer: captureClassification(source).producer, method: 'deterministic', output_schema: 'echo-capture-facts-v1',
      facts: [{ pillar: 'content', text: 'Unsupported.', evidence: [{ source_id: source.item.source_id, revision_id: source.revision.revision_id, span: { passage_id: 'p1', start: 0, end: 1, quote: 'x' } }] }] } as const;
    expect(() => assertCaptureDeriveOutputV1({ ...body, output_sha256: sourceContentSha256V1(body) }, selected)).toThrow(/outside/);
  });
});
