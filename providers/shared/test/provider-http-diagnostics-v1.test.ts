import { describe, expect, it, vi } from 'vitest';
import { captureCoreRuntimeContentV1, observeCoreRuntimeV1, type CoreRuntimeObservationV1 } from '@echo-brain/organization-authority-kernel/shared/core-runtime-observation-v1';
import { observeProviderHttpRequestV1, providerHttpResponseDiagnosticsV1 } from '../src/provider-http-diagnostics-v1.js';

describe('provider HTTP diagnostics', () => {
  it('keeps concurrent Nango and Atlassian 429s in distinct, finite child spans', async () => {
    const events: CoreRuntimeObservationV1[] = [];
    await observeCoreRuntimeV1('ask_request', () => Promise.all([
      observeProviderHttpRequestV1({ upstream_service: 'nango', upstream_operation: 'connection_read' }, async () =>
        new Response('private Nango body', { status: 429, headers: { 'Retry-After': '41', 'X-RateLimit-Limit': '200', 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': '1767225600' } })),
      observeProviderHttpRequestV1({ upstream_service: 'jira', upstream_operation: 'provider_read' }, async () =>
        new Response('private Atlassian body', { status: 429, headers: { 'Retry-After': '42', 'X-RateLimit-Limit': '1000', 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': '2026-01-01T00:01:00Z', 'RateLimit-Reason': 'jira-burst-based' } })),
    ]), { observer: event => { events.push(event); } });
    const ended = events.filter(event => event.event === 'succeeded' && event.phase === 'http_request');
    expect(ended).toHaveLength(2);
    expect(new Set(ended.map(event => event.span_id)).size).toBe(2);
    expect(ended).toEqual(expect.arrayContaining([
      expect.objectContaining({ upstream_service: 'nango', upstream_operation: 'connection_read', counts: expect.objectContaining({ http_status: 429, upstream_retry_after_seconds: 41, upstream_rate_limit: 200, upstream_rate_remaining: 0, upstream_rate_reset_unix_seconds: 1767225600 }) }),
      expect.objectContaining({ upstream_service: 'jira', upstream_operation: 'provider_read', upstream_rate_limit_reason: 'burst', counts: expect.objectContaining({ http_status: 429, upstream_retry_after_seconds: 42, upstream_rate_limit: 1000, upstream_rate_remaining: 0, upstream_rate_reset_unix_seconds: 1767225660 }) }),
    ]));
  });

  it('converts canonical date headers using the supplied clock and rejects impossible dates', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(providerHttpResponseDiagnosticsV1(new Response(null, { status: 429, headers: {
      'Retry-After': 'Thu, 01 Jan 2026 00:00:42 GMT', 'X-RateLimit-Reset': '2026-01-01T00:01:00.000Z',
    } }), now)).toEqual({ counts: { http_status: 429, upstream_retry_after_seconds: 42, upstream_rate_reset_unix_seconds: 1767225660 } });
    expect(providerHttpResponseDiagnosticsV1(new Response(null, { status: 429, headers: {
      'Retry-After': 'Tue, 31 Feb 2026 00:00:00 GMT', 'X-RateLimit-Reset': '2026-02-31T00:00:00Z',
    } }), now)).toEqual({ counts: { http_status: 429 } });
  });

  it('rejects malformed rate-limit fields without retaining raw header values', () => {
    const diagnostics = providerHttpResponseDiagnosticsV1(new Response(null, { status: 429, headers: {
      'Retry-After': '-2', 'X-RateLimit-Limit': '10.5', 'X-RateLimit-Remaining': 'private-value',
      'X-RateLimit-Reset': 'not-a-date', 'RateLimit-Reason': 'private-provider-code',
    } }), Date.parse('2026-01-01T00:00:00Z'));
    expect(diagnostics).toEqual({ counts: { http_status: 429 }, upstream_rate_limit_reason: 'other' });
  });

  it('does not let a malformed response-header implementation change the provider exchange', () => {
    const response = { status: 429, headers: { get() { throw new Error('private header failure'); } } } as unknown as Pick<Response, 'status' | 'headers'>;
    expect(providerHttpResponseDiagnosticsV1(response)).toEqual({ counts: { http_status: 429 } });
  });

  it('works with telemetry disabled and excludes content capture from the provider exchange', async () => {
    await expect(observeProviderHttpRequestV1({ upstream_service: 'confluence', upstream_operation: 'provider_read' }, async () => new Response('private response body', { status: 429 }))).resolves.toBeInstanceOf(Response);
    const captured = vi.fn();
    await observeCoreRuntimeV1('ask_request', () => observeProviderHttpRequestV1({ upstream_service: 'confluence', upstream_operation: 'provider_read' }, async () => {
      captureCoreRuntimeContentV1('model_response', { body: 'private response body' });
      return new Response('private response body', { status: 429 });
    }), { observer: () => undefined, content_observer: captured });
    expect(captured).not.toHaveBeenCalled();
  });
});
