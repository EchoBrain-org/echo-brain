/** Closed staging-only Jira read protocol. V2 remains immutable historical bytes. */
export const STAGING_CONNECTOR_REHEARSAL_PATH_V1 = '/v1/staging/connector-rehearsal';
export const STAGING_CONNECTOR_REHEARSAL_POLICY_V3 = 'initial-owner-jira-pointer-v3';
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const RELEASE = /^clean-v1-[a-z0-9][a-z0-9-]{2,63}$/;
export interface StagingConnectorRehearsalProfileV3 {
  readonly schema_version: 3;
  readonly kind: 'echo-staging-connector-rehearsal-profile-v3';
  readonly read_policy: typeof STAGING_CONNECTOR_REHEARSAL_POLICY_V3;
  readonly jira: {
      readonly cloud_id: string;
      readonly integration_key: string;
      readonly project: string;
  };
}
interface BindingV3 {
  readonly schema_version: 3;
  readonly release_id: string;
  readonly profile_sha256: `sha256:${string}`;
}
export type StagingConnectorRehearsalRequestV3 = BindingV3 & ({
  readonly action: 'status';
} | {
  readonly action: 'verify-read';
  readonly tool: 'jira';
});
export const STAGING_CONNECTOR_READ_PHASES_V1 = ['local_authorization', 'connection', 'provider_verification', 'inventory', 'open', 'final_fence'] as const;
export const STAGING_CONNECTOR_READ_REASONS_V1 = ['connection_absent', 'identity_unlinked', 'unauthorized', 'stale_access_state', 'not_found', 'invalid_output', 'rate_limited', 'unavailable', 'cancelled', 'deadline_exceeded', 'empty', 'quota_exceeded'] as const;
export type StagingConnectorReadPhaseV1 = typeof STAGING_CONNECTOR_READ_PHASES_V1[number];
export type StagingConnectorReadReasonV1 = typeof STAGING_CONNECTOR_READ_REASONS_V1[number];
export type StagingConnectorReadResultV1 = {
  readonly status: 'verified';
  readonly source_coordinate_sha256: `sha256:${string}`;
  readonly text_sha256: `sha256:${string}`;
  readonly text_bytes: number;
} | {
  readonly status: 'refused';
  readonly phase: StagingConnectorReadPhaseV1;
  readonly reason: StagingConnectorReadReasonV1;
};
export type StagingConnectorRehearsalResponseV3 = BindingV3 & {
  readonly kind: 'echo-staging-connector-rehearsal-receipt-v3';
  readonly qualified: false;
} & ({
  readonly action: 'status';
  readonly processing: 'active' | 'idle_until_finalize';
} | {
  readonly action: 'verify-read';
  readonly tool: 'jira';
  readonly result: StagingConnectorReadResultV1;
});
function invalid(): never {
  throw new Error('Staging connector rehearsal value is invalid');
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, expected: readonly string[]): void {
  if (Object.keys(value).sort().join(',') !== [...expected].sort().join(',')) invalid();
}

function stringMatches(value: unknown, pattern: RegExp): void {
  if (typeof value !== 'string' || !pattern.test(value)) invalid();
}

function binding(value: Record<string, unknown>): void {
  if (value.schema_version !== 3) invalid();
  stringMatches(value.release_id, RELEASE);
  stringMatches(value.profile_sha256, DIGEST);
}

export function validateStagingConnectorRehearsalProfileV3(value: unknown): StagingConnectorRehearsalProfileV3 {
  const profile = record(value);
  keys(profile, ['schema_version', 'kind', 'read_policy', 'jira']);
  if (profile.schema_version !== 3 ||
      profile.kind !== 'echo-staging-connector-rehearsal-profile-v3' ||
      profile.read_policy !== STAGING_CONNECTOR_REHEARSAL_POLICY_V3) invalid();
  const jira = record(profile.jira);
  keys(jira, ['cloud_id', 'integration_key', 'project']);
  stringMatches(jira.cloud_id, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i);
  stringMatches(jira.integration_key, /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
  stringMatches(jira.project, /^[A-Z][A-Z0-9_]{1,31}$/);
  return Object.freeze({
    schema_version: 3,
    kind: 'echo-staging-connector-rehearsal-profile-v3',
    read_policy: STAGING_CONNECTOR_REHEARSAL_POLICY_V3,
    jira: Object.freeze({
      cloud_id: jira.cloud_id as string,
      integration_key: jira.integration_key as string,
      project: jira.project as string,
    }),
  });
}

export function validateStagingConnectorRehearsalRequestV3(value: unknown): StagingConnectorRehearsalRequestV3 {
  const request = record(value);
  binding(request);
  if (request.action === 'status') {
    keys(request, ['schema_version', 'release_id', 'profile_sha256', 'action']);
  } else if (request.action === 'verify-read') {
    keys(request, ['schema_version', 'release_id', 'profile_sha256', 'action', 'tool']);
    if (request.tool !== 'jira') invalid();
  } else {
    invalid();
  }
  return Object.freeze({ ...request }) as unknown as StagingConnectorRehearsalRequestV3;
}

export function validateStagingConnectorRehearsalResponseV3(value: unknown): StagingConnectorRehearsalResponseV3 {
  const response = record(value);
  binding(response);
  if (response.kind !== 'echo-staging-connector-rehearsal-receipt-v3' || response.qualified !== false) invalid();
  const common = ['schema_version', 'kind', 'release_id', 'profile_sha256', 'action', 'qualified'];
  if (response.action === 'status') {
    keys(response, [...common, 'processing']);
    if (!['active', 'idle_until_finalize'].includes(response.processing as string)) invalid();
    return Object.freeze({ ...response }) as unknown as StagingConnectorRehearsalResponseV3;
  }
  if (response.action !== 'verify-read' || response.tool !== 'jira') invalid();
  keys(response, [...common, 'tool', 'result']);
  const result = record(response.result);
  if (result.status === 'verified') {
    keys(result, ['status', 'source_coordinate_sha256', 'text_sha256', 'text_bytes']);
    stringMatches(result.source_coordinate_sha256, DIGEST);
    stringMatches(result.text_sha256, DIGEST);
    if (!Number.isSafeInteger(result.text_bytes) ||
        (result.text_bytes as number) < 1 || (result.text_bytes as number) > 3072) invalid();
  } else if (result.status === 'refused') {
    keys(result, ['status', 'phase', 'reason']);
    if (!STAGING_CONNECTOR_READ_PHASES_V1.includes(result.phase as StagingConnectorReadPhaseV1) ||
        !STAGING_CONNECTOR_READ_REASONS_V1.includes(result.reason as StagingConnectorReadReasonV1)) invalid();
  } else {
    invalid();
  }
  return Object.freeze({ ...response, result: Object.freeze({ ...result }) }) as unknown as StagingConnectorRehearsalResponseV3;
}
