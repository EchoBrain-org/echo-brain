import {
  generateKeyPairSync,
  sign as signMessage,
  type KeyObject,
} from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { OrganizationAuthoritySigner } from '../../src/product/federation/authority/authority-signer.js';
import { createOrganizationEnrollmentProof } from '../../src/product/federation/authority/enrollment-proof.js';
import { OrganizationAuthorityStore } from '../../src/product/federation/authority/organization-authority-store.js';
import type {
  LocalIdentityManifestV1,
  OrganizationAuthorityDescriptorV1,
  OrganizationEnrollmentChallengeV1,
  OrganizationEnrollmentReceiptV1,
  OrganizationIngestBatchV1,
  PublicationPolicyV1,
  Sha256Digest,
} from '../../src/product/federation/contracts.js';
import {
  canonicalJson,
  canonicalSha256,
  parseCanonicalJson,
} from '../../src/product/federation/foundation/canonical-json.js';
import type {
  InstallationKeyDescriptor,
  InstallationSigner,
} from '../../src/product/federation/foundation/installation-signer.js';
import {
  createSignedDocument,
  createSignedDocumentWithKey,
  signedPayload,
} from '../../src/product/federation/foundation/signed-document.js';
import {
  normalizeP256LowS,
  p256KeyId,
} from '../../src/product/federation/foundation/signature-profile.js';
import { OrganizationSyncStore } from '../../src/product/federation/organization/organization-sync-store.js';
import {
  ORGANIZATION_UPLOAD_MAX_EVENTS,
  OrganizationOutboxUploader,
  type OrganizationIngestClient,
} from '../../src/product/federation/organization/outbox-uploader.js';
import {
  FederatedOutboxStore,
  type StoredFederatedOutboxEvent,
} from '../../src/product/federation/outbox-store.js';
import {
  CountingInstallationSigner,
  federatedApprovalGroupDrafts,
  federationFixtureId,
  signFederatedApprovalGroupDrafts,
} from './fixtures/federated-records.js';
import { testManifest, testPolicy } from './fixtures/founder-identity.js';

const NOW = '2026-07-20T18:00:00.000Z';
const EXPIRES = '2026-07-20T18:10:00.000Z';
const DIGEST_A = `sha256:${'a'.repeat(64)}` as const;
const DIGEST_B = `sha256:${'b'.repeat(64)}` as const;
const DIGEST_C = `sha256:${'c'.repeat(64)}` as const;
const DECISION_ID = `decision:sha256:${'1'.repeat(64)}`;
const ACTION_ID = `action:sha256:${'2'.repeat(64)}`;
const POLICY_ID = federationFixtureId('pol', 101);
const IDS = {
  organization: federationFixtureId('org', 101),
  principal: federationFixtureId('prn', 101),
  membership: federationFixtureId('mem', 101),
  device: federationFixtureId('dev', 101),
  installation: federationFixtureId('ins', 101),
  manifest: federationFixtureId('idm', 101),
  claim: federationFixtureId('clm', 101),
};

const temporary: string[] = [];
const openResources: { close(): Promise<void> }[] = [];

afterEach(async () => {
  for (const resource of openResources.splice(0).reverse()) {
    await resource.close();
  }
  for (const path of temporary.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function track<T extends { close(): Promise<void> }>(resource: T): T {
  openResources.push(resource);
  return resource;
}

function databasePath(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), `echo-${label}-`));
  temporary.push(directory);
  return join(directory, `${label}.sqlite`);
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

class TestAuthoritySigner implements OrganizationAuthoritySigner {
  private readonly privateKey: KeyObject;
  readonly descriptor: OrganizationAuthorityDescriptorV1;

  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
    });
    const publicKeyDer = publicKey.export({ type: 'spki', format: 'der' });
    this.privateKey = privateKey;
    this.descriptor = {
      schema_version: 1,
      kind: 'echo-organization-authority',
      authority_id: federationFixtureId('oau', 101),
      organization_id: IDS.organization,
      signing_key: {
        key_id: p256KeyId(publicKeyDer),
        algorithm: 'ecdsa-p256-sha256-der-low-s',
        public_key_spki_der_base64: publicKeyDer.toString('base64'),
      },
    };
  }

  async inspect(): Promise<OrganizationAuthorityDescriptorV1> {
    return structuredClone(this.descriptor);
  }

  async sign(message: Buffer, expectedKeyId?: Sha256Digest): Promise<Buffer> {
    if (expectedKeyId !== this.descriptor.signing_key.key_id) {
      throw new Error('test authority signing identity mismatch');
    }
    return this.signUnchecked(message);
  }

  signUnchecked(message: Buffer): Buffer {
    return normalizeP256LowS(
      signMessage('sha256', message, {
        key: this.privateKey,
        dsaEncoding: 'der',
      }),
    );
  }
}

interface SyncHarness {
  authoritySigner: TestAuthoritySigner;
  installationSigner: CountingInstallationSigner;
  authority: OrganizationAuthorityStore;
  sync: OrganizationSyncStore;
  outbox: FederatedOutboxStore;
  manifest: LocalIdentityManifestV1;
  publicationPolicy: PublicationPolicyV1;
  enrollmentReceipt: OrganizationEnrollmentReceiptV1;
}

class LoopbackAuthorityClient implements OrganizationIngestClient {
  readonly batches: OrganizationIngestBatchV1[] = [];

  constructor(private readonly authority: OrganizationAuthorityStore) {}

  async upload(
    batch: OrganizationIngestBatchV1,
    options: { signal: AbortSignal },
  ): Promise<readonly string[]> {
    options.signal.throwIfAborted();
    this.batches.push(structuredClone(batch));
    const receipts = await this.authority.ingestBatch(batch);
    options.signal.throwIfAborted();
    return receipts.map((receipt) => canonicalJson(receipt));
  }
}

function manifestKey(
  descriptor: InstallationKeyDescriptor,
): LocalIdentityManifestV1['installation']['signing_key'] {
  return {
    key_id: descriptor.key_id,
    algorithm: descriptor.algorithm,
    public_key_spki_der_base64: descriptor.public_key_spki_der_base64,
    protection: descriptor.protection,
    assurance: descriptor.assurance,
  };
}

async function createManifest(
  signer: InstallationSigner,
  descriptor: InstallationKeyDescriptor,
): Promise<LocalIdentityManifestV1> {
  return createSignedDocument(
    testManifest({ ids: IDS, at: NOW, key: manifestKey(descriptor) }),
    signer,
    IDS.installation,
    descriptor.key_id,
  );
}

async function issueChallenge(
  authority: OrganizationAuthorityStore,
  manifest: LocalIdentityManifestV1,
  publicationPolicy: PublicationPolicyV1,
): Promise<OrganizationEnrollmentChallengeV1> {
  const grant = await authority.issueEnrollmentGrant(IDS.membership, {
    expires_at: EXPIRES,
  });
  return authority.issueEnrollmentChallenge({
    manifest,
    publication_policy: publicationPolicy,
    enrollment_grant: grant.enrollment_grant,
    expires_at: EXPIRES,
  });
}

async function createHarness(
  options: {
    syncPath?: string;
    authoritySigner?: TestAuthoritySigner;
  } = {},
): Promise<SyncHarness> {
  const authoritySigner = options.authoritySigner ?? new TestAuthoritySigner();
  const installationSigner = new CountingInstallationSigner(IDS.installation);
  const manifest = await createManifest(
    installationSigner,
    installationSigner.descriptor,
  );
  const publicationPolicy = await createSignedDocument(
    testPolicy({
      policyId: POLICY_ID,
      organizationId: IDS.organization,
      manifestId: IDS.manifest,
      installationId: IDS.installation,
      keyId: installationSigner.descriptor.key_id,
      effectiveAt: NOW,
    }),
    installationSigner,
    IDS.installation,
    installationSigner.descriptor.key_id,
  );
  const authority = track(
    new OrganizationAuthorityStore({
      databasePath: ':memory:',
      signer: authoritySigner,
      now: () => NOW,
    }),
  );
  await authority.provisionOrganization({
    organization_id: IDS.organization,
    display_name: manifest.organization.display_name,
    principal_id: IDS.principal,
    principal_display_name: manifest.principal.display_name,
    membership_id: IDS.membership,
    provisioned_at: NOW,
  });
  const challenge = await issueChallenge(
    authority,
    manifest,
    publicationPolicy,
  );
  const proof = await createOrganizationEnrollmentProof({
    challenge,
    authority: authoritySigner.descriptor,
    manifest,
    publication_policy: publicationPolicy,
    signer: installationSigner,
    now: NOW,
  });
  const enrollmentReceipt = await authority.completeEnrollment({
    challenge,
    proof,
    manifest,
  });
  const sync = track(
    new OrganizationSyncStore(
      options.syncPath ?? ':memory:',
      authoritySigner.descriptor,
    ),
  );
  await sync.storeEnrollmentReceipt(canonicalJson(enrollmentReceipt));
  const outbox = track(new FederatedOutboxStore(':memory:'));
  return {
    authoritySigner,
    installationSigner,
    authority,
    sync,
    outbox,
    manifest,
    publicationPolicy,
    enrollmentReceipt,
  };
}

function groupDrafts(
  harness: SyncHarness,
  groupIndex: number,
): ReturnType<typeof federatedApprovalGroupDrafts> {
  return federatedApprovalGroupDrafts({
    signer: harness.installationSigner,
    occurredAt: NOW,
    approvalId: `organization-sync-approval-${groupIndex}`,
    decisionId: DECISION_ID,
    actionId: ACTION_ID,
    digests: { a: DIGEST_A, b: DIGEST_B, c: DIGEST_C },
    organizationId: IDS.organization,
    principalId: IDS.principal,
    membershipId: IDS.membership,
    manifestId: IDS.manifest,
    manifestSha256: canonicalSha256(harness.manifest),
    productVersion: '0.1.0-dev.7',
    policy: {
      policyId: harness.publicationPolicy.policy_id,
      version: harness.publicationPolicy.version,
      sha256: canonicalSha256(harness.publicationPolicy),
      identityManifestId: harness.publicationPolicy.identity_manifest_id,
      signerInstallationId: harness.publicationPolicy.issued_by.installation_id,
      signerKeyId: harness.publicationPolicy.issued_by.key_id,
      publication: harness.publicationPolicy.publication,
    },
    idOffset: groupIndex * 2,
  });
}

async function appendGroup(
  harness: SyncHarness,
  groupIndex: number,
): Promise<readonly StoredFederatedOutboxEvent[]> {
  return harness.outbox.appendApprovalGroup({
    installation_id: IDS.installation,
    key_id: harness.installationSigner.descriptor.key_id,
    created_at: NOW,
    signer: harness.installationSigner,
    events: groupDrafts(harness, groupIndex),
  });
}

function batchFor(
  harness: SyncHarness,
  events: readonly StoredFederatedOutboxEvent[],
): OrganizationIngestBatchV1 {
  return {
    schema_version: 1,
    kind: 'echo-organization-ingest-batch',
    authority_id: harness.authoritySigner.descriptor.authority_id,
    organization_id: IDS.organization,
    installation_id: IDS.installation,
    enrollment_receipt_sha256: canonicalSha256(harness.enrollmentReceipt),
    events: events.map(({ envelope_json }) => envelope_json),
  };
}

function uploader(
  harness: SyncHarness,
  client: OrganizationIngestClient,
): OrganizationOutboxUploader {
  return track(
    new OrganizationOutboxUploader({
      installation_id: IDS.installation,
      outbox: harness.outbox,
      sync: harness.sync,
      client,
    }),
  );
}

async function expectZeroCursor(sync: OrganizationSyncStore): Promise<void> {
  expect(await sync.inspectState(IDS.installation)).toMatchObject({
    acknowledged_sequence: 0,
    acknowledged_event_hash: null,
    terminal_status: 'active',
    last_receipt_id: null,
  });
}

describe('local organization sync and outbox upload', () => {
  it('persists enrollment and advances the local cursor only from exact loopback authority receipts', async () => {
    const harness = await createHarness();
    const events = await appendGroup(harness, 0);
    const client = new LoopbackAuthorityClient(harness.authority);
    const upload = uploader(harness, client);

    const storedEnrollment = await harness.sync.inspectEnrollment(
      IDS.installation,
    );
    expect(storedEnrollment?.canonical).toBe(
      canonicalJson(harness.enrollmentReceipt),
    );
    expect(storedEnrollment?.sha256).toBe(
      canonicalSha256(harness.enrollmentReceipt),
    );
    await expectZeroCursor(harness.sync);

    const result = await upload.uploadPending();
    expect(result).toEqual({
      status: 'accepted',
      attempted_events: 2,
      acknowledged_sequence: 2,
      acknowledged_event_hash: events[1]!.event_hash,
      batch_sha256: canonicalSha256(client.batches[0]!),
    });
    expect(client.batches[0]!.events).toEqual(
      events.map(({ envelope_json }) => envelope_json),
    );
    expect(await upload.inspect()).toMatchObject({
      acknowledged_sequence: 2,
      acknowledged_event_hash: events[1]!.event_hash,
      terminal_status: 'active',
    });
    expect(
      await harness.sync.inspectIngestReceipts(IDS.installation),
    ).toHaveLength(2);
    expect(await upload.uploadPending()).toMatchObject({
      status: 'idle',
      attempted_events: 0,
      acknowledged_sequence: 2,
      batch_sha256: null,
    });
  });

  it('rejects a conflicting authority pin on reopen', async () => {
    const path = databasePath('organization-sync-pin');
    const firstAuthority = new TestAuthoritySigner();
    const first = track(
      new OrganizationSyncStore(path, firstAuthority.descriptor),
    );
    await first.close();

    const differentKeyForSameAuthority = new TestAuthoritySigner();
    expect(
      () =>
        new OrganizationSyncStore(
          path,
          differentKeyForSameAuthority.descriptor,
        ),
    ).toThrow(/pinned organization authority conflicts/);
    const reopened = track(
      new OrganizationSyncStore(path, firstAuthority.descriptor),
    );
    expect(reopened.authority).toEqual(firstAuthority.descriptor);
  });

  it('rejects tampered and wrong-key receipts without cursor movement, then recovers on exact signed duplicates', async () => {
    const harness = await createHarness();
    await appendGroup(harness, 0);
    const wrongSigner = new TestAuthoritySigner();
    let mode: 'tampered' | 'wrong-key' | 'exact' = 'tampered';
    const client: OrganizationIngestClient = {
      upload: async (batch, { signal }) => {
        signal.throwIfAborted();
        const receipts = await harness.authority.ingestBatch(batch);
        if (mode === 'tampered') {
          return receipts.map((receipt, index) =>
            canonicalJson({
              ...receipt,
              receipt_id: federationFixtureId('igr', 900 + index),
            }),
          );
        }
        if (mode === 'wrong-key') {
          return Promise.all(
            receipts.map(async (receipt) =>
              canonicalJson(
                await createSignedDocumentWithKey(
                  signedPayload(receipt),
                  harness.authoritySigner.descriptor.signing_key.key_id,
                  async (bytes) => wrongSigner.signUnchecked(bytes),
                ),
              ),
            ),
          );
        }
        return receipts.map((receipt) => canonicalJson(receipt));
      },
    };
    const upload = uploader(harness, client);

    await expect(upload.uploadPending()).rejects.toThrow(/payload digest/);
    await expectZeroCursor(harness.sync);
    expect(await harness.sync.inspectIngestReceipts(IDS.installation)).toEqual(
      [],
    );

    mode = 'wrong-key';
    await expect(upload.uploadPending()).rejects.toThrow(
      /signature is invalid/,
    );
    await expectZeroCursor(harness.sync);
    expect(await harness.sync.inspectIngestReceipts(IDS.installation)).toEqual(
      [],
    );

    mode = 'exact';
    await expect(upload.uploadPending()).resolves.toMatchObject({
      status: 'accepted',
      acknowledged_sequence: 2,
    });
    expect(
      await harness.sync.inspectIngestReceipts(IDS.installation),
    ).toHaveLength(2);
  });

  it('stores delayed stale terminal receipts without poisoning a newer accepted head', async () => {
    const harness = await createHarness();
    const acceptedEvents = await appendGroup(harness, 0);
    const gapEvents = await signFederatedApprovalGroupDrafts({
      signer: harness.installationSigner,
      drafts: groupDrafts(harness, 20),
      sequenceOffset: 2,
      previousEventHash: null,
    });
    const staleBatch = batchFor(harness, gapEvents);
    const staleReceipts = await harness.authority.ingestBatch(staleBatch);
    expect(
      staleReceipts.every(
        ({ status, reason }) =>
          status === 'quarantined' && reason === 'sequence_gap',
      ),
    ).toBe(true);
    expect(
      staleReceipts.every(
        ({ authority_head }) =>
          authority_head.last_sequence === 0 &&
          authority_head.last_event_hash === null,
      ),
    ).toBe(true);

    const acceptedBatch = batchFor(harness, acceptedEvents);
    const acceptedReceipts = await harness.authority.ingestBatch(acceptedBatch);
    const advanced = await harness.sync.storeIngestReceipts(
      acceptedBatch,
      acceptedReceipts.map((receipt) => canonicalJson(receipt)),
    );
    expect(advanced).toMatchObject({
      acknowledged_sequence: 2,
      acknowledged_event_hash: acceptedEvents[1]!.event_hash,
      terminal_status: 'active',
    });

    const afterStale = await harness.sync.storeIngestReceipts(
      staleBatch,
      staleReceipts.map((receipt) => canonicalJson(receipt)),
    );
    expect(afterStale).toMatchObject({
      acknowledged_sequence: 2,
      acknowledged_event_hash: acceptedEvents[1]!.event_hash,
      terminal_status: 'active',
      last_receipt_id: advanced.last_receipt_id,
    });
    expect(
      await harness.sync.inspectIngestReceipts(IDS.installation),
    ).toHaveLength(4);
  });

  it('packs bounded uploads at complete approval-group boundaries', async () => {
    const harness = await createHarness();
    const groupCount = ORGANIZATION_UPLOAD_MAX_EVENTS / 2 + 1;
    for (let index = 0; index < groupCount; index += 1) {
      await appendGroup(harness, index);
    }
    const client = new LoopbackAuthorityClient(harness.authority);
    const upload = uploader(harness, client);

    const first = await upload.uploadPending();
    expect(first).toMatchObject({
      status: 'accepted',
      attempted_events: ORGANIZATION_UPLOAD_MAX_EVENTS,
      acknowledged_sequence: ORGANIZATION_UPLOAD_MAX_EVENTS,
    });
    const second = await upload.uploadPending();
    expect(second).toMatchObject({
      status: 'accepted',
      attempted_events: 2,
      acknowledged_sequence: ORGANIZATION_UPLOAD_MAX_EVENTS + 2,
    });
    expect(client.batches.map(({ events }) => events.length)).toEqual([
      ORGANIZATION_UPLOAD_MAX_EVENTS,
      2,
    ]);
    for (const batch of client.batches) {
      const approvalCounts = new Map<string, number>();
      for (const raw of batch.events) {
        const event = parseCanonicalJson(raw) as unknown as {
          local_reference: { approval_id: string };
        };
        const approvalId = event.local_reference.approval_id;
        approvalCounts.set(
          approvalId,
          (approvalCounts.get(approvalId) ?? 0) + 1,
        );
      }
      expect([...approvalCounts.values()].every((count) => count === 2)).toBe(
        true,
      );
    }
    await expect(upload.uploadPending()).resolves.toMatchObject({
      status: 'idle',
      attempted_events: 0,
      acknowledged_sequence: ORGANIZATION_UPLOAD_MAX_EVENTS + 2,
    });
  });

  it('aborts an in-flight transport on close without moving the cursor or owning its stores', async () => {
    const harness = await createHarness();
    await appendGroup(harness, 0);
    const started = deferred();
    let observedSignal: AbortSignal | undefined;
    const client: OrganizationIngestClient = {
      upload: async (_batch, { signal }) => {
        observedSignal = signal;
        started.resolve();
        return new Promise<readonly string[]>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new Error('test transport aborted')),
            { once: true },
          );
        });
      },
    };
    const upload = uploader(harness, client);
    const pending = upload.uploadPending();
    await started.promise;
    const closing = upload.close();

    await expect(pending).rejects.toThrow(/transport aborted/);
    await closing;
    expect(observedSignal?.aborted).toBe(true);
    await expectZeroCursor(harness.sync);
    await expect(upload.uploadPending()).rejects.toThrow(/uploader is closed/);
    expect(
      await harness.outbox.readInstallationEvents(IDS.installation),
    ).toHaveLength(2);
    expect(await harness.sync.inspectState(IDS.installation)).not.toBeNull();
  });
});
