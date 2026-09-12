export interface SchemaCleanupInspection {
  readonly kind: 'echo-authority-schema-cleanup-inspection-v1';
  readonly source_inventory_sha256: string;
  readonly source_root_version: 1;
  readonly target_root_version: 2;
  readonly retired_tables_empty: true;
  readonly retained_rows: Readonly<Record<string, readonly { table: string; rows: number; sha256: string }[]>>;
}
export function inspectAuthoritySchemaCleanup(source: string): SchemaCleanupInspection;
export function convertAuthoritySchemaCleanup(input: {
  source: string;
  output: string;
  expectedSourceInventorySha256: string;
  artifactSourceSha: string;
}): Readonly<{
  kind: 'echo-authority-schema-cleanup-receipt-v1';
  source_inventory_sha256: string;
  output_inventory_sha256: string;
  artifact_source_sha: string;
  source_unchanged: true;
  retained_rows_unchanged: true;
  root_manifest_sha256: string;
  retired_tables: 22;
}>;
