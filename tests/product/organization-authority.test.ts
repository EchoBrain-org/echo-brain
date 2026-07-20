import {
  generateKeyPairSync,
  sign as signMessage,
  type KeyObject,
} from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  OrganizationAuthorityStore,
  type OrganizationAuthorityStoreOptions,
} from '../../src/product/federation/authority/organization-authority-store.js';
import { createOrganizationEnrollmentProof } from '../../src/product/federation/authority/enrollment-proof.js';
import type { OrganizationAuthoritySigner } from '../../src/product/federation/authority/authority-signer.js';
import type {
  FederatedEventV1,
  LocalIdentityManifestV1,
  OrganizationAuthorityDescriptorV1,
  OrganizationEnrollmentReceiptV1,
  OrganizationIngestBatchV1,
  PublicationPolicyV1,
  Sha256Digest,
} from '../../src/product/federation/contracts.js';
import {
  canonicalJson,
  canonicalSha256,
  sha256Digest,
} from '../../src/product/federation/foundation/canonical-json.js';
import type {
  InstallationKeyDescriptor,
  InstallationSigner,
} from '../../src/product/federation/foundation/installation-signer.js';
import { createSignedDocument } from '../../src/product/federation/foundation/signed-document.js';
import {
  normalizeP256LowS,
  p256KeyId,
} from '../../src/product/federation/foundation/signature-profile.js';
import { verifySignedDocument } from '../../src/product/federation/foundation/signed-document.js';
import {
  FederatedOutboxStore,
  type FederatedOutboxEventDraft,
  type StoredFederatedOutboxEvent,
} from '../../src/product/federation/outbox-store.js';
import {
  CountingInstallationSigner,
  federatedApprovalGroupDrafts,
  federationFixtureId,
  signFederatedApprovalGroupDrafts,
} from './fixtures/federated-records.js';
import { testManifest, testPolicy } from './fixtures/founder-identity.js';

const NOW = '2026-07-20T17:00:00.000Z';
const BEFORE = '2026-07-20T16:59:00.000Z';
const SOON = '2026-07-20T17:01:00.000Z';
const LATER = '2026-07-20T17:02:00.000Z';
const MUCH_LATER = '2026-07-20T17:03:00.000Z';
const EXPIRES = '2026-07-20T17:10:00.000Z';
const DIGEST_A = `sha256:${'a'.repeat(64)}` as const;
const DIGEST_B = `sha256:${'b'.repeat(64)}` as const;
const DIGEST_C = `sha256:${'c'.repeat(64)}` as const;
const DECISION_ID = `decision:sha256:${'1'.repeat(64)}`;
const ACTION_ID = `action:sha256:${'2'.repeat(64)}`;

const IDS = {
  organization: federationFixtureId('org', 1),
  principal: federationFixtureId('prn', 1),
  membership: federationFixtureId('mem', 1),
  device: federationFixtureId('dev', 1),
  installation: federationFixtureId('ins', 1),
  manifest: federationFixtureId('idm', 1),
  policy: federationFixtureId('pol', 1),
  claim: federationFixtureId('clm', 1),
};

const temporary: string[] = [];
const openStores: { close(): Promise<void> }[] = [];

afterEach(async () => {
  for (const store of openStores.splice(0).reverse()) {
    await store.close();
  }
  for (const path of temporary.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function track<T extends { close(): Promise<void> }>(store: T): T {
  openStores.push(store);
  return store;
}

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'echo-organization-authority-'));
  temporary.push(directory);
  return join(directory, 'authority.sqlite');
}

class TestAuthoritySigner implements OrganizationAuthoritySigner {
  private readonly privateKey: KeyObject;
  readonly descriptor: OrganizationAuthorityDescriptorV1;
  signCalls = 0;

  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
    });
    const publicKeyDer = publicKey.export({ type: 'spki', format: 'der' });
    this.privateKey = privateKey;
    this.descriptor = {
      schema_version: 1,
      kind: 'echo-organization-authority',
      authority_id: federationFixtureId('oau', 1),
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
    this.signCalls += 1;
    return normalizeP256LowS(
      signMessage('sha256', message, {
        key: this.privateKey,
        dsaEncoding: 'der',
      }),
    );
  }
}

interface Harness {
  store: OrganizationAuthorityStore;
  authoritySigner: TestAuthoritySigner;
  installationSigner: CountingInstallationSigner;
  manifest: LocalIdentityManifestV1;
  policy: PublicationPolicyV1;
  clock: { value: string };
}

interface EnrolledHarness extends Harness {
  enrollmentReceipt: OrganizationEnrollmentReceiptV1;
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

async function signedManifest(
  signer: InstallationSigner,
  descriptor: InstallationKeyDescriptor,
  ids: typeof IDS = IDS,
): Promise<LocalIdentityManifestV1> {
  return createSignedDocument(
    testManifest({
      ids,
      at: NOW,
      key: manifestKey(descriptor),
    }),
    signer,
    ids.installation,
    descriptor.key_id,
  );
}

async function signedPolicy(
  signer: InstallationSigner,
  descriptor: InstallationKeyDescriptor,
  ids: typeof IDS = IDS,
): Promise<PublicationPolicyV1> {
  return createSignedDocument(
    testPolicy({
      policyId: ids.policy,
      organizationId: ids.organization,
      manifestId: ids.manifest,
      installationId: ids.installation,
      keyId: descriptor.key_id,
      effectiveAt: NOW,
    }),
    signer,
    ids.installation,
    descriptor.key_id,
  );
}

async function resignedManifest(
  harness: Harness,
  mutate: (manifest: Omit<LocalIdentityManifestV1, 'integrity'>) => void,
): Promise<LocalIdentityManifestV1> {
  const { integrity: _integrity, ...payload } = structuredClone(
    harness.manifest,
  );
  mutate(payload);
  return createSignedDocument(
    payload,
    harness.installationSigner,
    IDS.installation,
    harness.installationSigner.descriptor.key_id,
  );
}

async function resignedPolicy(
  harness: Harness,
  mutate: (policy: Omit<PublicationPolicyV1, 'integrity'>) => void,
): Promise<PublicationPolicyV1> {
  const { integrity: _integrity, ...payload } = structuredClone(harness.policy);
  mutate(payload);
  return createSignedDocument(
    payload,
    harness.installationSigner,
    IDS.installation,
    harness.installationSigner.descriptor.key_id,
  );
}

async function provisionedHarness(
  options: {
    path?: string;
    authoritySigner?: TestAuthoritySigner;
    installationSigner?: CountingInstallationSigner;
    clock?: { value: string };
  } = {},
): Promise<Harness> {
  const authoritySigner = options.authoritySigner ?? new TestAuthoritySigner();
  const installationSigner =
    options.installationSigner ??
    new CountingInstallationSigner(IDS.installation);
  const clock = options.clock ?? { value: NOW };
  const storeOptions: OrganizationAuthorityStoreOptions = {
    databasePath: options.path ?? ':memory:',
    signer: authoritySigner,
    now: () => clock.value,
  };
  const store = track(new OrganizationAuthorityStore(storeOptions));
  const manifest = await signedManifest(
    installationSigner,
    installationSigner.descriptor,
  );
  const policy = await signedPolicy(
    installationSigner,
    installationSigner.descriptor,
  );
  await store.provisionOrganization({
    organization_id: IDS.organization,
    display_name: manifest.organization.display_name,
    principal_id: IDS.principal,
    principal_display_name: manifest.principal.display_name,
    membership_id: IDS.membership,
    provisioned_at: NOW,
  });
  return {
    store,
    authoritySigner,
    installationSigner,
    manifest,
    policy,
    clock,
  };
}

async function grant(harness: Harness): Promise<string> {
  return (
    await harness.store.issueEnrollmentGrant(IDS.membership, {
      expires_at: EXPIRES,
    })
  ).enrollment_grant;
}

async function enroll(harness: Harness): Promise<EnrolledHarness> {
  const challenge = await harness.store.issueEnrollmentChallenge({
    manifest: harness.manifest,
    publication_policy: harness.policy,
    enrollment_grant: await grant(harness),
    expires_at: EXPIRES,
  });
  const proof = await createOrganizationEnrollmentProof({
    challenge,
    authority: harness.authoritySigner.descriptor,
    manifest: harness.manifest,
    publication_policy: harness.policy,
    signer: harness.installationSigner,
    now: harness.clock.value,
  });
  const enrollmentReceipt = await harness.store.completeEnrollment({
    challenge,
    proof,
    manifest: harness.manifest,
  });
  return { ...harness, enrollmentReceipt };
}

function eventDrafts(
  harness: Harness,
  approvalId: string,
  idOffset: number,
  occurredAt = NOW,
): FederatedOutboxEventDraft[] {
  return federatedApprovalGroupDrafts({
    signer: harness.installationSigner,
    occurredAt,
    approvalId,
    decisionId: DECISION_ID,
    actionId: ACTION_ID,
    digests: { a: DIGEST_A, b: DIGEST_B, c: DIGEST_C },
    organizationId: IDS.organization,
    principalId: IDS.principal,
    membershipId: IDS.membership,
    manifestId: IDS.manifest,
    manifestSha256: canonicalSha256(harness.manifest),
    policy: {
      policyId: harness.policy.policy_id,
      version: harness.policy.version,
      sha256: canonicalSha256(harness.policy),
      identityManifestId: harness.policy.identity_manifest_id,
      signerInstallationId: harness.policy.issued_by.installation_id,
      signerKeyId: harness.policy.issued_by.key_id,
      publication: harness.policy.publication,
    },
    productVersion: '0.1.0-dev.7',
    idOffset,
  });
}

function ingestBatch(
  harness: EnrolledHarness,
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

async function acceptedFirstGroup(harness: EnrolledHarness): Promise<{
  outbox: FederatedOutboxStore;
  events: readonly StoredFederatedOutboxEvent[];
}> {
  const outbox = track(new FederatedOutboxStore(':memory:'));
  const events = await outbox.appendApprovalGroup({
    installation_id: IDS.installation,
    key_id: harness.installationSigner.descriptor.key_id,
    created_at: NOW,
    signer: harness.installationSigner,
    events: eventDrafts(harness, 'approval-authority-one', 0),
  });
  const receipts = await harness.store.ingestBatch(
    ingestBatch(harness, events),
  );
  expect(receipts.map(({ status }) => status)).toEqual([
    'accepted',
    'accepted',
  ]);
  return { outbox, events };
}

describe('organization authority', () => {
  it('requires the matching one-time grant and rejects a divergent consumed-grant retry', async () => {
    const harness = await provisionedHarness();
    const otherMembershipId = federationFixtureId('mem', 2);
    await harness.store.provisionMembership({
      principal_id: federationFixtureId('prn', 2),
      principal_display_name: 'Another member',
      membership_id: otherMembershipId,
      membership_type: 'employee',
      provisioned_at: NOW,
    });
    const wrongGrant = (
      await harness.store.issueEnrollmentGrant(otherMembershipId, {
        expires_at: EXPIRES,
      })
    ).enrollment_grant;
    const enrollmentGrant = await grant(harness);

    await expect(
      harness.store.issueEnrollmentChallenge({
        manifest: harness.manifest,
        publication_policy: harness.policy,
        enrollment_grant: wrongGrant,
        expires_at: EXPIRES,
      }),
    ).rejects.toThrow(/does not authorize/);
    expect((await harness.store.counts()).challenges).toBe(0);

    await harness.store.issueEnrollmentChallenge({
      manifest: harness.manifest,
      publication_policy: harness.policy,
      enrollment_grant: enrollmentGrant,
      expires_at: EXPIRES,
    });
    await expect(
      harness.store.issueEnrollmentChallenge({
        manifest: harness.manifest,
        publication_policy: harness.policy,
        enrollment_grant: enrollmentGrant,
        expires_at: MUCH_LATER,
      }),
    ).rejects.toThrow(/already consumed differently/);
    expect((await harness.store.counts()).challenges).toBe(1);
  });

  it('rejects signed manifests with invalid semantics or authority display mismatches', async () => {
    const harness = await provisionedHarness();
    const enrollmentGrant = await grant(harness);
    const duplicateClaimManifest = await resignedManifest(
      harness,
      (manifest) => {
        manifest.identity_claims = [
          ...manifest.identity_claims,
          structuredClone(manifest.identity_claims[0]!),
        ];
      },
    );

    await expect(
      harness.store.issueEnrollmentChallenge({
        manifest: duplicateClaimManifest,
        publication_policy: harness.policy,
        enrollment_grant: enrollmentGrant,
        expires_at: EXPIRES,
      }),
    ).rejects.toThrow(/duplicate claim IDs/);

    const renamedManifest = await resignedManifest(harness, (manifest) => {
      manifest.organization.display_name = 'Lookalike EchoBrain';
    });
    await expect(
      harness.store.issueEnrollmentChallenge({
        manifest: renamedManifest,
        publication_policy: harness.policy,
        enrollment_grant: enrollmentGrant,
        expires_at: EXPIRES,
      }),
    ).rejects.toThrow(/does not match active preprovisioned authority facts/);
    expect((await harness.store.counts()).challenges).toBe(0);
  });

  it('rejects tampered policies and valid signatures over mismatched policy coordinates', async () => {
    const harness = await provisionedHarness();
    const enrollmentGrant = await grant(harness);
    const tamperedPolicy = structuredClone(harness.policy);
    tamperedPolicy.publication.sensitivity = 'restricted';

    await expect(
      harness.store.issueEnrollmentChallenge({
        manifest: harness.manifest,
        publication_policy: tamperedPolicy,
        enrollment_grant: enrollmentGrant,
        expires_at: EXPIRES,
      }),
    ).rejects.toThrow(/payload digest does not match|signature is invalid/i);

    const mismatchedPolicy = await resignedPolicy(harness, (policy) => {
      policy.identity_manifest_id = federationFixtureId('idm', 99);
    });
    await expect(
      harness.store.issueEnrollmentChallenge({
        manifest: harness.manifest,
        publication_policy: mismatchedPolicy,
        enrollment_grant: enrollmentGrant,
        expires_at: EXPIRES,
      }),
    ).rejects.toThrow(/does not match its identity manifest/);

    const predatingPolicy = await resignedPolicy(harness, (policy) => {
      policy.effective_at = BEFORE;
    });
    await expect(
      harness.store.issueEnrollmentChallenge({
        manifest: harness.manifest,
        publication_policy: predatingPolicy,
        enrollment_grant: enrollmentGrant,
        expires_at: EXPIRES,
      }),
    ).rejects.toThrow(/outside its manifest and authority chronology/);
    expect((await harness.store.counts()).challenges).toBe(0);
  });

  it('signs exact challenges and proofs, expires without partial enrollment, and makes completion exactly idempotent', async () => {
    const harness = await provisionedHarness();
    const authorityPublicKey = Buffer.from(
      harness.authoritySigner.descriptor.signing_key.public_key_spki_der_base64,
      'base64',
    );
    const installationPublicKey = Buffer.from(
      harness.installationSigner.descriptor.public_key_spki_der_base64,
      'base64',
    );

    const expiredChallenge = await harness.store.issueEnrollmentChallenge({
      manifest: harness.manifest,
      publication_policy: harness.policy,
      enrollment_grant: await grant(harness),
      expires_at: SOON,
    });
    verifySignedDocument(
      expiredChallenge,
      authorityPublicKey,
      harness.authoritySigner.descriptor.signing_key.key_id,
    );
    expect(expiredChallenge.identity_manifest_sha256).toBe(
      canonicalSha256(harness.manifest),
    );
    const expiredProof = await createOrganizationEnrollmentProof({
      challenge: expiredChallenge,
      authority: harness.authoritySigner.descriptor,
      manifest: harness.manifest,
      publication_policy: harness.policy,
      signer: harness.installationSigner,
      now: NOW,
    });
    harness.clock.value = SOON;
    await expect(
      harness.store.completeEnrollment({
        challenge: expiredChallenge,
        proof: expiredProof,
        manifest: harness.manifest,
      }),
    ).rejects.toThrow(/expired/);
    expect(
      await harness.store.inspectInstallation(IDS.installation),
    ).toBeNull();
    expect((await harness.store.counts()).installations).toBe(0);

    harness.clock.value = LATER;
    const enrollmentGrant = await grant(harness);
    const challenge = await harness.store.issueEnrollmentChallenge({
      manifest: harness.manifest,
      publication_policy: harness.policy,
      enrollment_grant: enrollmentGrant,
      expires_at: EXPIRES,
    });
    expect(
      canonicalJson(
        await harness.store.issueEnrollmentChallenge({
          manifest: harness.manifest,
          publication_policy: harness.policy,
          enrollment_grant: enrollmentGrant,
          expires_at: EXPIRES,
        }),
      ),
    ).toBe(canonicalJson(challenge));
    const proof = await createOrganizationEnrollmentProof({
      challenge,
      authority: harness.authoritySigner.descriptor,
      manifest: harness.manifest,
      publication_policy: harness.policy,
      signer: harness.installationSigner,
      now: LATER,
    });
    verifySignedDocument(
      proof,
      installationPublicKey,
      harness.installationSigner.descriptor.key_id,
    );
    const receipt = await harness.store.completeEnrollment({
      challenge,
      proof,
      manifest: harness.manifest,
    });
    verifySignedDocument(
      receipt,
      authorityPublicKey,
      harness.authoritySigner.descriptor.signing_key.key_id,
    );
    const retry = await harness.store.completeEnrollment({
      challenge,
      proof,
      manifest: harness.manifest,
    });
    expect(canonicalJson(retry)).toBe(canonicalJson(receipt));

    const differentlySignedProof = await createOrganizationEnrollmentProof({
      challenge,
      authority: harness.authoritySigner.descriptor,
      manifest: harness.manifest,
      publication_policy: harness.policy,
      signer: harness.installationSigner,
      now: LATER,
    });
    expect(canonicalJson(differentlySignedProof)).not.toBe(
      canonicalJson(proof),
    );
    await expect(
      harness.store.completeEnrollment({
        challenge,
        proof: differentlySignedProof,
        manifest: harness.manifest,
      }),
    ).rejects.toThrow(/already consumed/);
    expect((await harness.store.counts()).installations).toBe(1);
  });

  it('atomically accepts exact event bytes and returns event-specific duplicate replay heads', async () => {
    const harness = await enroll(await provisionedHarness());
    const { events } = await acceptedFirstGroup(harness);
    const firstReceipts = await harness.store.listIngestReceipts(
      events[0]!.event_id,
    );
    expect(firstReceipts).toHaveLength(1);
    expect(firstReceipts[0]!.authority_head).toEqual({
      last_sequence: 1,
      last_event_hash: events[0]!.event_hash,
    });

    const duplicate = await harness.store.ingestBatch(
      ingestBatch(harness, events),
    );
    expect(duplicate.map(({ status }) => status)).toEqual([
      'duplicate',
      'duplicate',
    ]);
    expect(duplicate.map(({ authority_head }) => authority_head)).toEqual(
      events.map(({ sequence, event_hash }) => ({
        last_sequence: sequence,
        last_event_hash: event_hash,
      })),
    );
    expect(
      (await harness.store.readAcceptedEvent(events[0]!.event_id))!
        .envelope_json,
    ).toBe(events[0]!.envelope_json);
    expect(
      await harness.store.inspectInstallation(IDS.installation),
    ).toMatchObject({
      last_sequence: 2,
      last_event_hash: events[1]!.event_hash,
    });
    expect(await harness.store.counts()).toMatchObject({
      accepted_events: 2,
      ingest_receipts: 4,
    });
  });

  it('quarantines sequence gaps, forks, and record-ID conflicts without advancing the trusted head', async () => {
    const harness = await enroll(await provisionedHarness());
    const { events: accepted } = await acceptedFirstGroup(harness);
    const acceptedHead = accepted[1]!.event_hash;

    const gap = await signFederatedApprovalGroupDrafts({
      signer: harness.installationSigner,
      drafts: eventDrafts(harness, 'approval-authority-gap', 10),
      sequenceOffset: 3,
      previousEventHash: acceptedHead,
    });
    const gapReceipts = await harness.store.ingestBatch(
      ingestBatch(harness, gap),
    );
    expect(
      gapReceipts.map(({ status, reason }) => ({ status, reason })),
    ).toEqual([
      { status: 'quarantined', reason: 'sequence_gap' },
      { status: 'quarantined', reason: 'sequence_gap' },
    ]);

    const fork = await signFederatedApprovalGroupDrafts({
      signer: harness.installationSigner,
      drafts: eventDrafts(harness, 'approval-authority-fork', 20),
      sequenceOffset: 1,
      previousEventHash: accepted[0]!.event_hash,
    });
    const forkReceipts = await harness.store.ingestBatch(
      ingestBatch(harness, fork),
    );
    expect(forkReceipts.every(({ reason }) => reason === 'sequence_fork')).toBe(
      true,
    );

    const conflictDrafts = eventDrafts(
      harness,
      'approval-authority-record-conflict',
      30,
    );
    const firstConflict = conflictDrafts[0]!;
    conflictDrafts[0] = {
      ...firstConflict,
      envelope: {
        ...firstConflict.envelope,
        record: {
          ...firstConflict.envelope.record,
          record_id: accepted[0]!.envelope.record.record_id,
        } as FederatedEventV1['record'],
      },
    };
    const recordConflict = await signFederatedApprovalGroupDrafts({
      signer: harness.installationSigner,
      drafts: conflictDrafts,
      sequenceOffset: 2,
      previousEventHash: acceptedHead,
    });
    const recordReceipts = await harness.store.ingestBatch(
      ingestBatch(harness, recordConflict),
    );
    expect(
      recordReceipts.every(({ reason }) => reason === 'record_id_conflict'),
    ).toBe(true);

    for (const receipt of [
      ...gapReceipts,
      ...forkReceipts,
      ...recordReceipts,
    ]) {
      expect(receipt.authority_head).toEqual({
        last_sequence: 2,
        last_event_hash: acceptedHead,
      });
    }
    expect(
      await harness.store.inspectInstallation(IDS.installation),
    ).toMatchObject({
      last_sequence: 2,
      last_event_hash: acceptedHead,
    });
    expect((await harness.store.counts()).accepted_events).toBe(2);
  });

  it('rejects re-signed semantic event forgery without advancing the trusted head', async () => {
    const harness = await enroll(await provisionedHarness());
    const digestMismatchDrafts = eventDrafts(
      harness,
      'approval-authority-config-forgery',
      40,
    );
    for (const draft of digestMismatchDrafts) {
      draft.envelope.processor.configuration_snapshot = {
        model: 'attacker-substituted-model',
      };
    }
    const digestMismatch = await signFederatedApprovalGroupDrafts({
      signer: harness.installationSigner,
      drafts: digestMismatchDrafts,
    });

    await expect(
      harness.store.ingestBatch(ingestBatch(harness, digestMismatch)),
    ).rejects.toThrow(/chronology is inconsistent/);
    expect(
      await harness.store.inspectInstallation(IDS.installation),
    ).toMatchObject({ last_sequence: 0, last_event_hash: null });

    const approvalMismatchDrafts = eventDrafts(
      harness,
      'approval-authority-time-forgery',
      50,
    );
    for (const draft of approvalMismatchDrafts) {
      draft.envelope.approval = {
        ...draft.envelope.approval,
        reviewed_at: SOON,
      };
    }
    const approvalMismatch = await signFederatedApprovalGroupDrafts({
      signer: harness.installationSigner,
      drafts: approvalMismatchDrafts,
    });

    await expect(
      harness.store.ingestBatch(ingestBatch(harness, approvalMismatch)),
    ).rejects.toThrow(/chronology is inconsistent/);
    expect(
      await harness.store.inspectInstallation(IDS.installation),
    ).toMatchObject({ last_sequence: 0, last_event_hash: null });
    expect(await harness.store.counts()).toMatchObject({
      accepted_events: 0,
      ingest_receipts: 0,
    });
  });

  it('serializes installation and membership revocation with ingest while preserving accepted history', async () => {
    const harness = await enroll(await provisionedHarness());
    const { outbox, events: accepted } = await acceptedFirstGroup(harness);
    const laterEvents = await outbox.appendApprovalGroup({
      installation_id: IDS.installation,
      key_id: harness.installationSigner.descriptor.key_id,
      created_at: LATER,
      signer: harness.installationSigner,
      events: eventDrafts(
        harness,
        'approval-authority-after-revocation',
        2,
        LATER,
      ),
    });

    harness.clock.value = LATER;
    const requestedInstallationRevocation = {
      reason: 'device retired',
      revoked_at: NOW,
    };
    const installationRevocation = await harness.store.revokeInstallation(
      IDS.installation,
      requestedInstallationRevocation,
    );
    expect(installationRevocation.revoked_at).toBe(LATER);
    const installationRejected = await harness.store.ingestBatch(
      ingestBatch(harness, laterEvents),
    );
    expect(
      installationRejected.every(
        ({ status, reason }) =>
          status === 'rejected' && reason === 'installation_revoked',
      ),
    ).toBe(true);

    harness.clock.value = MUCH_LATER;
    const installationRevocationRetry = await harness.store.revokeInstallation(
      IDS.installation,
      requestedInstallationRevocation,
    );
    expect(installationRevocationRetry).toMatchObject({
      version: 2,
      revoked_at: LATER,
    });
    const requestedMembershipRevocation = {
      reason: 'tenure ended',
      revoked_at: NOW,
    };
    const membershipRevocation = await harness.store.revokeMembership(
      IDS.membership,
      requestedMembershipRevocation,
    );
    expect(membershipRevocation.revoked_at).toBe(MUCH_LATER);
    const membershipRejected = await harness.store.ingestBatch(
      ingestBatch(harness, laterEvents),
    );
    expect(
      membershipRejected.every(
        ({ status, reason }) =>
          status === 'rejected' && reason === 'membership_revoked',
      ),
    ).toBe(true);
    expect(
      await harness.store.inspectInstallation(IDS.installation),
    ).toMatchObject({
      status: 'revoked',
      version: 2,
      last_sequence: 2,
      last_event_hash: accepted[1]!.event_hash,
    });
    expect(await harness.store.inspectMembership(IDS.membership)).toMatchObject(
      {
        status: 'revoked',
        version: 2,
      },
    );
    expect((await harness.store.counts()).accepted_events).toBe(2);
    expect(
      (await harness.store.readAcceptedEvent(accepted[0]!.event_id))!
        .envelope_json,
    ).toBe(accepted[0]!.envelope_json);
  });

  it('persists exact authority state across reopen and forbids reusing one key for another installation', async () => {
    const path = databasePath();
    const authoritySigner = new TestAuthoritySigner();
    const clock = { value: NOW };
    const harness = await enroll(
      await provisionedHarness({ path, authoritySigner, clock }),
    );
    const { events } = await acceptedFirstGroup(harness);
    await harness.store.close();

    clock.value = LATER;
    const reopened = track(
      new OrganizationAuthorityStore({
        databasePath: path,
        signer: authoritySigner,
        now: () => clock.value,
      }),
    );
    expect(await reopened.readEnrollmentReceipt(IDS.installation)).toEqual(
      harness.enrollmentReceipt,
    );
    expect(
      (await reopened.readAcceptedEvent(events[1]!.event_id))!.envelope_json,
    ).toBe(events[1]!.envelope_json);
    expect(await reopened.counts()).toMatchObject({
      organizations: 1,
      memberships: 1,
      installations: 1,
      accepted_events: 2,
    });

    const aliasInstallation = federationFixtureId('ins', 2);
    const baseSigner = harness.installationSigner;
    const aliasDescriptor: InstallationKeyDescriptor = {
      ...baseSigner.descriptor,
      installation_id: aliasInstallation,
    };
    const aliasSigner: InstallationSigner = {
      generate: async (installationId) => {
        if (installationId !== aliasInstallation)
          throw new Error('unknown alias');
        return aliasDescriptor;
      },
      inspect: async (installationId) =>
        installationId === aliasInstallation ? aliasDescriptor : null,
      sign: async (installationId, message, expectedKeyId) => {
        if (installationId !== aliasInstallation)
          throw new Error('unknown alias');
        return baseSigner.sign(
          baseSigner.descriptor.installation_id,
          message,
          expectedKeyId,
        );
      },
    };
    const aliasIds = {
      ...IDS,
      device: federationFixtureId('dev', 2),
      installation: aliasInstallation,
      manifest: federationFixtureId('idm', 2),
      policy: federationFixtureId('pol', 2),
      claim: federationFixtureId('clm', 2),
    };
    const aliasManifest = await signedManifest(
      aliasSigner,
      aliasDescriptor,
      aliasIds,
    );
    const aliasPolicy = await signedPolicy(
      aliasSigner,
      aliasDescriptor,
      aliasIds,
    );
    const aliasGrant = await reopened.issueEnrollmentGrant(IDS.membership, {
      expires_at: EXPIRES,
    });
    await expect(
      reopened.issueEnrollmentChallenge({
        manifest: aliasManifest,
        publication_policy: aliasPolicy,
        enrollment_grant: aliasGrant.enrollment_grant,
        expires_at: EXPIRES,
      }),
    ).rejects.toThrow(/already registered/);
    expect(await reopened.inspectInstallation(aliasInstallation)).toBeNull();
    expect((await reopened.counts()).installations).toBe(1);
  });

  it('detects accepted-event and receipt row tampering on authority reads', async () => {
    const path = databasePath();
    const authoritySigner = new TestAuthoritySigner();
    const harness = await enroll(
      await provisionedHarness({ path, authoritySigner }),
    );
    const { events } = await acceptedFirstGroup(harness);
    const firstReceipt = (
      await harness.store.listIngestReceipts(events[0]!.event_id)
    )[0]!;
    await harness.store.close();

    const forgedEnvelope = structuredClone(events[0]!.envelope);
    forgedEnvelope.record.record_id = federationFixtureId('rec', 99);
    const forgedJson = canonicalJson(forgedEnvelope);
    const database = new Database(path);
    database
      .prepare(
        `UPDATE authority_accepted_events
         SET record_id = ?, event_sha256 = ?, envelope_json = ?
         WHERE event_id = ?`,
      )
      .run(
        forgedEnvelope.record.record_id,
        sha256Digest(forgedJson),
        forgedJson,
        forgedEnvelope.event_id,
      );
    database
      .prepare(
        `UPDATE authority_ingest_receipts SET event_id = ?
         WHERE receipt_id = ?`,
      )
      .run(events[1]!.event_id, firstReceipt.receipt_id);
    database.close();

    const reopened = track(
      new OrganizationAuthorityStore({
        databasePath: path,
        signer: authoritySigner,
        now: () => LATER,
      }),
    );
    await expect(
      reopened.readAcceptedEvent(events[0]!.event_id),
    ).rejects.toThrow(/payload digest does not match|signature is invalid/i);
    await expect(
      reopened.listIngestReceipts(events[1]!.event_id),
    ).rejects.toThrow(/receipt row is inconsistent/);
  });
});
