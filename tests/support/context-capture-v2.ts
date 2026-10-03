import {
  buildContextCaptureEnvelopeV2, captureRevisionRefV1, captureSourceRefV1, sourceContentSha256V1,
  type CaptureBindingsV1, type CaptureClassificationV1, type CaptureContainerScopeV1, type ContextCaptureContentV2, type ContextCaptureEnvelopeV2, type SourceAdapterIdentityV1,
} from '@echo-brain/organization-processing/core';

export const CAPTURE_IDENTITY = { kind: 'source', adapter_id: 'fixture', instance_id: 'fixture', version: '1' } as const;
export const CAPTURE_PROJECT = 'prj_11111111-1111-4111-8111-111111111111';
export const CAPTURE_CONTAINER = captureSourceRefV1({ tool: 'fixture', tenant: 'workspace', kind: 'container', id: 'channel' });
export const CAPTURE_ACTOR = captureSourceRefV1({ tool: 'fixture', tenant: 'workspace', kind: 'actor', id: 'alex' });
export const CAPTURE_TIME = '2026-10-03T00:00:00.000Z';
export const CAPTURE_TEXT = 'Alex completed the handoff.';
export const CAPTURE_SPAN = { passage_id: 'p1', start: 0, end: CAPTURE_TEXT.length, quote: CAPTURE_TEXT } as const;
export function captureContent(): ContextCaptureContentV2 {
  return { schema_version: 2, kind: 'echo-context-capture-v2', lifecycle: 'present', label: 'Handoff', provenance: { origin_ref: 'fixture://handoff', container_ref: CAPTURE_CONTAINER },
    payload: { schema_version: 1, kind: 'message', channel_ref: CAPTURE_CONTAINER, sent_at: CAPTURE_TIME, author_ref: CAPTURE_ACTOR },
    representation: { kind: 'full_snapshot', text: CAPTURE_TEXT, passages: [{ id: 'p1', source_anchor: 'message:1', start: 0, end: CAPTURE_TEXT.length, text: CAPTURE_TEXT }] },
    actors: [{ source_actor_ref: CAPTURE_ACTOR, role: 'mentioned', evidence: { passage_id: 'p1', start: 0, end: 4, quote: 'Alex' } }],
    actions: [{ id: 'a1', kind: 'completed', evidence: CAPTURE_SPAN, source_actor_ref: CAPTURE_ACTOR }] };
}
export function captureSource(options: { content?: ContextCaptureContentV2; external_id?: string; captured_at?: string; previous?: ContextCaptureEnvelopeV2; identity?: SourceAdapterIdentityV1 } = {}) {
  return buildContextCaptureEnvelopeV2({ identity: options.identity ?? CAPTURE_IDENTITY, external_id: options.external_id ?? 'handoff', captured_at: options.captured_at ?? CAPTURE_TIME,
    content: options.content ?? captureContent(), ...(options.previous === undefined ? {} : { previous: options.previous }) });
}
export function captureClassification(source = captureSource()): CaptureClassificationV1 {
  return { schema_version: 1, method: 'local_rules', input: captureRevisionRefV1(source), producer: { id: 'fixture-rule', version: '1', config_sha256: sourceContentSha256V1({ retain: 'handoff' }) },
    decision: 'retain', reason: source.content.lifecycle === 'deleted' ? 'source_deleted' : 'useful' };
}
export function captureBindings(): CaptureBindingsV1 {
  return { scope: { organization_id: 'org_project_test', custody_ref: 'organization:org_project_test', access_policy_ref: 'fixture', analysis_policy: 'on_request' },
    project_id: CAPTURE_PROJECT, container_ref: CAPTURE_CONTAINER, people: [{ source_actor_ref: CAPTURE_ACTOR, principal_id: 'prn_member', membership_id: 'mem_22222222-2222-4222-8222-222222222222', identity_link_ref: 'verified:fixture:alex' }] };
}

export function captureContainerScope(project_id = CAPTURE_PROJECT): CaptureContainerScopeV1 {
  return { schema_version: 1, organization_id: 'org_project_test', mappings: [{ container_ref: CAPTURE_CONTAINER, project_id,
    adapter: { adapter_id: CAPTURE_IDENTITY.adapter_id, instance_id: CAPTURE_IDENTITY.instance_id } }] };
}
