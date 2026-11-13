import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PersonAuthorityClient } from '../../src/product/person-client/authority-client.js';
import { runPersonClientCli } from '../../src/product/person-client/composition.js';
import { signedInHome } from './signed-in-home.js';

const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

function sessionHome(): string {
  const home = signedInHome({ prefix: 'echo-person-runs-cli-', now: '2026-10-07T10:00:00.000Z' }); homes.push(home);
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

  it('checks in with next, which names no run, and refuses an answer outside its states', async () => {
    const home = sessionHome(); let stdout = '';
    const io = { home_directory: home, now: () => '2026-10-07T10:00:00.000Z', stdout: { write: (value: string) => { stdout += value; } }, stderr: { write: () => undefined } };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json({ state: 'idle' }));
    expect(await runPersonClientCli(['runs', '--request', '{"schema_version":1,"operation":"next"}'], { ...io, fetch })).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ ok: true, result: { state: 'idle' } });
    expect(new URL(String(fetch.mock.calls[0]![0])).pathname).toBe('/v1/person/runs');
    expect(JSON.parse(String(fetch.mock.calls[0]![1]!.body))).toEqual({ schema_version: 1, operation: 'next' });
    // The client checks each answer against its operation: a next answer outside its states is the Authority's mistake.
    const finished = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json({ state: 'done' })); stdout = '';
    expect(await runPersonClientCli(['runs', '--request', '{"schema_version":1,"operation":"next"}'], { ...io, fetch: finished })).not.toBe(0);
    expect(stdout).toBe('');
  });

  it('runs an open-items request and names every operation in its help', async () => {
    const home = sessionHome(); let stdout = ''; let stderr = '';
    const empty = { send: [], items: [], waiting: 0 };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json(empty));
    const io = { home_directory: home, now: () => '2026-10-07T10:00:00.000Z', stdout: { write: (value: string) => { stdout += value; } }, stderr: { write: (value: string) => { stderr += value; } } };
    expect(await runPersonClientCli(['runs', '--request', '{"schema_version":1,"operation":"home"}'], { ...io, fetch })).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ ok: true, result: empty });
    expect(JSON.parse(String(fetch.mock.calls[0]![1]!.body))).toEqual({ schema_version: 1, operation: 'home' });
    stdout = '';
    expect(await runPersonClientCli(['runs', '--help'], { ...io, fetch: vi.fn() })).toBe(0);
    for (const operation of ['list', 'start', 'next', 'retry', 'view', 'home', 'items', 'item', 'send', 'set_state', 'assign']) expect(stdout).toContain(operation);
    // Sweeps are retired (SVC-2): the help names none.
    expect(stdout).not.toContain('sweep');
    expect(stdout).toContain('list                 your own impact runs\n');
    expect(stdout).toContain('false dismisses it, and unlisted items stay unsent');
    expect(stdout).toContain('before send the approver only');
    expect(stdout).toContain('read "rows" reads no item live (every reach not_read)\n');
    expect(stdout).toContain('read "rows" answers the same page with no item read live (every reach not_read), and read "counts" the counts alone');
    expect(stdout).toContain('states (a non-empty list of unsent, open, done and not_relevant) pages over items in those states only');
    expect(stderr).toBe('');
  });

  it('refuses a sweep, as an operation the runs API no longer has, before networking (SVC-2)', async () => {
    const home = sessionHome(); let stderr = '';
    const io = { home_directory: home, now: () => '2026-10-07T10:00:00.000Z', stdout: { write: () => undefined }, stderr: { write: (value: string) => { stderr += value; } } };
    const noNetwork = vi.fn<typeof globalThis.fetch>();
    expect(await runPersonClientCli(['runs', '--request', '{"schema_version":1,"operation":"sweep","scope":"mine"}'], { ...io, fetch: noNetwork })).toBe(2);
    expect(JSON.parse(stderr)).toMatchObject({ ok: false });
    expect(noNetwork).not.toHaveBeenCalled();
  });
});
