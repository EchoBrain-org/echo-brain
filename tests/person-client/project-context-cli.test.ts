import { readFileSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalJson } from '@echo-brain/federation-protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runPersonClientCli } from '../../src/product/person-client/composition.js';
import { PersonSessionStore } from '../../src/product/person-client/session-store.js';

interface Operation {
  id: string;
  argv: string[];
  http: { method: string; path: string; status: number; body?: Record<string, unknown>; response: Record<string, unknown> };
}
const fixtures = JSON.parse(readFileSync(new URL('../fixtures/project-context-v1/operations.json', import.meta.url), 'utf8')) as { operations: Operation[] };
const failures = JSON.parse(readFileSync(new URL('../fixtures/project-context-v1/invalid.json', import.meta.url), 'utf8')) as {
  errors: { id: string; http_status: number; http: unknown; cli: { action: string; [key: string]: unknown } }[];
};
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
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

describe('frozen project context CLI contract', () => {
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
    expect(await runPersonClientCli([...operation.argv.slice(0, 2), '--help'], { fetch: network,
      stdout: { write: value => { output += value; } }, stderr: { write: () => {} } })).toBe(0);
    expect(output).toContain(`echo-brain person ${operation.argv.slice(0, 2).join(' ')}`);
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
