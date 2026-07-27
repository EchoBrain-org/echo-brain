import type { OrganizationAdminEdgeInstalledRelease } from "./install-release.mjs";

export const ORGANIZATION_ADMIN_EDGE_LAUNCHD_LABEL: string;
export const ORGANIZATION_ADMIN_EDGE_RELEASE_PLATFORM: Readonly<{
  os: "darwin";
  architecture: "arm64";
  node: "22.22.1";
}>;

export interface OrganizationAdminEdgeLaunchAgentInput {
  readonly nodePath: string;
  readonly edgeCliPath: string;
  readonly configPath: string;
  readonly workingDirectory: string;
  readonly stdoutPath: string;
  readonly stderrPath: string;
}

export interface OrganizationAdminEdgeLaunchdPreparationInput {
  readonly releaseDirectory: string;
  readonly expectedArtifactSha256: string;
  readonly configPath: string;
  readonly stateDirectory: string;
}

export interface OrganizationAdminEdgePreflightCommandResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface OrganizationAdminEdgeLaunchdPreparationDependencies {
  readonly observedPlatform?: {
    readonly platform: string;
    readonly architecture: string;
    readonly node: string;
  };
  readonly verifyInstalledRelease?: (options: {
    readonly releaseDirectory: string;
    readonly expectedArtifactSha256: string;
  }) => OrganizationAdminEdgeInstalledRelease;
  readonly runPreflight?: (input: {
    readonly edgeCliPath: string;
    readonly configPath: string;
  }) => OrganizationAdminEdgePreflightCommandResult;
}

export interface OrganizationAdminEdgeLaunchdPreparation {
  readonly schema_version: 1;
  readonly kind: "echo-organization-admin-edge-launchd-preparation";
  readonly prepared_at: string;
  readonly ok: true;
  readonly label: string;
  readonly observed_platform: Readonly<{
    os: "darwin";
    architecture: "arm64";
    node: "22.22.1";
  }>;
  readonly release_id: string;
  readonly source_sha: string;
  readonly version: string;
  readonly artifact_sha256: string;
  readonly artifact_manifest_sha256: string;
  readonly deployed_tree_sha256: string;
  readonly config_path: string;
  readonly config_sha256: string;
  readonly node_executable_path: string;
  readonly preflight_sha256: string;
  readonly plist_sha256: string;
  readonly node_executable_sha256: string;
  readonly preflight_record_path: string;
  readonly staged_plist_path: string;
  readonly preparation_record_path: string;
  readonly preparation_record_sha256: string;
}

export function renderOrganizationAdminEdgeLaunchAgent(
  input: OrganizationAdminEdgeLaunchAgentInput,
): string;

export function assertOrganizationAdminEdgeReleasePlatform(observed?: {
  readonly platform?: string;
  readonly architecture?: string;
  readonly node?: string;
}): void;

export function parseSuccessfulPreflight(
  value: string,
): Readonly<Record<string, unknown>>;

export function prepareOrganizationAdminEdgeLaunchd(
  input: OrganizationAdminEdgeLaunchdPreparationInput,
  dependencies?: OrganizationAdminEdgeLaunchdPreparationDependencies,
): OrganizationAdminEdgeLaunchdPreparation;
