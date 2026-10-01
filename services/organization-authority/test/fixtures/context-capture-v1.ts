import { sourceContentSha256V1, sourceItemIdV1, type SourceAdapterIdentityV1 } from '@echo-brain/organization-processing/core';
import type {
  ContextCaptureContentV1, ContextCaptureEnvelopeV1, ContextObservationV1, ContextRepresentationV1,
} from '../../src/application/context-intake-v1.js';

export const CONTEXT_CAPTURE_IDENTITY_V1 = Object.freeze({
  kind: 'source', adapter_id: 'synthetic-context', instance_id: 'fixture', version: '1',
} as const) satisfies SourceAdapterIdentityV1;

export const CONTEXT_CAPTURE_SCOPE_V1 = Object.freeze({
  organization_id: 'org_project_test', custody_ref: 'organization:org_project_test',
  access_policy_ref: 'context-capture-fixture', analysis_policy: 'on_request',
} as const);

const CAPTURED_AT = '2026-10-01T00:00:00.000Z';

export function pointerRepresentationV1(pointer = 'synthetic://context/brief-1'): ContextRepresentationV1 {
  return { kind: 'pointer', pointer };
}

export function excerptRepresentationV1(text = 'Hardware handoff is Friday.'): ContextRepresentationV1 {
  return {
    kind: 'excerpt',
    passages: [{ id: 'passage-1', source_anchor: 'paragraph:1', start: 0, end: text.length, text }],
  };
}

export function snapshotRepresentationV1(text = 'Hardware handoff is Friday.'): ContextRepresentationV1 {
  return {
    kind: 'full_snapshot', text,
    passages: [{ id: 'passage-1', source_anchor: 'paragraph:1', start: 0, end: text.length, text }],
  };
}

export function contextCaptureV1(options: {
  readonly external_id?: string;
  readonly revision_id?: string;
  readonly previous_revision_id?: string;
  readonly captured_at?: string;
  readonly source_type?: ContextCaptureContentV1['source_type'];
  readonly label?: string;
  readonly origin_ref?: string;
  readonly observed_at?: string;
  readonly representation?: ContextRepresentationV1;
  readonly observations?: readonly ContextObservationV1[];
} = {}): ContextCaptureEnvelopeV1 {
  const externalId = options.external_id ?? 'brief-1';
  const sourceId = sourceItemIdV1(CONTEXT_CAPTURE_IDENTITY_V1, externalId);
  const content: ContextCaptureContentV1 = {
    schema_version: 1, kind: 'echo-context-capture-v1',
    source_type: options.source_type ?? 'document', truth_status: 'source_observation',
    label: options.label ?? 'Synthetic context brief',
    provenance: { origin_ref: options.origin_ref ?? `synthetic://context/${externalId}`, observed_at: options.observed_at ?? CAPTURED_AT },
    representation: options.representation ?? snapshotRepresentationV1(),
    observations: options.observations ?? [],
  };
  return {
    item: { schema_version: 1, source_id: sourceId, adapter: CONTEXT_CAPTURE_IDENTITY_V1, external_id: externalId },
    revision: {
      schema_version: 1, source_id: sourceId, revision_id: options.revision_id ?? 'revision-1',
      captured_at: options.captured_at ?? CAPTURED_AT, content_sha256: sourceContentSha256V1(content),
      artifact_refs: [], representation_refs: [], ...(options.previous_revision_id === undefined ? {} : { previous_revision_id: options.previous_revision_id }),
    },
    content,
  };
}
