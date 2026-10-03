import {
  captureSourceRefV1, CAPTURE_DEFAULT_CLASSIFIER_V1,
  type AdapterOperationContext, type CaptureProviderFactoryV2, type CaptureSourceBatchV2, type CaptureSourceConfigV1,
  type CaptureSourceItemV2, type CaptureSourcePullRequestV2, type ContextCaptureContentV2, type SourceAdapterIdentityV1,
  type SourceArtifactReferenceV1,
} from '@echo-brain/organization-processing/core';

/** A vendor-free provider for exercising the capture core. It emits V2 content only. */
export const FAKE_SOURCE_ID = 'src_fake_workspace';
export const FAKE_IDENTITY: SourceAdapterIdentityV1 = Object.freeze({ kind: 'source', adapter_id: 'fake-tool', instance_id: 'fake-workspace', version: '1' });
export const FAKE_ORGANIZATION = 'org_project_test';
export const FAKE_PROJECTS = Object.freeze({
  alpha: 'prj_11111111-1111-4111-8111-111111111111', beta: 'prj_22222222-2222-4222-8222-222222222222',
});
function ref(kind: string, id: string): string { return captureSourceRefV1({ tool: 'fake', tenant: 'workspace', kind, id }); }
export const FAKE_CONTAINERS = Object.freeze({ alpha: ref('container', 'alpha'), beta: ref('container', 'beta'), unmapped: ref('container', 'gamma') });
export const FAKE_ACTOR = ref('actor', 'sam');
export const FAKE_TIMES = Object.freeze({
  first: '2026-10-03T00:00:00.000Z', second: '2026-10-03T01:00:00.000Z', third: '2026-10-03T02:00:00.000Z',
});
export const FAKE_CURSORS = Object.freeze({ first: 'fake-cursor-1', second: 'fake-cursor-2' });

export function fakeCaptureSourceConfig(changes: Partial<CaptureSourceConfigV1> = {}, organization_id = FAKE_ORGANIZATION): CaptureSourceConfigV1 {
  const adapter = { adapter_id: FAKE_IDENTITY.adapter_id, instance_id: FAKE_IDENTITY.instance_id };
  return {
    schema_version: 1, source_id: FAKE_SOURCE_ID, adapter: { ...FAKE_IDENTITY },
    scope: { organization_id, custody_ref: `organization:${organization_id}`, access_policy_ref: 'fake-source-policy', analysis_policy: 'on_request' },
    containers: { schema_version: 1, organization_id, mappings: [
      { container_ref: FAKE_CONTAINERS.alpha, project_id: FAKE_PROJECTS.alpha, adapter },
      { container_ref: FAKE_CONTAINERS.beta, project_id: FAKE_PROJECTS.beta, adapter },
    ] },
    disposition: 'retained', representations: ['pointer', 'excerpt', 'full_snapshot'],
    classifier: { id: CAPTURE_DEFAULT_CLASSIFIER_V1.id, version: CAPTURE_DEFAULT_CLASSIFIER_V1.version },
    ...changes,
  };
}

type Present = Extract<ContextCaptureContentV2, { lifecycle: 'present' }>;
function present(input: Pick<Present, 'label' | 'payload' | 'representation'> & { readonly id: string; readonly container: string; readonly updated?: string } &
  Partial<Pick<Present, 'actors' | 'actions'>>): ContextCaptureContentV2 {
  return { schema_version: 2, kind: 'echo-context-capture-v2', lifecycle: 'present', label: input.label,
    provenance: { origin_ref: `fake://items/${input.id}`, container_ref: input.container, source_updated_at: input.updated ?? FAKE_TIMES.first },
    payload: input.payload, representation: input.representation, actors: input.actors ?? [], actions: input.actions ?? [] };
}
function snapshot(text: string) {
  return { kind: 'full_snapshot', text, passages: [{ id: 'p1', source_anchor: 'body', start: 0, end: text.length, text }] } as const;
}
const MEETING_TEXT = 'Sam: the importer ships Friday.';
const DOCUMENT_TEXT = 'Rollout plan: import, verify, announce.';

/** Content for each payload kind, across two containers. */
export const FAKE_CONTENT = Object.freeze({
  ticket(status = 'open', updated: string = FAKE_TIMES.first): ContextCaptureContentV2 {
    return present({ id: 'ticket-1', container: FAKE_CONTAINERS.alpha, label: 'Import ticket', updated,
      payload: { schema_version: 1, kind: 'ticket', key: 'ITEM-1', status, labels: ['capture'], assignee_ref: FAKE_ACTOR },
      representation: { kind: 'pointer', pointer: 'fake://items/ticket-1' },
      actions: [{ id: 'status', kind: 'status_observed', evidence: { kind: 'payload_field', field: 'ticket.status' } }] });
  },
  message(container = FAKE_CONTAINERS.alpha): ContextCaptureContentV2 {
    return present({ id: 'message-1', container, label: 'Importer update',
      payload: { schema_version: 1, kind: 'message', channel_ref: container, sent_at: FAKE_TIMES.first, author_ref: FAKE_ACTOR },
      representation: snapshot('Sam shipped the importer.'),
      actors: [{ source_actor_ref: FAKE_ACTOR, role: 'mentioned', evidence: { passage_id: 'p1', start: 0, end: 3, quote: 'Sam' } }] });
  },
  meeting(): ContextCaptureContentV2 {
    return present({ id: 'meeting-1', container: FAKE_CONTAINERS.beta, label: 'Import sync',
      payload: { schema_version: 1, kind: 'meeting', started_at: FAKE_TIMES.first, ended_at: FAKE_TIMES.second, participant_refs: [FAKE_ACTOR] },
      representation: { kind: 'excerpt', passages: [{ id: 'p1', source_anchor: 'segment:1', start: 0, end: MEETING_TEXT.length, text: MEETING_TEXT }] },
      actors: [{ source_actor_ref: FAKE_ACTOR, role: 'speaker', attribution: { source_anchor: 'segments[0].speaker', passage_ids: ['p1'] } }] });
  },
  note(): ContextCaptureContentV2 {
    return present({ id: 'note-1', container: FAKE_CONTAINERS.beta, label: 'Import notes',
      payload: { schema_version: 1, kind: 'note', format: 'markdown' }, representation: snapshot('Check row counts after import.') });
  },
  document(original_artifact?: SourceArtifactReferenceV1): ContextCaptureContentV2 {
    return present({ id: 'document-1', container: FAKE_CONTAINERS.beta, label: 'Rollout plan',
      payload: { schema_version: 2, kind: 'document', media_type: 'text/html', filename: 'rollout.html', path: '/Plans/rollout.html',
        ...(original_artifact === undefined ? {} : { original_artifact }) },
      representation: { kind: 'excerpt', passages: [{ id: 'p1', source_anchor: 'section:1', start: 0, end: DOCUMENT_TEXT.length, text: DOCUMENT_TEXT }] } });
  },
  /** An explicit upstream deletion, never inferred from a missing poll result. */
  tombstone(id: string, container: string, updated: string = FAKE_TIMES.second): ContextCaptureContentV2 {
    return { schema_version: 2, kind: 'echo-context-capture-v2', lifecycle: 'deleted', label: 'Deleted item',
      provenance: { origin_ref: `fake://items/${id}`, container_ref: container, source_updated_at: updated }, deletion: 'explicit_upstream_tombstone' };
  },
});

/** Ticket, message, meeting, note and document across two containers. */
export function fakeInitialItems(captured_at: string = FAKE_TIMES.first): CaptureSourceItemV2[] {
  return [
    { external_id: 'ticket-1', captured_at, content: FAKE_CONTENT.ticket() },
    { external_id: 'message-1', captured_at, content: FAKE_CONTENT.message() },
    { external_id: 'meeting-1', captured_at, content: FAKE_CONTENT.meeting() },
    { external_id: 'note-1', captured_at, content: FAKE_CONTENT.note() },
    { external_id: 'document-1', captured_at, content: FAKE_CONTENT.document() },
  ];
}
/** A changed revision, an unchanged repoll and an explicit tombstone. */
export function fakeFollowUpItems(captured_at: string = FAKE_TIMES.second): CaptureSourceItemV2[] {
  return [
    { external_id: 'ticket-1', captured_at, content: FAKE_CONTENT.ticket('done', FAKE_TIMES.second) },
    { external_id: 'message-1', captured_at, content: FAKE_CONTENT.message() },
    { external_id: 'note-1', captured_at, content: FAKE_CONTENT.tombstone('note-1', FAKE_CONTAINERS.beta) },
  ];
}
/** The default upstream: the initial page, then follow-ups, then nothing new. */
export function fakeScenarioPage(request: CaptureSourcePullRequestV2): CaptureSourceBatchV2 {
  if (request.cursor === undefined) return { items: fakeInitialItems(), next_cursor: FAKE_CURSORS.first };
  if (request.cursor === FAKE_CURSORS.first) return { items: fakeFollowUpItems(), next_cursor: FAKE_CURSORS.second };
  return { items: [], next_cursor: FAKE_CURSORS.second };
}

export interface FakeCaptureProviderV2 {
  readonly factory: CaptureProviderFactoryV2;
  readonly requests: CaptureSourcePullRequestV2[];
  /** Read through a getter on every check, so a test can change it during a run. */
  identity: SourceAdapterIdentityV1;
  grant: boolean;
  grant_checks: number;
  /** Optional extra work inside each read-grant check, such as waiting on the caller's signal. */
  on_grant_check?: (context?: AdapterOperationContext) => void | Promise<void>;
  respond: (request: CaptureSourcePullRequestV2, context?: AdapterOperationContext) => CaptureSourceBatchV2 | Promise<CaptureSourceBatchV2>;
}
export function createFakeCaptureProviderV2(): FakeCaptureProviderV2 {
  const fake: FakeCaptureProviderV2 = {
    requests: [], identity: FAKE_IDENTITY, grant: true, grant_checks: 0, respond: fakeScenarioPage,
    factory: () => ({
      source: {
        get identity() { return fake.identity; },
        async pull(request, context) { fake.requests.push(request); return fake.respond(request, context); },
      },
      async require_read_current(context) {
        fake.grant_checks += 1;
        await fake.on_grant_check?.(context);
        context?.signal.throwIfAborted();
        if (!fake.grant) throw new Error('Fake read grant was revoked');
      },
    }),
  };
  return fake;
}
