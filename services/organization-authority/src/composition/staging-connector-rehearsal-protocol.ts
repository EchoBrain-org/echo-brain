/** Closed staging-only protocol. Receipts never contain provider credentials or source text. */
export const STAGING_CONNECTOR_REHEARSAL_PATH_V1 = '/v1/staging/connector-rehearsal';
// Historical profile identifier: preserve its digest and sidecar binding. It no longer
// authorizes Jira or Slack capture; tools support verify-read only.
export const STAGING_CONNECTOR_REHEARSAL_POLICY_V2 = 'initial-owner-granola-retained-jira-pointer-slack-pointer-v2';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const CONTENT_SHA256 = /^[a-f0-9]{64}$/;
const RELEASE = /^clean-v1-[a-z0-9][a-z0-9-]{2,63}$/;

export interface StagingConnectorRehearsalProfileV2 {
  readonly schema_version: 2;
  readonly kind: 'echo-staging-connector-rehearsal-profile-v2';
  readonly capture_policy: typeof STAGING_CONNECTOR_REHEARSAL_POLICY_V2;
  readonly jira: { readonly cloud_id: string; readonly integration_key: string; readonly project: string };
  /** The sole public Slack channel selected by host-owned nonsecret configuration. */
  readonly slack: { readonly channel_id: string };
}

interface BindingV2 {
  readonly schema_version: 2;
  readonly release_id: string;
  readonly profile_sha256: `sha256:${string}`;
}
export type StagingConnectorRehearsalRequestV2 = BindingV2 & (
  | { readonly action: 'status' }
  | { readonly action: 'capture'; readonly tool: 'granola'; readonly limit: number }
  | { readonly action: 'verify-read'; readonly tool: 'jira' | 'slack' }
);
export const STAGING_CONNECTOR_READ_PHASES_V1 = ['local_authorization', 'connection', 'provider_verification', 'inventory', 'open', 'final_fence'] as const;
export const STAGING_CONNECTOR_READ_REASONS_V1 = ['connection_absent', 'identity_unlinked', 'unauthorized', 'stale_access_state', 'not_found', 'invalid_output', 'rate_limited', 'unavailable', 'cancelled', 'deadline_exceeded', 'empty', 'quota_exceeded'] as const;
export type StagingConnectorReadPhaseV1 = typeof STAGING_CONNECTOR_READ_PHASES_V1[number];
export type StagingConnectorReadReasonV1 = typeof STAGING_CONNECTOR_READ_REASONS_V1[number];
export type StagingConnectorReadResultV1 =
  | { readonly status: 'verified'; readonly source_coordinate_sha256: `sha256:${string}`; readonly text_sha256: `sha256:${string}`; readonly text_bytes: number }
  | { readonly status: 'refused'; readonly phase: StagingConnectorReadPhaseV1; readonly reason: StagingConnectorReadReasonV1 };
export interface StagingConnectorCaptureReceiptV2 {
  readonly schema_version: 1;
  readonly kind: 'echo-context-capture-rehearsal-receipt-v1';
  readonly source_identity_sha256: `sha256:${string}`;
  readonly captures: readonly {
    readonly source_type: 'meeting' | 'note';
    readonly admission: 'admitted' | 'duplicate';
    readonly source_id_sha256: `sha256:${string}`;
    readonly revision_id_sha256: `sha256:${string}`;
    readonly content_sha256: string;
  }[];
  readonly counts: { readonly captured: number; readonly admitted: number; readonly duplicate: number; readonly request_only: 0 };
}
export type StagingConnectorRehearsalResponseV2 = BindingV2 & {
  readonly kind: 'echo-staging-connector-rehearsal-receipt-v2';
  /** A successful bounded observation does not qualify an entire provider. */
  readonly qualified: false;
} & (
  | { readonly action: 'status'; readonly processing: 'active' | 'idle_until_finalize'; readonly granola_available: boolean }
  | { readonly action: 'capture'; readonly tool: 'granola'; readonly receipt: StagingConnectorCaptureReceiptV2 }
  | { readonly action: 'verify-read'; readonly tool: 'jira' | 'slack'; readonly result: StagingConnectorReadResultV1 }
);

function invalid(): never { throw new Error('Staging connector rehearsal value is invalid'); }
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
  if (value.schema_version !== 2) invalid();
  stringMatches(value.release_id, RELEASE);
  stringMatches(value.profile_sha256, DIGEST);
}

/** The profile cannot select arbitrary Slack channels, owners or provider credentials. */
export function validateStagingConnectorRehearsalProfileV2(value: unknown): StagingConnectorRehearsalProfileV2 {
  const profile = record(value);
  keys(profile, ['schema_version', 'kind', 'capture_policy', 'jira', 'slack']);
  if (profile.schema_version !== 2 || profile.kind !== 'echo-staging-connector-rehearsal-profile-v2' ||
      profile.capture_policy !== STAGING_CONNECTOR_REHEARSAL_POLICY_V2) invalid();
  const jira = record(profile.jira);
  keys(jira, ['cloud_id', 'integration_key', 'project']);
  stringMatches(jira.cloud_id, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i);
  stringMatches(jira.integration_key, /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
  stringMatches(jira.project, /^[A-Z][A-Z0-9_]{1,31}$/);
  const slack = record(profile.slack);
  keys(slack, ['channel_id']);
  // Public Slack channels use C IDs. The source additionally verifies is_private=false.
  stringMatches(slack.channel_id, /^C[A-Z0-9]{2,63}$/);
  return Object.freeze({
    schema_version: 2,
    kind: 'echo-staging-connector-rehearsal-profile-v2',
    capture_policy: STAGING_CONNECTOR_REHEARSAL_POLICY_V2,
    jira: Object.freeze({ cloud_id: jira.cloud_id as string, integration_key: jira.integration_key as string, project: jira.project as string }),
    slack: Object.freeze({ channel_id: slack.channel_id as string }),
  });
}

export function validateStagingConnectorRehearsalRequestV2(value: unknown): StagingConnectorRehearsalRequestV2 {
  const request = record(value);
  binding(request);
  if (request.action === 'status') keys(request, ['schema_version', 'release_id', 'profile_sha256', 'action']);
  else if (request.action === 'capture') {
    keys(request, ['schema_version', 'release_id', 'profile_sha256', 'action', 'tool', 'limit']);
    if (request.tool !== 'granola' || !Number.isSafeInteger(request.limit) ||
        (request.limit as number) < 1 || (request.limit as number) > 5) invalid();
  } else if (request.action === 'verify-read') {
    keys(request, ['schema_version', 'release_id', 'profile_sha256', 'action', 'tool']);
    if (!['jira', 'slack'].includes(request.tool as string)) invalid();
  } else invalid();
  return Object.freeze({ ...request }) as unknown as StagingConnectorRehearsalRequestV2;
}

function captureReceipt(value: unknown): StagingConnectorCaptureReceiptV2 {
  const receipt = record(value);
  keys(receipt, ['schema_version', 'kind', 'source_identity_sha256', 'captures', 'counts']);
  if (receipt.schema_version !== 1 || receipt.kind !== 'echo-context-capture-rehearsal-receipt-v1' ||
      !Array.isArray(receipt.captures) || receipt.captures.length > 5) invalid();
  stringMatches(receipt.source_identity_sha256, DIGEST);
  const expectedSourceTypes = ['meeting', 'note'];
  const captures = receipt.captures.map(value => {
    const capture = record(value);
    keys(capture, ['source_type', 'admission', 'source_id_sha256', 'revision_id_sha256', 'content_sha256']);
    if (!expectedSourceTypes.includes(capture.source_type as string) || !['admitted', 'duplicate'].includes(capture.admission as string)) invalid();
    for (const key of ['source_id_sha256', 'revision_id_sha256']) stringMatches(capture[key], DIGEST);
    stringMatches(capture.content_sha256, CONTENT_SHA256);
    return Object.freeze({ ...capture }) as unknown as StagingConnectorCaptureReceiptV2['captures'][number];
  });
  const counts = record(receipt.counts);
  keys(counts, ['captured', 'admitted', 'duplicate', 'request_only']);
  if (counts.captured !== captures.length || counts.request_only !== 0) invalid();
  for (const outcome of ['admitted', 'duplicate'] as const) {
    if (counts[outcome] !== captures.filter(capture => capture.admission === outcome).length) invalid();
  }
  return Object.freeze({ schema_version: 1, kind: 'echo-context-capture-rehearsal-receipt-v1',
    source_identity_sha256: receipt.source_identity_sha256 as `sha256:${string}`,
    captures: Object.freeze(captures), counts: Object.freeze({ ...counts }) as StagingConnectorCaptureReceiptV2['counts'] });
}

export function validateStagingConnectorRehearsalResponseV2(value: unknown): StagingConnectorRehearsalResponseV2 {
  const response = record(value);
  binding(response);
  if (response.kind !== 'echo-staging-connector-rehearsal-receipt-v2' || response.qualified !== false) invalid();
  const common = ['schema_version', 'kind', 'release_id', 'profile_sha256', 'action', 'qualified'];
  if (response.action === 'status') {
    keys(response, [...common, 'processing', 'granola_available']);
    if (!['active', 'idle_until_finalize'].includes(response.processing as string) || typeof response.granola_available !== 'boolean' ||
        (response.processing === 'idle_until_finalize' && response.granola_available)) invalid();
    return Object.freeze({ ...response }) as unknown as StagingConnectorRehearsalResponseV2;
  }
  if (response.action === 'verify-read') {
    keys(response, [...common, 'tool', 'result']);
    if (!['jira', 'slack'].includes(response.tool as string)) invalid();
    const result = record(response.result);
    if (result.status === 'verified') {
      keys(result, ['status', 'source_coordinate_sha256', 'text_sha256', 'text_bytes']);
      stringMatches(result.source_coordinate_sha256, DIGEST);
      stringMatches(result.text_sha256, DIGEST);
      if (!Number.isSafeInteger(result.text_bytes) || (result.text_bytes as number) < 1 || (result.text_bytes as number) > 3072) invalid();
    } else if (result.status === 'refused') {
      keys(result, ['status', 'phase', 'reason']);
      if (!STAGING_CONNECTOR_READ_PHASES_V1.includes(result.phase as StagingConnectorReadPhaseV1) ||
          !STAGING_CONNECTOR_READ_REASONS_V1.includes(result.reason as StagingConnectorReadReasonV1)) invalid();
    } else invalid();
    return Object.freeze({ ...response, result: Object.freeze({ ...result }) }) as unknown as StagingConnectorRehearsalResponseV2;
  }
  if (response.action !== 'capture' || response.tool !== 'granola') invalid();
  keys(response, [...common, 'tool', 'receipt']);
  return Object.freeze({ ...response, receipt: captureReceipt(response.receipt) }) as unknown as StagingConnectorRehearsalResponseV2;
}
