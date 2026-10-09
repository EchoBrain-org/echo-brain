import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PersonAuthorityClient } from '../../src/product/person-client/authority-client.js';
import { PersonClient } from '../../src/product/person-client/client.js';
import { PersonSessionStore } from '../../src/product/person-client/session-store.js';

const capture_id = 'cap_00000000-0000-4000-8000-000000000001';
const prepared = { schema_version: 1, kind: 'echo-person-diagnostic-capture-v1', capture_id, status: 'prepared', expires_at: '2026-10-08T20:15:00.000Z' };
const read = { ...prepared, kind: 'echo-person-diagnostic-result-v1', status: 'completed', trace: { schema_version: 1, kind: 'echo-agentic-research-trace-v1', complete: true, events: [{ kind: 'model_request', sequence: 1, input: { user_prompt: 'x'.repeat(200_000) } }], dropped_events: 0 } };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
function signedInClient(fetch: typeof globalThis.fetch): PersonClient {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'echo-person-diagnostics-'))); homes.push(home);
  new PersonSessionStore(home).install('https://authority.example.test', 'oau_00000000-0000-4000-8000-000000000001', {
    organization_id: 'org_00000000-0000-4000-8000-000000000001', principal_id: 'prn_00000000-0000-4000-8000-000000000001', membership_id: 'mem_00000000-0000-4000-8000-000000000001',
    display_name: 'Maya Chen', membership_type: 'employee', identity_binding_id: 'oib_00000000-0000-4000-8000-000000000001', session_family_id: 'psf_00000000-0000-4000-8000-000000000001',
    access_token: 'A'.repeat(43), refresh_token: 'R'.repeat(43), access_expires_at: '2026-10-08T20:10:00.000Z', refresh_expires_at: '2026-10-14T20:00:00.000Z', hard_reauthentication_at: '2026-10-14T20:00:00.000Z',
  });
  return new PersonClient({ home_directory: home, now: () => '2026-10-08T20:00:00.000Z', fetch });
}

describe('ordinary request diagnostics client', () => {
  it('prepares and reads through the authenticated product endpoint, accepting bounded large payloads', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json(prepared)).mockResolvedValueOnce(json(read));
    const client = signedInClient(fetch);
    const receipt = await client.diagnostics({ schema_version: 1, operation: 'prepare', target: { kind: 'ask' } });
    expect(receipt.capture_id).toBe(capture_id);
    const result = await client.diagnostics({ schema_version: 1, operation: 'read', capture_id: receipt.capture_id });
    expect(result.trace).toEqual(read.trace);
    expect(fetch.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(['/v1/person/diagnostics', '/v1/person/diagnostics']);
    expect(fetch.mock.calls[0]![1]!.headers).toMatchObject({ authorization: `Bearer ${'A'.repeat(43)}` });
  });

  it('rejects mismatched read capture identities and prepare/read response kinds', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json({ ...read, capture_id: 'cap_00000000-0000-4000-8000-000000000002' }))
      .mockResolvedValueOnce(json(prepared))
      .mockResolvedValueOnce(json(read));
    const client = new PersonAuthorityClient({ authority_origin: 'https://authority.example.test', fetch });
    await expect(client.diagnostics('bearer', { schema_version: 1, operation: 'read', capture_id })).rejects.toMatchObject({ code: 'invalid_response' });
    await expect(client.diagnostics('bearer', { schema_version: 1, operation: 'read', capture_id })).rejects.toMatchObject({ code: 'invalid_response' });
    await expect(client.diagnostics('bearer', { schema_version: 1, operation: 'prepare', target: { kind: 'ask' } })).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('refuses malformed capture requests before transport', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = new PersonAuthorityClient({ authority_origin: 'https://authority.example.test', fetch });
    await expect(client.diagnostics('bearer', { schema_version: 1, operation: 'read', capture_id: 'guess' } as never)).rejects.toThrow();
    await expect(client.askV5('bearer', 'What changed?', undefined, undefined, 'guess' as never)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('attaches capture ids to the same ordinary Ask and approved-run start requests', async () => {
    const answer = { schema_version: 6, kind: 'echo-clean-person-answer-v6', scope: { kind: 'global' }, outcome: 'not_found', citations: [], parts: [{ question: 'What changed?', status: 'not_found', statements: [], gap: 'No relevant evidence was found.' }] };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json(answer)).mockResolvedValueOnce(json({ state: 'running' }));
    const client = signedInClient(fetch);
    await expect(client.askWithLiveSources('What changed?', undefined, undefined, capture_id)).resolves.toEqual(answer);
    await expect(client.runs({ schema_version: 1, operation: 'start', run_id: 'run_example', capture_id })).resolves.toEqual({ state: 'running' });
    expect(fetch.mock.calls.map(([url, init]) => [new URL(String(url)).pathname, JSON.parse(String(init?.body))])).toEqual([
      ['/v5/person/ask', { schema_version: 3, question: 'What changed?', capture_id }],
      ['/v1/person/runs', { schema_version: 1, operation: 'start', run_id: 'run_example', capture_id }],
    ]);
  });

  it('does not replay a captured live Ask on a fallback route when the Authority lacks V5', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json({ error: { code: 'not_found', message: 'Route absent' } }, 404));
    const client = signedInClient(fetch);
    await expect(client.askWithLiveSources('What changed?', undefined, undefined, capture_id)).rejects.toMatchObject({ code: 'not_found', status: 404 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(new URL(String(fetch.mock.calls[0]![0])).pathname).toBe('/v5/person/ask');
  });
});
