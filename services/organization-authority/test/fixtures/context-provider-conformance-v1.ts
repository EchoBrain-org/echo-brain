import {
  sourceContentSha256V1, sourceItemIdV1,
  type AdapterConfig, type AdapterConfigValidation, type AdapterHealth, type AdapterOperationContext,
  type SourceAdapterIdentityV1, type SourceAdapterV1, type SourceBatchV1, type SourcePullRequestV1,
} from '@echo-brain/organization-processing/core';
import type { ContextCaptureContentV1, ContextCaptureEnvelopeV1, ContextRepresentationV1 } from '../../src/application/context-intake-v1.js';
import type { ContextStructuredPayloadV1, ContextStructuredSourceTypeV1 } from '../../src/application/context-structured-payload-v1.js';

export const CONTEXT_PROVIDER_CONFORMANCE_IDENTITY_V1 = Object.freeze({
  kind: 'source', adapter_id: 'synthetic-provider-conformance', instance_id: 'fixture', version: '1',
} as const) satisfies SourceAdapterIdentityV1;

export const CONTEXT_PROVIDER_CONFORMANCE_SCOPE_V1 = Object.freeze({
  organization_id: 'org_project_test', custody_ref: 'organization:org_project_test',
  access_policy_ref: 'context-provider-conformance-fixture', analysis_policy: 'on_request',
} as const);

type ConformanceSourceTypeV1 = ContextStructuredSourceTypeV1;
export type ContextProviderConformancePayloadV1 = {
  [Type in ConformanceSourceTypeV1]: {
    readonly external_id: string;
    readonly revision_id: string;
    readonly previous_revision_id?: string;
    /** Poll time only. It changes on an otherwise identical replay. */
    readonly captured_at: string;
    /** Provider semantic update time, omitted when the provider does not expose it. */
    readonly source_updated_at?: string;
    readonly source_type: Type;
    readonly label: string;
    readonly origin_ref: string;
    readonly payload: Extract<ContextStructuredPayloadV1, { readonly kind: Type }>;
    readonly representation: ContextRepresentationV1;
  };
}[ConformanceSourceTypeV1];

function excerpt(text: string, anchor: string): ContextRepresentationV1 {
  return { kind: 'excerpt', passages: [{ id: 'body-1', source_anchor: anchor, start: 0, end: text.length, text }] };
}

function snapshot(text: string, anchor: string): ContextRepresentationV1 {
  return { kind: 'full_snapshot', text, passages: [{ id: 'body-1', source_anchor: anchor, start: 0, end: text.length, text }] };
}

function pointer(pointerRef: string): ContextRepresentationV1 {
  return { kind: 'pointer', pointer: pointerRef };
}

/** Every V1 source type with opaque provider facts and no credentials. Ticket stays first for temporal proofs. */
export function contextProviderConformancePayloadsV1(): readonly ContextProviderConformancePayloadV1[] {
  return [
    {
      external_id: 'ticket:CON-17', revision_id: 'ticket:CON-17:r1', captured_at: '2026-10-01T12:00:00.000Z', source_updated_at: '2026-10-01T11:30:00.000Z',
      source_type: 'ticket', label: 'Conformance ticket', origin_ref: 'synthetic-provider://tickets/CON-17',
      payload: { schema_version: 1, kind: 'ticket', key: 'CON-17', status: 'open', priority: 'high', assignee_ref: 'provider-user:ada', due_at: '2026-10-03T17:00:00.000Z', labels: ['ingestion', 'fixture'] },
      representation: excerpt('Ticket body stays bounded source evidence.', 'ticket:CON-17:description'),
    },
    {
      external_id: 'document:brief-1', revision_id: 'document:brief-1:r1', captured_at: '2026-10-01T12:00:00.000Z',
      source_type: 'document', label: 'Conformance document', origin_ref: 'synthetic-provider://documents/brief-1',
      payload: { schema_version: 1, kind: 'document', media_type: 'text/markdown', language: 'en' },
      representation: snapshot('Document body stays bounded source evidence.', 'document:brief-1:body'),
    },
    {
      external_id: 'note:private-4', revision_id: 'note:private-4:r1', captured_at: '2026-10-01T12:00:00.000Z',
      source_type: 'note', label: 'Conformance note', origin_ref: 'synthetic-provider://notes/private-4',
      payload: { schema_version: 1, kind: 'note', format: 'markdown' }, representation: pointer('synthetic-provider://notes/private-4'),
    },
    {
      external_id: 'message:834', revision_id: 'message:834:r1', captured_at: '2026-10-01T12:00:00.000Z', source_updated_at: '2026-10-01T11:52:00.000Z',
      source_type: 'message', label: 'Conformance message', origin_ref: 'synthetic-provider://messages/834',
      payload: { schema_version: 1, kind: 'message', channel_ref: 'provider-channel:eng', sent_at: '2026-10-01T11:51:00.000Z', thread_ref: 'provider-thread:3', author_ref: 'provider-user:ada' },
      representation: snapshot('Message body stays bounded source evidence.', 'message:834:body'),
    },
    {
      external_id: 'task:42', revision_id: 'task:42:r1', captured_at: '2026-10-01T12:00:00.000Z', source_updated_at: '2026-10-01T11:45:00.000Z',
      source_type: 'task', label: 'Conformance task', origin_ref: 'synthetic-provider://tasks/42',
      payload: { schema_version: 1, kind: 'task', status: 'in_progress', due_at: '2026-10-04T17:00:00.000Z', assignee_ref: 'provider-user:bea' },
      representation: excerpt('Task body stays bounded source evidence.', 'task:42:description'),
    },
    {
      external_id: 'activity:99', revision_id: 'activity:99:r1', captured_at: '2026-10-01T12:00:00.000Z',
      source_type: 'activity', label: 'Conformance activity', origin_ref: 'synthetic-provider://activities/99',
      payload: { schema_version: 1, kind: 'activity', action: 'commented', occurred_at: '2026-10-01T11:50:00.000Z', subject_ref: 'ticket:CON-17', actor_ref: 'provider-user:cy' },
      representation: excerpt('Activity body stays bounded source evidence.', 'activity:99:body'),
    },
    {
      external_id: 'meeting:planning-7', revision_id: 'meeting:planning-7:r1', captured_at: '2026-10-01T12:00:00.000Z', source_updated_at: '2026-10-01T11:55:00.000Z',
      source_type: 'meeting', label: 'Conformance meeting', origin_ref: 'synthetic-provider://meetings/planning-7',
      payload: { schema_version: 1, kind: 'meeting', started_at: '2026-10-01T10:00:00.000Z', ended_at: '2026-10-01T11:00:00.000Z', participant_refs: ['provider-user:ada', 'provider-user:bea'] },
      representation: excerpt('Meeting body stays bounded source evidence.', 'meeting:planning-7:notes'),
    },
    {
      external_id: 'decision:12', revision_id: 'decision:12:r1', captured_at: '2026-10-01T12:00:00.000Z',
      source_type: 'decision', label: 'Conformance decision', origin_ref: 'synthetic-provider://decisions/12',
      payload: { schema_version: 1, kind: 'decision', status: 'approved', decided_at: '2026-10-01T11:40:00.000Z', decider_refs: ['provider-user:ada'] },
      representation: excerpt('Decision body stays bounded source evidence.', 'decision:12:body'),
    },
  ];
}

/** Provider mappers produce source envelopes only; Authority binds retention separately. */
export function mapContextProviderConformancePayloadV1(
  input: ContextProviderConformancePayloadV1,
  identity: SourceAdapterIdentityV1 = CONTEXT_PROVIDER_CONFORMANCE_IDENTITY_V1,
): ContextCaptureEnvelopeV1 {
  const sourceId = sourceItemIdV1(identity, input.external_id);
  const content: ContextCaptureContentV1 = {
    schema_version: 1, kind: 'echo-context-capture-v1', source_type: input.source_type, truth_status: 'source_observation',
    label: input.label, provenance: { origin_ref: input.origin_ref, ...(input.source_updated_at === undefined ? {} : { source_updated_at: input.source_updated_at }) },
    payload: input.payload, representation: input.representation, observations: [],
  };
  return {
    item: { schema_version: 1, source_id: sourceId, adapter: identity, external_id: input.external_id },
    revision: {
      schema_version: 1, source_id: sourceId, revision_id: input.revision_id, captured_at: input.captured_at,
      content_sha256: sourceContentSha256V1(content), artifact_refs: [], representation_refs: [],
      ...(input.previous_revision_id === undefined ? {} : { previous_revision_id: input.previous_revision_id }),
    },
    content,
  };
}

export type ContextProviderConformanceMapperV1<TRaw> = (raw: TRaw, identity: SourceAdapterIdentityV1) => ContextCaptureEnvelopeV1;

/**
 * Reusable adapter harness. A provider supplies raw values and an envelope mapper;
 * the default mapper preserves the synthetic payload fixture for simple suites.
 */
export class ContextProviderConformanceAdapterV1<TRaw = ContextProviderConformancePayloadV1> implements SourceAdapterV1<ContextCaptureContentV1> {
  readonly identity: SourceAdapterIdentityV1;

  constructor(
    private readonly rawValues: readonly TRaw[],
    private readonly mapRaw: ContextProviderConformanceMapperV1<TRaw> = mapContextProviderConformancePayloadV1 as unknown as ContextProviderConformanceMapperV1<TRaw>,
    identity: SourceAdapterIdentityV1 = CONTEXT_PROVIDER_CONFORMANCE_IDENTITY_V1,
  ) {
    this.identity = identity;
  }

  validateConfig(_config: AdapterConfig): AdapterConfigValidation {
    return { ok: true, errors: [] };
  }

  async healthCheck(context?: AdapterOperationContext): Promise<AdapterHealth> {
    context?.signal.throwIfAborted();
    return { status: 'healthy', checked_at: '2026-10-01T12:00:00.000Z' };
  }

  async pull(request: SourcePullRequestV1, context?: AdapterOperationContext): Promise<SourceBatchV1<ContextCaptureContentV1>> {
    context?.signal.throwIfAborted();
    const limit = request.limit ?? this.rawValues.length;
    return { sources: this.rawValues.slice(0, limit).map(raw => this.mapRaw(raw, this.identity)) };
  }
}

/** A document-only fallback when a provider exposes no native revision token. */
export interface ContextProviderDocumentFallbackV1 {
  readonly external_id: string;
  readonly captured_at: string;
  readonly label: string;
  readonly origin_ref: string;
  readonly text: string;
}

export function mapContextProviderDocumentFallbackV1(
  input: ContextProviderDocumentFallbackV1,
  identity: SourceAdapterIdentityV1 = CONTEXT_PROVIDER_CONFORMANCE_IDENTITY_V1,
): ContextCaptureEnvelopeV1 {
  const sourceId = sourceItemIdV1(identity, input.external_id);
  const representation = snapshot(input.text, 'document:fallback:body');
  const content: ContextCaptureContentV1 = {
    schema_version: 1, kind: 'echo-context-capture-v1', source_type: 'document', truth_status: 'source_observation',
    label: input.label, provenance: { origin_ref: input.origin_ref },
    payload: { schema_version: 1, kind: 'document', media_type: 'text/plain' }, representation, observations: [],
  };
  return {
    item: { schema_version: 1, source_id: sourceId, adapter: identity, external_id: input.external_id },
    revision: {
      schema_version: 1, source_id: sourceId, revision_id: `sha256:${sourceContentSha256V1(content)}`,
      captured_at: input.captured_at, content_sha256: sourceContentSha256V1(content), artifact_refs: [], representation_refs: [],
    },
    content,
  };
}
