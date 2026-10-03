import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildContextCaptureEnvelopeV2, captureRevisionRefV1, captureSourceConfigSha256V1, classifyCaptureV1, sourceItemIdV1,
  type CaptureLocalClassifierV1, type CaptureSnapshotSelectionV1, type CaptureSourceConfigV1, type ContextCaptureEnvelopeV2,
} from '@echo-brain/organization-processing/core';
import { SqliteCaptureFoundationV1 } from '../src/adapters/persistence/sqlite/capture-foundation-v1.js';
import { createCaptureSourceAuthorityV1, type CaptureSourceAuthorityCheckersV1 } from '../src/application/capture-source-authority-v1.js';
import { CAPTURE_CURSORS_DATABASE_V1, openCaptureSourceRunnerV1 } from '../src/composition/capture-source-runner-v1.js';
import { bootstrapOrganizationAuthorityState } from '../src/composition/organization-authority-state-bootstrap.js';
import {
  FAKE_ACTOR, FAKE_CONTAINERS, FAKE_CONTENT, FAKE_CURSORS, FAKE_IDENTITY, FAKE_PROJECTS, FAKE_SOURCE_ID, FAKE_TIMES,
  createFakeCaptureProviderV2, fakeCaptureSourceConfig, fakeInitialItems, type FakeCaptureProviderV2,
} from '../../../tests/support/capture-fake-provider-v2.js';

let root: string;
let directory: string;
let organization: string;
let owner: { readonly principal_id: string; readonly membership_id: string };
let fake: FakeCaptureProviderV2;
const opened: { close(): void }[] = [];

function config(changes: Partial<CaptureSourceConfigV1> = {}): CaptureSourceConfigV1 { return fakeCaptureSourceConfig(changes, organization); }

function open(options: { config?: CaptureSourceConfigV1; checkers?: CaptureSourceAuthorityCheckersV1; classifiers?: readonly CaptureLocalClassifierV1[]; providers?: Record<string, FakeCaptureProviderV2['factory']> } = {}) {
  const runner = openCaptureSourceRunnerV1({
    state_directory: directory, configs: [options.config ?? config()],
    providers: options.providers ?? { [FAKE_IDENTITY.adapter_id]: fake.factory }, provider_deps: undefined, now: () => FAKE_TIMES.third,
    ...(options.checkers === undefined ? {} : { checkers: options.checkers }), ...(options.classifiers === undefined ? {} : { classifiers: options.classifiers }),
  });
  opened.push(runner);
  return runner;
}
function inspect<T>(file: string, read: (database: Database.Database) => T): T {
  const database = new Database(join(directory, file));
  try { return read(database); } finally { database.close(); }
}
function count(table: string): number {
  return inspect('authority.sqlite', database => (database.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n);
}
function bookmark(): string | undefined {
  return inspect(CAPTURE_CURSORS_DATABASE_V1, database => (database.prepare('SELECT cursor FROM capture_cursors_v1 WHERE source_id=?').get(FAKE_SOURCE_ID) as { cursor: string } | undefined)?.cursor);
}
function withStore<T>(use: (store: SqliteCaptureFoundationV1, database: Database.Database) => T, policy = config(), checkers: CaptureSourceAuthorityCheckersV1 = {}): T {
  return inspect('authority.sqlite', database => {
    database.pragma('foreign_keys = ON');
    return use(new SqliteCaptureFoundationV1(database, createCaptureSourceAuthorityV1(policy, checkers), policy.containers), database);
  });
}
function head(external_id: string): ContextCaptureEnvelopeV2 | undefined {
  return withStore(store => store.head({ organization_id: organization, source_id: sourceItemIdV1(FAKE_IDENTITY, external_id) }));
}
function annotations(): { project_id: string; container_ref: string; classification: { reason: string } }[] {
  return inspect('authority.sqlite', database => (database.prepare('SELECT content_json FROM authority_source_representations_v1').all() as { content_json: string }[])
    .map(row => JSON.parse(row.content_json)));
}
function addProject(database: Database.Database, projectId: string) {
  database.prepare("INSERT INTO authority_projects_v1(project_id,organization_id,name,status,created_at,creator_principal_id,creator_membership_id,creator_membership_type) VALUES (?,?,?,'active',?,?,?,'owner')")
    .run(projectId, organization, 'Fixture', FAKE_TIMES.first, owner.principal_id, owner.membership_id);
}
function retainedNothing() { expect(count('authority_sources_v1')).toBe(0); expect(count('authority_source_revisions_v1')).toBe(0); expect(bookmark()).toBeUndefined(); }

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'echo-capture-run-')); chmodSync(root, 0o700);
  const initialized = bootstrapOrganizationAuthorityState({ state_directory: join(root, 'state'), organization_display_name: 'Fixture',
    owner_display_name: 'Owner', created_at: FAKE_TIMES.first, creating_artifact_revision: 'capture-core-fixture' });
  directory = initialized.state_directory; organization = initialized.organization_id;
  owner = { principal_id: initialized.owner_principal_id, membership_id: initialized.owner_membership_id };
  inspect('authority.sqlite', database => { addProject(database, FAKE_PROJECTS.alpha); addProject(database, FAKE_PROJECTS.beta); });
  fake = createFakeCaptureProviderV2();
});
afterEach(() => { for (const runner of opened.splice(0)) runner.close(); rmSync(root, { recursive: true, force: true }); });

describe('vendor-free capture runtime', () => {
  it('admits five kinds across two containers, then a rerun is all duplicates', async () => {
    const runner = open();
    expect(await runner.runCaptureSourceOnce(FAKE_SOURCE_ID)).toEqual({ admitted: 5, duplicate: 0, skipped: 0 });
    expect(fake.requests).toEqual([{ limit: 50 }]); expect(bookmark()).toBe(FAKE_CURSORS.first);
    const kinds = inspect('authority.sqlite', database => (database.prepare('SELECT content_json FROM authority_source_contents_v1').all() as { content_json: string }[])
      .map(row => JSON.parse(row.content_json).payload.kind).sort());
    expect(kinds).toEqual(['document', 'meeting', 'message', 'note', 'ticket']);
    expect(annotations().map(entry => [entry.container_ref, entry.project_id, entry.classification.reason]).sort()).toEqual([
      ...Array(2).fill([FAKE_CONTAINERS.alpha, FAKE_PROJECTS.alpha, 'useful']), ...Array(3).fill([FAKE_CONTAINERS.beta, FAKE_PROJECTS.beta, 'useful']),
    ]);
    // The provider replays the same items later; nothing new is stored.
    fake.respond = () => ({ items: fakeInitialItems(FAKE_TIMES.second), next_cursor: FAKE_CURSORS.first });
    expect(await runner.runCaptureSourceOnce(FAKE_SOURCE_ID)).toEqual({ admitted: 0, duplicate: 5, skipped: 0 });
    expect(fake.requests[1]).toEqual({ limit: 50, cursor: FAKE_CURSORS.first });
    expect(count('authority_source_revisions_v1')).toBe(5); expect(count('authority_source_representations_v1')).toBe(5);
  });

  it('links a changed item to its predecessor, reuses an unchanged repoll and retains an explicit tombstone', async () => {
    const runner = open();
    await runner.runCaptureSourceOnce(FAKE_SOURCE_ID);
    const ticket = head('ticket-1')!; const note = head('note-1')!;
    expect(await runner.runCaptureSourceOnce(FAKE_SOURCE_ID)).toEqual({ admitted: 2, duplicate: 1, skipped: 0 });
    const changed = head('ticket-1')!;
    expect(changed.revision.previous_revision_id).toBe(ticket.revision.revision_id);
    expect(changed.content.lifecycle === 'present' && changed.content.payload.kind === 'ticket' && changed.content.payload.status).toBe('done');
    const deleted = head('note-1')!;
    expect(deleted.content.lifecycle).toBe('deleted'); expect(deleted.revision.previous_revision_id).toBe(note.revision.revision_id);
    expect(annotations().filter(entry => entry.classification.reason === 'source_deleted')).toHaveLength(1);
    expect(count('authority_source_revisions_v1')).toBe(7); expect(bookmark()).toBe(FAKE_CURSORS.second);
    // Nothing new upstream: the bookmark stays put and a repeated tombstone stays a duplicate.
    expect(await runner.runCaptureSourceOnce(FAKE_SOURCE_ID)).toEqual({ admitted: 0, duplicate: 0, skipped: 0 });
    fake.respond = () => ({ items: [{ external_id: 'note-1', captured_at: FAKE_TIMES.third, content: FAKE_CONTENT.tombstone('note-1', FAKE_CONTAINERS.beta) }] });
    expect(await runner.runCaptureSourceOnce(FAKE_SOURCE_ID)).toEqual({ admitted: 0, duplicate: 1, skipped: 0 });
    expect(bookmark()).toBe(FAKE_CURSORS.second);
    // An empty batch with a new cursor still advances the bookmark.
    fake.respond = () => ({ items: [], next_cursor: 'fake-cursor-3' });
    expect(await runner.runCaptureSourceOnce(FAKE_SOURCE_ID)).toEqual({ admitted: 0, duplicate: 0, skipped: 0 });
    expect(bookmark()).toBe('fake-cursor-3');
    await runner.runCaptureSourceOnce(FAKE_SOURCE_ID);
    expect(fake.requests.at(-1)).toEqual({ limit: 50, cursor: 'fake-cursor-3' });
  });

  it('refuses a batch that repeats an item, so a replayed page never reorders lineage', async () => {
    const runner = open();
    fake.respond = () => ({ items: [
      { external_id: 'ticket-1', captured_at: FAKE_TIMES.first, content: FAKE_CONTENT.ticket() },
      { external_id: 'ticket-1', captured_at: FAKE_TIMES.first, content: FAKE_CONTENT.ticket('done', FAKE_TIMES.second) },
    ] });
    await expect(runner.runCaptureSourceOnce(FAKE_SOURCE_ID)).rejects.toThrow(/repeats an item/);
    retainedNothing();
    // A final page without a next cursor is pulled again on every run and stays idempotent.
    fake.respond = () => ({ items: fakeInitialItems() });
    expect(await runner.runCaptureSourceOnce(FAKE_SOURCE_ID)).toEqual({ admitted: 5, duplicate: 0, skipped: 0 });
    expect(await runner.runCaptureSourceOnce(FAKE_SOURCE_ID)).toEqual({ admitted: 0, duplicate: 5, skipped: 0 });
    expect(await runner.runCaptureSourceOnce(FAKE_SOURCE_ID)).toEqual({ admitted: 0, duplicate: 5, skipped: 0 });
    expect(count('authority_source_revisions_v1')).toBe(5); expect(bookmark()).toBeUndefined();
  });

  it('preserves the bookmark and lineage across a restart', async () => {
    const first = open();
    await first.runCaptureSourceOnce(FAKE_SOURCE_ID);
    const ticket = head('ticket-1')!;
    first.close();
    expect(await open().runCaptureSourceOnce(FAKE_SOURCE_ID)).toEqual({ admitted: 2, duplicate: 1, skipped: 0 });
    expect(fake.requests[1]!.cursor).toBe(FAKE_CURSORS.first);
    expect(head('ticket-1')!.revision.previous_revision_id).toBe(ticket.revision.revision_id);
  });

  it('replays to duplicates after a crash between admission and the bookmark write', async () => {
    open().close();
    inspect(CAPTURE_CURSORS_DATABASE_V1, database => database.exec("CREATE TRIGGER crash BEFORE INSERT ON capture_cursors_v1 BEGIN SELECT RAISE(ABORT, 'crash before bookmark'); END"));
    const crashed = open();
    await expect(crashed.runCaptureSourceOnce(FAKE_SOURCE_ID)).rejects.toThrow(/crash before bookmark/);
    expect(count('authority_source_revisions_v1')).toBe(5); expect(bookmark()).toBeUndefined();
    crashed.close();
    inspect(CAPTURE_CURSORS_DATABASE_V1, database => database.exec('DROP TRIGGER crash'));
    expect(await open().runCaptureSourceOnce(FAKE_SOURCE_ID)).toEqual({ admitted: 0, duplicate: 5, skipped: 0 });
    expect(fake.requests.map(request => request.cursor)).toEqual([undefined, undefined]);
    expect(count('authority_source_revisions_v1')).toBe(5); expect(bookmark()).toBe(FAKE_CURSORS.first);
  });

  it('hands admitted captures to an exact derive snapshot through the same configured policy, across an adapter upgrade', async () => {
    await open().runCaptureSourceOnce(FAKE_SOURCE_ID);
    const upgraded = config({ adapter: { ...FAKE_IDENTITY, version: '2' } });
    const selections = inspect('authority.sqlite', database => (database.prepare(`SELECT r.source_id, r.revision_id, r.content_sha256, a.representation_id AS annotation_representation_id, a.content_json
      FROM authority_source_revisions_v1 r JOIN authority_source_representations_v1 a ON a.source_id=r.source_id AND a.revision_id=r.revision_id`).all() as (CaptureSnapshotSelectionV1 & { content_json: string })[])
      .filter(row => JSON.parse(row.content_json).project_id === FAKE_PROJECTS.alpha).map(({ content_json: _json, ...selection }) => selection));
    const snapshot = withStore(store => store.snapshot({ organization_id: organization, project_id: FAKE_PROJECTS.alpha, selections }), upgraded);
    expect(snapshot.inputs.map(input => input.source.item.external_id).sort()).toEqual(['message-1', 'ticket-1']);
    // Retention still requires the configured adapter version.
    const stale = buildContextCaptureEnvelopeV2({ identity: FAKE_IDENTITY, external_id: 'fresh', captured_at: FAKE_TIMES.first, content: FAKE_CONTENT.note() });
    const classification = classifyCaptureV1({ source: stale, producer: { id: 'rules', version: '1', config_sha256: captureSourceConfigSha256V1(upgraded) }, rules: [] });
    const bindings = { scope: upgraded.scope, project_id: FAKE_PROJECTS.beta, container_ref: FAKE_CONTAINERS.beta, people: [] };
    expect(() => withStore(store => store.admit({ identity: FAKE_IDENTITY, source: stale, classification, bindings }), upgraded)).toThrow(/adapter differs/);
  });
});

describe('vendor-free capture refusals', () => {
  it('refuses an unmapped container before storing any item of the batch', async () => {
    fake.respond = () => ({ items: [...fakeInitialItems(), { external_id: 'stray', captured_at: FAKE_TIMES.first, content: FAKE_CONTENT.message(FAKE_CONTAINERS.unmapped) }], next_cursor: FAKE_CURSORS.first });
    await expect(open().runCaptureSourceOnce(FAKE_SOURCE_ID)).rejects.toThrow(/outside the configured scope/);
    retainedNothing();
  });

  it('refuses a representation the configuration does not allow', async () => {
    const pointersOnly = config({ representations: ['pointer'] });
    fake.respond = () => ({ items: [fakeInitialItems()[1]!], next_cursor: FAKE_CURSORS.first });
    await expect(open({ config: pointersOnly }).runCaptureSourceOnce(FAKE_SOURCE_ID)).rejects.toThrow(/representation is not permitted/);
    retainedNothing();
    fake.respond = () => ({ items: [fakeInitialItems()[0]!], next_cursor: FAKE_CURSORS.first });
    expect(await open({ config: pointersOnly }).runCaptureSourceOnce(FAKE_SOURCE_ID)).toEqual({ admitted: 1, duplicate: 0, skipped: 0 });
  });

  it('refuses a provider whose identity differs from its configuration, before or during the pull', async () => {
    fake.identity = { ...FAKE_IDENTITY, version: '2' };
    await expect(open().runCaptureSourceOnce(FAKE_SOURCE_ID)).rejects.toThrow(/differs from its configured adapter/);
    expect(fake.requests).toEqual([]); expect(fake.grant_checks).toBe(0);
    fake.identity = FAKE_IDENTITY;
    fake.respond = () => { fake.identity = { ...FAKE_IDENTITY, instance_id: 'other' }; return { items: fakeInitialItems() }; };
    await expect(open().runCaptureSourceOnce(FAKE_SOURCE_ID)).rejects.toThrow(/differs from its configured adapter/);
    retainedNothing();
    await expect(open().runCaptureSourceOnce('src_unknown')).rejects.toThrow(/not configured/);
  });

  it('refuses non-empty people unless an identity-link checker verifies each binding', () => {
    // The runner always binds no people; any other caller of the store meets the same fence.
    const message = buildContextCaptureEnvelopeV2({ identity: FAKE_IDENTITY, external_id: 'message-1', captured_at: FAKE_TIMES.first, content: FAKE_CONTENT.message() });
    const classification = classifyCaptureV1({ source: message, producer: { id: 'rules', version: '1', config_sha256: captureSourceConfigSha256V1(config()) }, rules: [] });
    const people = [{ source_actor_ref: FAKE_ACTOR, principal_id: owner.principal_id, membership_id: owner.membership_id, identity_link_ref: 'link:sam' }];
    const bindings = { scope: config().scope, project_id: FAKE_PROJECTS.alpha, container_ref: FAKE_CONTAINERS.alpha, people };
    const input = { identity: FAKE_IDENTITY, source: message, classification, bindings };
    expect(() => withStore(store => store.admit(input))).toThrow(/Person binding is not verified/);
    expect(() => withStore(store => store.admit(input), undefined, { identity_link: () => Promise.resolve(true) as unknown as boolean })).toThrow(/not verified/);
    const verified: string[] = [];
    const checker = { identity_link: ({ binding }: { binding: { identity_link_ref: string } }) => { verified.push(binding.identity_link_ref); return true; } };
    expect(withStore(store => store.admit(input), undefined, checker).admission).toBe('admitted');
    expect(verified).toEqual(['link:sam']);
  });

  it('refuses a document original unless an artifact-custody checker accepts it', async () => {
    const original = { artifact_id: 'artifact:rollout', media_type: 'text/html', sha256: 'a'.repeat(64), byte_length: 120 };
    fake.respond = () => ({ items: [{ external_id: 'document-1', captured_at: FAKE_TIMES.first, content: FAKE_CONTENT.document(original) }], next_cursor: FAKE_CURSORS.first });
    await expect(open().runCaptureSourceOnce(FAKE_SOURCE_ID)).rejects.toThrow(/original artifact custody/);
    retainedNothing();
    const seen: string[] = [];
    const checkers = { artifact_custody: ({ artifact }: { artifact: { artifact_id: string } }) => { seen.push(artifact.artifact_id); return true; } };
    expect(await open({ checkers }).runCaptureSourceOnce(FAKE_SOURCE_ID)).toEqual({ admitted: 1, duplicate: 0, skipped: 0 });
    expect(seen).toEqual(['artifact:rollout']);
  });

  it('checks the read grant before the pull and again before admission', async () => {
    fake.grant = false;
    await expect(open().runCaptureSourceOnce(FAKE_SOURCE_ID)).rejects.toThrow(/revoked/);
    expect(fake.requests).toEqual([]);
    fake.grant = true; fake.grant_checks = 0;
    fake.respond = request => { fake.grant = false; return { items: fakeInitialItems(), ...(request.cursor === undefined ? { next_cursor: FAKE_CURSORS.first } : {}) }; };
    await expect(open().runCaptureSourceOnce(FAKE_SOURCE_ID)).rejects.toThrow(/revoked/);
    expect(fake.grant_checks).toBe(2); retainedNothing();
  });

  it('propagates aborts without storing anything', async () => {
    const before = new AbortController(); before.abort(new Error('cancelled early'));
    await expect(open().runCaptureSourceOnce(FAKE_SOURCE_ID, { signal: before.signal })).rejects.toThrow(/cancelled early/);
    expect(fake.requests).toEqual([]);
    const during = new AbortController();
    let observed: AbortSignal | undefined;
    fake.respond = (_request, context) => { observed = context?.signal; during.abort(new Error('cancelled mid-pull')); return { items: fakeInitialItems(), next_cursor: FAKE_CURSORS.first }; };
    await expect(open().runCaptureSourceOnce(FAKE_SOURCE_ID, { signal: during.signal })).rejects.toThrow(/cancelled mid-pull/);
    expect(observed).toBe(during.signal); retainedNothing();
    // The provider-owned grant check receives the caller's signal and can stop waiting on it.
    const waiting = new AbortController();
    fake.requests.length = 0; fake.grant_checks = 0;
    fake.on_grant_check = context => new Promise((_resolve, reject) => {
      context?.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true });
    });
    const run = open().runCaptureSourceOnce(FAKE_SOURCE_ID, { signal: waiting.signal });
    await vi.waitFor(() => expect(fake.grant_checks).toBeGreaterThan(0));
    waiting.abort(new Error('cancelled during grant check'));
    await expect(run).rejects.toThrow(/cancelled during grant check/);
    expect(fake.requests).toEqual([]); retainedNothing();
  });

  it('rejects a concurrent run of the same source', async () => {
    const runner = open();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    fake.respond = async request => { await gate; return { items: fakeInitialItems(), ...(request.cursor === undefined ? { next_cursor: FAKE_CURSORS.first } : {}) }; };
    const first = runner.runCaptureSourceOnce(FAKE_SOURCE_ID);
    await vi.waitFor(() => expect(fake.requests).toHaveLength(1));
    await expect(runner.runCaptureSourceOnce(FAKE_SOURCE_ID)).rejects.toThrow(/already has a run in progress/);
    release();
    expect(await first).toEqual({ admitted: 5, duplicate: 0, skipped: 0 });
    expect(await runner.runCaptureSourceOnce(FAKE_SOURCE_ID)).toEqual({ admitted: 0, duplicate: 5, skipped: 0 });
    // A failed run releases the source for the next run on the same runner.
    fake.grant = false;
    await expect(runner.runCaptureSourceOnce(FAKE_SOURCE_ID)).rejects.toThrow(/revoked/);
    fake.grant = true;
    expect(await runner.runCaptureSourceOnce(FAKE_SOURCE_ID)).toEqual({ admitted: 0, duplicate: 5, skipped: 0 });
  });

  it('stops at an unresolved item with a body-free retry reference and keeps the bookmark', async () => {
    const reviewMeetings: CaptureLocalClassifierV1 = { id: 'review-meetings', version: '1',
      rules: [content => content.payload.kind === 'meeting' ? { decision: 'unresolved', reason: 'needs_review' } : undefined] };
    const runner = open({ config: config({ classifier: { id: 'review-meetings', version: '1' } }), classifiers: [reviewMeetings] });
    const result = await runner.runCaptureSourceOnce(FAKE_SOURCE_ID);
    const meeting = buildContextCaptureEnvelopeV2({ identity: FAKE_IDENTITY, external_id: 'meeting-1', captured_at: FAKE_TIMES.first, content: FAKE_CONTENT.meeting() });
    expect(result).toEqual({ admitted: 2, duplicate: 0, skipped: 0, stopped_at: { ...captureRevisionRefV1(meeting), reason: 'needs_review' } });
    expect(JSON.stringify(result)).not.toMatch(/importer ships/);
    expect(count('authority_sources_v1')).toBe(2); expect(bookmark()).toBeUndefined();
    // The retry replays the same batch: earlier items are duplicates and it stops again.
    expect(await runner.runCaptureSourceOnce(FAKE_SOURCE_ID)).toMatchObject({ admitted: 0, duplicate: 2, stopped_at: { reason: 'needs_review' } });
  });

  it('applies kind-based skip rules without storing skipped bodies, and skips tombstones with nothing retained', async () => {
    const skipNotes: CaptureLocalClassifierV1 = { id: 'skip-notes', version: '1',
      rules: [content => content.payload.kind === 'note' ? { decision: 'skip', reason: 'noise' } : undefined] };
    const runner = open({ config: config({ classifier: { id: 'skip-notes', version: '1' } }), classifiers: [skipNotes] });
    expect(await runner.runCaptureSourceOnce(FAKE_SOURCE_ID)).toEqual({ admitted: 4, duplicate: 0, skipped: 1 });
    expect(head('note-1')).toBeUndefined(); expect(bookmark()).toBe(FAKE_CURSORS.first);
    // The follow-up deletes the never-retained note: there is nothing to record it against.
    expect(await runner.runCaptureSourceOnce(FAKE_SOURCE_ID)).toEqual({ admitted: 1, duplicate: 1, skipped: 1 });
    expect(head('note-1')).toBeUndefined();
  });

  it('refuses an unknown classifier or provider before any read', async () => {
    await expect(open({ config: config({ classifier: { id: 'missing', version: '1' } }) }).runCaptureSourceOnce(FAKE_SOURCE_ID)).rejects.toThrow(/classifier is not available/);
    await expect(open({ providers: {} }).runCaptureSourceOnce(FAKE_SOURCE_ID)).rejects.toThrow(/no registered provider/);
    expect(fake.requests).toEqual([]); expect(fake.grant_checks).toBe(0);
  });

  it('refuses another organization, two sources on one adapter instance, and state the lineage guard refuses', () => {
    expect(() => open({ config: fakeCaptureSourceConfig({}, 'org_other') })).toThrow(/another organization/);
    const providers = { [FAKE_IDENTITY.adapter_id]: fake.factory };
    expect(() => openCaptureSourceRunnerV1({ state_directory: directory, configs: [config(), config({ source_id: 'src_fake_copy' })], providers, provider_deps: undefined }))
      .toThrow(/adapter instances must be unique/);
    writeFileSync(join(directory, '.installing-capture'), '');
    expect(() => open()).toThrow(/debris/);
  });
});
