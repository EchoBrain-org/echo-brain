import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  organizationControlBaselineSha256V2,
  ORGANIZATION_CONTROL_BASELINE_SCHEMA_VERSION_V2,
} from "@echo-brain/organization-control-plane/organization-control-database-v1";
import {
  organizationRecordDerivedBaselineSha256V1,
  organizationRecordLogBaselineSha256V2,
  ORGANIZATION_RECORD_DERIVED_BASELINE_SCHEMA_VERSION_V1,
  ORGANIZATION_RECORD_LOG_BASELINE_SCHEMA_VERSION_V2,
} from "@echo-brain/organization-record/organization-record-api-v1";
import {
  readableSearchPlaneBaselineSha256V1,
  READABLE_SEARCH_CONTENT_BASELINE_V1,
  READABLE_SEARCH_FACTS_BASELINE_V1,
  READABLE_SEARCH_LEXICAL_BASELINE_V1,
  READABLE_SEARCH_PLANE_BASELINE_SCHEMA_VERSION_V1,
} from "@echo-brain/organization-retrieval/readable-search-engine-v1";
import {
  AUTHORITY_BASELINE_SCHEMA_VERSION_V4,
  authorityBaselineSha256V4,
} from "../adapters/persistence/sqlite/baseline.js";
import { verifyStateLineageBeforeOpen } from "../state-lineage/state-lineage-preopen-guard.js";
import { validateStateLineageRootManifestV1 } from "../state-lineage/state-lineage-manifest-v1.js";

function rootForState(stateDirectory: string) {
  const path = join(stateDirectory, "state-lineage-root.v1.json");
  try {
    return validateStateLineageRootManifestV1(
      JSON.parse(readFileSync(path, "utf8")),
    );
  } catch {
    throw new Error(
      "Organization Authority requires a valid state-lineage root manifest",
    );
  }
}

/** Verify every Authority state role before a stopped command opens a writable handle. */
export function verifyAuthorityStateLineage(stateDirectory: string) {
  const root = rootForState(stateDirectory);
  return verifyStateLineageBeforeOpen({
    state_directory: stateDirectory,
    expected_binding: {
      authority_id: root.authority_id,
      organization_id: root.organization_id,
      state_lineage_id: root.state_lineage_id,
    },
    expected_schemas: {
      authority: {
        database_schema_version: AUTHORITY_BASELINE_SCHEMA_VERSION_V4,
        schema_sha256: authorityBaselineSha256V4(),
      },
      "control-plane": {
        database_schema_version:
          ORGANIZATION_CONTROL_BASELINE_SCHEMA_VERSION_V2,
        schema_sha256: organizationControlBaselineSha256V2(),
      },
      "record-log": {
        database_schema_version:
          ORGANIZATION_RECORD_LOG_BASELINE_SCHEMA_VERSION_V2,
        schema_sha256: organizationRecordLogBaselineSha256V2(),
      },
      "record-derived": {
        database_schema_version:
          ORGANIZATION_RECORD_DERIVED_BASELINE_SCHEMA_VERSION_V1,
        schema_sha256: organizationRecordDerivedBaselineSha256V1(),
      },
      "retrieval-facts": {
        database_schema_version:
          READABLE_SEARCH_PLANE_BASELINE_SCHEMA_VERSION_V1,
        schema_sha256: readableSearchPlaneBaselineSha256V1(
          READABLE_SEARCH_FACTS_BASELINE_V1,
        ),
      },
      "retrieval-lexical": {
        database_schema_version:
          READABLE_SEARCH_PLANE_BASELINE_SCHEMA_VERSION_V1,
        schema_sha256: readableSearchPlaneBaselineSha256V1(
          READABLE_SEARCH_LEXICAL_BASELINE_V1,
        ),
      },
      "retrieval-content": {
        database_schema_version:
          READABLE_SEARCH_PLANE_BASELINE_SCHEMA_VERSION_V1,
        schema_sha256: readableSearchPlaneBaselineSha256V1(
          READABLE_SEARCH_CONTENT_BASELINE_V1,
        ),
      },
    },
  });
}
