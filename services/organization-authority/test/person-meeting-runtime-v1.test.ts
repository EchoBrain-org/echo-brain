import { SqlitePersonOriginalContextRetrievalV1 } from '../src/adapters/persistence/sqlite/person-original-context-retrieval-v1.js';
import { SqlitePersonOriginalItemsV1 } from '../src/adapters/persistence/sqlite/person-original-items-v1.js';
import { createPersonListRouteV1 } from '../src/composition/person-list-v1-route.js';
import { SqlitePersonListDirectoryV1 } from '../src/adapters/persistence/sqlite/person-list-directory-v1.js';
import { describe, expect, it } from 'vitest';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import type { PersonMeetingOperationV1, PersonMeetingResultsV1 } from '@echo-brain/organization-api';
import type { MeetingDocument } from '@echo-brain/organization-processing/core';
import { readGranolaCheckpointV1, writeGranolaCheckpointV1, GRANOLA_FOLDER_CURSOR_POLICY_V1 } from '@echo-brain/provider-granola/granola-folder-source-v1';
import { createPersonMeetingRuntimeV1, type PersonMeetingProviderV1 } from '../src/composition/person-meeting-runtime-v1.js';
import { SqlitePersonMeetingIntakeV1 } from '../src/adapters/persistence/sqlite/person-meeting-intake-v1.js';
import { personMeetingReviewFixture } from './fixtures/person-meeting-review.js';
import { authorization, addMembership } from './fixtures/project-context-sqlite.js';
import { meeting as original, decisions } from '../../../packages/organization-processing/test/admitted-meeting-processing/fixtures/sqlite-meeting-state.js';
const id = '00000000-0000-4000-8000-000000000001';
const folder = '00000000-0000-4000-8000-000000000002';
const project = 'prj_00000000-0000-4000-8000-000000000003';
const projectB = 'prj_00000000-0000-4000-8000-000000000013';
const foreignProject = 'prj_00000000-0000-4000-8000-000000000023';
async function fixture(options: { readonly transcriptOnly?: boolean } = {}) {
  const f = await personMeetingReviewFixture();
  f.db.prepare('INSERT INTO authority_project_authorization_state_v1 VALUES (?,0,?)').run(f.actor.organization_id, new Date().toISOString());
  const person = { organization_id: f.actor.organization_id, principal_id: f.actor.principal_id, membership_id: f.actor.membership_id };
  const other = { ...person, principal_id: 'prn_00000000-0000-4000-8000-000000000011', membership_id: 'mem_00000000-0000-4000-8000-000000000012' };
  addMembership(f.db, { ...other, membership_type: 'employee' }, 'Other', 'other@example.test');
  let active = true, extracted = 0, duringPull: (() => void | Promise<void>) | undefined;
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
          if (!cursor.manual[0]) {
            if (cursor.folder === null || cursor.baseline) return { meetings: [] };
            await duringPull?.();
            return { meetings: [], next_cursor: writeGranolaCheckpointV1({ ...cursor, baseline: true, revisions: { [id]: canonicalSha256('historical meeting') } }) };
          }
          const transcript = { id: 'private-transcript', kind: 'transcript' as const, text: 'TRANSCRIPT_SECRET_DO_NOT_SHARE' };
          // A real provider names the meeting by its source instance, so two tool accounts never share a meeting id.
          const meeting: MeetingDocument = { ...original, id: `${identity.instance_id}:${cursor.manual[0]}`, content: options.transcriptOnly ? [transcript] : [...original.content, transcript], title: 'Test meeting', provenance: { ...original.provenance, source: identity, external_id: cursor.manual[0], canonical_revision: canonicalSha256('meeting version') } };
          await duringPull?.();
          return { meetings: [meeting], next_cursor: writeGranolaCheckpointV1({ ...cursor, manual: cursor.manual.slice(1) }) };
        },
      };
    },
  });
  const provider = fakeProvider('granola', GRANOLA_FOLDER_CURSOR_POLICY_V1.source_adapter_id);
  const sessions = { authenticateAccess: ({ access_token }: { access_token: string }) => authorization({ ...(access_token === 'owner' ? person : other), membership_type: access_token === 'owner' ? 'owner' : 'employee' }) };
  const create = (providers: readonly PersonMeetingProviderV1[] = [provider]) => createPersonMeetingRuntimeV1({ database: f.db, approval: f.context, providers,
    sessions,
    processor: { processor_adapter_id: 'llm', current_commitments: instance_id => ({ adapter_id: 'llm', instance_id, version: '1.0.0', configuration_sha256: canonicalSha256('processor'), credential_reference_sha256: canonicalSha256('ref') }), assert_admission_commitments() {},
      create_processor(admission) { const identity = { kind: 'decision-processor' as const, adapter_id: 'llm', instance_id: admission.processor.instance_id, version: admission.processor.version };
        return { identity, validateConfig: () => ({ ok: true, errors: [] }), healthCheck: async () => ({ status: 'healthy', checked_at: new Date().toISOString() }),
          async extract(meeting) { extracted++; return { ...decisions, meeting_id: meeting.id, meeting_revision: meeting.provenance.canonical_revision, processor: identity,
            signals: decisions.signals.map(signal => ({ ...signal, evidence: signal.evidence.map(evidence => ({ ...evidence, meeting_id: meeting.id })) })) }; } };
      },
    },
    extraction_attempts: { reserve: () => ({ status: 'reserved', attempt: 1, claim_id: 'claim' }), complete() {} },
  });
  const call = async <K extends PersonMeetingOperationV1['operation']>(runtime: ReturnType<typeof create>, op: PersonMeetingOperationV1 & { operation: K }, token = 'owner', tool_id = 'granola') => {
    const meetings = runtime.applications.find(application => application.routes.some(route => route.route_id === 'personal-meetings'))!;
    const response = await meetings.accept({ route_id: 'personal-meetings', method: 'POST', path: '/v1/person/meetings', headers: { authorization: `Bearer ${token}` }, content_type: 'application/json', raw_body: Buffer.from(JSON.stringify({ schema_version: 1, tool_id, ...op })) });
    if (!('body' in response)) throw new Error('Expected JSON');
    return response.body as PersonMeetingResultsV1[K];
  };
  let grants = 0;
  const grantProject = (project_id = project, member: 'owner' | 'other' = 'owner') => {
    const time = new Date().toISOString(), actor = member === 'owner' ? person : other, type = member === 'owner' ? 'owner' : 'employee';
    f.db.prepare("INSERT INTO authority_projects_v1 VALUES (?,?,?,'active',?,?,?,?)").run(project_id, person.organization_id, 'ECHO', time, actor.principal_id, actor.membership_id, type);
    f.db.prepare("INSERT INTO authority_project_memberships_v1 VALUES (?,?,?,?,?,?,'lead','active',?,NULL)").run(`pgm_00000000-0000-4000-8000-${String(5 + 10 * grants++).padStart(12, '0')}`, project_id, person.organization_id, actor.principal_id, actor.membership_id, type, time);
  };
  const intake = new SqlitePersonMeetingIntakeV1(f.db, provider.cursor);
  const processUntilIdle = async (runtime: ReturnType<typeof create>) => {
    for (let pass = 0; pass < 10 && intake.list().some(s => intake.checkpoint(s.source_key).manual.length > 0); pass++) await runtime.processing.pollAndStageAdmittedMeetings(new AbortController().signal);
  };
  const count = (table: string) => f.db.prepare(`SELECT count(*) FROM ${table}`).pluck().get();
  // The review fixture already holds one proposal of its own source, so proposals are counted per personal source.
  const proposals = (sourceKey: string) => f.db.prepare(`SELECT count(*) FROM authority_live_approval_outbox_v2 o
    JOIN authority_live_source_candidates_v2 c ON c.candidate_id=o.candidate_id
    JOIN authority_live_source_admission_v2 a ON a.semantic_input_sha256=c.admission_semantic_input_sha256 WHERE a.source_key=?`).pluck().get(sourceKey);
  return { ...f, person, other, sessions, create, call, grantProject, fakeProvider, sources, intake, processUntilIdle, count, proposals, extracted: () => extracted, disconnect: () => { active = false; }, duringPull: (fn: () => void | Promise<void>) => { duringPull = fn; } };
}
describe('personal meeting intake uses the shared processing path', () => {
  it('imports one note into two projects as one source and one extraction', async () => {
    const f = await fixture(), runtime = f.create(); f.grantProject(); f.grantProject(projectB);
    await f.call(runtime, { operation: 'import', meeting_id: id, project_id: project, retain: true });
    await f.call(runtime, { operation: 'import', meeting_id: id, project_id: projectB, retain: true });
    await f.processUntilIdle(runtime);
    expect(f.count('authority_person_meeting_sources_v2')).toBe(1);
    expect(f.extracted()).toBe(1);
    const [source] = (await f.call(runtime, { operation: 'home' })).sources;
    expect(f.proposals(source!.source_key)).toBe(1);
    expect((await f.call(runtime, { operation: 'reviews' })).reviews).toHaveLength(1);
    expect(f.intake.suggestions(source!.source_key, id)).toEqual([project, projectB].sort());
  });
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
    expect(pending).toMatchObject({ status: 'pending', project_id: project });
    f.db.prepare("UPDATE authority_project_memberships_v1 SET status='revoked',revoked_at=? WHERE project_id=?").run(new Date().toISOString(), project);
    expect((await f.call(runtime, { operation: 'reviews' })).reviews).toEqual([{ ...pending, project_id: null }]);
    const opened = await f.call(runtime, { operation: 'review_open', approval_id: pending!.approval_id });
    await expect(f.call(runtime, { operation: 'review', approval_id: pending!.approval_id, snapshot_sha256: opened.snapshot_sha256, command_id: 'approve-left-project', action: 'approve', project_id: project, share_transcript: false })).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(f.call(runtime, { operation: 'review', approval_id: pending!.approval_id, snapshot_sha256: opened.snapshot_sha256, command_id: 'approve-only-me', action: 'approve', project_id: null, share_transcript: false })).resolves.toEqual({ status: 'publishing' });
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
    await expect(f.call(runtime, { operation: 'review', approval_id: review.review.approval_id, snapshot_sha256: review.snapshot_sha256, command_id: 'invalid command id', action: 'approve', project_id: null, share_transcript: false })).rejects.toMatchObject({ code: 'invalid_request' });
    expect(f.db.prepare('SELECT count(*) FROM authority_person_meeting_approval_actions_v1').pluck().get()).toBe(0);
    f.disconnect();
    await f.call(runtime, { operation: 'review', approval_id: review.review.approval_id, snapshot_sha256: review.snapshot_sha256, command_id: 'approve-once', action: 'approve', project_id: null, share_transcript: false });
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
  it('lists and cites imported originals for the importer only, whatever project was suggested, without releasing transcripts', async () => {
    const f = await fixture(), runtime = f.create(); f.grantProject();
    await f.call(runtime, { operation: 'import', meeting_id: id, project_id: project, retain: true });
    await runtime.processing.pollAndStageAdmittedMeetings(new AbortController().signal);
    const originals = new SqlitePersonOriginalContextRetrievalV1(f.db, f.sessions, f.person.organization_id);
    const items = new SqlitePersonOriginalItemsV1(f.db, f.sessions, f.person.organization_id);
    const list = createPersonListRouteV1({ organization_id: f.person.organization_id, sessions: f.sessions, tools: async () => [], directory: new SqlitePersonListDirectoryV1(f.db), originals: items,
      meetings: { collectMeetings: () => ({ status: 'ok', rows: [], handle: {} }), commitMeetings: () => ({}), revalidateMeetingRelease() {}, admitMeeting() {}, openMeeting() { throw new Error('unused'); } },
      transcripts: { readApprovedMeetingTranscriptByRecordV1() { throw new Error('unused'); } },
    });
    const page = await list.list({ access_token: 'owner', request: { schema_version: 1, mine: true } });
    expect(page.items).toHaveLength(1); expect(page.items[0]).toMatchObject({ kind: 'imported_meeting', visibility: 'only_me' });
    const opened = await list.open({ access_token: 'owner', request: { schema_version: 1, ref: page.items[0]!.ref } });
    expect(JSON.stringify(opened)).toContain('Ship the cohort'); expect(JSON.stringify(opened)).not.toContain('TRANSCRIPT_SECRET');
    // A suggested project is not an audience: unapproved notes stay out of project scope until approval shares them.
    expect(originals.deskSearch({ access_token: 'owner', scope: { kind: 'project', project_id: project }, query: 'cohort', kinds: ['imported_meeting'] }).items).toEqual([]);
    const search = originals.deskSearch({ access_token: 'owner', scope: { kind: 'global' }, query: 'cohort', kinds: ['imported_meeting'] });
    expect(search.items).toHaveLength(1); expect(search.items[0]?.kind).toBe('imported_meeting');
    expect(originals.deskOpen({ access_token: 'owner', scope: { kind: 'mine' }, citation: search.items[0]!.citation }).items[0]?.text).toContain('Ship the cohort');
    expect(originals.deskSearch({ access_token: 'other', scope: { kind: 'global' }, query: 'cohort' }).items).toEqual([]);
    await expect(list.open({ access_token: 'other', request: { schema_version: 1, ref: page.items[0]!.ref } })).rejects.toMatchObject({ code: 'not_found' });
    expect(originals.deskSearch({ access_token: 'owner', scope: { kind: 'global' }, query: 'TRANSCRIPT_SECRET_DO_NOT_SHARE' }).items).toEqual([]);
    // Leaving the suggested project does not take the importer's own notes away.
    f.db.prepare("UPDATE authority_project_memberships_v1 SET status='revoked',revoked_at=? WHERE project_id=?").run(new Date().toISOString(), project);
    expect(JSON.stringify(await list.open({ access_token: 'owner', request: { schema_version: 1, ref: page.items[0]!.ref } }))).toContain('Ship the cohort');
  });
  it('opens a valid transcript-only imported meeting with no releasable body', async () => {
    const f = await fixture({ transcriptOnly: true }), runtime = f.create();
    await f.call(runtime, { operation: 'import', meeting_id: id, project_id: null, retain: true });
    await runtime.processing.pollAndStageAdmittedMeetings(new AbortController().signal);
    const items = new SqlitePersonOriginalItemsV1(f.db, f.sessions, f.person.organization_id);
    const list = createPersonListRouteV1({ organization_id: f.person.organization_id, sessions: f.sessions, tools: async () => [], directory: new SqlitePersonListDirectoryV1(f.db), originals: items,
      meetings: { collectMeetings: () => ({ status: 'ok', rows: [], handle: {} }), commitMeetings: () => ({}), revalidateMeetingRelease() {}, admitMeeting() {}, openMeeting() { throw new Error('unused'); } },
      transcripts: { readApprovedMeetingTranscriptByRecordV1() { throw new Error('unused'); } },
    });
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
    // The meetings API still names the watched folder's project `project_id`.
    expect((await f.call(runtime, { operation: 'home' })).sources[0]).toMatchObject({ folder_id: folder, project_id: project, baseline: false });
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
});
