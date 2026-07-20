import type { AdapterInstanceConfig } from "../../../core/index.js";
import type { ProductRuntimeConfig } from "../../config.js";
import { identityBindingConfigurationSnapshot } from "./binding-configuration.js";
import { canonicalSha256 } from "../foundation/canonical-json.js";
import type {
  LocalConnectionRegistryV1,
  LocalIdentityManifestV1,
  PublicationPolicyV1,
} from "../contracts.js";
import { assertUtcMillisecondTimestamp } from "../foundation/identifiers.js";

type ManifestSemanticShape = Omit<
  LocalIdentityManifestV1,
  "integrity" | "installation"
> & {
  installation: Omit<LocalIdentityManifestV1["installation"], "signing_key"> &
    Partial<Pick<LocalIdentityManifestV1["installation"], "signing_key">>;
};

type RegistrySemanticShape = Omit<LocalConnectionRegistryV1, "integrity">;
type PolicySemanticShape = Omit<
  PublicationPolicyV1,
  "integrity" | "issued_by"
> &
  Partial<Pick<PublicationPolicyV1, "issued_by">>;

interface ConfiguredBinding {
  capability:
    | "meeting-source"
    | "decision-processor"
    | "approval-surface"
    | "delivery-surface";
  config: AdapterInstanceConfig;
}

function fail(message: string): never {
  throw new Error(`identity bundle semantic mismatch: ${message}`);
}

function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) fail(`${label} must be unique`);
}

function configuredBindings(config: ProductRuntimeConfig): ConfiguredBinding[] {
  return [
    ...config.meeting_sources.map((item) => ({
      capability: "meeting-source" as const,
      config: item,
    })),
    {
      capability: "decision-processor" as const,
      config: config.decision_processor,
    },
    ...config.delivery_surfaces.map((item) => ({
      capability: "delivery-surface" as const,
      config: item,
    })),
    ...(config.approval_mode === "adapter"
      ? [
          {
            capability: "approval-surface" as const,
            config: config.approval_surface,
          },
        ]
      : []),
  ];
}

function bindingKey(
  capability: string,
  adapterId: string,
  instanceId: string,
): string {
  return `${capability}:${adapterId}:${instanceId}`;
}

function expectedProvider(adapterId: string): string | null {
  if (adapterId === "granola") return "granola";
  if (adapterId === "slack" || adapterId === "slack-reactions") return "slack";
  return null;
}

export function validateIdentityDocumentSemantics(
  manifest: ManifestSemanticShape,
  registry: RegistrySemanticShape,
  policy: PolicySemanticShape,
): void {
  const organizationId = manifest.organization.organization_id;
  const principalId = manifest.principal.principal_id;
  const membershipId = manifest.membership.membership_id;
  const installationId = manifest.installation.installation_id;

  if (
    manifest.principal.organization_id !== organizationId ||
    manifest.membership.organization_id !== organizationId ||
    manifest.membership.principal_id !== principalId ||
    manifest.installation.organization_id !== organizationId ||
    manifest.installation.membership_id !== membershipId
  ) {
    fail("organization, principal, membership, and installation IDs disagree");
  }
  for (const [label, timestamp] of [
    ["manifest.created_at", manifest.created_at],
    ["organization.created_at", manifest.organization.created_at],
    ["membership.valid_from", manifest.membership.valid_from],
    ["installation.enrolled_at", manifest.installation.enrolled_at],
    ["legacy_cutover.declared_at", manifest.legacy_cutover.declared_at],
    ["registry.updated_at", registry.updated_at],
    ["policy.effective_at", policy.effective_at],
  ] as const) {
    assertUtcMillisecondTimestamp(timestamp, label);
  }
  unique(
    manifest.identity_claims.map((claim) => claim.claim_id),
    "identity claim IDs",
  );
  for (const claim of manifest.identity_claims) {
    if (claim.principal_id !== principalId) {
      fail("identity claim refers to another principal");
    }
    assertUtcMillisecondTimestamp(
      claim.verification.verified_at,
      "identity claim verified_at",
    );
    if (
      claim.verification.method === "slack_dm_challenge" &&
      (claim.issuer.kind !== "provider" ||
        claim.issuer.provider !== "slack" ||
        claim.subject.kind !== "user" ||
        claim.verification.assurance !== "provider_challenge_observed")
    ) {
      fail(
        "Slack challenge claim method, issuer, subject, or assurance disagrees",
      );
    }
    if (
      claim.verification.method === "oidc_id_token" &&
      (claim.issuer.kind !== "oidc" ||
        claim.subject.kind !== "oidc_sub" ||
        claim.verification.assurance !== "provider_verified")
    ) {
      fail("OIDC claim method, issuer, subject, or assurance disagrees");
    }
  }

  if (
    registry.identity_manifest_id !== manifest.manifest_id ||
    policy.identity_manifest_id !== manifest.manifest_id ||
    policy.organization_id !== organizationId
  ) {
    fail("registry or policy is bound to another identity manifest");
  }
  if (
    policy.issued_by !== undefined &&
    policy.issued_by.installation_id !== installationId
  ) {
    fail("publication policy was issued by another installation");
  }

  unique(
    registry.connections.map((connection) => connection.connection_id),
    "connection IDs",
  );
  const connectionById = new Map(
    registry.connections.map((connection) => [
      connection.connection_id,
      connection,
    ]),
  );
  for (const connection of registry.connections) {
    if (connection.organization_id !== organizationId) {
      fail(
        `connection ${connection.connection_id} belongs to another organization`,
      );
    }
    if (
      (connection.owner.kind === "organization" &&
        connection.owner.id !== organizationId) ||
      (connection.owner.kind === "membership" &&
        connection.owner.id !== membershipId)
    ) {
      fail(`connection ${connection.connection_id} has an unknown owner`);
    }
    unique(
      connection.generations.map((generation) => String(generation.generation)),
      `connection ${connection.connection_id} generations`,
    );
    if (
      connection.generations.filter(
        (generation) => generation.ended_at === null,
      ).length > 1
    ) {
      fail(
        `connection ${connection.connection_id} has multiple active generations`,
      );
    }
    for (const generation of connection.generations) {
      assertUtcMillisecondTimestamp(
        generation.active_from,
        "connection generation active_from",
      );
      if (generation.ended_at !== null) {
        assertUtcMillisecondTimestamp(
          generation.ended_at,
          "connection generation ended_at",
        );
        if (generation.ended_at < generation.active_from) {
          fail(`connection ${connection.connection_id} ends before it starts`);
        }
      }
      assertUtcMillisecondTimestamp(
        generation.provider_identity.verification.verified_at,
        "provider identity verified_at",
      );
      if (connection.provider === "slack") {
        if (
          generation.provider_identity.tenant?.kind !== "slack-team" ||
          generation.provider_identity.subject === null ||
          generation.provider_identity.verification.method !==
            "slack_auth_test" ||
          generation.provider_identity.verification.assurance !==
            "provider_verified"
        ) {
          fail("Slack connection lacks a verified team and bot identity");
        }
      }
      if (
        connection.provider === "granola" &&
        generation.provider_identity.verification.method ===
          "provider_first_capture" &&
        (generation.provider_identity.tenant !== null ||
          generation.provider_identity.subject !== null ||
          generation.provider_identity.verification.assurance !==
            "credential_observed")
      ) {
        fail("Granola first-capture evidence overstates provider identity");
      }
    }
  }

  unique(
    registry.bindings.map((binding) => binding.adapter_binding_id),
    "adapter binding IDs",
  );
  unique(
    registry.bindings
      .filter((binding) => binding.status === "active")
      .map((binding) =>
        bindingKey(binding.capability, binding.adapter_id, binding.instance_id),
      ),
    "active adapter binding slots",
  );
  for (const binding of registry.bindings) {
    if (
      canonicalSha256(binding.configuration_snapshot) !==
      binding.configuration_sha256
    ) {
      fail(
        `binding ${binding.adapter_binding_id} configuration digest disagrees`,
      );
    }
    assertUtcMillisecondTimestamp(binding.created_at, "binding created_at");
    if (
      (binding.status === "active" && binding.ended_at !== null) ||
      (binding.status === "retired" && binding.ended_at === null)
    ) {
      fail(`binding ${binding.adapter_binding_id} lifecycle is inconsistent`);
    }
    if (binding.ended_at !== null) {
      assertUtcMillisecondTimestamp(binding.ended_at, "binding ended_at");
      if (binding.ended_at < binding.created_at) {
        fail(`binding ${binding.adapter_binding_id} ends before it starts`);
      }
    }
    if (binding.connection_id === null) {
      if (binding.connection_generation !== null) {
        fail(`binding ${binding.adapter_binding_id} has a dangling generation`);
      }
      continue;
    }
    const connection = connectionById.get(binding.connection_id);
    const generation = connection?.generations.find(
      (item) => item.generation === binding.connection_generation,
    );
    if (connection === undefined || generation === undefined) {
      fail(
        `binding ${binding.adapter_binding_id} refers to a missing connection generation`,
      );
    }
    if (binding.status === "active" && generation.ended_at !== null) {
      fail(
        `binding ${binding.adapter_binding_id} refers to a retired credential generation`,
      );
    }
    const provider = expectedProvider(binding.adapter_id);
    if (provider !== null && connection.provider !== provider) {
      fail(
        `binding ${binding.adapter_binding_id} uses the wrong provider connection`,
      );
    }
  }

  const slackApprovalBindings = registry.bindings.filter(
    (binding) =>
      binding.status === "active" &&
      binding.capability === "approval-surface" &&
      binding.adapter_id === "slack-reactions",
  );
  for (const claim of manifest.identity_claims) {
    if (claim.issuer.kind === "provider" && claim.issuer.provider === "slack") {
      if (slackApprovalBindings.length !== 1) {
        fail(
          "Slack human claim requires exactly one active slack-reactions approval binding",
        );
      }
      const approvalBinding = slackApprovalBindings[0]!;
      const approvalConnection =
        approvalBinding.connection_id === null
          ? undefined
          : connectionById.get(approvalBinding.connection_id);
      const approvalGeneration = approvalConnection?.generations.find(
        (generation) =>
          generation.generation === approvalBinding.connection_generation,
      );
      if (
        approvalConnection?.provider !== "slack" ||
        approvalGeneration?.ended_at !== null ||
        approvalGeneration.provider_identity.tenant?.kind !== "slack-team" ||
        approvalGeneration.provider_identity.tenant.id !==
          claim.issuer.tenant_id
      ) {
        fail(
          "Slack human claim and active approval-surface connection name different workspaces",
        );
      }
    }
  }

  if (
    policy.publication.audience.subjects.some(
      (subject) =>
        !(
          (subject.kind === "organization" && subject.id === organizationId) ||
          (subject.kind === "membership" && subject.id === membershipId)
        ),
    )
  ) {
    fail("publication audience contains an unknown local subject");
  }
  if (
    policy.publication.audience.scope === "organization" &&
    (policy.publication.audience.subjects.length !== 1 ||
      policy.publication.audience.subjects[0]?.kind !== "organization" ||
      policy.publication.audience.subjects[0].id !== organizationId)
  ) {
    fail("organization audience must name exactly the enrolled organization");
  }
}
export function validateRegistryAgainstRuntime(
  config: ProductRuntimeConfig,
  registry: RegistrySemanticShape,
): void {
  const configured = configuredBindings(config);
  const active = registry.bindings.filter(
    (binding) => binding.status === "active",
  );
  if (active.length !== configured.length) {
    fail("active binding count does not match runtime configuration");
  }
  const connections = new Map(
    registry.connections.map((connection) => [
      connection.connection_id,
      connection,
    ]),
  );
  for (const expected of configured) {
    const matches = active.filter(
      (binding) =>
        binding.capability === expected.capability &&
        binding.adapter_id === expected.config.adapter_id &&
        binding.instance_id === expected.config.instance_id,
    );
    if (matches.length !== 1) {
      fail(
        `runtime adapter ${bindingKey(expected.capability, expected.config.adapter_id, expected.config.instance_id)} does not have exactly one active binding`,
      );
    }
    const binding = matches[0]!;
    const expectedConfiguration = identityBindingConfigurationSnapshot(
      expected.capability,
      expected.config,
    );
    if (
      canonicalSha256(expectedConfiguration) !== binding.configuration_sha256 ||
      canonicalSha256(expectedConfiguration) !==
        canonicalSha256(binding.configuration_snapshot)
    ) {
      fail(
        `runtime settings drifted from binding ${binding.adapter_binding_id}`,
      );
    }
    if (binding.connection_id === null) {
      if (expected.config.credential_ref !== undefined) {
        fail(
          `credentialed adapter ${binding.adapter_binding_id} has no connection`,
        );
      }
      continue;
    }
    const connection = connections.get(binding.connection_id);
    const generation = connection?.generations.find(
      (item) => item.generation === binding.connection_generation,
    );
    if (generation === undefined) {
      fail(
        `binding ${binding.adapter_binding_id} has no credential generation`,
      );
    }
    if (
      expected.config.credential_ref === undefined ||
      generation.local_credential_guard.reference !==
        expected.config.credential_ref
    ) {
      fail(
        `runtime credential reference drifted from binding ${binding.adapter_binding_id}`,
      );
    }
  }
}
