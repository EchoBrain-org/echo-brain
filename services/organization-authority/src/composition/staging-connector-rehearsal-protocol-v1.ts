/** Closed staging-only protocol. It carries configuration and receipts, never source contents. */
export const STAGING_CONNECTOR_REHEARSAL_PATH_V1 = '/v1/staging/connector-rehearsal';
export const STAGING_CONNECTOR_REHEARSAL_POLICY_V1 = 'initial-owner-granola-retained-jira-request-only-v1';
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const CONTENT_SHA256 = /^[a-f0-9]{64}$/;
const RELEASE = /^clean-v1-[a-z0-9][a-z0-9-]{2,63}$/;

export interface StagingConnectorRehearsalProfileV1 {
  readonly schema_version: 1;
  readonly kind: 'echo-staging-connector-rehearsal-profile-v1';
  readonly capture_policy: typeof STAGING_CONNECTOR_REHEARSAL_POLICY_V1;
  readonly jira: { readonly cloud_id: string; readonly integration_key: string; readonly project: string };
}

interface BindingV1 {
  readonly schema_version: 1;
  readonly release_id: string;
  readonly profile_sha256: `sha256:${string}`;
}
export type StagingConnectorRehearsalRequestV1 = BindingV1 & (
  | { readonly action: 'status' }
  | { readonly action: 'capture'; readonly tool: 'granola' | 'jira'; readonly limit: number }
);
export interface StagingConnectorCaptureReceiptV1 {
  readonly schema_version: 1;
  readonly kind: 'echo-context-capture-rehearsal-receipt-v1';
  readonly source_identity_sha256: `sha256:${string}`;
  readonly captures: readonly {
    readonly source_type: 'meeting' | 'note' | 'ticket';
    readonly admission: 'admitted' | 'duplicate' | 'request_only';
    readonly source_id_sha256: `sha256:${string}`;
    readonly revision_id_sha256: `sha256:${string}`;
    readonly content_sha256: string;
  }[];
  readonly counts: { readonly captured: number; readonly admitted: number; readonly duplicate: number; readonly request_only: number };
}
export type StagingConnectorRehearsalResponseV1 = BindingV1 & {
  readonly kind: 'echo-staging-connector-rehearsal-receipt-v1';
  /** A successful single observation does not qualify the entire provider. */
  readonly qualified: false;
} & (
  | { readonly action: 'status'; readonly processing: 'active' | 'idle_until_finalize'; readonly granola_available: boolean }
  | { readonly action: 'capture'; readonly tool: 'granola' | 'jira'; readonly receipt: StagingConnectorCaptureReceiptV1 }
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
  if (value.schema_version !== 1) invalid();
  stringMatches(value.release_id, RELEASE);
  stringMatches(value.profile_sha256, DIGEST);
}

export function validateStagingConnectorRehearsalProfileV1(value: unknown): StagingConnectorRehearsalProfileV1 {
  const profile = record(value);
  keys(profile, ['schema_version', 'kind', 'capture_policy', 'jira']);
  if (profile.schema_version !== 1 || profile.kind !== 'echo-staging-connector-rehearsal-profile-v1' ||
      profile.capture_policy !== STAGING_CONNECTOR_REHEARSAL_POLICY_V1) invalid();
  const jira = record(profile.jira);
  keys(jira, ['cloud_id', 'integration_key', 'project']);
  stringMatches(jira.cloud_id, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i);
  stringMatches(jira.integration_key, /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
  stringMatches(jira.project, /^[A-Z][A-Z0-9_]{1,31}$/);
  return Object.freeze({ schema_version: 1, kind: profile.kind, capture_policy: profile.capture_policy,
    jira: Object.freeze({ cloud_id: jira.cloud_id as string, integration_key: jira.integration_key as string, project: jira.project as string }) });
}

export function validateStagingConnectorRehearsalRequestV1(value: unknown): StagingConnectorRehearsalRequestV1 {
  const request = record(value);
  binding(request);
  if (request.action === 'status') keys(request, ['schema_version', 'release_id', 'profile_sha256', 'action']);
  else if (request.action === 'capture') {
    keys(request, ['schema_version', 'release_id', 'profile_sha256', 'action', 'tool', 'limit']);
    if ((request.tool !== 'granola' && request.tool !== 'jira') || !Number.isSafeInteger(request.limit) ||
        (request.limit as number) < 1 || (request.limit as number) > 5) invalid();
  } else invalid();
  return Object.freeze({ ...request }) as unknown as StagingConnectorRehearsalRequestV1;
}

function captureReceipt(value: unknown, tool: 'granola' | 'jira'): StagingConnectorCaptureReceiptV1 {
  const receipt = record(value);
  keys(receipt, ['schema_version', 'kind', 'source_identity_sha256', 'captures', 'counts']);
  if (receipt.schema_version !== 1 || receipt.kind !== 'echo-context-capture-rehearsal-receipt-v1' ||
      !Array.isArray(receipt.captures) || receipt.captures.length > 5) invalid();
  stringMatches(receipt.source_identity_sha256, DIGEST);
  const captures = receipt.captures.map(value => {
    const capture = record(value);
    keys(capture, ['source_type', 'admission', 'source_id_sha256', 'revision_id_sha256', 'content_sha256']);
    if (tool === 'jira' ? capture.source_type !== 'ticket' || capture.admission !== 'request_only'
      : !['meeting', 'note'].includes(capture.source_type as string) || !['admitted', 'duplicate'].includes(capture.admission as string)) invalid();
    for (const key of ['source_id_sha256', 'revision_id_sha256']) stringMatches(capture[key], DIGEST);
    stringMatches(capture.content_sha256, CONTENT_SHA256);
    return Object.freeze({ ...capture }) as unknown as StagingConnectorCaptureReceiptV1['captures'][number];
  });
  const counts = record(receipt.counts);
  keys(counts, ['captured', 'admitted', 'duplicate', 'request_only']);
  if (counts.captured !== captures.length) invalid();
  for (const outcome of ['admitted', 'duplicate', 'request_only'] as const) {
    if (counts[outcome] !== captures.filter(capture => capture.admission === outcome).length) invalid();
  }
  return Object.freeze({ schema_version: 1, kind: receipt.kind,
    source_identity_sha256: receipt.source_identity_sha256 as `sha256:${string}`,
    captures: Object.freeze(captures), counts: Object.freeze({ ...counts }) as unknown as StagingConnectorCaptureReceiptV1['counts'] });
}

export function validateStagingConnectorRehearsalResponseV1(value: unknown): StagingConnectorRehearsalResponseV1 {
  const response = record(value);
  binding(response);
  if (response.kind !== 'echo-staging-connector-rehearsal-receipt-v1' || response.qualified !== false) invalid();
  const common = ['schema_version', 'kind', 'release_id', 'profile_sha256', 'action', 'qualified'];
  if (response.action === 'status') {
    keys(response, [...common, 'processing', 'granola_available']);
    if (!['active', 'idle_until_finalize'].includes(response.processing as string) || typeof response.granola_available !== 'boolean' ||
        (response.processing === 'idle_until_finalize' && response.granola_available)) invalid();
    return Object.freeze({ ...response }) as unknown as StagingConnectorRehearsalResponseV1;
  }
  if (response.action !== 'capture' || (response.tool !== 'granola' && response.tool !== 'jira')) invalid();
  keys(response, [...common, 'tool', 'receipt']);
  return Object.freeze({ ...response, receipt: captureReceipt(response.receipt, response.tool) }) as unknown as StagingConnectorRehearsalResponseV1;
}
