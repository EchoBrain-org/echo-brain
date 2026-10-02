import {
  STAGING_CONNECTOR_REHEARSAL_PATH_V1,
  validateStagingConnectorRehearsalProfileV1, validateStagingConnectorRehearsalRequestV1, validateStagingConnectorRehearsalResponseV1,
  type StagingConnectorRehearsalProfileV1, type StagingConnectorRehearsalRequestV1, type StagingConnectorRehearsalResponseV1,
} from './staging-connector-rehearsal-protocol-v1.js';
import {
  validateStagingConnectorRehearsalProfileV2, validateStagingConnectorRehearsalRequestV2, validateStagingConnectorRehearsalResponseV2,
  type StagingConnectorRehearsalProfileV2, type StagingConnectorRehearsalRequestV2, type StagingConnectorRehearsalResponseV2,
} from './staging-connector-rehearsal-protocol-v2.js';

export type StagingConnectorRehearsalProfile = StagingConnectorRehearsalProfileV1 | StagingConnectorRehearsalProfileV2;
export type StagingConnectorRehearsalRequest = StagingConnectorRehearsalRequestV1 | StagingConnectorRehearsalRequestV2;
export type StagingConnectorRehearsalResponse = StagingConnectorRehearsalResponseV1 | StagingConnectorRehearsalResponseV2;
/** Both versions use the same logical bounded-capture endpoint. */
export { STAGING_CONNECTOR_REHEARSAL_PATH_V1 };

/** Version is chosen only by the host-owned selected profile, never by a request body. */
export function stagingConnectorRehearsalProtocol(profile: StagingConnectorRehearsalProfile) {
  if (profile.schema_version === 1) return Object.freeze({
    schema_version: 1 as const,
    validate_request: validateStagingConnectorRehearsalRequestV1,
    validate_response: validateStagingConnectorRehearsalResponseV1,
    receipt_kind: 'echo-staging-connector-rehearsal-receipt-v1' as const,
  });
  return Object.freeze({
    schema_version: 2 as const,
    validate_request: validateStagingConnectorRehearsalRequestV2,
    validate_response: validateStagingConnectorRehearsalResponseV2,
    receipt_kind: 'echo-staging-connector-rehearsal-receipt-v2' as const,
  });
}

export function validateStagingConnectorRehearsalProfile(value: unknown): StagingConnectorRehearsalProfile {
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && (value as { schema_version?: unknown }).schema_version === 2) {
    return validateStagingConnectorRehearsalProfileV2(value);
  }
  return validateStagingConnectorRehearsalProfileV1(value);
}
