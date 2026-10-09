import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PersonAuthorityClient } from '../../src/product/person-client/authority-client.js';
import { runPersonClientCli } from '../../src/product/person-client/composition.js';
import { PersonSessionStore } from '../../src/product/person-client/session-store.js';

const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

function sessionHome(): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'echo-person-runs-cli-'))); homes.push(home);
  new PersonSessionStore(home).install('https://authority.example.test', 'oau_00000000-0000-4000-8000-000000000001', {
    organization_id: 'org_00000000-0000-4000-8000-000000000001', principal_id: 'prn_00000000-0000-4000-8000-000000000001', membership_id: 'mem_00000000-0000-4000-8000-000000000001',
    display_name: 'Maya Chen', membership_type: 'employee', identity_binding_id: 'oib_00000000-0000-4000-8000-000000000001', session_family_id: 'psf_00000000-0000-4000-8000-000000000001',
    access_token: 'A'.repeat(43), refresh_token: 'R'.repeat(43), access_expires_at: '2026-10-07T10:10:00.000Z', refresh_expires_at: '2026-10-14T10:00:00.000Z', hard_reauthentication_at: '2026-10-14T10:00:00.000Z',
  });
  return home;
}

describe('person runs client', () => {
  it('validates its request before networking and returns the operation result', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json({ runs: [] }));
    const client = new PersonAuthorityClient({ authority_origin: 'https://authority.example.test', fetch });
    await expect(client.runs('bearer', { schema_version: 1, operation: 'list' })).resolves.toEqual({ runs: [] });
    expect(new URL(String(fetch.mock.calls[0]![0])).pathname).toBe('/v1/person/runs');
    await expect(client.runs('bearer', { schema_version: 1, operation: 'start', run_id: 'bad' } as never)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('runs the CLI request parser, prints the operation result, and refuses malformed JSON before networking', async () => {
    const home = sessionHome(); let stdout = ''; let stderr = '';
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json({ runs: [] }));
    expect(await runPersonClientCli(['runs', '--request', '{"schema_version":1,"operation":"list"}'], {
      home_directory: home, now: () => '2026-10-07T10:00:00.000Z', fetch,
      stdout: { write: value => { stdout += value; } }, stderr: { write: value => { stderr += value; } },
    })).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ ok: true, result: { runs: [] } });
    expect(new URL(String(fetch.mock.calls[0]![0])).pathname).toBe('/v1/person/runs');
    const noNetwork = vi.fn<typeof globalThis.fetch>(); stdout = ''; stderr = '';
    expect(await runPersonClientCli(['runs', '--request', '{'], {
      home_directory: home, now: () => '2026-10-07T10:00:00.000Z', fetch: noNetwork,
      stdout: { write: value => { stdout += value; } }, stderr: { write: value => { stderr += value; } },
    })).toBe(2);
    expect(JSON.parse(stderr)).toMatchObject({ ok: false });
    expect(noNetwork).not.toHaveBeenCalled();
  });

  it('runs an open-items request and names every operation in its help', async () => {
    const home = sessionHome(); let stdout = ''; let stderr = '';
    const empty = { send: [], items: [], landed: 0, waiting: 0, last_checked_at: null, sweep_due: false };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json(empty));
    const io = { home_directory: home, now: () => '2026-10-07T10:00:00.000Z', stdout: { write: (value: string) => { stdout += value; } }, stderr: { write: (value: string) => { stderr += value; } } };
    expect(await runPersonClientCli(['runs', '--request', '{"schema_version":1,"operation":"home"}'], { ...io, fetch })).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ ok: true, result: empty });
    expect(JSON.parse(String(fetch.mock.calls[0]![1]!.body))).toEqual({ schema_version: 1, operation: 'home' });
    stdout = '';
    expect(await runPersonClientCli(['runs', '--help'], { ...io, fetch: vi.fn() })).toBe(0);
    for (const operation of ['list', 'start', 'retry', 'view', 'home', 'items', 'item', 'send', 'set_state', 'assign']) expect(stdout).toContain(operation);
    expect(stderr).toBe('');
  });
});
