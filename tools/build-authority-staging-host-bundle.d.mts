export type AuthorityStagingHostBundleFile = Readonly<{
  path: string;
  sha256: string;
  mode: string;
}>;

export type AuthorityStagingHostBundleManifest = Readonly<{
  schema_version: 1;
  kind: "echo-authority-staging-host-bundle-v1";
  source_commit: string;
  files: readonly AuthorityStagingHostBundleFile[];
  archive_sha256: string;
}>;
