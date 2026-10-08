import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PERSON_RUNS_PATH_V1 } from '@echo-brain/organization-api';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import { createOrganizationAuthorityHttpServer } from '../src/presentation/organization-authority-http-server.js';
import type { PersonTriggerRunsHttpApplicationV1 } from '../src/presentation/person-trigger-runs-http-application.js';

const servers: ReturnType<typeof createOrganizationAuthorityHttpServer>[] = [];
afterEach(async () => { for (const server of servers.splice(0)) { const closed = once(server, 'close'); server.close(); server.closeAllConnections(); await closed; } });
async function origin(app: PersonTriggerRunsHttpApplicationV1) { const server = createOrganizationAuthorityHttpServer({ descriptor: {} as never, sessions: {} as never, oidc_provider: {} as never, expected_issuer: 'https://issuer.example', person_trigger_runs: app }); servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); if (address === null || typeof address === 'string') throw new Error('address unavailable'); return `http://127.0.0.1:${address.port}`; }
const post = (base: string, body: unknown, authorization: string | null = 'Bearer fixture') => fetch(`${base}${PERSON_RUNS_PATH_V1}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(authorization === null ? {} : { authorization }) }, body: JSON.stringify(body) });

describe('person runs HTTP transport', () => {
  it('reserves the route, requires a bearer, and dispatches a validated list', async () => {
    const app = { list: vi.fn(async () => ({ runs: [] })), start: vi.fn(), retry: vi.fn(), view: vi.fn(), close() {} } satisfies PersonTriggerRunsHttpApplicationV1;
    const base = await origin(app);
    expect((await post(base, { schema_version: 1, operation: 'list' }, null)).status).toBe(401);
    const response = await post(base, { schema_version: 1, operation: 'list' });
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ runs: [] });
    expect(app.list).toHaveBeenCalledWith({ access_token: 'fixture', signal: expect.any(AbortSignal) });
    expect(() => createOrganizationAuthorityHttpServer({ descriptor: {} as never, sessions: {} as never, oidc_provider: {} as never, expected_issuer: 'https://issuer.example', person_tools: { routes: [{ route_id: 'collision', method: 'POST', path: PERSON_RUNS_PATH_V1 }], accept: async () => ({ status: 200, body: {} }) } })).toThrow('collides with Authority route');
  });

  it('surfaces a composed no-model application as unavailable', async () => {
    const app = { async list() { throw new AuthorityOperationError('unavailable', 'an answer model is not configured'); }, async start() { throw new AuthorityOperationError('unavailable', 'an answer model is not configured'); }, async retry() { throw new AuthorityOperationError('unavailable', 'an answer model is not configured'); }, async view() { throw new AuthorityOperationError('unavailable', 'an answer model is not configured'); }, close() {} } satisfies PersonTriggerRunsHttpApplicationV1;
    expect((await post(await origin(app), { schema_version: 1, operation: 'list' })).status).toBe(503);
  });
});
