import { once } from 'node:events';
import { expect, it, vi } from 'vitest';
import { createConfluencePersonConnectionHttpApplicationV1 } from '@echo-brain/provider-confluence/confluence-person-connection-http-application-v1';
import { validateConfluenceSpacesPageV1 } from '@echo-brain/provider-confluence-client/organization-api/confluence-project-mapping-v1';
import { createOrganizationAuthorityHttpServer } from '../src/presentation/organization-authority-http-server.js';
import { authorityHttpServerOptions } from './fixtures/authority-http-server.js';

it('serves a maximum valid spaces page through authenticated provider HTTP ingress', async () => {
  // 20 spaces whose key and name are 256 lone surrogates (six JSON bytes each) and the longest cursor: over 64 KiB.
  const body = validateConfluenceSpacesPageV1({ schema_version: 1, next_cursor: 'c'.repeat(4096),
    items: Array.from({ length: 20 }, (_, index) => ({ id: String(10n ** 19n + BigInt(index)), key: '\ud800'.repeat(256), name: '\ud800'.repeat(256) })) });
  expect(Buffer.byteLength(JSON.stringify(body))).toBeGreaterThan(64 * 1024);
  const spacesList = vi.fn(async ({ access_token }: { access_token: string }) => { expect(access_token).toBe('fixture'); return body; });
  const application = createConfluencePersonConnectionHttpApplicationV1({
    connect: vi.fn(), status: vi.fn(), cancel: vi.fn(), disconnect: vi.fn(), spacesList,
  });
  const server = createOrganizationAuthorityHttpServer(authorityHttpServerOptions({ person_tool_connections: [application] }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/person/tools/confluence/spaces/list`;
  try {
    const request = { method: 'POST', body: JSON.stringify({ schema_version: 1 }) };
    expect((await fetch(url, { ...request, headers: { 'content-type': 'application/json' } })).status).toBe(401);
    expect(spacesList).not.toHaveBeenCalled();
    const response = await fetch(url, { ...request, headers: { 'content-type': 'application/json', authorization: 'Bearer fixture' } });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual(body);
  } finally { const closed = once(server, 'close'); server.close(); await closed; }
});
