export interface OrganizationAdminEdgeInstalledRelease {
  readonly ok: true;
  readonly changed: boolean;
  readonly release_id: string;
  readonly release_directory: string;
  readonly package_directory: string;
  readonly edge_cli_path: string;
  readonly artifact: {
    readonly target: "organization-admin-edge";
    readonly package: "@echo-brain/organization-admin-edge";
    readonly source_sha: string;
    readonly version: string;
    readonly sha256: string;
    readonly manifest_sha256: string;
  };
  readonly deployed_manifest_sha256: string;
}

export interface VerifyOrganizationAdminEdgeInstalledReleaseOptions {
  readonly releaseDirectory: string;
  readonly expectedArtifactSha256?: string;
}

export interface InstallOrganizationAdminEdgeReleaseOptions {
  readonly artifactDirectory: string;
  readonly expectedArtifactSha256: string;
  readonly installRoot: string;
}

export interface InstallOrganizationAdminEdgeReleaseDependencies {
  readonly sealPublishedReleaseRoot?: (releaseDirectory: string) => void;
}

export function verifyOrganizationAdminEdgeInstalledRelease(
  options: VerifyOrganizationAdminEdgeInstalledReleaseOptions,
): OrganizationAdminEdgeInstalledRelease;

export function installOrganizationAdminEdgeRelease(
  options: InstallOrganizationAdminEdgeReleaseOptions,
  dependencies?: InstallOrganizationAdminEdgeReleaseDependencies,
): OrganizationAdminEdgeInstalledRelease;
