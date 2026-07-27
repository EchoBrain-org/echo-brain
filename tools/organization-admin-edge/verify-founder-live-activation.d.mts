import type { OrganizationAdminEdgeInstalledRelease } from "./install-release.mjs";

export interface OrganizationAdminEdgeFounderLiveActivationInput {
  readonly planPath: string;
  readonly commitmentPath: string;
  readonly preparationPath: string;
  readonly restoredPreparationPath: string;
  readonly networkPolicyPath: string;
  readonly networkProcedurePath: string;
  readonly releaseDirectory: string;
  readonly outputPath: string;
}

export interface OrganizationAdminEdgeFounderLiveActivationDependencies {
  readonly now?: string;
  readonly observedPlatform?: {
    readonly platform: string;
    readonly architecture: string;
    readonly node: string;
  };
  readonly verifyInstalledRelease?: (options: {
    readonly releaseDirectory: string;
    readonly expectedArtifactSha256: string;
  }) => OrganizationAdminEdgeInstalledRelease;
}

export interface OrganizationAdminEdgeFounderLiveActivationVerification {
  readonly schema_version: 1;
  readonly kind: string;
  readonly ok: true;
  readonly checked_at: string;
  readonly plan_sha256: string;
  readonly commitment_receipt_sha256: string;
  readonly release_id: string;
  readonly artifact_sha256: string;
  readonly config_sha256: string;
  readonly node_executable_sha256: string;
  readonly supervisor_plist_sha256: string;
  readonly network_policy_sha256: string;
  readonly network_procedure_sha256: string;
  readonly service_label: string;
  readonly record_path: string;
  readonly record_sha256: string;
}

export function verifyOrganizationAdminEdgeFounderLiveActivation(
  input: OrganizationAdminEdgeFounderLiveActivationInput,
  dependencies?: OrganizationAdminEdgeFounderLiveActivationDependencies,
): OrganizationAdminEdgeFounderLiveActivationVerification;
