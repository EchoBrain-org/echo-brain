import { SqlitePersonOriginalContextRetrievalV1 } from '../src/adapters/persistence/sqlite/person-original-context-retrieval-v1.js';
import { SqlitePersonOriginalItemsV1 } from '../src/adapters/persistence/sqlite/person-original-items-v1.js';
import { createPersonListRouteV1 } from '../src/composition/person-list-v1-route.js';
import { SqlitePersonListDirectoryV1 } from '../src/adapters/persistence/sqlite/person-list-directory-v1.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStagingSyntheticPersonalMeetingProviderV1, StagingSyntheticMeetingStoreV1 } from '@echo-brain/provider-synthetic-demo/staging-synthetic-personal-meeting-provider-v1';
const refusal = vi.hoisted(() => ({ next: 0 }));
vi.mock('@echo-brain/organization-protocol/record-codec-support-v4', async (importOriginal) => {
  const original = await importOriginal<typeof import('@echo-brain/organization-protocol/record-codec-support-v4')>();
  return { ...original, validateApprovedDecisionSnapshotV2(value: unknown) {
    if (refusal.next > 0) { refusal.next--; throw new Error('snapshot refused by the record codec'); }
    return original.validateApprovedDecisionSnapshotV2(value);
  } };
});
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { approvalRecordIdV2 } from '@echo-brain/organization-protocol';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import { coreRuntimeIdentityV1, observeCoreRuntimeDiagnosticV1, observeCoreRuntimeV1, type CoreRuntimeObservationV1, type CoreRuntimeObservationScopeV1 } from '@echo-brain/organization-authority-kernel/shared/core-runtime-observation-v1';
import type { PersonMeetingOperationV2, PersonMeetingResultsV2 } from '@echo-brain/organization-api';
import type { MeetingDocument } from '@echo-brain/organization-processing/core';
import { readGranolaCheckpointV1, writeGranolaCheckpointV1, GRANOLA_WATCH_CURSOR_POLICY_V1, GRANOLA_PERSONAL_CHECKPOINT_CODEC_V1 } from '@echo-brain/provider-granola/granola-watch-source-v1';
import { SqliteExtractionAttemptStoreV1 } from '@echo-brain/organization-processing/adapters/persistence/sqlite-extraction-attempt-store-v1';
import { AdapterError } from '@echo-brain/organization-processing/core/contracts/adapter';
import { providerStatusError } from '@echo-brain/organization-processing/llm/llm-provider';
import { SqliteAuthorityMeetingProcessingStateV1 } from '@echo-brain/organization-processing/admitted-meeting-processing/sqlite-authority-meeting-processing-state-v1';
import { createPersonDiagnosticsV1 } from '../src/composition/person-diagnostics-v1.js';
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
const ledgers: SqliteExtractionAttemptStoreV1[] = [];
afterEach(() => { for (const ledger of ledgers.splice(0)) ledger.close(); });
/** `actions` adds that many unowned actions (act-2, act-3, …) to what the extractor finds; `reasonsOnly` finds one rationale and nothing else. */
async function fixture(options: { readonly transcriptOnly?: boolean; readonly ownedAction?: boolean; readonly actions?: number; readonly started?: string; readonly path?: string; readonly reasonsOnly?: boolean } = {}) {
  const f = await approvalContextFixture(options.path === undefined ? {} : { path: options.path });
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
  let active = true, extracted = 0, duringPull: (() => void | Promise<void>) | undefined, duringExtract: (() => void | Promise<void>) | undefined, failExtraction: unknown, edition = '', pulls = 0;
  // One durable attempt ledger per Authority, shared by every runtime the test creates.
  const ledger = new SqliteExtractionAttemptStoreV1(new Database(':memory:'), { authority_id: 'aut_runtime', organization_id: 'org_runtime', state_lineage_id: 'lineage-runtime' });
  ledgers.push(ledger);
  // Meetings the watch delivers on its next scans after the baseline, what each browse read, and each watch Save checked.
  const folderDeliveries: string[] = [], browsed: (string | null)[] = [], watched: unknown[] = [];
  let windowFull = false;
  const current = () => { if (!active) throw new Error('Disconnected'); };
  const sources: { readonly tool_id: string; readonly source_key: string }[] = [];
  const fakeProvider = (tool_id: string, adapter_id: string): PersonMeetingProviderV1 => ({
    id: tool_id, normalizer_version: '2.2.0', cursor: { ...GRANOLA_PERSONAL_CHECKPOINT_CODEC_V1,
      policy: adapter_id === GRANOLA_WATCH_CURSOR_POLICY_V1.source_adapter_id ? GRANOLA_WATCH_CURSOR_POLICY_V1 : { source_adapter_id: adapter_id, assert_live_cursor(cursor) { readGranolaCheckpointV1(cursor); } } },
    connection_http: { routes: [], async accept() { throw new Error('unused'); } },
    tool: () => ({ tool_id, display_name: tool_id, availability: 'enabled', personal_status: active ? 'linked' : 'revoked', external_scope_id: null, external_subject_id: null, organization_setup: null }),
    async open(actor, guard) {
      guard(); current();
      return { identity: { kind: 'meeting-source', adapter_id, instance_id: `${tool_id}-${canonicalSha256(actor).slice(7)}`, version: '1.0.0' },
        custodian: { actor }, email: 'fixture@example.test', workspace: 'Fixture', current() { guard(); current(); },
        async folders() { return [{ id: folder, title: 'ECHO', count: 0 }]; }, async browse(value) { browsed.push(value); return { meetings: [] }; },
        async watchable(value) { watched.push(value); if (windowFull) throw new AuthorityOperationError('quota_exceeded', 'Granola lists more than 200 meetings to watch'); },
        async preview(value) { return { id: value, title: 'Test meeting', notes: 'Ship pilot.', summary: '', truncated: false }; },
      };
    },
    source(setting, guard) {
      sources.push({ tool_id, source_key: setting.source_key });
      const identity = { kind: 'meeting-source' as const, adapter_id: setting.source_adapter_id, instance_id: setting.source_adapter_instance_id, version: setting.source_adapter_version };
      return { identity, validateConfig: () => ({ ok: true, errors: [] }), healthCheck: async () => ({ status: 'healthy', checked_at: new Date().toISOString() }),
        requireCurrent() { guard(); current(); },
        async pull(input) {
          pulls++; guard(); current(); const cursor = readGranolaCheckpointV1(input.cursor!);
          const transcript = { id: 'private-transcript', kind: 'transcript' as const, text: 'TRANSCRIPT_SECRET_DO_NOT_SHARE' };
          // A real provider names the meeting by its source instance, so two tool accounts never share a meeting id.
          const build = (external: string): MeetingDocument => ({ ...original, id: `${identity.instance_id}:${external}`, content: options.transcriptOnly ? [transcript] : [...original.content, transcript], title: `Test meeting${edition}`, provenance: { ...original.provenance, source: identity, external_id: external, canonical_revision: canonicalSha256(`meeting version${edition}`) },
            ...(options.started === undefined ? {} : { time: { actual_start_at: options.started } }) });
          if (!cursor.manual[0]) {
            if (cursor.mode !== 'off' && cursor.baseline && folderDeliveries[0] !== undefined) {
              const delivered = folderDeliveries.shift()!;
              return { meetings: [build(delivered)], next_cursor: writeGranolaCheckpointV1({ ...cursor, seen: { ...cursor.seen, [delivered]: canonicalSha256('meeting version') } }) };
            }
            if (cursor.mode === 'off' || cursor.baseline) return { meetings: [] };
            await duringPull?.();
            return { meetings: [], next_cursor: writeGranolaCheckpointV1({ ...cursor, baseline: true, seen: { [id]: canonicalSha256('historical meeting') } }) };
          }
          const meeting = build(cursor.manual[0]);
          await duringPull?.();
          return { meetings: [meeting], next_cursor: writeGranolaCheckpointV1({ ...cursor, manual: cursor.manual.slice(1) }) };
        },
      };
    },
  });
  const provider = fakeProvider('granola', GRANOLA_WATCH_CURSOR_POLICY_V1.source_adapter_id);
  const sessions = { authenticateAccess: ({ access_token }: { access_token: string }) => authorization({ ...(actors[access_token as keyof typeof actors] ?? other), membership_type: access_token === 'owner' ? 'owner' : 'employee' }) };
  const create = (providers: readonly PersonMeetingProviderV1[] = [provider], seams: { readonly approval_core?: Parameters<typeof createPersonMeetingRuntimeV1>[0]['approval_core']; readonly record_append?: typeof f.context.record_append; readonly database?: Database.Database; readonly meeting_lanes?: number; readonly observation?: CoreRuntimeObservationScopeV1 } = {}) =>
    createPersonMeetingRuntimeV1({ database: seams.database ?? f.db, approval: seams.record_append === undefined ? f.context : { ...f.context, record_append: seams.record_append }, providers,
    sessions, ...(seams.approval_core === undefined ? {} : { approval_core: seams.approval_core }), ...(seams.meeting_lanes === undefined ? {} : { meeting_lanes: seams.meeting_lanes }),
    ...(seams.observation === undefined ? {} : { observation: seams.observation }),
    processor: { processor_adapter_id: 'llm', current_commitments: instance_id => ({ adapter_id: 'llm', instance_id, version: '1.0.0', configuration_sha256: canonicalSha256('processor'), credential_reference_sha256: canonicalSha256('ref') }), assert_admission_commitments() {},
      create_processor(admission) { const identity = { kind: 'decision-processor' as const, adapter_id: 'llm', instance_id: admission.processor.instance_id, version: admission.processor.version };
        return { identity, validateConfig: () => ({ ok: true, errors: [] }), healthCheck: async () => ({ status: 'healthy', checked_at: new Date().toISOString() }),
          async extract(meeting) {
            extracted++; await duringExtract?.();
            if (failExtraction !== undefined) { const failure = failExtraction; failExtraction = undefined; throw failure; }
            if (options.reasonsOnly) return { ...decisions, meeting_id: meeting.id, meeting_revision: meeting.provenance.canonical_revision, processor: identity,
              signals: [{ id: 'reason-1', kind: 'rationale' as const, text: 'The cohort is ready.', subject: null, confidence: 1, supports_signal_ids: [], evidence: [{ meeting_id: meeting.id, block_id: 'block-1' }] }] };
            return { ...decisions, meeting_id: meeting.id, meeting_revision: meeting.provenance.canonical_revision, processor: identity,
            signals: [...decisions.signals, ...(options.ownedAction ? [{ id: 'act-1', kind: 'action' as const, text: 'Send the pilot plan.', subject: null, confidence: 1, owner: 'Rafael Moreno', due_at: null,
              evidence: [{ meeting_id: meeting.id, block_id: 'block-1' }] }] : []),
              ...Array.from({ length: options.actions ?? 0 }, (_, i) => ({ id: `act-${i + 2}`, kind: 'action' as const, text: `Follow up on item ${i + 2}.`, subject: null, confidence: 1, owner: null, due_at: null,
                evidence: [{ meeting_id: meeting.id, block_id: 'block-1' }] }))].map(signal => ({ ...signal, evidence: signal.evidence.map(evidence => ({ ...evidence, meeting_id: meeting.id,
                  ...(toolIsSynthetic(meeting) ? { block_id: meeting.content[0]!.id } : {}) })) })) }; } };
      },
    },
    extraction_attempts: ledger,
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
    meetings: { collectMeetings: () => ({ status: 'ok', rows: [], handle: {} }), commitMeetings: () => ({}), revalidateMeetingRelease() {}, openMeeting() { throw new Error('unused'); } },
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
  /** Routes for every item of an open review, each to one destination (null = not kept, [] = Only me) or as chosen per item. */
  const routes = (opened: PersonMeetingResultsV2['review_open'], to: readonly string[] | null | ((item: PersonMeetingResultsV2['review_open']['items'][number]) => readonly string[] | null) = []) =>
    opened.items.map(item => ({ signal_id: item.signal_id, project_ids: typeof to === 'function' ? to(item) : to }));
  return { ...f, person, sessions, create, call, outbox, grantProject, join, leave, listRoute, readers, folderDeliveries, browsed, watched, fullWindow: (value = true) => { windowFull = value; }, fakeProvider, sources, intake, processUntilIdle, pendingReview, routes, count, proposals, extracted: () => extracted, disconnect: () => { active = false; }, duringPull: (fn: () => void | Promise<void>) => { duringPull = fn; },
    duringExtract: (fn: (() => void | Promise<void>) | undefined) => { duringExtract = fn; }, failNextExtraction: (error: unknown = new Error('extraction failed')) => { failExtraction = error; },
    ledger, pulls: () => pulls, revise: (value: string) => { edition = value; },
    held: () => f.db.prepare('SELECT * FROM authority_live_source_held_extractions_v1').all() as { external_id: string; failure_stage: string; extraction_admission_sha256: string; review_lineage_id: string; review_input_sha256: string }[] };
}
function toolIsSynthetic(meeting: MeetingDocument) { return meeting.provenance.source.adapter_id === 'staging-synthetic-meeting'; }
/** The owner's held status: IDs and the allowlisted stage only. */
const heldError = (external: string, stage = 'unknown', next = 'An operator can authorize one more attempt.') =>
  `Meeting ${external} is held after extraction attempt 1 failed at ${stage}. Later meetings continue. ${next}`;
describe('personal meeting intake uses the shared processing path', () => {
  it.each([false, true])('captures one authorized extraction, keeps normal traces private, and joins its approval (failed=%s)', async failed => {
    const f = await fixture(), events: CoreRuntimeObservationV1[] = [];
    const observation = { observer: (event: CoreRuntimeObservationV1) => { events.push(event); } };
    const runtime = f.create(undefined, { observation });
    const diagnostics = createPersonDiagnosticsV1({ sessions: f.sessions });
    runtime.attachDiagnostics(diagnostics);
    const failures: unknown[] = [];
    const process = async () => {
      await runtime.processing.pollAndStageAdmittedMeetings(new AbortController().signal, failure => { failures.push(failure); });
      await runtime.processing.settle!();
      expect(failures).toEqual([]);
    };
    try {
      await f.call(runtime, { operation: 'import', meeting_id: id, project_id: null, retain: true });
      const source = f.intake.list(f.person)[0]!;
      const capture = await diagnostics.prepare({ access_token: 'owner', request: { schema_version: 1, operation: 'prepare', target: {
        kind: 'meeting_extraction', source_key: source.source_key, meeting_id: id,
      } } });
      f.duringExtract(() => { observeCoreRuntimeDiagnosticV1({ kind: 'model_response', role: 'extraction', call_id: 1, value: 'PRIVATE EXTRACTION' }); });
      if (failed) f.failNextExtraction(new AdapterError('temporarily_unavailable', 'LLM output contained invalid or unsupported signal grounding at stage: evidence_quote', true));
      await process();
      const read = () => diagnostics.read({ access_token: 'owner', request: { schema_version: 1, operation: 'read', capture_id: capture.capture_id } });
      expect(await read()).toMatchObject({ status: failed ? 'failed' : 'completed', trace: { complete: true, events: [
        { stage: 'extraction', event: 'started' }, { kind: 'model_response', value: 'PRIVATE EXTRACTION' },
        { stage: 'extraction', event: failed ? 'failed' : 'succeeded' },
      ] } });
      expect(f.extracted()).toBe(1);
      const extraction = events.find(event => event.phase === 'extraction' && event.event !== 'started')!;
      expect(extraction).toMatchObject({ attempt: 1, meeting_id: expect.stringMatching(/^[a-f0-9]{64}$/), event: failed ? 'failed' : 'succeeded' });
      if (failed) {
        expect(f.held()).toHaveLength(1);
        expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ phase: 'worker_execution', result: 'held' })]));
        expect(events.some(event => event.phase === 'approval_staging')).toBe(false);
      } else {
        const [review] = (await f.call(runtime, { operation: 'reviews' })).reviews;
        const approval_id = coreRuntimeIdentityV1('approval', review!.approval_id);
        expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ phase: 'approval_staging', event: 'succeeded', meeting_id: extraction.meeting_id, approval_id, result: 'published' })]));
        await observeCoreRuntimeV1('http_request', () => f.call(runtime, { operation: 'review_open', approval_id: review!.approval_id }), observation);
        expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ phase: 'approval_review', event: 'succeeded', approval_id, approval_surface: 'desktop', result: 'returned' })]));
      }
      await f.call(runtime, { operation: 'import', meeting_id: folder, project_id: null, retain: true });
      await process();
      expect(f.extracted()).toBe(2);
      expect((await read()).trace!.events).toHaveLength(3);
      for (const text of ['PRIVATE EXTRACTION', 'TRANSCRIPT_SECRET_DO_NOT_SHARE', id, source.source_key]) expect(JSON.stringify(events)).not.toContain(text);
      // Source settings are revalidated when exporting the private payload, even after success/failure.
      f.db.prepare('UPDATE authority_person_meeting_sources_v2 SET settings_revision=settings_revision+1 WHERE source_key=?').run(source.source_key);
      expect(await read()).not.toHaveProperty('trace');
    } finally { diagnostics.close(); runtime.close(); f.db.close(); }
  });

  it('submits a custom synthetic meeting through extraction, one human review and one after-record trigger, surviving retries', async () => {
    const f = await fixture(), storage = new Database(':memory:');
    try {
      f.grantProject();
      const provider = createStagingSyntheticPersonalMeetingProviderV1({ custom_store: new StagingSyntheticMeetingStoreV1(storage) });
      const calls: AfterApprovedRecordEventV1[] = [];
      const create = () => f.create([provider], { approval_core: { after_record: [(_db, event) => { calls.push(event); }] } });
      let runtime = create();
      const meeting = { id: 'synthetic-custom-cohort-review', title: 'Cohort rehearsal', notes: 'Ship the cohort onboarding.', transcript: 'Synthetic speaker: ship the cohort onboarding.' };
      const submit = { operation: 'submit', meeting, project_id: project, retain: true } as const;
      await expect(f.call(runtime, submit, 'owner', 'synthetic')).resolves.toEqual({ status: 'queued', meeting_id: meeting.id });
      await f.call(runtime, submit, 'owner', 'synthetic');
      expect(calls).toEqual([]);
      const intake = new SqlitePersonMeetingIntakeV1(f.db, provider.cursor);
      expect(intake.checkpoint(intake.list()[0]!.source_key).manual).toEqual([meeting.id]);
      // Restart the shared runtime before processing the durable queue.
      runtime = create();
      for (let i = 0; i < 3; i++) await runtime.processing.pollAndStageAdmittedMeetings(new AbortController().signal);
      const [pending] = (await f.call(runtime, { operation: 'reviews' }, 'owner', 'synthetic')).reviews;
      expect(pending).toMatchObject({ title: 'SYNTHETIC STAGING - Cohort rehearsal', status: 'pending', project_ids: [project] });
      expect(f.extracted()).toBe(1); expect(calls).toEqual([]);
      expect((await f.call(runtime, { operation: 'reviews' }, 'other', 'synthetic')).reviews).toEqual([]);
      const opened = await f.call(runtime, { operation: 'review_open', approval_id: pending!.approval_id }, 'owner', 'synthetic');
      const approve = { operation: 'review', approval_id: pending!.approval_id, snapshot_sha256: opened.snapshot_sha256,
        command_id: 'synthetic-review-1', action: 'approve', routes: f.routes(opened, [project]), owners: [] } as const;
      await f.call(runtime, approve, 'owner', 'synthetic');
      await runtime.processing.appendFinalizedApprovalsToV4(new AbortController().signal);
      expect(calls).toHaveLength(1);
      await f.call(runtime, submit, 'owner', 'synthetic');
      await runtime.processing.pollAndStageAdmittedMeetings(new AbortController().signal);
      await runtime.processing.appendFinalizedApprovalsToV4(new AbortController().signal);
      expect(f.extracted()).toBe(1); expect(calls).toHaveLength(1);
      expect((await f.call(runtime, { operation: 'reviews' }, 'owner', 'synthetic')).reviews).toHaveLength(1);
      expect(f.db.prepare("SELECT source_custodian_assurance FROM authority_live_source_admission_v2 WHERE source_adapter_id='staging-synthetic-meeting'").pluck().get()).toBe('staging_synthetic');
    } finally { storage.close(); }
  });

  it('refuses custom submissions by employees, outside a joined project, or without the staging capability', async () => {
    const f = await fixture(), storage = new Database(':memory:');
    try {
      const provider = createStagingSyntheticPersonalMeetingProviderV1({ custom_store: new StagingSyntheticMeetingStoreV1(storage) });
      const runtime = f.create([provider]);
      const submit = { operation: 'submit', meeting: { id: 'synthetic-custom-one', title: 'Test', notes: 'Ship the cohort onboarding.', transcript: '' }, project_id: null, retain: true } as const;
      await expect(f.call(runtime, submit, 'other', 'synthetic')).rejects.toMatchObject({ code: 'unauthorized' });
      f.grantProject(foreignProject, 'other');
      await expect(f.call(runtime, { ...submit, project_id: foreignProject }, 'owner', 'synthetic')).rejects.toMatchObject({ code: 'unauthorized' });
      await expect(f.call(f.create(), submit, 'owner', 'synthetic')).rejects.toMatchObject({ code: 'not_found' });
      await expect(f.call(f.create([createStagingSyntheticPersonalMeetingProviderV1({})]), submit, 'owner', 'synthetic')).rejects.toMatchObject({ code: 'not_found' });
      expect(storage.prepare('SELECT count(*) FROM staging_custom_meetings_v1').pluck().get()).toBe(0);
      expect(f.intake.list()).toHaveLength(0);
    } finally { storage.close(); }
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
    expect(pending).toMatchObject({ status: 'pending', project_ids: [project] });
    f.db.prepare("UPDATE authority_project_memberships_v1 SET status='revoked',revoked_at=? WHERE project_id=?").run(new Date().toISOString(), project);
    expect((await f.call(runtime, { operation: 'reviews' })).reviews).toEqual([{ ...pending, project_ids: [] }]);
    const opened = await f.call(runtime, { operation: 'review_open', approval_id: pending!.approval_id });
    expect(opened.suggested_projects).toEqual([]);
    // The left project is no longer a suggestion: every item starts Only me.
    expect(opened.items.map(item => item.project_ids)).toEqual(opened.items.map(() => []));
    await expect(f.call(runtime, { operation: 'review', approval_id: pending!.approval_id, snapshot_sha256: opened.snapshot_sha256, command_id: 'approve-left-project', action: 'approve', routes: f.routes(opened, [project]), owners: [] })).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(f.call(runtime, { operation: 'review', approval_id: pending!.approval_id, snapshot_sha256: opened.snapshot_sha256, command_id: 'approve-only-me', action: 'approve', routes: f.routes(opened, []), owners: [] })).resolves.toEqual({ status: 'publishing', decided_on: 'desktop' });
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
    await expect(f.call(runtime, { operation: 'review', approval_id: review.review.approval_id, snapshot_sha256: review.snapshot_sha256, command_id: 'invalid command id', action: 'approve', routes: f.routes(review), owners: [] })).rejects.toMatchObject({ code: 'invalid_request' });
    expect(f.db.prepare('SELECT count(*) FROM authority_approval_decisions_v1').pluck().get()).toBe(0);
    f.disconnect();
    await f.call(runtime, { operation: 'review', approval_id: review.review.approval_id, snapshot_sha256: review.snapshot_sha256, command_id: 'approve-once', action: 'approve', routes: f.routes(review), owners: [] });
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
  it('lists and cites imported originals for their importer alone, in global and Mine scope and never in project scope, without releasing transcripts', async () => {
    const f = await fixture(), runtime = f.create(); f.grantProject(); f.join(project, 'reader-a');
    await f.call(runtime, { operation: 'import', meeting_id: id, project_id: project, retain: true });
    await runtime.processing.pollAndStageAdmittedMeetings(new AbortController().signal);
    const originals = new SqlitePersonOriginalContextRetrievalV1(f.db, f.sessions, f.person.organization_id);
    const list = f.listRoute();
    const page = await list.list({ access_token: 'owner', request: { schema_version: 1, mine: true } });
    expect(page.items).toHaveLength(1); expect(page.items[0]).toMatchObject({ kind: 'imported_meeting', visibility: 'only_me', projects: [] });
    const opened = await list.open({ access_token: 'owner', request: { schema_version: 1, ref: page.items[0]!.ref } });
    expect(JSON.stringify(opened)).toContain('Ship the cohort'); expect(JSON.stringify(opened)).not.toContain('TRANSCRIPT_SECRET');
    // A suggested project grants nothing: its scope holds no unapproved notes, for its members or the importer.
    for (const token of ['owner', 'reader-a']) {
      expect(originals.deskSearch({ access_token: token, scope: { kind: 'project', project_id: project }, query: 'cohort', kinds: ['imported_meeting'] }).items).toEqual([]);
    }
    const search = originals.deskSearch({ access_token: 'owner', scope: { kind: 'global' }, query: 'cohort', kinds: ['imported_meeting'] });
    expect(search.items).toHaveLength(1); expect(search.items[0]?.kind).toBe('imported_meeting');
    expect(originals.deskOpen({ access_token: 'owner', scope: { kind: 'mine' }, citation: search.items[0]!.citation }).items[0]?.text).toContain('Ship the cohort');
    for (const token of ['other', 'reader-a']) {
      expect(originals.deskSearch({ access_token: token, scope: { kind: 'global' }, query: 'cohort' }).items).toEqual([]);
      expect(() => originals.deskOpen({ access_token: token, scope: { kind: 'global' }, citation: search.items[0]!.citation })).toThrow();
      await expect(list.open({ access_token: token, request: { schema_version: 1, ref: page.items[0]!.ref } })).rejects.toMatchObject({ code: 'not_found' });
    }
    expect(originals.deskSearch({ access_token: 'owner', scope: { kind: 'global' }, query: 'TRANSCRIPT_SECRET_DO_NOT_SHARE' }).items).toEqual([]);
    f.db.prepare("UPDATE authority_project_memberships_v1 SET status='revoked',revoked_at=? WHERE project_id=?").run(new Date().toISOString(), project);
    // Project scope itself still needs current project membership; the importer's own notes do not.
    expect(() => originals.deskSearch({ access_token: 'owner', scope: { kind: 'project', project_id: project }, query: 'cohort' })).toThrow();
    expect(originals.deskSearch({ access_token: 'owner', scope: { kind: 'global' }, query: 'cohort', kinds: ['imported_meeting'] }).items).toHaveLength(1);
    expect(JSON.stringify(await list.open({ access_token: 'owner', request: { schema_version: 1, ref: page.items[0]!.ref } }))).toContain('Ship the cohort');
  });
  it.each([undefined, '2026-10-02T15:00:00.000Z'])('dates imported notes by their meeting when recorded and by their arrival, and counts them where a date cannot test them (started: %s)', async started => {
    const f = await fixture(started === undefined ? {} : { started }), runtime = f.create();
    await f.call(runtime, { operation: 'import', meeting_id: id, project_id: null, retain: true });
    await runtime.processing.pollAndStageAdmittedMeetings(new AbortController().signal);
    const originals = new SqlitePersonOriginalContextRetrievalV1(f.db, f.sessions, f.person.organization_id);
    const scope = { kind: 'global' } as const;
    const [note] = originals.deskSearch({ access_token: 'owner', scope, query: 'cohort', kinds: ['imported_meeting'] }).items;
    expect(note!.dates).toEqual({ ...(started === undefined ? {} : { occurred: started }), received: note!.received_at });
    const arrived = note!.received_at.slice(0, 10);
    const read = (filter: { readonly since: string; readonly until: string; readonly date_field?: 'occurred' | 'approved' | 'received' | 'due' | 'any' }) => {
      const listed = originals.deskSearch({ access_token: 'owner', scope, source: 'meeting', ...filter });
      expect(listed).not.toHaveProperty('notice');
      return { items: listed.items.length, unchecked: listed.unchecked };
    };
    const day = (value: string) => ({ since: value, until: value });
    const recorded = started === undefined ? ['received'] : ['occurred', 'received'];
    // Imported notes are never approved, and only a meeting's actions are due.
    for (const date_field of ['approved', 'due'] as const) expect(read({ ...day(arrived), date_field })).toEqual({ items: 0, unchecked: { count: 1, dates: recorded } });
    expect(read({ ...day(arrived), date_field: 'received' })).toEqual({ items: 1, unchecked: undefined });
    expect(read({ ...day(arrived), date_field: 'any' })).toEqual({ items: 1, unchecked: undefined });
    if (started === undefined) {
      // No field is the meeting's time, as before: notes without one are counted, never a notice.
      expect(read(day('2026-10-02'))).toEqual({ items: 0, unchecked: { count: 1, dates: ['received'] } });
      expect(read({ ...day('2026-10-02'), date_field: 'occurred' })).toEqual({ items: 0, unchecked: { count: 1, dates: ['received'] } });
    } else {
      expect(read(day('2026-10-02'))).toEqual({ items: 1, unchecked: undefined });
      expect(read({ ...day('2026-10-02'), date_field: 'any' })).toEqual({ items: 1, unchecked: undefined });
    }
    // Someone who cannot read the import never has it counted.
    expect(originals.deskSearch({ access_token: 'other', scope, source: 'meeting', ...day(arrived), date_field: 'approved' })).not.toHaveProperty('unchecked');
  });
  it.each([false, true])('never shares the transcript from an approval, and keeps the importer\'s notes readable (project audience: %s)', async (sharedWithProject) => {
    const f = await fixture(), runtime = f.create();
    f.grantProject(); f.join(project, 'reader-a'); f.grantProject(projectB); f.join(projectB, 'reader-b');
    await f.call(runtime, { operation: 'import', meeting_id: id, project_id: project, retain: true });
    await f.processUntilIdle(runtime);
    const [pending] = (await f.call(runtime, { operation: 'reviews' })).reviews;
    const review = await f.call(runtime, { operation: 'review_open', approval_id: pending!.approval_id });
    await f.call(runtime, { operation: 'review', approval_id: pending!.approval_id, snapshot_sha256: review.snapshot_sha256,
      command_id: 'approve-no-transcript', action: 'approve', routes: f.routes(review, sharedWithProject ? [projectB] : []), owners: [] });
    await runtime.processing.recoverV4Appends(new AbortController().signal);
    f.disconnect(); // Reading retained evidence must not require a provider connection.
    expect(JSON.parse(f.record.prepare('SELECT canonical_envelope FROM organization_record_log').pluck().get() as string).body.human_act_resolution_ref.share_transcript).toBe(false);
    const originals = new SqlitePersonOriginalContextRetrievalV1(f.db, f.sessions, f.person.organization_id);
    const scope = { kind: 'global' } as const;
    const notes = originals.deskSearch({ access_token: 'owner', scope, query: 'cohort', kinds: ['imported_meeting'] });
    expect(notes.items).toHaveLength(1);
    expect(JSON.stringify(notes.items)).not.toContain('TRANSCRIPT_SECRET');
    expect(originals.deskOpen({ access_token: 'owner', scope, citation: notes.items[0]!.citation }).items[0]?.kind).toBe('imported_meeting');
    for (const token of ['owner', 'reader-a', 'reader-b', 'other']) {
      expect(originals.deskSearch({ access_token: token, scope, query: 'TRANSCRIPT_SECRET_DO_NOT_SHARE' }).items).toEqual([]);
    }
  });
  it('keeps a meeting the watch delivers private to its importer, with the watch\'s project frozen only as a suggestion', async () => {
    const f = await fixture(); f.grantProject(); f.join(project, 'reader-a'); f.grantProject(projectB); f.join(projectB, 'reader-b');
    const home = await f.call(f.create(), { operation: 'home' });
    await f.call(f.create(), { operation: 'watch', watch: 'folder', folder_id: folder, project_id: project, retain: true, settings_sha256: home.settings_sha256 });
    expect(f.watched).toEqual([{ watch: 'folder', folder_id: folder }]);
    await f.create().processing.pollAndStageAdmittedMeetings(new AbortController().signal); // baseline
    f.folderDeliveries.push(id);
    await f.create().processing.pollAndStageAdmittedMeetings(new AbortController().signal);
    expect(f.folderDeliveries).toEqual([]); expect(f.extracted()).toBe(1);
    const [source] = (await f.call(f.create(), { operation: 'home' })).sources;
    expect(f.intake.suggestions(source!.source_key, id)).toEqual([project]);
    expect(JSON.parse(f.outbox(source!.source_key)[0]!.suggested_projects_json!)).toEqual([project]);
    expect(await f.readers()).toEqual(['owner']);
    const watched = await f.call(f.create(), { operation: 'home' });
    await f.call(f.create(), { operation: 'watch', watch: 'folder', folder_id: folder, project_id: projectB, retain: true, settings_sha256: watched.settings_sha256 });
    expect((await f.call(f.create(), { operation: 'home' })).sources[0]).toMatchObject({ watch: 'folder', folder_id: folder, project_id: projectB });
    f.join(project, 'reader-b');
    expect(await f.readers()).toEqual(['owner']);
  });
  it('watches the meetings the person captured with no folder and no project', async () => {
    const f = await fixture(); f.grantProject(); f.join(project, 'reader-a');
    const home = await f.call(f.create(), { operation: 'home' });
    for (const invalid of [{ watch: 'folder', folder_id: null, project_id: null }, { watch: 'mine', folder_id: folder, project_id: null }, { watch: 'off', folder_id: null, project_id: project }] as const) {
      await expect(f.call(f.create(), { operation: 'watch', ...invalid, retain: true, settings_sha256: home.settings_sha256 })).rejects.toMatchObject({ code: 'invalid_request' });
    }
    await expect(f.call(f.create(), { operation: 'watch', watch: 'mine', folder_id: null, project_id: null, retain: true, settings_sha256: home.settings_sha256 })).resolves.toEqual({ status: 'saved' });
    expect(f.watched).toEqual([{ watch: 'mine', folder_id: null }]);
    expect((await f.call(f.create(), { operation: 'home' })).sources).toEqual([expect.objectContaining({ watch: 'mine', folder_id: null, project_id: null, baseline: false })]);
    await f.create().processing.pollAndStageAdmittedMeetings(new AbortController().signal); // baseline
    expect((await f.call(f.create(), { operation: 'home' })).sources[0]).toMatchObject({ watch: 'mine', baseline: true, error: null });
    f.folderDeliveries.push(id);
    await f.create().processing.pollAndStageAdmittedMeetings(new AbortController().signal);
    const [source] = (await f.call(f.create(), { operation: 'home' })).sources;
    expect(f.intake.suggestions(source!.source_key, id)).toEqual([]);
    expect((await f.call(f.create(), { operation: 'reviews' })).reviews).toEqual([expect.objectContaining({ status: 'pending', project_ids: [] })]);
    expect(await f.readers()).toEqual(['owner']);
  });
  it('makes no review of a meeting with no decision and no action, and keeps it in its importer\'s context', async () => {
    const f = await fixture({ reasonsOnly: true }), runtime = f.create(); f.grantProject(); f.join(project, 'reader-a');
    await f.call(runtime, { operation: 'import', meeting_id: id, project_id: project, retain: true });
    await f.processUntilIdle(runtime);
    const [source] = (await f.call(runtime, { operation: 'home' })).sources;
    expect([f.extracted(), source!.pending_imports, source!.error, f.proposals(source!.source_key)]).toEqual([1, [], null, 0]);
    expect((await f.call(runtime, { operation: 'reviews' })).reviews).toEqual([]);
    expect(await f.readers()).toEqual(['owner']);
  });
  it('keeps a private import with the importer even while a folder is watched', async () => {
    const f = await fixture(); f.grantProject(); f.join(project, 'reader-a');
    const home = await f.call(f.create(), { operation: 'home' });
    await f.call(f.create(), { operation: 'watch', watch: 'folder', folder_id: folder, project_id: project, retain: true, settings_sha256: home.settings_sha256 });
    await f.create().processing.pollAndStageAdmittedMeetings(new AbortController().signal); // baseline
    await f.call(f.create(), { operation: 'import', meeting_id: id, project_id: null, retain: true });
    await f.processUntilIdle(f.create());
    expect(f.extracted()).toBe(1);
    const [source] = (await f.call(f.create(), { operation: 'home' })).sources;
    expect(f.intake.suggestions(source!.source_key, id)).toEqual([]);
    expect(await f.readers()).toEqual(['owner']);
  });
  it('keeps a note imported with projects readable by its importer alone, recording the projects as suggestions', async () => {
    const f = await fixture(), runtime = f.create(); f.grantProject(); f.join(project, 'reader-a'); f.grantProject(projectB); f.join(projectB, 'reader-b');
    await f.call(runtime, { operation: 'import', meeting_id: id, project_id: project, retain: true });
    // The project choice waits as pending until processing consumes the queued import.
    expect(f.count('authority_person_meeting_suggestions_v1')).toBe(0);
    expect(f.count('authority_person_meeting_pending_suggestions_v1')).toBe(1);
    await f.processUntilIdle(runtime);
    const [source] = (await f.call(runtime, { operation: 'home' })).sources;
    expect(f.intake.suggestions(source!.source_key, id)).toEqual([project]);
    expect(f.count('authority_person_meeting_pending_suggestions_v1')).toBe(0);
    expect(await f.readers()).toEqual(['owner']);
    const revisions = f.count('authority_source_revisions_v1');
    await f.call(runtime, { operation: 'import', meeting_id: id, project_id: projectB, retain: true });
    expect(await f.readers()).toEqual(['owner']);
    await f.processUntilIdle(f.create());
    // The unchanged revision is re-admitted as a duplicate; that admission consumes the queued import and promotes B.
    expect(f.count('authority_source_revisions_v1')).toBe(revisions); expect(f.extracted()).toBe(1);
    expect(f.intake.suggestions(source!.source_key, id)).toEqual([project, projectB].sort());
    expect(f.count('authority_person_meeting_pending_suggestions_v1')).toBe(0);
    expect(await f.readers()).toEqual(['owner']);
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
    await f.call(f.create(), { operation: 'watch', watch: 'folder', folder_id: folder, project_id: projectB, retain: true, settings_sha256: home.settings_sha256 });
    await f.create().processing.pollAndStageAdmittedMeetings(new AbortController().signal); // baseline
    await f.call(f.create(), { operation: 'import', meeting_id: id, project_id: project, retain: true });
    const [queued] = (await f.call(f.create(), { operation: 'home' })).sources;
    await f.call(f.create(), { operation: 'cancel_import', source_key: queued!.source_key, meeting_id: id });
    f.folderDeliveries.push(id);
    await f.create().processing.pollAndStageAdmittedMeetings(new AbortController().signal);
    expect(f.folderDeliveries).toEqual([]); expect(f.extracted()).toBe(1);
    expect(f.intake.suggestions(queued!.source_key, id)).toEqual([projectB]);
    expect(f.count('authority_person_meeting_pending_suggestions_v1')).toBe(0);
    expect(await f.readers()).toEqual(['owner']);
  });
  it.each([false, true])('grants, stages and parks nothing when the import is cancelled while its admitted meeting is being extracted (extraction fails: %s)', async (fails) => {
    const f = await fixture(), runtime = f.create(); f.grantProject(); f.join(project, 'reader-a');
    await f.call(runtime, { operation: 'import', meeting_id: id, project_id: project, retain: true });
    const [queued] = (await f.call(runtime, { operation: 'home' })).sources;
    if (fails) f.failNextExtraction();
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
    expect((await f.call(runtime, { operation: 'reviews' })).reviews).toEqual([]);
    expect(f.held()).toEqual([]);
    expect(await f.readers()).toEqual(['owner']);
  });
  it.each([false, true])('keeps the paid result and an import queued during its extraction (extraction fails: %s)', async (fails) => {
    const f = await fixture(), runtime = f.create(), b = '00000000-0000-4000-8000-000000000004'; f.grantProject(); f.grantProject(projectB);
    const poll = async () => { await runtime.processing.pollAndStageAdmittedMeetings(new AbortController().signal); return (await f.call(runtime, { operation: 'home' })).sources[0]!; };
    const reviews = async () => (await f.call(runtime, { operation: 'reviews' })).reviews.length;
    await f.call(runtime, { operation: 'import', meeting_id: id, project_id: project, retain: true });
    if (fails) f.failNextExtraction();
    f.duringExtract(async () => { f.duringExtract(undefined); await f.call(runtime, { operation: 'import', meeting_id: b, project_id: projectB, retain: true }); });
    const source = await poll();
    expect(source.pending_imports).toEqual([b]);
    expect(f.extracted()).toBe(1);
    expect(await reviews()).toBe(fails ? 0 : 1);
    expect(f.held()).toEqual(fails ? [expect.objectContaining({ external_id: id, failure_stage: 'unknown' })] : []);
    // The advance consumed A's import only: B's project choice waits for B.
    expect(f.intake.suggestions(source.source_key, id)).toEqual([project]);
    expect(f.count('authority_person_meeting_pending_suggestions_v1')).toBe(1);
    expect((await poll()).pending_imports).toEqual([]);
    expect(f.extracted()).toBe(2);
    expect(await reviews()).toBe(fails ? 1 : 2);
  });
  it.each([false, true])('keeps the paid result when another queued import is cancelled during its extraction (extraction fails: %s)', async (fails) => {
    const f = await fixture(), runtime = f.create(), x = '00000000-0000-4000-8000-000000000004';
    for (const meeting_id of [id, x]) await f.call(runtime, { operation: 'import', meeting_id, project_id: null, retain: true });
    const [queued] = (await f.call(runtime, { operation: 'home' })).sources;
    if (fails) f.failNextExtraction();
    f.duringExtract(async () => { f.duringExtract(undefined); await f.call(runtime, { operation: 'cancel_import', source_key: queued!.source_key, meeting_id: x }); });
    await runtime.processing.pollAndStageAdmittedMeetings(new AbortController().signal);
    expect(f.intake.checkpoint(queued!.source_key).manual).toEqual([]);
    expect(f.extracted()).toBe(1);
    expect((await f.call(runtime, { operation: 'reviews' })).reviews).toHaveLength(fails ? 0 : 1);
    // A failure parks with its own stage, not the blocked path's not_recorded.
    expect(f.held()).toEqual(fails ? [expect.objectContaining({ external_id: id, failure_stage: 'unknown' })] : []);
  });
  it('advances past a re-staged meeting whose first advance never ran, after another import is cancelled', async () => {
    const f = await fixture(), runtime = f.create(), x = '00000000-0000-4000-8000-000000000004', stopping = new AbortController();
    for (const meeting_id of [id, x]) await f.call(runtime, { operation: 'import', meeting_id, project_id: null, retain: true });
    const [queued] = (await f.call(runtime, { operation: 'home' })).sources;
    // The freeze fails while the poll is stopping: the candidate stays queued and nothing advances.
    refusal.next = 1; f.duringExtract(() => { f.duringExtract(undefined); stopping.abort(); });
    await expect(runtime.processing.pollAndStageAdmittedMeetings(stopping.signal)).rejects.toThrow();
    expect(f.intake.checkpoint(queued!.source_key).manual).toEqual([id, x]);
    await f.call(runtime, { operation: 'cancel_import', source_key: queued!.source_key, meeting_id: x });
    await runtime.processing.pollAndStageAdmittedMeetings(new AbortController().signal);
    expect(f.intake.checkpoint(queued!.source_key).manual).toEqual([]);
    expect((await f.call(runtime, { operation: 'reviews' })).reviews).toHaveLength(1);
    expect(f.extracted()).toBe(1);
  });
  it('runs one pass per source at a time: a poll skips a source in flight and a targeted pass waits for it', async () => {
    const f = await fixture(), runtime = f.create(), signal = new AbortController().signal;
    const advances = vi.spyOn(SqliteAuthorityMeetingProcessingStateV1.prototype, 'advanceCursor');
    try {
      await f.call(runtime, { operation: 'import', meeting_id: id, project_id: null, retain: true });
      const [setting] = f.intake.list();
      let release!: () => void, targeted = false;
      const gate = new Promise<void>(resolve => { release = resolve; });
      f.duringExtract(() => { f.duringExtract(undefined); return gate; });
      const periodic = runtime.processing.pollAndStageAdmittedMeetings(signal);
      let pass: Promise<void> | undefined;
      try {
        await vi.waitFor(() => expect(f.extracted()).toBe(1));
        pass = runtime.pollAndStageSource(setting!.source_key, signal).then(() => { targeted = true; });
        await runtime.processing.pollAndStageAdmittedMeetings(signal);
        // A waiter whose caller gives up leaves without registering a pass.
        const stop = new AbortController(), abandoned = runtime.pollAndStageSource(setting!.source_key, stop.signal);
        stop.abort(); await expect(abandoned).rejects.toThrow();
        expect([f.pulls(), targeted]).toEqual([1, false]);
        release(); await Promise.all([periodic, pass]);
        expect([f.extracted(), f.pulls(), f.proposals(setting!.source_key), advances.mock.calls.length]).toEqual([1, 1, 1, 1]);
      } finally { release(); await Promise.allSettled([periodic, pass]); }
    } finally { advances.mockRestore(); }
  });
  it('lets a second runtime on another handle find the extraction in flight: no error, park or cursor move', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'person-runtime-'));
    try {
      const f = await fixture({ path: join(directory, 'authority.sqlite') }), first = f.create();
      const handle = new Database(join(directory, 'authority.sqlite')); handle.pragma('foreign_keys=ON'); handle.pragma('busy_timeout=5000');
      try {
        const second = f.create(undefined, { database: handle });
        await f.call(first, { operation: 'import', meeting_id: id, project_id: null, retain: true });
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        f.duringExtract(() => { f.duringExtract(undefined); return gate; });
        const running = first.processing.pollAndStageAdmittedMeetings(new AbortController().signal);
        try {
          await vi.waitFor(() => expect(f.extracted()).toBe(1));
          await second.processing.pollAndStageAdmittedMeetings(new AbortController().signal);
          const [source] = (await f.call(second, { operation: 'home' })).sources;
          expect([source!.error, source!.pending_imports, f.held(), f.extracted()]).toEqual([null, [id], [], 1]);
          // The head in flight elsewhere backs its source off instead of being pulled again at once.
          const pulls = f.pulls(); await second.processing.pollAndStageAdmittedMeetings(new AbortController().signal);
          expect(f.pulls()).toBe(pulls);
          release(); await running;
          expect(f.proposals(source!.source_key)).toBe(1);
        } finally { release(); await Promise.allSettled([running]); }
      } finally { handle.close(); }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it('runs sources in detached lanes, never one source twice, and reports a failing lane without stalling the others', async () => {
    const f = await fixture(), b = '00000000-0000-4000-8000-000000000004', failures: unknown[] = [];
    let settles = 0;
    // The notes tool's source throws a non-Error before any pull.
    const runtime = f.create([f.fakeProvider('granola', 'granola-person-mcp'), { ...f.fakeProvider('notes', 'notes-person-mcp'), source() { throw 'boom'; } }]);
    for (const [meeting_id, token, tool] of [[id, 'owner', 'granola'], [b, 'owner', 'granola'], [id, 'other', 'granola'], [id, 'owner', 'notes']] as const) {
      await f.call(runtime, { operation: 'import', meeting_id, project_id: null, retain: true }, token, tool);
    }
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    f.duringExtract(() => gate);
    try {
      await runtime.processing.pollAndStageAdmittedMeetings(new AbortController().signal, failure => { failures.push(failure); }, () => { settles++; });
      await vi.waitFor(() => expect([f.extracted(), settles]).toEqual([2, 1]));
      // Let the failed lane's queued top-up run while both successful extractions remain held.
      await new Promise<void>(resolve => setImmediate(resolve));
      // Two sources extract at once; the failed lane's free slot never starts the owner's second import beside its first.
      expect([f.extracted(), f.pulls(), failures, settles]).toEqual([2, 2, ['boom'], 1]);
      release(); await runtime.processing.settle?.();
      // The owner's lane topped up with its second import as it settled; every settled lane said so.
      expect([f.extracted(), failures, settles]).toEqual([3, ['boom'], 4]);
    } finally { release(); await runtime.processing.settle?.(true); }
  });
  it('starts no more passes than the lane count and tops up as one settles', async () => {
    const f = await fixture(), runtime = f.create(undefined, { meeting_lanes: 2 });
    for (const token of ['owner', 'other', 'reader-a']) await f.call(runtime, { operation: 'import', meeting_id: id, project_id: null, retain: true }, token);
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    f.duringExtract(() => gate);
    try {
      await runtime.processing.pollAndStageAdmittedMeetings(new AbortController().signal, () => undefined);
      await vi.waitFor(() => expect(f.extracted()).toBe(2));
      // Another poll cannot fill an occupied lane while its extraction is held.
      await runtime.processing.pollAndStageAdmittedMeetings(new AbortController().signal, () => undefined);
      expect([f.extracted(), f.pulls()]).toEqual([2, 2]);
      release(); await runtime.processing.settle?.();
      expect(f.extracted()).toBe(3);
    } finally { release(); await runtime.processing.settle?.(true); }
  });
  it('starts no lane once shutdown has asked it to stop', async () => {
    const f = await fixture(), runtime = f.create();
    await f.call(runtime, { operation: 'import', meeting_id: id, project_id: null, retain: true });
    await runtime.processing.settle?.(true);
    await runtime.processing.pollAndStageAdmittedMeetings(new AbortController().signal, () => undefined);
    await runtime.processing.settle?.();
    expect(f.extracted()).toBe(0);
  });
  it('settles only after the top-up a settling lane starts', async () => {
    const f = await fixture(), runtime = f.create(), b = '00000000-0000-4000-8000-000000000004';
    for (const meeting_id of [id, b]) await f.call(runtime, { operation: 'import', meeting_id, project_id: null, retain: true });
    // `settled` runs after the lane has left the in-flight set and before its top-up starts the next import.
    let settling: Promise<unknown> | undefined;
    await runtime.processing.pollAndStageAdmittedMeetings(new AbortController().signal, () => undefined,
      () => { settling ??= runtime.processing.settle!().then(() => f.count('authority_live_approval_outbox_v2')); });
    await vi.waitFor(() => expect(settling).toBeDefined());
    expect(await settling).toBe(2);
  });
  it('starts no lane for a minute after a transient provider failure, then resumes', async () => {
    const f = await fixture(), runtime = f.create(undefined, { meeting_lanes: 1 });
    for (const token of ['owner', 'other']) await f.call(runtime, { operation: 'import', meeting_id: id, project_id: null, retain: true }, token);
    const cycle = async () => { await runtime.processing.pollAndStageAdmittedMeetings(new AbortController().signal, () => undefined); await runtime.processing.settle?.(); };
    f.failNextExtraction(new AdapterError('timeout', 'provider timed out', true));
    // Neither the failed lane's top-up nor the next cycle starts the other person's import.
    await cycle(); await cycle();
    expect([f.extracted(), f.held()]).toEqual([1, [expect.objectContaining({ failure_stage: 'timeout' })]]);
    const later = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000);
    try { await cycle(); expect(f.extracted()).toBe(2); } finally { later.mockRestore(); }
  });
  it.each([false, true])('retries an unbilled first failure once, automatically, from the head of its queue (the retry fails: %s)', async (failsAgain) => {
    const f = await fixture(), runtime = f.create();
    const poll = async () => { await runtime.processing.pollAndStageAdmittedMeetings(new AbortController().signal); return (await f.call(runtime, { operation: 'home' })).sources[0]!; };
    await f.call(runtime, { operation: 'import', meeting_id: id, project_id: null, retain: true });
    f.failNextExtraction(providerStatusError('OpenRouter', 429, true));
    // Not parked, still queued, no operator wording: one grant for the exact key.
    expect(await poll()).toMatchObject({ pending_imports: [id], error: null });
    const [attempt] = f.ledger.listLatest();
    expect([f.held(), attempt]).toEqual([[], expect.objectContaining({ attempt: 1, outcome: 'failed', failure_code: 'rate_limited', retry_authorized: true })]);
    await poll();
    expect(f.extracted()).toBe(1);
    const later = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000);
    try {
      if (failsAgain) f.failNextExtraction(providerStatusError('OpenRouter', 503, true));
      // The next poll re-runs it and consumes the grant; a second unbilled failure parks it.
      expect((await poll()).pending_imports).toEqual([]);
      expect(f.extracted()).toBe(2);
      expect((await f.call(runtime, { operation: 'reviews' })).reviews).toHaveLength(failsAgain ? 0 : 1);
      expect(f.held()).toEqual(failsAgain ? [expect.objectContaining({ external_id: id, failure_stage: 'temporarily_unavailable' })] : []);
      expect(f.ledger.inspect(attempt!)).toMatchObject({ attempt: 2, outcome: failsAgain ? 'failed' : 'succeeded', retry_authorized: false });
    } finally { later.mockRestore(); }
  });
  it('consumes an import whose extraction failed and records its project choice, as for a staged one', async () => {
    const f = await fixture(), runtime = f.create(); f.grantProject(); f.join(project, 'reader-a');
    await f.call(runtime, { operation: 'import', meeting_id: id, project_id: project, retain: true });
    f.failNextExtraction();
    await runtime.processing.pollAndStageAdmittedMeetings(new AbortController().signal);
    const [held] = (await f.call(runtime, { operation: 'home' })).sources;
    expect(held).toMatchObject({ pending_imports: [], error: heldError(id) });
    expect(f.intake.suggestions(held!.source_key, id)).toEqual([project]);
    expect(f.count('authority_person_meeting_pending_suggestions_v1')).toBe(0);
    expect(await f.readers()).toEqual(['owner']);
  });
  it.each(['granola', 'synthetic'] as const)('parks a failed meeting and stages the next one in its %s source on the next poll', async (tool) => {
    const f = await fixture(), storage = new Database(':memory:');
    try {
      const runtime = tool === 'granola' ? f.create() : f.create([createStagingSyntheticPersonalMeetingProviderV1({ custom_store: new StagingSyntheticMeetingStoreV1(storage) })]);
      const [a, b] = tool === 'granola' ? [id, '00000000-0000-4000-8000-000000000004'] : ['synthetic-custom-held-a', 'synthetic-custom-next-b'];
      for (const meeting_id of [a, b]) {
        await f.call(runtime, tool === 'granola' ? { operation: 'import', meeting_id, project_id: null, retain: true }
          : { operation: 'submit', meeting: { id: meeting_id, title: meeting_id, notes: 'Ship the cohort onboarding.', transcript: '' }, project_id: null, retain: true }, 'owner', tool);
      }
      const poll = async () => { await runtime.processing.pollAndStageAdmittedMeetings(new AbortController().signal); return (await f.call(runtime, { operation: 'home' }, 'owner', tool)).sources[0]; };
      f.failNextExtraction();
      // No backoff: the held meeting's source stays eligible for the next queued meeting.
      expect(await poll()).toMatchObject({ pending_imports: [b], error: heldError(a) });
      expect(f.held()).toEqual([expect.objectContaining({ external_id: a, failure_stage: 'unknown' })]);
      expect(await poll()).toMatchObject({ pending_imports: [], error: heldError(a) });
      expect((await f.call(runtime, { operation: 'reviews' }, 'owner', tool)).reviews).toHaveLength(1);
      expect(f.extracted()).toBe(2);
    } finally { storage.close(); }
  });
  it('keeps a held meeting parked across a restart with no model call, and parks a legacy blocked head as not_recorded', async () => {
    const f = await fixture();
    const importAndPoll = async () => {
      const runtime = f.create();
      await f.call(runtime, { operation: 'import', meeting_id: id, project_id: null, retain: true });
      await runtime.processing.pollAndStageAdmittedMeetings(new AbortController().signal);
      return (await f.call(runtime, { operation: 'home' })).sources[0];
    };
    f.failNextExtraction();
    const source = await importAndPoll();
    const [row] = f.held();
    const key = { admission_sha256: row!.extraction_admission_sha256, review_lineage_id: row!.review_lineage_id, review_input_sha256: row!.review_input_sha256 };
    // The parked revision is rebuilt from source custody, as an operator retry reads it.
    const state = new SqliteAuthorityMeetingProcessingStateV1(f.db, GRANOLA_WATCH_CURSOR_POLICY_V1, 'llm', undefined, source!.source_key);
    const [listed] = await state.listHeldExtractions();
    expect(listed).toMatchObject({ external_id: id, key, attempt: 1, failure_stage: 'unknown' });
    expect((await state.readHeldMeeting(listed!)).provenance).toMatchObject({ external_id: id, canonical_revision: listed!.revision_id });
    // A new runtime on the same Authority and ledger: importing the meeting again spends nothing.
    expect(await importAndPoll()).toMatchObject({ pending_imports: [], error: heldError(id) });
    expect(f.held()).toEqual([expect.objectContaining({ external_id: id, failure_stage: 'unknown' })]);
    expect(f.ledger.history(key)).toHaveLength(1);
    expect(f.ledger.inspect(key)).toEqual({ attempt: 1, outcome: 'failed', failure_code: 'unknown', reserved_at: expect.any(String), retry_authorized: false });
    // Before parking existed, a failed head had a ledger attempt and no held row.
    f.db.prepare('DELETE FROM authority_live_source_held_extractions_v1').run();
    expect(await importAndPoll()).toMatchObject({ pending_imports: [], error: heldError(id, 'not_recorded') });
    expect(f.held()).toEqual([expect.objectContaining({ external_id: id, failure_stage: 'not_recorded' })]);
    expect(f.extracted()).toBe(1);
  });
  it('drops the held row when a newer revision of the meeting becomes a candidate', async () => {
    const f = await fixture(), runtime = f.create();
    const importAndPoll = async () => {
      await f.call(runtime, { operation: 'import', meeting_id: id, project_id: null, retain: true });
      await runtime.processing.pollAndStageAdmittedMeetings(new AbortController().signal);
    };
    f.failNextExtraction();
    await importAndPoll();
    expect(f.held()).toHaveLength(1);
    f.revise(' (edited)');
    await importAndPoll();
    expect(f.held()).toEqual([]);
    expect((await f.call(runtime, { operation: 'reviews' })).reviews).toHaveLength(1);
    expect(f.extracted()).toBe(2);
  });
  it('re-runs from custody only the held meeting whose exact key an operator authorized, once', async () => {
    const f = await fixture(), runtime = f.create(), b = '00000000-0000-4000-8000-000000000004';
    const poll = () => runtime.processing.pollAndStageAdmittedMeetings(new AbortController().signal);
    // A fresh runtime reads the status from durable rows alone.
    const error = async () => (await f.call(f.create(), { operation: 'home' })).sources[0]!.error;
    for (const meeting_id of [id, b]) await f.call(runtime, { operation: 'import', meeting_id, project_id: null, retain: true });
    f.failNextExtraction(); await poll();
    f.failNextExtraction(); await poll();
    const row = (external: string) => f.held().find(held => held.external_id === external)!;
    const key = { admission_sha256: row(id).extraction_admission_sha256, review_lineage_id: row(id).review_lineage_id, review_input_sha256: row(id).review_input_sha256 };
    const heldB = row(b);
    expect(await error()).toBe(heldError(id));
    // A grant for another key of A's lineage does not trigger A.
    const other = { ...key, review_input_sha256: `sha256:${'f'.repeat(64)}` }, claim = f.ledger.reserve(other);
    if (claim.status !== 'reserved') throw new Error('test reservation failed');
    f.ledger.complete({ key: other, ...claim, outcome: 'failed', failure_code: 'unknown' });
    expect(f.ledger.authorizeRetry({ key: other, expected_attempt: 1, expected_outcome: 'failed' })).toBe('authorized');
    await poll();
    expect(f.extracted()).toBe(2);
    expect(f.ledger.authorizeRetry({ key, expected_attempt: 1, expected_outcome: 'failed' })).toBe('authorized');
    expect(await error()).toBe(heldError(id, 'unknown', 'A retry is authorized and runs on the next check.'));
    const pulls = f.pulls();
    // An import queued during the retry's model call does not discard its paid result.
    f.duringExtract(async () => { f.duringExtract(undefined); await f.call(runtime, { operation: 'import', meeting_id: b, project_id: null, retain: true }); });
    await poll();
    expect(f.pulls()).toBe(pulls); expect(f.extracted()).toBe(3);
    expect(f.held()).toEqual([heldB]);
    expect((await f.call(runtime, { operation: 'reviews' })).reviews).toHaveLength(1);
    expect(await error()).toBe(heldError(b));
    // The grant is spent.
    expect(f.ledger.inspect(key)).toMatchObject({ attempt: 2, outcome: 'succeeded', retry_authorized: false });
    await poll();
    expect(f.extracted()).toBe(3);
  });
  it('lets a queued import stage when an authorized retry cannot reserve', async () => {
    const f = await fixture(), runtime = f.create(), b = '00000000-0000-4000-8000-000000000004';
    const poll = () => runtime.processing.pollAndStageAdmittedMeetings(new AbortController().signal);
    await f.call(runtime, { operation: 'import', meeting_id: id, project_id: null, retain: true });
    f.failNextExtraction(); await poll();
    // A granted held key that no longer matches custody: the retry refuses before reserving.
    const [row] = f.held(), key = { admission_sha256: row!.extraction_admission_sha256, review_lineage_id: row!.review_lineage_id, review_input_sha256: `sha256:${'f'.repeat(64)}` };
    f.db.prepare('UPDATE authority_live_source_held_extractions_v1 SET review_input_sha256 = ?').run(key.review_input_sha256);
    const claim = f.ledger.reserve(key);
    if (claim.status !== 'reserved') throw new Error('test reservation failed');
    f.ledger.complete({ key, ...claim, outcome: 'failed', failure_code: 'unknown' });
    f.ledger.authorizeRetry({ key, expected_attempt: 1, expected_outcome: 'failed' });
    await f.call(runtime, { operation: 'import', meeting_id: b, project_id: null, retain: true });
    await poll(); await poll();
    expect((await f.call(runtime, { operation: 'reviews' })).reviews).toHaveLength(1);
    expect(f.extracted()).toBe(2);
    expect(f.held()).toEqual([expect.objectContaining({ external_id: id })]);
  });
  it('forgets a held meeting the person cancels', async () => {
    const f = await fixture(), runtime = f.create();
    await f.call(runtime, { operation: 'import', meeting_id: id, project_id: null, retain: true });
    f.failNextExtraction();
    await runtime.processing.pollAndStageAdmittedMeetings(new AbortController().signal);
    const [source] = (await f.call(runtime, { operation: 'home' })).sources;
    await f.call(runtime, { operation: 'cancel_import', source_key: source!.source_key, meeting_id: id });
    expect(f.held()).toEqual([]);
    expect((await f.call(runtime, { operation: 'home' })).sources[0]!.error).toBeNull();
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
    expect(await f.readers()).toEqual(['owner']);
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
    const originals = new SqlitePersonOriginalContextRetrievalV1(f.db, f.sessions, f.person.organization_id);
    const release = originals.deskSearch({ access_token: 'owner', scope: { kind: 'global' }, kinds: ['imported_meeting'] });
    expect(release).toMatchObject({ items: [], release: { released_atoms: [] }, truncated: false });
    expect(() => originals.revalidateDeskRelease({ access_token: 'owner', release })).not.toThrow();
  });
  it('lists readable meeting evidence past transcript-only imports', async () => {
    const f = await fixture(), storage = new Database(':memory:');
    try {
      const provider = createStagingSyntheticPersonalMeetingProviderV1({ custom_store: new StagingSyntheticMeetingStoreV1(storage) });
      const runtime = f.create([provider]);
      // Newer transcript-only imports must not consume the evidence limit or
      // hide the older notes. The transcripts have no sharing approval.
      for (let index = 0; index < 5; index++) {
        const meeting = { id: `synthetic-custom-inventory-${index}`, title: `Inventory meeting ${index}`, notes: index < 2 ? 'Ship the cohort onboarding.' : '', transcript: 'TRANSCRIPT_SECRET_DO_NOT_SHARE' };
        await f.call(runtime, { operation: 'submit', meeting, project_id: null, retain: true }, 'owner', 'synthetic');
        await runtime.processing.pollAndStageAdmittedMeetings(new AbortController().signal);
      }
      const listed = await f.listRoute().list({ access_token: 'owner', request: { schema_version: 1, mine: true } });
      expect(listed.items).toHaveLength(5);
      const originals = new SqlitePersonOriginalContextRetrievalV1(f.db, f.sessions, f.person.organization_id);
      for (const limit of [1, 2]) {
        const release = originals.deskSearch({ access_token: 'owner', scope: { kind: 'global' }, kinds: ['imported_meeting'], limit });
        expect(release.items).toHaveLength(limit);
        expect(release.truncated).toBe(limit === 1);
        expect(release.release.released_atoms.every(atom => atom.text.includes('Ship the cohort onboarding.'))).toBe(true);
        expect(JSON.stringify(release)).not.toContain('TRANSCRIPT_SECRET_DO_NOT_SHARE');
        expect(() => originals.revalidateDeskRelease({ access_token: 'owner', release })).not.toThrow();
      }
    } finally { storage.close(); }
  });
  it('saves a pending watch before the background baseline finishes, survives restart, and retains no history', async () => {
    const f = await fixture(), runtime = f.create(); f.grantProject();
    const home = await f.call(runtime, { operation: 'home' });
    await expect(f.call(runtime, { operation: 'watch', watch: 'folder', folder_id: folder, project_id: project, retain: true, settings_sha256: home.settings_sha256 })).resolves.toEqual({ status: 'saved' });
    expect((await f.call(runtime, { operation: 'home' })).sources[0]).toMatchObject({ watch: 'folder', folder_id: folder, project_id: project, baseline: false });
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
    await f.call(runtime, { operation: 'watch', watch: 'mine', folder_id: null, project_id: project, retain: true, settings_sha256: home.settings_sha256 });
    const pending = await f.call(runtime, { operation: 'home' });
    expect(pending.sources[0]?.baseline).toBe(false);
    f.duringPull(async () => { await f.call(runtime, { operation: 'watch', watch: 'off', folder_id: null, project_id: null, retain: true, settings_sha256: pending.settings_sha256 }); });
    const before = f.db.prepare('SELECT count(*) FROM authority_source_revisions_v1').pluck().get();
    await runtime.processing.pollAndStageAdmittedMeetings(new AbortController().signal);
    expect((await f.call(runtime, { operation: 'home' })).sources[0]).toMatchObject({ watch: 'off', folder_id: null, project_id: null, baseline: false });
    expect(f.db.prepare('SELECT count(*) FROM authority_source_revisions_v1').pluck().get()).toBe(before);
    expect(f.extracted()).toBe(0);
  });
  it('uses compare-and-set across clients and permits stopping after project access is revoked', async () => {
    const f = await fixture(), runtime = f.create(); f.grantProject();
    const home = await f.call(runtime, { operation: 'home' });
    const watch = { operation: 'watch' as const, watch: 'folder' as const, folder_id: folder, project_id: project, retain: true as const, settings_sha256: home.settings_sha256 };
    await f.call(runtime, watch);
    await expect(f.call(f.create(), watch)).rejects.toMatchObject({ code: 'stale_access_state' });
    const next = await f.call(runtime, { operation: 'home' }); expect(next.sources[0]?.baseline).toBe(false);
    f.db.prepare("UPDATE authority_project_memberships_v1 SET status='revoked',revoked_at=? WHERE project_id=?").run(new Date().toISOString(), project);
    await f.call(runtime, { operation: 'watch', watch: 'off', folder_id: null, project_id: null, retain: true, settings_sha256: next.settings_sha256 });
    expect((await f.call(runtime, { operation: 'home' })).sources[0]).toMatchObject({ watch: 'off', folder_id: null, project_id: null });
  });
  it('changes only the suggestion of an unchanged watch, so its change detection carries on', async () => {
    const f = await fixture(); f.grantProject(); f.grantProject(projectB);
    const home = await f.call(f.create(), { operation: 'home' });
    await f.call(f.create(), { operation: 'watch', watch: 'folder', folder_id: folder, project_id: project, retain: true, settings_sha256: home.settings_sha256 });
    await f.create().processing.pollAndStageAdmittedMeetings(new AbortController().signal); // baseline
    const watched = await f.call(f.create(), { operation: 'home' });
    const [source] = watched.sources;
    expect(source).toMatchObject({ project_id: project, baseline: true });
    const checkpoint = f.intake.checkpoint(source!.source_key);
    await f.call(f.create(), { operation: 'watch', watch: 'folder', folder_id: folder, project_id: projectB, retain: true, settings_sha256: watched.settings_sha256 });
    const changed = await f.call(f.create(), { operation: 'home' });
    expect(changed.sources).toEqual([expect.objectContaining({ watch: 'folder', folder_id: folder, project_id: projectB, baseline: true })]);
    expect(changed.settings_sha256).not.toBe(watched.settings_sha256);
    expect(f.intake.checkpoint(source!.source_key)).toEqual(checkpoint);
    // The next meeting the watch delivers takes the new suggestion.
    f.folderDeliveries.push(id);
    await f.create().processing.pollAndStageAdmittedMeetings(new AbortController().signal);
    expect(f.intake.suggestions(source!.source_key, id)).toEqual([projectB]);
  });
  it('refuses at Save a watch whose window holds more than 200 meetings, and names the cap when the worker meets it later', async () => {
    const f = await fixture(), runtime = f.create();
    const home = await f.call(runtime, { operation: 'home' });
    const mine = { operation: 'watch' as const, watch: 'mine' as const, folder_id: null, project_id: null, retain: true as const, settings_sha256: home.settings_sha256 };
    f.fullWindow();
    await expect(f.call(runtime, mine)).rejects.toMatchObject({ code: 'quota_exceeded' });
    expect((await f.call(runtime, { operation: 'home' })).sources).toEqual([]);
    f.fullWindow(false);
    await expect(f.call(runtime, mine)).resolves.toEqual({ status: 'saved' });
    expect(f.watched).toEqual([{ watch: 'mine', folder_id: null }, { watch: 'mine', folder_id: null }]);
    // The window grew past the cap after Save: the status says so, rather than blaming the connection.
    f.duringPull(() => { throw new AuthorityOperationError('quota_exceeded', 'Granola lists more than 200 meetings to watch'); });
    await runtime.processing.pollAndStageAdmittedMeetings(new AbortController().signal);
    const [full] = (await f.call(runtime, { operation: 'home' })).sources;
    expect(full).toMatchObject({ baseline: false, error: 'More than 200 meetings in 7 days. Choose one folder.' });
    f.duringPull(() => { throw new AuthorityOperationError('unavailable', 'Granola operation could not be completed'); });
    await runtime.pollAndStageSource(full!.source_key, new AbortController().signal);
    expect((await f.call(runtime, { operation: 'home' })).sources[0]).toMatchObject({ error: 'Meeting intake needs attention. Check the connection and folder access.' });
  });
  it('leaves no status behind when the person stops a failing watch', async () => {
    const f = await fixture(), runtime = f.create();
    const home = await f.call(runtime, { operation: 'home' });
    await f.call(runtime, { operation: 'watch', watch: 'mine', folder_id: null, project_id: null, retain: true, settings_sha256: home.settings_sha256 });
    f.duringPull(() => { throw new AuthorityOperationError('unavailable', 'Granola operation could not be completed'); });
    await runtime.processing.pollAndStageAdmittedMeetings(new AbortController().signal);
    const failing = await f.call(runtime, { operation: 'home' });
    expect(failing.sources[0]).toMatchObject({ error: expect.stringContaining('needs attention'), checked_at: expect.any(String) });
    await f.call(runtime, { operation: 'watch', watch: 'off', folder_id: null, project_id: null, retain: true, settings_sha256: failing.settings_sha256 });
    expect((await f.call(runtime, { operation: 'home' })).sources[0]).toMatchObject({ watch: 'off', error: null, checked_at: null });
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
    expect(await f.readers()).toEqual(['owner']);
  });
  it('approves into the chosen project through the route', async () => {
    const f = await fixture(), runtime = f.create(); f.grantProject(); f.grantProject(projectB);
    const { pending, opened } = await f.pendingReview(runtime, project);
    await expect(f.call(runtime, { operation: 'review', approval_id: pending!.approval_id, snapshot_sha256: opened.snapshot_sha256, command_id: 'approve-b', action: 'approve', routes: f.routes(opened, [projectB]), owners: [] }))
      .resolves.toEqual({ status: 'publishing', decided_on: 'desktop' });
    const body = JSON.parse(f.db.prepare('SELECT body_json FROM authority_approval_decisions_v1').pluck().get() as string);
    expect(body).toMatchObject({ surface: 'desktop', request: { routes: f.routes(opened, [projectB]), owners: [] }, evidence: { kind: 'person-session' } });
    expect(Object.keys(body.request).sort()).toEqual(['action', 'approval_id', 'command_id', 'owners', 'routes', 'snapshot_sha256']);
    await runtime.processing.recoverV4Appends(new AbortController().signal);
    const envelope = JSON.parse(f.record.prepare('SELECT canonical_envelope FROM organization_record_log').pluck().get() as string);
    expect(envelope.body.human_act_resolution_ref.audience_project_ids).toEqual([projectB]);
    expect((await f.call(runtime, { operation: 'reviews' })).reviews[0]).toMatchObject({ status: 'approved', project_ids: [projectB], decided_on: 'desktop',
      records: [{ approval_id: approvalRecordIdV2(pending!.approval_id, [projectB]), project_ids: [projectB] }] });
  });
  it('opens a pending review as items with their suggested destinations and proposed owners, and a decided one as chosen', async () => {
    const f = await fixture({ ownedAction: true, actions: 1 }), runtime = f.create(); f.grantProject(); f.grantProject(projectB);
    const { pending, opened } = await f.pendingReview(runtime, project);
    expect(Object.keys(opened).sort()).toEqual(['items', 'participants', 'reasons', 'records', 'review', 'snapshot_sha256', 'suggested_projects']);
    expect(opened.items).toEqual([
      { signal_id: 'decision-1', kind: 'decision', text: 'Ship the cohort onboarding.', subject: null, status: 'decided', due_at: null, quotes: [], owner: null, owner_editable: false, project_ids: [project] },
      { signal_id: 'act-1', kind: 'action', text: 'Send the pilot plan.', subject: null, status: null, due_at: null, quotes: [], owner: 'Rafael Moreno', owner_editable: true, project_ids: [project] },
      { signal_id: 'act-2', kind: 'action', text: 'Follow up on item 2.', subject: null, status: null, due_at: null, quotes: [], owner: null, owner_editable: false, project_ids: [project] },
    ]);
    expect(opened).toMatchObject({ reasons: [], records: [], suggested_projects: [{ project_id: project, name: 'ECHO' }], review: { status: 'pending', records: [] } });
    // Mixed destinations: THERM-like project B for the decision, both for the owned action, the other action not kept.
    const routes = f.routes(opened, item => ({ 'decision-1': [projectB], 'act-1': [project, projectB].sort(), 'act-2': null })[item.signal_id] ?? null);
    await f.call(runtime, { operation: 'review', approval_id: pending!.approval_id, snapshot_sha256: opened.snapshot_sha256, command_id: 'approve-mixed', action: 'approve',
      routes, owners: [{ signal_id: 'act-1', owner: 'Rafael M.' }] });
    const publishing = await f.call(runtime, { operation: 'review_open', approval_id: pending!.approval_id });
    expect(publishing.items.map(item => [item.signal_id, item.project_ids, item.owner, item.owner_editable])).toEqual([
      ['decision-1', [projectB], null, false], ['act-1', [project, projectB].sort(), 'Rafael M.', false], ['act-2', null, null, false]]);
    expect(publishing.records).toEqual([]);
    expect(publishing.suggested_projects.map(entry => entry.project_id)).toEqual([project, projectB].sort());
    await runtime.processing.recoverV4Appends(new AbortController().signal);
    const approved = await f.call(runtime, { operation: 'review_open', approval_id: pending!.approval_id });
    const records = [{ approval_id: approvalRecordIdV2(pending!.approval_id, [projectB]), project_ids: [projectB] },
      { approval_id: approvalRecordIdV2(pending!.approval_id, [project, projectB].sort()), project_ids: [project, projectB].sort() }];
    expect(approved.records).toEqual(records);
    expect(approved.review).toMatchObject({ status: 'approved', project_ids: [project, projectB].sort(), records });
    expect((await f.call(runtime, { operation: 'reviews' })).reviews[0]!.records).toEqual(records);
    // A destination the reviewer can no longer read keeps its route but loses its name.
    f.leave(projectB, 'owner');
    const later = await f.call(runtime, { operation: 'review_open', approval_id: pending!.approval_id });
    expect(later.items[0]!.project_ids).toEqual([projectB]);
    expect(later.suggested_projects.map(entry => entry.project_id)).toEqual([project]);
  });
  it('opens a review by one of its published records\' own approval ids (a run\'s event_ref), for its reviewer only', async () => {
    const f = await fixture({ ownedAction: true, actions: 1 }), runtime = f.create(); f.grantProject(); f.grantProject(projectB);
    const { pending, opened } = await f.pendingReview(runtime, project);
    const routes = f.routes(opened, item => ({ 'decision-1': [projectB], 'act-1': [], 'act-2': null })[item.signal_id] ?? null);
    await f.call(runtime, { operation: 'review', approval_id: pending!.approval_id, snapshot_sha256: opened.snapshot_sha256, command_id: 'approve-split', action: 'approve', routes, owners: [] });
    const recordIds = [approvalRecordIdV2(pending!.approval_id, [projectB]), approvalRecordIdV2(pending!.approval_id, [])];
    // While the approval publishes, no record exists yet to name it.
    await expect(f.call(runtime, { operation: 'review_open', approval_id: recordIds[0]! })).rejects.toMatchObject({ code: 'not_found' });
    await runtime.processing.recoverV4Appends(new AbortController().signal);
    const byProposal = await f.call(runtime, { operation: 'review_open', approval_id: pending!.approval_id });
    expect(byProposal.records.map(record => record.approval_id)).toEqual(recordIds);
    for (const id of recordIds) {
      const byRecord = await f.call(runtime, { operation: 'review_open', approval_id: id });
      // The proposal's own review, under its approval id: the desktop decides and links by that.
      expect(byRecord).toEqual(byProposal);
      expect(byRecord.review.approval_id).toBe(pending!.approval_id);
    }
    // Another member opens it by neither id, as if neither existed.
    for (const id of [pending!.approval_id, ...recordIds]) {
      await expect(f.call(runtime, { operation: 'review_open', approval_id: id }, 'other')).rejects.toMatchObject({ code: 'not_found' });
    }
    // A decision never takes a record id, and an id that names no record of theirs opens nothing.
    await expect(f.call(runtime, { operation: 'review', approval_id: recordIds[1]!, snapshot_sha256: opened.snapshot_sha256, command_id: 'reject-record', action: 'reject', routes: [], owners: [] }))
      .rejects.toMatchObject({ code: 'not_found' });
    await expect(f.call(runtime, { operation: 'review_open', approval_id: `apr_${'e'.repeat(64)}` })).rejects.toMatchObject({ code: 'not_found' });
    expect(f.count('authority_approval_decisions_v1')).toBe(1);
  });
  it('opens a rejected review with nothing kept', async () => {
    const f = await fixture({ ownedAction: true }), runtime = f.create(); f.grantProject();
    const { pending, opened } = await f.pendingReview(runtime, project);
    await f.call(runtime, { operation: 'review', approval_id: pending!.approval_id, snapshot_sha256: opened.snapshot_sha256, command_id: 'reject-it', action: 'reject', routes: [], owners: [] });
    const rejected = await f.call(runtime, { operation: 'review_open', approval_id: pending!.approval_id });
    expect(rejected.items.map(item => [item.project_ids, item.owner, item.owner_editable])).toEqual([[null, null, false], [null, null, false]]);
    expect(rejected).toMatchObject({ suggested_projects: [], records: [], review: { status: 'rejected', project_ids: [], records: [] } });
  });
  it('forwards after_record hooks from the runtime passthrough', async () => {
    const calls: AfterApprovedRecordEventV1[] = [];
    const f = await fixture(), runtime = f.create(undefined, { approval_core: { after_record: [(tx, event) => { expect(tx.inTransaction).toBe(true); calls.push(event); }] } });
    const { pending, opened } = await f.pendingReview(runtime);
    await f.call(runtime, { operation: 'review', approval_id: pending!.approval_id, snapshot_sha256: opened.snapshot_sha256, command_id: 'approve-hooked', action: 'approve', routes: f.routes(opened), owners: [] });
    await runtime.processing.appendFinalizedApprovalsToV4(new AbortController().signal);
    await runtime.processing.appendFinalizedApprovalsToV4(new AbortController().signal);
    expect(calls).toEqual([expect.objectContaining({ approval_id: approvalRecordIdV2(pending!.approval_id, []), proposal_approval_id: pending!.approval_id,
      record_sha256: f.record.prepare('SELECT record_sha256 FROM organization_record_log').pluck().get() })]);
  });
  it('crash between append and receipt at restart: one record, one receipt, one hook', async () => {
    const calls: AfterApprovedRecordEventV1[] = [];
    const after_record = [(_tx: unknown, event: AfterApprovedRecordEventV1) => { calls.push(event); }];
    const f = await fixture();
    const crashing = f.create(undefined, { approval_core: { after_record }, record_append: { async append(input) { await f.context.record_append.append(input); throw new Error('crash after append'); } } });
    const { pending, opened } = await f.pendingReview(crashing);
    await f.call(crashing, { operation: 'review', approval_id: pending!.approval_id, snapshot_sha256: opened.snapshot_sha256, command_id: 'approve-crash', action: 'approve', routes: f.routes(opened), owners: [] });
    // A row failure does not fail recovery; the row stays unpublished for the next pass.
    await crashing.processing.recoverV4Appends(new AbortController().signal);
    expect(calls).toEqual([]);
    crashing.close();
    const restarted = f.create(undefined, { approval_core: { after_record } });
    await restarted.processing.recoverV4Appends(new AbortController().signal);
    await restarted.processing.recoverV4Appends(new AbortController().signal);
    expect(f.record.prepare('SELECT count(*) FROM organization_record_log').pluck().get()).toBe(1);
    expect(f.db.prepare('SELECT count(*) FROM authority_approval_decisions_v1 WHERE receipt_json IS NOT NULL').pluck().get()).toBe(1);
    expect(calls).toEqual([expect.objectContaining({ approval_id: approvalRecordIdV2(pending!.approval_id, []), proposal_approval_id: pending!.approval_id })]);
  });
  it('returns an earlier decision and writes no second row', async () => {
    const f = await fixture(), runtime = f.create();
    const { pending, opened } = await f.pendingReview(runtime);
    const review = { operation: 'review' as const, approval_id: pending!.approval_id, snapshot_sha256: opened.snapshot_sha256, command_id: 'reject-once', action: 'reject' as const, routes: [], owners: [] };
    await expect(f.call(runtime, review)).resolves.toEqual({ status: 'rejected', decided_on: 'desktop' });
    await expect(f.call(runtime, review)).resolves.toEqual({ status: 'rejected', decided_on: 'desktop' });
    await expect(f.call(runtime, { ...review, command_id: 'approve-later', action: 'approve', routes: f.routes(opened) })).resolves.toEqual({ status: 'rejected', decided_on: 'desktop' });
    await expect(f.call(runtime, { ...review, command_id: 'approve-stale', action: 'approve', routes: f.routes(opened), snapshot_sha256: canonicalSha256('other') })).resolves.toEqual({ status: 'rejected', decided_on: 'desktop' });
    expect(f.count('authority_approval_decisions_v1')).toBe(1);
  });
  it('approves into two projects with a confirmed owner through the route', async () => {
    const f = await fixture({ ownedAction: true }), runtime = f.create(); f.grantProject(); f.grantProject(projectB);
    const { pending, opened } = await f.pendingReview(runtime, project);
    expect(opened.items.find(item => item.signal_id === 'act-1')).toMatchObject({ text: 'Send the pilot plan.', due_at: null, owner: 'Rafael Moreno', owner_editable: true });
    expect(opened.suggested_projects).toEqual([{ project_id: project, name: 'ECHO' }]);
    await expect(f.call(runtime, { operation: 'review', approval_id: pending!.approval_id, command_id: 'c1', snapshot_sha256: opened.snapshot_sha256,
      action: 'approve', routes: f.routes(opened, [project, projectB].sort()), owners: [{ signal_id: 'act-1', owner: 'Rafael Moreno' }] }))
      .resolves.toEqual({ status: 'publishing', decided_on: 'desktop' });
  });
  it('returns the earlier decision when Slack decided first', async () => {
    const f = await fixture(), runtime = f.create();
    const { pending, opened } = await f.pendingReview(runtime);
    const slackReview = validateApprovalDecisionRequestV1('slack', { approval_id: pending!.approval_id, command_id: 'slack:k', snapshot_sha256: opened.snapshot_sha256,
      action: 'approve', routes: f.routes(opened), owners: [] });
    (await runtime.approvals()).decide('slack', slackReview, () => ({ actor: f.person, evidence: { kind: 'slack-click', sha256: canonicalSha256('slack click') } }));
    expect((await f.call(runtime, { operation: 'review_open', approval_id: pending!.approval_id })).review.decided_on).toBe('slack');
    await expect(f.call(runtime, { operation: 'review', approval_id: pending!.approval_id, command_id: 'c2', snapshot_sha256: opened.snapshot_sha256,
      action: 'reject', routes: [], owners: [] })).resolves.toEqual({ status: 'publishing', decided_on: 'slack' });
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
