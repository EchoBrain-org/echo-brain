import { SqlitePersonOriginalContextRetrievalV1 } from '../src/adapters/persistence/sqlite/person-original-context-retrieval-v1.js';
import { SqlitePersonOriginalItemsV1 } from '../src/adapters/persistence/sqlite/person-original-items-v1.js';
import { createPersonListRouteV1 } from '../src/composition/person-list-v1-route.js';
import { SqlitePersonListDirectoryV1 } from '../src/adapters/persistence/sqlite/person-list-directory-v1.js';
import { describe, expect, it, vi } from 'vitest';
const refusal = vi.hoisted(() => ({ next: 0 }));
vi.mock('@echo-brain/organization-protocol/record-codec-support-v4', async (importOriginal) => {
  const original = await importOriginal<typeof import('@echo-brain/organization-protocol/record-codec-support-v4')>();
  return { ...original, validateApprovedDecisionSnapshotV2(value: unknown) {
    if (refusal.next > 0) { refusal.next--; throw new Error('snapshot refused by the record codec'); }
    return original.validateApprovedDecisionSnapshotV2(value);
  } };
});
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import type { PersonMeetingOperationV2, PersonMeetingResultsV2 } from '@echo-brain/organization-api';
import type { MeetingDocument } from '@echo-brain/organization-processing/core';
import { readGranolaCheckpointV1, writeGranolaCheckpointV1, GRANOLA_FOLDER_CURSOR_POLICY_V1 } from '@echo-brain/provider-granola/granola-folder-source-v1';
import { createPersonMeetingRuntimeV1, type PersonMeetingProviderV1 } from '../src/composition/person-meeting-runtime-v1.js';
import { SqlitePersonMeetingIntakeV1 } from '../src/adapters/persistence/sqlite/person-meeting-intake-v1.js';
import { approvalContextFixture } from './fixtures/approval-core.js';
import { validateApprovalDecisionRequestV1, type AfterApprovedRecordEventV1 } from '../src/composition/approval-core-v1.js';
import { authorization, addMembership } from './fixtures/project-context-sqlite.js';
import { meeting as original, decisions } from '../../../packages/organization-processing/test/admitted-meeting-processing/fixtures/sqlite-meeting-state.js';
const id = '00000000-0000-4000-8000-000000000001';
const folder = '00000000-0000-4000-8000-000000000002';
const project = 'prj_00000000-0000-4000-8000-000000000003';
const projectB = 'prj_00000000-0000-4000-8000-000000000013';
const foreignProject = 'prj_00000000-0000-4000-8000-000000000023';
/** `actions` adds that many unowned actions (act-2, act-3, …) to what the extractor finds. */
async function fixture(options: { readonly transcriptOnly?: boolean; readonly ownedAction?: boolean; readonly actions?: number; readonly started?: string } = {}) {
  const f = await approvalContextFixture();
  f.db.prepare('INSERT INTO authority_project_authorization_state_v1 VALUES (?,0,?)').run(f.actor.organization_id, new Date().toISOString());
  const person = { organization_id: f.actor.organization_id, principal_id: f.actor.principal_id, membership_id: f.actor.membership_id };
  const other = { ...person, principal_id: 'prn_00000000-0000-4000-8000-000000000011', membership_id: 'mem_00000000-0000-4000-8000-000000000012' };
  addMembership(f.db, { ...other, membership_type: 'employee' }, 'Other', 'other@example.test');
  // Project readers who never import anything: one for project A, one for project B.
  const readerA = { ...person, principal_id: 'prn_00000000-0000-4000-8000-000000000021', membership_id: 'mem_00000000-0000-4000-8000-000000000022' };
  const readerB = { ...person, principal_id: 'prn_00000000-0000-4000-8000-000000000031', membership_id: 'mem_00000000-0000-4000-8000-000000000032' };
  addMembership(f.db, { ...readerA, membership_type: 'employee' }, 'Reader A', 'reader-a@example.test');
  addMembership(f.db, { ...readerB, membership_type: 'employee' }, 'Reader B', 'reader-b@example.test');
  const actors = { owner: person, other, 'reader-a': readerA, 'reader-b': readerB } as const;
  let active = true, extracted = 0, duringPull: (() => void | Promise<void>) | undefined, duringExtract: (() => void | Promise<void>) | undefined, failExtraction = false;
  // Meetings the watched folder delivers on its next scans after the baseline.
  const folderDeliveries: string[] = [];
  const current = () => { if (!active) throw new Error('Disconnected'); };
  const sources: { readonly tool_id: string; readonly source_key: string }[] = [];
  const fakeProvider = (tool_id: string, adapter_id: string): PersonMeetingProviderV1 => ({
    id: tool_id, normalizer_version: '2.2.0', cursor: { read: readGranolaCheckpointV1, write: writeGranolaCheckpointV1,
      policy: adapter_id === GRANOLA_FOLDER_CURSOR_POLICY_V1.source_adapter_id ? GRANOLA_FOLDER_CURSOR_POLICY_V1 : { source_adapter_id: adapter_id, assert_live_cursor(cursor) { readGranolaCheckpointV1(cursor); } } },
    connection_http: { routes: [], async accept() { throw new Error('unused'); } },
    tool: () => ({ tool_id, display_name: tool_id, availability: 'enabled', personal_status: active ? 'linked' : 'revoked', external_scope_id: null, external_subject_id: null, organization_setup: null }),
    async open(actor, guard) {
      guard(); current();
      return { identity: { kind: 'meeting-source', adapter_id, instance_id: `${tool_id}-${canonicalSha256(actor).slice(7)}`, version: '1.0.0' },
        custodian: { actor }, email: 'fixture@example.test', workspace: 'Fixture', current() { guard(); current(); },
        async folders() { return [{ id: folder, title: 'ECHO', count: 0 }]; }, async browse() { return { meetings: [] }; },
        async preview(value) { return { id: value, title: 'Test meeting', notes: 'Ship pilot.', summary: '', truncated: false }; },
      };
    },
    source(setting, guard) {
      sources.push({ tool_id, source_key: setting.source_key });
      const identity = { kind: 'meeting-source' as const, adapter_id: setting.source_adapter_id, instance_id: setting.source_adapter_instance_id, version: setting.source_adapter_version };
      return { identity, validateConfig: () => ({ ok: true, errors: [] }), healthCheck: async () => ({ status: 'healthy', checked_at: new Date().toISOString() }),
        requireCurrent() { guard(); current(); },
        async pull(input) {
          guard(); current(); const cursor = readGranolaCheckpointV1(input.cursor!);
          const transcript = { id: 'private-transcript', kind: 'transcript' as const, text: 'TRANSCRIPT_SECRET_DO_NOT_SHARE' };
          // A real provider names the meeting by its source instance, so two tool accounts never share a meeting id.
          const build = (external: string): MeetingDocument => ({ ...original, id: `${identity.instance_id}:${external}`, content: options.transcriptOnly ? [transcript] : [...original.content, transcript], title: 'Test meeting', provenance: { ...original.provenance, source: identity, external_id: external, canonical_revision: canonicalSha256('meeting version') },
            ...(options.started === undefined ? {} : { time: { actual_start_at: options.started } }) });
          if (!cursor.manual[0]) {
            if (cursor.folder !== null && cursor.baseline && folderDeliveries[0] !== undefined) {
              const delivered = folderDeliveries.shift()!;
              return { meetings: [build(delivered)], next_cursor: writeGranolaCheckpointV1({ ...cursor, revisions: { ...cursor.revisions, [delivered]: canonicalSha256('meeting version') } }) };
            }
            if (cursor.folder === null || cursor.baseline) return { meetings: [] };
            await duringPull?.();
            return { meetings: [], next_cursor: writeGranolaCheckpointV1({ ...cursor, baseline: true, revisions: { [id]: canonicalSha256('historical meeting') } }) };
          }
          const meeting = build(cursor.manual[0]);
          await duringPull?.();
          return { meetings: [meeting], next_cursor: writeGranolaCheckpointV1({ ...cursor, manual: cursor.manual.slice(1) }) };
        },
      };
    },
  });
  const provider = fakeProvider('granola', GRANOLA_FOLDER_CURSOR_POLICY_V1.source_adapter_id);
  const sessions = { authenticateAccess: ({ access_token }: { access_token: string }) => authorization({ ...(actors[access_token as keyof typeof actors] ?? other), membership_type: access_token === 'owner' ? 'owner' : 'employee' }) };
  const create = (providers: readonly PersonMeetingProviderV1[] = [provider], seams: { readonly approval_core?: Parameters<typeof createPersonMeetingRuntimeV1>[0]['approval_core']; readonly record_append?: typeof f.context.record_append } = {}) =>
    createPersonMeetingRuntimeV1({ database: f.db, approval: seams.record_append === undefined ? f.context : { ...f.context, record_append: seams.record_append }, providers,
    sessions, ...(seams.approval_core === undefined ? {} : { approval_core: seams.approval_core }),
    processor: { processor_adapter_id: 'llm', current_commitments: instance_id => ({ adapter_id: 'llm', instance_id, version: '1.0.0', configuration_sha256: canonicalSha256('processor'), credential_reference_sha256: canonicalSha256('ref') }), assert_admission_commitments() {},
      create_processor(admission) { const identity = { kind: 'decision-processor' as const, adapter_id: 'llm', instance_id: admission.processor.instance_id, version: admission.processor.version };
        return { identity, validateConfig: () => ({ ok: true, errors: [] }), healthCheck: async () => ({ status: 'healthy', checked_at: new Date().toISOString() }),
          async extract(meeting) {
            extracted++; await duringExtract?.();
            if (failExtraction) { failExtraction = false; throw new Error('extraction failed'); }
            return { ...decisions, meeting_id: meeting.id, meeting_revision: meeting.provenance.canonical_revision, processor: identity,
            signals: [...decisions.signals, ...(options.ownedAction ? [{ id: 'act-1', kind: 'action' as const, text: 'Send the pilot plan.', subject: null, confidence: 1, owner: 'Rafael Moreno', due_at: null,
              evidence: [{ meeting_id: meeting.id, block_id: 'block-1' }] }] : []),
              ...Array.from({ length: options.actions ?? 0 }, (_, i) => ({ id: `act-${i + 2}`, kind: 'action' as const, text: `Follow up on item ${i + 2}.`, subject: null, confidence: 1, owner: null, due_at: null,
                evidence: [{ meeting_id: meeting.id, block_id: 'block-1' }] }))].map(signal => ({ ...signal, evidence: signal.evidence.map(evidence => ({ ...evidence, meeting_id: meeting.id })) })) }; } };
      },
    },
    extraction_attempts: { reserve: () => ({ status: 'reserved', attempt: 1, claim_id: 'claim' }), complete() {} },
  });
  const call = async <K extends PersonMeetingOperationV2['operation']>(runtime: ReturnType<typeof create>, op: PersonMeetingOperationV2 & { operation: K }, token = 'owner', tool_id = 'granola') => {
    const meetings = runtime.applications.find(application => application.routes.some(route => route.route_id === 'personal-meetings'))!;
    const response = await meetings.accept({ route_id: 'personal-meetings', method: 'POST', path: '/v1/person/meetings', headers: { authorization: `Bearer ${token}` }, content_type: 'application/json', raw_body: Buffer.from(JSON.stringify({ schema_version: 2, tool_id, ...op })) });
    if (!('body' in response)) throw new Error('Expected JSON');
    return response.body as PersonMeetingResultsV2[K];
  };
  let grants = 0;
  const join = (project_id: string, member: keyof typeof actors) => {
    const actor = actors[member], type = member === 'owner' ? 'owner' : 'employee';
    f.db.prepare("INSERT INTO authority_project_memberships_v1 VALUES (?,?,?,?,?,?,'member','active',?,NULL)").run(`pgm_00000000-0000-4000-8000-${String(5 + 10 * grants++).padStart(12, '0')}`, project_id, person.organization_id, actor.principal_id, actor.membership_id, type, new Date().toISOString());
  };
  const grantProject = (project_id = project, member: keyof typeof actors = 'owner') => {
    const actor = actors[member], type = member === 'owner' ? 'owner' : 'employee';
    f.db.prepare("INSERT INTO authority_projects_v1 VALUES (?,?,?,'active',?,?,?,?)").run(project_id, person.organization_id, 'ECHO', new Date().toISOString(), actor.principal_id, actor.membership_id, type);
    join(project_id, member);
  };
  const leave = (project_id: string, member: keyof typeof actors) => f.db.prepare("UPDATE authority_project_memberships_v1 SET status='revoked',revoked_at=? WHERE project_id=? AND membership_id=? AND status='active'")
    .run(new Date().toISOString(), project_id, actors[member].membership_id);
  const listRoute = () => createPersonListRouteV1({ organization_id: person.organization_id, sessions, tools: async () => [], directory: new SqlitePersonListDirectoryV1(f.db), originals: new SqlitePersonOriginalItemsV1(f.db, sessions, person.organization_id),
    meetings: { collectMeetings: () => ({ status: 'ok', rows: [], handle: {} }), commitMeetings: () => ({}), revalidateMeetingRelease() {}, admitMeeting() {}, openMeeting() { throw new Error('unused'); } },
    transcripts: { readApprovedMeetingTranscriptByRecordV1() { throw new Error('unused'); } },
  });
  // Who can find and open the imported note through the list route and the original-context desk.
  const readers = async (tokens: readonly (keyof typeof actors)[] = ['owner', 'other', 'reader-a', 'reader-b']) => {
    const originals = new SqlitePersonOriginalContextRetrievalV1(f.db, sessions, person.organization_id);
    const list = listRoute();
    const can: string[] = [];
    for (const token of tokens) {
      const listed = (await list.list({ access_token: token, request: { schema_version: 1 } })).items.filter(item => item.kind === 'imported_meeting');
      const found = originals.deskSearch({ access_token: token, scope: { kind: 'global' }, query: 'cohort', kinds: ['imported_meeting'] }).items;
      if (listed.length !== found.length) throw new Error(`list and desk disagree for ${token}`);
      if (listed.length === 0) continue;
      expect(JSON.stringify(await list.open({ access_token: token, request: { schema_version: 1, ref: listed[0]!.ref } }))).toContain('Ship the cohort');
      can.push(token);
    }
    return can;
  };
  const intake = new SqlitePersonMeetingIntakeV1(f.db, provider.cursor);
  const processUntilIdle = async (runtime: ReturnType<typeof create>) => {
    for (let pass = 0; pass < 10 && intake.list().some(s => intake.checkpoint(s.source_key).manual.length > 0); pass++) await runtime.processing.pollAndStageAdmittedMeetings(new AbortController().signal);
  };
  // Imports the meeting, processes it, and opens its one pending review.
  const pendingReview = async (runtime: ReturnType<typeof create>, project_id: string | null = null) => {
    await call(runtime, { operation: 'import', meeting_id: id, project_id, retain: true });
    await processUntilIdle(runtime);
    const [pending] = (await call(runtime, { operation: 'reviews' })).reviews;
    return { pending, opened: await call(runtime, { operation: 'review_open', approval_id: pending!.approval_id }) };
  };
  const count = (table: string) => f.db.prepare(`SELECT count(*) FROM ${table}`).pluck().get();
  // Proposals are counted per personal source.
  const proposals = (sourceKey: string) => f.db.prepare(`SELECT count(*) FROM authority_live_approval_outbox_v2 o
    JOIN authority_live_source_candidates_v2 c ON c.candidate_id=o.candidate_id
    JOIN authority_live_source_admission_v2 a ON a.semantic_input_sha256=c.admission_semantic_input_sha256 WHERE a.source_key=?`).pluck().get(sourceKey);
  // The one proposal of a personal source, with its frozen suggestions.
  const outbox = (sourceKey: string) => f.db.prepare(`SELECT o.approval_id, o.state, o.suggested_projects_json FROM authority_live_approval_outbox_v2 o
    JOIN authority_live_source_candidates_v2 c ON c.candidate_id=o.candidate_id
    JOIN authority_live_source_admission_v2 a ON a.semantic_input_sha256=c.admission_semantic_input_sha256 WHERE a.source_key=? ORDER BY c.created_at, o.approval_id`).all(sourceKey) as { approval_id: string; state: string; suggested_projects_json: string | null }[];
  return { ...f, person, sessions, create, call, outbox, grantProject, join, leave, listRoute, readers, folderDeliveries, fakeProvider, sources, intake, processUntilIdle, pendingReview, count, proposals, extracted: () => extracted, disconnect: () => { active = false; }, duringPull: (fn: () => void | Promise<void>) => { duringPull = fn; },
    duringExtract: (fn: (() => void | Promise<void>) | undefined) => { duringExtract = fn; }, failNextExtraction: () => { failExtraction = true; } };
}
describe('personal meeting intake uses the shared processing path', () => {
  it('refuses an import suggestion for a project the person is not in', async () => {
    const f = await fixture(), runtime = f.create(); f.grantProject(foreignProject, 'other');
    await expect(f.call(runtime, { operation: 'import', meeting_id: id, project_id: foreignProject, retain: true })).rejects.toMatchObject({ code: 'unauthorized' });
    expect(f.count('authority_person_meeting_suggestions_v1')).toBe(0);
    expect(f.count('authority_person_meeting_sources_v2')).toBe(0);
  });
  it('keeps a review visible after its suggested project is left, and offers only readable suggestions', async () => {
    const f = await fixture(), runtime = f.create(); f.grantProject();
    await f.call(runtime, { operation: 'import', meeting_id: id, project_id: project, retain: true });
    await f.processUntilIdle(runtime);
    const [pending] = (await f.call(runtime, { operation: 'reviews' })).reviews;
    expect(pending).toMatchObject({ status: 'pending', project_ids: [project] });
    f.db.prepare("UPDATE authority_project_memberships_v1 SET status='revoked',revoked_at=? WHERE project_id=?").run(new Date().toISOString(), project);
    expect((await f.call(runtime, { operation: 'reviews' })).reviews).toEqual([{ ...pending, project_ids: [] }]);
    const opened = await f.call(runtime, { operation: 'review_open', approval_id: pending!.approval_id });
    expect(opened.suggested_projects).toEqual([]);
    await expect(f.call(runtime, { operation: 'review', approval_id: pending!.approval_id, snapshot_sha256: opened.snapshot_sha256, command_id: 'approve-left-project', action: 'approve', project_ids: [project], share_transcript: false, owners: [] })).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(f.call(runtime, { operation: 'review', approval_id: pending!.approval_id, snapshot_sha256: opened.snapshot_sha256, command_id: 'approve-only-me', action: 'approve', project_ids: [], share_transcript: false, owners: [] })).resolves.toEqual({ status: 'publishing', decided_on: 'desktop' });
  });
  it('routes each stored source to the provider that owns its adapter id', async () => {
    const f = await fixture(); f.grantProject();
    const runtime = f.create([f.fakeProvider('granola', 'granola-person-mcp'), f.fakeProvider('notes', 'notes-person-mcp')]);
    await f.call(runtime, { operation: 'import', meeting_id: id, project_id: null, retain: true });
    // A project choice is only a suggestion; each tool account still has its own source.
    await f.call(runtime, { operation: 'import', meeting_id: id, project_id: project, retain: true }, 'owner', 'notes');
    const granola = (await f.call(runtime, { operation: 'home' })).sources;
    const notes = (await f.call(runtime, { operation: 'home' }, 'owner', 'notes')).sources;
    expect(granola).toHaveLength(1); expect(notes).toHaveLength(1);
    expect(granola[0]?.source_key).not.toBe(notes[0]?.source_key);
    await runtime.processing.pollAndStageAdmittedMeetings(new AbortController().signal);
    await runtime.processing.pollAndStageAdmittedMeetings(new AbortController().signal);
    expect(new Set(f.sources.filter(call => call.tool_id === 'granola').map(call => call.source_key))).toEqual(new Set([granola[0]!.source_key]));
    expect(new Set(f.sources.filter(call => call.tool_id === 'notes').map(call => call.source_key))).toEqual(new Set([notes[0]!.source_key]));
    expect((await f.call(runtime, { operation: 'reviews' })).reviews).toHaveLength(2);
    await expect(f.call(runtime, { operation: 'home' }, 'owner', 'calendar')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('keeps two people importing the same meeting in independent private custody and review', async () => {
    const f = await fixture(), runtime = f.create();
    for (const token of ['owner', 'other']) await f.call(runtime, { operation: 'import', meeting_id: id, project_id: null, retain: true }, token);
    const owner = await f.call(runtime, { operation: 'home' });
    const other = await f.call(runtime, { operation: 'home' }, 'other');
    expect(owner.sources[0]?.source_key).not.toBe(other.sources[0]?.source_key);
    await runtime.processing.pollAndStageAdmittedMeetings(new AbortController().signal);
    await runtime.processing.pollAndStageAdmittedMeetings(new AbortController().signal);
    const a = (await f.call(runtime, { operation: 'reviews' })).reviews;
    const b = (await f.call(runtime, { operation: 'reviews' }, 'other')).reviews;
    expect(a).toHaveLength(1); expect(b).toHaveLength(1); expect(a[0]?.approval_id).not.toBe(b[0]?.approval_id);
    await expect(f.call(runtime, { operation: 'review_open', approval_id: a[0]!.approval_id }, 'other')).rejects.toMatchObject({ code: 'not_found' });
    const originals = new SqlitePersonOriginalContextRetrievalV1(f.db, f.sessions, f.person.organization_id);
    for (const token of ['owner', 'other']) expect(originals.deskSearch({ access_token: token, scope: { kind: 'mine' }, query: 'cohort' }).items).toHaveLength(1);
  });

  it('browses without retention; imports once across clients/restart and approves without Slack', async () => {
    const f = await fixture(), runtime = f.create();
    await f.call(runtime, { operation: 'open', meeting_id: id });
    expect(f.db.prepare('SELECT count(*) AS n FROM authority_person_meeting_sources_v2').get()).toEqual({ n: 0 });
    await f.call(runtime, { operation: 'import', meeting_id: id, project_id: null, retain: true });
    await f.call(f.create(), { operation: 'import', meeting_id: id, project_id: null, retain: true });
    const home = await f.call(runtime, { operation: 'home' }); expect(home.sources[0]?.pending_imports).toEqual([id]);
    await runtime.processing.pollAndStageAdmittedMeetings(new AbortController().signal);
    const reviews = await f.call(runtime, { operation: 'reviews' }); expect(reviews.reviews).toHaveLength(1); expect(f.extracted()).toBe(1);
    expect((await f.call(runtime, { operation: 'reviews' }, 'other')).reviews).toEqual([]);
    const review = await f.call(runtime, { operation: 'review_open', approval_id: reviews.reviews[0]!.approval_id });
    await expect(f.call(runtime, { operation: 'review', approval_id: review.review.approval_id, snapshot_sha256: review.snapshot_sha256, command_id: 'invalid command id', action: 'approve', project_ids: [], share_transcript: false, owners: [] })).rejects.toMatchObject({ code: 'invalid_request' });
    expect(f.db.prepare('SELECT count(*) FROM authority_approval_decisions_v1').pluck().get()).toBe(0);
    f.disconnect();
    await f.call(runtime, { operation: 'review', approval_id: review.review.approval_id, snapshot_sha256: review.snapshot_sha256, command_id: 'approve-once', action: 'approve', project_ids: [], share_transcript: false, owners: [] });
    await f.create().processing.recoverV4Appends(new AbortController().signal);
    expect((await f.call(runtime, { operation: 'reviews' })).reviews[0]?.status).toBe('approved');
    expect(f.record.prepare('SELECT count(*) AS n FROM organization_record_log').get()).toEqual({ n: 1 });
  });
  it('honors cancellation while the queued meeting is being fetched', async () => {
    const f = await fixture(), runtime = f.create();
    await f.call(runtime, { operation: 'import', meeting_id: id, project_id: null, retain: true });
    const home = await f.call(runtime, { operation: 'home' });
    f.duringPull(async () => { await f.call(runtime, { operation: 'cancel_import', source_key: home.sources[0]!.source_key, meeting_id: id }); });
    const before = f.db.prepare('SELECT count(*) FROM authority_source_revisions_v1').pluck().get();
    await runtime.processing.pollAndStageAdmittedMeetings(new AbortController().signal);
    expect(f.db.prepare('SELECT count(*) FROM authority_source_revisions_v1').pluck().get()).toBe(before);
    expect(f.extracted()).toBe(0);
  });
  it('refuses custody when a connection is revoked during fetch', async () => {
    const f = await fixture(), runtime = f.create();
    await f.call(runtime, { operation: 'import', meeting_id: id, project_id: null, retain: true });
    f.duringPull(f.disconnect);
    const before = f.db.prepare('SELECT count(*) AS n FROM authority_source_revisions_v1').get();
    await runtime.processing.pollAndStageAdmittedMeetings(new AbortController().signal);
    expect(f.db.prepare('SELECT count(*) AS n FROM authority_source_revisions_v1').get()).toEqual(before); expect(f.extracted()).toBe(0);
  });
  it('lists and cites imported originals in Mine and project scope; the importer always reads their own imports, without releasing transcripts or outsider content', async () => {
    const f = await fixture(), runtime = f.create(); f.grantProject();
    await f.call(runtime, { operation: 'import', meeting_id: id, project_id: project, retain: true });
    await runtime.processing.pollAndStageAdmittedMeetings(new AbortController().signal);
    const originals = new SqlitePersonOriginalContextRetrievalV1(f.db, f.sessions, f.person.organization_id);
    const list = f.listRoute();
    const page = await list.list({ access_token: 'owner', request: { schema_version: 1, mine: true } });
    expect(page.items).toHaveLength(1); expect(page.items[0]).toMatchObject({ kind: 'imported_meeting', visibility: 'project' });
    const opened = await list.open({ access_token: 'owner', request: { schema_version: 1, ref: page.items[0]!.ref } });
    expect(JSON.stringify(opened)).toContain('Ship the cohort'); expect(JSON.stringify(opened)).not.toContain('TRANSCRIPT_SECRET');
    const search = originals.deskSearch({ access_token: 'owner', scope: { kind: 'project', project_id: project }, query: 'cohort', kinds: ['imported_meeting'] });
    expect(search.items).toHaveLength(1); expect(search.items[0]?.kind).toBe('imported_meeting');
    expect(originals.deskOpen({ access_token: 'owner', scope: { kind: 'mine' }, citation: search.items[0]!.citation }).items[0]?.text).toContain('Ship the cohort');
    expect(originals.deskSearch({ access_token: 'other', scope: { kind: 'global' }, query: 'cohort' }).items).toEqual([]);
    await expect(list.open({ access_token: 'other', request: { schema_version: 1, ref: page.items[0]!.ref } })).rejects.toMatchObject({ code: 'not_found' });
    expect(originals.deskSearch({ access_token: 'owner', scope: { kind: 'global' }, query: 'TRANSCRIPT_SECRET_DO_NOT_SHARE' }).items).toEqual([]);
    f.db.prepare("UPDATE authority_project_memberships_v1 SET status='revoked',revoked_at=? WHERE project_id=?").run(new Date().toISOString(), project);
    expect(() => originals.revalidateDeskRelease({ access_token: 'owner', release: search })).toThrow();
    // Intended rule (R26): the importer always reads their own imports; project members read them only while they are members.
    // Project scope itself still needs current project membership.
    expect(() => originals.deskSearch({ access_token: 'owner', scope: { kind: 'project', project_id: project }, query: 'cohort' })).toThrow();
    expect(JSON.stringify(await list.open({ access_token: 'owner', request: { schema_version: 1, ref: page.items[0]!.ref } }))).toContain('Ship the cohort');
  });
  it('keeps a folder-delivered meeting readable by the folder project after the watch moves', async () => {
    const f = await fixture(); f.grantProject(); f.join(project, 'reader-a'); f.grantProject(projectB); f.join(projectB, 'reader-b');
    const home = await f.call(f.create(), { operation: 'home' });
    await f.call(f.create(), { operation: 'watch', folder_id: folder, project_id: project, retain: true, settings_sha256: home.settings_sha256 });
    await f.create().processing.pollAndStageAdmittedMeetings(new AbortController().signal); // baseline
    f.folderDeliveries.push(id);
    await f.create().processing.pollAndStageAdmittedMeetings(new AbortController().signal);
    expect(f.folderDeliveries).toEqual([]); expect(f.extracted()).toBe(1);
    const [source] = (await f.call(f.create(), { operation: 'home' })).sources;
    expect(f.intake.suggestions(source!.source_key, id)).toEqual([project]);
    expect(await f.readers()).toEqual(['owner', 'reader-a']);
    const watched = await f.call(f.create(), { operation: 'home' });
    await f.call(f.create(), { operation: 'watch', folder_id: folder, project_id: projectB, retain: true, settings_sha256: watched.settings_sha256 });
    expect((await f.call(f.create(), { operation: 'home' })).sources[0]).toMatchObject({ folder_id: folder, folder_project_id: projectB });
    expect(await f.readers()).toEqual(['owner', 'reader-a']);
    // A member of both projects reads it through project A.
    f.join(project, 'reader-b');
    expect(await f.readers()).toEqual(['owner', 'reader-a', 'reader-b']);
  });
  it('keeps a private import with the importer even while a folder is watched', async () => {
    const f = await fixture(); f.grantProject(); f.join(project, 'reader-a');
    const home = await f.call(f.create(), { operation: 'home' });
    await f.call(f.create(), { operation: 'watch', folder_id: folder, project_id: project, retain: true, settings_sha256: home.settings_sha256 });
    await f.create().processing.pollAndStageAdmittedMeetings(new AbortController().signal); // baseline
    await f.call(f.create(), { operation: 'import', meeting_id: id, project_id: null, retain: true });
    await f.processUntilIdle(f.create());
    expect(f.extracted()).toBe(1);
    const [source] = (await f.call(f.create(), { operation: 'home' })).sources;
    expect(f.intake.suggestions(source!.source_key, id)).toEqual([]);
    expect(await f.readers()).toEqual(['owner']);
  });
  it('lets members of each project a note was imported with read it, and only while they are members', async () => {
    const f = await fixture(), runtime = f.create(); f.grantProject(); f.join(project, 'reader-a'); f.grantProject(projectB); f.join(projectB, 'reader-b');
    await f.call(runtime, { operation: 'import', meeting_id: id, project_id: project, retain: true });
    // The project choice waits as pending until processing consumes the queued import.
    expect(f.count('authority_person_meeting_suggestions_v1')).toBe(0);
    expect(f.count('authority_person_meeting_pending_suggestions_v1')).toBe(1);
    await f.processUntilIdle(runtime);
    const [source] = (await f.call(runtime, { operation: 'home' })).sources;
    expect(f.intake.suggestions(source!.source_key, id)).toEqual([project]);
    expect(f.count('authority_person_meeting_pending_suggestions_v1')).toBe(0);
    expect(await f.readers()).toEqual(['owner', 'reader-a']);
    const revisions = f.count('authority_source_revisions_v1');
    await f.call(runtime, { operation: 'import', meeting_id: id, project_id: projectB, retain: true });
    expect(await f.readers()).toEqual(['owner', 'reader-a']);
    await f.processUntilIdle(f.create());
    // The unchanged revision is re-admitted as a duplicate; that admission consumes the queued import and promotes B.
    expect(f.count('authority_source_revisions_v1')).toBe(revisions); expect(f.extracted()).toBe(1);
    expect(f.intake.suggestions(source!.source_key, id)).toEqual([project, projectB].sort());
    expect(f.count('authority_person_meeting_pending_suggestions_v1')).toBe(0);
    expect(await f.readers()).toEqual(['owner', 'reader-a', 'reader-b']);
    f.leave(project, 'reader-a');
    expect(await f.readers()).toEqual(['owner', 'reader-b']);
  });
  it('grants nothing to the project of a cancelled import when the note is re-imported privately', async () => {
    const f = await fixture(), runtime = f.create(); f.grantProject(); f.join(project, 'reader-a');
    await f.call(runtime, { operation: 'import', meeting_id: id, project_id: project, retain: true });
    const [queued] = (await f.call(runtime, { operation: 'home' })).sources;
    await f.call(runtime, { operation: 'cancel_import', source_key: queued!.source_key, meeting_id: id });
    await f.call(runtime, { operation: 'import', meeting_id: id, project_id: null, retain: true });
    await f.processUntilIdle(runtime);
    expect(f.extracted()).toBe(1);
    expect(f.count('authority_person_meeting_suggestions_v1')).toBe(0);
    expect(f.count('authority_person_meeting_pending_suggestions_v1')).toBe(0);
    expect(await f.readers()).toEqual(['owner']);
  });
  it('grants nothing to the project of a cancelled import when the folder later delivers the note', async () => {
    const f = await fixture(); f.grantProject(); f.join(project, 'reader-a'); f.grantProject(projectB); f.join(projectB, 'reader-b');
    const home = await f.call(f.create(), { operation: 'home' });
    await f.call(f.create(), { operation: 'watch', folder_id: folder, project_id: projectB, retain: true, settings_sha256: home.settings_sha256 });
    await f.create().processing.pollAndStageAdmittedMeetings(new AbortController().signal); // baseline
    await f.call(f.create(), { operation: 'import', meeting_id: id, project_id: project, retain: true });
    const [queued] = (await f.call(f.create(), { operation: 'home' })).sources;
    await f.call(f.create(), { operation: 'cancel_import', source_key: queued!.source_key, meeting_id: id });
    f.folderDeliveries.push(id);
    await f.create().processing.pollAndStageAdmittedMeetings(new AbortController().signal);
    expect(f.folderDeliveries).toEqual([]); expect(f.extracted()).toBe(1);
    expect(f.intake.suggestions(queued!.source_key, id)).toEqual([projectB]);
    expect(f.count('authority_person_meeting_pending_suggestions_v1')).toBe(0);
    expect(await f.readers()).toEqual(['owner', 'reader-b']);
  });
  it('grants nothing when the import is cancelled while its admitted meeting is being extracted', async () => {
    const f = await fixture(), runtime = f.create(); f.grantProject(); f.join(project, 'reader-a');
    await f.call(runtime, { operation: 'import', meeting_id: id, project_id: project, retain: true });
    const [queued] = (await f.call(runtime, { operation: 'home' })).sources;
    f.duringExtract(async () => {
      // The meeting is already admitted; the cancel lands before the cursor advance.
      expect(f.count('authority_person_meeting_pending_suggestions_v1')).toBe(1);
      await expect(f.call(runtime, { operation: 'cancel_import', source_key: queued!.source_key, meeting_id: id })).resolves.toEqual({ status: 'cancelled' });
    });
    await runtime.processing.pollAndStageAdmittedMeetings(new AbortController().signal);
    expect(f.extracted()).toBe(1);
    expect(f.intake.checkpoint(queued!.source_key).manual).toEqual([]);
    expect(f.count('authority_person_meeting_suggestions_v1')).toBe(0);
    expect(f.count('authority_person_meeting_pending_suggestions_v1')).toBe(0);
    expect(await f.readers()).toEqual(['owner']);
  });
  it('grants nothing when a cycle fails after admission and the import is then cancelled', async () => {
    const f = await fixture(), runtime = f.create(); f.grantProject(); f.join(project, 'reader-a');
    await f.call(runtime, { operation: 'import', meeting_id: id, project_id: project, retain: true });
    f.failNextExtraction();
    await runtime.processing.pollAndStageAdmittedMeetings(new AbortController().signal);
    const [failed] = (await f.call(runtime, { operation: 'home' })).sources;
    expect(failed).toMatchObject({ pending_imports: [id], error: expect.any(String) });
    expect(await f.readers()).toEqual(['owner']);
    await f.call(runtime, { operation: 'cancel_import', source_key: failed!.source_key, meeting_id: id });
    await f.processUntilIdle(f.create());
    expect(f.count('authority_person_meeting_suggestions_v1')).toBe(0);
    expect(f.count('authority_person_meeting_pending_suggestions_v1')).toBe(0);
    expect(await f.readers()).toEqual(['owner']);
  });
  it('records and freezes an in-flight re-import\'s project when the cursor advance drops the meeting', async () => {
    const f = await fixture(), runtime = f.create(); f.grantProject(); f.join(project, 'reader-a'); f.grantProject(projectB); f.join(projectB, 'reader-b');
    await f.call(runtime, { operation: 'import', meeting_id: id, project_id: project, retain: true });
    f.duringExtract(async () => {
      f.duringExtract(undefined);
      await f.call(runtime, { operation: 'import', meeting_id: id, project_id: projectB, retain: true });
      expect(f.count('authority_person_meeting_pending_suggestions_v1')).toBe(2);
      expect(f.count('authority_person_meeting_suggestions_v1')).toBe(0);
    });
    await runtime.processing.pollAndStageAdmittedMeetings(new AbortController().signal);
    const [source] = (await f.call(runtime, { operation: 'home' })).sources;
    expect(source!.pending_imports).toEqual([]);
    expect(f.intake.suggestions(source!.source_key, id)).toEqual([project, projectB].sort());
    expect(JSON.parse(f.outbox(source!.source_key)[0]!.suggested_projects_json!)).toEqual([project, projectB].sort());
    expect(f.count('authority_person_meeting_pending_suggestions_v1')).toBe(0);
    expect(f.extracted()).toBe(1);
    expect(await f.readers()).toEqual(['owner', 'reader-a', 'reader-b']);
  });
  it('refuses a project reader\'s earlier desk release once they leave the project', async () => {
    const f = await fixture(), runtime = f.create(); f.grantProject(); f.join(project, 'reader-a');
    await f.call(runtime, { operation: 'import', meeting_id: id, project_id: project, retain: true });
    await f.processUntilIdle(runtime);
    const originals = new SqlitePersonOriginalContextRetrievalV1(f.db, f.sessions, f.person.organization_id);
    const release = originals.deskSearch({ access_token: 'reader-a', scope: { kind: 'global' }, query: 'cohort', kinds: ['imported_meeting'] });
    expect(release.items).toHaveLength(1);
    expect(() => originals.revalidateDeskRelease({ access_token: 'reader-a', release })).not.toThrow();
    f.leave(project, 'reader-a');
    expect(() => originals.revalidateDeskRelease({ access_token: 'reader-a', release })).toThrow();
  });
  it('opens a valid transcript-only imported meeting with no releasable body', async () => {
    const f = await fixture({ transcriptOnly: true }), runtime = f.create();
    await f.call(runtime, { operation: 'import', meeting_id: id, project_id: null, retain: true });
    await runtime.processing.pollAndStageAdmittedMeetings(new AbortController().signal);
    const list = f.listRoute();
    const page = await list.list({ access_token: 'owner', request: { schema_version: 1, mine: true } });
    expect(page.items).toHaveLength(1);
    const opened = await list.open({ access_token: 'owner', request: { schema_version: 1, ref: page.items[0]!.ref } });
    expect(opened).toMatchObject({ text: '', next_cursor: null });
    expect(JSON.stringify(opened)).not.toContain('TRANSCRIPT_SECRET_DO_NOT_SHARE');
  });
  it('saves a pending watch before the background baseline finishes, survives restart, and retains no history', async () => {
    const f = await fixture(), runtime = f.create(); f.grantProject();
    const home = await f.call(runtime, { operation: 'home' });
    await expect(f.call(runtime, { operation: 'watch', folder_id: folder, project_id: project, retain: true, settings_sha256: home.settings_sha256 })).resolves.toEqual({ status: 'saved' });
    expect((await f.call(runtime, { operation: 'home' })).sources[0]).toMatchObject({ folder_id: folder, folder_project_id: project, baseline: false });
    const before = f.db.prepare('SELECT count(*) FROM authority_source_revisions_v1').pluck().get();
    let started!: () => void, release!: () => void;
    const startedPull = new Promise<void>(resolve => { started = resolve; });
    const finishPull = new Promise<void>(resolve => { release = resolve; });
    f.duringPull(async () => { started(); await finishPull; });
    const restarted = f.create();
    const scan = restarted.processing.pollAndStageAdmittedMeetings(new AbortController().signal);
    await startedPull;
    try { expect((await f.call(restarted, { operation: 'home' })).sources[0]?.baseline).toBe(false); }
    finally { release(); await scan; }
    expect((await f.call(restarted, { operation: 'home' })).sources[0]).toMatchObject({ baseline: true, pending_imports: [], error: null });
    expect(f.db.prepare('SELECT count(*) FROM authority_source_revisions_v1').pluck().get()).toBe(before);
    expect(f.extracted()).toBe(0);
  });
  it('discards an in-flight baseline when the person stops the watch', async () => {
    const f = await fixture(), runtime = f.create(); f.grantProject();
    const home = await f.call(runtime, { operation: 'home' });
    await f.call(runtime, { operation: 'watch', folder_id: folder, project_id: project, retain: true, settings_sha256: home.settings_sha256 });
    const pending = await f.call(runtime, { operation: 'home' });
    expect(pending.sources[0]?.baseline).toBe(false);
    f.duringPull(async () => { await f.call(runtime, { operation: 'watch', folder_id: null, project_id: null, retain: true, settings_sha256: pending.settings_sha256 }); });
    const before = f.db.prepare('SELECT count(*) FROM authority_source_revisions_v1').pluck().get();
    await runtime.processing.pollAndStageAdmittedMeetings(new AbortController().signal);
    expect((await f.call(runtime, { operation: 'home' })).sources[0]).toMatchObject({ folder_id: null, baseline: false });
    expect(f.db.prepare('SELECT count(*) FROM authority_source_revisions_v1').pluck().get()).toBe(before);
    expect(f.extracted()).toBe(0);
  });
  it('uses compare-and-set across clients and permits stopping after project access is revoked', async () => {
    const f = await fixture(), runtime = f.create(); f.grantProject();
    const home = await f.call(runtime, { operation: 'home' });
    const watch = { operation: 'watch' as const, folder_id: folder, project_id: project, retain: true as const, settings_sha256: home.settings_sha256 };
    await f.call(runtime, watch);
    await expect(f.call(f.create(), watch)).rejects.toMatchObject({ code: 'stale_access_state' });
    const next = await f.call(runtime, { operation: 'home' }); expect(next.sources[0]?.baseline).toBe(false);
    f.db.prepare("UPDATE authority_project_memberships_v1 SET status='revoked',revoked_at=? WHERE project_id=?").run(new Date().toISOString(), project);
    await f.call(runtime, { operation: 'watch', folder_id: null, project_id: null, retain: true, settings_sha256: next.settings_sha256 });
    expect((await f.call(runtime, { operation: 'home' })).sources[0]?.folder_id).toBeNull();
  });
  it('imports a note saved to A and then B before processing as one source and one extraction, freezing both projects', async () => {
    const f = await fixture(), runtime = f.create(); f.grantProject(); f.grantProject(projectB);
    await f.call(runtime, { operation: 'import', meeting_id: id, project_id: project, retain: true });
    await f.call(runtime, { operation: 'import', meeting_id: id, project_id: projectB, retain: true });
    await f.processUntilIdle(runtime);
    expect(f.count('authority_person_meeting_sources_v2')).toBe(1);
    const [source] = (await f.call(runtime, { operation: 'home' })).sources;
    expect(f.extracted()).toBe(1);
    expect(f.proposals(source!.source_key)).toBe(1);
    expect(f.intake.suggestions(source!.source_key, id)).toEqual([project, projectB].sort());
    const [proposal] = f.outbox(source!.source_key);
    expect(JSON.parse(proposal!.suggested_projects_json!)).toEqual([project, projectB].sort());
    expect((await runtime.approvals()).proposal(proposal!.approval_id)!.project_ids).toEqual([project, projectB].sort());
    expect((await f.call(runtime, { operation: 'reviews' })).reviews.map(review => review.project_ids)).toEqual([[project, projectB].sort()]);
    expect(f.count('authority_person_meeting_pending_suggestions_v1')).toBe(0);
  });
  it('shows a failed first freeze on its source and re-freezes it on a later tick with no new import', async () => {
    const f = await fixture(), runtime = f.create(); f.grantProject();
    await f.call(runtime, { operation: 'import', meeting_id: id, project_id: project, retain: true });
    refusal.next = 1;
    try { await runtime.processing.pollAndStageAdmittedMeetings(new AbortController().signal); } finally { refusal.next = 0; }
    const [source] = (await f.call(runtime, { operation: 'home' })).sources;
    // The cursor advanced past the import (it cannot cork intake) and recorded its project choice.
    expect(source).toMatchObject({ pending_imports: [], error: expect.stringContaining('needs attention') });
    expect(f.intake.suggestions(source!.source_key, id)).toEqual([project]);
    expect(f.outbox(source!.source_key)).toEqual([expect.objectContaining({ state: 'queued', suggested_projects_json: null })]);
    expect((await f.call(runtime, { operation: 'reviews' })).reviews).toEqual([]);
    // The retry waits out the source's backoff; it needs no new import and no provider access.
    f.disconnect();
    await runtime.processing.pollAndStageAdmittedMeetings(new AbortController().signal);
    expect(f.outbox(source!.source_key)[0]).toMatchObject({ state: 'queued' });
    const later = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000);
    try { await runtime.processing.pollAndStageAdmittedMeetings(new AbortController().signal); } finally { later.mockRestore(); }
    const [frozen] = f.outbox(source!.source_key);
    expect(frozen).toMatchObject({ state: 'staged' });
    expect(JSON.parse(frozen!.suggested_projects_json!)).toEqual([project]);
    expect((await f.call(runtime, { operation: 'home' })).sources[0]).toMatchObject({ error: null });
    expect((await f.call(runtime, { operation: 'reviews' })).reviews).toEqual([expect.objectContaining({ approval_id: frozen!.approval_id, project_ids: [project] })]);
    // A frozen source with nothing to import drops out of the poll.
    await runtime.processing.pollAndStageAdmittedMeetings(new AbortController().signal);
    expect(f.extracted()).toBe(1);
  });
  it('keeps a repeated freeze failure visible on its source', async () => {
    const f = await fixture(), runtime = f.create(); f.grantProject();
    await f.call(runtime, { operation: 'import', meeting_id: id, project_id: project, retain: true });
    refusal.next = 2;
    try {
      await runtime.processing.pollAndStageAdmittedMeetings(new AbortController().signal);
      const later = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000);
      try { await runtime.processing.pollAndStageAdmittedMeetings(new AbortController().signal); } finally { later.mockRestore(); }
    } finally { refusal.next = 0; }
    const [source] = (await f.call(runtime, { operation: 'home' })).sources;
    expect(source).toMatchObject({ pending_imports: [], error: expect.stringContaining('needs attention') });
    expect(f.outbox(source!.source_key)).toEqual([expect.objectContaining({ state: 'queued', suggested_projects_json: null })]);
  });
  it('keeps the frozen suggestions when the note is saved to another project after staging', async () => {
    const f = await fixture(), runtime = f.create(); f.grantProject(); f.grantProject(projectB); f.join(projectB, 'reader-b');
    await f.call(runtime, { operation: 'import', meeting_id: id, project_id: project, retain: true });
    await f.processUntilIdle(runtime);
    await f.call(runtime, { operation: 'import', meeting_id: id, project_id: projectB, retain: true });
    await f.processUntilIdle(runtime);
    const [source] = (await f.call(runtime, { operation: 'home' })).sources;
    expect(f.extracted()).toBe(1);
    const proposals = f.outbox(source!.source_key);
    expect(proposals).toHaveLength(1);
    expect(JSON.parse(proposals[0]!.suggested_projects_json!)).toEqual([project]);
    expect((await f.call(runtime, { operation: 'reviews' })).reviews[0]?.project_ids).toEqual([project]);
    expect((await runtime.approvals()).proposal(proposals[0]!.approval_id)!.project_ids).toEqual([project]);
    expect(f.intake.suggestions(source!.source_key, id)).toEqual([project, projectB].sort());
    expect(await f.readers()).toContain('reader-b');
  });
  it('approves into the chosen project through the v2 route', async () => {
    const f = await fixture(), runtime = f.create(); f.grantProject(); f.grantProject(projectB);
    const { pending, opened } = await f.pendingReview(runtime, project);
    await expect(f.call(runtime, { operation: 'review', approval_id: pending!.approval_id, snapshot_sha256: opened.snapshot_sha256, command_id: 'approve-b', action: 'approve', project_ids: [projectB], share_transcript: true, owners: [] }))
      .resolves.toEqual({ status: 'publishing', decided_on: 'desktop' });
    const body = JSON.parse(f.db.prepare('SELECT body_json FROM authority_approval_decisions_v1').pluck().get() as string);
    expect(body).toMatchObject({ surface: 'desktop', request: { project_ids: [projectB], share_transcript: true, owners: [] }, evidence: { kind: 'person-session' } });
    await runtime.processing.recoverV4Appends(new AbortController().signal);
    const envelope = JSON.parse(f.record.prepare('SELECT canonical_envelope FROM organization_record_log').pluck().get() as string);
    expect(envelope.body.human_act_resolution_ref.audience_project_ids).toEqual([projectB]);
    expect((await f.call(runtime, { operation: 'reviews' })).reviews[0]).toMatchObject({ status: 'approved', project_ids: [projectB], decided_on: 'desktop' });
  });
  it('forwards after_record hooks from the runtime passthrough', async () => {
    const calls: AfterApprovedRecordEventV1[] = [];
    const f = await fixture(), runtime = f.create(undefined, { approval_core: { after_record: [(tx, event) => { expect(tx.inTransaction).toBe(true); calls.push(event); }] } });
    const { pending, opened } = await f.pendingReview(runtime);
    await f.call(runtime, { operation: 'review', approval_id: pending!.approval_id, snapshot_sha256: opened.snapshot_sha256, command_id: 'approve-hooked', action: 'approve', project_ids: [], share_transcript: false, owners: [] });
    await runtime.processing.appendFinalizedApprovalsToV4(new AbortController().signal);
    await runtime.processing.appendFinalizedApprovalsToV4(new AbortController().signal);
    expect(calls).toEqual([expect.objectContaining({ approval_id: pending!.approval_id, record_sha256: f.record.prepare('SELECT record_sha256 FROM organization_record_log').pluck().get() })]);
  });
  it('crash between append and receipt at restart: one record, one receipt, one hook', async () => {
    const calls: AfterApprovedRecordEventV1[] = [];
    const after_record = [(_tx: unknown, event: AfterApprovedRecordEventV1) => { calls.push(event); }];
    const f = await fixture();
    const crashing = f.create(undefined, { approval_core: { after_record }, record_append: { async append(input) { await f.context.record_append.append(input); throw new Error('crash after append'); } } });
    const { pending, opened } = await f.pendingReview(crashing);
    await f.call(crashing, { operation: 'review', approval_id: pending!.approval_id, snapshot_sha256: opened.snapshot_sha256, command_id: 'approve-crash', action: 'approve', project_ids: [], share_transcript: false, owners: [] });
    await expect(crashing.processing.recoverV4Appends(new AbortController().signal)).rejects.toThrow('crash after append');
    expect(calls).toEqual([]);
    crashing.close();
    const restarted = f.create(undefined, { approval_core: { after_record } });
    await restarted.processing.recoverV4Appends(new AbortController().signal);
    await restarted.processing.recoverV4Appends(new AbortController().signal);
    expect(f.record.prepare('SELECT count(*) FROM organization_record_log').pluck().get()).toBe(1);
    expect(f.db.prepare('SELECT count(*) FROM authority_approval_decisions_v1 WHERE receipt_json IS NOT NULL').pluck().get()).toBe(1);
    expect(calls).toEqual([expect.objectContaining({ approval_id: pending!.approval_id })]);
  });
  it('returns an earlier decision and writes no second row', async () => {
    const f = await fixture(), runtime = f.create();
    const { pending, opened } = await f.pendingReview(runtime);
    const review = { operation: 'review' as const, approval_id: pending!.approval_id, snapshot_sha256: opened.snapshot_sha256, command_id: 'reject-once', action: 'reject' as const, project_ids: [], share_transcript: false, owners: [] };
    await expect(f.call(runtime, review)).resolves.toEqual({ status: 'rejected', decided_on: 'desktop' });
    await expect(f.call(runtime, review)).resolves.toEqual({ status: 'rejected', decided_on: 'desktop' });
    await expect(f.call(runtime, { ...review, command_id: 'approve-later', action: 'approve' })).resolves.toEqual({ status: 'rejected', decided_on: 'desktop' });
    await expect(f.call(runtime, { ...review, command_id: 'approve-stale', action: 'approve', snapshot_sha256: canonicalSha256('other') })).resolves.toEqual({ status: 'rejected', decided_on: 'desktop' });
    expect(f.count('authority_approval_decisions_v1')).toBe(1);
  });
  it('approves into two projects with a confirmed owner through the route', async () => {
    const f = await fixture({ ownedAction: true }), runtime = f.create(); f.grantProject(); f.grantProject(projectB);
    const { pending, opened } = await f.pendingReview(runtime, project);
    expect(opened.content).toContain('Send the pilot plan.');
    expect(opened.content).toContain('  Due: Not specified');
    expect(opened.content).not.toMatch(/Owner|Rafael/);
    expect(opened.owners).toEqual([{ signal_id: 'act-1', action: 'Send the pilot plan.', proposed: 'Rafael Moreno' }]);
    expect(opened.suggested_projects).toEqual([{ project_id: project, name: 'ECHO' }]);
    await expect(f.call(runtime, { operation: 'review', approval_id: pending!.approval_id, command_id: 'c1', snapshot_sha256: opened.snapshot_sha256,
      action: 'approve', project_ids: [project, projectB].sort(), share_transcript: false, owners: [{ signal_id: 'act-1', owner: 'Rafael Moreno' }] }))
      .resolves.toEqual({ status: 'publishing', decided_on: 'desktop' });
  });
  it('returns the earlier decision when Slack decided first', async () => {
    const f = await fixture(), runtime = f.create();
    const { pending, opened } = await f.pendingReview(runtime);
    const slackReview = validateApprovalDecisionRequestV1('slack', { approval_id: pending!.approval_id, command_id: 'slack:k', snapshot_sha256: opened.snapshot_sha256,
      action: 'approve', project_ids: [], share_transcript: false, owners: [] });
    (await runtime.approvals()).decide('slack', slackReview, () => ({ actor: f.person, evidence: { kind: 'slack-click', sha256: canonicalSha256('slack click') } }));
    expect((await f.call(runtime, { operation: 'review_open', approval_id: pending!.approval_id })).review.decided_on).toBe('slack');
    await expect(f.call(runtime, { operation: 'review', approval_id: pending!.approval_id, command_id: 'c2', snapshot_sha256: opened.snapshot_sha256,
      action: 'reject', project_ids: [], share_transcript: false, owners: [] })).resolves.toEqual({ status: 'publishing', decided_on: 'slack' });
  });
  it('names the first decision, the action count and the meeting time on review rows', async () => {
    const f = await fixture({ ownedAction: true, started: '2026-10-06T16:00:00.000Z' }), runtime = f.create();
    await f.call(runtime, { operation: 'import', meeting_id: id, project_id: null, retain: true });
    await f.processUntilIdle(runtime);
    const [row] = (await f.call(runtime, { operation: 'reviews' })).reviews;
    expect(row).toMatchObject({ first_line: 'Ship the cohort onboarding.', action_count: 1, meeting_at: '2026-10-06T16:00:00.000Z' });
    expect((await f.call(runtime, { operation: 'review_open', approval_id: row!.approval_id })).review).toEqual(row);
    const g = await fixture(), plain = g.create();
    await g.call(plain, { operation: 'import', meeting_id: id, project_id: null, retain: true });
    await g.processUntilIdle(plain);
    expect((await g.call(plain, { operation: 'reviews' })).reviews).toEqual([expect.objectContaining({ first_line: 'Ship the cohort onboarding.', action_count: 0, meeting_at: null })]);
  });
  it('counts every action on a review row, past 40, and the Authority still accepts its own list', async () => {
    const f = await fixture({ actions: 41 }), runtime = f.create();
    await f.call(runtime, { operation: 'import', meeting_id: id, project_id: null, retain: true });
    await f.processUntilIdle(runtime);
    const [row] = (await f.call(runtime, { operation: 'reviews' })).reviews;
    expect(row).toMatchObject({ first_line: 'Ship the cohort onboarding.', action_count: 41 });
    expect((await f.call(runtime, { operation: 'review_open', approval_id: row!.approval_id })).review).toEqual(row);
  });
  it('approvals() returns one core per runtime', async () => {
    const f = await fixture(), runtime = f.create();
    const core = await runtime.approvals();
    expect(await runtime.approvals()).toBe(core);
    expect(await f.create().approvals()).not.toBe(core);
  });
});
