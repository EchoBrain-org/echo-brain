import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { validatePersonAskCheckV1 } from '@echo-brain/organization-api';
import { PersonAuthorityClient } from '../../src/product/person-client/authority-client.js';
import { runPersonClientCli } from '../../src/product/person-client/composition.js';
import { signedInHome } from './signed-in-home.js';

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const MARKER = canonicalSha256({ summary: 'Ship on Friday' });
const TICKET = { kind: 'ticket', tool_id: 'jira', external_scope_id: '00000000-0000-4000-8000-000000000007', ticket_id: '10012',
  permalink: 'https://echo.atlassian.net/browse/ECHO-12', text_sha256: canonicalSha256('ECHO-12') };
const FOLLOW_UP = { kind: 'follow_up', item_id: 'itm_6b0f8a52-55a4-4f6e-9a39-6d3c8c3c2a10' };
const REQUEST = { schema_version: 1, kind: 'echo-person-ask-check-request-v1', items: [
  { asked_at: '2026-10-20T09:00:00.000Z', citation: TICKET }, { asked_at: '2026-10-20T09:00:00.000Z', citation: FOLLOW_UP },
] } as const;
const CHECK = { schema_version: 1, kind: 'echo-person-ask-check-v1', items: [{ state: 'same', marker: MARKER }, { state: 'changed' }] };
const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

const NOW = '2026-10-25T10:00:00.000Z';
function sessionHome(): string {
  const home = signedInHome({ prefix: 'echo-person-ask-check-cli-', now: NOW }); homes.push(home);
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
const client = (fetch: typeof globalThis.fetch) => new PersonAuthorityClient({ authority_origin: 'https://authority.example.test', fetch });

describe('person Ask source check client (ADR-0047)', () => {
  it('posts the validated request to POST /v1/person/ask/check with the bearer and validates the answer against it', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json(CHECK));
    await expect(client(fetch).askCheck('bearer', REQUEST as never)).resolves.toEqual(CHECK);
    const [url, init] = fetch.mock.calls[0]!;
    expect(new URL(String(url)).pathname).toBe('/v1/person/ask/check');
    expect(init).toMatchObject({ method: 'POST', headers: { authorization: 'Bearer bearer', 'content-type': 'application/json' } });
    expect(JSON.parse(String(init!.body))).toEqual(REQUEST);
  });

  it('refuses an answer that is not the answer to its request', async () => {
    for (const answer of [
      { ...CHECK, items: [{ state: 'same', marker: MARKER }] },
      { ...CHECK, items: [{ state: 'same' }, { state: 'changed' }] },
      { ...CHECK, items: [{ state: 'same', marker: MARKER }, { state: 'changed', marker: MARKER }] },
      { ...CHECK, items: [{ state: 'unreadable', marker: MARKER }, { state: 'changed' }] },
      { ...CHECK, items: [{ state: 'same', marker: MARKER }, { state: 'changed', reason: 'reassigned' }] },
    ]) {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json(answer));
      await expect(client(fetch).askCheck('bearer', REQUEST as never), JSON.stringify(answer)).rejects.toMatchObject({ name: 'PersonAuthorityClientError', code: 'invalid_response' });
    }
  });

  it('validates the request before any network use, a body of up to 64 KiB included', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    for (const value of [
      { ...REQUEST, items: [] },
      { ...REQUEST, items: [{ asked_at: '2026-10-20T09:00:00.000Z', citation: { kind: 'project', project_id: 'prj_6b0f8a52-55a4-4f6e-9a39-6d3c8c3c2a10' } }] },
      { ...REQUEST, items: [{ asked_at: '2026-10-20T09:00:00.000Z', citation: FOLLOW_UP, marker: MARKER }] },
    ]) await expect(client(fetch).askCheck('bearer', value as never)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    // A hundred items pass the ordinary 16 KiB bound of other requests, within the check's own 64 KiB.
    const hundred = { ...REQUEST, items: Array.from({ length: 100 }, () => ({ asked_at: '2026-10-20T09:00:00.000Z', citation: { ...TICKET, permalink: `https://echo.atlassian.net/browse/ECHO-12/${'x'.repeat(150)}` } })) };
    const answered = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json({ ...CHECK, items: hundred.items.map(() => ({ state: 'unknown' })) }));
    expect((await client(answered).askCheck('bearer', hundred as never)).items).toHaveLength(100);
    expect(String(answered.mock.calls[0]![1]!.body).length).toBeGreaterThan(16 * 1024);
  });

  it('reports a 404 as not_found, as any other read, and keeps other failures', async () => {
    const missing = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json({ error: { code: 'not_found', message: 'request failed' } }, 404));
    await expect(client(missing).askCheck('bearer', REQUEST as never)).rejects.toMatchObject({ name: 'PersonAuthorityClientError', code: 'not_found', status: 404 });
    const signedOut = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json({ error: { code: 'unauthorized', message: 'request failed' } }, 401));
    await expect(client(signedOut).askCheck('bearer', REQUEST as never)).rejects.toMatchObject({ code: 'unauthorized', status: 401 });
    const invalid = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json({ error: { code: 'invalid_request', message: 'request failed' } }, 400));
    await expect(client(invalid).askCheck('bearer', REQUEST as never)).rejects.toMatchObject({ code: 'invalid_request', status: 400 });
  });

  it('prints the check as the last stdout line from the ask-check command', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json(CHECK));
    const { output, run } = cli(sessionHome(), fetch);
    expect(await run(['ask-check', '--request', JSON.stringify(REQUEST)])).toBe(0);
    expect(output.stderr).toBe('');
    expect(validatePersonAskCheckV1(lastLine(output.stdout))).toEqual(CHECK);
    expect(new URL(String(fetch.mock.calls[0]![0])).pathname).toBe('/v1/person/ask/check');
    expect((fetch.mock.calls[0]![1]!.headers as Record<string, string>).authorization).toBe(`Bearer ${'A'.repeat(43)}`);
    expect(JSON.parse(String(fetch.mock.calls[0]![1]!.body))).toEqual(REQUEST);
  });

  it('fails the ask-check command with code not_found on 404, as other commands report their codes', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json({ error: { code: 'not_found', message: 'request failed' } }, 404));
    const { output, run } = cli(sessionHome(), fetch);
    expect(await run(['ask-check', '--request', JSON.stringify(REQUEST)])).toBe(1);
    expect(output.stdout).toBe('');
    expect(lastLine(output.stderr)).toEqual({ ok: false, action: 'ask-check', error: 'Person Authority rejected the request', code: 'not_found', status: 404 });
  });

  it('needs a valid --request and a signed-in session before any request', async () => {
    const noNetwork = vi.fn<typeof globalThis.fetch>();
    const signedIn = cli(sessionHome(), noNetwork);
    for (const argv of [
      ['ask-check'],
      ['ask-check', '--request', '{"schema_version":1'],
      ['ask-check', '--request', JSON.stringify({ ...REQUEST, kind: 'echo-person-ask-check-v1' })],
      ['ask-check', '--request', JSON.stringify({ ...REQUEST, items: [{ asked_at: '2026-10-20', citation: FOLLOW_UP }] })],
      ['ask-check', '--request', JSON.stringify(REQUEST), '--limit', '1'],
    ]) {
      signedIn.output.stderr = '';
      expect(await signedIn.run(argv), argv.join(' ')).toBe(2);
      expect(lastLine(signedIn.output.stderr)).toMatchObject({ ok: false });
    }
    signedIn.output.stderr = '';
    expect(await signedIn.run(['ask-check', '--request', '{"schema_version":1'])).toBe(2);
    expect(lastLine(signedIn.output.stderr)).toEqual({ ok: false, error: 'Ask check request JSON is invalid' });
    // --request belongs to runs and ask-check alone.
    expect(await signedIn.run(['changes', '--request', JSON.stringify(REQUEST)])).toBe(2);
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'echo-person-ask-check-signed-out-'))); homes.push(home);
    const signedOut = cli(home, noNetwork);
    expect(await signedOut.run(['ask-check', '--request', JSON.stringify(REQUEST)])).toBe(1);
    expect(lastLine(signedOut.output.stderr)).toMatchObject({ ok: false, action: 'ask-check' });
    expect(noNetwork).not.toHaveBeenCalled();
  });

  it('documents itself without a session', async () => {
    const { output, run } = cli(sessionHome(), vi.fn<typeof globalThis.fetch>());
    expect(await run(['ask-check', '--help'])).toBe(0);
    expect(output.stdout).toContain('usage: echo-brain person ask-check --request <json>');
    expect(output.stdout).toContain('echo-person-ask-check-request-v1');
    expect(output.stdout).not.toContain('not_supported');
    output.stdout = '';
    expect(await run(['--help'])).toBe(0);
    expect(output.stdout).toContain('ask-check   Check whether what earlier answers cited changed, with no content.');
  });
});
