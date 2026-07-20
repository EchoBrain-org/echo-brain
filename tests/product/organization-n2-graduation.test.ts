import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildAuthorityMemberJoinPlan,
  type AuthorityMemberJoinPlan,
} from "../../src/product/federation/authority/member-join.js";
import { createOrganizationEnrollmentProof } from "../../src/product/federation/authority/enrollment-proof.js";
import { FileOrganizationAuthoritySigner } from "../../src/product/federation/authority/file-organization-authority-signer.js";
import { OrganizationAuthorityStore } from "../../src/product/federation/authority/organization-authority-store.js";
import type {
  NativeProducerV1,
  OrganizationAuthorityDescriptorV1,
  OrganizationEnrollmentReceiptV1,
  PublicationSnapshotV1,
} from "../../src/product/federation/contracts.js";
import {
  canonicalJson,
  canonicalSha256,
} from "../../src/product/federation/foundation/canonical-json.js";
import { FileInstallationSigner } from "../../src/product/federation/foundation/file-installation-signer.js";
import type { InstallationKeyDescriptor } from "../../src/product/federation/foundation/installation-signer.js";
import { OrganizationSyncStore } from "../../src/product/federation/organization/organization-sync-store.js";
import {
  OrganizationOutboxUploader,
  type OrganizationIngestClient,
} from "../../src/product/federation/organization/outbox-uploader.js";
import {
  FederatedOutboxStore,
  type StoredFederatedOutboxEvent,
} from "../../src/product/federation/outbox-store.js";
import {
  federatedApprovalGroupDrafts,
  federationFixtureId,
} from "./fixtures/federated-records.js";

const PROVISIONED_AT = "2026-07-20T16:59:00.000Z";
const ENROLLED_AT = "2026-07-20T17:00:00.000Z";
const AFTER_REVOCATION = "2026-07-20T17:01:00.000Z";
const EXPIRES_AT = "2026-07-20T17:10:00.000Z";
const ORGANIZATION_ID = federationFixtureId("org", 1);
const AUTHORITY_ID = federationFixtureId("oau", 1);
const DIGEST_A = `sha256:${"a".repeat(64)}` as const;
const DIGEST_B = `sha256:${"b".repeat(64)}` as const;
const DIGEST_C = `sha256:${"c".repeat(64)}` as const;
const DECISION_ID = `decision:sha256:${"1".repeat(64)}`;
const ACTION_ID = `action:sha256:${"2".repeat(64)}`;

const MEMBER_IDS = {
  owner: {
    principal: federationFixtureId("prn", 1),
    membership: federationFixtureId("mem", 1),
    device: federationFixtureId("dev", 1),
    installation: federationFixtureId("ins", 1),
    manifest: federationFixtureId("idm", 1),
    policy: federationFixtureId("pol", 1),
  },
  employee: {
    principal: federationFixtureId("prn", 2),
    membership: federationFixtureId("mem", 2),
    device: federationFixtureId("dev", 2),
    installation: federationFixtureId("ins", 2),
    manifest: federationFixtureId("idm", 2),
    policy: federationFixtureId("pol", 2),
  },
} as const;

const publication: PublicationSnapshotV1 = {
  payload_scope:
    "approved-signal-with-meeting-context-brief-digest-and-bounded-evidence",
  audience: {
    scope: "organization",
    subjects: [{ kind: "organization", id: ORGANIZATION_ID }],
  },
  sensitivity: "internal",
  retention: { kind: "indefinite" },
  raw_meeting_content: "local-only",
  participant_observations: "included-namespaced",
};

type DevelopmentMemberSigner = FileInstallationSigner & {
  readonly descriptor: InstallationKeyDescriptor;
};

interface EnrolledMember {
  ids: (typeof MEMBER_IDS)[keyof typeof MEMBER_IDS];
  displayName: string;
  signer: DevelopmentMemberSigner;
  plan: AuthorityMemberJoinPlan;
  receipt: OrganizationEnrollmentReceiptV1;
  sync: OrganizationSyncStore;
  outbox: FederatedOutboxStore;
  client: LoopbackAuthorityClient;
  uploader: OrganizationOutboxUploader;
}

const resources: { close(): Promise<void> }[] = [];
const temporaryRoots: string[] = [];

function track<T extends { close(): Promise<void> }>(resource: T): T {
  resources.push(resource);
  return resource;
}

class LoopbackAuthorityClient implements OrganizationIngestClient {
  readonly batches: Parameters<OrganizationIngestClient["upload"]>[0][] = [];

  constructor(private readonly authority: OrganizationAuthorityStore) {}

  async upload(
    batch: Parameters<OrganizationIngestClient["upload"]>[0],
    options: { signal: AbortSignal },
  ): Promise<readonly string[]> {
    options.signal.throwIfAborted();
    this.batches.push(structuredClone(batch));
    const receipts = await this.authority.ingestBatch(batch);
    options.signal.throwIfAborted();
    return receipts.map((receipt) => canonicalJson(receipt));
  }
}

function signerDirectory(label: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `echo-n2-${label}-`)));
  temporaryRoots.push(root);
  return join(root, "keys");
}

async function memberSigner(
  installationId: string,
): Promise<DevelopmentMemberSigner> {
  const signer = new FileInstallationSigner(
    signerDirectory(installationId.slice(0, 3)),
  );
  const descriptor = await signer.generate(installationId);
  return Object.assign(signer, { descriptor });
}

afterEach(async () => {
  for (const resource of resources.splice(0).reverse()) {
    await resource.close();
  }
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

async function enrollMember(input: {
  store: OrganizationAuthorityStore;
  authorityDescriptor: OrganizationAuthorityDescriptorV1;
  membershipType: "owner" | "employee";
  displayName: string;
  ids: EnrolledMember["ids"];
}): Promise<EnrolledMember> {
  const signer = await memberSigner(input.ids.installation);
  const plan = await buildAuthorityMemberJoinPlan({
    authority_identity: {
      organization: {
        organization_id: ORGANIZATION_ID,
        display_name: "EchoBrain",
        created_at: PROVISIONED_AT,
      },
      principal: {
        principal_id: input.ids.principal,
        organization_id: ORGANIZATION_ID,
        kind: "human",
        display_name: input.displayName,
      },
      membership: {
        membership_id: input.ids.membership,
        organization_id: ORGANIZATION_ID,
        principal_id: input.ids.principal,
        type: input.membershipType,
        status: "active",
        valid_from: PROVISIONED_AT,
      },
    },
    local_identity: {
      device_id: input.ids.device,
      installation_id: input.ids.installation,
      manifest_id: input.ids.manifest,
      policy_id: input.ids.policy,
      device_class: "byod",
      created_at: ENROLLED_AT,
    },
    publication,
    build_identity: {
      schema_version: 1,
      kind: "echo-packaged-build-identity",
      product_version: "0.1.0-dev.6",
      source_sha: "a".repeat(40),
      source_kind: "materialized-commit",
    },
    signer,
  });
  const grant = await input.store.issueEnrollmentGrant(input.ids.membership, {
    expires_at: EXPIRES_AT,
  });
  const challenge = await input.store.issueEnrollmentChallenge({
    manifest: plan.identity_manifest,
    publication_policy: plan.publication_policy,
    enrollment_grant: grant.enrollment_grant,
    expires_at: EXPIRES_AT,
  });
  const proof = await createOrganizationEnrollmentProof({
    challenge,
    authority: input.authorityDescriptor,
    manifest: plan.identity_manifest,
    publication_policy: plan.publication_policy,
    signer,
    now: ENROLLED_AT,
  });
  const receipt = await input.store.completeEnrollment({
    challenge,
    proof,
    manifest: plan.identity_manifest,
  });
  const sync = track(
    new OrganizationSyncStore(":memory:", input.authorityDescriptor),
  );
  await sync.storeEnrollmentReceipt(canonicalJson(receipt));
  const outbox = track(new FederatedOutboxStore(":memory:"));
  const client = new LoopbackAuthorityClient(input.store);
  const uploader = track(
    new OrganizationOutboxUploader({
      installation_id: input.ids.installation,
      outbox,
      sync,
      client,
    }),
  );
  return {
    ids: input.ids,
    displayName: input.displayName,
    signer,
    plan,
    receipt,
    sync,
    outbox,
    client,
    uploader,
  };
}

function membershipAssertion(
  member: EnrolledMember,
): NativeProducerV1["membership_assertion"] {
  return member.plan.identity_manifest.authority.kind ===
    "local-founder-bootstrap"
    ? {
        status: "active",
        authority: "local-founder-bootstrap",
        assurance: "founder_attested",
      }
    : {
        status: "active",
        authority: "organization-authority-enrollment",
        assurance: "authority_preprovisioned",
      };
}

async function approvalGroup(input: {
  member: EnrolledMember;
  approvalId: string;
  idOffset: number;
  occurredAt: string;
}): Promise<readonly StoredFederatedOutboxEvent[]> {
  const manifest = input.member.plan.identity_manifest;
  const policy = input.member.plan.publication_policy;
  const drafts = federatedApprovalGroupDrafts({
    signer: input.member.signer,
    occurredAt: input.occurredAt,
    approvalId: input.approvalId,
    decisionId: DECISION_ID,
    actionId: ACTION_ID,
    digests: { a: DIGEST_A, b: DIGEST_B, c: DIGEST_C },
    organizationId: ORGANIZATION_ID,
    principalId: input.member.ids.principal,
    membershipId: input.member.ids.membership,
    manifestId: input.member.ids.manifest,
    manifestSha256: canonicalSha256(manifest),
    policy: {
      policyId: policy.policy_id,
      version: policy.version,
      sha256: canonicalSha256(policy),
      identityManifestId: policy.identity_manifest_id,
      signerInstallationId: policy.issued_by.installation_id,
      signerKeyId: policy.issued_by.key_id,
      publication: policy.publication,
    },
    productVersion: "0.1.0-dev.7",
    idOffset: input.idOffset,
    meetingId: `meeting-${input.approvalId}`,
    briefId: `brief-${input.approvalId}`,
    decisionText: `${input.member.displayName} approved a decision.`,
    actionText: `${input.member.displayName} approved an action.`,
    approvalReason: `${input.member.displayName} approved.`,
    membershipAssertion: membershipAssertion(input.member),
  });
  return input.member.outbox.appendApprovalGroup({
    installation_id: input.member.ids.installation,
    key_id: input.member.signer.descriptor.key_id,
    created_at: input.occurredAt,
    signer: input.member.signer,
    events: drafts,
  });
}

describe("N=2 organization graduation", () => {
  it("revokes owner installation A while employee installation B keeps advancing", async () => {
    const authoritySigner = await FileOrganizationAuthoritySigner.open({
      directory: signerDirectory("authority"),
      authorityId: AUTHORITY_ID,
      organizationId: ORGANIZATION_ID,
    });
    const authorityDescriptor = await authoritySigner.inspect();
    const clock = { value: ENROLLED_AT };
    const store = track(
      new OrganizationAuthorityStore({
        databasePath: ":memory:",
        signer: authoritySigner,
        now: () => clock.value,
      }),
    );

    await store.provisionOrganization({
      organization_id: ORGANIZATION_ID,
      display_name: "EchoBrain",
      principal_id: MEMBER_IDS.owner.principal,
      principal_display_name: "Founder",
      membership_id: MEMBER_IDS.owner.membership,
      provisioned_at: PROVISIONED_AT,
    });
    await store.provisionMembership({
      principal_id: MEMBER_IDS.employee.principal,
      principal_display_name: "Teammate",
      membership_id: MEMBER_IDS.employee.membership,
      membership_type: "employee",
      provisioned_at: PROVISIONED_AT,
    });

    const owner = await enrollMember({
      store,
      authorityDescriptor,
      membershipType: "owner",
      displayName: "Founder",
      ids: MEMBER_IDS.owner,
    });
    const employee = await enrollMember({
      store,
      authorityDescriptor,
      membershipType: "employee",
      displayName: "Teammate",
      ids: MEMBER_IDS.employee,
    });
    expect(owner.receipt.status).toBe("enrolled");
    expect(employee.receipt.status).toBe("enrolled");
    expect(owner.signer.descriptor.key_id).not.toBe(
      employee.signer.descriptor.key_id,
    );

    const ownerFirst = await approvalGroup({
      member: owner,
      approvalId: "owner-first",
      idOffset: 0,
      occurredAt: ENROLLED_AT,
    });
    const employeeFirst = await approvalGroup({
      member: employee,
      approvalId: "employee-first",
      idOffset: 100,
      occurredAt: ENROLLED_AT,
    });
    await expect(owner.uploader.uploadPending()).resolves.toMatchObject({
      status: "accepted",
      attempted_events: 2,
      acknowledged_sequence: 2,
      acknowledged_event_hash: ownerFirst[1]!.event_hash,
    });
    await expect(employee.uploader.uploadPending()).resolves.toMatchObject({
      status: "accepted",
      attempted_events: 2,
      acknowledged_sequence: 2,
      acknowledged_event_hash: employeeFirst[1]!.event_hash,
    });
    expect(owner.client.batches).toHaveLength(1);
    expect(employee.client.batches).toHaveLength(1);

    const ownerHead = ownerFirst[1]!.event_hash;
    const ownerNext = await approvalGroup({
      member: owner,
      approvalId: "owner-after-revocation",
      idOffset: 200,
      occurredAt: AFTER_REVOCATION,
    });
    const employeeNext = await approvalGroup({
      member: employee,
      approvalId: "employee-after-owner-revocation",
      idOffset: 300,
      occurredAt: AFTER_REVOCATION,
    });
    expect(ownerNext.map(({ sequence }) => sequence)).toEqual([3, 4]);

    clock.value = AFTER_REVOCATION;
    await store.revokeInstallation(owner.ids.installation, {
      reason: "N=2 revocation check",
    });
    await expect(owner.uploader.uploadPending()).resolves.toMatchObject({
      status: "rejected",
      attempted_events: 2,
      acknowledged_sequence: 2,
      acknowledged_event_hash: ownerHead,
    });
    expect(await owner.uploader.inspect()).toMatchObject({
      acknowledged_sequence: 2,
      acknowledged_event_hash: ownerHead,
      terminal_status: "rejected",
    });
    expect(
      (await owner.sync.inspectIngestReceipts(owner.ids.installation))
        .slice(-2)
        .map(({ receipt }) => ({
          status: receipt.status,
          reason: receipt.reason,
        })),
    ).toEqual([
      { status: "rejected", reason: "installation_revoked" },
      { status: "rejected", reason: "installation_revoked" },
    ]);
    await expect(owner.uploader.uploadPending()).resolves.toEqual({
      status: "rejected",
      attempted_events: 0,
      acknowledged_sequence: 2,
      acknowledged_event_hash: ownerHead,
      batch_sha256: null,
    });
    expect(owner.client.batches).toHaveLength(2);

    await expect(employee.uploader.uploadPending()).resolves.toMatchObject({
      status: "accepted",
      attempted_events: 2,
      acknowledged_sequence: 4,
      acknowledged_event_hash: employeeNext[1]!.event_hash,
    });
    expect(await employee.uploader.inspect()).toMatchObject({
      acknowledged_sequence: 4,
      acknowledged_event_hash: employeeNext[1]!.event_hash,
      terminal_status: "active",
    });
    expect(owner.client.batches).toHaveLength(2);
    expect(employee.client.batches).toHaveLength(2);
    expect(
      await store.inspectInstallation(owner.ids.installation),
    ).toMatchObject({
      status: "revoked",
      last_sequence: 2,
      last_event_hash: ownerHead,
    });
    expect(
      await store.inspectInstallation(employee.ids.installation),
    ).toMatchObject({
      status: "active",
      last_sequence: 4,
      last_event_hash: employeeNext[1]!.event_hash,
    });
    expect((await store.counts()).accepted_events).toBe(6);
  });
});
