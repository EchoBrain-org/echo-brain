import { readFileSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalJson } from '@echo-brain/federation-protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runPersonClientCli } from '../../src/product/person-client/composition.js';
import { PersonSessionStore } from '../../src/product/person-client/session-store.js';
import { PersonClient } from '../../src/product/person-client/client.js';
import { PersonAuthorityClient } from '../../src/product/person-client/authority-client.js';
import { validatePersonUpdateSubmitV2 } from '@echo-brain/organization-api';

interface Operation {
  id: string;
  argv: string[];
  http: { method: string; path: string; status: number; body?: Record<string, unknown>; response: Record<string, unknown> };
}
const fixtures = JSON.parse(readFileSync(new URL('../fixtures/project-context-v1/operations.json', import.meta.url), 'utf8')) as { operations: Operation[] };
const failures = JSON.parse(readFileSync(new URL('../fixtures/project-context-v1/invalid.json', import.meta.url), 'utf8')) as {
  errors: { id: string; http_status: number; http: unknown; cli: { action: string; [key: string]: unknown } }[];
};
const visibility = JSON.parse(readFileSync(new URL('../fixtures/project-context-v1/visibility.json', import.meta.url), 'utf8')) as {
  submits: { id: string; cli: string[]; body: Record<string, unknown> }[];
};
const operation = (id: string) => fixtures.operations.find(item => item.id === id)!;
const projectId = 'prj_11111111-1111-4111-8111-111111111111';
const otherProject = 'prj_44444444-4444-4444-8444-444444444444';
const upload = operation('updates-submit-v2');
const homes: string[] = [];
const now = '2026-09-21T22:01:00.000Z';
function setup() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'echo-project-cli-')));
  homes.push(home);
  new PersonSessionStore(home).install('https://authority.example', 'oau_00000000-0000-4000-8000-000000000001', {
    organization_id: 'org_00000000-0000-4000-8000-000000000001',
    principal_id: 'prn_00000000-0000-4000-8000-000000000001',
    membership_id: 'mem_00000000-0000-4000-8000-000000000001',
    display_name: 'Fixture Person', membership_type: 'employee',
    identity_binding_id: 'oib_00000000-0000-4000-8000-000000000001',
    session_family_id: 'psf_00000000-0000-4000-8000-000000000001',
    access_token: 'A'.repeat(43), refresh_token: 'R'.repeat(43),
    access_expires_at: '2026-09-21T22:11:00.000Z',
    refresh_expires_at: '2026-09-28T22:00:00.000Z', hard_reauthentication_at: '2026-09-28T22:00:00.000Z',
  });
  const file = join(home, 'snapshot.txt');
  writeFileSync(file, 'We agreed to ship.\n');
  return { home, file };
}
function json(value: unknown, status = 200) {
  return new Response(canonicalJson(value), { status, headers: { 'content-type': 'application/json' } });
}
async function run(operation: Operation, fetch: typeof globalThis.fetch, extraArgv: string[] = []) {
  const { home, file } = setup();
  let stdout = ''; let stderr = '';
  const argv = [...operation.argv.map(value => value === '/private/snapshot.txt' ? file : value), ...extraArgv];
  const code = await runPersonClientCli(argv, { home_directory: home, now: () => now, fetch,
    stdout: { write: value => { stdout += value; } }, stderr: { write: value => { stderr += value; } } });
  return { code, stdout, stderr };
}
function isMutation(item: Operation) { return item.http.body?.request_id !== undefined; }
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

describe('frozen project context CLI contract', () => {
  it.each(visibility.submits)('$id keeps audience and association independent', async example => {
    const item: Operation = { id: example.id, argv: example.cli, http: { ...upload.http,
      body: { ...example.body, text: 'We agreed to ship.\n' }, response: { ...upload.http.response,
        request_id: example.body.request_id, audience: example.body.audience, project_id: example.body.project_id } } };
    const network = vi.fn<typeof fetch>(async (_url, init) => {
      expect(JSON.parse(String(init?.body))).toEqual(item.http.body);
      return json(item.http.response, 202);
    });
    const result = await run(item, network);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(item.http.response);
  });

  it.each(fixtures.operations)('$id rejects unknown success fields without releasing content', async item => {
    const result = await run(item, async () => json({ ...item.http.response, private_extra: 'must not leak' }, item.http.status));
    expect(result.code).toBe(1); expect(result.stdout).toBe('');
    expect(result.stderr).not.toContain('must not leak');
    expect(JSON.parse(result.stderr)).toMatchObject({ code: isMutation(item) ? 'outcome_unknown' : 'invalid_response',
      ...(isMutation(item) ? { mutation_outcome: 'unknown', request_id: item.http.body!.request_id } : {}) });
  });

  it.each(fixtures.operations)('$id rejects an unexpected success status', async item => {
    const result = await run(item, async () => json(item.http.response, item.http.status === 200 ? 201 : 200));
    expect(result.code).toBe(1); expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr).code).toBe(isMutation(item) ? 'outcome_unknown' : 'invalid_response');
  });

  const mismatches: [string, Record<string, unknown>][] = [
    ['projects-create', { request_id: '00000000-0000-4000-8000-000000000009' }],
    ['projects-read', { project_id: otherProject }],
    ['projects-members', { project_id: otherProject }], ['projects-directory', { project_id: otherProject }],
    ['projects-member-add', { membership_id: 'mem_44444444-4444-4444-8444-444444444444' }],
    ['projects-member-set', { operation: 'member_remove' }],
    ['projects-member-set', { membership_id: 'mem_44444444-4444-4444-8444-444444444444' }],
    ['projects-member-remove', { project_id: otherProject }],
    ['projects-associate', { context_id: `ctx_${'b'.repeat(64)}` }], ['projects-dissociate', { operation: 'associate' }],
    ['projects-feed', { project_id: otherProject }], ['projects-search', { project_id: otherProject }],
    ['projects-read-context', { context_id: `ctx_${'b'.repeat(64)}` }],
    ['updates-submit-v2', { audience: { kind: 'team' } }], ['updates-submit-v2', { project_id: otherProject }],
    ['updates-submit-v2', { audience: { kind: 'project', project_id: otherProject } }],
    ['updates-status-v2', { request_id: '00000000-0000-4000-8000-000000000009' }],
    ['updates-read-v2', { context_id: `ctx_${'b'.repeat(64)}` }],
  ];
  it.each(mismatches)('%s binds decoded responses to the requested coordinates (%j)', async (id, change) => {
    const item = operation(id);
    const result = await run(item, async () => json({ ...item.http.response, ...change }, item.http.status));
    expect(result.code).toBe(1); expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr).code).toBe(isMutation(item) ? 'outcome_unknown' : 'invalid_response');
  });

  it.each(fixtures.operations.filter(isMutation))('$id classifies closed 4xx and uncertain failures without retrying', async item => {
    for (const [status, code] of [[400, 'invalid_request'], [400, 'stale_access_state'], [401, 'unauthorized'], [404, 'not_found'],
      [409, 'conflict'], [409, 'quota_exceeded'], [429, 'rate_limited'], [502, 'invalid_output'], [503, 'unavailable']] as const) {
      const network = vi.fn<typeof fetch>(async () => json({ error: { code, message: 'sensitive diagnostic' } }, status));
      const result = await run(item, network);
      expect(result.code).toBe(1); expect(result.stdout).toBe('');
      expect(result.stderr).not.toContain('sensitive');
      expect(JSON.parse(result.stderr)).toMatchObject({ status, request_id: item.http.body!.request_id,
        code: status < 500 ? code : 'outcome_unknown', mutation_outcome: status < 500 ? 'not_submitted' : 'unknown' });
      expect(network).toHaveBeenCalledTimes(1);
    }
  });

  it.each([
    ['noncanonical error', () => json({ error: { code: 'new_error', message: 'private' } }, 400)],
    ['malformed error', () => json({ error: { code: 'invalid_request', message: 'private', extra: true } }, 400)],
    ['HTML', () => new Response('private', { status: 404, headers: { 'content-type': 'text/html' } })],
    ['invalid JSON', () => new Response('{private', { status: 400, headers: { 'content-type': 'application/json' } })],
    ['invalid UTF-8', () => new Response(new Uint8Array([0xc3, 0x28]), { status: 400, headers: { 'content-type': 'application/json' } })],
    ['duplicate error', () => new Response('{"error":{"code":"unavailable","code":"invalid_request","message":"private"}}', { status: 400, headers: { 'content-type': 'application/json' } })],
    ['oversized', () => new Response(' '.repeat(32769), { status: 400, headers: { 'content-type': 'application/json' } })],
    ['lost response', () => { throw new Error('private connection diagnostic'); }],
  ] as const)('treats %s as unknown and retains the upload request ID', async (_name, response) => {
    const network = vi.fn<typeof fetch>(async () => response());
    const result = await run(upload, network);
    expect(result.code).toBe(1); expect(result.stdout).toBe(''); expect(result.stderr).not.toContain('private');
    expect(JSON.parse(result.stderr)).toMatchObject({ code: 'outcome_unknown', mutation_outcome: 'unknown', request_id: upload.http.body!.request_id });
    expect(network).toHaveBeenCalledTimes(1);
  });

  const invalidArgv = [
    ['projects', 'feed'], ['projects', 'search', '--project-id', projectId, '--query', ''],
    ['projects', 'list', '--limit', '0'], ['projects', 'list', '--limit', '11'], ['projects', 'list', '--limit', '1e0'],
    ['projects', 'list', '--cursor', 'bad cursor'], ['projects', 'list', '--cursor', 'AB'],
    ['projects', 'list', '--limit', '1', '--limit=2'],
    ['projects', 'read', '--project-id', projectId, '--project-id', otherProject],
    ['projects', 'feed', '--project-id', '../../updates'],
    ['projects', 'ask', '--question', 'ship'], ['ask', '--question', 'ship', '--project-id', projectId],
    ['updates', 'search', '--query', 'ship', '--project-id', projectId],
    ['updates', 'read', '--context-id', `ctx_${'g'.repeat(64)}`],
    [...upload.argv.filter((_, i) => i < upload.argv.indexOf('--visibility')), '--audience-project-id', projectId],
    [...upload.argv.slice(0, upload.argv.indexOf('--audience-project-id'))],
    [...upload.argv, '--visibility', 'team'], [...upload.argv, '--project-id', otherProject],
    [...upload.argv, '--request-id', '00000000-0000-4000-8000-000000000008'],
    [...upload.argv.slice(0, upload.argv.indexOf('--visibility')), '--visibility', 'only_me'],
    [...operation('projects-member-set').argv.slice(0, -1), 'owner'],
    [...operation('projects-create').argv, '--organization-id', 'private-input'],
    ['directory', '--project-id', projectId], ['directory', '--membership-id', 'mem_44444444-4444-4444-8444-444444444444'],
    ['directory', '--query', ''], ['directory', '--query', ' ari'], ['directory', '--limit', '0'], ['directory', '--limit', '11'],
    ['directory', '--cursor', 'AB'], ['directory', '--query', 'ari', '--query', 'bo'], ['directory', 'private-input'],
    ['directory', '--organization-id', 'private-input'],
  ];
  it.each(invalidArgv.map(argv => ({ argv })))('rejects invalid/ambiguous argv before network: $argv', async ({ argv }) => {
    const network = vi.fn();
    const result = await run({ ...upload, argv }, network);
    expect(result.code).not.toBe(0); expect(result.stdout).toBe(''); expect(network).not.toHaveBeenCalled();
    expect(result.stderr).not.toContain('private-input');
  });

  it('accepts ordinary JSON object order but rejects duplicate escaped keys, nested extras, and duplicate item IDs', async () => {
    const item = operation('projects-feed');
    expect((await run(item, async () => new Response(JSON.stringify(item.http.response, null, 2), { headers: { 'content-type': 'application/json' } }))).code).toBe(0);
    const rows = item.http.response.items as Record<string, unknown>[];
    const bad = [
      JSON.stringify(item.http.response).replace('"schema_version":1', '"schema_version":2,"schema_\\u0076ersion":1'),
      JSON.stringify({ ...item.http.response, items: [...rows, ...rows] }),
      JSON.stringify({ ...item.http.response, items: rows.map(row => ({ ...row, audience: { kind: 'team', project_id: projectId } })) }),
    ];
    for (const body of bad) {
      const result = await run(item, async () => new Response(body, { headers: { 'content-type': 'application/json' } }));
      expect(result.code).toBe(1); expect(result.stdout).toBe('');
    }
  });

  it('uses the V2 project feed for a projects-audience upload without downcasting its audience', async () => {
    const { home } = setup(); let stdout = ''; let stderr = '';
    const contextId = `ctx_${'c'.repeat(64)}`;
    const response = { schema_version: 2, kind: 'echo-project-context-feed-v2', project_id: projectId, items: [{
      context_id: contextId, received_at: now, title: 'SCOUT MRD', excerpt: 'Autonomous inspection requirements', audience: { kind: 'projects', project_ids: [projectId, otherProject] },
    }], next_cursor: null };
    const code = await runPersonClientCli(['projects', 'feed-v2', '--project-id', projectId], { home_directory: home, now: () => now,
      fetch: async (url, init) => {
        expect(String(url)).toBe('https://authority.example/v2/person/projects/context/feed');
        expect(init?.method).toBe('POST'); expect(JSON.parse(String(init?.body))).toEqual({ project_id: projectId, limit: 10 });
        return json(response);
      }, stdout: { write: value => { stdout += value; } }, stderr: { write: value => { stderr += value; } } });
    expect(code, stderr).toBe(0); expect(JSON.parse(stdout)).toEqual(response);
  });

  it('supports the full 8 KiB original under the 32 KiB wire bound', async () => {
    const item = operation('updates-read-v2');
    const response = { ...item.http.response, text: '\t'.repeat(8191) + 'x' };
    expect(Buffer.byteLength(JSON.stringify(response))).toBeGreaterThan(16384);
    const result = await run(item, async () => json(response));
    expect(result.code, result.stderr).toBe(0); expect(JSON.parse(result.stdout)).toEqual(response);
  });

  it('reports actual transport timeout as unknown without a replay', async () => {
    const network = vi.fn<typeof fetch>(async (_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new Error('timeout')), { once: true });
    }));
    const authority = new PersonAuthorityClient({ authority_origin: 'https://authority.example', fetch: network, timeout_ms: 5 });
    await expect(authority.submitUpdateV2('fixture', validatePersonUpdateSubmitV2(upload.http.body))).rejects.toMatchObject({
      code: 'outcome_unknown', mutation_outcome: 'unknown', request_id: upload.http.body!.request_id, status: null,
    });
    expect(network).toHaveBeenCalledTimes(1);
  });

  it('snapshots the original and independent project coordinates before yielding; unknown recovery only reads V2 status', async () => {
    const { home } = setup();
    const request = { ...validatePersonUpdateSubmitV2(upload.http.body), project_id: otherProject as `prj_${string}` };
    const original = structuredClone(request);
    const status = { ...operation('updates-status-v2').http.response, project_id: otherProject };
    const paths: string[] = [];
    const client = new PersonClient({ home_directory: home, now: () => now, fetch: async (url, init) => {
      paths.push(new URL(String(url)).pathname);
      if (init?.method === 'POST') {
        expect(JSON.parse(String(init.body))).toEqual(original);
        throw new Error('lost receipt after store');
      }
      return json(status);
    } });
    const pending = client.submitUpdateV2(request);
    request.text = 'changed draft'; request.project_id = projectId;
    if (request.audience.kind === 'project') Object.assign(request.audience, { project_id: otherProject });
    await expect(pending).rejects.toMatchObject({ mutation_outcome: 'unknown', request_id: original.request_id });
    await expect(client.updateStatusV2(original.request_id)).resolves.toEqual(status);
    expect(paths).toEqual(['/v2/person/updates', `/v2/person/updates/${original.request_id}`]);
  });

  it('does not release a response after the local account changes', async () => {
    const { home } = setup(); const store = new PersonSessionStore(home);
    const client = new PersonClient({ home_directory: home, now: () => now, fetch: async () => {
      const stored = store.read();
      store.install(stored.authority_origin, stored.authority_id, { ...stored.session,
        membership_id: 'mem_44444444-4444-4444-8444-444444444444' });
      return json(operation('projects-list').http.response);
    } });
    await expect(client.projects()).rejects.toMatchObject({ code: 'stale_access_state' });
  });

  it.each(failures.errors)('$id preserves the exact sanitized failure contract', async failure => {
    const operation = fixtures.operations.find(item => item.id === failure.cli.action || item.id === `${failure.cli.action}-v2`)!;
    const network = vi.fn<typeof fetch>(async () => json(failure.http, failure.http_status));
    const result = await run(operation, network);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toEqual(failure.cli);
    expect(network).toHaveBeenCalledTimes(1);
  });

  it.each(fixtures.operations)('$id has help without network or a session', async operation => {
    const network = vi.fn(); let output = '';
    // `person directory` is one word; the project families are `<family> <action>`.
    const command = operation.argv.slice(0, operation.argv[0] === 'directory' ? 1 : 2);
    expect(await runPersonClientCli([...command, '--help'], { fetch: network,
      stdout: { write: value => { output += value; } }, stderr: { write: () => {} } })).toBe(0);
    expect(output).toContain(`echo-brain person ${command.join(' ')}`);
    expect(network).not.toHaveBeenCalled();
  });

  it.each(fixtures.operations)('$id maps exact argv to the frozen HTTP and success JSON', async operation => {
    const network = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      expect(`${url.pathname}${url.search}`).toBe(operation.http.path);
      expect(init?.method).toBe(operation.http.method);
      expect(init?.redirect).toBe('error');
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${'A'.repeat(43)}`);
      expect(init?.body === undefined ? undefined : JSON.parse(String(init.body))).toEqual(operation.http.body);
      return json(operation.http.response, operation.http.status);
    });
    const result = await run(operation, network);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.stdout.endsWith('\n')).toBe(true);
    expect(JSON.parse(result.stdout)).toEqual(operation.http.response);
    expect(network).toHaveBeenCalledTimes(1);
  });
});

describe('person directory CLI', () => {
  const page = operation('person-directory').http.response;
  async function directory(argv: string[], fetch: typeof globalThis.fetch, signedIn = true) {
    const home = signedIn ? setup().home : realpathSync(mkdtempSync(join(tmpdir(), 'echo-project-cli-')));
    if (!signedIn) homes.push(home);
    let stdout = ''; let stderr = '';
    const code = await runPersonClientCli(['directory', ...argv], { home_directory: home, now: () => now, fetch,
      stdout: { write: value => { stdout += value; } }, stderr: { write: value => { stderr += value; } } });
    return { code, stdout, stderr };
  }

  it('browses the first page with no query or project, then follows the opaque cursor', async () => {
    const bodies: unknown[] = [];
    const network = vi.fn<typeof fetch>(async (input, init) => {
      expect(new URL(String(input)).pathname).toBe('/v1/person/directory');
      bodies.push(JSON.parse(String(init?.body)));
      return json({ ...page, next_cursor: bodies.length === 1 ? 'AQ' : null });
    });
    const first = await directory([], network);
    expect(first.code, first.stderr).toBe(0);
    expect(JSON.parse(first.stdout)).toEqual({ ...page, next_cursor: 'AQ' });
    const next = await directory(['--limit', '5', '--cursor', 'AQ'], network);
    expect(next.code, next.stderr).toBe(0);
    expect(bodies).toEqual([{ limit: 10 }, { limit: 5, cursor: 'AQ' }]);
  });

  it('asks for sign-in without a session and never calls the Authority', async () => {
    const network = vi.fn();
    const result = await directory(['--query', 'ari'], network, false);
    expect(result.code).toBe(1); expect(result.stdout).toBe(''); expect(network).not.toHaveBeenCalled();
    expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, action: 'directory', code: 'sign_in_required' });
  });

  it.each([[401, 'unauthorized'], [400, 'invalid_request'], [404, 'not_found'], [503, 'unavailable']] as const)(
    'reports a %i %s rejection as a read failure without server text', async (status, code) => {
      const result = await directory(['--query', 'ari'], async () => json({ error: { code, message: 'private diagnostic' } }, status));
      expect(result.code).toBe(1); expect(result.stdout).toBe(''); expect(result.stderr).not.toContain('private');
      const failure = JSON.parse(result.stderr);
      expect(failure).toEqual({ ok: false, action: 'directory', error: 'Person Authority rejected the request', code, status });
    });

  it('does not release a page after the local account changes during the request', async () => {
    const { home } = setup(); const store = new PersonSessionStore(home);
    const client = new PersonClient({ home_directory: home, now: () => now, fetch: async () => {
      const stored = store.read();
      store.install(stored.authority_origin, stored.authority_id, { ...stored.session,
        membership_id: 'mem_44444444-4444-4444-8444-444444444444' });
      return json(page);
    } });
    await expect(client.organizationDirectory({ query: 'ari' })).rejects.toMatchObject({ code: 'stale_access_state' });
  });

  it('withholds a page longer than the requested limit or carrying a project', async () => {
    const extra = { membership_id: 'mem_44444444-4444-4444-8444-444444444444', display_name: 'Bo' };
    for (const response of [{ ...page, items: [...(page.items as unknown[]), extra] }, { ...page, project_id: projectId }]) {
      const result = await directory(['--limit', '1'], async () => json(response));
      expect(result.code).toBe(1); expect(result.stdout).toBe('');
      expect(JSON.parse(result.stderr)).toMatchObject({ action: 'directory', code: 'invalid_response' });
    }
  });
});
