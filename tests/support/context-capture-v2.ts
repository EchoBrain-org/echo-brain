import {
  buildContextCaptureEnvelopeV2, captureRevisionRefV1, sourceContentSha256V1,
  type CaptureBindingsV1, type CaptureClassificationV1, type ContextCaptureContentV2,
} from '@echo-brain/organization-processing/core';

export const CAPTURE_IDENTITY = { kind: 'source', adapter_id: 'fixture', instance_id: 'fixture', version: '1' } as const;
export const CAPTURE_PROJECT = 'prj_11111111-1111-4111-8111-111111111111';
export const CAPTURE_TIME = '2026-10-03T00:00:00.000Z';
export const CAPTURE_TEXT = 'Alex completed the handoff.';
export const CAPTURE_SPAN = { passage_id: 'p1', start: 0, end: CAPTURE_TEXT.length, quote: CAPTURE_TEXT } as const;
export function captureContent(): ContextCaptureContentV2 {
  return { schema_version: 2, kind: 'echo-context-capture-v2', lifecycle: 'present', label: 'Handoff', provenance: { origin_ref: 'fixture://handoff' },
    payload: { schema_version: 1, kind: 'message', channel_ref: 'channel:fixture', sent_at: CAPTURE_TIME, author_ref: 'actor:alex' },
    representation: { kind: 'full_snapshot', text: CAPTURE_TEXT, passages: [{ id: 'p1', source_anchor: 'message:1', start: 0, end: CAPTURE_TEXT.length, text: CAPTURE_TEXT }] },
    actors: [{ source_actor_ref: 'actor:alex', role: 'mentioned', evidence: { passage_id: 'p1', start: 0, end: 4, quote: 'Alex' } }],
    actions: [{ id: 'a1', kind: 'completed', evidence: CAPTURE_SPAN, source_actor_ref: 'actor:alex' }] };
}
export function captureSource(options: { content?: ContextCaptureContentV2; external_id?: string; captured_at?: string; previous_revision_id?: string } = {}) {
  return buildContextCaptureEnvelopeV2({ identity: CAPTURE_IDENTITY, external_id: options.external_id ?? 'handoff', captured_at: options.captured_at ?? CAPTURE_TIME,
    content: options.content ?? captureContent(), ...(options.previous_revision_id === undefined ? {} : { previous_revision_id: options.previous_revision_id }) });
}
export function captureClassification(source = captureSource()): CaptureClassificationV1 {
  return { schema_version: 1, input: captureRevisionRefV1(source), producer: { id: 'fixture-rule', version: '1', config_sha256: sourceContentSha256V1({ retain: 'handoff' }) },
    decision: 'retain', reason: source.content.lifecycle === 'deleted' ? 'source_deleted' : 'useful' };
}
export function captureBindings(): CaptureBindingsV1 {
  return { scope: { organization_id: 'org_project_test', custody_ref: 'organization:org_project_test', access_policy_ref: 'fixture', analysis_policy: 'on_request' },
    project_id: CAPTURE_PROJECT, people: [{ source_actor_ref: 'actor:alex', principal_id: 'prn_member', membership_id: 'mem_22222222-2222-4222-8222-222222222222', identity_link_ref: 'verified:fixture:alex' }] };
}
