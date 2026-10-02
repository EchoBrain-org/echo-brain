import { describe, expect, it, vi } from 'vitest';
import type { PersonConnectorReadBindingV1 } from '@echo-brain/organization-authority-kernel/shared/person-live-evidence-v1';
import { createSlackContextTransportV1, SLACK_CONTEXT_RESPONSE_MAX_BYTES_V1, type SlackContextRequestV1 } from '../../src/context/slack-context-transport-v1.js';

const binding: PersonConnectorReadBindingV1 = { organization_id: 'org-test', principal_id: 'person-test', membership_id: 'membership-test',
  tool_id: 'slack', external_scope_id: 'TTEST123', external_subject_id: 'UHUMAN123', read_grant_sha256: `sha256:${'a'.repeat(64)}` };
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json; charset=utf-8' } });

describe('bounded Slack context transport V1', () => {
  it('fixes API origin, method and selectors while preserving the authorized fetch and cancellation', async () => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => json({ ok: true, messages: [] }));
    const transport = createSlackContextTransportV1({ binding, fetch });
    const controller = new AbortController();
    await transport.request({ method: 'conversations.history', query: { channel: 'CTEST123', limit: '1', cursor: 'next==' }, signal: controller.signal });
    expect(fetch).toHaveBeenCalledWith('https://slack.com/api/conversations.history?channel=CTEST123&limit=1&cursor=next%3D%3D',
      expect.objectContaining({ method: 'GET', redirect: 'error', signal: expect.any(AbortSignal), headers: { Accept: 'application/json' } }));
    controller.abort();
    expect(fetch.mock.calls[0]![1].signal!.aborted).toBe(true);
  });

  it('refuses write endpoints, arbitrary URLs and unbounded or unexpected selectors without fetching', async () => {
    const fetch = vi.fn(async () => json({ ok: true }));
    const transport = createSlackContextTransportV1({ binding, fetch });
    const requests = [
      { method: 'chat.postMessage' }, { method: 'https://evil.example/' }, { method: 'auth.test', query: { token: 'private' } },
      { method: 'conversations.info', query: { channel: 'https://evil.example/' } },
      { method: 'conversations.history', query: { channel: 'CTEST123', limit: '16' } },
      { method: 'conversations.history', query: { channel: 'CTEST123', limit: '1', oldest: '1790966400.000001' } },
      { method: 'conversations.history', query: { channel: 'CTEST123', limit: '1', cursor: 'x'.repeat(4097) } },
      { method: 'chat.getPermalink', query: { channel: 'CTEST123', message_ts: '../message' } },
    ];
    for (const request of requests) await expect(transport.request(request as SlackContextRequestV1)).rejects.toMatchObject({ code: 'invalid_request' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([[401, 'unauthorized'], [403, 'unauthorized'], [404, 'not_found'], [429, 'rate_limited'], [503, 'unavailable']])('classifies HTTP %s without parsing private response diagnostics', async (status, code) => {
    const transport = createSlackContextTransportV1({ binding, fetch: async () => new Response('private provider detail', { status: Number(status) }) });
    await expect(transport.request({ method: 'auth.test' })).rejects.toMatchObject({ code, message: 'Slack context capture could not be completed' });
  });

  it.each([['missing_scope', 'unauthorized'], ['invalid_auth', 'unauthorized'], ['ratelimited', 'rate_limited'], ['channel_not_found', 'not_found'], ['invalid_cursor', 'invalid_request']])('classifies Slack %s without leaking diagnostics', async (error, code) => {
    const transport = createSlackContextTransportV1({ binding, fetch: async () => json({ ok: false, error, private: 'provider detail' }) });
    await expect(transport.request({ method: 'auth.test' })).rejects.toMatchObject({ code, message: 'Slack context capture could not be completed' });
  });

  it('refuses malformed JSON, invalid UTF-8, oversized declared and streamed bodies, and wrong media type', async () => {
    for (const response of [new Response('{', { headers: { 'content-type': 'application/json' } }),
      new Response(new Uint8Array([0xff]), { headers: { 'content-type': 'application/json' } }),
      new Response('{}', { headers: { 'content-type': 'text/html' } }),
      new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': String(SLACK_CONTEXT_RESPONSE_MAX_BYTES_V1 + 1) } }),
      new Response('x'.repeat(SLACK_CONTEXT_RESPONSE_MAX_BYTES_V1 + 1), { headers: { 'content-type': 'application/json' } })]) {
      const transport = createSlackContextTransportV1({ binding, fetch: async () => response });
      await expect(transport.request({ method: 'auth.test' })).rejects.toMatchObject({ code: 'invalid_output' });
    }
  });

  it('refuses response-origin and authorization drift before returning any data', async () => {
    const changedOrigin = json({ ok: true });
    Object.defineProperty(changedOrigin, 'url', { value: 'https://evil.example/' });
    await expect(createSlackContextTransportV1({ binding, fetch: async () => changedOrigin }).request({ method: 'auth.test' })).rejects.toMatchObject({ code: 'invalid_output' });
    const authenticated = { binding: { ...binding }, fetch: vi.fn(async () => json({ ok: true })) };
    const transport = createSlackContextTransportV1(authenticated);
    authenticated.binding.read_grant_sha256 = `sha256:${'b'.repeat(64)}`;
    await expect(transport.request({ method: 'auth.test' })).rejects.toMatchObject({ code: 'stale_access_state' });
    expect(authenticated.fetch).not.toHaveBeenCalled();
  });

  it('does not emit partial context when cancelled before fetch or during streaming', async () => {
    const controller = new AbortController();
    const fetch = vi.fn(async () => json({ ok: true }));
    controller.abort();
    await expect(createSlackContextTransportV1({ binding, fetch }).request({ method: 'auth.test', signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch).not.toHaveBeenCalled();
    const midway = new AbortController();
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ pull(target) { target.enqueue(new TextEncoder().encode('{"ok":')); midway.abort(); }, cancel });
    const transport = createSlackContextTransportV1({ binding, fetch: async () => new Response(stream, { headers: { 'content-type': 'application/json' } }) });
    await expect(transport.request({ method: 'auth.test', signal: midway.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancel).toHaveBeenCalledOnce();
  });
});
