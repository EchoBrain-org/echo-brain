import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { sourceContentSha256V1, type SourceAdmissionStoreV1 } from '@echo-brain/organization-processing/core';
import { SqliteContextCaptureReaderV1 } from '../src/adapters/persistence/sqlite/context-capture-reader-v1.js';
import { SqliteSourceAdmissionStoreV1 } from '../src/adapters/persistence/sqlite/source-admission-v1.js';
import { intakeContextBatchV1, type ContextCaptureEnvelopeV1, type ContextIntakeAuthorityV1, type ContextIntakePolicyV1 } from '../src/application/context-intake-v1.js';
import { projectContextDatabase } from './fixtures/project-context-sqlite.js';
import {
  CONTEXT_CAPTURE_IDENTITY_V1, CONTEXT_CAPTURE_SCOPE_V1, contextCaptureV1,
  excerptRepresentationV1, pointerRepresentationV1, snapshotRepresentationV1,
} from './fixtures/context-capture-v1.js';

const databases: Database.Database[] = [];
const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

function database(): Database.Database {
  const value = projectContextDatabase();
  databases.push(value);
  return value;
}

function policy(disposition: ContextIntakePolicyV1['disposition'] = 'retained'): ContextIntakePolicyV1 {
  return { disposition, scope: CONTEXT_CAPTURE_SCOPE_V1, permitted_representations: ['pointer', 'excerpt', 'full_snapshot'] };
}

function authority(options: {
  readonly disposition?: ContextIntakePolicyV1['disposition'];
  readonly requireCurrent?: (source: ContextCaptureEnvelopeV1, selected: ContextIntakePolicyV1) => void;
  readonly selected?: unknown;
} = {}): ContextIntakeAuthorityV1 {
  return {
    select: () => (options.selected ?? policy(options.disposition)) as ContextIntakePolicyV1,
    requireCurrent: options.requireCurrent ?? (() => undefined),
  };
}

function counts(value: Database.Database): Record<string, number> {
  return {
    sources: (value.prepare('SELECT count(*) AS n FROM authority_sources_v1').get() as { n: number }).n,
    revisions: (value.prepare('SELECT count(*) AS n FROM authority_source_revisions_v1').get() as { n: number }).n,
    contents: (value.prepare('SELECT count(*) AS n FROM authority_source_contents_v1').get() as { n: number }).n,
    representations: (value.prepare('SELECT count(*) AS n FROM authority_source_representations_v1').get() as { n: number }).n,
  };
}

function withContent(source: ContextCaptureEnvelopeV1, content: unknown): unknown {
  return { ...source, content, revision: { ...source.revision, content_sha256: sourceContentSha256V1(content) } };
}

describe('context intake V1 shared gate', () => {
  it('repeats the Authority retention fence inside the SQLite transaction after a queued admission', async () => {
    const value = database(); let permitted = true;
    const selected = authority({ requireCurrent: () => { if (!permitted) throw new Error('retention revoked'); } });
    const real = new SqliteSourceAdmissionStoreV1(value, (source, scope) => {
      expect(value.inTransaction).toBe(true);
      selected.requireCurrent(source as ContextCaptureEnvelopeV1, { ...policy(), scope });
    });
    const queued: SourceAdmissionStoreV1 = { admitSourceRevision: async (input, context) => {
      await Promise.resolve(); permitted = false;
      return real.admitSourceRevision(input, context);
    } };
    await expect(intakeContextBatchV1({ identity: CONTEXT_CAPTURE_IDENTITY_V1, sources: [contextCaptureV1()], authority: selected, store: queued })).rejects.toThrow('retention revoked');
    expect(counts(value)).toEqual({ sources: 0, revisions: 0, contents: 0, representations: 0 });
  });
  it('retains exact permitted pointer, excerpt and full snapshot captures through one admission store', async () => {
    const value = database();
    const captures = [
      contextCaptureV1({ external_id: 'pointer', representation: pointerRepresentationV1() }),
      contextCaptureV1({ external_id: 'excerpt', representation: excerptRepresentationV1('The owner is Ada.') }),
      contextCaptureV1({ external_id: 'snapshot', representation: snapshotRepresentationV1('The release is Friday.') }),
    ];

    await expect(intakeContextBatchV1({ identity: CONTEXT_CAPTURE_IDENTITY_V1, sources: captures, authority: authority(), store: new SqliteSourceAdmissionStoreV1(value) }))
      .resolves.toMatchObject([{ admission: 'admitted' }, { admission: 'admitted' }, { admission: 'admitted' }]);

    const retained = new SqliteContextCaptureReaderV1(value).list({ organization_id: CONTEXT_CAPTURE_SCOPE_V1.organization_id });
    const orderedCaptures = [...captures].sort((left, right) => left.item.source_id.localeCompare(right.item.source_id));
    expect(retained.map(entry => entry.source)).toEqual(orderedCaptures);
    expect(retained.map(entry => entry.scope)).toEqual([CONTEXT_CAPTURE_SCOPE_V1, CONTEXT_CAPTURE_SCOPE_V1, CONTEXT_CAPTURE_SCOPE_V1]);
    expect(retained.find(entry => entry.source.item.external_id === 'pointer')!.source.content.representation).toEqual(pointerRepresentationV1());
    expect(retained.find(entry => entry.source.item.external_id === 'excerpt')!.source.content.representation).toEqual(excerptRepresentationV1('The owner is Ada.'));
    expect(retained.find(entry => entry.source.item.external_id === 'snapshot')!.source.content.representation).toEqual(snapshotRepresentationV1('The release is Friday.'));
  });

  it('survives a real file-backed SQLite restart with exact representations, anchors, policy bindings and replay deduplication', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'echo-context-intake-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'authority.sqlite');
    const initial = projectContextDatabase(path);
    const pointer = contextCaptureV1({ external_id: 'restart-pointer', representation: pointerRepresentationV1('synthetic://restart/pointer') });
    const excerpt = contextCaptureV1({ external_id: 'restart-excerpt', representation: excerptRepresentationV1('A retained exact excerpt.') });
    const snapshot = contextCaptureV1({
      external_id: 'restart-snapshot', representation: snapshotRepresentationV1('A retained full snapshot.'),
      observations: [{
        kind: 'references', anchor_id: 'passage-1',
        target: { source_id: pointer.item.source_id, revision_id: pointer.revision.revision_id }, occurred_at: '2026-10-01T00:00:00.000Z',
      }],
    });
    const captures = [pointer, excerpt, snapshot];
    await intakeContextBatchV1({ identity: CONTEXT_CAPTURE_IDENTITY_V1, sources: captures, authority: authority(), store: new SqliteSourceAdmissionStoreV1(initial) });
    initial.close();

    const reopened = new Database(path);
    reopened.pragma('foreign_keys = ON');
    databases.push(reopened);
    const reader = new SqliteContextCaptureReaderV1(reopened);
    const retained = reader.list({ organization_id: CONTEXT_CAPTURE_SCOPE_V1.organization_id });
    const ordered = [...captures].sort((left, right) => left.item.source_id.localeCompare(right.item.source_id));
    expect(retained.map(entry => entry.source)).toEqual(ordered);
    expect(retained.map(entry => entry.scope)).toEqual([CONTEXT_CAPTURE_SCOPE_V1, CONTEXT_CAPTURE_SCOPE_V1, CONTEXT_CAPTURE_SCOPE_V1]);
    expect(retained.find(entry => entry.source.item.external_id === 'restart-snapshot')!.source.content.observations).toEqual(snapshot.content.observations);

    const replay = captures.map(source => ({ ...source, revision: { ...source.revision, captured_at: '2026-10-01T00:02:00.000Z' } }));
    await expect(intakeContextBatchV1({ identity: CONTEXT_CAPTURE_IDENTITY_V1, sources: replay, authority: authority(), store: new SqliteSourceAdmissionStoreV1(reopened) }))
      .resolves.toMatchObject([{ admission: 'duplicate' }, { admission: 'duplicate' }, { admission: 'duplicate' }]);
    expect(reader.list({ organization_id: CONTEXT_CAPTURE_SCOPE_V1.organization_id }).map(entry => entry.source)).toEqual(ordered);
  });

  it('rejects noncanonical identity, provenance, anchors, bounds, closed fields and Authority policy before storage', async () => {
    const value = database();
    const store = new SqliteSourceAdmissionStoreV1(value);
    const base = contextCaptureV1();
    const invalid = [
      { ...base, item: { ...base.item, source_id: 'source:not-canonical' } },
      { ...base, content: { ...base.content, provenance: { ...base.content.provenance, source_updated_at: '2026-10-01' } } },
      { ...base, content: { ...base.content, representation: { kind: 'excerpt', passages: [{ id: 'bad', source_anchor: 'p:1', start: 0, end: 3, text: 'four' }] } } },
      { ...base, content: { ...base.content, representation: snapshotRepresentationV1('x'.repeat(128 * 1024 + 1)) } },
      { ...base, content: { ...base.content, extra: 'provider-cannot-widen-contract' } },
    ].map(source => ({ ...source, revision: { ...source.revision, content_sha256: sourceContentSha256V1(source.content) } }));

    for (const source of invalid) {
      await expect(intakeContextBatchV1({ identity: CONTEXT_CAPTURE_IDENTITY_V1, sources: [source], authority: authority(), store })).rejects.toThrow();
    }
    await expect(intakeContextBatchV1({
      identity: CONTEXT_CAPTURE_IDENTITY_V1, sources: [base], store,
      authority: authority({ selected: { ...policy(), extra: 'not-a-policy-field' } }),
    })).rejects.toThrow('unknown field');
    await expect(intakeContextBatchV1({
      identity: CONTEXT_CAPTURE_IDENTITY_V1, sources: [base], store,
      authority: authority({ selected: { ...policy(), scope: { ...CONTEXT_CAPTURE_SCOPE_V1, analysis_policy: 'automatic' } } }),
    })).rejects.toThrow('not authorized');
    expect(counts(value)).toEqual({ sources: 0, revisions: 0, contents: 0, representations: 0 });
  });

  it('does not treat a read grant as retention permission and keeps request-only captures out of durable custody', async () => {
    const value = database();
    const capture = contextCaptureV1({ representation: excerptRepresentationV1('A live reader may see this.') });
    let currentReadGrantWasChecked = false;
    const result = await intakeContextBatchV1({
      identity: CONTEXT_CAPTURE_IDENTITY_V1, sources: [capture], store: new SqliteSourceAdmissionStoreV1(value),
      authority: authority({ disposition: 'request_only', requireCurrent: () => { currentReadGrantWasChecked = true; } }),
    });
    expect(currentReadGrantWasChecked).toBe(true);
    expect(result).toMatchObject([{ admission: 'request_only', source: capture }]);
    expect(counts(value)).toEqual({ sources: 0, revisions: 0, contents: 0, representations: 0 });
  });

  it('rejects malformed identities, digests, anchors and bounds equally for retained and request-only observations', async () => {
    const value = database();
    const base = contextCaptureV1();
    const malformed = [
      { ...base, item: { ...base.item, adapter: { ...base.item.adapter, instance_id: 'forged-instance' } } },
      { ...base, revision: { ...base.revision, content_sha256: '0'.repeat(64) } },
      withContent(base, { ...base.content, representation: { kind: 'excerpt', passages: [{ id: 'no-anchor', source_anchor: '', start: 0, end: 4, text: 'text' }] } }),
      withContent(base, { ...base.content, label: 'x'.repeat(201) }),
    ];
    for (const disposition of ['retained', 'request_only'] as const) {
      for (const source of malformed) {
        await expect(intakeContextBatchV1({
          identity: CONTEXT_CAPTURE_IDENTITY_V1, sources: [source], authority: authority({ disposition }), store: new SqliteSourceAdmissionStoreV1(value),
        })).rejects.toThrow();
      }
    }
    expect(counts(value)).toEqual({ sources: 0, revisions: 0, contents: 0, representations: 0 });
  });

  it('rejects pointer observations and provider attempts to introduce policy or approval claims', async () => {
    const value = database();
    const pointer = contextCaptureV1({ representation: pointerRepresentationV1() });
    const target = contextCaptureV1({ external_id: 'target' });
    const pointerObservation = withContent(pointer, {
      ...pointer.content,
      observations: [{ kind: 'references', anchor_id: 'metadata:pointer', target: { source_id: target.item.source_id, revision_id: target.revision.revision_id }, occurred_at: '2026-10-01T00:00:00.000Z' }],
    });
    const providerPolicy = withContent(pointer, { ...pointer.content, policy: { disposition: 'retained', audience: 'everyone' } });
    const providerApproval = withContent(pointer, { ...pointer.content, approval: { approved: true } });
    const providerContributor = { ...pointer, revision: { ...pointer.revision, contributor: { principal_id: 'prn_provider', membership_id: 'mem_provider' } } };
    for (const source of [pointerObservation, providerPolicy, providerApproval, providerContributor]) {
      await expect(intakeContextBatchV1({ identity: CONTEXT_CAPTURE_IDENTITY_V1, sources: [source], authority: authority(), store: new SqliteSourceAdmissionStoreV1(value) })).rejects.toThrow();
    }
    expect(counts(value)).toEqual({ sources: 0, revisions: 0, contents: 0, representations: 0 });
  });

  it('rejects sparse, accessor and symbol-bearing adapter or policy data before either disposition', async () => {
    const value = database();
    const sparseBase = contextCaptureV1({ external_id: 'sparse' });
    const sparse = { ...sparseBase, content: { ...sparseBase.content, observations: new Array(1) } };
    const accessor = contextCaptureV1({ external_id: 'accessor' });
    Object.defineProperty((accessor as unknown as { content: object }).content, 'label', {
      enumerable: true, configurable: true, get: () => 'getter must not run',
    });
    const symbol = contextCaptureV1({ external_id: 'symbol' });
    Object.defineProperty((symbol as unknown as { content: object }).content, Symbol('provider-hidden-field'), { enumerable: true, value: 'hidden' });
    for (const disposition of ['retained', 'request_only'] as const) {
      for (const source of [sparse, accessor, symbol]) {
        await expect(intakeContextBatchV1({
          identity: CONTEXT_CAPTURE_IDENTITY_V1, sources: [source], authority: authority({ disposition }), store: new SqliteSourceAdmissionStoreV1(value),
        })).rejects.toThrow();
      }
      const policyAccessor = { ...policy(disposition) } as { disposition: ContextIntakePolicyV1['disposition']; scope: ContextIntakePolicyV1['scope']; permitted_representations: readonly string[] };
      Object.defineProperty(policyAccessor, 'scope', { enumerable: true, get: () => CONTEXT_CAPTURE_SCOPE_V1 });
      await expect(intakeContextBatchV1({
        identity: CONTEXT_CAPTURE_IDENTITY_V1, sources: [contextCaptureV1()], store: new SqliteSourceAdmissionStoreV1(value), authority: authority({ selected: policyAccessor }),
      })).rejects.toThrow();
    }
    expect(counts(value)).toEqual({ sources: 0, revisions: 0, contents: 0, representations: 0 });
  });

  it('retains activity, task and decision metadata only as source observations without permission fields', async () => {
    const value = database();
    const captures = (['activity', 'task', 'decision'] as const).map(source_type => contextCaptureV1({
      external_id: `${source_type}-metadata`, source_type, representation: excerptRepresentationV1(`${source_type} evidence.`),
    }));
    await intakeContextBatchV1({ identity: CONTEXT_CAPTURE_IDENTITY_V1, sources: captures, authority: authority(), store: new SqliteSourceAdmissionStoreV1(value) });
    const retained = new SqliteContextCaptureReaderV1(value).list({ organization_id: CONTEXT_CAPTURE_SCOPE_V1.organization_id });
    expect(retained.map(entry => [entry.source.content.source_type, entry.source.content.truth_status]).sort()).toEqual([
      ['activity', 'source_observation'], ['decision', 'source_observation'], ['task', 'source_observation'],
    ]);
    for (const entry of retained) {
      expect(Object.keys(entry.source.content)).not.toContain('policy');
      expect(Object.keys(entry.source.content)).not.toContain('approval');
      expect(Object.keys(entry.source.content)).not.toContain('membership');
      expect(entry.scope).toEqual(CONTEXT_CAPTURE_SCOPE_V1);
    }
  });

  it('deduplicates an identical revision, rejects immutable conflicts, and retains a new revision separately', async () => {
    const value = database();
    const store = new SqliteSourceAdmissionStoreV1(value);
    const first = contextCaptureV1();
    const replay = contextCaptureV1({ captured_at: '2026-10-01T00:01:00.000Z' });
    const changed = contextCaptureV1({ representation: snapshotRepresentationV1('Changed source bytes.') });
    const next = contextCaptureV1({ revision_id: 'revision-2', previous_revision_id: 'revision-1', representation: snapshotRepresentationV1('The revised release is Monday.') });

    await expect(intakeContextBatchV1({ identity: CONTEXT_CAPTURE_IDENTITY_V1, sources: [first], authority: authority(), store })).resolves.toMatchObject([{ admission: 'admitted' }]);
    await expect(intakeContextBatchV1({ identity: CONTEXT_CAPTURE_IDENTITY_V1, sources: [replay], authority: authority(), store })).resolves.toMatchObject([{ admission: 'duplicate' }]);
    await expect(intakeContextBatchV1({ identity: CONTEXT_CAPTURE_IDENTITY_V1, sources: [changed], authority: authority(), store })).rejects.toThrow('conflicts');
    await expect(intakeContextBatchV1({ identity: CONTEXT_CAPTURE_IDENTITY_V1, sources: [next], authority: authority(), store })).resolves.toMatchObject([{ admission: 'admitted' }]);
    expect(new SqliteContextCaptureReaderV1(value).list({ organization_id: CONTEXT_CAPTURE_SCOPE_V1.organization_id }).map(entry => entry.source.revision.revision_id))
      .toEqual(['revision-1', 'revision-2']);
  });

  it('validates a whole batch before admitting any capture', async () => {
    const value = database();
    const valid = contextCaptureV1();
    const badBase = contextCaptureV1({ external_id: 'bad' });
    const invalidContent = { ...badBase.content, truth_status: 'approved_fact' };
    const invalid = { ...badBase, content: invalidContent, revision: { ...badBase.revision, content_sha256: sourceContentSha256V1(invalidContent) } };
    await expect(intakeContextBatchV1({ identity: CONTEXT_CAPTURE_IDENTITY_V1, sources: [valid, invalid], authority: authority(), store: new SqliteSourceAdmissionStoreV1(value) })).rejects.toThrow('unsupported');
    expect(counts(value)).toEqual({ sources: 0, revisions: 0, contents: 0, representations: 0 });
  });

  it('rejects conflicting Authority custody bindings for one stable source before any batch write', async () => {
    const value = database();
    const first = contextCaptureV1({ revision_id: 'revision-1' });
    const second = contextCaptureV1({ revision_id: 'revision-2', previous_revision_id: 'revision-1' });
    const changingAuthority: ContextIntakeAuthorityV1 = {
      select: source => source.revision.revision_id === 'revision-1'
        ? policy()
        : { ...policy(), scope: { ...CONTEXT_CAPTURE_SCOPE_V1, custody_ref: 'project:conflicting-fixture' } },
      requireCurrent: () => undefined,
    };
    await expect(intakeContextBatchV1({
      identity: CONTEXT_CAPTURE_IDENTITY_V1, sources: [first, second], authority: changingAuthority, store: new SqliteSourceAdmissionStoreV1(value),
    })).rejects.toThrow('custody conflicts');
    expect(counts(value)).toEqual({ sources: 0, revisions: 0, contents: 0, representations: 0 });
  });

  it('rejects a partial retained input set and detects corruption in current retained content', async () => {
    const value = database();
    const first = contextCaptureV1({ external_id: 'complete-a' });
    const second = contextCaptureV1({ external_id: 'complete-b' });
    await intakeContextBatchV1({ identity: CONTEXT_CAPTURE_IDENTITY_V1, sources: [first, second], authority: authority(), store: new SqliteSourceAdmissionStoreV1(value) });
    const reader = new SqliteContextCaptureReaderV1(value);
    expect(() => reader.list({ organization_id: CONTEXT_CAPTURE_SCOPE_V1.organization_id, limit: 1 })).toThrow('exceeds its bound');

    value.exec('DROP TRIGGER authority_source_contents_v1_update_denied');
    value.prepare('UPDATE authority_source_contents_v1 SET content_json=? WHERE source_id=? AND revision_id=?')
      .run('{"kind":"echo-context-capture-v1"}', first.item.source_id, first.revision.revision_id);
    expect(() => reader.list({ organization_id: CONTEXT_CAPTURE_SCOPE_V1.organization_id })).toThrow();
  });

  it('snapshots input before policy checks, rechecks Authority, and lets cancellation stop a held admission', async () => {
    const value = database();
    const original = contextCaptureV1();
    let checks = 0;
    const rejected = authority({ requireCurrent: () => {
      checks += 1;
      if (checks === 1) (original as unknown as { content: { label: string } }).content.label = 'mutated after input snapshot';
      if (checks === 2) throw new Error('policy changed');
    } });
    await expect(intakeContextBatchV1({ identity: CONTEXT_CAPTURE_IDENTITY_V1, sources: [original], authority: rejected, store: new SqliteSourceAdmissionStoreV1(value) })).rejects.toThrow('policy changed');
    expect(checks).toBe(2);
    expect(counts(value)).toEqual({ sources: 0, revisions: 0, contents: 0, representations: 0 });

    let enter!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const real = new SqliteSourceAdmissionStoreV1(value);
    const blockingStore: SourceAdmissionStoreV1 = { admitSourceRevision: async (input, context) => {
      enter(); await held; return real.admitSourceRevision(input, context);
    } };
    const controller = new AbortController();
    const pending = intakeContextBatchV1({ identity: CONTEXT_CAPTURE_IDENTITY_V1, sources: [contextCaptureV1()], authority: authority(), store: blockingStore, context: { signal: controller.signal } });
    await entered;
    controller.abort(new Error('fixture cancelled'));
    release();
    await expect(pending).rejects.toThrow('fixture cancelled');
    expect(counts(value)).toEqual({ sources: 0, revisions: 0, contents: 0, representations: 0 });
  });

  it('rolls back a real SQLite failure and permits a bounded replay after a transient admission failure', async () => {
    const value = database();
    const source = contextCaptureV1();
    value.exec("CREATE TRIGGER context_capture_fail BEFORE INSERT ON authority_source_contents_v1 BEGIN SELECT RAISE(ABORT,'fixture storage unavailable'); END;");
    await expect(intakeContextBatchV1({ identity: CONTEXT_CAPTURE_IDENTITY_V1, sources: [source], authority: authority(), store: new SqliteSourceAdmissionStoreV1(value) })).rejects.toThrow('fixture storage unavailable');
    expect(counts(value)).toEqual({ sources: 0, revisions: 0, contents: 0, representations: 0 });
    value.exec('DROP TRIGGER context_capture_fail');

    let attempts = 0;
    const real = new SqliteSourceAdmissionStoreV1(value);
    const transient: SourceAdmissionStoreV1 = { admitSourceRevision: async (input, context) => {
      attempts += 1;
      if (attempts === 1) throw new Error('temporary fixture failure');
      return real.admitSourceRevision(input, context);
    } };
    await expect(intakeContextBatchV1({ identity: CONTEXT_CAPTURE_IDENTITY_V1, sources: [source], authority: authority(), store: transient })).rejects.toThrow('temporary fixture failure');
    await expect(intakeContextBatchV1({ identity: CONTEXT_CAPTURE_IDENTITY_V1, sources: [source], authority: authority(), store: transient })).resolves.toMatchObject([{ admission: 'admitted' }]);
    expect(attempts).toBe(2);
    expect(counts(value)).toEqual({ sources: 1, revisions: 1, contents: 1, representations: 0 });
  });

  it('keeps earlier per-capture admissions durable when a later capture fails, then replay recovers', async () => {
    const value = database();
    const first = contextCaptureV1({ external_id: 'mixed-first' });
    const second = contextCaptureV1({ external_id: 'mixed-second' });
    value.exec(`CREATE TRIGGER context_capture_later_failure BEFORE INSERT ON authority_source_contents_v1
      WHEN NEW.source_id = '${second.item.source_id}' BEGIN SELECT RAISE(ABORT,'later fixture failure'); END;`);
    const store = new SqliteSourceAdmissionStoreV1(value);
    await expect(intakeContextBatchV1({ identity: CONTEXT_CAPTURE_IDENTITY_V1, sources: [first, second], authority: authority(), store })).rejects.toThrow('later fixture failure');
    expect(counts(value)).toEqual({ sources: 1, revisions: 1, contents: 1, representations: 0 });
    value.exec('DROP TRIGGER context_capture_later_failure');
    await expect(intakeContextBatchV1({ identity: CONTEXT_CAPTURE_IDENTITY_V1, sources: [first, second], authority: authority(), store }))
      .resolves.toMatchObject([{ admission: 'duplicate' }, { admission: 'admitted' }]);
    expect(counts(value)).toEqual({ sources: 2, revisions: 2, contents: 2, representations: 0 });
  });
});
