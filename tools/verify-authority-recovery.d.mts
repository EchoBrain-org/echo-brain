export interface LinuxMountInspection {
  readonly mount_id: string;
  readonly mount_point: string;
  readonly mount_options: readonly string[];
}

export interface AuthorityRecoveryVerificationOptions {
  readonly cleanData: string;
  readonly sourceRoot: string;
  readonly mountInspector?: (path: string) => LinuxMountInspection;
}

export interface AuthorityRecoveryVerificationResult {
  readonly schema_version: 1;
  readonly kind: "echo-authority-offline-recovery-verification-v1";
  readonly ok: true;
  readonly release_runtime_profile_tuple_valid: true;
  readonly runtime_environment_snapshot_schema_valid: true;
  readonly release_bound_environment_fields_valid: true;
  readonly state_lineage_valid: true;
  readonly private_metadata_valid: true;
  readonly private_entry_count: number;
  readonly primary_sqlite_database_count: number;
  readonly primary_sqlite_integrity_valid: true;
  readonly retrieval_generation_count: number;
  readonly retrieval_segment_count: number;
  readonly retrieval_sqlite_database_count: number;
  readonly retrieval_sqlite_integrity_valid: true;
}

export function parseLinuxMountinfo(
  text: string,
): readonly LinuxMountInspection[];

export function inspectLinuxReadOnlyMount(
  path: string,
  readMountinfo?: () => string,
): LinuxMountInspection;

export function verifyAuthorityRecovery(
  options: AuthorityRecoveryVerificationOptions,
): Promise<AuthorityRecoveryVerificationResult>;
