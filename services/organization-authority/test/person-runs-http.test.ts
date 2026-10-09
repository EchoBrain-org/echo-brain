import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PERSON_RUNS_PATH_V1 } from '@echo-brain/organization-api';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import { unavailablePersonTriggerRunsV1 } from '../src/composition/organization-authority-api-runtime.js';
import { createOrganizationAuthorityHttpServer } from '../src/presentation/organization-authority-http-server.js';
import type { PersonTriggerRunsHttpApplicationV1 } from '../src/presentation/person-trigger-runs-http-application.js';

const ITEM = 'itm_00000000-0000-4000-8000-000000000001';
const RUN = 'run_00000000-0000-4000-8000-000000000001';
const MEMBER = 'mem_00000000-0000-4000-8000-000000000002';
const RECORD = `sha256:${'a'.repeat(64)}`;
/** One valid request per open-items operation, and the result its method answers. */
const OPEN_ITEMS = {
  home: [{ schema_version: 1, operation: 'home' }, { send: [], items: [], landed: 0, waiting: 0, last_checked_at: null }],
  items: [{ schema_version: 1, operation: 'items', scope: 'record', id: RECORD }, { items: [], next_cursor: null, stages: [], summary: { unsent: 0, open: 0, done: 0, not_relevant: 0, landed: 0, changed: 0, unreadable: 0, decisions: 0, last_checked_at: null, by_decision: [] } }],
  item: [{ schema_version: 1, operation: 'item', item_id: ITEM }, { item: { item_id: ITEM } }],
  send: [{ schema_version: 1, operation: 'send', run_id: RUN, command_id: 'cmd-1', items: [{ item_id: ITEM, include: true, owner_membership_id: MEMBER }] }, { sent: 1, not_relevant: 0 }],
  set_state: [{ schema_version: 1, operation: 'set_state', item_id: ITEM, state: 'done' }, { state: 'done' }],
  assign: [{ schema_version: 1, operation: 'assign', item_id: ITEM, owner_membership_id: MEMBER }, { owner: { membership_id: MEMBER, name: 'Mina Patel', active: true } }],
} as const;
const unavailable = async () => { throw new AuthorityOperationError('unavailable', 'an answer model is not configured'); };

const servers: ReturnType<typeof createOrganizationAuthorityHttpServer>[] = [];
afterEach(async () => { for (const server of servers.splice(0)) { const closed = once(server, 'close'); server.close(); server.closeAllConnections(); await closed; } });
async function origin(app: PersonTriggerRunsHttpApplicationV1) { const server = createOrganizationAuthorityHttpServer({ descriptor: {} as never, sessions: {} as never, oidc_provider: {} as never, expected_issuer: 'https://issuer.example', person_trigger_runs: app }); servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); if (address === null || typeof address === 'string') throw new Error('address unavailable'); return `http://127.0.0.1:${address.port}`; }
const post = (base: string, body: unknown, authorization: string | null = 'Bearer fixture') => fetch(`${base}${PERSON_RUNS_PATH_V1}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(authorization === null ? {} : { authorization }) }, body: JSON.stringify(body) });

describe('person runs HTTP transport', () => {
  it('reserves the route, requires a bearer, and dispatches a validated list', async () => {
    const app = { list: vi.fn(async () => ({ runs: [] })), start: vi.fn(), retry: vi.fn(), view: vi.fn(), home: vi.fn(), items: vi.fn(), item: vi.fn(), send: vi.fn(), set_state: vi.fn(), assign: vi.fn(), close() {} } satisfies PersonTriggerRunsHttpApplicationV1;
    const base = await origin(app);
    expect((await post(base, { schema_version: 1, operation: 'list' }, null)).status).toBe(401);
    const response = await post(base, { schema_version: 1, operation: 'list' });
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ runs: [] });
    expect(app.list).toHaveBeenCalledWith({ access_token: 'fixture', signal: expect.any(AbortSignal) });
    expect(() => createOrganizationAuthorityHttpServer({ descriptor: {} as never, sessions: {} as never, oidc_provider: {} as never, expected_issuer: 'https://issuer.example', person_tools: { routes: [{ route_id: 'collision', method: 'POST', path: PERSON_RUNS_PATH_V1 }], accept: async () => ({ status: 200, body: {} }) } })).toThrow('collides with Authority route');
  });

  it('surfaces a composed no-model application as unavailable', async () => {
    const app = { list: unavailable, start: unavailable, retry: unavailable, view: unavailable, home: unavailable, items: unavailable, item: unavailable, send: unavailable, set_state: unavailable, assign: unavailable, close() {} } satisfies PersonTriggerRunsHttpApplicationV1;
    expect((await post(await origin(app), { schema_version: 1, operation: 'list' })).status).toBe(503);
  });

  it('dispatches each open-items operation to its method with the validated request', async () => {
    const methods = Object.fromEntries(Object.entries(OPEN_ITEMS).map(([operation, [, result]]) => [operation, vi.fn(async () => result)]));
    const app = { list: vi.fn(), start: vi.fn(), retry: vi.fn(), view: vi.fn(), ...methods, close() {} } as unknown as PersonTriggerRunsHttpApplicationV1;
    const base = await origin(app);
    for (const [operation, [request, result]] of Object.entries(OPEN_ITEMS)) {
      const response = await post(base, request);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(result);
      expect(methods[operation]).toHaveBeenCalledWith(operation === 'home'
        ? { access_token: 'fixture', signal: expect.any(AbortSignal) }
        : { access_token: 'fixture', request, signal: expect.any(AbortSignal) });
    }
    // A request the API refuses never reaches a method.
    expect((await post(base, { schema_version: 1, operation: 'set_state', item_id: ITEM, state: 'unsent' })).status).toBe(400);
    expect(methods.set_state).toHaveBeenCalledTimes(1);
  });

  it('answers unavailable from a runtime with no model, only after authenticating', async () => {
    const authenticateAccess = vi.fn(({ access_token }: { readonly access_token: string }) => {
      if (access_token !== 'fixture') throw new AuthorityOperationError('unauthorized', 'person authentication failed');
      return {} as never;
    });
    const base = await origin(unavailablePersonTriggerRunsV1({ authenticateAccess }));
    for (const request of [{ schema_version: 1, operation: 'list' }, { schema_version: 1, operation: 'view', run_id: RUN }, ...Object.values(OPEN_ITEMS).map(([value]) => value)]) {
      expect((await post(base, request, 'Bearer stranger')).status).toBe(401);
      const response = await post(base, request);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: { code: 'unavailable' } });
    }
    expect(authenticateAccess).toHaveBeenCalledTimes(16);
  });
});
