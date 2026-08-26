export type AuthorityRecoveryHelperBundleManifest = Readonly<{
  schema_version: 1;
  kind: "echo-authority-recovery-helper-bundle-v1";
  source_commit: string;
  node_version: "v22.22.1";
  platform: "linux";
  architecture: "arm64";
  package_lock_sha256: string;
  archive_sha256: string;
  required_paths: readonly string[];
}>;
