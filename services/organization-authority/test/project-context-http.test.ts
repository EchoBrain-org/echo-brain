import { Buffer } from 'node:buffer';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MAX_ORGANIZATION_API_BODY_BYTES, PROJECT_CONTEXT_RESPONSE_MAX_BYTES,
} from '@echo-brain/organization-api';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import type { ProjectContextApplicationV1 } from '../src/application/ports/project-context-v1.js';
import {
  createOrganizationAuthorityHttpServer,
  type OrganizationAuthorityHttpServerOptions,
} from '../src/presentation/organization-authority-http-server.js';

type Operation = keyof ProjectContextApplicationV1;
interface Fixture {
  id: string;
  http: { method: string; path: string; status: number; body?: Record<string, unknown>; response: Record<string, unknown> };
}
const fixtures = (JSON.parse(readFileSync(new URL('../../../tests/fixtures/project-context-v1/operations.json', import.meta.url), 'utf8')) as { operations: Fixture[] }).operations;
const operations: Record<string, Operation> = {
  'projects-list': 'listProjects', 'projects-create': 'createProject', 'projects-read': 'readProject',
  'projects-members': 'listMembers', 'projects-directory': 'searchDirectory',
  'person-directory': 'searchOrganizationDirectory',
  'projects-member-add': 'addMember',
  'projects-member-set': 'setMember', 'projects-member-remove': 'removeMember',
  'projects-associate': 'associateContext', 'projects-dissociate': 'dissociateContext',
  'projects-feed': 'feed', 'projects-search': 'search', 'projects-read-context': 'readContext',
  'updates-submit-v2': 'submitUpload', 'updates-status-v2': 'uploadStatus',
  'updates-search-v2': 'searchUploads', 'updates-read-v2': 'readUpload',
};
const fixture = (id: string) => fixtures.find(row => row.id === id)!;
const calls: { operation: Operation; args: unknown[] }[] = [];
function fake(overrides: Partial<ProjectContextApplicationV1> = {}): ProjectContextApplicationV1 {
  return {
    ...Object.fromEntries(fixtures.map(row => [operations[row.id]!, (...args: unknown[]) => {
      calls.push({ operation: operations[row.id]!, args });
      if (args[0] !== 'fixture-session') throw new AuthorityOperationError('unauthorized', 'private diagnostic');
      return structuredClone(row.http.response);
    }])),
    ...overrides,
  } as ProjectContextApplicationV1;
}
const options = (): OrganizationAuthorityHttpServerOptions => ({
  descriptor: {} as never, sessions: {} as never, oidc_provider: {} as never, expected_issuer: 'https://issuer.example',
});
const closers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closers.splice(0)) await close(); calls.length = 0; });
async function start(application: ProjectContextApplicationV1 | undefined = fake(), extra: Partial<OrganizationAuthorityHttpServerOptions> = {}) {
  const server = createOrganizationAuthorityHttpServer({ ...options(), ...(application === undefined ? {} : { project_context: application }), ...extra });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('missing fixture address');
  closers.push(async () => { const closed = once(server, 'close'); server.close(); server.closeAllConnections(); await closed; });
  return `http://127.0.0.1:${address.port}`;
}
const headers = { authorization: 'Bearer fixture-session', 'content-type': 'application/json' };
async function send(origin: string, row: Fixture, override: RequestInit = {}) {
  return fetch(`${origin}${row.http.path}`, {
    method: row.http.method, headers,
    ...(row.http.body === undefined ? {} : { body: JSON.stringify(row.http.body) }), ...override,
  });
}
async function failure(response: Response, status = 400, code = 'invalid_request') {
  expect(response.status).toBe(status);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual({ error: { code, message: 'request failed' } });
}

describe('frozen project/V2 HTTP transport', () => {
  it.each(fixtures)('dispatches the exact fixture method/path and response: $id', async row => {
    const origin = await start();
    const response = await send(origin, row);
    expect(response.status).toBe(row.http.status);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const bytes = await response.text();
    expect(bytes).toBe(JSON.stringify(row.http.response));
    expect(Number(response.headers.get('content-length'))).toBe(Buffer.byteLength(bytes));
    let input: unknown[];
    const parts = row.http.path.split('/');
    if (row.http.body !== undefined) input = [row.http.body];
    else if (row.id === 'projects-list') input = [{ limit: 10, cursor: 'eyJsYXN0Ijoicm93In0' }];
    else if (row.id === 'projects-read-context') input = [parts[4], parts[6]];
    else input = [parts.at(-1)];
    expect(calls).toEqual([{ operation: operations[row.id], args: ['fixture-session', ...input] }]);
  });

  it('defaults a bounded project list and feed without inventing a search query', async () => {
    const origin = await start();
    expect((await fetch(`${origin}/v1/person/projects`, { headers })).status).toBe(200);
    const row = fixture('projects-feed');
    expect((await send(origin, row, { body: JSON.stringify({ project_id: row.http.body!.project_id }) })).status).toBe(200);
    expect(calls.map(call => call.args[1])).toEqual([{ limit: 10 }, { project_id: row.http.body!.project_id, limit: 10 }]);
    expect((await send(origin, { ...fixture('projects-directory'), http: { ...fixture('projects-directory').http, body: { project_id: fixture('projects-directory').http.body!.project_id } } })).status).toBe(200);
    for (const id of ['projects-search', 'updates-search-v2']) {
      await failure(await send(origin, fixture(id), { body: JSON.stringify({ ...fixture(id).http.body, query: '' }) }));
    }
    expect(calls.map(call => call.operation)).toEqual(['listProjects', 'feed', 'searchDirectory']);
  });

  it('rejects caller authority fields and cross-version bodies before application calls', async () => {
    const origin = await start();
    for (const row of fixtures.filter(row => row.http.body !== undefined)) {
      for (const field of ['organization_id', 'principal_id', 'caller_membership_id', 'authorization_revision', 'resolved_readers', 'access_token']) {
        await failure(await send(origin, row, { body: JSON.stringify({ ...row.http.body, [field]: 'untrusted' }) }));
      }
      if (!Object.hasOwn(row.http.body!, 'membership_id')) {
        await failure(await send(origin, row, { body: JSON.stringify({ ...row.http.body, membership_id: 'untrusted' }) }));
      }
    }
    await failure(await send(origin, fixture('updates-submit-v2'), { body: JSON.stringify({ ...fixture('updates-submit-v2').http.body, schema_version: 1 }) }));
    expect(calls).toEqual([]);
  });

  it('rejects malformed, duplicate, nested duplicate and non-UTF-8 JSON', async () => {
    const origin = await start(); const row = fixture('updates-submit-v2');
    const serialized = JSON.stringify(row.http.body);
    for (const body of [
      '', '{', 'null', '[]',
      serialized.replace('"schema_version":2', '"schema_version":1,"schema_version":2'),
      serialized.replace('"schema_version":2', '"schema_version":1,"schema_\\u0076ersion":2'),
      serialized.replace('"kind":"project"', '"kind":"team","kind":"project"'),
      Buffer.concat([Buffer.from(serialized.slice(0, -1)), Buffer.from([0xc3, 0x28]), Buffer.from('}')]),
    ]) await failure(await send(origin, row, { body }));
    expect(calls).toEqual([]);
  });

  it('accepts exactly 16 KiB on the wire and refuses overflow before dispatch', async () => {
    const origin = await start(); const row = fixture('projects-create');
    const json = JSON.stringify(row.http.body);
    const body = json + ' '.repeat(MAX_ORGANIZATION_API_BODY_BYTES - Buffer.byteLength(json));
    expect((await send(origin, row, { body })).status).toBe(201);
    await failure(await send(origin, row, { body: body + ' ' }));
    expect(calls).toHaveLength(1);
  });

  it('rejects unknown/duplicate query parameters, invalid page bounds and noncanonical IDs', async () => {
    const origin = await start();
    for (const query of ['limit=0', 'limit=11', 'limit=01', 'limit=1e0', 'limit=', 'limit=1&limit=2', 'cursor=YQ&cursor=Yg', 'cursor=!', 'cursor=', 'principal_id=untrusted']) {
      await failure(await fetch(`${origin}/v1/person/projects?${query}`, { headers }));
    }
    for (const path of ['/v1/person/projects/not-an-id', '/v2/person/updates/not-a-request', '/v2/person/updates/content/not-a-context', fixture('projects-read').http.path + '?organization_id=untrusted']) {
      await failure(await fetch(origin + path, { headers }));
    }
    for (const row of fixtures.filter(row => row.http.body !== undefined)) {
      await failure(await fetch(origin + row.http.path + '?principal_id=untrusted', { method: 'POST', headers, body: JSON.stringify(row.http.body) }));
    }
    expect(calls).toEqual([]);
  });

  it('rejects a GET body rather than discarding caller fields', async () => {
    const origin = await start();
    const result = await new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
      const body = JSON.stringify({ principal_id: 'untrusted' });
      const request = httpRequest(`${origin}/v1/person/projects`, { method: 'GET', headers: { ...headers, 'content-length': Buffer.byteLength(body) } }, response => {
        let data = ''; response.on('data', chunk => { data += String(chunk); });
        response.on('end', () => resolve({ status: response.statusCode, body: data }));
      });
      request.on('error', reject); request.end(body);
    });
    expect(result).toEqual({ status: 400, body: JSON.stringify({ error: { code: 'invalid_request', message: 'request failed' } }) });
    expect(calls).toEqual([]);
  });

  it('keeps unsupported methods/routes and capability absence non-disclosing', async () => {
    const origin = await start();
    for (const row of fixtures) {
      await failure(await send(origin, row, { method: 'PUT', body: '{}' }), 404, 'not_found');
    }
    for (const path of ['/v1/person/projects/context/feed', '/v1/person/projects/members', '/v2/person/updates/search', '/v2/person/updates']) {
      await failure(await fetch(origin + path, { headers }), 404, 'not_found');
    }
    expect(calls).toEqual([]);
    const disabled = await start(fake(), { project_context: undefined });
    for (const row of fixtures) await failure(await send(disabled, row), 404, 'not_found');
    const hidden = await start(fake({ readProject() { throw new AuthorityOperationError('not_found', 'private project'); } }));
    expect((await fetch(`${hidden}/v1/person/projects`, { headers })).status).toBe(200);
    await failure(await send(hidden, fixture('projects-read')), 404, 'not_found');
  });

  it.each(fixtures)('requires Person bearer authentication: $id', async row => {
    const origin = await start();
    await failure(await send(origin, row, { headers: {} }), 401, 'unauthorized');
    expect(calls).toEqual([]);
    await failure(await send(origin, row, { headers: { authorization: 'Bearer expired' } }), 401, 'unauthorized');
  });

  it.each([
    ['invalid_request', 400], ['conflict', 409], ['invalid_output', 502], ['not_found', 404],
    ['stale_access_state', 400], ['unauthorized', 401], ['rate_limited', 429], ['unavailable', 503],
  ] as const)('preserves canonical %s errors without diagnostics', async (code, status) => {
    const origin = await start(fake({ listProjects() { throw new AuthorityOperationError(code, 'sensitive source diagnostic'); } }));
    await failure(await fetch(`${origin}/v1/person/projects`, { headers }), status, code);
  });

  it.each(fixtures)('sanitizes unexpected application failures as unavailable: $id', async row => {
    const origin = await start(fake({
      [operations[row.id]!]() { throw new Error('SQLITE_IOERR: private persistence diagnostic'); },
    }));
    await failure(await send(origin, row), 503, 'unavailable');
  });

  it('rejects invalid application output and permits a full 8 KiB original response', async () => {
    const row = fixture('projects-read-context');
    const large = { ...row.http.response, text: '\t'.repeat(8191) + 'x' };
    expect(Buffer.byteLength(JSON.stringify(large))).toBeGreaterThan(16 * 1024);
    expect(Buffer.byteLength(JSON.stringify(large))).toBeLessThan(PROJECT_CONTEXT_RESPONSE_MAX_BYTES);
    const origin = await start(fake({ readContext: () => large as never }));
    const response = await send(origin, row);
    expect(response.status).toBe(200); expect(await response.json()).toEqual(large);
    for (const output of [{ ...large, hidden_count: 1 }, { ...large, text: 'x'.repeat(PROJECT_CONTEXT_RESPONSE_MAX_BYTES) }, { ...large, kind: 'echo-person-upload-content-v2' }]) {
      const bad = await start(fake({ readContext: () => output as never }));
      await failure(await send(bad, row), 502, 'invalid_output');
    }
  });

  it('reserves project and V2 route families against every provider ingress', () => {
    for (const key of ['private_approval_interaction_ingress', 'person_external_identity_link', 'person_tools']) {
      for (const path of ['/v1/person/projects', fixture('projects-read-context').http.path, '/v2/person/updates', '/v2/person/updates/search', '/v1/person/directory', '/v1/person/directory/next']) {
        expect(() => createOrganizationAuthorityHttpServer({ ...options(), [key]: { routes: [{ route_id: 'collision', method: 'POST', path }], accept: async () => ({ status: 200, body: {} }) } })).toThrow('collides with Authority route');
      }
    }
  });
});

describe('organization people directory HTTP route', () => {
  const page = { schema_version: 1, kind: 'echo-organization-directory-v1', items: [{ membership_id: 'mem_22222222-2222-4222-8222-222222222222', display_name: 'Ari' }], next_cursor: null };
  const directory = (response: unknown = page) => fake({ searchOrganizationDirectory: (...args: unknown[]) => {
    calls.push({ operation: 'searchOrganizationDirectory', args });
    if (args[0] !== 'fixture-session') throw new AuthorityOperationError('unauthorized', 'private diagnostic');
    return structuredClone(response) as never;
  } });
  const post = (origin: string, body: unknown, init: RequestInit = {}) =>
    fetch(`${origin}/v1/person/directory`, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body), ...init });

  it('dispatches a search and a default first page with no project', async () => {
    const origin = await start(directory());
    const response = await post(origin, { query: 'ari', limit: 10 });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toBe(JSON.stringify(page));
    expect((await post(origin, {})).status).toBe(200);
    expect(calls).toEqual([
      { operation: 'searchOrganizationDirectory', args: ['fixture-session', { query: 'ari', limit: 10 }] },
      { operation: 'searchOrganizationDirectory', args: ['fixture-session', { limit: 10 }] },
    ]);
  });

  it('rejects caller-chosen coordinates, bad bounds, a query string and other methods before the application', async () => {
    const origin = await start(directory());
    for (const body of [
      { project_id: 'prj_11111111-1111-4111-8111-111111111111' }, { organization_id: 'org_other' },
      { membership_id: 'mem_22222222-2222-4222-8222-222222222222' }, { principal_id: 'untrusted' },
      { query: '' }, { query: ' ari' }, { limit: 0 }, { limit: 11 }, { cursor: 'AB' }, [], null, '{"query":"a","query":"b"}',
    ]) await failure(await post(origin, body));
    await failure(await fetch(`${origin}/v1/person/directory?limit=10`, { method: 'POST', headers, body: '{}' }));
    await failure(await fetch(`${origin}/v1/person/directory`, { headers }), 404, 'not_found');
    await failure(await post(origin, {}, { method: 'PUT' }), 404, 'not_found');
    expect(calls).toEqual([]);
  });

  it('requires a current Person session and stays hidden when projects are not composed', async () => {
    const origin = await start(directory());
    await failure(await post(origin, {}, { headers: { 'content-type': 'application/json' } }), 401, 'unauthorized');
    expect(calls).toEqual([]);
    await failure(await post(origin, {}, { headers: { ...headers, authorization: 'Bearer revoked' } }), 401, 'unauthorized');
    await failure(await post(await start(fake(), { project_context: undefined }), {}), 404, 'not_found');
  });

  it('withholds any page that is not an exact organization directory', async () => {
    for (const output of [
      { ...page, project_id: 'prj_11111111-1111-4111-8111-111111111111' }, { ...page, kind: 'echo-project-directory-v1' },
      { ...page, items: [{ ...page.items[0], email: 'ari@example.test' }] }, { ...page, items: [page.items[0], page.items[0]] },
    ]) await failure(await post(await start(directory(output)), {}), 502, 'invalid_output');
  });
});
