import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { expect, it, vi } from 'vitest';
import { createOrganizationAuthorityHttpServer } from '../src/presentation/organization-authority-http-server.js';
import type { JiraPersonConnectionHttpApplicationV1 } from '../src/presentation/jira-person-connection-http-application-v1.js';

async function server(application?: JiraPersonConnectionHttpApplicationV1) {
  const instance = createOrganizationAuthorityHttpServer({ descriptor: {} as never, sessions: {} as never, oidc_provider: {} as never, expected_issuer: 'https://issuer.example.test', ...(application === undefined ? {} : { person_jira_connection: application }) });
  instance.listen(0, '127.0.0.1'); await once(instance, 'listening');
  return { origin: `http://127.0.0.1:${(instance.address() as { port: number }).port}`, async close() { const closed = once(instance, 'close'); instance.close(); await closed; } };
}

it('keeps the Jira feature unavailable unless selected and refuses client-selected identity and tenant fields', async () => {
  const connect = vi.fn(async () => ({ schema_version: 1 as const, attempt: '00000000-0000-4000-8000-000000000001', connect_link: 'https://connect.nango.dev/fixture' }));
  const value = await server({ connect, complete: vi.fn(), disconnect: vi.fn() });
  try {
    const post = (body: unknown, auth?: string) => fetch(`${value.origin}/v1/person/jira/connect`, { method: 'POST', headers: { 'content-type': 'application/json', ...(auth === undefined ? {} : { authorization: auth }) }, body: JSON.stringify(body) });
    expect((await post({ schema_version: 1 })).status).toBe(401);
    for (const key of ['principal_id', 'membership_id', 'organization_id', 'cloud_id', 'connection']) expect((await post({ schema_version: 1, [key]: 'another' }, 'Bearer fixture')).status).toBe(400);
    expect(connect).not.toHaveBeenCalled();
    const selected = await post({ schema_version: 1 }, 'Bearer fixture'); expect(selected.status).toBe(200);
    expect(connect).toHaveBeenCalledWith(expect.objectContaining({ access_token: 'fixture', signal: expect.any(AbortSignal) }));
  } finally { await value.close(); }
  const disabled = await server();
  try {
    for (const path of ['/v1/person/jira/connect', '/v1/person/jira/complete', '/v1/person/jira/disconnect', '/v4/person/ask']) expect((await fetch(`${disabled.origin}${path}`, { method: 'POST' })).status).toBe(503);
  } finally { await disabled.close(); }
});

it('aborts an in-flight Jira connect when its Person HTTP client disconnects', async () => {
  let started!: () => void; const begun = new Promise<void>(resolve => { started = resolve; });
  let aborted!: () => void; const cancelled = new Promise<void>(resolve => { aborted = resolve; });
  const value = await server({ connect: ({ signal }) => new Promise((_resolve, reject) => { started(); signal!.addEventListener('abort', () => { aborted(); reject(signal!.reason); }, { once: true }); }), complete: vi.fn(), disconnect: vi.fn() });
  try {
    const request = httpRequest(`${value.origin}/v1/person/jira/connect`, { method: 'POST', headers: { authorization: 'Bearer fixture', 'content-type': 'application/json' } });
    request.on('error', () => {}); request.end(JSON.stringify({ schema_version: 1 })); await begun; request.destroy(); await cancelled;
  } finally { await value.close(); }
});
