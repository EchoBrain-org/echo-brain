import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { sourceContentSha256V1, type ContextCaptureEnvelopeV1, type SourceAdmissionStoreV1 } from '@echo-brain/organization-processing/core';
import { SqliteContextCaptureReaderV1 } from '../src/adapters/persistence/sqlite/context-capture-reader-v1.js';
import { SqliteContextCaptureStoreV1 } from '../src/adapters/persistence/sqlite/context-capture-store-v1.js';
import { SqliteSourceAdmissionStoreV1 } from '../src/adapters/persistence/sqlite/source-admission-v1.js';
import { intakeContextBatchV1, type ContextIntakeAuthorityV1, type ContextIntakePolicyV1 } from '../src/application/context-intake-v1.js';
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
  it('rechecks the retained policy and exact custody scope inside the SQLite transaction for new and duplicate captures', async () => {
    const drifts: readonly ((base: ContextIntakePolicyV1) => ContextIntakePolicyV1)[] = [
      base => ({ ...base, disposition: 'request_only' }),
      base => ({ ...base, permitted_representations: ['pointer'] }),
      base => ({ ...base, scope: { ...base.scope, custody_ref: 'project:drift' } }),
      base => ({ ...base, scope: { ...base.scope, access_policy_ref: 'context-capture-drift' } }),
    ];
    for (const [index, drift] of drifts.entries()) {
      for (const existing of [false, true]) {
        const value = database();
        if (existing) await intakeContextBatchV1({ identity: CONTEXT_CAPTURE_IDENTITY_V1, sources: [contextCaptureV1()], authority: authority(), store: new SqliteContextCaptureStoreV1(value, authority(), CONTEXT_CAPTURE_IDENTITY_V1) });
        let current = policy(); let preAdmissionChecks = 0; let selectedInTransaction = false;
        const queued: ContextIntakeAuthorityV1 = {
          select: () => { if (value.inTransaction) selectedInTransaction = true; return current; },
          requireCurrent: () => { if (!value.inTransaction && ++preAdmissionChecks === 2) current = drift(policy()); },
        };
        await expect(intakeContextBatchV1({
          identity: CONTEXT_CAPTURE_IDENTITY_V1, sources: [contextCaptureV1()], authority: queued, store: new SqliteContextCaptureStoreV1(value, queued, CONTEXT_CAPTURE_IDENTITY_V1),
        }), `drift ${index}`).rejects.toThrow();
        expect(selectedInTransaction, `drift ${index}`).toBe(true);
        expect(counts(value).contents, `drift ${index}`).toBe(existing ? 1 : 0);
      }
    }

    const value = database(); let requireCurrentInTransaction = false;
    const fenced = authority({ requireCurrent: () => { if (value.inTransaction) requireCurrentInTransaction = true; } });
    const store = new SqliteContextCaptureStoreV1(value, fenced, CONTEXT_CAPTURE_IDENTITY_V1);
    await intakeContextBatchV1({ identity: CONTEXT_CAPTURE_IDENTITY_V1, sources: [contextCaptureV1()], authority: fenced, store });
    await expect(intakeContextBatchV1({ identity: CONTEXT_CAPTURE_IDENTITY_V1, sources: [contextCaptureV1()], authority: fenced, store }))
      .resolves.toMatchObject([{ admission: 'duplicate' }]);
    expect(requireCurrentInTransaction).toBe(true);
  });

  it('fails closed for an asynchronous Authority fence and for cancellation inside the custody transaction', async () => {
    const asyncDatabase = database(); let asyncInTransaction = false;
    const asyncAuthority = authority({ requireCurrent: (() => {
      if (!asyncDatabase.inTransaction) return undefined;
      asyncInTransaction = true;
      return Promise.reject(new Error('late async authorization rejected'));
    }) as unknown as ContextIntakeAuthorityV1['requireCurrent'] });
    await expect(intakeContextBatchV1({
      identity: CONTEXT_CAPTURE_IDENTITY_V1, sources: [contextCaptureV1()], authority: asyncAuthority,
      store: new SqliteContextCaptureStoreV1(asyncDatabase, asyncAuthority, CONTEXT_CAPTURE_IDENTITY_V1),
    })).rejects.toThrow('synchronously');
    expect(asyncInTransaction).toBe(true);
    expect(counts(asyncDatabase).contents).toBe(0);

    const cancelledDatabase = database(); const controller = new AbortController(); let cancelledInTransaction = false;
    const cancelledAuthority = authority({ requireCurrent: () => {
      if (!cancelledDatabase.inTransaction) return;
      cancelledInTransaction = true;
      controller.abort(new Error('cancelled in custody fence'));
    } });
    await expect(intakeContextBatchV1({
      identity: CONTEXT_CAPTURE_IDENTITY_V1, sources: [contextCaptureV1()], authority: cancelledAuthority,
      store: new SqliteContextCaptureStoreV1(cancelledDatabase, cancelledAuthority, CONTEXT_CAPTURE_IDENTITY_V1), context: { signal: controller.signal },
    })).rejects.toThrow('cancelled in custody fence');
    expect(cancelledInTransaction).toBe(true);
    expect(counts(cancelledDatabase).contents).toBe(0);
  });

  it('binds direct persistence to the configured adapter and snapshots source and scope against Authority mutation', async () => {
    const value = database();
    const foreignStore = new SqliteContextCaptureStoreV1(value, authority(), { ...CONTEXT_CAPTURE_IDENTITY_V1, adapter_id: 'foreign-context' });
    await expect(foreignStore.admitSourceRevision({ scope: CONTEXT_CAPTURE_SCOPE_V1, source: contextCaptureV1() })).rejects.toThrow('configured adapter');
    expect(counts(value).contents).toBe(0);

    const source = contextCaptureV1();
    const expectedScope = { ...CONTEXT_CAPTURE_SCOPE_V1 };
    let selectMutationRejected = false; let fenceMutationRejected = false;
    const mutating: ContextIntakeAuthorityV1 = {
      select: selected => {
        try { (selected as unknown as { content: { label: string } }).content.label = 'authority mutation'; } catch { selectMutationRejected = true; }
        return policy();
      },
      requireCurrent: (selected, selectedPolicy) => {
        if (!value.inTransaction) return;
        try {
          (selected as unknown as { revision: { revision_id: string } }).revision.revision_id = 'authority mutation';
          (selectedPolicy.scope as unknown as { custody_ref: string }).custody_ref = 'authority mutation';
        } catch { fenceMutationRejected = true; }
      },
    };
    await expect(new SqliteContextCaptureStoreV1(value, mutating, CONTEXT_CAPTURE_IDENTITY_V1).admitSourceRevision({ scope: expectedScope, source })).resolves.toBe('admitted');
    expect(selectMutationRejected).toBe(true);
    expect(fenceMutationRejected).toBe(true);
    const retained = new SqliteContextCaptureReaderV1(value).list({ organization_id: CONTEXT_CAPTURE_SCOPE_V1.organization_id });
    expect(retained.map(entry => [entry.source, entry.scope])).toEqual([[source, expectedScope]]);
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

  it('rejects a malformed capture under either disposition and malformed Authority policy before storage', async () => {
    const value = database();
    const store = new SqliteSourceAdmissionStoreV1(value);
    const base = contextCaptureV1();
    const malformed = withContent(base, { ...base.content, extra: 'provider-cannot-widen-contract' });
    for (const disposition of ['retained', 'request_only'] as const) {
      await expect(intakeContextBatchV1({ identity: CONTEXT_CAPTURE_IDENTITY_V1, sources: [malformed], authority: authority({ disposition }), store })).rejects.toThrow('unknown field');
    }
    const policyAccessor = { ...policy() } as { disposition: ContextIntakePolicyV1['disposition']; scope: ContextIntakePolicyV1['scope']; permitted_representations: readonly string[] };
    Object.defineProperty(policyAccessor, 'scope', { enumerable: true, get: () => CONTEXT_CAPTURE_SCOPE_V1 });
    for (const [selected, message] of [
      [{ ...policy(), extra: 'not-a-policy-field' }, 'unknown field'],
      [{ ...policy(), scope: { ...CONTEXT_CAPTURE_SCOPE_V1, analysis_policy: 'automatic' } }, 'not authorized'],
      [policyAccessor, 'non-data fields'],
    ] as const) {
      await expect(intakeContextBatchV1({ identity: CONTEXT_CAPTURE_IDENTITY_V1, sources: [base], store, authority: authority({ selected }) })).rejects.toThrow(message);
    }
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

  it('rejects contradictory excerpts at the SQLite capture boundary without the batch coordinator', async () => {
    const value = database();
    const source = contextCaptureV1({ representation: { kind: 'excerpt', passages: [
      { id: 'first', source_anchor: 'paragraph:1', start: 0, end: 4, text: 'good' },
      { id: 'second', source_anchor: 'paragraph:1', start: 0, end: 4, text: 'evil' },
    ] } });
    const store = new SqliteContextCaptureStoreV1(value, authority(), CONTEXT_CAPTURE_IDENTITY_V1);
    await expect(store.admitSourceRevision({ source, scope: CONTEXT_CAPTURE_SCOPE_V1 }))
      .rejects.toThrow('Context excerpts conflict at the same source anchor');
    expect(counts(value)).toEqual({ sources: 0, revisions: 0, contents: 0, representations: 0 });
  });

  it('retains every structured source type exactly and only as a source observation', async () => {
    const value = database();
    const captures = (['document', 'note', 'message', 'ticket', 'meeting', 'activity', 'task', 'decision'] as const).map(source_type => contextCaptureV1({
      external_id: `${source_type}-metadata`, source_type, representation: excerptRepresentationV1(`${source_type} evidence.`),
    }));
    await intakeContextBatchV1({ identity: CONTEXT_CAPTURE_IDENTITY_V1, sources: captures, authority: authority(), store: new SqliteSourceAdmissionStoreV1(value) });
    const retained = new SqliteContextCaptureReaderV1(value).list({ organization_id: CONTEXT_CAPTURE_SCOPE_V1.organization_id });
    expect(retained.map(entry => entry.source)).toEqual([...captures].sort((left, right) => left.item.source_id.localeCompare(right.item.source_id)));
    expect(retained.every(entry => entry.source.content.truth_status === 'source_observation')).toBe(true);
    expect(retained.map(entry => entry.scope)).toEqual(new Array(8).fill(CONTEXT_CAPTURE_SCOPE_V1));
  });

  it('deduplicates an identical revision, rejects immutable conflicts, and retains a new revision separately', async () => {
    const value = database();
    const store = new SqliteSourceAdmissionStoreV1(value);
    const first = contextCaptureV1();
    const replay = contextCaptureV1({ captured_at: '2026-10-01T00:01:00.000Z' });
    const conflicts = [
      contextCaptureV1({ representation: snapshotRepresentationV1('Changed source bytes.') }),
      contextCaptureV1({ source_updated_at: '2026-10-01T00:01:00.000Z' }),
      contextCaptureV1({ payload: { schema_version: 1, kind: 'document', media_type: 'text/markdown', language: 'fr' } }),
    ];
    const next = contextCaptureV1({ revision_id: 'revision-2', previous_revision_id: 'revision-1', representation: snapshotRepresentationV1('The revised release is Monday.') });

    await expect(intakeContextBatchV1({ identity: CONTEXT_CAPTURE_IDENTITY_V1, sources: [first], authority: authority(), store })).resolves.toMatchObject([{ admission: 'admitted' }]);
    await expect(intakeContextBatchV1({ identity: CONTEXT_CAPTURE_IDENTITY_V1, sources: [replay], authority: authority(), store })).resolves.toMatchObject([{ admission: 'duplicate' }]);
    for (const changed of conflicts) {
      await expect(intakeContextBatchV1({ identity: CONTEXT_CAPTURE_IDENTITY_V1, sources: [changed], authority: authority(), store })).rejects.toThrow('conflicts');
    }
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

  it('permits a bounded replay after a transient admission failure', async () => {
    const value = database();
    const source = contextCaptureV1();
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
