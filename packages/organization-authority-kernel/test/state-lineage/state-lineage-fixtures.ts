import {
  STATE_LINEAGE_DATABASE_MANIFEST_V1_KIND,
  STATE_LINEAGE_ROOT_MANIFEST_V2_KIND,
  stateLineageDatabaseSlotsV2,
} from "../../src/state-lineage/state-lineage-manifest-v1.js";
import type { StateLineageRoleV2 } from "../../src/state-lineage/state-lineage-manifest-v1.js";

/**
 * The golden state-lineage manifest bodies. With no binding override they hash
 * to the golden digests pinned in state-lineage-manifest-v1.test.ts.
 */
export const AUTHORITY_ID = "oau_11111111-1111-4111-8111-111111111111";
export const ORGANIZATION_ID = "org_22222222-2222-4222-8222-222222222222";
export const STATE_LINEAGE_ID = "lineage-2026-08-21-fresh-baseline";
export const CREATED_AT = "2026-08-21T00:00:00.000Z";
export const ARTIFACT_REVISION = "42dd37a0000000000000000000000000000000aa";
export const SCHEMA_SHA256 =
  "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

export interface ManifestBindingOverrides {
  readonly authority_id?: string;
  readonly organization_id?: string;
  readonly state_lineage_id?: string;
}

export function rootManifestBody(
  binding: ManifestBindingOverrides = {},
): Record<string, unknown> {
  return {
    schema_version: 2,
    kind: STATE_LINEAGE_ROOT_MANIFEST_V2_KIND,
    authority_id: binding.authority_id ?? AUTHORITY_ID,
    organization_id: binding.organization_id ?? ORGANIZATION_ID,
    state_lineage_id: binding.state_lineage_id ?? STATE_LINEAGE_ID,
    databases: stateLineageDatabaseSlotsV2().map((slot) => ({
      role: slot.role,
      location:
        slot.location.kind === "state_file"
          ? { kind: "state_file", filename: slot.location.filename }
          : {
              kind: "retrieval_segment_tree",
              directory: slot.location.directory,
              filename: slot.location.filename,
            },
      application_id: slot.application_id,
    })),
    created_at: CREATED_AT,
    creating_artifact_revision: ARTIFACT_REVISION,
  };
}

export function databaseManifestBody(
  role: StateLineageRoleV2 = "authority",
  binding: ManifestBindingOverrides = {},
): Record<string, unknown> {
  return {
    schema_version: 1,
    kind: STATE_LINEAGE_DATABASE_MANIFEST_V1_KIND,
    role,
    authority_id: binding.authority_id ?? AUTHORITY_ID,
    organization_id: binding.organization_id ?? ORGANIZATION_ID,
    state_lineage_id: binding.state_lineage_id ?? STATE_LINEAGE_ID,
    database_schema_version: 1,
    schema_sha256: SCHEMA_SHA256,
    created_at: CREATED_AT,
    creating_artifact_revision: ARTIFACT_REVISION,
  };
}
