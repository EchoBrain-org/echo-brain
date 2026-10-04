import { describe, expect, it, vi } from 'vitest';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import type { PersonConnectorReadBindingV1 } from '@echo-brain/organization-authority-kernel/shared/person-live-evidence-v1';
import { createJiraCloudTransportV1, JIRA_RESPONSE_MAX_BYTES_V1, type JiraCloudRequestV1 } from '../src/jira-cloud-transport-v1.js';

const cloudid = '00000000-0000-4000-8000-000000000007';
const binding: PersonConnectorReadBindingV1 = { organization_id: 'synthetic-org', principal_id: 'synthetic-person', membership_id: 'synthetic-membership', tool_id: 'jira',
  external_scope_id: cloudid, external_subject_id: 'synthetic-account', read_grant_sha256: canonicalSha256({ synthetic_grant: 1 }) };
const prefix = `/ex/jira/${cloudid}/rest/api/3`;
const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

describe('bounded direct Jira Cloud transport', () => {
  it('pins URL routing to the trusted cloudid and preserves abort, redirect refusal and authenticated fetch', async () => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => response({ id: '10001' }));
    const transport = createJiraCloudTransportV1({ binding, fetch }); const controller = new AbortController();
    expect(await transport.request({ path: `${prefix}/issue/10001`, query: { fields: 'summary,project' }, signal: controller.signal })).toEqual({ id: '10001' });
    expect(fetch).toHaveBeenCalledWith(`https://api.atlassian.com${prefix}/issue/10001?fields=summary%2Cproject`, expect.objectContaining({ method: 'GET', redirect: 'error', headers: { Accept: 'application/json' }, signal: expect.any(AbortSignal) }));
    const signal = fetch.mock.calls[0]![1].signal!;
    controller.abort(); expect(signal.aborted).toBe(true);
    await transport.request({ path: `${prefix}/search/jql`, method: 'POST', body: { jql: 'project = 10000', maxResults: 1 } });
    expect(fetch.mock.calls.at(-1)![1]).toMatchObject({ method: 'POST', redirect: 'error', body: '{"jql":"project = 10000","maxResults":1}', headers: { 'Content-Type': 'application/json' } });
    await transport.request({ path: `${prefix}/project/KAN`, query: { expand: 'projectKeys' } });
    expect(fetch).toHaveBeenLastCalledWith(`https://api.atlassian.com${prefix}/project/KAN?expand=projectKeys`, expect.objectContaining({ method: 'GET', redirect: 'error' }));
  });

  it('refuses another tenant, absolute/provider links, unapproved endpoints and query selectors before fetching', async () => {
    const fetch = vi.fn(async () => response({})); const transport = createJiraCloudTransportV1({ binding, fetch });
    for (const path of ['https://evil.example.test', '//evil.example.test', '/rest/api/3/myself', '/ex/jira/another/rest/api/3/myself', `${prefix}/issue/ECHO-1`, `${prefix}/issue/10001/../../myself`, `${prefix}/user`, `${prefix}/myself?person=another`, `${prefix}/myself#fragment`]) {
      await expect(transport.request({ path })).rejects.toMatchObject({ code: 'invalid_request' });
    }
    const invalidRequests: JiraCloudRequestV1[] = [{ path: `${prefix}/myself`, method: 'POST' }, { path: `${prefix}/myself`, query: { subject: 'another-person' } },
      { path: `${prefix}/issue/10001`, query: { fields: 'summary&token=synthetic' } }, { path: `${prefix}/search/jql` },
      { path: `${prefix}/issue/10001`, query: { expand: 'projectKeys' } },
      { path: `${prefix}/project/KAN`, query: { expand: 'projectKeys,lead' } },
      { path: `${prefix}/project/KAN`, query: { fields: 'summary' } },
      { path: `${prefix}/myself`, body: { connectionId: 'another' } }];
    for (const input of invalidRequests) await expect(transport.request(input)).rejects.toMatchObject({ code: 'invalid_request' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([[401, 'unauthorized'], [403, 'unauthorized'], [404, 'not_found'], [429, 'rate_limited'], [500, 'unavailable'], [302, 'unavailable'], [204, 'unavailable']])('maps HTTP %i without parsing or leaking provider error bodies', async (status, code) => {
    const body = status === 204 ? null : 'synthetic-private-token and private issue body';
    const fetch = vi.fn(async () => new Response(body, { status: Number(status) }));
    const transport = createJiraCloudTransportV1({ binding, fetch });
    await expect(transport.request({ path: `${prefix}/myself` })).rejects.toMatchObject({ code, message: 'Jira live evidence operation could not be completed' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('refuses malformed JSON, invalid UTF-8, response media types and oversized streamed bodies', async () => {
    const malformed = [new Response('{bad', { headers: { 'content-type': 'application/json' } }), new Response('{}', { headers: { 'content-type': 'text/html' } }),
      new Response(new Uint8Array([0xff]), { headers: { 'content-type': 'application/json' } }),
      new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': String(JIRA_RESPONSE_MAX_BYTES_V1 + 1) } }),
      new Response('x'.repeat(JIRA_RESPONSE_MAX_BYTES_V1 + 1), { headers: { 'content-type': 'application/json' } })];
    for (const value of malformed) {
      const transport = createJiraCloudTransportV1({ binding, fetch: async () => value });
      await expect(transport.request({ path: '/oauth/token/accessible-resources' })).rejects.toMatchObject({ code: 'invalid_output' });
    }
  });

  it('checks final response origin and rejects mutable authentication bindings', async () => {
    for (const redirected of [true, false]) {
      const value = response({});
      Object.defineProperty(value, redirected ? 'redirected' : 'url', { value: redirected ? true : 'https://evil.example.test' });
      const transport = createJiraCloudTransportV1({ binding, fetch: async () => value });
      await expect(transport.request({ path: `${prefix}/myself` })).rejects.toMatchObject({ code: 'invalid_output' });
    }
    const authenticated = { binding: { ...binding }, fetch: vi.fn(async () => response({})) };
    const transport = createJiraCloudTransportV1(authenticated);
    authenticated.binding.read_grant_sha256 = canonicalSha256({ replacement: true });
    await expect(transport.request({ path: `${prefix}/myself` })).rejects.toMatchObject({ code: 'stale_access_state' });
    expect(authenticated.fetch).not.toHaveBeenCalled();
  });

  it('cancels before fetch and during a stream without returning partial JSON', async () => {
    const controller = new AbortController(); const fetch = vi.fn(async () => response({}));
    controller.abort(); const transport = createJiraCloudTransportV1({ binding, fetch });
    await expect(transport.request({ path: `${prefix}/myself`, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch).not.toHaveBeenCalled();
    const midway = new AbortController(); const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull(stream) { stream.enqueue(new TextEncoder().encode('{"private":')); midway.abort(); }, cancel: cancelled });
    const streaming = createJiraCloudTransportV1({ binding, fetch: async () => new Response(body, { headers: { 'content-type': 'application/json' } }) });
    await expect(streaming.request({ path: `${prefix}/myself`, signal: midway.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
});
