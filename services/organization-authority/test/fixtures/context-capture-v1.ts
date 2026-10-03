import {
  sourceContentSha256V1, sourceItemIdV1,
  type ContextCaptureContentV1, type ContextCaptureEnvelopeV1, type ContextRepresentationV1,
  type ContextStructuredPayloadV1, type ContextStructuredSourceTypeV1, type SourceAdapterIdentityV1,
} from '@echo-brain/organization-processing/core';

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

/** Synthetic provider metadata is intentionally separate from retained body text. */
function contextStructuredPayloadV1(source_type: ContextStructuredSourceTypeV1 = 'note'): ContextStructuredPayloadV1 {
  switch (source_type) {
    case 'note': return { schema_version: 1, kind: 'note', format: 'markdown' };
    case 'message': return { schema_version: 1, kind: 'message', channel_ref: 'channel:fixture', sent_at: CAPTURED_AT, thread_ref: 'thread:fixture', author_ref: 'author:fixture' };
    case 'ticket': return { schema_version: 1, kind: 'ticket', key: 'FIX-1', status: 'open', priority: 'normal', assignee_ref: 'assignee:fixture', due_at: CAPTURED_AT, labels: ['fixture'] };
    case 'meeting': return { schema_version: 1, kind: 'meeting', started_at: CAPTURED_AT, ended_at: '2026-10-01T01:00:00.000Z', participant_refs: ['participant:fixture'] };
  }
}

export function contextCaptureV1(options: {
  readonly external_id?: string;
  readonly revision_id?: string;
  readonly previous_revision_id?: string;
  readonly captured_at?: string;
  readonly source_type?: ContextStructuredSourceTypeV1;
  readonly label?: string;
  readonly origin_ref?: string;
  /** A source-stable semantic timestamp, omitted when the source exposes none. */
  readonly source_updated_at?: string;
  readonly payload?: ContextStructuredPayloadV1;
  readonly representation?: ContextRepresentationV1;
} = {}): ContextCaptureEnvelopeV1 {
  const externalId = options.external_id ?? 'brief-1';
  const sourceId = sourceItemIdV1(CONTEXT_CAPTURE_IDENTITY_V1, externalId);
  const content: ContextCaptureContentV1 = {
    schema_version: 1, kind: 'echo-context-capture-v1',
    label: options.label ?? 'Synthetic context brief',
    provenance: { origin_ref: options.origin_ref ?? `synthetic://context/${externalId}`, ...(options.source_updated_at === undefined ? {} : { source_updated_at: options.source_updated_at }) },
    payload: options.payload ?? contextStructuredPayloadV1(options.source_type),
    representation: options.representation ?? snapshotRepresentationV1(),
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
