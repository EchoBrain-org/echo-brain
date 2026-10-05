import { once } from 'node:events';
import { expect, it, vi } from 'vitest';
import { createConfluencePersonConnectionHttpApplicationV1 } from '@echo-brain/provider-confluence/confluence-person-connection-http-application-v1';
import { validateConfluenceProjectMappingsV1 } from '@echo-brain/provider-confluence-client/organization-api/confluence-project-mapping-v1';
import { createOrganizationAuthorityHttpServer } from '../src/presentation/organization-authority-http-server.js';

it('serves a maximum valid mapping collection through authenticated provider HTTP ingress', async () => {
  const uuid = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
  const body = validateConfluenceProjectMappingsV1({ schema_version: 1, mappings: Array.from({ length: 100 }, (_, index) => ({
    schema_version: 1, project_id: `prj_${uuid(index)}`, revision: uuid(1),
    mapping: { cloud_id: uuid(2), space_ids: Array.from({ length: 20 }, (_, id) => String(10n ** 19n + BigInt(id))) },
  })) });
  expect(Buffer.byteLength(JSON.stringify(body))).toBeGreaterThan(64 * 1024);
  const projectList = vi.fn(({ access_token }: { access_token: string }) => { expect(access_token).toBe('fixture'); return body; });
  const application = createConfluencePersonConnectionHttpApplicationV1({
    connect: vi.fn(), status: vi.fn(), cancel: vi.fn(), disconnect: vi.fn(),
    projectRead: vi.fn(), projectSet: vi.fn(), projectList,
  });
  const server = createOrganizationAuthorityHttpServer({ descriptor: {} as never, sessions: {} as never, oidc_provider: {} as never,
    expected_issuer: 'https://issuer.example.test', person_tool_connections: [application] });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/person/tools/confluence/project/list`;
  try {
    const request = { method: 'POST', body: JSON.stringify({ schema_version: 1 }) };
    expect((await fetch(url, { ...request, headers: { 'content-type': 'application/json' } })).status).toBe(401);
    expect(projectList).not.toHaveBeenCalled();
    const response = await fetch(url, { ...request, headers: { 'content-type': 'application/json', authorization: 'Bearer fixture' } });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual(body);
  } finally { const closed = once(server, 'close'); server.close(); await closed; }
});
