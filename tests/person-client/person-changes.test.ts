import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { validatePersonChangesV1 } from '@echo-brain/organization-api';
import { PersonAuthorityClient } from '../../src/product/person-client/authority-client.js';
import { runPersonClientCli } from '../../src/product/person-client/composition.js';
import { PersonSessionStore } from '../../src/product/person-client/session-store.js';

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const CHANGES = {
  kind: 'echo-person-changes-v1',
  areas: { projects: canonicalSha256(['projects']), follow_ups: canonicalSha256(['follow_ups']), reviews: canonicalSha256([]) },
  check_again_after_seconds: 60,
};
const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

function sessionHome(): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'echo-person-changes-cli-'))); homes.push(home);
  new PersonSessionStore(home).install('https://authority.example.test', 'oau_00000000-0000-4000-8000-000000000001', {
    organization_id: 'org_00000000-0000-4000-8000-000000000001', principal_id: 'prn_00000000-0000-4000-8000-000000000001', membership_id: 'mem_00000000-0000-4000-8000-000000000001',
    display_name: 'Maya Chen', membership_type: 'employee', identity_binding_id: 'oib_00000000-0000-4000-8000-000000000001', session_family_id: 'psf_00000000-0000-4000-8000-000000000001',
    access_token: 'A'.repeat(43), refresh_token: 'R'.repeat(43), access_expires_at: '2026-10-15T10:10:00.000Z', refresh_expires_at: '2026-10-22T10:00:00.000Z', hard_reauthentication_at: '2026-10-22T10:00:00.000Z',
  });
  return home;
}
function cli(home: string, fetch: typeof globalThis.fetch) {
  const output = { stdout: '', stderr: '' };
  const run = (argv: readonly string[]) => runPersonClientCli(argv, {
    home_directory: home, now: () => '2026-10-15T10:00:00.000Z', fetch,
    stdout: { write: value => { output.stdout += value; } }, stderr: { write: value => { output.stderr += value; } },
  });
  return { output, run };
}
const lastLine = (text: string) => JSON.parse(text.trim().split('\n').at(-1)!) as unknown;

describe('person change check client (ADR-0036)', () => {
  it('reads GET /v1/person/changes with the bearer and validates the exact answer', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json(CHANGES));
    const client = new PersonAuthorityClient({ authority_origin: 'https://authority.example.test', fetch });
    await expect(client.changes('bearer')).resolves.toEqual(CHANGES);
    const [url, init] = fetch.mock.calls[0]!;
    expect(new URL(String(url)).pathname).toBe('/v1/person/changes');
    expect(new URL(String(url)).search).toBe('');
    expect(init).toMatchObject({ method: 'GET', headers: { authorization: 'Bearer bearer' } });
    // An extra key, or a digest that is not one, is a malformed answer.
    for (const body of [{ ...CHANGES, position: 7 }, { ...CHANGES, areas: { ...CHANGES.areas, reviews: 'sha256:short' } }, { ...CHANGES, check_again_after_seconds: 5 }]) {
      await expect(new PersonAuthorityClient({ authority_origin: 'https://authority.example.test', fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json(body)) }).changes('bearer'))
        .rejects.toMatchObject({ code: 'invalid_response' });
    }
  });

  it('reports an Authority without the route as not_supported, never not_found, and keeps other failures', async () => {
    const older = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json({ error: { code: 'not_found', message: 'request failed' } }, 404));
    await expect(new PersonAuthorityClient({ authority_origin: 'https://authority.example.test', fetch: older }).changes('bearer'))
      .rejects.toMatchObject({ name: 'PersonAuthorityClientError', code: 'not_supported', status: 404 });
    const signedOut = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json({ error: { code: 'unauthorized', message: 'request failed' } }, 401));
    await expect(new PersonAuthorityClient({ authority_origin: 'https://authority.example.test', fetch: signedOut }).changes('bearer'))
      .rejects.toMatchObject({ code: 'unauthorized', status: 401 });
  });

  it('prints the change check as the last stdout line from the changes command', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json(CHANGES));
    const { output, run } = cli(sessionHome(), fetch);
    expect(await run(['changes'])).toBe(0);
    expect(output.stderr).toBe('');
    expect(validatePersonChangesV1(lastLine(output.stdout))).toEqual(CHANGES);
    expect(new URL(String(fetch.mock.calls[0]![0])).pathname).toBe('/v1/person/changes');
    expect((fetch.mock.calls[0]![1]!.headers as Record<string, string>).authorization).toBe(`Bearer ${'A'.repeat(43)}`);
  });

  it('fails the changes command with code not_supported on 404, as other commands report their codes', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json({ error: { code: 'not_found', message: 'request failed' } }, 404));
    const { output, run } = cli(sessionHome(), fetch);
    expect(await run(['changes'])).toBe(1);
    expect(output.stdout).toBe('');
    expect(lastLine(output.stderr)).toEqual({ ok: false, action: 'changes', error: 'This Authority has no change check', code: 'not_supported', status: 404 });
  });

  it('takes no options and needs a signed-in session before any request', async () => {
    const noNetwork = vi.fn<typeof globalThis.fetch>();
    const signedIn = cli(sessionHome(), noNetwork);
    expect(await signedIn.run(['changes', '--limit', '1'])).toBe(2);
    expect(lastLine(signedIn.output.stderr)).toMatchObject({ ok: false });
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'echo-person-changes-signed-out-'))); homes.push(home);
    const signedOut = cli(home, noNetwork);
    expect(await signedOut.run(['changes'])).toBe(1);
    expect(lastLine(signedOut.output.stderr)).toMatchObject({ ok: false, action: 'changes' });
    expect(noNetwork).not.toHaveBeenCalled();
  });

  it('documents itself and the involved scope', async () => {
    const { output, run } = cli(sessionHome(), vi.fn());
    expect(await run(['changes', '--help'])).toBe(0);
    expect(output.stdout).toContain('usage: echo-brain person changes');
    expect(output.stdout).toContain('not_supported');
    output.stdout = '';
    expect(await run(['--help'])).toBe(0);
    expect(output.stdout).toContain('changes     Check what moved in your own view, with no content.');
    output.stdout = '';
    expect(await run(['runs', '--help'])).toBe(0);
    expect(output.stdout).toContain('with scope mine, involved, run, record or project');
  });
});
