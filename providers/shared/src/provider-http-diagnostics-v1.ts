import { annotateCoreRuntimeV1, observeCoreRuntimeV1, withoutCoreRuntimeContentV1, type CoreRuntimeCountsV1, type CoreRuntimeDetailV1 } from '@echo-brain/organization-authority-kernel/shared/core-runtime-observation-v1';

type UpstreamService = NonNullable<CoreRuntimeDetailV1['upstream_service']>;
type UpstreamOperation = NonNullable<CoreRuntimeDetailV1['upstream_operation']>;
type UpstreamRateLimitReason = NonNullable<CoreRuntimeDetailV1['upstream_rate_limit_reason']>;

export function providerUpstreamServiceV1(toolId: string): Exclude<UpstreamService, 'nango'> {
  if (toolId === 'jira' || toolId === 'confluence' || toolId === 'granola') return toolId;
  return 'other';
}

function decimal(value: string | null): number | undefined {
  if (value === null || !/^(?:0|[1-9][0-9]{0,14})$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function retryAfterSeconds(value: string | null, now: number): number | undefined {
  const seconds = decimal(value);
  if (seconds !== undefined) return seconds;
  // Admit only canonical IMF-fixdate, without preserving the original header.
  if (value === null || !/^[A-Z][a-z]{2}, [0-9]{2} [A-Z][a-z]{2} [0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2} GMT$/.test(value)) return undefined;
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed) || new Date(parsed).toUTCString() !== value) return undefined;
  return Math.max(0, Math.ceil((parsed - now) / 1000));
}

function resetUnixSeconds(value: string | null): number | undefined {
  const seconds = decimal(value);
  if (seconds !== undefined) return seconds;
  // Atlassian exposes an ISO-8601 reset instant. Accept only its UTC representation.
  if (value === null || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return undefined;
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return undefined;
  const canonical = new Date(parsed).toISOString();
  if (canonical !== (value.includes('.') ? value : value.replace('Z', '.000Z'))) return undefined;
  return Math.floor(parsed / 1000);
}

function rateLimitReason(value: string | null): UpstreamRateLimitReason | undefined {
  if (value === null) return undefined;
  if (value === 'jira-burst-based' || value === 'confluence-burst-based') return 'burst';
  if (value === 'jira-quota-global-based' || value === 'confluence-quota-global-based') return 'global_quota';
  if (value === 'jira-quota-tenant-based' || value === 'confluence-quota-tenant-based') return 'tenant_quota';
  if (value === 'jira-per-issue-on-write') return 'per_issue_write';
  return 'other';
}

/**
 * Converts only finite, non-sensitive HTTP rate-limit metadata to telemetry.
 * Response text, URLs, provider IDs, and credentials are deliberately not read.
 */
export function providerHttpResponseDiagnosticsV1(response: Pick<Response, 'status' | 'headers'>, now = Date.now()): { readonly counts: CoreRuntimeCountsV1; readonly upstream_rate_limit_reason?: UpstreamRateLimitReason } {
  const counts: CoreRuntimeCountsV1 = { http_status: response.status };
  try {
    const retryAfter = retryAfterSeconds(response.headers.get('retry-after'), now);
    const limit = decimal(response.headers.get('x-ratelimit-limit'));
    const remaining = decimal(response.headers.get('x-ratelimit-remaining'));
    const reset = resetUnixSeconds(response.headers.get('x-ratelimit-reset'));
    if (retryAfter !== undefined) counts.upstream_retry_after_seconds = retryAfter;
    if (limit !== undefined) counts.upstream_rate_limit = limit;
    if (remaining !== undefined) counts.upstream_rate_remaining = remaining;
    if (reset !== undefined) counts.upstream_rate_reset_unix_seconds = reset;
    const reason = rateLimitReason(response.headers.get('ratelimit-reason'));
    return reason === undefined ? { counts } : { counts, upstream_rate_limit_reason: reason };
  } catch { return { counts }; }
}

/** Each upstream exchange gets a child span, so overlapping provider calls retain their own status and quota hints. */
export function observeProviderHttpRequestV1<T extends Response>(input: { readonly upstream_service: UpstreamService; readonly upstream_operation: UpstreamOperation }, operation: () => Promise<T>): Promise<T> {
  return withoutCoreRuntimeContentV1(() => observeCoreRuntimeV1('http_request', async () => {
    annotateCoreRuntimeV1(input);
    const response = await operation();
    annotateCoreRuntimeV1(providerHttpResponseDiagnosticsV1(response));
    return response;
  }));
}
