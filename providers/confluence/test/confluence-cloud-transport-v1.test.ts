import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import type { PersonConnectorReadBindingV1 } from '@echo-brain/organization-authority-kernel/shared/person-live-evidence-v1';
import { CONFLUENCE_RESPONSE_MAX_BYTES_V1, createConfluenceCloudTransportV1, type ConfluenceCloudRequestV1 } from '../src/confluence-cloud-transport-v1.js';

const cloud = '00000000-0000-4000-8000-000000000007';
const binding: PersonConnectorReadBindingV1 = Object.freeze({
  organization_id: 'synthetic-org', principal_id: 'synthetic-person', membership_id: 'synthetic-membership',
  tool_id: 'confluence', external_scope_id: cloud, external_subject_id: 'synthetic-account',
  read_grant_sha256: canonicalSha256({ synthetic_grant: 1 }),
});
const prefix = `https://api.atlassian.com/ex/confluence/${cloud}/wiki`;
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const message = 'Confluence live evidence operation could not be completed';
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
afterEach(() => { vi.restoreAllMocks(); });

describe('bounded read-only Confluence Cloud transport', () => {
  it('pins each supported endpoint to its tenant and permits only adapter-owned selectors', async () => {
    const fetch = vi.fn(async (url: string, _init: RequestInit) => {
      const response = json({ ok: true });
      Object.defineProperty(response, 'url', { value: url });
      return response;
    });
    const transport = createConfluenceCloudTransportV1({ binding, fetch });
    const cases: Array<[ConfluenceCloudRequestV1, string]> = [
      [{ path: '/oauth/token/accessible-resources' }, 'https://api.atlassian.com/oauth/token/accessible-resources'],
      [{ path: '/rest/api/user/current' }, `${prefix}/rest/api/user/current`],
      [{ path: '/api/v2/pages', query: { limit: '20', status: ['current', 'archived', 'deleted', 'trashed'], cursor: 'opaque+/=' } }, `${prefix}/api/v2/pages?limit=20&status=current&status=archived&status=deleted&status=trashed&cursor=opaque%2B%2F%3D`],
      [{ path: '/api/v2/pages/123', query: { 'body-format': 'atlas_doc_format', status: ['draft', 'historical'] } }, `${prefix}/api/v2/pages/123?body-format=atlas_doc_format&status=draft&status=historical`],
      [{ path: '/api/v2/pages', query: { 'space-id': ['42', '43'], limit: '250' } }, `${prefix}/api/v2/pages?space-id=42%2C43&limit=250`],
      [{ path: '/api/v2/spaces', query: { limit: '100', cursor: 'opaque' } }, `${prefix}/api/v2/spaces?limit=100&cursor=opaque`],
      [{ path: '/api/v2/spaces/42' }, `${prefix}/api/v2/spaces/42`],
      [{ path: '/api/v2/spaces/42/pages', query: { status: 'current', limit: '1' } }, `${prefix}/api/v2/spaces/42/pages?status=current&limit=1`],
      [{ path: '/rest/api/search', query: { cql: 'type = page AND text ~ "EVT"', limit: '20', expand: 'content', includeArchivedSpaces: 'true', cursor: 'opaque' } }, `${prefix}/rest/api/search?cql=type+%3D+page+AND+text+%7E+%22EVT%22&limit=20&expand=content&includeArchivedSpaces=true&cursor=opaque`],
    ];
    for (const [request, expected] of cases) {
      expect(await transport.request(request)).toEqual({ ok: true });
      expect(fetch).toHaveBeenLastCalledWith(expected, expect.objectContaining({
        method: 'GET', redirect: 'error', headers: { Accept: 'application/json' }, signal: expect.any(AbortSignal),
      }));
      expect(fetch.mock.calls.at(-1)![1]).not.toHaveProperty('body');
    }
  });

  it.each([
    'https://evil.example.test/api/v2/pages', '//evil.example.test/api/v2/pages',
    `/ex/confluence/${cloud}/wiki/api/v2/pages`, '/api/v2/pages/123/../../spaces',
    '/api/v2/pages/%2e%2e', '/api/v2/pages/123%2f..', '/api/v2/pages/123\\..\\spaces',
    '/api/v2/pages/0', '/api/v2/pages/001', '/api/v2/pages/123/comments', '/api/v2/pages/123/attachments',
    '/api/v2/pages?limit=1', '/api/v2/pages#fragment', '/api/v2/pages/', '/rest/api/content',
    '/rest/api/user?accountId=other', '/rest/api/user/current/..', '/oauth/token/accessible-resources?scope=other',
  ])('rejects unsafe or unapproved path %s before fetch', async path => {
    const fetch = vi.fn();
    await expect(createConfluenceCloudTransportV1({ binding, fetch }).request({ path })).rejects.toMatchObject({ code: 'invalid_request', message });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses writes, endpoint-inappropriate selectors, malformed values, and malformed status and space arrays', async () => {
    const fetch = vi.fn();
    const transport = createConfluenceCloudTransportV1({ binding, fetch });
    const invalid: unknown[] = [
      { path: '/api/v2/pages', method: 'POST', body: { title: 'never written' } },
      { path: '/api/v2/pages', method: 'DELETE' },
      { path: '/api/v2/pages', body: {} },
      { path: '/rest/api/user/current', query: { accountId: 'someone-else' } },
      { path: '/oauth/token/accessible-resources', query: { limit: '1' } },
      { path: '/api/v2/pages', query: { unknown: undefined } },
      { path: '/api/v2/pages', query: { limit: '251' } },
      { path: '/api/v2/pages', query: { limit: '0' } },
      { path: '/api/v2/pages', query: { limit: '1&token=private' } },
      { path: '/api/v2/pages', query: { limit: ['1', '2'] } },
      { path: '/api/v2/pages', query: { cursor: 'x'.repeat(4097) } },
      { path: '/api/v2/pages', query: { cursor: 'secret\nheader' } },
      { path: '/api/v2/pages', query: { status: ['current', 'current'] } },
      { path: '/api/v2/pages', query: { status: [] } },
      { path: '/api/v2/pages', query: { status: ['draft'] } },
      { path: '/api/v2/pages', query: { 'space-id': [] } },
      { path: '/api/v2/pages', query: { 'space-id': ['42', '42'] } },
      { path: '/api/v2/pages', query: { 'space-id': ['42', '../43'] } },
      { path: '/api/v2/pages', query: { 'space-id': Array.from({ length: 101 }, (_, i) => String(i + 1)) } },
      { path: '/api/v2/spaces/42/pages', query: { 'space-id': ['43'] } },
      { path: '/api/v2/pages', query: { status: ['current', 'unknown'] } },
      { path: '/api/v2/pages', query: { status: 'current,trashed' } },
      { path: '/api/v2/pages', query: { 'body-format': 'atlas_doc_format' } },
      { path: '/api/v2/pages/123', query: { 'body-format': 'view' } },
      { path: '/api/v2/spaces', query: { status: ['current'] } },
      { path: '/api/v2/spaces/42', query: { cursor: 'opaque' } },
      { path: '/rest/api/search', query: { expand: 'content.body.storage' } },
      { path: '/rest/api/search', query: { cql: '' } },
      { path: '/rest/api/search', query: { includeArchivedSpaces: 'yes' } },
      { path: '/rest/api/search', query: { cql: 'x'.repeat(4097) } },
    ];
    for (const input of invalid) await expect(transport.request(input as ConfluenceCloudRequestV1)).rejects.toMatchObject({ code: 'invalid_request', message });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses a malformed tenant binding before any request can be created', () => {
    const fetch = vi.fn();
    for (const external_scope_id of ['../jira/cloud', 'tenant?token=private', 'https://evil.test', '']) {
      expect(() => createConfluenceCloudTransportV1({ binding: { ...binding, external_scope_id }, fetch })).toThrow(message);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([[401, 'unauthorized'], [403, 'unauthorized'], [404, 'not_found'], [429, 'rate_limited'], [500, 'unavailable'], [302, 'unavailable'], [204, 'unavailable']])('sanitizes HTTP %i and cancels its body', async (status, code) => {
    const cancel = vi.fn();
    const body = Number(status) === 204 ? null : new ReadableStream<Uint8Array>({ cancel });
    const transport = createConfluenceCloudTransportV1({ binding, fetch: async () => new Response(body, { status: Number(status) }) });
    await expect(transport.request({ path: '/rest/api/user/current' })).rejects.toMatchObject({ code, message });
    if (body !== null) expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('sanitizes network/provider exceptions without retries or leaking their text', async () => {
    const fetch = vi.fn(async () => { throw new Error('synthetic-secret provider response'); });
    await expect(createConfluenceCloudTransportV1({ binding, fetch }).request({ path: '/api/v2/pages' })).rejects.toMatchObject({ code: 'unavailable', message });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(['https://evil.example.test', `${prefix}/api/v2/pages/other`, `${prefix}/api/v2/pages?unexpected=1`])('refuses unexpected final response URL %s', async url => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }), { headers: { 'content-type': 'application/json' } });
    Object.defineProperty(response, 'url', { value: url });
    const transport = createConfluenceCloudTransportV1({ binding, fetch: async () => response });
    await expect(transport.request({ path: '/api/v2/pages' })).rejects.toMatchObject({ code: 'invalid_output', message });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('refuses responses that report having followed a redirect, even back to the exact URL', async () => {
    const response = json({});
    Object.defineProperties(response, { redirected: { value: true }, url: { value: `${prefix}/api/v2/pages` } });
    await expect(createConfluenceCloudTransportV1({ binding, fetch: async () => response }).request({ path: '/api/v2/pages' })).rejects.toMatchObject({ code: 'invalid_output' });
  });

  it('rejects malformed JSON, invalid UTF-8, unsafe media types and declared oversize before releasing content', async () => {
    const values = [
      new Response('{bad', { headers: { 'content-type': 'application/json' } }),
      new Response(new Uint8Array([0xff]), { headers: { 'content-type': 'application/json' } }),
      new Response('{}', { headers: { 'content-type': 'text/html' } }),
      new Response('{}', { headers: { 'content-type': 'application/json-secret' } }),
      new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '-1' } }),
      new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': String(CONFLUENCE_RESPONSE_MAX_BYTES_V1 + 1) } }),
      new Response(null, { headers: { 'content-type': 'application/json' } }),
    ];
    for (const response of values) await expect(createConfluenceCloudTransportV1({ binding, fetch: async () => response }).request({ path: '/api/v2/pages' })).rejects.toMatchObject({ code: 'invalid_output', message });
    expect(await createConfluenceCloudTransportV1({ binding, fetch: async () => new Response('{}', { headers: { 'content-type': 'application/vendor+json; charset=utf-8' } }) }).request({ path: '/api/v2/pages' })).toEqual({});
  });

  it('bounds the streamed body even when content-length lies and cancels oversized streams', async () => {
    const cancel = vi.fn();
    let chunks = 0;
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) { chunks += 1; controller.enqueue(new Uint8Array(600_000)); }, cancel,
    }), { headers: { 'content-type': 'application/json', 'content-length': '1' } });
    await expect(createConfluenceCloudTransportV1({ binding, fetch: async () => response }).request({ path: '/api/v2/pages' })).rejects.toMatchObject({ code: 'invalid_output', message });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(chunks).toBeLessThanOrEqual(3);
  });

  it('detects authorization changes before fetch and after body consumption', async () => {
    const authenticated = { binding: { ...binding }, fetch: vi.fn(async () => json({})) };
    const transport = createConfluenceCloudTransportV1(authenticated);
    authenticated.binding.read_grant_sha256 = canonicalSha256({ replacement: true });
    await expect(transport.request({ path: '/api/v2/pages' })).rejects.toMatchObject({ code: 'stale_access_state' });
    expect(authenticated.fetch).not.toHaveBeenCalled();
    const changed = { binding: { ...binding }, fetch: async () => {
      const response = json({ private: 'must not escape' });
      changed.binding.read_grant_sha256 = canonicalSha256({ revoked: true });
      return response;
    } };
    await expect(createConfluenceCloudTransportV1(changed).request({ path: '/api/v2/pages' })).rejects.toMatchObject({ code: 'stale_access_state' });
  });

  it('does not fetch for an already-aborted caller signal', async () => {
    const controller = new AbortController(); controller.abort();
    const fetch = vi.fn();
    await expect(createConfluenceCloudTransportV1({ binding, fetch }).request({ path: '/api/v2/pages', signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('honors caller cancellation during a stalled stream and closes it without awaiting a stuck cancel', async () => {
    const controller = new AbortController();
    const reading = deferred<void>();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const response = new Response(new ReadableStream<Uint8Array>({ pull() { reading.resolve(); }, cancel }, { highWaterMark: 0 }), { headers: { 'content-type': 'application/json' } });
    const pending = createConfluenceCloudTransportV1({ binding, fetch: async () => response }).request({ path: '/api/v2/pages', signal: controller.signal });
    await reading.promise; controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(response.body!.locked).toBe(false);
  });

  it('applies its 15-second deadline while fetch ignores cancellation and disposes a late response', async () => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    const late = deferred<Response>();
    const fetch = vi.fn(() => late.promise);
    const pending = createConfluenceCloudTransportV1({ binding, fetch }).request({ path: '/api/v2/pages' });
    expect(timeout).toHaveBeenCalledWith(15_000);
    deadline.abort(new DOMException('synthetic deadline', 'TimeoutError'));
    await expect(pending).rejects.toMatchObject({ code: 'unavailable', message });
    const cancel = vi.fn();
    late.resolve(new Response(new ReadableStream<Uint8Array>({ cancel })));
    await Promise.resolve(); await Promise.resolve();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps the same deadline active through a body read that never resolves', async () => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    const reading = deferred<void>();
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({ pull() { reading.resolve(); }, cancel }, { highWaterMark: 0 }), { headers: { 'content-type': 'application/json' } });
    const pending = createConfluenceCloudTransportV1({ binding, fetch: async () => response }).request({ path: '/api/v2/pages' });
    await reading.promise;
    deadline.abort(new DOMException('synthetic deadline', 'TimeoutError'));
    await expect(pending).rejects.toMatchObject({ code: 'unavailable', message });
    expect(timeout).toHaveBeenCalledTimes(1);
    expect(timeout).toHaveBeenCalledWith(15_000);
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
