import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { sourceContentSha256V1 } from '@echo-brain/organization-processing/core';
import { SqliteContextCaptureReaderV1 } from '../src/adapters/persistence/sqlite/context-capture-reader-v1.js';
import { SqliteContextCaptureStoreV1 } from '../src/adapters/persistence/sqlite/context-capture-store-v1.js';
import { intakeContextBatchV1, type ContextCaptureEnvelopeV1, type ContextIntakeAuthorityV1, type ContextIntakePolicyV1 } from '../src/application/context-intake-v1.js';
import { projectContextDatabase } from './fixtures/project-context-sqlite.js';
import {
  CONTEXT_PROVIDER_CONFORMANCE_IDENTITY_V1, CONTEXT_PROVIDER_CONFORMANCE_SCOPE_V1, ContextProviderConformanceAdapterV1,
  contextProviderConformancePayloadsV1, mapContextProviderConformancePayloadV1, mapContextProviderDocumentFallbackV1,
  type ContextProviderConformancePayloadV1,
} from './fixtures/context-provider-conformance-v1.js';

const databases: Database.Database[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

function database(): Database.Database {
  const value = projectContextDatabase();
  databases.push(value);
  return value;
}

function count(value: Database.Database): number {
  return (value.prepare('SELECT count(*) AS n FROM authority_source_contents_v1').get() as { n: number }).n;
}

function retainedPolicy(overrides: Partial<ContextIntakePolicyV1> = {}): ContextIntakePolicyV1 {
  return {
    disposition: 'retained', scope: CONTEXT_PROVIDER_CONFORMANCE_SCOPE_V1,
    permitted_representations: ['pointer', 'excerpt', 'full_snapshot'], ...overrides,
  };
}

function authority(select: (source: ContextCaptureEnvelopeV1) => ContextIntakePolicyV1, requireCurrent: ContextIntakeAuthorityV1['requireCurrent'] = () => undefined): ContextIntakeAuthorityV1 {
  return { select, requireCurrent };
}

function remap(input: ContextProviderConformancePayloadV1, changes: Partial<ContextProviderConformancePayloadV1>): ContextCaptureEnvelopeV1 {
  return mapContextProviderConformancePayloadV1({ ...input, ...changes } as ContextProviderConformancePayloadV1);
}

function withContent(source: ContextCaptureEnvelopeV1, content: unknown): unknown {
  return { ...source, content, revision: { ...source.revision, content_sha256: sourceContentSha256V1(content) } };
}

describe('context provider conformance V1', () => {
  it('maps source adapters through shared retained and request-only intake with exact closed structured payload roundtrips', async () => {
    const retainedDatabase = database();
    const payloads = contextProviderConformancePayloadsV1();
    const adapter = new ContextProviderConformanceAdapterV1(payloads);
    const injectedAdapter = new ContextProviderConformanceAdapterV1(
      [{ raw: payloads[0]! }],
      (raw, identity) => mapContextProviderConformancePayloadV1(raw.raw, identity),
    );
    const injected = await injectedAdapter.pull({ limit: 1 });
    expect(injected.sources).toEqual([mapContextProviderConformancePayloadV1(payloads[0]!, injectedAdapter.identity)]);
    const pulled = await adapter.pull({ limit: 8 });
    const retainedAuthority = authority(() => retainedPolicy());
    const retained = await intakeContextBatchV1({
      identity: adapter.identity, sources: pulled.sources, authority: retainedAuthority,
      store: new SqliteContextCaptureStoreV1(retainedDatabase, retainedAuthority, adapter.identity),
    });
    expect(retained.map(result => result.admission)).toEqual(new Array(8).fill('admitted'));
    const persisted = new SqliteContextCaptureReaderV1(retainedDatabase).list({ organization_id: CONTEXT_PROVIDER_CONFORMANCE_SCOPE_V1.organization_id });
    const expected = pulled.sources.slice().sort((left, right) => left.item.source_id.localeCompare(right.item.source_id));
    expect(persisted.map(entry => entry.source)).toEqual(expected);
    expect(persisted.map(entry => entry.scope)).toEqual(new Array(8).fill(CONTEXT_PROVIDER_CONFORMANCE_SCOPE_V1));
    expect(persisted.map(entry => entry.source.content.payload.kind).sort()).toEqual(['activity', 'decision', 'document', 'meeting', 'message', 'note', 'task', 'ticket']);
    expect(persisted.every(entry => entry.source.content.truth_status === 'source_observation')).toBe(true);

    const requestOnlyDatabase = database();
    const requestOnlyAuthority = authority(() => ({ ...retainedPolicy(), disposition: 'request_only' }));
    await expect(intakeContextBatchV1({
      identity: adapter.identity, sources: pulled.sources, authority: requestOnlyAuthority,
      store: new SqliteContextCaptureStoreV1(requestOnlyDatabase, requestOnlyAuthority, adapter.identity),
    })).resolves.toMatchObject(new Array(8).fill({ admission: 'request_only' }));
    expect(count(requestOnlyDatabase)).toBe(0);
  });

  it('treats poll capture time as observational while source semantic time and structured payload changes require a new revision', async () => {
    const value = database();
    const ticket = contextProviderConformancePayloadsV1()[0]!;
    if (ticket.source_type !== 'ticket') throw new Error('Temporal conformance fixture must be a ticket');
    const initial = mapContextProviderConformancePayloadV1(ticket);
    const currentAuthority = authority(() => retainedPolicy());
    const store = new SqliteContextCaptureStoreV1(value, currentAuthority, initial.item.adapter);
    await expect(intakeContextBatchV1({ identity: initial.item.adapter, sources: [initial], authority: currentAuthority, store })).resolves.toMatchObject([{ admission: 'admitted' }]);

    const pollReplay = remap(ticket, { captured_at: '2026-10-01T12:05:00.000Z' });
    await expect(intakeContextBatchV1({ identity: initial.item.adapter, sources: [pollReplay], authority: currentAuthority, store })).resolves.toMatchObject([{ admission: 'duplicate' }]);
    expect(new SqliteContextCaptureReaderV1(value).list({ organization_id: CONTEXT_PROVIDER_CONFORMANCE_SCOPE_V1.organization_id })[0]!.source.revision.captured_at)
      .toBe(ticket.captured_at);

    const semanticTimeChange = remap(ticket, { captured_at: '2026-10-01T12:10:00.000Z', source_updated_at: '2026-10-01T12:01:00.000Z' });
    await expect(intakeContextBatchV1({ identity: initial.item.adapter, sources: [semanticTimeChange], authority: currentAuthority, store })).rejects.toThrow('conflicts');
    const payloadChange = remap(ticket, {
      captured_at: '2026-10-01T12:10:00.000Z',
      payload: { ...ticket.payload, status: 'closed' },
    });
    await expect(intakeContextBatchV1({ identity: initial.item.adapter, sources: [payloadChange], authority: currentAuthority, store })).rejects.toThrow('conflicts');
    const nextRevision = remap(ticket, {
      revision_id: 'ticket:CON-17:r2', previous_revision_id: ticket.revision_id, captured_at: '2026-10-01T12:10:00.000Z',
      source_updated_at: '2026-10-01T12:01:00.000Z', payload: { ...ticket.payload, status: 'closed' },
    });
    await expect(intakeContextBatchV1({ identity: initial.item.adapter, sources: [nextRevision], authority: currentAuthority, store })).resolves.toMatchObject([{ admission: 'admitted' }]);
    expect(new SqliteContextCaptureReaderV1(value).list({ organization_id: CONTEXT_PROVIDER_CONFORMANCE_SCOPE_V1.organization_id }).map(entry => entry.source.revision.revision_id))
      .toEqual(['ticket:CON-17:r1', 'ticket:CON-17:r2']);
  });

  it('derives deterministic document revisions when a provider has no native revision token', async () => {
    const value = database();
    const initialInput = {
      external_id: 'document:no-native-token', captured_at: '2026-10-01T12:00:00.000Z',
      label: 'Fallback document', origin_ref: 'synthetic-provider://documents/no-native-token', text: 'The first document state.',
    };
    const initial = mapContextProviderDocumentFallbackV1(initialInput);
    const currentAuthority = authority(() => retainedPolicy());
    const store = new SqliteContextCaptureStoreV1(value, currentAuthority, initial.item.adapter);
    await intakeContextBatchV1({ identity: initial.item.adapter, sources: [initial], authority: currentAuthority, store });
    const replay = mapContextProviderDocumentFallbackV1({ ...initialInput, captured_at: '2026-10-01T12:05:00.000Z' });
    expect(replay.item.source_id).toBe(initial.item.source_id);
    expect(replay.revision.revision_id).toBe(initial.revision.revision_id);
    await expect(intakeContextBatchV1({ identity: initial.item.adapter, sources: [replay], authority: currentAuthority, store })).resolves.toMatchObject([{ admission: 'duplicate' }]);
    const changed = mapContextProviderDocumentFallbackV1({ ...initialInput, captured_at: '2026-10-01T12:10:00.000Z', text: 'The second document state.' });
    expect(changed.item.source_id).toBe(initial.item.source_id);
    expect(changed.revision.revision_id).not.toBe(initial.revision.revision_id);
    await expect(intakeContextBatchV1({ identity: initial.item.adapter, sources: [changed], authority: currentAuthority, store })).resolves.toMatchObject([{ admission: 'admitted' }]);
  });

  it('rejects malformed structured provider values under retained and request-only dispositions without writing custody', async () => {
    const value = database();
    const payloads = contextProviderConformancePayloadsV1();
    const ticket = mapContextProviderConformancePayloadV1(payloads[0]!);
    const activity = mapContextProviderConformancePayloadV1(payloads.find(payload => payload.source_type === 'activity')!);
    const meeting = mapContextProviderConformancePayloadV1(payloads.find(payload => payload.source_type === 'meeting')!);
    const malformed = [
      withContent(ticket, { ...ticket.content, payload: activity.content.payload }),
      withContent(ticket, { ...ticket.content, payload: { ...ticket.content.payload, permission: 'provider-admin' } }),
      withContent(ticket, { ...ticket.content, provenance: { ...ticket.content.provenance, source_updated_at: 'tomorrow' } }),
      withContent(activity, { ...activity.content, payload: { ...activity.content.payload, occurred_at: 'not-a-utc-time' } }),
      withContent(ticket, { ...ticket.content, provenance: { ...ticket.content.provenance, observed_at: 'legacy-poll-time' } }),
      withContent(meeting, { ...meeting.content, payload: { ...meeting.content.payload, ended_at: '2026-10-01T09:00:00.000Z' } }),
      withContent(meeting, { ...meeting.content, payload: { ...meeting.content.payload, participant_refs: ['provider-user:dup', 'provider-user:dup'] } }),
      withContent(meeting, { ...meeting.content, payload: { ...meeting.content.payload, participant_refs: [''] } }),
      withContent(ticket, { ...ticket.content, payload: { ...ticket.content.payload, labels: new Array(32).fill('x'.repeat(600)) } }),
    ];
    for (const disposition of ['retained', 'request_only'] as const) {
      const currentAuthority = authority(() => ({ ...retainedPolicy(), disposition }));
      const store = new SqliteContextCaptureStoreV1(value, currentAuthority, ticket.item.adapter);
      for (const source of malformed) {
        await expect(intakeContextBatchV1({ identity: ticket.item.adapter, sources: [source], authority: currentAuthority, store })).rejects.toThrow();
      }
    }
    expect(count(value)).toBe(0);
  });

  it('rechecks the retained policy and exact custody scope in the SQLite transaction, including duplicate replays', async () => {
    const cases: readonly { readonly name: string; readonly change: (base: ContextIntakePolicyV1) => ContextIntakePolicyV1 }[] = [
      { name: 'retention revocation', change: base => ({ ...base, disposition: 'request_only' }) },
      { name: 'representation removal', change: base => ({ ...base, permitted_representations: ['pointer'] }) },
      { name: 'custody drift', change: base => ({ ...base, scope: { ...base.scope, custody_ref: 'project:drift' } }) },
      { name: 'access policy drift', change: base => ({ ...base, scope: { ...base.scope, access_policy_ref: 'context-provider-conformance-drift' } }) },
    ];
    const ticket = contextProviderConformancePayloadsV1()[0]!;
    const source = mapContextProviderConformancePayloadV1(ticket);

    for (const scenario of cases) {
      const value = database();
      const initialAuthority = authority(() => retainedPolicy());
      await intakeContextBatchV1({
        identity: source.item.adapter, sources: [source], authority: initialAuthority,
        store: new SqliteContextCaptureStoreV1(value, initialAuthority, source.item.adapter),
      });
      let current = retainedPolicy();
      let preAdmissionChecks = 0;
      let selectedInTransaction = false;
      const queuedAuthority: ContextIntakeAuthorityV1 = {
        select: () => { if (value.inTransaction) selectedInTransaction = true; return current; },
        requireCurrent: () => {
          if (!value.inTransaction) {
            preAdmissionChecks += 1;
            if (preAdmissionChecks === 2) current = scenario.change(retainedPolicy());
          }
        },
      };
      await expect(intakeContextBatchV1({
        identity: source.item.adapter, sources: [source], authority: queuedAuthority,
        store: new SqliteContextCaptureStoreV1(value, queuedAuthority, source.item.adapter),
      }), scenario.name).rejects.toThrow();
      expect(count(value), scenario.name).toBe(1);
      expect(selectedInTransaction, scenario.name).toBe(true);
    }

    const duplicateDatabase = database();
    let requireCurrentInTransaction = false;
    const duplicateAuthority = authority(
      () => retainedPolicy(),
      () => { if (duplicateDatabase.inTransaction) requireCurrentInTransaction = true; },
    );
    const duplicateStore = new SqliteContextCaptureStoreV1(duplicateDatabase, duplicateAuthority, source.item.adapter);
    await intakeContextBatchV1({ identity: source.item.adapter, sources: [source], authority: duplicateAuthority, store: duplicateStore });
    await expect(intakeContextBatchV1({ identity: source.item.adapter, sources: [source], authority: duplicateAuthority, store: duplicateStore }))
      .resolves.toMatchObject([{ admission: 'duplicate' }]);
    expect(requireCurrentInTransaction).toBe(true);
  });

  it('fails closed for a newly queued capture, asynchronous Authority fences, and cancellation inside the custody transaction', async () => {
    const ticket = contextProviderConformancePayloadsV1()[0]!;
    const source = mapContextProviderConformancePayloadV1(ticket);

    const driftDatabase = database();
    let current = retainedPolicy();
    let preAdmissionChecks = 0;
    let selectionInTransaction = false;
    const driftAuthority: ContextIntakeAuthorityV1 = {
      select: () => { if (driftDatabase.inTransaction) selectionInTransaction = true; return current; },
      requireCurrent: () => {
        if (!driftDatabase.inTransaction && ++preAdmissionChecks === 2) current = { ...retainedPolicy(), disposition: 'request_only' };
      },
    };
    await expect(intakeContextBatchV1({
      identity: source.item.adapter, sources: [source], authority: driftAuthority,
      store: new SqliteContextCaptureStoreV1(driftDatabase, driftAuthority, source.item.adapter),
    })).rejects.toThrow('changed before admission');
    expect(selectionInTransaction).toBe(true);
    expect(count(driftDatabase)).toBe(0);

    const asyncDatabase = database();
    let asyncInTransaction = false;
    const asyncAuthority = authority(
      () => retainedPolicy(),
      (() => {
        if (asyncDatabase.inTransaction) {
          asyncInTransaction = true;
          return Promise.reject(new Error('late async authorization rejected'));
        }
        return undefined;
      }) as unknown as ContextIntakeAuthorityV1['requireCurrent'],
    );
    await expect(intakeContextBatchV1({
      identity: source.item.adapter, sources: [source], authority: asyncAuthority,
      store: new SqliteContextCaptureStoreV1(asyncDatabase, asyncAuthority, source.item.adapter),
    })).rejects.toThrow('synchronously');
    expect(asyncInTransaction).toBe(true);
    expect(count(asyncDatabase)).toBe(0);

    const cancelledDatabase = database();
    const controller = new AbortController();
    let cancelledInTransaction = false;
    const cancelledAuthority = authority(
      () => retainedPolicy(),
      () => {
        if (cancelledDatabase.inTransaction) {
          cancelledInTransaction = true;
          controller.abort(new Error('cancelled in custody fence'));
        }
      },
    );
    await expect(intakeContextBatchV1({
      identity: source.item.adapter, sources: [source], authority: cancelledAuthority,
      store: new SqliteContextCaptureStoreV1(cancelledDatabase, cancelledAuthority, source.item.adapter), context: { signal: controller.signal },
    })).rejects.toThrow('cancelled in custody fence');
    expect(cancelledInTransaction).toBe(true);
    expect(count(cancelledDatabase)).toBe(0);
  });

  it('binds direct persistence to the configured adapter and snapshots source and scope against Authority mutation', async () => {
    const value = database();
    const ticket = contextProviderConformancePayloadsV1()[0]!;
    const permissiveAuthority = authority(() => retainedPolicy());
    const configuredStore = new SqliteContextCaptureStoreV1(value, permissiveAuthority, CONTEXT_PROVIDER_CONFORMANCE_IDENTITY_V1);
    const foreignIdentity = { ...CONTEXT_PROVIDER_CONFORMANCE_IDENTITY_V1, adapter_id: 'foreign-provider-fixture' } as const;
    const foreign = mapContextProviderConformancePayloadV1(ticket, foreignIdentity);
    await expect(configuredStore.admitSourceRevision({ scope: CONTEXT_PROVIDER_CONFORMANCE_SCOPE_V1, source: foreign })).rejects.toThrow('configured adapter');
    expect(count(value)).toBe(0);

    const source = mapContextProviderConformancePayloadV1(ticket);
    const expectedScope = { ...CONTEXT_PROVIDER_CONFORMANCE_SCOPE_V1 };
    let selectMutationRejected = false;
    let fenceMutationRejected = false;
    const mutatingAuthority = authority(
      selected => {
        try { (selected as unknown as { content: { label: string } }).content.label = 'authority mutation'; } catch { selectMutationRejected = true; }
        return retainedPolicy();
      },
      (selected, selectedPolicy) => {
        if (value.inTransaction) {
          try {
            (selected as unknown as { revision: { revision_id: string } }).revision.revision_id = 'authority mutation';
            (selectedPolicy.scope as unknown as { custody_ref: string }).custody_ref = 'authority mutation';
          } catch { fenceMutationRejected = true; }
        }
      },
    );
    const mutatingStore = new SqliteContextCaptureStoreV1(value, mutatingAuthority, source.item.adapter);
    await expect(mutatingStore.admitSourceRevision({ scope: expectedScope, source })).resolves.toBe('admitted');
    expect(selectMutationRejected).toBe(true);
    expect(fenceMutationRejected).toBe(true);
    const retained = new SqliteContextCaptureReaderV1(value).list({ organization_id: CONTEXT_PROVIDER_CONFORMANCE_SCOPE_V1.organization_id });
    expect(retained).toHaveLength(1);
    expect(retained[0]!.source).toEqual(source);
    expect(retained[0]!.scope).toEqual(expectedScope);
  });

  it('does not permit provider payload fields to substitute for Authority retention policy', async () => {
    const value = database();
    const ticket = contextProviderConformancePayloadsV1()[0]!;
    const source = mapContextProviderConformancePayloadV1(ticket);
    const providerClaim = {
      ...source,
      content: { ...source.content, payload: { ...ticket.payload, retention: 'forever' } },
    } as unknown as ContextCaptureEnvelopeV1;
    const content = providerClaim.content;
    const forged = { ...providerClaim, revision: { ...providerClaim.revision, content_sha256: sourceContentSha256V1(content) } };
    const currentAuthority = authority(() => ({ ...retainedPolicy(), disposition: 'request_only' }));
    await expect(intakeContextBatchV1({
      identity: source.item.adapter, sources: [forged], authority: currentAuthority,
      store: new SqliteContextCaptureStoreV1(value, currentAuthority, source.item.adapter),
    })).rejects.toThrow();
    expect(count(value)).toBe(0);
  });
});
