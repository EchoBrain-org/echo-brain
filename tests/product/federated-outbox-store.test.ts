import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  canonicalJson,
  parseCanonicalJson,
  sha256Digest,
} from '../../src/product/federation/foundation/canonical-json.js';
import type { FederatedEventV1 } from '../../src/product/federation/contracts.js';
import {
  FederatedOutboxStore,
  type AppendFederatedApprovalGroupRequest,
  type FederatedOutboxEventDraft,
} from '../../src/product/federation/outbox-store.js';
import type { InstallationSigner } from '../../src/product/federation/foundation/installation-signer.js';
import { signWithInstallationKey } from '../../src/product/federation/foundation/installation-signer.js';
import {
  CountingInstallationSigner as TestInstallationSigner,
  federatedApprovalGroupDrafts,
  federationFixtureId as fixtureId,
} from './fixtures/federated-records.js';

const NOW = '2026-07-19T22:00:00.000Z';
const LATER = '2026-07-19T22:01:00.000Z';
const DIGEST_A = `sha256:${'a'.repeat(64)}` as const;
const DIGEST_B = `sha256:${'b'.repeat(64)}` as const;
const DIGEST_C = `sha256:${'c'.repeat(64)}` as const;
const SIGNAL_ONE = `decision:sha256:${'1'.repeat(64)}`;
const SIGNAL_TWO = `action:sha256:${'2'.repeat(64)}`;
const INSTALLATION_ID = 'ins_00000000-0000-4000-8000-000000000001';
const APPROVAL_ID = 'approval-fixture-one';
const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'echo-federated-outbox-'));
  temporary.push(directory);
  return join(directory, 'echo-brain.sqlite');
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function draftGroup(
  signer: TestInstallationSigner,
  options: {
    approvalId?: string;
    idOffset?: number;
    signals?: readonly (typeof SIGNAL_ONE | typeof SIGNAL_TWO)[];
  } = {},
): FederatedOutboxEventDraft[] {
  return federatedApprovalGroupDrafts({
    signer,
    occurredAt: NOW,
    approvalId: options.approvalId ?? APPROVAL_ID,
    decisionId: SIGNAL_ONE,
    actionId: SIGNAL_TWO,
    digests: { a: DIGEST_A, b: DIGEST_B, c: DIGEST_C },
    ...(options.idOffset === undefined ? {} : { idOffset: options.idOffset }),
    ...(options.signals === undefined ? {} : { signals: options.signals }),
  });
}

function appendRequest(
  signer: TestInstallationSigner,
  events: readonly FederatedOutboxEventDraft[],
  createdAt = NOW,
) {
  return {
    installation_id: INSTALLATION_ID,
    key_id: signer.descriptor.key_id,
    created_at: createdAt,
    signer,
    events,
  } as const;
}

function singleDecisionGroup(
  signer: TestInstallationSigner,
): FederatedOutboxEventDraft[] {
  const first = draftGroup(signer)[0]!;
  return [
    {
      ...first,
      envelope: {
        ...first.envelope,
        record: {
          ...first.envelope.record,
          approval_group: {
            ...first.envelope.record.approval_group,
            signal_manifest: [
              first.envelope.record.approval_group.signal_manifest[0]!,
            ],
          },
        },
      },
    },
  ];
}

describe('federated signed outbox store', () => {
  it('locks the shared approval-group fixture bytes', () => {
    const signer = new TestInstallationSigner();
    const normalized = draftGroup(signer).map(
      ({ local_subject_key, envelope }) => ({
        local_subject_key,
        envelope: {
          ...envelope,
          producer: { ...envelope.producer, key_id: DIGEST_A },
          publication: {
            ...envelope.publication,
            signer_key_id: DIGEST_A,
          },
        },
      }),
    );

    expect(sha256Digest(canonicalJson(normalized))).toBe(
      'sha256:3adb9cfb999921eb2d583746900395582aafd12c12949f1a04d673bb3f84da7e',
    );
  });

  it('atomically signs a complete approval group into one contiguous chain', async () => {
    const path = databasePath();
    const signer = new TestInstallationSigner();
    const store = new FederatedOutboxStore(path);
    const drafts = draftGroup(signer);
    const internals = store as unknown as {
      database: Database.Database;
    };

    expect(internals.database.pragma('synchronous', { simple: true })).toBe(2);

    const written = await store.appendApprovalGroup(
      appendRequest(signer, drafts),
    );

    expect(written.map((event) => event.sequence)).toEqual([1, 2]);
    expect(written[0]!.previous_event_hash).toBeNull();
    expect(written[1]!.previous_event_hash).toBe(written[0]!.event_hash);
    expect(written.every((event) => event.envelope_json.startsWith('{'))).toBe(
      true,
    );
    expect(
      written.every((event) =>
        event.envelope_bytes.equals(Buffer.from(event.envelope_json, 'utf8')),
      ),
    ).toBe(true);
    expect(written.map((event) => event.envelope.sequence)).toEqual([1, 2]);
    expect(await store.readSequenceRange(INSTALLATION_ID, 1, 2)).toEqual(
      written,
    );
    expect(
      await store.readByLocalSubject(
        INSTALLATION_ID,
        drafts[1]!.local_subject_key,
      ),
    ).toEqual(written[1]);

    const verified = await store.verifyInstallationChain(INSTALLATION_ID, {
      key_id: signer.descriptor.key_id,
      public_key_spki_der: Buffer.from(
        signer.descriptor.public_key_spki_der_base64,
        'base64',
      ),
    });
    expect(verified.events.map((event) => event.envelope_json)).toEqual(
      written.map((event) => event.envelope_json),
    );
    expect(verified.head).toMatchObject({
      last_sequence: 2,
      last_event_hash: written[1]!.event_hash,
    });
    await expect(
      store.verifyInstallationChain(INSTALLATION_ID, {
        key_id: DIGEST_A,
        public_key_spki_der: Buffer.from(
          signer.descriptor.public_key_spki_der_base64,
          'base64',
        ),
      }),
    ).rejects.toThrow('fingerprint does not match');

    const database = new Database(path, { readonly: true });
    const raw = database
      .prepare(
        'SELECT envelope_json FROM federated_outbox_events ORDER BY sequence',
      )
      .all() as { envelope_json: string }[];
    expect(raw.map((row) => row.envelope_json)).toEqual(
      written.map((event) => event.envelope_json),
    );
    database.close();
    await store.close();
  });

  it('appends and verifies historical per-event signing-key epochs', async () => {
    const signerA = new TestInstallationSigner();
    const signerB = new TestInstallationSigner();
    const store = new FederatedOutboxStore(databasePath());
    const keyFor = (signer: TestInstallationSigner) => ({
      key_id: signer.descriptor.key_id,
      public_key_spki_der: Buffer.from(
        signer.descriptor.public_key_spki_der_base64,
        'base64',
      ),
    });
    const resolveHistoricalKey = (
      event: Awaited<
        ReturnType<FederatedOutboxStore['readInstallationEvents']>
      >[number],
    ) => {
      if (event.envelope.producer.key_id === signerA.descriptor.key_id) {
        return keyFor(signerA);
      }
      if (event.envelope.producer.key_id === signerB.descriptor.key_id) {
        return keyFor(signerB);
      }
      throw new Error('unknown historical test key');
    };

    await store.appendApprovalGroup(
      appendRequest(signerA, draftGroup(signerA)),
    );
    await store.appendApprovalGroup({
      ...appendRequest(
        signerB,
        draftGroup(signerB, {
          approvalId: 'approval-fixture-two',
          idOffset: 2,
        }),
        LATER,
      ),
      historical_verification_key_resolver: resolveHistoricalKey,
    });

    const verified = await store.verifyInstallationChain(
      INSTALLATION_ID,
      resolveHistoricalKey,
    );
    expect(
      verified.events.map((event) => event.envelope.producer.key_id),
    ).toEqual([
      signerA.descriptor.key_id,
      signerA.descriptor.key_id,
      signerB.descriptor.key_id,
      signerB.descriptor.key_id,
    ]);
    expect(await store.listInstallationIds()).toEqual([INSTALLATION_ID]);
    await store.close();
  });

  it('returns the exact original whole group on local-subject idempotent retry', async () => {
    const signer = new TestInstallationSigner();
    const store = new FederatedOutboxStore(databasePath());
    const first = await store.appendApprovalGroup(
      appendRequest(signer, draftGroup(signer)),
    );
    const signCalls = signer.signCalls;

    const retry = await store.appendApprovalGroup(
      appendRequest(signer, draftGroup(signer), LATER),
    );

    expect(retry.map((event) => event.envelope_json)).toEqual(
      first.map((event) => event.envelope_json),
    );
    expect(signer.signCalls).toBe(signCalls);
    expect((await store.readChainHead(INSTALLATION_ID))?.last_sequence).toBe(2);
    await store.close();
  });

  it('returns a historically verified retry without requiring the old private key', async () => {
    const signer = new TestInstallationSigner();
    const store = new FederatedOutboxStore(databasePath());
    const drafts = draftGroup(signer);
    const first = await store.appendApprovalGroup(
      appendRequest(signer, drafts),
    );
    let inspectCalls = 0;
    const unavailableSigner: InstallationSigner = {
      generate: async () => {
        throw new Error('old private key is unavailable');
      },
      inspect: async () => {
        inspectCalls += 1;
        return null;
      },
      sign: async () => {
        throw new Error('old private key is unavailable');
      },
    };
    const publicKey = Buffer.from(
      signer.descriptor.public_key_spki_der_base64,
      'base64',
    );

    const retry = await store.appendApprovalGroup({
      ...appendRequest(signer, draftGroup(signer), LATER),
      signer: unavailableSigner,
      historical_verification_key_resolver: (event) => {
        if (event.envelope.producer.key_id !== signer.descriptor.key_id) {
          throw new Error('unexpected historical key');
        }
        return {
          key_id: signer.descriptor.key_id,
          public_key_spki_der: publicKey,
        };
      },
    });

    expect(retry.map((event) => event.envelope_json)).toEqual(
      first.map((event) => event.envelope_json),
    );
    expect(inspectCalls).toBe(0);
    await store.close();
  });

  it('fails closed for a missing historical retry key and skips the rotated live signer for an exact retry', async () => {
    const signerA = new TestInstallationSigner();
    const signerB = new TestInstallationSigner();
    const store = new FederatedOutboxStore(databasePath());
    const first = await store.appendApprovalGroup(
      appendRequest(signerA, draftGroup(signerA)),
    );
    let rotatedInspectCalls = 0;
    const rotatedSigner: InstallationSigner = {
      generate: (installationId) => signerB.generate(installationId),
      inspect: async (installationId) => {
        rotatedInspectCalls += 1;
        return signerB.inspect(installationId);
      },
      sign: (installationId, message, expectedKeyId) =>
        signerB.sign(installationId, message, expectedKeyId),
    };
    const retryRequest = {
      ...appendRequest(signerA, draftGroup(signerA), LATER),
      signer: rotatedSigner,
    };

    await expect(
      store.appendApprovalGroup({
        ...retryRequest,
        historical_verification_key_resolver: () => {
          throw new Error('missing historical verification key');
        },
      }),
    ).rejects.toThrow('missing historical verification key');
    expect(rotatedInspectCalls).toBe(0);

    const retry = await store.appendApprovalGroup({
      ...retryRequest,
      historical_verification_key_resolver: (event) => {
        if (event.envelope.producer.key_id !== signerA.descriptor.key_id) {
          throw new Error('missing historical verification key');
        }
        return {
          key_id: signerA.descriptor.key_id,
          public_key_spki_der: Buffer.from(
            signerA.descriptor.public_key_spki_der_base64,
            'base64',
          ),
        };
      },
    });
    expect(retry.map((event) => event.envelope_json)).toEqual(
      first.map((event) => event.envelope_json),
    );
    expect(rotatedInspectCalls).toBe(0);
    expect(signerB.signCalls).toBe(0);
    await store.close();
  });

  it('returns the exact committed group after closing and reopening the database', async () => {
    const path = databasePath();
    const signer = new TestInstallationSigner();
    const firstStore = new FederatedOutboxStore(path);
    const first = await firstStore.appendApprovalGroup(
      appendRequest(signer, draftGroup(signer)),
    );
    const signCalls = signer.signCalls;
    await firstStore.close();

    const reopened = new FederatedOutboxStore(path);
    const retry = await reopened.appendApprovalGroup(
      appendRequest(signer, draftGroup(signer), LATER),
    );

    expect(retry.map((event) => event.envelope_json)).toEqual(
      first.map((event) => event.envelope_json),
    );
    expect(signer.signCalls).toBe(signCalls);
    expect((await reopened.readChainHead(INSTALLATION_ID))?.last_sequence).toBe(
      2,
    );
    await reopened.close();
  });

  it('uses a canonical deep snapshot when callers mutate drafts during async inspection', async () => {
    const signer = new TestInstallationSigner();
    const store = new FederatedOutboxStore(databasePath());
    const drafts = draftGroup(signer);
    const originalReason = drafts[0]!.envelope.approval.reason;
    const inspectionStarted = deferred();
    const releaseInspection = deferred();
    const delayedSigner: InstallationSigner = {
      generate: (installationId) => signer.generate(installationId),
      inspect: async (installationId) => {
        inspectionStarted.resolve();
        await releaseInspection.promise;
        return signer.inspect(installationId);
      },
      sign: (installationId, message, expectedKeyId) =>
        signer.sign(installationId, message, expectedKeyId),
    };
    const request: AppendFederatedApprovalGroupRequest = {
      ...appendRequest(signer, drafts),
      signer: delayedSigner,
    };
    const pending = store.appendApprovalGroup(request);

    await inspectionStarted.promise;
    drafts[0]!.envelope.approval.reason = 'caller mutated after validation';
    drafts.pop();
    request.installation_id = fixtureId('ins', 2);
    request.key_id = DIGEST_A;
    request.created_at = LATER;
    releaseInspection.resolve();

    const written = await pending;
    expect(written).toHaveLength(2);
    expect(written[0]!.envelope.approval.reason).toBe(originalReason);
    expect(written[0]!.installation_id).toBe(INSTALLATION_ID);
    expect(written[0]!.created_at).toBe(NOW);
    expect(await store.readInstallationEvents(INSTALLATION_ID)).toHaveLength(2);
    await store.close();
  });

  it('rejects a key descriptor bound to another installation everywhere it can sign', async () => {
    const signer = new TestInstallationSigner();
    const otherInstallationId = fixtureId('ins', 2);
    const mismatchedSigner: InstallationSigner = {
      generate: async () => ({
        ...signer.descriptor,
        installation_id: otherInstallationId,
      }),
      inspect: async () => ({
        ...signer.descriptor,
        installation_id: otherInstallationId,
      }),
      sign: (installationId, message, expectedKeyId) =>
        signer.sign(installationId, message, expectedKeyId),
    };
    const store = new FederatedOutboxStore(databasePath());

    await expect(
      store.appendApprovalGroup({
        ...appendRequest(signer, draftGroup(signer)),
        signer: mismatchedSigner,
      }),
    ).rejects.toThrow('descriptor belongs to a different installation');
    await expect(
      signWithInstallationKey(
        mismatchedSigner,
        INSTALLATION_ID,
        signer.descriptor.key_id,
        Buffer.from('message', 'utf8'),
      ),
    ).rejects.toThrow('descriptor belongs to a different installation');
    expect(signer.signCalls).toBe(0);
    expect(await store.readInstallationEvents(INSTALLATION_ID)).toEqual([]);
    await store.close();
  });

  it('rejects a signer that mutates the message buffer before signing', async () => {
    const signer = new TestInstallationSigner();
    const mutatingSigner: InstallationSigner = {
      generate: (installationId) => signer.generate(installationId),
      inspect: (installationId) => signer.inspect(installationId),
      sign: (installationId, message, expectedKeyId) => {
        message.fill(0);
        return signer.sign(installationId, message, expectedKeyId);
      },
    };
    const store = new FederatedOutboxStore(databasePath());

    await expect(
      store.appendApprovalGroup({
        ...appendRequest(signer, draftGroup(signer)),
        signer: mutatingSigner,
      }),
    ).rejects.toThrow('installation signer returned an invalid signature');
    expect(await store.readInstallationEvents(INSTALLATION_ID)).toEqual([]);
    expect(await store.readChainHead(INSTALLATION_ID)).toBeNull();
    await store.close();
  });

  it('rejects a projection time earlier than any event occurrence time', async () => {
    const signer = new TestInstallationSigner();
    const store = new FederatedOutboxStore(databasePath());

    await expect(
      store.appendApprovalGroup(
        appendRequest(signer, draftGroup(signer), '2026-07-19T21:59:59.999Z'),
      ),
    ).rejects.toThrow('creation time cannot precede event occurrence time');
    expect(signer.signCalls).toBe(0);
    expect(await store.readInstallationEvents(INSTALLATION_ID)).toEqual([]);
    await store.close();
  });

  it('rejects changed immutable content under the same local-subject keys', async () => {
    const signer = new TestInstallationSigner();
    const store = new FederatedOutboxStore(databasePath());
    await store.appendApprovalGroup(appendRequest(signer, draftGroup(signer)));
    const changed = draftGroup(signer).map((item) => ({
      ...item,
      envelope: {
        ...item.envelope,
        publication: {
          ...item.envelope.publication,
          sensitivity: 'confidential' as const,
        },
      },
    }));

    await expect(
      store.appendApprovalGroup(appendRequest(signer, changed, LATER)),
    ).rejects.toThrow('content differs from the retry');
    await expect(
      store.appendApprovalGroup(
        appendRequest(signer, draftGroup(signer, { idOffset: 100 }), LATER),
      ),
    ).rejects.toThrow('content differs from the retry');
    expect(await store.readInstallationEvents(INSTALLATION_ID)).toHaveLength(2);
    await store.close();
  });

  it('rejects a retry unless the full expected local-subject set is present', async () => {
    const signer = new TestInstallationSigner();
    const store = new FederatedOutboxStore(databasePath());
    const original = draftGroup(signer);
    await store.appendApprovalGroup(appendRequest(signer, original));
    const retry = draftGroup(signer);
    const narrowed = {
      ...retry[0]!,
      envelope: {
        ...retry[0]!.envelope,
        record: {
          ...retry[0]!.envelope.record,
          approval_group: {
            ...retry[0]!.envelope.record.approval_group,
            signal_manifest: [
              retry[0]!.envelope.record.approval_group.signal_manifest[0]!,
            ],
          },
        },
      },
    };

    await expect(
      store.appendApprovalGroup(appendRequest(signer, [narrowed])),
    ).rejects.toThrow('persisted federated approval group differs');
    expect(await store.readInstallationEvents(INSTALLATION_ID)).toHaveLength(2);
    await store.close();
  });

  it('rolls back every sibling and the chain head when signing fails mid-group', async () => {
    const path = databasePath();
    const signer = new TestInstallationSigner();
    signer.failOnSignCall = 2;
    const store = new FederatedOutboxStore(path);

    await expect(
      store.appendApprovalGroup(appendRequest(signer, draftGroup(signer))),
    ).rejects.toThrow('injected signing failure');

    expect(await store.readInstallationEvents(INSTALLATION_ID)).toEqual([]);
    expect(await store.readChainHead(INSTALLATION_ID)).toBeNull();
    const database = new Database(path, { readonly: true });
    expect(
      (
        database
          .prepare('SELECT COUNT(*) AS count FROM federated_outbox_events')
          .get() as { count: number }
      ).count,
    ).toBe(0);
    expect(
      (
        database
          .prepare('SELECT COUNT(*) AS count FROM federated_chain_heads')
          .get() as { count: number }
      ).count,
    ).toBe(0);
    database.close();
    await store.close();
  });

  it('continues the same installation chain across approval groups', async () => {
    const signer = new TestInstallationSigner();
    const store = new FederatedOutboxStore(databasePath());
    const first = await store.appendApprovalGroup(
      appendRequest(signer, draftGroup(signer)),
    );
    await expect(
      store.appendApprovalGroup(
        appendRequest(
          signer,
          draftGroup(signer, { approvalId: 'approval-fixture-two' }),
          LATER,
        ),
      ),
    ).rejects.toThrow('record IDs must be unique');
    const secondDrafts = draftGroup(signer, {
      approvalId: 'approval-fixture-two',
      idOffset: 10,
    });
    const second = await store.appendApprovalGroup(
      appendRequest(signer, secondDrafts, LATER),
    );

    expect(second.map((event) => event.sequence)).toEqual([3, 4]);
    expect(second[0]!.previous_event_hash).toBe(first[1]!.event_hash);
    expect((await store.readChainHead(INSTALLATION_ID))?.last_sequence).toBe(4);
    await store.close();
  });

  it('fails closed when exact stored bytes or the persisted chain are altered', async () => {
    const path = databasePath();
    const signer = new TestInstallationSigner();
    const store = new FederatedOutboxStore(path);
    await store.appendApprovalGroup(appendRequest(signer, draftGroup(signer)));
    await store.close();

    const database = new Database(path);
    database
      .prepare(
        `UPDATE federated_outbox_events
         SET envelope_json = json_set(envelope_json, '$.approval.reason', 'tampered')
         WHERE sequence = 1`,
      )
      .run();
    database.close();

    const reopened = new FederatedOutboxStore(path);
    await expect(
      reopened.readInstallationEvents(INSTALLATION_ID),
    ).rejects.toThrow(/canonical|digest|hash/);
    await reopened.close();
  });

  it('reads rows and their chain head from one snapshot across another connection commit', async () => {
    const path = databasePath();
    const signer = new TestInstallationSigner();
    const store = new FederatedOutboxStore(path);
    await store.appendApprovalGroup(appendRequest(signer, draftGroup(signer)));
    const internals = store as unknown as {
      rowsForInstallation(installationId: string): unknown[];
    };
    const originalRowsForInstallation =
      internals.rowsForInstallation.bind(store);
    let writerCommitted = false;
    internals.rowsForInstallation = (installationId: string) => {
      const rows = originalRowsForInstallation(installationId);
      const writer = new Database(path);
      writer.pragma('busy_timeout = 1000');
      writer
        .prepare(
          `UPDATE federated_chain_heads
           SET last_sequence = 99
           WHERE installation_id = ?`,
        )
        .run(INSTALLATION_ID);
      writer.close();
      writerCommitted = true;
      return rows;
    };

    const consistentRead = await store.readInstallationEvents(INSTALLATION_ID);
    expect(consistentRead).toHaveLength(2);
    expect(writerCommitted).toBe(true);

    internals.rowsForInstallation = originalRowsForInstallation;
    await expect(store.readInstallationEvents(INSTALLATION_ID)).rejects.toThrow(
      'chain head does not match',
    );
    await store.close();
  });

  it('cryptographically rejects a rehashed envelope with an invalid signature', async () => {
    const path = databasePath();
    const signer = new TestInstallationSigner();
    const store = new FederatedOutboxStore(path);
    await store.appendApprovalGroup(
      appendRequest(signer, singleDecisionGroup(signer)),
    );
    await store.close();

    const database = new Database(path);
    const row = database
      .prepare('SELECT envelope_json FROM federated_outbox_events')
      .get() as { envelope_json: string };
    const envelope = parseCanonicalJson(
      row.envelope_json,
    ) as unknown as FederatedEventV1;
    envelope.integrity.signature_base64 = (
      await signer.sign(
        INSTALLATION_ID,
        Buffer.from('different signed payload', 'utf8'),
        signer.descriptor.key_id,
      )
    ).toString('base64');
    const envelopeJson = canonicalJson(envelope);
    const eventHash = sha256Digest(envelopeJson);
    database.exec('BEGIN IMMEDIATE');
    database
      .prepare(
        `UPDATE federated_outbox_events
         SET envelope_json = ?, event_hash = ?`,
      )
      .run(envelopeJson, eventHash);
    database
      .prepare(
        `UPDATE federated_chain_heads
         SET last_event_hash = ?`,
      )
      .run(eventHash);
    database.exec('COMMIT');
    database.close();

    const reopened = new FederatedOutboxStore(path);
    expect(await reopened.readInstallationEvents(INSTALLATION_ID)).toHaveLength(
      1,
    );
    await expect(
      reopened.verifyInstallationChain(INSTALLATION_ID, {
        key_id: signer.descriptor.key_id,
        public_key_spki_der: Buffer.from(
          signer.descriptor.public_key_spki_der_base64,
          'base64',
        ),
      }),
    ).rejects.toThrow('signature is invalid');
    await reopened.close();
  });

  it('rejects incomplete and non-canonically ordered approval groups before writing', async () => {
    const signer = new TestInstallationSigner();
    const store = new FederatedOutboxStore(databasePath());
    const drafts = draftGroup(signer);

    await expect(
      store.appendApprovalGroup(appendRequest(signer, [drafts[0]!])),
    ).rejects.toThrow('complete signal manifest');

    const duplicateManifest = drafts.map((item) => ({
      ...item,
      envelope: {
        ...item.envelope,
        record: {
          ...item.envelope.record,
          approval_group: {
            ...item.envelope.record.approval_group,
            signal_manifest: [
              ...item.envelope.record.approval_group.signal_manifest,
              item.envelope.record.approval_group.signal_manifest[0]!,
            ],
          },
        },
      },
    }));
    await expect(
      store.appendApprovalGroup(appendRequest(signer, duplicateManifest)),
    ).rejects.toThrow('signal manifest contains duplicates');

    await expect(
      store.appendApprovalGroup(
        appendRequest(signer, [drafts[1]!, drafts[0]!]),
      ),
    ).rejects.toThrow('canonical kind and position order');

    const badDigest = drafts.map((item) => ({
      ...item,
      envelope: {
        ...item.envelope,
        record: {
          ...item.envelope.record,
          approval_group: {
            ...item.envelope.record.approval_group,
            signal_manifest:
              item.envelope.record.approval_group.signal_manifest.map(
                (manifestItem, index) =>
                  index === 0
                    ? { ...manifestItem, sha256: DIGEST_A }
                    : manifestItem,
              ),
          },
        },
      },
    }));
    await expect(
      store.appendApprovalGroup(appendRequest(signer, badDigest)),
    ).rejects.toThrow('signal digest does not match');

    const badPosition = drafts.map((item) => ({
      ...item,
      envelope: {
        ...item.envelope,
        record: {
          ...item.envelope.record,
          approval_group: {
            ...item.envelope.record.approval_group,
            signal_manifest:
              item.envelope.record.approval_group.signal_manifest.map(
                (manifestItem, index) =>
                  index === 0
                    ? { ...manifestItem, position_within_kind: 1 }
                    : manifestItem,
              ),
          },
        },
      },
    }));
    await expect(
      store.appendApprovalGroup(appendRequest(signer, badPosition)),
    ).rejects.toThrow('signal manifest is not canonically positioned');

    const mismatchedSibling = {
      ...drafts[1]!,
      envelope: {
        ...drafts[1]!.envelope,
        publication: {
          ...drafts[1]!.envelope.publication,
          sensitivity: 'confidential' as const,
        },
      },
    };
    await expect(
      store.appendApprovalGroup(
        appendRequest(signer, [drafts[0]!, mismatchedSibling]),
      ),
    ).rejects.toThrow('same shared facts');
    expect(await store.readInstallationEvents(INSTALLATION_ID)).toEqual([]);
    await store.close();
  });
});
