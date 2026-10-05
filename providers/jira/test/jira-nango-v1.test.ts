import { describe, expect, it, vi } from 'vitest';
import { createJiraNangoV1 } from '../src/jira-nango-v1.js';
const integration = 'jira-fixture';
const tags = { echo_attempt: 'attempt-fixture', organization_id: 'org-fixture', end_user_id: 'person-fixture', echo_membership: 'membership-fixture' };
const connection = { connection_id: 'reference-fixture', provider_config_key: integration, provider: 'jira', updated_at: '2026-10-01T00:00:00.000Z', tags, credentials: { type: 'OAUTH2', access_token: 'synthetic-jira-access', refresh_token: 'never-return-refresh' } };
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
function fixture() {
  const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => json(connection));
  const nango = createJiraNangoV1({ integration_id: integration, authorization: () => 'synthetic-nango-key', fetch: fetch as typeof globalThis.fetch });
  return { fetch, nango };
}
describe('Jira Nango HTTP authentication adapter', () => {
  it('preserves credential throttling without exposing the response or retrying it', async () => {
    const f = fixture();
    f.fetch.mockResolvedValueOnce(new Response('private provider body', { status: 429, headers: { 'Retry-After': '41' } }));
    await expect(f.nango.connection('reference-fixture')).rejects.toMatchObject({ code: 'rate_limited', message: 'Jira live evidence operation could not be completed' });
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });
  it('limits fresh Connect sessions to Jira and server tags/read scopes and never requests a refresh token', async () => {
    const f = fixture(); f.fetch.mockResolvedValueOnce(json({ data: { connect_link: 'https://connect.nango.dev/fixture-consent' } }));
    expect(await f.nango.connect(tags)).toEqual({ link: 'https://connect.nango.dev/fixture-consent' });
    expect(JSON.parse(f.fetch.mock.calls[0]![1]!.body as string)).toEqual({ tags, allowed_integrations: [integration], integrations_config_defaults: { [integration]: { connection_config: { oauth_scopes_override: 'offline_access read:jira-work read:jira-user' } } } });
    const result = await f.nango.connection('reference-fixture');
    expect(result).toEqual({ tags, access_token: 'synthetic-jira-access' }); expect(result).not.toHaveProperty('refresh_token'); expect(result).not.toHaveProperty('updated_at');
    expect(f.fetch.mock.calls[1]![0]).toBe('https://api.nango.dev/connections/reference-fixture?provider_config_key=jira-fixture');
    f.fetch.mockResolvedValueOnce(json({ data: { connect_link: 'https://connect.nango.dev/fixture-reconnect' } }));
    const nextTags = { ...tags, echo_attempt: 'fresh-attempt-fixture' };
    await f.nango.connect(nextTags);
    expect(f.fetch.mock.calls[2]![0]).toBe('https://api.nango.dev/connect/sessions');
    expect(JSON.parse(f.fetch.mock.calls[2]![1]!.body as string)).toEqual({ tags: nextTags, allowed_integrations: [integration], integrations_config_defaults: { [integration]: { connection_config: { oauth_scopes_override: 'offline_access read:jira-work read:jira-user' } } } });
    f.fetch.mockResolvedValueOnce(new Response('', { status: 404 }));
    await f.nango.disconnect('reference-fixture');
    expect(f.fetch.mock.calls[3]![1]!.method).toBe('DELETE');
    for (const [, init] of f.fetch.mock.calls) expect(init).toMatchObject({ redirect: 'error', headers: expect.objectContaining({ Authorization: 'Bearer synthetic-nango-key' }) });
  });
  it('finds a single server-tagged connection without collecting credentials or trusting a client locator', async () => {
    const f = fixture(); const taggedConnections = [connection]; const requests: URL[] = []; const served: (typeof connection)[][] = [];
    f.fetch.mockImplementation(async url => {
      const request = new URL(String(url)); requests.push(request);
      const limit = Number(request.searchParams.get('limit')); const page = Number(request.searchParams.get('page'));
      const tagsMatch = Object.entries(tags).every(([key, value]) => request.searchParams.get(`tags[${key}]`) === value);
      const connections = tagsMatch ? taggedConnections.slice(page * limit, (page + 1) * limit) : []; served.push(connections);
      return json({ connections });
    });
    expect(await f.nango.find(tags)).toBe('reference-fixture');
    expect(requests).toHaveLength(1); expect(served).toEqual([[connection]]);
    const url = requests[0]!;
    expect(url.searchParams.get('tags[echo_attempt]')).toBe(tags.echo_attempt);
    expect(url.searchParams.get('limit')).toBe('2');
    expect(url.searchParams.get('page')).toBe('0');
    taggedConnections.length = 0; expect(await f.nango.find(tags)).toBeUndefined();
    taggedConnections.push(connection, connection); await expect(f.nango.find(tags)).rejects.toMatchObject({ code: 'unauthorized' });
  });
  it('accepts Nango\'s already-deleted connection response so reconnect can start fresh consent', async () => {
    const f = fixture();
    f.fetch.mockResolvedValueOnce(Response.json({ success: true }));
    await f.nango.disconnect('reference-fixture');
    f.fetch.mockResolvedValueOnce(Response.json({ error: { code: 'unknown_connection' } }, { status: 400 }));
    await expect(f.nango.disconnect('reference-fixture')).resolves.toBeUndefined();
    f.fetch.mockResolvedValueOnce(json({ data: { connect_link: 'https://connect.nango.dev/fixture-reconnect' } }));
    await expect(f.nango.connect({ ...tags, echo_attempt: 'fresh-attempt-fixture' })).resolves.toEqual({ link: 'https://connect.nango.dev/fixture-reconnect' });
  });
  it.each([
    [400, { error: { code: 'invalid_query_params' } }],
    [400, { code: 'unknown_connection' }],
    [400, { error: { code: 'unknown_connection' }, private: 'x'.repeat(128 * 1024) }],
    [401, { error: { code: 'unknown_connection' } }],
    [403, { error: { code: 'unknown_connection' } }],
    [429, { error: { code: 'unknown_connection' } }],
    [500, { error: { code: 'unknown_connection' } }],
  ] as const)('keeps other deletion failures closed (case %#, HTTP %s)', async (status, body) => {
    const f = fixture(); f.fetch.mockResolvedValueOnce(Response.json(body, { status }));
    await expect(f.nango.disconnect('reference-fixture')).rejects.toMatchObject({ code: status === 429 ? 'rate_limited' : 'unavailable', message: 'Jira live evidence operation could not be completed' });
  });
  it('does not accept unknown_connection as success for connection reads or fresh consent', async () => {
    const f = fixture();
    f.fetch.mockImplementation(async () => Response.json({ error: { code: 'unknown_connection' } }, { status: 400 }));
    await expect(f.nango.connection('reference-fixture')).rejects.toMatchObject({ code: 'unavailable' });
    await expect(f.nango.connect(tags)).rejects.toMatchObject({ code: 'unavailable' });
  });
  it.each([{ connection_id: 'another-reference' }, { provider_config_key: 'another-integration' }, { provider: 'jira-data-center' }, { credentials: { type: 'BASIC', password: 'synthetic-private' } }, { tags: { ...tags, echo_attempt: undefined } }])('fails closed for mismatched or malformed connection data', async change => {
    const f = fixture(); f.fetch.mockResolvedValueOnce(json({ ...connection, ...change }));
    await expect(f.nango.connection('reference-fixture')).rejects.toMatchObject({ message: 'Jira live evidence operation could not be completed' });
  });
  it('bounds streamed Nango responses and sanitizes provider failures', async () => {
    const f = fixture(); f.fetch.mockResolvedValueOnce(json({ private: 'x'.repeat(128 * 1024) }));
    await expect(f.nango.connection('reference-fixture')).rejects.toMatchObject({ code: 'unavailable' });
    f.fetch.mockRejectedValueOnce(new Error('synthetic-private-token-and-body'));
    await expect(f.nango.connection('reference-fixture')).rejects.toMatchObject({ message: 'Jira live evidence operation could not be completed' });
  });
  it.each(['https://attacker.example.test/consent', 'https://connect.nango.dev:444/consent', 'https://connect.nango.dev/consent#private', 'https://synthetic@connect.nango.dev/consent'])('rejects unsafe consent URL %s', async link => {
    const f = fixture(); f.fetch.mockResolvedValueOnce(json({ data: { connect_link: link } }));
    await expect(f.nango.connect(tags)).rejects.toMatchObject({ code: 'invalid_output' });
  });
  it('rejects redirects and honors abort while the response stream is pending', async () => {
    const f = fixture();
    const redirected = json(connection); Object.defineProperty(redirected, 'redirected', { value: true }); f.fetch.mockResolvedValueOnce(redirected);
    await expect(f.nango.connection('reference-fixture')).rejects.toMatchObject({ code: 'unavailable' });
    const abort = new AbortController(); let cancelled = false;
    f.fetch.mockResolvedValueOnce(new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-type': 'application/json' } }));
    const pending = f.nango.connection('reference-fixture', abort.signal); await Promise.resolve(); abort.abort();
    await expect(pending).rejects.toThrow(); expect(cancelled).toBe(true);
  });
});
