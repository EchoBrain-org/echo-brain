import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { validatePersonProjectActivityV1 } from '@echo-brain/organization-api';
import { PersonAuthorityClient } from '../../src/product/person-client/authority-client.js';
import { runPersonClientCli } from '../../src/product/person-client/composition.js';
import { signedInHome } from './signed-in-home.js';

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const ACTIVITY = {
  schema_version: 1,
  kind: 'echo-person-project-activity-v1',
  items: [
    { project_id: 'prj_00000000-0000-4000-8000-0000000000a1', latest_at: '2026-10-25T09:30:00.000Z' },
    { project_id: 'prj_00000000-0000-4000-8000-0000000000b1', latest_at: null },
  ],
};
const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

const NOW = '2026-10-25T10:00:00.000Z';
function sessionHome(): string {
  const home = signedInHome({ prefix: 'echo-person-project-activity-cli-', now: NOW }); homes.push(home);
  return home;
}
function cli(home: string, fetch: typeof globalThis.fetch) {
  const output = { stdout: '', stderr: '' };
  const run = (argv: readonly string[]) => runPersonClientCli(argv, {
    home_directory: home, now: () => NOW, fetch,
    stdout: { write: value => { output.stdout += value; } }, stderr: { write: value => { output.stderr += value; } },
  });
  return { output, run };
}
const lastLine = (text: string) => JSON.parse(text.trim().split('\n').at(-1)!) as unknown;

describe('person project activity client (Ask timeline v1, C2)', () => {
  it('reads GET /v1/person/project-activity with the bearer and validates the exact answer', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json(ACTIVITY));
    const client = new PersonAuthorityClient({ authority_origin: 'https://authority.example.test', fetch });
    await expect(client.projectActivity('bearer')).resolves.toEqual(ACTIVITY);
    const [url, init] = fetch.mock.calls[0]!;
    expect(new URL(String(url)).pathname).toBe('/v1/person/project-activity');
    expect(new URL(String(url)).search).toBe('');
    expect(init).toMatchObject({ method: 'GET', headers: { authorization: 'Bearer bearer' } });
  });

  it('refuses an answer the contract does not accept', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json({ ...ACTIVITY, items: [{ ...ACTIVITY.items[0], name: 'Pilot' }] }));
    await expect(new PersonAuthorityClient({ authority_origin: 'https://authority.example.test', fetch }).projectActivity('bearer'))
      .rejects.toMatchObject({ name: 'PersonAuthorityClientError', code: 'invalid_response' });
  });

  it('keeps the code the Authority sent, a 404 included, since every Authority serves the read (ADR-0048)', async () => {
    const missing = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json({ error: { code: 'not_found', message: 'request failed' } }, 404));
    await expect(new PersonAuthorityClient({ authority_origin: 'https://authority.example.test', fetch: missing }).projectActivity('bearer'))
      .rejects.toMatchObject({ name: 'PersonAuthorityClientError', code: 'not_found', status: 404 });
    const signedOut = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json({ error: { code: 'unauthorized', message: 'request failed' } }, 401));
    await expect(new PersonAuthorityClient({ authority_origin: 'https://authority.example.test', fetch: signedOut }).projectActivity('bearer'))
      .rejects.toMatchObject({ code: 'unauthorized', status: 401 });
  });

  it('prints the project activity as the last stdout line from the project-activity command', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json(ACTIVITY));
    const { output, run } = cli(sessionHome(), fetch);
    expect(await run(['project-activity'])).toBe(0);
    expect(output.stderr).toBe('');
    expect(validatePersonProjectActivityV1(lastLine(output.stdout))).toEqual(ACTIVITY);
    expect(new URL(String(fetch.mock.calls[0]![0])).pathname).toBe('/v1/person/project-activity');
    expect((fetch.mock.calls[0]![1]!.headers as Record<string, string>).authorization).toBe(`Bearer ${'A'.repeat(43)}`);
  });

  it('fails the project-activity command with the code the Authority sent, as other commands report their codes', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json({ error: { code: 'not_found', message: 'request failed' } }, 404));
    const { output, run } = cli(sessionHome(), fetch);
    expect(await run(['project-activity'])).toBe(1);
    expect(output.stdout).toBe('');
    expect(lastLine(output.stderr)).toMatchObject({ ok: false, action: 'project-activity', code: 'not_found', status: 404 });
  });

  it('takes no options and needs a signed-in session before any request', async () => {
    const noNetwork = vi.fn<typeof globalThis.fetch>();
    const signedIn = cli(sessionHome(), noNetwork);
    expect(await signedIn.run(['project-activity', '--project', 'prj_00000000-0000-4000-8000-0000000000a1'])).toBe(2);
    expect(lastLine(signedIn.output.stderr)).toMatchObject({ ok: false });
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'echo-person-project-activity-signed-out-'))); homes.push(home);
    const signedOut = cli(home, noNetwork);
    expect(await signedOut.run(['project-activity'])).toBe(1);
    expect(lastLine(signedOut.output.stderr)).toMatchObject({ ok: false, action: 'project-activity' });
    expect(noNetwork).not.toHaveBeenCalled();
  });

  it('documents itself without a session', async () => {
    const noNetwork = vi.fn<typeof globalThis.fetch>();
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'echo-person-project-activity-help-'))); homes.push(home);
    const { output, run } = cli(home, noNetwork);
    expect(await run(['project-activity', '--help'])).toBe(0);
    expect(output.stdout).toContain('usage: echo-brain person project-activity');
    expect(output.stdout).toContain('echo-person-project-activity-v1');
    expect(output.stdout).not.toContain('not_supported');
    expect(await run(['--help'])).toBe(0);
    expect(output.stdout).toContain('project-activity  When each of your projects last had something new from someone else, with no content.');
    expect(noNetwork).not.toHaveBeenCalled();
  });
});
