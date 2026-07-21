import {
  generateKeyPairSync,
  sign as signMessage,
  type KeyObject,
} from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OrganizationAuthoritySigner } from "../../src/experimental/n2/authority/authority-signer.js";
import { createOrganizationEnrollmentRequest } from "../../src/experimental/n2/authority/enrollment-request.js";
import { OrganizationAuthorityStore } from "../../src/experimental/n2/authority/organization-authority-store.js";
import type {
  LocalIdentityManifestV1,
  PublicationPolicyV1,
  Sha256Digest,
} from "../../src/product/federation/contracts.js";
import type {
  OrganizationAuthorityDescriptorV1,
  OrganizationEnrollmentRequestV1,
  OrganizationEnrollmentReceiptV1,
  OrganizationIngestBatchV1,
} from "../../src/experimental/n2/contracts.js";
import {
  canonicalJson,
  canonicalSha256,
} from "../../src/product/federation/foundation/canonical-json.js";
import type {
  InstallationKeyDescriptor,
  InstallationSigner,
} from "../../src/product/federation/foundation/installation-signer.js";
import {
  createSignedDocument,
  createSignedDocumentWithKey,
  signedPayload,
} from "../../src/product/federation/foundation/signed-document.js";
import {
  normalizeP256LowS,
  p256KeyId,
} from "../../src/product/federation/foundation/signature-profile.js";
import { OrganizationSyncStore } from "../../src/experimental/n2/organization/organization-sync-store.js";
import {
  FederatedOutboxStore,
  type StoredFederatedOutboxEvent,
} from "../../src/product/federation/outbox-store.js";
import {
  CountingInstallationSigner,
  federatedApprovalGroupDrafts,
  federationFixtureId,
  signFederatedApprovalGroupDrafts,
} from "./fixtures/federated-records.js";
import { testManifest, testPolicy } from "./fixtures/founder-identity.js";

const NOW = "2026-07-20T18:00:00.000Z";
const EXPIRES = "2026-07-20T18:10:00.000Z";
const DIGEST_A = `sha256:${"a".repeat(64)}` as const;
const DIGEST_B = `sha256:${"b".repeat(64)}` as const;
const DIGEST_C = `sha256:${"c".repeat(64)}` as const;
const DECISION_ID = `decision:sha256:${"1".repeat(64)}`;
const ACTION_ID = `action:sha256:${"2".repeat(64)}`;
const POLICY_ID = federationFixtureId("pol", 101);
const IDS = {
  organization: federationFixtureId("org", 101),
  principal: federationFixtureId("prn", 101),
  membership: federationFixtureId("mem", 101),
  device: federationFixtureId("dev", 101),
  installation: federationFixtureId("ins", 101),
  manifest: federationFixtureId("idm", 101),
  claim: federationFixtureId("clm", 101),
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

class TestAuthoritySigner implements OrganizationAuthoritySigner {
  private readonly privateKey: KeyObject;
  readonly descriptor: OrganizationAuthorityDescriptorV1;

  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
    });
    const publicKeyDer = publicKey.export({ type: "spki", format: "der" });
    this.privateKey = privateKey;
    this.descriptor = {
      schema_version: 1,
      kind: "echo-organization-authority",
      authority_id: federationFixtureId("oau", 101),
      organization_id: IDS.organization,
      signing_key: {
        key_id: p256KeyId(publicKeyDer),
        algorithm: "ecdsa-p256-sha256-der-low-s",
        public_key_spki_der_base64: publicKeyDer.toString("base64"),
      },
    };
  }

  async inspect(): Promise<OrganizationAuthorityDescriptorV1> {
    return structuredClone(this.descriptor);
  }

  async sign(message: Buffer, expectedKeyId?: Sha256Digest): Promise<Buffer> {
    if (expectedKeyId !== this.descriptor.signing_key.key_id) {
      throw new Error("test authority signing identity mismatch");
    }
    return this.signUnchecked(message);
  }

  signUnchecked(message: Buffer): Buffer {
    return normalizeP256LowS(
      signMessage("sha256", message, {
        key: this.privateKey,
        dsaEncoding: "der",
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

function manifestKey(
  descriptor: InstallationKeyDescriptor,
): LocalIdentityManifestV1["installation"]["signing_key"] {
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

async function enrollmentRequest(
  authority: OrganizationAuthorityStore,
  authorityDescriptor: OrganizationAuthorityDescriptorV1,
  manifest: LocalIdentityManifestV1,
  publicationPolicy: PublicationPolicyV1,
  signer: InstallationSigner,
): Promise<{
  grant: string;
  request: OrganizationEnrollmentRequestV1;
}> {
  const grant = await authority.issueEnrollmentGrant(IDS.membership, {
    expires_at: EXPIRES,
  });
  return {
    grant: grant.enrollment_grant,
    request: await createOrganizationEnrollmentRequest({
      authority: authorityDescriptor,
      manifest,
      publication_policy: publicationPolicy,
      enrollment_grant: grant.enrollment_grant,
      signer,
    }),
  };
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
      databasePath: ":memory:",
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
  const enrollment = await enrollmentRequest(
    authority,
    authoritySigner.descriptor,
    manifest,
    publicationPolicy,
    installationSigner,
  );
  const enrollmentReceipt = await authority.completeEnrollment({
    enrollment_request: enrollment.request,
    enrollment_grant: enrollment.grant,
    manifest,
    publication_policy: publicationPolicy,
  });
  const sync = track(
    new OrganizationSyncStore(
      options.syncPath ?? ":memory:",
      authoritySigner.descriptor,
    ),
  );
  await sync.storeEnrollmentReceipt(canonicalJson(enrollmentReceipt));
  const outbox = track(new FederatedOutboxStore(":memory:"));
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
    productVersion: "0.1.0-dev.7",
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
    kind: "echo-organization-ingest-batch",
    authority_id: harness.authoritySigner.descriptor.authority_id,
    organization_id: IDS.organization,
    installation_id: IDS.installation,
    enrollment_receipt_sha256: canonicalSha256(harness.enrollmentReceipt),
    events: events.map(({ envelope_json }) => envelope_json),
  };
}

async function expectZeroCursor(sync: OrganizationSyncStore): Promise<void> {
  expect(await sync.inspectState(IDS.installation)).toMatchObject({
    acknowledged_sequence: 0,
    acknowledged_event_hash: null,
    terminal_status: "active",
  });
}

describe("local organization sync", () => {
  it("advances only from authority receipts and records revocation", async () => {
    const harness = await createHarness();
    const events = await appendGroup(harness, 0);

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

    const batch = batchFor(harness, events);
    const receipt = await harness.authority.ingestBatch(batch);
    const result = await harness.sync.storeBatchReceipt(
      batch,
      canonicalJson(receipt),
    );
    expect(result.state).toMatchObject({
      acknowledged_sequence: 2,
      acknowledged_event_hash: events[1]!.event_hash,
      terminal_status: "active",
    });
    expect(
      await harness.sync.inspectBatchReceipts(IDS.installation),
    ).toHaveLength(1);

    const revokedEvents = await appendGroup(harness, 1);
    await harness.authority.revokeInstallation(IDS.installation, {
      reason: "organization sync revocation test",
    });
    const revokedBatch = batchFor(harness, revokedEvents);
    const revokedReceipt = await harness.authority.ingestBatch(revokedBatch);
    expect(revokedReceipt).toMatchObject({
      status: "rejected",
      reason: "installation_revoked",
    });
    const revoked = await harness.sync.storeBatchReceipt(
      revokedBatch,
      canonicalJson(revokedReceipt),
    );
    expect(revoked.state).toMatchObject({
      acknowledged_sequence: 2,
      acknowledged_event_hash: events[1]!.event_hash,
      terminal_status: "revoked",
    });
    expect(
      await harness.sync.inspectBatchReceipts(IDS.installation),
    ).toHaveLength(2);
  });

  it("rejects a conflicting authority pin on reopen", async () => {
    const path = databasePath("organization-sync-pin");
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

  it("rejects tampered and wrong-key receipts without cursor movement, then recovers on exact signed duplicates", async () => {
    const harness = await createHarness();
    const events = await appendGroup(harness, 0);
    const batch = batchFor(harness, events);
    const receipt = await harness.authority.ingestBatch(batch);
    const wrongSigner = new TestAuthoritySigner();
    const tampered = canonicalJson({
      ...receipt,
      receipt_id: federationFixtureId("igr", 900),
    });
    await expect(
      harness.sync.storeBatchReceipt(batch, tampered),
    ).rejects.toThrow(/payload digest/);
    await expectZeroCursor(harness.sync);
    expect(await harness.sync.inspectBatchReceipts(IDS.installation)).toEqual(
      [],
    );

    const wrongKey = canonicalJson(
      await createSignedDocumentWithKey(
        signedPayload(receipt),
        harness.authoritySigner.descriptor.signing_key.key_id,
        async (bytes) => wrongSigner.signUnchecked(bytes),
      ),
    );
    await expect(
      harness.sync.storeBatchReceipt(batch, wrongKey),
    ).rejects.toThrow(/signature is invalid/);
    await expectZeroCursor(harness.sync);

    await expect(
      harness.sync.storeBatchReceipt(batch, canonicalJson(receipt)),
    ).resolves.toMatchObject(
      {
        state: { acknowledged_sequence: 2 },
      },
    );
    expect(
      await harness.sync.inspectBatchReceipts(IDS.installation),
    ).toHaveLength(1);
  });

  it("leaves authority and local state unchanged after a sequence-gap error", async () => {
    const harness = await createHarness();
    const acceptedEvents = await appendGroup(harness, 0);
    const gapEvents = await signFederatedApprovalGroupDrafts({
      signer: harness.installationSigner,
      drafts: groupDrafts(harness, 20),
      sequenceOffset: 2,
      previousEventHash: null,
    });
    const staleBatch = batchFor(harness, gapEvents);
    await expect(harness.authority.ingestBatch(staleBatch)).rejects.toThrow(
      /sequence_gap/,
    );
    expect(await harness.authority.listBatchReceipts(IDS.installation)).toEqual(
      [],
    );
    await expectZeroCursor(harness.sync);

    const acceptedBatch = batchFor(harness, acceptedEvents);
    const acceptedReceipt = await harness.authority.ingestBatch(acceptedBatch);
    const advanced = await harness.sync.storeBatchReceipt(
      acceptedBatch,
      canonicalJson(acceptedReceipt),
    );
    expect(advanced.state).toMatchObject({
      acknowledged_sequence: 2,
      acknowledged_event_hash: acceptedEvents[1]!.event_hash,
      terminal_status: "active",
    });
    expect(
      await harness.sync.inspectBatchReceipts(IDS.installation),
    ).toHaveLength(1);
  });

});
