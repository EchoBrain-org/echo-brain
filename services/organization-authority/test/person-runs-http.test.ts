import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PERSON_RUNS_PATH_V1 } from '@echo-brain/organization-api';
import { createOrganizationAuthorityHttpServer } from '../src/presentation/organization-authority-http-server.js';
import type { PersonTriggerRunsHttpApplicationV1 } from '../src/presentation/person-trigger-runs-http-application.js';
import { authorityHttpServerOptions } from './fixtures/authority-http-server.js';

const ITEM = 'itm_00000000-0000-4000-8000-000000000001';
const RUN = 'run_00000000-0000-4000-8000-000000000001';
const MEMBER = 'mem_00000000-0000-4000-8000-000000000002';
const RECORD = `sha256:${'a'.repeat(64)}`;
const PROJECT = 'prj_00000000-0000-4000-8000-000000000003';
/** One valid request per open-items operation, and the result its method answers. */
const OPEN_ITEMS = {
  home: [{ schema_version: 1, operation: 'home' }, { send: [], items: [], waiting: 0 }],
  items: [{ schema_version: 1, operation: 'items', scope: 'record', id: RECORD }, { items: [], next_cursor: null, stages: [], summary: { unsent: 0, open: 0, done: 0, not_relevant: 0, decisions: 0, by_decision: [] } }],
  item: [{ schema_version: 1, operation: 'item', item_id: ITEM }, { item: { item_id: ITEM } }],
  send: [{ schema_version: 1, operation: 'send', run_id: RUN, command_id: 'cmd-1', items: [{ item_id: ITEM, include: true, owner_membership_id: MEMBER }] }, { sent: 1, not_relevant: 0 }],
  set_state: [{ schema_version: 1, operation: 'set_state', item_id: ITEM, state: 'done' }, { state: 'done' }],
  assign: [{ schema_version: 1, operation: 'assign', item_id: ITEM, owner_membership_id: MEMBER }, { owner: { membership_id: MEMBER, name: 'Mina Patel', active: true } }],
} as const;

const servers: ReturnType<typeof createOrganizationAuthorityHttpServer>[] = [];
afterEach(async () => { for (const server of servers.splice(0)) { const closed = once(server, 'close'); server.close(); server.closeAllConnections(); await closed; } });
async function origin(app: PersonTriggerRunsHttpApplicationV1) { const server = createOrganizationAuthorityHttpServer(authorityHttpServerOptions({ person_trigger_runs: app })); servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); if (address === null || typeof address === 'string') throw new Error('address unavailable'); return `http://127.0.0.1:${address.port}`; }
const post = (base: string, body: unknown, authorization: string | null = 'Bearer fixture') => fetch(`${base}${PERSON_RUNS_PATH_V1}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(authorization === null ? {} : { authorization }) }, body: JSON.stringify(body) });

describe('person runs HTTP transport', () => {
  it('reserves the route, requires a bearer, and dispatches a validated list', async () => {
    const app = { list: vi.fn(async () => ({ runs: [] })), start: vi.fn(), next: vi.fn(), retry: vi.fn(), view: vi.fn(), home: vi.fn(), items: vi.fn(), item: vi.fn(), send: vi.fn(), set_state: vi.fn(), assign: vi.fn(), close() {} } satisfies PersonTriggerRunsHttpApplicationV1;
    const base = await origin(app);
    expect((await post(base, { schema_version: 1, operation: 'list' }, null)).status).toBe(401);
    const response = await post(base, { schema_version: 1, operation: 'list' });
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ runs: [] });
    expect(app.list).toHaveBeenCalledWith({ access_token: 'fixture', signal: expect.any(AbortSignal) });
    expect(() => createOrganizationAuthorityHttpServer(authorityHttpServerOptions({ person_tools: { routes: [{ route_id: 'collision', method: 'POST', path: PERSON_RUNS_PATH_V1 }], accept: async () => ({ status: 200, body: {} }) } }))).toThrow('collides with Authority route');
  });

  it('dispatches a check-in (next) to its method with the validated request', async () => {
    const next = vi.fn(async () => ({ state: 'running' as const }));
    const app = { list: vi.fn(), start: vi.fn(), next, retry: vi.fn(), view: vi.fn(), home: vi.fn(), items: vi.fn(), item: vi.fn(), send: vi.fn(), set_state: vi.fn(), assign: vi.fn(), close() {} } satisfies PersonTriggerRunsHttpApplicationV1;
    const base = await origin(app);
    const request = { schema_version: 1, operation: 'next' };
    expect((await post(base, request, null)).status).toBe(401);
    const response = await post(base, request);
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ state: 'running' });
    expect(next).toHaveBeenCalledExactlyOnceWith({ access_token: 'fixture', request, signal: expect.any(AbortSignal) });
  });

  it('dispatches each open-items operation to its method with the validated request', async () => {
    const methods = Object.fromEntries(Object.entries(OPEN_ITEMS).map(([operation, [, result]]) => [operation, vi.fn(async () => result)]));
    const app = { list: vi.fn(), start: vi.fn(), next: vi.fn(), retry: vi.fn(), view: vi.fn(), ...methods, close() {} } as unknown as PersonTriggerRunsHttpApplicationV1;
    const base = await origin(app);
    for (const [operation, [request, result]] of Object.entries(OPEN_ITEMS)) {
      const response = await post(base, request);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(result);
      expect(methods[operation]).toHaveBeenCalledWith({ access_token: 'fixture', request, signal: expect.any(AbortSignal) });
    }
    // Home's quiet check reaches the same method, read as rows.
    const quiet = { schema_version: 1, operation: 'home', read: 'rows' };
    expect((await post(base, quiet)).status).toBe(200);
    expect(methods.home).toHaveBeenLastCalledWith({ access_token: 'fixture', request: quiet, signal: expect.any(AbortSignal) });
    expect((await post(base, { ...quiet, read: 'counts' })).status).toBe(400);
    // A request the API refuses never reaches a method.
    expect((await post(base, { schema_version: 1, operation: 'set_state', item_id: ITEM, state: 'unsent' })).status).toBe(400);
    expect(methods.set_state).toHaveBeenCalledTimes(1);
  });

  it('refuses a sweep of any scope with 400 before any method: sweeps are retired (SVC-2)', async () => {
    const methods = { list: vi.fn(), start: vi.fn(), next: vi.fn(), retry: vi.fn(), view: vi.fn(), home: vi.fn(), items: vi.fn(), item: vi.fn(), send: vi.fn(), set_state: vi.fn(), assign: vi.fn() };
    const base = await origin({ ...methods, close() {} } satisfies PersonTriggerRunsHttpApplicationV1);
    // The requests a released desktop's Check now and auto-sweep sent.
    for (const fields of [{ scope: 'mine' }, { scope: 'record', id: RECORD }, { scope: 'project', id: PROJECT }]) {
      const response = await post(base, { schema_version: 1, operation: 'sweep', ...fields });
      expect(response.status, JSON.stringify(fields)).toBe(400);
      expect(await response.json(), JSON.stringify(fields)).toMatchObject({ error: { code: 'invalid_request' } });
    }
    for (const method of Object.values(methods)) expect(method).not.toHaveBeenCalled();
  });

  it('dispatches a start with its run id alone, and refuses a capture id with 400 before any method: diagnostic captures are retired (SVC-9)', async () => {
    const methods = { list: vi.fn(), start: vi.fn(async () => ({ state: 'running' as const })), next: vi.fn(), retry: vi.fn(), view: vi.fn(), home: vi.fn(), items: vi.fn(), item: vi.fn(), send: vi.fn(), set_state: vi.fn(), assign: vi.fn() };
    const base = await origin({ ...methods, close() {} } satisfies PersonTriggerRunsHttpApplicationV1);
    const start = { schema_version: 1, operation: 'start', run_id: RUN };
    const response = await post(base, start);
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ state: 'running' });
    expect(methods.start).toHaveBeenCalledExactlyOnceWith({ access_token: 'fixture', request: start, signal: expect.any(AbortSignal) });
    // The start the retired research-loop trace command sent.
    const captured = await post(base, { ...start, capture_id: 'cap_00000000-0000-4000-8000-000000000001' });
    expect(captured.status).toBe(400);
    expect(await captured.json()).toMatchObject({ error: { code: 'invalid_request' } });
    expect(methods.start).toHaveBeenCalledTimes(1);
  });
});
