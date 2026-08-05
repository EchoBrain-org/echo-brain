import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProductRuntimeConfig } from "../../../../src/product/config.js";
import type {
  AdapterBindingV1,
  LocalConnectionRegistryV1,
  LocalIdentityManifestV1,
  PublicationPolicyV1,
  PublicationSnapshotV1,
  ToolConnectionV1,
} from "../../../../src/product/federation/contracts.js";
import type { InstallationKeyDescriptor } from "../../../../src/product/federation/foundation/installation-signer.js";
import { canonicalSha256 } from "../../../../src/product/federation/foundation/canonical-json.js";

export type JsonRecord = Record<string, unknown>;

export const TEST_BUILD = {
  schema_version: 1,
  kind: "echo-packaged-build-identity",
  product_version: "0.1.0-dev.6",
  source_sha: "a".repeat(40),
  source_kind: "materialized-commit",
} as const;

export function createPrivateTestState(
  temporary: string[],
  prefix = "echo-founder-identity-",
): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(root);
  const state = join(realpathSync(root), "state");
  mkdirSync(state, { mode: 0o700 });
  chmodSync(state, 0o700);
  return state;
}

export function manualRuntimeConfig(stateDir: string): ProductRuntimeConfig {
  return {
    schema_version: 1,
    lane: "team-product",
    state_dir: stateDir,
    meeting_sources: [{
      adapter_id: "granola", instance_id: "primary",
      credential_ref: "file:/private/local/granola-api-key", settings: {},
    }],
    decision_processor: { adapter_id: "structured-text", instance_id: "primary", settings: {} },
    delivery_surfaces: [{ adapter_id: "jsonl-outbox", instance_id: "local", settings: {} }],
    approval_mode: "manual",
  };
}

function testPublication(
  organizationId: string,
): PublicationSnapshotV1 {
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

interface TestConnectionOptions {
  connectionId: string;
  organizationId: string;
  owner: ToolConnectionV1["owner"];
  provider: "slack" | "granola";
  activeAt: string;
  providerIdentity: ToolConnectionV1["generations"][number]["provider_identity"];
  credentialGuard: ToolConnectionV1["generations"][number]["local_credential_guard"];
}

function testConnection(options: TestConnectionOptions): ToolConnectionV1 {
  return {
    connection_id: options.connectionId,
    organization_id: options.organizationId,
    owner: options.owner,
    provider: options.provider,
    generations: [
      {
        generation: 1,
        active_from: options.activeAt,
        ended_at: null,
        provider_identity: options.providerIdentity,
        local_credential_guard: options.credentialGuard,
      },
    ],
  };
}

export function slackConnectionFixture(options: {
  connectionId: string;
  organizationId: string;
  owner?: ToolConnectionV1["owner"];
  activeAt: string;
  tenantId: string;
  credentialGuard: ToolConnectionV1["generations"][number]["local_credential_guard"];
  subject?: { id: string; bot_id: string; app_id: string };
  verifiedAt?: string;
  evidenceSha256?: `sha256:${string}`;
}): ToolConnectionV1 {
  const subject = options.subject ?? {
    id: `U_${options.tenantId}`,
    bot_id: `B_${options.tenantId}`,
    app_id: `A_${options.tenantId}`,
  };
  return testConnection({
    connectionId: options.connectionId,
    organizationId: options.organizationId,
    owner: options.owner ?? { kind: "organization", id: options.organizationId },
    provider: "slack",
    activeAt: options.activeAt,
    providerIdentity: {
      tenant: { kind: "slack-team", id: options.tenantId, enterprise_id: null },
      subject: { kind: "bot-installation", ...subject },
      verification: {
        method: "slack_auth_test",
        assurance: "provider_verified",
        verified_at: options.verifiedAt ?? options.activeAt,
        evidence_sha256: options.evidenceSha256 ?? `sha256:${"1".repeat(64)}`,
      },
    },
    credentialGuard: options.credentialGuard,
  });
}

export function testBinding(options: {
  adapterBindingId: string;
  capability: AdapterBindingV1["capability"];
  adapterId: string;
  instanceId: string;
  connectionId: string | null;
  createdAt: string;
  configuration?: AdapterBindingV1["configuration_snapshot"];
  status?: AdapterBindingV1["status"];
  endedAt?: string | null;
}): AdapterBindingV1 {
  const configuration = options.configuration ?? {};
  return {
    adapter_binding_id: options.adapterBindingId,
    capability: options.capability,
    adapter_id: options.adapterId,
    instance_id: options.instanceId,
    connection_id: options.connectionId,
    connection_generation: options.connectionId === null ? null : 1,
    configuration_snapshot: configuration,
    configuration_sha256: canonicalSha256(configuration),
    created_at: options.createdAt,
    ended_at: options.endedAt ?? null,
    status: options.status ?? "active",
  };
}

export function testManifest(options: {
  ids: {
    organization: string;
    principal: string;
    membership: string;
    device: string;
    installation: string;
    manifest: string;
    claim: string;
  };
  at: string;
  key: Omit<InstallationKeyDescriptor, "installation_id" | "private_key_exportable">;
  claimTenant?: string;
  claimSubject?: string;
  claimVerifiedAt?: string;
}): Omit<LocalIdentityManifestV1, "integrity"> {
  const { ids, at } = options;
  return {
    schema_version: 1,
    kind: "echo-local-identity-manifest",
    manifest_id: ids.manifest,
    predecessor_manifest_id: null,
    created_at: at,
    authority: { kind: "local-founder-bootstrap", assurance: "founder_attested" },
    organization: { organization_id: ids.organization, display_name: "EchoBrain", created_at: at },
    principal: {
      principal_id: ids.principal, organization_id: ids.organization,
      kind: "human", display_name: "Founder",
    },
    membership: {
      membership_id: ids.membership, organization_id: ids.organization,
      principal_id: ids.principal, type: "owner", status: "active", valid_from: at,
    },
    installation: {
      installation_id: ids.installation, organization_id: ids.organization,
      membership_id: ids.membership, device_id: ids.device,
      device_class: "byod", enrolled_at: at,
      product: { name: "echo-brain", version: TEST_BUILD.product_version, source_sha: TEST_BUILD.source_sha },
      signing_key: options.key,
    },
    identity_claims: [{
      claim_id: ids.claim, principal_id: ids.principal,
      issuer: { kind: "provider", provider: "slack", tenant_id: options.claimTenant ?? "T123" },
      subject: { kind: "user", id: options.claimSubject ?? "UFOUNDER" },
      verification: {
        method: "slack_dm_challenge", assurance: "provider_challenge_observed",
        verified_at: options.claimVerifiedAt ?? at, evidence_sha256: `sha256:${"1".repeat(64)}`,
      },
    }],
    legacy_cutover: {
      declared_at: at,
      pre_cutover_default: "disposable_test",
      native_records_require: [
        "source-attribution-v1",
        "processor-attribution-v1",
        "approval-context-v1",
        "signed-outbox-v1",
      ],
    },
  };
}

export function testPolicy(options: {
  policyId: string;
  organizationId: string;
  manifestId: string;
  installationId: string;
  keyId: `sha256:${string}`;
  effectiveAt: string;
}): Omit<PublicationPolicyV1, "integrity"> {
  return {
    schema_version: 1,
    kind: "echo-publication-policy",
    policy_id: options.policyId,
    organization_id: options.organizationId,
    identity_manifest_id: options.manifestId,
    issued_by: {
      installation_id: options.installationId,
      key_id: options.keyId,
    },
    version: 1,
    effective_at: options.effectiveAt,
    publication: testPublication(options.organizationId),
  };
}

export function testRegistry(options: {
  registryId: string;
  manifestId: string;
  updatedAt: string;
  connections: readonly ToolConnectionV1[];
  bindings: readonly AdapterBindingV1[];
}): Omit<LocalConnectionRegistryV1, "integrity"> {
  return {
    schema_version: 1,
    kind: "echo-local-connection-registry",
    registry_id: options.registryId,
    identity_manifest_id: options.manifestId,
    revision: 1,
    previous_registry_sha256: null,
    updated_at: options.updatedAt,
    connections: options.connections,
    bindings: options.bindings,
  };
}

export const EXACT_SESSION_AT = "2026-07-19T23:00:00.000Z";
/** Inside the 15-minute Slack DM challenge lifetime the ticket enforces. */
export const EXACT_SESSION_EXPIRES_AT = "2026-07-19T23:05:00.000Z";
export const EXACT_SESSION_DIGEST = `sha256:${"a".repeat(64)}`;
export const EXACT_SESSION_IDS = {
  organization_id: "org_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  principal_id: "prn_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  membership_id: "mem_cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  device_id: "dev_dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  installation_id: "ins_eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  manifest_id: "idm_11111111-1111-4111-8111-111111111111",
  registry_id: "reg_22222222-2222-4222-8222-222222222222",
  policy_id: "pol_33333333-3333-4333-8333-333333333333",
} as const;

function exactCredentialGuard(reference: string): JsonRecord {
  return {
    reference,
    algorithm: "sha256-salted",
    // 17 bytes: the credential guard requires a 16-64 byte salt, so this stays
    // long enough for full validation, not only the exact-key shape check.
    salt_base64: "ZWNoby1mb3VuZGVyLXNhbHQ=",
    digest: EXACT_SESSION_DIGEST,
    exportable: false,
  };
}

function exactProviderIdentity(provider: "slack" | "granola"): JsonRecord {
  return provider === "slack"
    ? {
        tenant: { kind: "slack-team", id: "T123TEAM", enterprise_id: null },
        subject: {
          kind: "bot-installation",
          id: "U123BOT",
          bot_id: "B123BOT",
          app_id: "A123APP",
        },
        verification: {
          method: "slack_auth_test",
          assurance: "provider_verified",
          verified_at: EXACT_SESSION_AT,
          evidence_sha256: EXACT_SESSION_DIGEST,
        },
      }
    : {
        tenant: null,
        subject: null,
        verification: {
          method: "provider_first_capture",
          assurance: "credential_observed",
          verified_at: EXACT_SESSION_AT,
          evidence_sha256: EXACT_SESSION_DIGEST,
        },
      };
}

export function exactSessionBindings(at = EXACT_SESSION_AT): JsonRecord[] {
  const items = [
    // The Granola meeting source must bind the Granola connection seed
    // (con_2222...); the Slack seed (con_1111...) belongs to the Slack surfaces.
    ["11111111-1111-4111-8111-111111111111", "meeting-source", "granola", "primary", "con_22222222-2222-4222-8222-222222222222", { base_url: "https://api.granola.test/v1", request_timeout_ms: 15_000, page_size: 1, cursor_overlap_ms: 0 }],
    ["22222222-2222-4222-8222-222222222222", "decision-processor", "structured-text", "primary", null, {}],
    ["33333333-3333-4333-8333-333333333333", "delivery-surface", "slack", "team-decisions", "con_11111111-1111-4111-8111-111111111111", { channel_id: "C123DECISIONS", request_timeout_ms: 60_000 }],
    ["44444444-4444-4444-8444-444444444444", "approval-surface", "slack-reactions", "founder-approval", "con_11111111-1111-4111-8111-111111111111", { channel_id: "C123APPROVALS", reviewer: { slack_user_id: "U123FOUNDER", name: "Founder" }, approve_reaction: "white_check_mark", reject_reaction: "x", request_timeout_ms: 60_000 }],
  ] as const;
  return items.map(([id, capability, adapter, instance, connection, settings]) => ({
    adapter_binding_id: `bnd_${id}`,
    capability,
    adapter_id: adapter,
    instance_id: instance,
    connection_id: connection,
    connection_generation: connection === null ? null : 1,
    configuration_snapshot: settings,
    // Derived, not pinned: full session validation recomputes this digest from
    // the snapshot, and the exact-shape contract only constrains the keys.
    configuration_sha256: canonicalSha256(settings),
    created_at: at,
    ended_at: null,
    status: "active",
  }));
}

function exactSigningKey(): JsonRecord {
  return {
    installation_id: EXACT_SESSION_IDS.installation_id,
    key_id: EXACT_SESSION_DIGEST,
    algorithm: "ecdsa-p256-sha256-der-low-s",
    public_key_spki_der_base64: "cHVibGljLWtleQ==",
    protection: "secure-enclave",
    assurance: "hardware_bound",
    private_key_exportable: false,
  };
}

function exactClaim(): JsonRecord {
  return {
    issuer: { kind: "provider", provider: "slack", tenant_id: "T123TEAM" },
    subject: { kind: "user", id: "U123FOUNDER" },
    verification: {
      method: "slack_dm_challenge",
      assurance: "provider_challenge_observed",
      verified_at: EXACT_SESSION_AT,
      evidence_sha256: EXACT_SESSION_DIGEST,
    },
  };
}

function exactPublication(): JsonRecord {
  return testPublication(EXACT_SESSION_IDS.organization_id) as unknown as JsonRecord;
}

function exactPlan(): JsonRecord {
  const bindings = exactSessionBindings();
  return {
    ids: { ...EXACT_SESSION_IDS },
    expected_signing_key: exactSigningKey(),
    manifest: {
      schema_version: 1,
      kind: "echo-local-identity-manifest",
      manifest_id: EXACT_SESSION_IDS.manifest_id,
      predecessor_manifest_id: null,
      created_at: EXACT_SESSION_AT,
      authority: { kind: "local-founder-bootstrap", assurance: "founder_attested" },
      organization: { organization_id: EXACT_SESSION_IDS.organization_id, display_name: "Echo", created_at: EXACT_SESSION_AT },
      principal: { principal_id: EXACT_SESSION_IDS.principal_id, organization_id: EXACT_SESSION_IDS.organization_id, kind: "human", display_name: "Founder" },
      membership: { membership_id: EXACT_SESSION_IDS.membership_id, organization_id: EXACT_SESSION_IDS.organization_id, principal_id: EXACT_SESSION_IDS.principal_id, type: "owner", status: "active", valid_from: EXACT_SESSION_AT },
      installation: { installation_id: EXACT_SESSION_IDS.installation_id, organization_id: EXACT_SESSION_IDS.organization_id, membership_id: EXACT_SESSION_IDS.membership_id, device_id: EXACT_SESSION_IDS.device_id, device_class: "byod", enrolled_at: EXACT_SESSION_AT, product: { name: "echo-brain", version: TEST_BUILD.product_version, source_sha: TEST_BUILD.source_sha } },
      identity_claims: [{ claim_id: "clm_11111111-1111-4111-8111-111111111111", principal_id: EXACT_SESSION_IDS.principal_id, ...exactClaim() }],
      legacy_cutover: { declared_at: EXACT_SESSION_AT, pre_cutover_default: "disposable_test", native_records_require: ["source-attribution-v1", "processor-attribution-v1", "approval-context-v1", "signed-outbox-v1"] },
    },
    registry: {
      schema_version: 1,
      kind: "echo-local-connection-registry",
      registry_id: EXACT_SESSION_IDS.registry_id,
      identity_manifest_id: EXACT_SESSION_IDS.manifest_id,
      revision: 1,
      previous_registry_sha256: null,
      updated_at: EXACT_SESSION_AT,
      connections: [
        { connection_id: "con_11111111-1111-4111-8111-111111111111", organization_id: EXACT_SESSION_IDS.organization_id, owner: { kind: "organization", id: EXACT_SESSION_IDS.organization_id }, provider: "slack", generations: [{ generation: 1, active_from: EXACT_SESSION_AT, ended_at: null, provider_identity: exactProviderIdentity("slack"), local_credential_guard: exactCredentialGuard("file:/private/slack-token") }] },
        { connection_id: "con_22222222-2222-4222-8222-222222222222", organization_id: EXACT_SESSION_IDS.organization_id, owner: { kind: "membership", id: EXACT_SESSION_IDS.membership_id }, provider: "granola", generations: [{ generation: 1, active_from: EXACT_SESSION_AT, ended_at: null, provider_identity: exactProviderIdentity("granola"), local_credential_guard: exactCredentialGuard("file:/private/granola-token") }] },
      ],
      bindings,
    },
    policy: { schema_version: 1, kind: "echo-publication-policy", policy_id: EXACT_SESSION_IDS.policy_id, organization_id: EXACT_SESSION_IDS.organization_id, identity_manifest_id: EXACT_SESSION_IDS.manifest_id, version: 1, effective_at: EXACT_SESSION_AT, publication: exactPublication() },
  };
}

export function completeBootstrapSessionShapeFixture(): JsonRecord {
  const bindings = exactSessionBindings();
  const challenge = { schema_version: 1, kind: "echo-slack-dm-challenge-ticket", provider: "slack", tenant_id: "T123TEAM", enterprise_id: null, subject_id: "U123FOUNDER", bot_user_id: "U123BOT", bot_id: "B123BOT", app_id: "A123APP", auth_test_evidence_sha256: EXACT_SESSION_DIGEST, channel_id: "D123FOUNDER", message_ts: "1752966000.000001", reaction_name: "white_check_mark", challenge_sha256: EXACT_SESSION_DIGEST, issued_at: EXACT_SESSION_AT, expires_at: EXACT_SESSION_EXPIRES_AT };
  const summaryBindings = bindings.map(({ created_at: _a, ended_at: _e, status: _s, ...binding }) => binding);
  return {
    schema_version: 1,
    kind: "echo-founder-bootstrap-session",
    session_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    revision: 6,
    phase: "complete",
    request: {
      config_sha256: EXACT_SESSION_DIGEST,
      build: { ...TEST_BUILD },
      created_at: EXACT_SESSION_AT,
      organization_display_name: "Echo",
      principal_display_name: "Founder",
      device_class: "byod",
      slack_user_id: "U123FOUNDER",
      ids: { ...EXACT_SESSION_IDS },
      claim_id: "clm_11111111-1111-4111-8111-111111111111",
      connection_seeds: [
        { provider: "slack", connection_id: "con_11111111-1111-4111-8111-111111111111", owner: { kind: "organization", id: EXACT_SESSION_IDS.organization_id }, credential_guard: exactCredentialGuard("file:/private/slack-token") },
        { provider: "granola", connection_id: "con_22222222-2222-4222-8222-222222222222", owner: { kind: "membership", id: EXACT_SESSION_IDS.membership_id }, credential_guard: exactCredentialGuard("file:/private/granola-token") },
      ],
      bindings,
      publication: exactPublication(),
    },
    signing_key: exactSigningKey(),
    provider_observations: {
      slack: { snapshot: { provider: "slack", team_id: "T123TEAM", enterprise_id: null, bot_user_id: "U123BOT", bot_id: "B123BOT", app_id: "A123APP" }, provider_identity: exactProviderIdentity("slack"), evidence_input: { schema_version: 1, kind: "echo-slack-auth-test-evidence-input", provider: "slack", tenant: { team_id: "T123TEAM", enterprise_id: null }, subject: { bot_user_id: "U123BOT", bot_id: "B123BOT", app_id: "A123APP" } }, evidence_sha256: EXACT_SESSION_DIGEST },
      granola: { provider: "granola", provider_identity: exactProviderIdentity("granola"), evidence: { schema_version: 1, kind: "echo-granola-first-capture-evidence", provider: "granola", operation: "list_notes", requested_page_size: 1, notes_observed: 1, observed_note_id_sha256: EXACT_SESSION_DIGEST, response_has_more: false, observed_at: EXACT_SESSION_AT } },
    },
    challenge,
    verification: { evidence_input: { schema_version: 1, kind: "echo-slack-dm-challenge-evidence-input", provider: "slack", tenant: { team_id: "T123TEAM", enterprise_id: null }, subject: { user_id: "U123FOUNDER" }, bot: { user_id: "U123BOT", bot_id: "B123BOT", app_id: "A123APP", auth_test_evidence_sha256: EXACT_SESSION_DIGEST }, challenge: { channel_id: "D123FOUNDER", message_ts: "1752966000.000001", nonce_sha256: EXACT_SESSION_DIGEST, issued_at: EXACT_SESSION_AT, expires_at: EXACT_SESSION_EXPIRES_AT }, assertion: { kind: "reaction", name: "white_check_mark", observed_at: EXACT_SESSION_AT } }, evidence_sha256: EXACT_SESSION_DIGEST, claim_assertion: exactClaim() },
    confirmation: { summary: { organization: { organization_id: EXACT_SESSION_IDS.organization_id, display_name: "Echo" }, founder: { principal_id: EXACT_SESSION_IDS.principal_id, membership_id: EXACT_SESSION_IDS.membership_id, display_name: "Founder", slack_team_id: "T123TEAM", slack_user_id: "U123FOUNDER", assurance: "provider_challenge_observed" }, installation: { installation_id: EXACT_SESSION_IDS.installation_id, device_id: EXACT_SESSION_IDS.device_id, key_id: EXACT_SESSION_DIGEST, key_protection: "secure-enclave" }, providers: { slack: { team_id: "T123TEAM", assurance: "provider_verified" }, granola: { tenant: null, assurance: "credential_observed" } }, configuration: { runtime_config_sha256: EXACT_SESSION_DIGEST, bindings: summaryBindings }, publication: exactPublication(), cutover: { before: "disposable_test_or_legacy_imported_unverified", after: "native_attributed_only_when_strict_green" } }, confirmation_sha256: EXACT_SESSION_DIGEST, ready_at: EXACT_SESSION_AT },
    commit: { confirmed_at: EXACT_SESSION_AT, confirmation_sha256: EXACT_SESSION_DIGEST, plan_sha256: EXACT_SESSION_DIGEST, plan: exactPlan() },
    result: { completed_at: EXACT_SESSION_AT, organization_id: EXACT_SESSION_IDS.organization_id, installation_id: EXACT_SESSION_IDS.installation_id, manifest_id: EXACT_SESSION_IDS.manifest_id, active_bundle_sha256: EXACT_SESSION_DIGEST },
    integrity: { canonicalization: "RFC8785", payload_sha256: EXACT_SESSION_DIGEST, signature_algorithm: "ecdsa-p256-sha256-der-low-s", key_id: EXACT_SESSION_DIGEST, signature_base64: "c2lnbmF0dXJl" },
  };
}

export function setFixturePath(
  root: unknown,
  path: readonly (string | number)[],
  value: unknown,
): void {
  let current = root;
  for (const segment of path.slice(0, -1)) {
    if (typeof segment === "number") {
      if (!Array.isArray(current)) throw new Error("test path is not an array");
      current = current[segment];
    } else {
      if (current === null || typeof current !== "object" || Array.isArray(current)) throw new Error("test path is not an object");
      current = (current as JsonRecord)[segment];
    }
  }
  const leaf = path.at(-1);
  if (leaf === undefined) throw new Error("test path must not be empty");
  if (typeof leaf === "number") {
    if (!Array.isArray(current)) throw new Error("test leaf is not an array");
    current[leaf] = value;
  } else {
    if (current === null || typeof current !== "object" || Array.isArray(current)) throw new Error("test leaf is not an object");
    (current as JsonRecord)[leaf] = value;
  }
}
