import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalJson, canonicalSha256 } from '@echo-brain/federation-protocol';
import type { PersonHandInMeetingV1, PersonMeetingOperationV2, PersonMeetingResultsV2 } from '@echo-brain/organization-api';
import { AdapterError, assertCanonicalMeetingDocument, type MeetingDocument } from '@echo-brain/organization-processing/core';
import { SqliteExtractionAttemptStoreV1 } from '@echo-brain/organization-processing/adapters/persistence/sqlite-extraction-attempt-store-v1';
import { createStagingSyntheticPersonalMeetingProviderV1, StagingSyntheticMeetingStoreV1 } from '@echo-brain/provider-synthetic-demo/staging-synthetic-personal-meeting-provider-v1';
import { createPersonMeetingRuntimeV1, type PersonMeetingProviderV1 } from '../src/composition/person-meeting-runtime-v1.js';
import { createHandInPersonMeetingProviderV1, handInMeetingDocumentV1, readHandInCheckpointV1, writeHandInCheckpointV1, HAND_IN_SOURCE_ADAPTER_ID_V1 } from '../src/composition/hand-in-person-meeting-provider-v1.js';
import { SqlitePersonHandInMeetingsV1 } from '../src/adapters/persistence/sqlite/person-hand-in-meetings-v1.js';
import { SqlitePersonMeetingIntakeV1 } from '../src/adapters/persistence/sqlite/person-meeting-intake-v1.js';
import { SqlitePersonOriginalContextRetrievalV1 } from '../src/adapters/persistence/sqlite/person-original-context-retrieval-v1.js';
import { approvalContextFixture } from './fixtures/approval-core.js';
import { addMembership, authorization, seedProject, seedProjectMember } from './fixtures/project-context-sqlite.js';
import { decisions } from '../../../packages/organization-processing/test/admitted-meeting-processing/fixtures/sqlite-meeting-state.js';

const project = 'prj_00000000-0000-4000-8000-000000000003';
const foreignProject = 'prj_00000000-0000-4000-8000-000000000023';
/** A fictional meeting, its text canonical as clients send it. */
const meeting: PersonHandInMeetingV1 = { title: 'Supplier sync', notes: '# Decisions\nMove the pilot to Friday.\n\nAction: Mina sends the revised quote.',
  transcript: 'Mina Patel: I will send the revised quote.\nRafael Moreno: Thanks.\n\nRafael Moreno: Friday works for the pilot.', started_at: '2026-10-21T12:00:00.000Z', all_day: true };
/** The id a handed-in meeting's canonical content derives: its payload digest. */
const handInMeetingIdV1 = (value: PersonHandInMeetingV1) => `hand-in-${canonicalSha256(value).slice(7)}`;
const ledgers: SqliteExtractionAttemptStoreV1[] = [];
afterEach(() => { for (const ledger of ledgers.splice(0)) ledger.close(); });

/** `quiet`: the extractor finds no decision and no action, so a meeting makes no card. */
async function fixture(options: { readonly quiet?: boolean } = {}) {
  const f = await approvalContextFixture();
  const now = new Date().toISOString();
  f.db.prepare('INSERT INTO authority_project_authorization_state_v1 VALUES (?,0,?)').run(f.actor.organization_id, now);
  const owner = { organization_id: f.actor.organization_id, principal_id: f.actor.principal_id, membership_id: f.actor.membership_id };
  const member = { ...owner, principal_id: 'prn_00000000-0000-4000-8000-000000000011', membership_id: 'mem_00000000-0000-4000-8000-000000000012' };
  addMembership(f.db, { ...member, membership_type: 'employee' }, 'Mina Patel', 'mina@example.test');
  const actors = { owner, member } as const;
  const sessions = { authenticateAccess: ({ access_token }: { access_token: string }) =>
    authorization({ ...actors[access_token as keyof typeof actors], membership_type: access_token === 'owner' ? 'owner' : 'employee' }) };
  // Each project is created by, and joined by, one of the two.
  let grants = 0;
  const grantProject = (project_id: string, who: keyof typeof actors) => {
    const actor = { ...actors[who], membership_type: who === 'owner' ? 'owner' as const : 'employee' as const };
    seedProject(f.db, project_id, actor, { name: 'Supplier review', created_at: now });
    seedProjectMember(f.db, project_id, actor, 'member', { id: `pgm_00000000-0000-4000-8000-${String(5 + grants++).padStart(12, '0')}`, granted_at: now });
  };
  const ledger = new SqliteExtractionAttemptStoreV1(new Database(':memory:'), { authority_id: 'aut_runtime', organization_id: 'org_runtime', state_lineage_id: 'lineage-runtime' });
  ledgers.push(ledger);
  const extracted: MeetingDocument[] = [];
  const handIn = createHandInPersonMeetingProviderV1({ database: f.db });
  const create = (providers: readonly PersonMeetingProviderV1[] = [handIn]) => createPersonMeetingRuntimeV1({ database: f.db, approval: f.context, providers, sessions,
    processor: { processor_adapter_id: 'llm', assert_admission_commitments() {},
      current_commitments: instance_id => ({ adapter_id: 'llm', instance_id, version: '1.0.0', configuration_sha256: canonicalSha256('processor'), credential_reference_sha256: canonicalSha256('ref') }),
      create_processor(admission) {
        const identity = { kind: 'decision-processor' as const, adapter_id: 'llm', instance_id: admission.processor.instance_id, version: admission.processor.version };
        return { identity, validateConfig: () => ({ ok: true, errors: [] }), healthCheck: async () => ({ status: 'healthy', checked_at: new Date().toISOString() }),
          async extract(document) {
            extracted.push(document);
            return { ...decisions, meeting_id: document.id, meeting_revision: document.provenance.canonical_revision, processor: identity,
              signals: options.quiet ? [] : decisions.signals.map(signal => ({ ...signal, text: 'Move the pilot to Friday.', evidence: [{ meeting_id: document.id, block_id: document.content[0]!.id }] })) };
          } };
      } },
    extraction_attempts: ledger });
  const call = async <K extends PersonMeetingOperationV2['operation']>(runtime: ReturnType<typeof create>, op: PersonMeetingOperationV2 & { operation: K }, token = 'member', tool_id = 'hand-in') => {
    const route = runtime.applications.find(application => application.routes.some(entry => entry.route_id === 'personal-meetings'))!;
    const response = await route.accept({ route_id: 'personal-meetings', method: 'POST', path: '/v1/person/meetings', headers: { authorization: `Bearer ${token}` },
      content_type: 'application/json', raw_body: Buffer.from(JSON.stringify({ schema_version: 2, tool_id, ...op })) });
    if (!('body' in response)) throw new Error('Expected JSON');
    return response.body as PersonMeetingResultsV2[K];
  };
  const intake = new SqlitePersonMeetingIntakeV1(f.db, handIn.cursor);
  const processUntilIdle = async (runtime: ReturnType<typeof create>) => {
    for (let pass = 0; pass < 10 && intake.list().some(s => intake.checkpoint(s.source_key).manual.length > 0); pass++) await runtime.processing.pollAndStageAdmittedMeetings(new AbortController().signal);
  };
  const count = (table: string) => f.db.prepare(`SELECT count(*) FROM ${table}`).pluck().get();
  return { ...f, owner, member, sessions, handIn, create, call, grantProject, intake, processUntilIdle, count, extracted };
}

describe('the hand-in meeting source', () => {
  it('takes a member\'s meeting into private custody like any other: one payload and one import, then one review', async () => {
    const f = await fixture(), runtime = f.create();
    f.grantProject(project, 'member');
    const submit = { operation: 'submit', meeting, project_id: project, retain: true } as const;
    const id = handInMeetingIdV1(meeting);
    await expect(f.call(runtime, submit)).resolves.toEqual({ status: 'queued', meeting_id: id });
    // The same meeting again is the same meeting: no second payload, no second import.
    await expect(f.call(runtime, submit)).resolves.toEqual({ status: 'queued', meeting_id: id });
    const [source] = f.intake.list(f.member);
    expect(f.intake.list(f.owner)).toEqual([]);
    expect(source).toMatchObject({ source_adapter_id: HAND_IN_SOURCE_ADAPTER_ID_V1, watch: 'off', folder_id: null });
    expect(f.intake.checkpoint(source!.source_key).manual).toEqual([id]);
    expect(f.db.prepare('SELECT source_key, external_id, payload_json, payload_sha256 FROM authority_person_hand_in_meetings_v1').all())
      .toEqual([{ source_key: source!.source_key, external_id: id, payload_json: canonicalJson(meeting), payload_sha256: canonicalSha256(meeting) }]);
    expect(f.db.prepare('SELECT source_custodian_assurance FROM authority_live_source_admission_v2 WHERE source_key=?').pluck().get(source!.source_key)).toBe('person_hand_in');

    await f.processUntilIdle(runtime);
    expect(f.extracted).toHaveLength(1);
    const [document] = f.extracted;
    // Honest custody: the text as handed in, its origin imported, the transcript a block per paragraph, nothing synthetic.
    // A whole day is read in UTC, so no reader moves it to another day.
    expect(document!.time).toEqual({ actual_start_at: '2026-10-21T12:00:00.000Z', timezone: 'UTC', all_day: true });
    expect(document).toMatchObject({ id, title: 'Supplier sync', participants: [], content: [
      { id: `${id}:notes`, kind: 'note', origin: 'imported', text: meeting.notes },
      { id: `${id}:transcript:0`, kind: 'transcript', origin: 'imported', sequence: 0, text: 'Mina Patel: I will send the revised quote.\nRafael Moreno: Thanks.' },
      { id: `${id}:transcript:1`, kind: 'transcript', origin: 'imported', sequence: 1, text: 'Rafael Moreno: Friday works for the pilot.' },
    ] });
    expect(JSON.stringify(document).toLowerCase()).not.toContain('synthetic');
    const [review] = (await f.call(runtime, { operation: 'reviews' })).reviews;
    expect(review).toMatchObject({ title: 'Supplier sync', status: 'pending', project_ids: [project], first_line: 'Move the pilot to Friday.', meeting_at: '2026-10-21T12:00:00.000Z',
      all_day: true });
    // The card reads the same row: its day, and no time of day.
    expect((await f.call(runtime, { operation: 'review_open', approval_id: review!.approval_id })).review).toEqual(review);
    expect((await f.call(runtime, { operation: 'reviews' }, 'owner')).reviews).toEqual([]);

    // Handed in once more after processing: the frozen result is reused, so no second extraction and no second card.
    await f.call(runtime, submit);
    await f.processUntilIdle(runtime);
    expect(f.extracted).toHaveLength(1);
    expect((await f.call(runtime, { operation: 'reviews' })).reviews).toHaveLength(1);
    expect(f.count('authority_person_hand_in_meetings_v1')).toBe(1);
  });

  it('forgets a cancelled paste with its import, and keeps one an admitted source revision holds', async () => {
    const f = await fixture(), runtime = f.create();
    const submit = { operation: 'submit', meeting, project_id: null, retain: true } as const;
    const { meeting_id: id } = await f.call(runtime, submit);
    const [source] = f.intake.list(f.member);
    const cancel = { operation: 'cancel_import', source_key: source!.source_key, meeting_id: id } as const;
    await expect(f.call(runtime, cancel)).resolves.toEqual({ status: 'cancelled' });
    // Cancelled before it was pulled: its payload went with its import, so nothing of it is left to remove.
    expect(f.intake.checkpoint(source!.source_key).manual).toEqual([]);
    expect(f.count('authority_person_hand_in_meetings_v1')).toBe(0);
    // Pasted again, it is kept again and processed.
    await expect(f.call(runtime, submit)).resolves.toEqual({ status: 'queued', meeting_id: id });
    await f.processUntilIdle(runtime);
    expect(f.extracted).toHaveLength(1);
    // Admitted, it stays: pasted once more and cancelled, its import goes but its payload stays with the revision that holds it.
    await f.call(runtime, submit);
    await expect(f.call(runtime, cancel)).resolves.toEqual({ status: 'cancelled' });
    expect(f.intake.checkpoint(source!.source_key).manual).toEqual([]);
    expect(new SqlitePersonHandInMeetingsV1(f.db).get(source!.source_key, id)).toMatchObject({ external_id: id, meeting });
    expect(() => f.db.prepare('DELETE FROM authority_person_hand_in_meetings_v1').run()).toThrow('handed-in meeting deletion is denied');
    // Forgetting outside the cancel's transaction is refused.
    expect(() => new SqlitePersonHandInMeetingsV1(f.db).forget(source!.source_key, id)).toThrow('only with its cancelled import');
  });

  it('lets its importer find and open a transcript-only paste that makes no card, and no one else', async () => {
    const f = await fixture({ quiet: true }), runtime = f.create();
    const pasted: PersonHandInMeetingV1 = { title: 'Kiln trial', notes: '', transcript: 'Mina Patel: The kiln trial slips a week.\n\nRafael Moreno: Then the glaze order waits.' };
    await f.call(runtime, { operation: 'submit', meeting: pasted, project_id: null, retain: true });
    await f.processUntilIdle(runtime);
    expect(f.extracted).toHaveLength(1);
    // No decision and no action: no card, and the meeting stays in its importer's custody.
    expect((await f.call(runtime, { operation: 'reviews' })).reviews).toEqual([]);
    const originals = new SqlitePersonOriginalContextRetrievalV1(f.db, f.sessions, f.member.organization_id);
    const found = originals.deskSearch({ access_token: 'member', scope: { kind: 'global' }, query: 'kiln glaze', kinds: ['imported_meeting'] });
    expect(found.items).toHaveLength(1);
    expect(() => originals.revalidateDeskRelease({ access_token: 'member', release: found })).not.toThrow();
    // The person supplied the transcript, so it is the text they open, whole.
    expect(originals.deskOpen({ access_token: 'member', scope: { kind: 'global' }, citation: found.items[0]!.citation }).items[0]?.text)
      .toContain('Mina Patel: The kiln trial slips a week.\n\nRafael Moreno: Then the glaze order waits.');
    expect(originals.deskSearch({ access_token: 'member', scope: { kind: 'global' }, query: 'glaze' }).items).toHaveLength(1);
    // Nobody else reads it, the owner included.
    expect(originals.deskSearch({ access_token: 'owner', scope: { kind: 'global' }, query: 'kiln glaze' }).items).toEqual([]);
  });

  it('is open to every member while the staging synthetic source stays owner-only', async () => {
    const f = await fixture(), storage = new Database(':memory:');
    try {
      const synthetic = createStagingSyntheticPersonalMeetingProviderV1({ custom_store: new StagingSyntheticMeetingStoreV1(storage) });
      const runtime = f.create([f.handIn, synthetic]);
      const custom = { operation: 'submit', meeting: { id: 'synthetic-custom-supplier', title: 'Supplier sync', notes: 'Move the pilot to Friday.', transcript: '' }, project_id: null, retain: true } as const;
      await expect(f.call(runtime, custom, 'member', 'synthetic')).rejects.toMatchObject({ code: 'unauthorized' });
      await expect(f.call(runtime, custom, 'owner', 'synthetic')).resolves.toEqual({ status: 'queued', meeting_id: 'synthetic-custom-supplier' });
      await expect(f.call(runtime, { operation: 'submit', meeting, project_id: null, retain: true }, 'member')).resolves.toMatchObject({ status: 'queued' });
      await expect(f.call(runtime, { operation: 'submit', meeting, project_id: null, retain: true }, 'owner')).resolves.toMatchObject({ status: 'queued' });
      // Each person's meeting is their own, in their own source.
      expect(f.db.prepare('SELECT count(DISTINCT source_key) FROM authority_person_hand_in_meetings_v1').pluck().get()).toBe(2);
      const tools = await runtime.tools('member');
      expect(tools.find(tool => tool.tool_id === 'hand-in')).toEqual({ tool_id: 'hand-in', display_name: 'Paste a meeting', availability: 'enabled', personal_status: 'linked',
        external_scope_id: null, external_subject_id: 'hand-in', organization_setup: null });
    } finally { storage.close(); }
  });

  it('refuses a suggestion outside the member\'s projects, and folders, previews and imports, keeping nothing', async () => {
    const f = await fixture(), runtime = f.create();
    f.grantProject(foreignProject, 'owner');
    await expect(f.call(runtime, { operation: 'submit', meeting, project_id: foreignProject, retain: true })).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(f.call(runtime, { operation: 'browse', folder_id: 'folder' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(f.call(runtime, { operation: 'open', meeting_id: handInMeetingIdV1(meeting) })).rejects.toMatchObject({ code: 'not_found' });
    await expect(f.call(runtime, { operation: 'import', meeting_id: handInMeetingIdV1(meeting), project_id: null, retain: true })).rejects.toMatchObject({ code: 'not_found' });
    expect(f.count('authority_person_hand_in_meetings_v1')).toBe(0);
    expect(f.intake.list()).toEqual([]);
    // Always linked, with no account elsewhere to name.
    expect(await f.call(runtime, { operation: 'home' })).toMatchObject({ connected: true, email: null, workspace: null });
  });

  it('keeps a payload only with its queued import: a full queue refuses the next meeting and keeps nothing of it', async () => {
    const f = await fixture(), runtime = f.create();
    const ids: string[] = [];
    for (let index = 0; index < 50; index++) {
      ids.push((await f.call(runtime, { operation: 'submit', meeting: { ...meeting, title: `Supplier sync ${index + 1}` }, project_id: null, retain: true })).meeting_id);
    }
    await expect(f.call(runtime, { operation: 'submit', meeting: { ...meeting, title: 'Supplier sync 51' }, project_id: null, retain: true })).rejects.toMatchObject({ code: 'rate_limited' });
    expect(f.count('authority_person_hand_in_meetings_v1')).toBe(50);
    const [source] = f.intake.list(f.member);
    expect(f.intake.checkpoint(source!.source_key).manual).toEqual(ids);
    // A meeting already waiting is still taken: it queues nothing new.
    await expect(f.call(runtime, { operation: 'submit', meeting: { ...meeting, title: 'Supplier sync 1' }, project_id: null, retain: true })).resolves.toEqual({ status: 'queued', meeting_id: ids[0] });
    expect(() => new SqlitePersonHandInMeetingsV1(f.db).save(source!.source_key, meeting)).toThrow('only with its queued import');
  });

  it('pulls only a kept, intact payload, and refuses an id queued without one', async () => {
    const f = await fixture(), runtime = f.create();
    const { meeting_id } = await f.call(runtime, { operation: 'submit', meeting, project_id: null, retain: true });
    const [setting] = f.intake.list(f.member);
    const store = new SqlitePersonHandInMeetingsV1(f.db);
    const kept = store.get(setting!.source_key, meeting_id)!;
    expect(kept).toMatchObject({ external_id: meeting_id, meeting, payload_sha256: canonicalSha256(meeting) });
    expect(store.get(setting!.source_key, `hand-in-${'0'.repeat(64)}`)).toBeUndefined();
    const source = f.handIn.source(setting!, () => undefined);
    const pulled = await source.pull({ cursor: writeHandInCheckpointV1({ manual: [meeting_id] }) });
    expect(pulled.meetings).toHaveLength(1);
    expect(readHandInCheckpointV1(pulled.next_cursor!).manual).toEqual([]);
    // Pulling again builds the same meeting and revision.
    expect((await source.pull({ cursor: writeHandInCheckpointV1({ manual: [meeting_id] }) })).meetings).toEqual(pulled.meetings);
    const orphan = `hand-in-${'1'.repeat(64)}`;
    await expect(source.pull({ cursor: writeHandInCheckpointV1({ manual: [orphan] }) })).rejects.toBeInstanceOf(AdapterError);
    // A payload whose bytes are not the canonical ones its id names is refused when read.
    const other = { ...meeting, title: 'Vendor sync' }, digest = canonicalSha256(other);
    f.db.prepare('INSERT INTO authority_person_hand_in_meetings_v1 VALUES (?,?,?,?,?)').run(setting!.source_key, `hand-in-${digest.slice(7)}`, JSON.stringify(other, null, 2), digest, new Date().toISOString());
    expect(() => store.get(setting!.source_key, `hand-in-${digest.slice(7)}`)).toThrow('integrity');
  });

  it('builds a timed meeting, a meeting without a time, and bounds its transcript blocks', () => {
    const identity = { kind: 'meeting-source' as const, adapter_id: HAND_IN_SOURCE_ADAPTER_ID_V1, instance_id: 'hand-in-fixture', version: '1.0.0' };
    const build = (value: PersonHandInMeetingV1) => handInMeetingDocumentV1(identity, { external_id: handInMeetingIdV1(value), meeting: value,
      payload_sha256: canonicalSha256(value), submitted_at: '2026-10-21T23:00:00.000Z' });
    const timed = build({ title: 'Supplier sync', notes: '', transcript: 'Mina Patel: Friday works.', started_at: '2026-10-21T22:30:00.000Z',
      ended_at: '2026-10-21T23:00:00.000Z', time_zone: 'America/Los_Angeles' });
    expect(timed.time).toEqual({ actual_start_at: '2026-10-21T22:30:00.000Z', actual_end_at: '2026-10-21T23:00:00.000Z', timezone: 'America/Los_Angeles' });
    expect(timed.capture.components).toEqual([{ kind: 'metadata', state: 'available' }, { kind: 'notes', state: 'not_provided' }, { kind: 'transcript', state: 'available' }]);
    expect(timed.provenance).toMatchObject({ source: identity, observed_at: '2026-10-21T23:00:00.000Z', normalizer_version: 'person-hand-in-meeting-v1' });
    const untimed = build({ title: 'Supplier sync', notes: 'Move the pilot to Friday.', transcript: '' });
    expect(untimed).not.toHaveProperty('time');
    expect(untimed.content).toEqual([{ id: `${untimed.id}:notes`, kind: 'note', text: 'Move the pilot to Friday.', origin: 'imported' }]);
    // Paragraphs past the thousandth share the last block, so a long paste stays within the meeting contract.
    const long = build({ title: 'Supplier sync', notes: '', transcript: Array.from({ length: 1_500 }, (_, index) => `Speaker ${index}: point ${index}.`).join('\n\n') });
    expect(long.content).toHaveLength(1_000);
    expect(long.content.map(block => block.text).join('\n\n')).toBe(Array.from({ length: 1_500 }, (_, index) => `Speaker ${index}: point ${index}.`).join('\n\n'));
    assertCanonicalMeetingDocument(long, identity);
    expect(new Set([timed, untimed, long].map(document => document.provenance.canonical_revision)).size).toBe(3);
  });
});
