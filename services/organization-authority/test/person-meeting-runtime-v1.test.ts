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
import { personMeetingReviewFixture } from './fixtures/person-meeting-review.js';
import { authorization, addMembership } from './fixtures/project-context-sqlite.js';
import { meeting as original, decisions } from '../../../packages/organization-processing/test/admitted-meeting-processing/fixtures/sqlite-meeting-state.js';
const id = '00000000-0000-4000-8000-000000000001';
const folder = '00000000-0000-4000-8000-000000000002';
const project = 'prj_00000000-0000-4000-8000-000000000003';
async function fixture() {
  const f = await personMeetingReviewFixture();
  f.db.prepare('INSERT INTO authority_project_authorization_state_v1 VALUES (?,0,?)').run(f.actor.organization_id, new Date().toISOString());
  const person = { organization_id: f.actor.organization_id, principal_id: f.actor.principal_id, membership_id: f.actor.membership_id };
  const other = { ...person, principal_id: 'prn_00000000-0000-4000-8000-000000000011', membership_id: 'mem_00000000-0000-4000-8000-000000000012' };
  addMembership(f.db, { ...other, membership_type: 'employee' }, 'Other', 'other@example.test');
  let active = true, extracted = 0, duringPull: (() => void | Promise<void>) | undefined;
  const current = () => { if (!active) throw new Error('Disconnected'); };
  const provider: PersonMeetingProviderV1 = {
    id: 'granola', normalizer_version: '2.2.0', cursor: { read: readGranolaCheckpointV1, write: writeGranolaCheckpointV1, policy: GRANOLA_FOLDER_CURSOR_POLICY_V1 },
    connection_http: { routes: [], async accept() { throw new Error('unused'); } },
    tool: () => ({ tool_id: 'granola', display_name: 'Granola', availability: 'enabled', personal_status: active ? 'linked' : 'revoked', external_scope_id: null, external_subject_id: null, organization_setup: null }),
    async open(actor, guard) {
      guard(); current();
      return { identity: { kind: 'meeting-source', adapter_id: 'granola-person-mcp', instance_id: `granola-${canonicalSha256(actor).slice(7)}`, version: '1.0.0' },
        custodian: { actor }, email: 'fixture@example.test', workspace: 'Fixture', current() { guard(); current(); },
        async folders() { return [{ id: folder, title: 'ECHO', count: 0 }]; }, async browse() { return { meetings: [] }; },
        async baseline(value) { return { folder: value, baseline: true, revisions: {}, manual: [] }; },
        async preview(value) { return { id: value, title: 'Test meeting', notes: 'Ship pilot.', summary: '', truncated: false }; },
      };
    },
    source(setting, guard) {
      const identity = { kind: 'meeting-source' as const, adapter_id: setting.source_adapter_id, instance_id: setting.source_adapter_instance_id, version: setting.source_adapter_version };
      return { identity, validateConfig: () => ({ ok: true, errors: [] }), healthCheck: async () => ({ status: 'healthy', checked_at: new Date().toISOString() }),
        requireCurrent() { guard(); current(); },
        async pull(input) {
          guard(); current(); const cursor = readGranolaCheckpointV1(input.cursor!);
          if (!cursor.manual[0]) return { meetings: [] };
          const meeting: MeetingDocument = { ...original, content: [...original.content, { id: 'private-transcript', kind: 'transcript', text: 'TRANSCRIPT_SECRET_DO_NOT_SHARE' }], title: 'Test meeting', provenance: { ...original.provenance, source: identity, external_id: cursor.manual[0], canonical_revision: canonicalSha256('meeting version') } };
          await duringPull?.();
          return { meetings: [meeting], next_cursor: writeGranolaCheckpointV1({ ...cursor, manual: cursor.manual.slice(1) }) };
        },
      };
    },
  };
  const sessions = { authenticateAccess: ({ access_token }: { access_token: string }) => authorization({ ...(access_token === 'owner' ? person : other), membership_type: access_token === 'owner' ? 'owner' : 'employee' }) };
  const create = () => createPersonMeetingRuntimeV1({ database: f.db, approval: f.context, provider,
    sessions,
    processor: { processor_adapter_id: 'llm', current_commitments: instance_id => ({ adapter_id: 'llm', instance_id, version: '1.0.0', configuration_sha256: canonicalSha256('processor'), credential_reference_sha256: canonicalSha256('ref') }), assert_admission_commitments() {},
      create_processor(admission) { const identity = { kind: 'decision-processor' as const, adapter_id: 'llm', instance_id: admission.processor.instance_id, version: admission.processor.version };
        return { identity, validateConfig: () => ({ ok: true, errors: [] }), healthCheck: async () => ({ status: 'healthy', checked_at: new Date().toISOString() }),
          async extract(meeting) { extracted++; return { ...decisions, meeting_id: meeting.id, meeting_revision: meeting.provenance.canonical_revision, processor: identity }; } };
      },
    },
    extraction_attempts: { reserve: () => ({ status: 'reserved', attempt: 1, claim_id: 'claim' }), complete() {} },
  });
  const call = async <K extends PersonMeetingOperationV1['operation']>(runtime: ReturnType<typeof create>, op: PersonMeetingOperationV1 & { operation: K }, token = 'owner') => {
    const response = await runtime.applications[1]!.accept({ route_id: 'personal-meetings', method: 'POST', path: '/v1/person/meetings', headers: { authorization: `Bearer ${token}` }, content_type: 'application/json', raw_body: Buffer.from(JSON.stringify({ schema_version: 1, tool_id: 'granola', ...op })) });
    if (!('body' in response)) throw new Error('Expected JSON');
    return response.body as PersonMeetingResultsV1[K];
  };
  const grantProject = () => {
    const time = new Date().toISOString();
    f.db.prepare("INSERT INTO authority_projects_v1 VALUES (?,?,?,'active',?,?,?,'owner')").run(project, person.organization_id, 'ECHO', time, person.principal_id, person.membership_id);
    f.db.prepare("INSERT INTO authority_project_memberships_v1 VALUES (?,?,?,?,?,'owner','lead','active',?,NULL)").run('pgm_00000000-0000-4000-8000-000000000005', project, person.organization_id, person.principal_id, person.membership_id, time);
  };
  return { ...f, person, other, sessions, create, call, grantProject, extracted: () => extracted, disconnect: () => { active = false; }, duringPull: (fn: () => void | Promise<void>) => { duringPull = fn; } };
}
describe('personal meeting intake uses the shared processing path', () => {
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
    expect(f.db.prepare('SELECT count(*) AS n FROM authority_person_meeting_sources_v1').get()).toEqual({ n: 0 });
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
  it('lists and cites imported originals in Mine and project scope, without releasing transcripts or outsider content', async () => {
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
    expect(page.items).toHaveLength(1); expect(page.items[0]?.kind).toBe('imported_meeting');
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
    await expect(list.open({ access_token: 'owner', request: { schema_version: 1, ref: page.items[0]!.ref } })).rejects.toMatchObject({ code: 'not_found' });
  });
  it('uses compare-and-set across clients and permits stopping after project access is revoked', async () => {
    const f = await fixture(), runtime = f.create(); f.grantProject();
    const home = await f.call(runtime, { operation: 'home' });
    const watch = { operation: 'watch' as const, folder_id: folder, project_id: project, retain: true as const, settings_sha256: home.settings_sha256 };
    await f.call(runtime, watch);
    await expect(f.call(f.create(), watch)).rejects.toMatchObject({ code: 'stale_access_state' });
    const next = await f.call(runtime, { operation: 'home' }); expect(next.sources[0]?.baseline).toBe(true);
    f.db.prepare("UPDATE authority_project_memberships_v1 SET status='revoked',revoked_at=? WHERE project_id=?").run(new Date().toISOString(), project);
    await f.call(runtime, { operation: 'watch', folder_id: null, project_id: null, retain: true, settings_sha256: next.settings_sha256 });
    expect((await f.call(runtime, { operation: 'home' })).sources[0]?.folder_id).toBeNull();
  });
});
