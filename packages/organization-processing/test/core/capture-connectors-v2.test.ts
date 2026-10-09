import { describe, expect, it } from 'vitest';
import {
  assertCaptureBindingsV1, assertCaptureContainerScopeV1, assertContextCaptureEnvelopeV2,
  captureLocalActorRefV1, captureSourceRefV1, resolveCaptureContainerV1, sourceItemIdV1,
  type ContextCaptureContentV2, type ContextStructuredPayloadV2, type SourceArtifactReferenceV1,
} from '../../src/core/index.js';
import {
  CAPTURE_ACTOR, CAPTURE_CONTAINER, CAPTURE_IDENTITY, CAPTURE_PROJECT, CAPTURE_TIME,
  captureBindings, captureContainerScope, captureContent, captureSource,
} from '../../../../tests/support/context-capture-v2.js';

function present(): Extract<ContextCaptureContentV2, { lifecycle: 'present' }> {
  const content = captureContent();
  if (content.lifecycle !== 'present') throw new Error('Expected present fixture');
  return content;
}
function document(media_type = 'application/pdf', original_artifact?: SourceArtifactReferenceV1): ContextCaptureContentV2 {
  return { ...present(), provenance: { origin_ref: 'fixture://requirements', container_ref: CAPTURE_CONTAINER, upstream_version: 'etag:revision-12' },
    payload: { schema_version: 2, kind: 'document', media_type, filename: 'requirements.pdf', path: '/Product/Requirements',
      ...(original_artifact === undefined ? {} : { original_artifact }) }, actors: [], actions: [] };
}
const artifact: SourceArtifactReferenceV1 = { artifact_id: 'artifact:original', media_type: 'application/pdf', sha256: 'a'.repeat(64), byte_length: 4096 };

describe('future connector capture contracts', () => {
  it.each(['application/pdf', 'text/html', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'])('preserves document metadata for %s', mediaType => {
    const original = { ...artifact, media_type: mediaType };
    const source = captureSource({ content: document(mediaType, original) });
    expect(source.content).toMatchObject({
      provenance: { container_ref: CAPTURE_CONTAINER, upstream_version: 'etag:revision-12' },
      payload: { schema_version: 2, kind: 'document', media_type: mediaType, filename: 'requirements.pdf', path: '/Product/Requirements', original_artifact: original },
    });
    expect(source.revision.artifact_refs).toEqual([original]);
    expect(() => assertContextCaptureEnvelopeV2(source, CAPTURE_IDENTITY)).not.toThrow();
  });
  it('allows remote documents without inventing an original artifact', () => {
    const source = captureSource({ content: document('text/html') });
    expect(source.revision.artifact_refs).toEqual([]);
    expect(source.content).toMatchObject({ payload: { kind: 'document', media_type: 'text/html' } });
  });
  it('requires the original descriptor to exactly match the source manifest', () => {
    const source = captureSource({ content: document('application/pdf', artifact) });
    for (const artifact_refs of [[], [{ ...artifact, sha256: 'b'.repeat(64) }], [{ ...artifact, byte_length: 4097 }], [{ ...artifact, artifact_id: 'artifact:other' }]]) {
      expect(() => assertContextCaptureEnvelopeV2({ ...source, revision: { ...source.revision, artifact_refs } }, CAPTURE_IDENTITY)).toThrow(/descriptor/);
    }
    expect(() => captureSource({ content: document('text/html', artifact) })).toThrow(/media type/);
  });
  it.each(['\u0000'.repeat(3000), 'a'.repeat(2049)])('rejects artifact IDs that cannot safely round-trip through custody: %j', artifact_id => {
    expect(() => captureSource({ content: document('application/pdf', { ...artifact, artifact_id }) })).toThrow();
  });
  it.each([
    { schema_version: 1 }, { media_type: 'PDF' }, { media_type: 'application/pdf; inline=true' },
    { body_bytes: 'private original bytes' }, { path: 'bad\npath' }, { original_artifact: { ...artifact, body_bytes: 'inline original' } },
    { original_artifact: { ...artifact, sha256: 'not-a-digest' } }, { original_artifact: { ...artifact, byte_length: -1 } },
  ])('rejects invalid document descriptors or inline original bytes: %j', change => {
    const content = document();
    if (content.lifecycle !== 'present') throw new Error('Expected document fixture');
    expect(() => captureSource({ content: { ...content, payload: { ...content.payload, ...change } as ContextStructuredPayloadV2 } })).toThrow();
  });

  const otherTenantActor = captureSourceRefV1({ tool: 'fixture', tenant: 'other-workspace', kind: 'actor', id: 'alex' });
  it.each<ContextStructuredPayloadV2>([
    { schema_version: 1, kind: 'message', channel_ref: CAPTURE_CONTAINER, sent_at: CAPTURE_TIME, author_ref: otherTenantActor },
    { schema_version: 1, kind: 'ticket', key: 'ITEM-1', status: 'open', labels: [], assignee_ref: otherTenantActor },
    { schema_version: 1, kind: 'meeting', started_at: CAPTURE_TIME, participant_refs: [otherTenantActor] },
  ])('preserves foreign-tenant actor metadata in $kind without granting Person identity', payload => {
    expect(() => captureSource({ content: { ...present(), payload, actors: [], actions: [] } })).not.toThrow();
  });
  it('allows foreign-tenant actors but rejects actors from another tool and foreign threads', () => {
    const content = present();
    expect(() => captureSource({ content: { ...content, actors: [{ ...content.actors[0]!, source_actor_ref: otherTenantActor }], actions: [] } })).not.toThrow();
    const foreignToolActor = captureSourceRefV1({ tool: 'other-tool', tenant: 'workspace', kind: 'actor', id: 'alex' });
    expect(() => captureSource({ content: { ...content, actors: [{ ...content.actors[0]!, source_actor_ref: foreignToolActor }], actions: [] } })).toThrow(/namespace/);
    const thread_ref = captureSourceRefV1({ tool: 'fixture', tenant: 'other-workspace', kind: 'message', id: 'thread-1' });
    expect(() => captureSource({ content: { ...content, payload: { schema_version: 1, kind: 'message', channel_ref: CAPTURE_CONTAINER, sent_at: CAPTURE_TIME, thread_ref } } })).toThrow(/namespace/);
  });
  it('retains source-local speakers without promoting them to verified Person bindings', () => {
    const actor = captureLocalActorRefV1({ tool: 'fixture', tenant: 'workspace', source_id: sourceItemIdV1(CAPTURE_IDENTITY, 'meeting-1'), local_id: 'speaker-1' });
    const source = captureSource({ external_id: 'meeting-1', content: { ...present(),
      payload: { schema_version: 1, kind: 'meeting', started_at: CAPTURE_TIME, participant_refs: [actor] },
      actors: [{ source_actor_ref: actor, role: 'speaker', attribution: { source_anchor: 'segments[0].speaker', passage_ids: ['p1'] } }], actions: [] } });
    expect(() => assertCaptureBindingsV1({ ...captureBindings(), people: [] }, source)).not.toThrow();
    expect(() => assertCaptureBindingsV1({ ...captureBindings(), people: [{ ...captureBindings().people[0]!, source_actor_ref: actor }] }, source)).toThrow(/source actor/);
    expect(() => assertCaptureBindingsV1(captureBindings(), captureSource())).not.toThrow();
  });
  it.each([{ external_id: 'meeting-a' }, { external_id: 'meeting-b', identity: { ...CAPTURE_IDENTITY, instance_id: 'other' } }])('rejects a local actor copied from another exact source: %j', change => {
    const actor = captureLocalActorRefV1({ tool: 'fixture', tenant: 'workspace', source_id: sourceItemIdV1(CAPTURE_IDENTITY, 'meeting-b'), local_id: 'speaker-1' });
    expect(() => captureSource({ ...change, content: { ...present(),
      payload: { schema_version: 1, kind: 'meeting', started_at: CAPTURE_TIME, participant_refs: [actor] }, actors: [], actions: [] } })).toThrow(/source/);
  });
  it.each([{ adapter_id: 'unrelated' }, { instance_id: 'unrelated' }])('rejects an adapter outside the configured container mapping: %j', change => {
    const source = captureSource({ identity: { ...CAPTURE_IDENTITY, ...change } });
    expect(() => resolveCaptureContainerV1(captureContainerScope(), source)).toThrow(/adapter/);
  });

  it('maps mixed kinds and multiple exact containers from one adapter into one ECHO project', () => {
    const secondContainer = captureSourceRefV1({ tool: 'fixture', tenant: 'workspace', kind: 'container', id: 'documents' });
    const scope = { ...captureContainerScope(), mappings: [...captureContainerScope().mappings, { ...captureContainerScope().mappings[0]!, container_ref: secondContainer }] };
    const payloads: ContextStructuredPayloadV2[] = [
      { schema_version: 1, kind: 'message', channel_ref: CAPTURE_CONTAINER, sent_at: CAPTURE_TIME, author_ref: CAPTURE_ACTOR },
      { schema_version: 1, kind: 'ticket', key: 'ITEM-1', status: 'open', labels: [] },
      { schema_version: 1, kind: 'meeting', started_at: CAPTURE_TIME, participant_refs: [] },
      { schema_version: 1, kind: 'note', format: 'markdown' },
      { schema_version: 2, kind: 'document', media_type: 'text/html', path: '/Product/Requirements' },
    ];
    const sources = payloads.map((payload, index) => captureSource({ external_id: `item-${index}`, content: { ...present(), payload, actors: [], actions: [],
      provenance: { origin_ref: `fixture://item-${index}`, container_ref: index === 0 ? CAPTURE_CONTAINER : secondContainer } } }));
    for (const source of sources) {
      expect(source.item.adapter).toEqual(CAPTURE_IDENTITY);
      expect(resolveCaptureContainerV1(scope, source)).toEqual({ organization_id: scope.organization_id, project_id: CAPTURE_PROJECT, container_ref: source.content.provenance.container_ref });
    }
    expect(() => resolveCaptureContainerV1(captureContainerScope(), sources[1]!)).toThrow(/outside/);
    expect(() => assertCaptureBindingsV1({ ...captureBindings(), container_ref: secondContainer }, sources[0]!)).toThrow(/container/);
    for (const project_id of [CAPTURE_PROJECT, 'prj_22222222-2222-4222-8222-222222222222']) {
      expect(() => assertCaptureContainerScopeV1({ ...scope, mappings: [...scope.mappings, { ...captureContainerScope().mappings[0]!, project_id }] })).toThrow(/ambiguous/);
    }
  });

  it('keeps unchanged polls stable across observation time and adapter version changes', () => {
    const first = captureSource();
    const replay = captureSource({ previous: first, captured_at: '2026-10-03T01:00:00.000Z', identity: { ...CAPTURE_IDENTITY, version: '2' } });
    expect(replay.item.source_id).toBe(first.item.source_id);
    expect(replay.revision.revision_id).toBe(first.revision.revision_id);
    expect(replay.revision.previous_revision_id).toBeUndefined();
    expect(replay.item.adapter.version).toBe('2');
    expect(() => resolveCaptureContainerV1(captureContainerScope(), replay)).not.toThrow();
  });
  it('links changed content and content reversion without creating a new revision on repeat polls', () => {
    const a = captureSource();
    const b = captureSource({ previous: a, content: { ...present(), provenance: { ...a.content.provenance, upstream_version: 'revision-b' } } });
    const reverted = captureSource({ previous: b });
    expect(b.revision.previous_revision_id).toBe(a.revision.revision_id);
    expect(reverted.revision.previous_revision_id).toBe(b.revision.revision_id);
    expect(reverted.revision.content_sha256).toBe(a.revision.content_sha256);
    expect(reverted.revision.revision_id).not.toBe(a.revision.revision_id);
    const replay = captureSource({ previous: reverted, captured_at: '2026-10-03T02:00:00.000Z' });
    expect(replay.revision.revision_id).toBe(reverted.revision.revision_id);
    expect(replay.revision.previous_revision_id).toBe(b.revision.revision_id);
  });
  it('keeps repeated explicit tombstones stable and rejects predecessors from other sources', () => {
    const first = captureSource();
    const content: ContextCaptureContentV2 = { schema_version: 2, kind: 'echo-context-capture-v2', lifecycle: 'deleted', label: 'Deleted source',
      provenance: { ...first.content.provenance, source_updated_at: '2026-10-03T01:00:00.000Z' }, deletion: 'explicit_upstream_tombstone' };
    const deleted = captureSource({ previous: first, content });
    const replay = captureSource({ previous: deleted, content, captured_at: '2026-10-03T02:00:00.000Z' });
    expect(replay.revision.revision_id).toBe(deleted.revision.revision_id);
    expect(replay.revision.previous_revision_id).toBe(first.revision.revision_id);
    expect(() => captureSource({ previous: first, external_id: 'other-item' })).toThrow(/different source/);
    expect(() => captureSource({ previous: first, identity: { ...CAPTURE_IDENTITY, instance_id: 'other-instance' } })).toThrow(/different source/);
  });
});
