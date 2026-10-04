import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { JiraConnectionStoreV1 } from '@echo-brain/provider-jira/jira-connection-store-v1';
import { createJiraPersonConnectionV1 } from '@echo-brain/provider-jira/jira-person-connection-v1';
import { createJiraNangoV1 } from '@echo-brain/provider-jira/jira-nango-v1';
import { createJiraPersonConnectionHttpApplicationV1, type JiraPersonConnectionHttpPortV1 } from '@echo-brain/provider-jira/jira-person-connection-http-application-v1';
import type { ProviderHttpApplicationV1 } from '@echo-brain/organization-authority-kernel/application/ports/provider-http-application-v1';
import { createOrganizationAuthorityHttpServer } from '../src/presentation/organization-authority-http-server.js';
import { fakeJiraCloudFetchV1, FIXTURE_JIRA_CLOUD_V1, FIXTURE_JIRA_SITE_V1 } from './fixtures/fake-jira-v1.js';

const ATTEMPT = '00000000-0000-4000-8000-000000000001';
const EXPIRES_AT = '2026-10-01T00:10:00.000Z';

function state(status: 'pending' | 'complete' | 'cancelled' | 'expired' | 'failed', failure_reason: null | 'provider_rejected' | 'provider_unavailable' | 'account_mismatch' = null) {
  return { schema_version: 1 as const, attempt: ATTEMPT, expires_at: EXPIRES_AT, status, failure_reason };
}

async function server(application?: ProviderHttpApplicationV1) {
  const instance = createOrganizationAuthorityHttpServer({
    descriptor: {} as never, sessions: {} as never, oidc_provider: {} as never,
    expected_issuer: 'https://issuer.example.test',
    ...(application === undefined ? {} : { person_tool_connections: [application] }),
  });
  instance.listen(0, '127.0.0.1'); await once(instance, 'listening');
  return {
    origin: `http://127.0.0.1:${(instance.address() as { port: number }).port}`,
    async close() { const closed = once(instance, 'close'); instance.close(); await closed; },
  };
}

function connection(): JiraPersonConnectionHttpPortV1 {
  return {
    connect: vi.fn(async () => ({ schema_version: 1 as const, attempt: ATTEMPT, connect_link: 'https://connect.nango.dev/fixture', expires_at: EXPIRES_AT })),
    status: vi.fn(async () => state('pending')),
    cancel: vi.fn(async () => state('cancelled')),
    disconnect: vi.fn(async () => ({ schema_version: 1 as const, connected: false as const })),
  };
}

it('mounts only the selected shared Jira tool routes and refuses client-selected identity fields', async () => {
  const port = connection();
  const value = await server(createJiraPersonConnectionHttpApplicationV1(port));
  try {
    const post = (path: string, body: unknown, auth?: string) => fetch(`${value.origin}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(auth === undefined ? {} : { authorization: auth }) }, body: JSON.stringify(body),
    });
    expect((await post('/v1/person/tools/jira/connect', { schema_version: 1 })).status).toBe(401);
    expect((await post('/v1/person/tools/jira/connect', { schema_version: 1, principal_id: 'another' }, 'Bearer fixture')).status).toBe(400);

    const connected = await post('/v1/person/tools/jira/connect', { schema_version: 1 }, 'Bearer fixture');
    expect(connected.status).toBe(201);
    expect(await connected.json()).toEqual({ schema_version: 1, attempt: ATTEMPT, connect_link: 'https://connect.nango.dev/fixture', expires_at: EXPIRES_AT });
    const status = await post('/v1/person/tools/jira/status', { schema_version: 1, attempt: ATTEMPT }, 'Bearer fixture');
    expect(status.status).toBe(200); expect(await status.json()).toEqual(state('pending'));
    const cancelled = await post('/v1/person/tools/jira/cancel', { schema_version: 1, attempt: ATTEMPT }, 'Bearer fixture');
    expect(cancelled.status).toBe(200); expect(await cancelled.json()).toEqual(state('cancelled'));
    const disconnected = await post('/v1/person/tools/jira/disconnect', { schema_version: 1 }, 'Bearer fixture');
    expect(disconnected.status).toBe(200); expect(await disconnected.json()).toEqual({ schema_version: 1, connected: false });
  } finally { await value.close(); }

  const disabled = await server();
  try {
    for (const path of [
      '/v1/person/tools/jira/connect', '/v1/person/tools/jira/status', '/v1/person/tools/jira/cancel', '/v1/person/tools/jira/disconnect',
      '/v1/person/jira/connect', '/v1/person/jira/complete', '/v1/person/jira/disconnect',
    ]) expect((await fetch(`${disabled.origin}${path}`, { method: 'POST' })).status).toBe(404);
    expect((await fetch(`${disabled.origin}/v4/person/ask`, { method: 'POST' })).status).toBe(503);
  } finally { await disabled.close(); }
});

it('aborts an in-flight shared Jira connect when its Person HTTP client disconnects', async () => {
  let started!: () => void; const begun = new Promise<void>(resolve => { started = resolve; });
  let aborted!: () => void; const cancelled = new Promise<void>(resolve => { aborted = resolve; });
  const port: JiraPersonConnectionHttpPortV1 = {
    connect: ({ signal }) => new Promise((_resolve, reject) => {
      started(); signal?.addEventListener('abort', () => { aborted(); reject(signal.reason); }, { once: true });
    }),
    status: vi.fn(), cancel: vi.fn(), disconnect: vi.fn(),
  };
  const value = await server(createJiraPersonConnectionHttpApplicationV1(port));
  try {
    const request = httpRequest(`${value.origin}/v1/person/tools/jira/connect`, {
      method: 'POST', headers: { authorization: 'Bearer fixture', 'content-type': 'application/json' },
    });
    request.on('error', () => {}); request.end(JSON.stringify({ schema_version: 1 }));
    await begun; request.destroy(); await cancelled;
  } finally { await value.close(); }
});

it('reconnects through the Person HTTP routes after disconnect deleted the Nango connection', async () => {
  const database = new Database(':memory:');
  const store = new JiraConnectionStoreV1(database);
  const person = { organization_id: 'org_00000000-0000-4000-8000-000000000001', principal_id: 'fixture-person', membership_id: 'mem_00000000-0000-4000-8000-000000000001' };
  const initial = store.begin(person);
  const old = store.complete(person, initial.attempt, 'old-reference', FIXTURE_JIRA_CLOUD_V1, 'fixture-jira-account', FIXTURE_JIRA_SITE_V1);
  let oldExists = true; let consent = false; let tags: Record<string, string> = {};
  const deletionStatuses: number[] = [];
  const nangoFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    if (init?.method === 'DELETE' && url.pathname === '/connections/old-reference') {
      const status = oldExists ? 200 : 400; oldExists = false; deletionStatuses.push(status);
      return Response.json(status === 200 ? { success: true } : { error: { code: 'unknown_connection' } }, { status });
    }
    if (init?.method === 'POST' && url.pathname === '/connect/sessions') {
      tags = JSON.parse(init.body as string).tags;
      return Response.json({ data: { connect_link: 'https://connect.nango.dev/fixture-reconnect' } });
    }
    const connected = { connection_id: 'fresh-reference', provider_config_key: 'jira-fixture', provider: 'jira', tags, credentials: { type: 'OAUTH2', access_token: 'synthetic-jira-oauth-bearer' } };
    if (init?.method === 'GET' && url.pathname === '/connections') {
      expect(url.searchParams.get('tags[echo_attempt]')).toBe(tags.echo_attempt);
      return Response.json({ connections: consent ? [connected] : [] });
    }
    if (init?.method === 'GET' && url.pathname === '/connections/fresh-reference' && consent) return Response.json(connected);
    throw new Error('Unexpected fixture Nango request');
  });
  const connection = createJiraPersonConnectionV1({
    store, nango: createJiraNangoV1({ integration_id: 'jira-fixture', authorization: () => 'synthetic-nango-key', fetch: nangoFetch }),
    cloud_id: FIXTURE_JIRA_CLOUD_V1, fetch: fakeJiraCloudFetchV1(),
    authenticate: token => { expect(token).toBe('fixture'); return { ...person, authorization_sha256: canonicalSha256(person) }; },
  });
  const value = await server(createJiraPersonConnectionHttpApplicationV1(connection));
  const post = (verb: string, extra = {}) => fetch(`${value.origin}/v1/person/tools/jira/${verb}`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer fixture' }, body: JSON.stringify({ schema_version: 1, ...extra }),
  });
  try {
    expect((await post('disconnect')).status).toBe(200);
    expect(connection.tool({ access_token: 'fixture' })).toMatchObject({ personal_status: 'revoked' });
    const reconnect = await post('connect');
    expect(reconnect.status).toBe(201);
    const begun = await reconnect.json() as { attempt: string; connect_link: string };
    expect(begun.connect_link).toBe('https://connect.nango.dev/fixture-reconnect');
    expect(begun.attempt).not.toBe(initial.attempt);
    expect(deletionStatuses).toEqual([200, 400]);
    expect(store.current(person)).toMatchObject({ active: false, version: old.version });
    expect(await (await post('status', { attempt: begun.attempt })).json()).toMatchObject({ status: 'pending' });
    consent = true;
    expect(await (await post('status', { attempt: begun.attempt })).json()).toMatchObject({ status: 'complete' });
    expect(connection.tool({ access_token: 'fixture' })).toMatchObject({ personal_status: 'linked' });
    expect(store.current(person)).toMatchObject({ active: true, reference: 'fresh-reference' });
    expect(store.current(person)!.binding.read_grant_sha256).not.toBe(old.binding.read_grant_sha256);
    expect(() => store.requireCurrent(old.binding)).toThrow();
  } finally { await value.close(); database.close(); }
});
