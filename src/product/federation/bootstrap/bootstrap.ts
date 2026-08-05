import type {
  AdapterBindingV1,
  IdentityClaimV1,
  LocalConnectionRegistryV1,
  LocalIdentityManifestV1,
  PublicationPolicyV1,
  PublicationSnapshotV1,
  ToolConnectionV1,
} from "../contracts.js";
import type { InstallationKeyDescriptor } from "../foundation/installation-signer.js";
import { verifyInstallationKeyDescriptor } from "../foundation/installation-signer.js";
import type { PackagedBuildIdentityV1 } from "../build-identity.js";
import { validateIdentityDocumentSemantics } from "../identity/bundle-semantics.js";

/**
 * Historical validation only. The founder bootstrap ceremony that authored
 * these plans is retired and deleted; what remains reconstructs and validates
 * the commit plan a stored bootstrap session already carries, so residue left
 * behind by the retired mode can still be parsed, cross-checked, and refused.
 */

export interface FounderBootstrapIds {
  organization_id: string;
  principal_id: string;
  membership_id: string;
  device_id: string;
  installation_id: string;
  manifest_id: string;
  registry_id: string;
  policy_id: string;
}

export interface FounderBootstrapInput {
  ids: FounderBootstrapIds;
  organization_display_name: string;
  principal_display_name: string;
  device_class: "byod" | "managed";
  created_at: string;
  identity_claims: readonly IdentityClaimV1[];
  connections: readonly ToolConnectionV1[];
  bindings: readonly AdapterBindingV1[];
  publication: PublicationSnapshotV1;
}

type UnsignedIdentityManifest = Omit<
  LocalIdentityManifestV1,
  "integrity" | "installation"
> & {
  installation: Omit<LocalIdentityManifestV1["installation"], "signing_key">;
};
type UnsignedConnectionRegistry = Omit<LocalConnectionRegistryV1, "integrity">;
type UnsignedPublicationPolicy = Omit<
  PublicationPolicyV1,
  "integrity" | "issued_by"
>;

export interface FounderBootstrapPlan {
  ids: FounderBootstrapIds;
  expected_signing_key: InstallationKeyDescriptor;
  manifest: UnsignedIdentityManifest;
  registry: UnsignedConnectionRegistry;
  policy: UnsignedPublicationPolicy;
}

function nonBlank(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 200) {
    throw new Error(`${label} must contain 1-200 characters`);
  }
  return trimmed;
}

function assertBuildIdentity(build: PackagedBuildIdentityV1): void {
  if (build.product_version.trim() === "")
    throw new Error("product version is required");
  if (!/^[a-f0-9]{40}$/.test(build.source_sha)) {
    throw new Error("bootstrap requires the full lowercase source commit SHA");
  }
  if (build.source_kind !== "materialized-commit") {
    throw new Error(
      "bootstrap requires a package built from one materialized commit",
    );
  }
}

function assertFounderBootstrapPlanIds(plan: FounderBootstrapPlan): void {
  const expected: ReadonlyArray<readonly [string, string, string]> = [
    [
      "organization_id",
      plan.ids.organization_id,
      plan.manifest.organization.organization_id,
    ],
    [
      "principal_id",
      plan.ids.principal_id,
      plan.manifest.principal.principal_id,
    ],
    [
      "membership_id",
      plan.ids.membership_id,
      plan.manifest.membership.membership_id,
    ],
    ["device_id", plan.ids.device_id, plan.manifest.installation.device_id],
    [
      "installation_id",
      plan.ids.installation_id,
      plan.manifest.installation.installation_id,
    ],
    [
      "signing_key.installation_id",
      plan.ids.installation_id,
      plan.expected_signing_key.installation_id,
    ],
    ["manifest_id", plan.ids.manifest_id, plan.manifest.manifest_id],
    ["registry_id", plan.ids.registry_id, plan.registry.registry_id],
    ["policy_id", plan.ids.policy_id, plan.policy.policy_id],
  ];
  const mismatches = expected
    .filter(([, planned, embedded]) => planned !== embedded)
    .map(([label]) => label);
  if (mismatches.length > 0) {
    throw new Error(
      `bootstrap plan IDs do not match their embedded documents: ${mismatches.join(", ")}`,
    );
  }
}

export function assertFounderBootstrapPlan(plan: FounderBootstrapPlan): void {
  assertFounderBootstrapPlanIds(plan);
  verifyInstallationKeyDescriptor(plan.expected_signing_key);
  validateIdentityDocumentSemantics(plan.manifest, plan.registry, plan.policy);
}

/**
 * Reconstruct the commit plan for a stored session's enrollment facts. The
 * build identity always comes from the stored session itself; there is no
 * fallback to the currently installed package.
 */
export function planFounderBootstrap(
  input: FounderBootstrapInput,
  expectedSigningKey: InstallationKeyDescriptor,
  build: PackagedBuildIdentityV1,
): FounderBootstrapPlan {
  const ids = input.ids;
  assertBuildIdentity(build);
  verifyInstallationKeyDescriptor(expectedSigningKey);
  if (expectedSigningKey.installation_id !== ids.installation_id) {
    throw new Error(
      "founder bootstrap plan requires the expected installation key",
    );
  }
  const organizationName = nonBlank(
    input.organization_display_name,
    "organization display name",
  );
  const principalName = nonBlank(
    input.principal_display_name,
    "principal display name",
  );
  const manifest: UnsignedIdentityManifest = {
    schema_version: 1,
    kind: "echo-local-identity-manifest",
    manifest_id: ids.manifest_id,
    predecessor_manifest_id: null,
    created_at: input.created_at,
    authority: {
      kind: "local-founder-bootstrap",
      assurance: "founder_attested",
    },
    organization: {
      organization_id: ids.organization_id,
      display_name: organizationName,
      created_at: input.created_at,
    },
    principal: {
      principal_id: ids.principal_id,
      organization_id: ids.organization_id,
      kind: "human",
      display_name: principalName,
    },
    membership: {
      membership_id: ids.membership_id,
      organization_id: ids.organization_id,
      principal_id: ids.principal_id,
      type: "owner",
      status: "active",
      valid_from: input.created_at,
    },
    installation: {
      installation_id: ids.installation_id,
      organization_id: ids.organization_id,
      membership_id: ids.membership_id,
      device_id: ids.device_id,
      device_class: input.device_class,
      enrolled_at: input.created_at,
      product: {
        name: "echo-brain",
        version: build.product_version,
        source_sha: build.source_sha,
      },
    },
    identity_claims: input.identity_claims,
    legacy_cutover: {
      declared_at: input.created_at,
      pre_cutover_default: "disposable_test",
      native_records_require: [
        "source-attribution-v1",
        "processor-attribution-v1",
        "approval-context-v1",
        "signed-outbox-v1",
      ],
    },
  };
  const registry: UnsignedConnectionRegistry = {
    schema_version: 1,
    kind: "echo-local-connection-registry",
    registry_id: ids.registry_id,
    identity_manifest_id: ids.manifest_id,
    revision: 1,
    previous_registry_sha256: null,
    updated_at: input.created_at,
    connections: input.connections,
    bindings: input.bindings,
  };
  const policy: UnsignedPublicationPolicy = {
    schema_version: 1,
    kind: "echo-publication-policy",
    policy_id: ids.policy_id,
    organization_id: ids.organization_id,
    identity_manifest_id: ids.manifest_id,
    version: 1,
    effective_at: input.created_at,
    publication: input.publication,
  };
  return {
    ids,
    expected_signing_key: expectedSigningKey,
    manifest,
    registry,
    policy,
  };
}
