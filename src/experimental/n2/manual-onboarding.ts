#!/usr/bin/env node

import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { atomicCreate } from "../../infrastructure/filesystem/atomic-create.js";
import { addUtcMilliseconds } from "../../util/timestamp.js";
import type { DecisionNodeState } from "../../product/approval/decision-node.js";
import { resolveProductClock } from "../../product/composition.js";
import { buildAuthorityMemberJoinPlan } from "./member-join.js";
import { createOrganizationEnrollmentRequest } from "./authority/enrollment-request.js";
import { FileOrganizationAuthoritySigner } from "./authority/file-organization-authority-signer.js";
import { OrganizationAuthorityStore } from "./authority/organization-authority-store.js";
import {
  loadPackagedBuildIdentity,
  validatePackagedBuildIdentity,
} from "../../product/federation/build-identity.js";
import type {
  LocalIdentityManifestV1,
  MembershipIdentityV1,
  OrganizationIdentityV1,
  PrincipalIdentityV1,
  ProductArtifactIdentityV1,
  PublicationPolicyV1,
  PublicationSnapshotV1,
} from "../../product/federation/contracts.js";
import type {
  OrganizationAuthorityDescriptorV1,
  OrganizationBatchReceiptV1,
  OrganizationEnrollmentRequestV1,
  OrganizationEnrollmentReceiptV1,
  OrganizationIngestBatchV1,
} from "./contracts.js";
import {
  canonicalJson,
  canonicalSha256,
  parseCanonicalJson,
} from "../../product/federation/foundation/canonical-json.js";
import { FileInstallationSigner } from "./file-installation-signer.js";
import { federationId } from "../../product/federation/foundation/identifiers.js";
import { OrganizationSyncStore } from "./organization/organization-sync-store.js";
import { FederatedOutboxStore } from "../../product/federation/outbox-store.js";
import {
  buildProjectionSignalManifest,
  buildRecordProjectionDrafts,
  orderedProjectionItems,
} from "../../product/federation/records/record-projection-drafts.js";
import type { FederatedProjectionSnapshots } from "../../product/federation/records/record-projection-snapshots.js";
import { validateN2Document } from "./schema-validation.js";

type Args = Record<string, string | boolean | undefined>;
type MembershipType = "owner" | "employee";

interface AuthorityState {
  schema_version: 1;
  kind: "echo-manual-n2-authority-state";
  authority_id: string;
  organization: OrganizationIdentityV1;
  owner_principal: PrincipalIdentityV1;
  owner_membership: MembershipIdentityV1 & { type: "owner" };
}

interface Invite {
  schema_version: 1;
  kind: "echo-manual-n2-invite";
  experimental: true;
  independent_copies_remain_authoritative: true;
  authority: OrganizationAuthorityDescriptorV1;
  organization: OrganizationIdentityV1;
  principal: PrincipalIdentityV1;
  membership: MembershipIdentityV1 & { type: MembershipType };
  enrollment_grant: string;
  issued_at: string;
  expires_at: string;
}

interface JoinRequest {
  schema_version: 1;
  kind: "echo-manual-n2-join-request";
  experimental: true;
  invite: Invite;
  identity_manifest: LocalIdentityManifestV1;
  publication_policy: PublicationPolicyV1;
  enrollment_request: OrganizationEnrollmentRequestV1;
}

interface MemberBundle {
  schema_version: 1;
  kind: "echo-manual-n2-member-bundle";
  experimental: true;
  authority: OrganizationAuthorityDescriptorV1;
  identity_manifest: LocalIdentityManifestV1;
  publication_policy: PublicationPolicyV1;
  enrollment_receipt: OrganizationEnrollmentReceiptV1;
}

interface ManualIngestResponse {
  schema_version: 1;
  kind: "echo-manual-n2-ingest-response";
  experimental: true;
  batch: OrganizationIngestBatchV1;
  receipt: OrganizationBatchReceiptV1;
}

const STATE_FILE = "authority-state.v1.json";
const AUTHORITY_DB = "n2-authority.sqlite";
const AUTHORITY_KEYS = "authority-keys";
const INSTALLATION_KEYS = "installation-keys";
const SYNC_DB = "n2-sync.sqlite";
const OUTBOX_DB = "outbox.sqlite";
const MEMBER_FILE = "member-bundle.v1.json";
const clock = resolveProductClock();

function need(args: Args, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`--${name} is required`);
  }
  return value;
}

function privateDirectory(path: string): string {
  const absolute = resolve(path);
  mkdirSync(absolute, { recursive: true, mode: 0o700 });
  chmodSync(absolute, 0o700);
  return absolute;
}

function readCanonical<T>(path: string): T {
  return parseCanonicalJson(
    readFileSync(resolve(path), "utf8"),
  ) as unknown as T;
}

function writeCanonical(path: string, value: unknown): void {
  const absolute = resolve(path);
  mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
  if (
    !atomicCreate({
      filePath: absolute,
      content: canonicalJson(value),
      mode: 0o600,
    })
  ) {
    throw new Error(`${absolute} already exists`);
  }
}

function utcNow(): string {
  return clock();
}

function expiresIn(milliseconds: number): string {
  return addUtcMilliseconds(utcNow(), milliseconds);
}

function publication(organizationId: string): PublicationSnapshotV1 {
  return {
    payload_scope:
      "approved-signal-with-meeting-context-brief-digest-and-bounded-evidence",
    audience: {
      scope: "organization",
      subjects: [{ kind: "organization", id: organizationId }],
    },
    sensitivity: "internal",
    retention: { kind: "indefinite" },
    raw_meeting_content: "local-only",
    participant_observations: "included-namespaced",
  };
}

function readMemberBundle(directory: string): MemberBundle {
  return readCanonical<MemberBundle>(join(directory, MEMBER_FILE));
}

function manualPilotDrafts(
  bundle: MemberBundle,
  text: string,
  occurredAt: string,
) {
  const manifest = bundle.identity_manifest;
  const policy = bundle.publication_policy;
  const identityManifestSha256 = canonicalSha256(manifest);
  const seed = federationId("evt");
  const approvalId = canonicalSha256({
    domain: "echo.synthetic-manual-n2-approval.v1",
    installation_id: manifest.installation.installation_id,
    seed,
  }).slice("sha256:".length);
  const meetingId = `synthetic-manual-n2-${approvalId.slice(0, 16)}`;
  const signal = {
    id: `decision:${canonicalSha256({
      domain: "echo.synthetic-manual-n2-signal.v1",
      approval_id: approvalId,
      text,
    })}`,
    kind: "decision" as const,
    text: `[synthetic manual N=2 pilot] ${text}`,
    subject: null,
    confidence: null,
    evidence: [
      {
        meeting_id: meetingId,
        block_id: "synthetic-manual-input",
        quote: text,
      },
    ],
    status: "decided" as const,
  };
  const processor = {
    kind: "decision-processor" as const,
    adapter_id: "manual-pilot",
    instance_id: "local",
    version: "experimental-1",
  };
  const state: DecisionNodeState = {
    approval_id: approvalId,
    node_id: `synthetic-manual-node-${approvalId.slice(0, 16)}`,
    processing_key: `synthetic-manual-processing-${approvalId}`,
    requested_at: occurredAt,
    requested_metadata: { experimental_manual_n2_pilot: true },
    brief: {
      schema_version: 1,
      id: `synthetic-manual-brief-${approvalId.slice(0, 16)}`,
      meeting: {
        id: meetingId,
        title: "Synthetic manual N=2 pilot",
        participants: [],
      },
      decisions: [signal],
      actions: [],
      rationales: [],
      provenance: {
        meeting_revision: "synthetic-manual-1",
        processor,
        generated_at: occurredAt,
      },
    },
    alternatives: [],
    links: { parent: null, supersedes: null },
    status: "approved",
    reviewed_at: occurredAt,
    reviewed_by: manifest.principal.display_name,
    reason: "Synthetic manual N=2 pilot approval.",
    resolved_surface: "cli",
    resolved_metadata: { experimental_manual_n2_pilot: true },
    published: [],
  };
  const artifact: ProductArtifactIdentityV1 = {
    product_version: manifest.installation.product.version,
    source_sha: manifest.installation.product.source_sha,
    artifact_sha256: canonicalSha256({
      domain: "echo.synthetic-manual-n2-artifact.v1",
      product: manifest.installation.product,
    }),
  };
  const sourceConfiguration = { mode: "synthetic-manual-n2-pilot" };
  const processorConfiguration = { mode: "synthetic-manual-n2-pilot" };
  const approvedBriefSha256 = canonicalSha256(state.brief);
  const snapshots: FederatedProjectionSnapshots = {
    source: {
      identity_manifest_id: manifest.manifest_id,
      identity_manifest_sha256: identityManifestSha256,
      binding: {
        adapter_binding_id: federationId("bnd"),
        adapter: {
          kind: "meeting-source",
          adapter_id: "manual-pilot",
          instance_id: "local",
          version: "experimental-1",
        },
        configuration_snapshot: sourceConfiguration,
        configuration_sha256: canonicalSha256(sourceConfiguration),
      },
      connection: {
        connection_id: federationId("con"),
        generation: 1,
        owner: { kind: "membership", id: manifest.membership.membership_id },
        provider_identity: {
          provider: "manual-pilot",
          tenant: null,
          subject: null,
          verification_method: "operator_attestation",
          assurance: "operator_attested",
        },
      },
      meeting: {
        external_id: meetingId,
        revision: "synthetic-manual-1",
        source_observation_id: federationId("obs"),
        document_sha256: canonicalSha256({ text }),
      },
      participant_observations: [],
      attribution_sha256: canonicalSha256({
        domain: "echo.synthetic-manual-n2-source.v1",
        meeting_id: meetingId,
      }),
      observed_by: artifact,
    },
    processor: {
      identity_manifest_id: manifest.manifest_id,
      identity_manifest_sha256: identityManifestSha256,
      adapter_binding_id: federationId("bnd"),
      adapter: processor,
      configuration_snapshot: processorConfiguration,
      configuration_sha256: canonicalSha256(processorConfiguration),
      attribution_sha256: canonicalSha256({
        domain: "echo.synthetic-manual-n2-processor.v1",
        approval_id: approvalId,
      }),
      decision_set_sha256: canonicalSha256({ signal }),
      generated_at: occurredAt,
      produced_by: artifact,
    },
    approval: {
      surface: null,
      approver: {
        principal_id: manifest.principal.principal_id,
        membership_id: manifest.membership.membership_id,
        claim_id: null,
      },
      raw_actor_assertion: {
        surface: "cli",
        installation_id: manifest.installation.installation_id,
        reviewer_label: manifest.principal.display_name,
        command: "approve",
        observed_at: occurredAt,
      },
      assurance: "installation_holder_self_attested",
      reviewed_at: occurredAt,
      reason: state.reason,
      approved_brief_sha256: approvedBriefSha256,
      approved_context_sha256: canonicalSha256({
        domain: "echo.synthetic-manual-n2-approved-context.v1",
        approval_id: approvalId,
      }),
      observed_by: artifact,
    },
  };
  const items = orderedProjectionItems(state);
  return buildRecordProjectionDrafts({
    state,
    items,
    manifest,
    identityManifestSha256,
    projectionArtifact: artifact,
    metadata: {
      publication: {
        policy_id: policy.policy_id,
        version: policy.version,
        policy_sha256: canonicalSha256(policy),
        identity_manifest_id: policy.identity_manifest_id,
        signer_installation_id: policy.issued_by.installation_id,
        signer_key_id: policy.issued_by.key_id,
        ...policy.publication,
      },
    },
    snapshots,
    approvedBriefSha256,
    signalManifest: buildProjectionSignalManifest(items),
  });
}

async function openAuthority(directory: string) {
  const state = readCanonical<AuthorityState>(join(directory, STATE_FILE));
  const signer = await FileOrganizationAuthoritySigner.open({
    directory: join(directory, AUTHORITY_KEYS),
    authorityId: state.authority_id,
    organizationId: state.organization.organization_id,
  });
  return {
    state,
    descriptor: await signer.inspect(),
    store: new OrganizationAuthorityStore({
      databasePath: join(directory, AUTHORITY_DB),
      signer,
    }),
  };
}

async function authorityInit(args: Args) {
  const directory = privateDirectory(need(args, "state"));
  const statePath = join(directory, STATE_FILE);
  let state: AuthorityState;
  if (existsSync(statePath)) {
    state = readCanonical<AuthorityState>(statePath);
  } else {
    const createdAt = utcNow();
    const organizationId = federationId("org");
    const principalId = federationId("prn");
    state = {
      schema_version: 1,
      kind: "echo-manual-n2-authority-state",
      authority_id: federationId("oau"),
      organization: {
        organization_id: organizationId,
        display_name: need(args, "organization-name"),
        created_at: createdAt,
      },
      owner_principal: {
        principal_id: principalId,
        organization_id: organizationId,
        kind: "human",
        display_name: need(args, "owner-name"),
      },
      owner_membership: {
        membership_id: federationId("mem"),
        organization_id: organizationId,
        principal_id: principalId,
        type: "owner",
        status: "active",
        valid_from: createdAt,
      },
    };
    writeCanonical(statePath, state);
  }
  const authority = await openAuthority(directory);
  try {
    await authority.store.provisionOrganization({
      organization_id: state.organization.organization_id,
      display_name: state.organization.display_name,
      principal_id: state.owner_principal.principal_id,
      principal_display_name: state.owner_principal.display_name,
      membership_id: state.owner_membership.membership_id,
      provisioned_at: state.owner_membership.valid_from,
    });
    return {
      authority_id: state.authority_id,
      authority_key_id: authority.descriptor.signing_key.key_id,
      organization_id: state.organization.organization_id,
      owner_membership_id: state.owner_membership.membership_id,
    };
  } finally {
    await authority.store.close();
  }
}

async function inviteCreate(args: Args) {
  const directory = privateDirectory(need(args, "state"));
  const authority = await openAuthority(directory);
  try {
    const membershipType = (args["membership-type"] ??
      "employee") as MembershipType;
    let principal = authority.state.owner_principal;
    let membership: MembershipIdentityV1 & { type: MembershipType } =
      authority.state.owner_membership;
    if (membershipType === "employee") {
      const createdAt = utcNow();
      const principalId = federationId("prn");
      const membershipId = federationId("mem");
      principal = {
        principal_id: principalId,
        organization_id: authority.state.organization.organization_id,
        kind: "human",
        display_name: need(args, "name"),
      };
      membership = {
        membership_id: membershipId,
        organization_id: authority.state.organization.organization_id,
        principal_id: principalId,
        type: "employee",
        status: "active",
        valid_from: createdAt,
      };
      await authority.store.provisionMembership({
        principal_id: principalId,
        principal_display_name: principal.display_name,
        membership_id: membershipId,
        membership_type: "employee",
        provisioned_at: createdAt,
      });
    } else if (membershipType !== "owner") {
      throw new Error("--membership-type must be owner or employee");
    }
    const grant = await authority.store.issueEnrollmentGrant(
      membership.membership_id,
      { expires_at: (args["expires-at"] as string) ?? expiresIn(86_400_000) },
    );
    const invite: Invite = {
      schema_version: 1,
      kind: "echo-manual-n2-invite",
      experimental: true,
      independent_copies_remain_authoritative: true,
      authority: authority.descriptor,
      organization: authority.state.organization,
      principal,
      membership,
      enrollment_grant: grant.enrollment_grant,
      issued_at: grant.issued_at,
      expires_at: grant.expires_at,
    };
    writeCanonical(need(args, "out"), invite);
    return {
      membership_id: membership.membership_id,
      membership_type: membership.type,
      invite_sha256: canonicalSha256(invite),
      expires_at: invite.expires_at,
    };
  } finally {
    await authority.store.close();
  }
}

async function joinPrepare(args: Args) {
  const invite = readCanonical<Invite>(need(args, "invite"));
  const directory = privateDirectory(need(args, "state"));
  const buildPath = args["build-identity"];
  const build =
    typeof buildPath === "string"
      ? validatePackagedBuildIdentity(
          JSON.parse(readFileSync(resolve(buildPath), "utf8")),
        )
      : loadPackagedBuildIdentity();
  const createdAt = utcNow();
  const signer = new FileInstallationSigner(join(directory, INSTALLATION_KEYS));
  const plan = await buildAuthorityMemberJoinPlan({
    authority_identity: {
      organization: invite.organization,
      principal: invite.principal,
      membership: invite.membership,
    },
    local_identity: {
      device_id: federationId("dev"),
      installation_id: federationId("ins"),
      manifest_id: federationId("idm"),
      policy_id: federationId("pol"),
      device_class: args["device-class"] === "managed" ? "managed" : "byod",
      created_at: createdAt,
    },
    publication: publication(invite.organization.organization_id),
    build_identity: build,
    signer,
  });
  const enrollmentRequest = await createOrganizationEnrollmentRequest({
    authority: invite.authority,
    manifest: plan.identity_manifest,
    publication_policy: plan.publication_policy,
    enrollment_grant: invite.enrollment_grant,
    signer,
  });
  const request: JoinRequest = {
    schema_version: 1,
    kind: "echo-manual-n2-join-request",
    experimental: true,
    invite,
    identity_manifest: plan.identity_manifest,
    publication_policy: plan.publication_policy,
    enrollment_request: enrollmentRequest,
  };
  writeCanonical(need(args, "out"), request);
  return {
    membership_id: invite.membership.membership_id,
    installation_id: plan.identity_manifest.installation.installation_id,
    installation_key_id: plan.signing_key.key_id,
    request_sha256: canonicalSha256(enrollmentRequest),
  };
}

async function enrollmentComplete(args: Args) {
  const directory = privateDirectory(need(args, "state"));
  const request = readCanonical<JoinRequest>(need(args, "request"));
  const authority = await openAuthority(directory);
  try {
    const receipt = await authority.store.completeEnrollment({
      enrollment_request: request.enrollment_request,
      enrollment_grant: request.invite.enrollment_grant,
      manifest: request.identity_manifest,
      publication_policy: request.publication_policy,
    });
    writeCanonical(need(args, "out"), receipt);
    return {
      enrollment_id: receipt.enrollment_id,
      membership_id: receipt.membership_id,
      installation_id: receipt.installation_id,
      receipt_sha256: canonicalSha256(receipt),
    };
  } finally {
    await authority.store.close();
  }
}
async function enrollmentAccept(args: Args) {
  const directory = privateDirectory(need(args, "state"));
  const request = readCanonical<JoinRequest>(need(args, "request"));
  const receipt = validateN2Document<OrganizationEnrollmentReceiptV1>(
    "organization-enrollment-receipt",
    readCanonical(need(args, "receipt")),
  );
  if (
    receipt.membership_id !==
      request.identity_manifest.membership.membership_id ||
    receipt.installation_id !==
      request.identity_manifest.installation.installation_id ||
    receipt.identity_manifest_sha256 !==
      canonicalSha256(request.identity_manifest) ||
    receipt.publication_policy_sha256 !==
      canonicalSha256(request.publication_policy)
  ) {
    throw new Error("enrollment receipt does not match the local join request");
  }
  const sync = new OrganizationSyncStore(
    join(directory, SYNC_DB),
    request.invite.authority,
  );
  try {
    const stored = await sync.storeEnrollmentReceipt(canonicalJson(receipt));
    writeCanonical(join(directory, MEMBER_FILE), {
      schema_version: 1,
      kind: "echo-manual-n2-member-bundle",
      experimental: true,
      authority: request.invite.authority,
      identity_manifest: request.identity_manifest,
      publication_policy: request.publication_policy,
      enrollment_receipt: receipt,
    } satisfies MemberBundle);
    return {
      enrollment_id: stored.receipt.enrollment_id,
      membership_id: stored.receipt.membership_id,
      installation_id: stored.receipt.installation_id,
      receipt_sha256: stored.sha256,
      independent_copies_remain_authoritative: true,
    };
  } finally {
    await sync.close();
  }
}

async function recordCreate(args: Args) {
  const directory = privateDirectory(need(args, "state"));
  const bundle = readMemberBundle(directory);
  const installation = bundle.identity_manifest.installation;
  const occurredAt = utcNow();
  const text =
    typeof args["text"] === "string" && args["text"].trim().length > 0
      ? args["text"]
      : "Prove the synthetic manual N=2 record path.";
  const outbox = new FederatedOutboxStore(join(directory, OUTBOX_DB));
  try {
    const stored = await outbox.appendApprovalGroup({
      installation_id: installation.installation_id,
      key_id: installation.signing_key.key_id,
      created_at: occurredAt,
      signer: new FileInstallationSigner(join(directory, INSTALLATION_KEYS)),
      events: manualPilotDrafts(bundle, text, occurredAt),
    });
    return {
      installation_id: installation.installation_id,
      approval_id: stored[0]!.envelope.local_reference.approval_id,
      event_count: stored.length,
      first_sequence: stored[0]!.sequence,
      last_sequence: stored.at(-1)!.sequence,
      last_event_hash: stored.at(-1)!.event_hash,
      synthetic_manual_pilot: true,
    };
  } finally {
    await outbox.close();
  }
}

async function batchCreate(args: Args) {
  const directory = privateDirectory(need(args, "state"));
  const bundle = readMemberBundle(directory);
  const installationId = bundle.identity_manifest.installation.installation_id;
  const outbox = new FederatedOutboxStore(join(directory, OUTBOX_DB));
  const sync = new OrganizationSyncStore(
    join(directory, SYNC_DB),
    bundle.authority,
  );
  try {
    const state = await sync.inspectState(installationId);
    if (state === null) throw new Error("local enrollment state is missing");
    const events = await outbox.readInstallationEvents(installationId);
    const pending = events.slice(state.acknowledged_sequence);
    if (pending.length === 0)
      throw new Error("no pending manual pilot records");
    const batch: OrganizationIngestBatchV1 = {
      schema_version: 1,
      kind: "echo-organization-ingest-batch",
      authority_id: bundle.authority.authority_id,
      organization_id: bundle.authority.organization_id,
      installation_id: installationId,
      enrollment_receipt_sha256: canonicalSha256(bundle.enrollment_receipt),
      events: pending.map(({ envelope_json: event }) => event),
    };
    writeCanonical(need(args, "out"), batch);
    return {
      installation_id: installationId,
      event_count: pending.length,
      first_sequence: pending[0]!.sequence,
      last_sequence: pending.at(-1)!.sequence,
      batch_sha256: canonicalSha256(batch),
    };
  } finally {
    await sync.close();
    await outbox.close();
  }
}

async function authorityIngest(args: Args) {
  const directory = privateDirectory(need(args, "state"));
  const batch = readCanonical<OrganizationIngestBatchV1>(need(args, "batch"));
  const authority = await openAuthority(directory);
  try {
    const receipt = await authority.store.ingestBatch(batch);
    const response: ManualIngestResponse = {
      schema_version: 1,
      kind: "echo-manual-n2-ingest-response",
      experimental: true,
      batch,
      receipt,
    };
    writeCanonical(need(args, "out"), response);
    return {
      installation_id: batch.installation_id,
      event_count: batch.events.length,
      status: receipt.status,
      response_sha256: canonicalSha256(response),
    };
  } finally {
    await authority.store.close();
  }
}

async function receiptAccept(args: Args) {
  const directory = privateDirectory(need(args, "state"));
  const bundle = readMemberBundle(directory);
  const response = readCanonical<ManualIngestResponse>(need(args, "response"));
  if (
    response.kind !== "echo-manual-n2-ingest-response" ||
    response.experimental !== true
  ) {
    throw new Error("manual ingest response is unsupported");
  }
  const sync = new OrganizationSyncStore(
    join(directory, SYNC_DB),
    bundle.authority,
  );
  try {
    const accepted = await sync.storeBatchReceipt(
      response.batch,
      canonicalJson(response.receipt),
    );
    const state = accepted.state;
    return {
      installation_id: state.installation_id,
      acknowledged_sequence: state.acknowledged_sequence,
      acknowledged_event_hash: state.acknowledged_event_hash,
      terminal_status: state.terminal_status,
    };
  } finally {
    await sync.close();
  }
}

async function authorityRevokeInstallation(args: Args) {
  const directory = privateDirectory(need(args, "state"));
  const authority = await openAuthority(directory);
  try {
    const installation = await authority.store.revokeInstallation(
      need(args, "installation-id"),
      {
        reason:
          typeof args["reason"] === "string"
            ? args["reason"]
            : "Manual N=2 pilot revocation.",
      },
    );
    return {
      installation_id: installation.installation_id,
      status: installation.status,
      revoked_at: installation.revoked_at,
    };
  } finally {
    await authority.store.close();
  }
}

export async function runManualN2Onboarding(argv: readonly string[]) {
  const parsed = parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: true,
    options: {
      state: { type: "string" },
      out: { type: "string" },
      invite: { type: "string" },
      request: { type: "string" },
      receipt: { type: "string" },
      batch: { type: "string" },
      response: { type: "string" },
      "organization-name": { type: "string" },
      "owner-name": { type: "string" },
      name: { type: "string" },
      "membership-type": { type: "string" },
      "expires-at": { type: "string" },
      "build-identity": { type: "string" },
      "device-class": { type: "string" },
      "installation-id": { type: "string" },
      text: { type: "string" },
      reason: { type: "string" },
    },
  });
  const args = parsed.values as Args;
  const handlers: Record<string, (values: Args) => Promise<object>> = {
    "authority-init": authorityInit,
    "invite-create": inviteCreate,
    "join-prepare": joinPrepare,
    "enrollment-complete": enrollmentComplete,
    "enrollment-accept": enrollmentAccept,
    "record-create": recordCreate,
    "batch-create": batchCreate,
    "authority-ingest": authorityIngest,
    "receipt-accept": receiptAccept,
    "authority-revoke-installation": authorityRevokeInstallation,
  };
  const command = parsed.positionals[0];
  const handler = command === undefined ? undefined : handlers[command];
  if (handler === undefined) throw new Error("unknown or missing command");
  return { ok: true, command, ...(await handler(args)) };
}

async function main(): Promise<void> {
  try {
    process.stdout.write(
      `${canonicalJson(await runManualN2Onboarding(process.argv.slice(2)))}\n`,
    );
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = 1;
  }
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  await main();
}
