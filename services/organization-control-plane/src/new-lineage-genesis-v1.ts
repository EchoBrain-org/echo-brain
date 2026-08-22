/**
 * Private workspace entrypoint for fresh-lineage genesis and verification.
 * It deliberately excludes Slack adapters and legacy control-plane surfaces.
 */
export {
  applyOrganizationControlBaselineV1,
  ORGANIZATION_CONTROL_BASELINE_APPLICATION_ID,
  ORGANIZATION_CONTROL_BASELINE_SCHEMA_VERSION_V1,
  organizationControlBaselineSha256V1,
} from "./persistence/baseline.js";
export { openOrganizationControlDatabase } from "./persistence/open-unmigrated-database.js";
