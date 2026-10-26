import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import {
  PERSON_ANSWER_ROUTE_HEADER_V5,
  PERSON_ASK_PROGRESS_HEADER_V1,
  formatPersonAskProgressEventV3,
  validatePersonAskProgressResultLineV3,
  type OrganizationPersonSessionV2,
  type PersonAnswerPreviousV1,
  type PersonAskProgressEventV3,
} from '@echo-brain/organization-api';
import { PersonClient } from '../../src/product/person-client/client.js';
import { runPersonClientCli } from '../../src/product/person-client/composition.js';
import { PersonSessionStore } from '../../src/product/person-client/session-store.js';

// The asker's previous turn on `person ask` (ADR-0047): sent to /v7, the one Ask route, streamed or not; validated before
// anything is sent; and an answer to an Ask without it never names a question, says what changed since or asks which one.

const ORIGIN = 'https://authority.example.test';
const NOW = '2026-10-25T17:00:00.000Z';
const SESSION: OrganizationPersonSessionV2 = {
  organization_id: 'org_00000000-0000-4000-8000-000000000001', principal_id: 'prn_00000000-0000-4000-8000-000000000001', membership_id: 'mem_00000000-0000-4000-8000-000000000001',
  display_name: 'Maya Chen', membership_type: 'employee', identity_binding_id: 'oib_00000000-0000-4000-8000-000000000001', session_family_id: 'psf_00000000-0000-4000-8000-000000000001',
  access_token: 'A'.repeat(43), refresh_token: 'R'.repeat(43), access_expires_at: '2026-10-25T17:10:00.000Z', refresh_expires_at: '2026-11-01T17:00:00.000Z', hard_reauthentication_at: '2026-11-01T17:00:00.000Z',
};
const ticket = {
  citation: { kind: 'ticket' as const, tool_id: 'jira', external_scope_id: 'cloud-1', ticket_id: '10482', permalink: 'https://example.atlassian.net/browse/THERM-482', text_sha256: canonicalSha256('THERM-482') },
  kind: 'ticket' as const, label: 'THERM-482: Thermal fixture fails at 45 °C', visibility: 'only_me' as const,
};
const PREVIOUS: PersonAnswerPreviousV1 = {
  purpose: 'follow_up', question: "What's blocking the DVT gate?", asked_at: '2026-10-24T17:05:00.000Z',
  statements: [{ text: 'THERM-482 blocks the DVT gate: the thermal fixture fails at 45 °C.', citation_indexes: [0] }], citations: [ticket],
};
const QUESTION = 'what are the details on that ticket?';
const RESOLVED = 'What are the details on THERM-482?';
const answered = (extra: Record<string, unknown> = {}) => ({
  schema_version: 8 as const, kind: 'echo-clean-person-answer-v8' as const, scope: { kind: 'global' as const }, outcome: 'answered' as const, citations: [ticket],
  parts: [{ question: RESOLVED, status: 'answered' as const, statements: [{ text: 'THERM-482 is in progress, owned by Dev Patel.', citation_indexes: [0], private: true }] }], ...extra,
});
const clarified = {
  schema_version: 8 as const, kind: 'echo-clean-person-answer-v8' as const, scope: { kind: 'global' as const }, outcome: 'clarify' as const, citations: [], parts: [], question: QUESTION,
  choices: [{ label: 'THERM-482', question: RESOLVED }, { label: 'MECH-214', question: 'What are the details on MECH-214?' }],
};
const V7_HEADERS = { [PERSON_ANSWER_ROUTE_HEADER_V5]: '7' };
const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });
const noRoute = () => json({ error: { code: 'not_found', message: 'route absent' } }, 404);
const stream = (events: readonly PersonAskProgressEventV3[]) => new Response(events.map(event => formatPersonAskProgressEventV3(event)).join(''),
  { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', ...V7_HEADERS } });
const pathOf = (input: unknown) => new URL(String(input)).pathname;
const bodyOf = (init: RequestInit | undefined) => JSON.parse(String(init?.body)) as Record<string, unknown>;

const homes: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function sessionHome(): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'echo-person-ask-previous-'))); homes.push(home);
  new PersonSessionStore(home).install(ORIGIN, 'oau_00000000-0000-4000-8000-000000000001', SESSION);
  return home;
}
const client = (fetch: typeof globalThis.fetch) => new PersonClient({ home_directory: sessionHome(), now: () => NOW, fetch });
function cli(fetch: typeof globalThis.fetch) {
  const output = { stdout: '', stderr: '' };
  const run = (argv: readonly string[]) => runPersonClientCli(argv, {
    home_directory: sessionHome(), now: () => NOW, fetch,
    stdout: { write: value => { output.stdout += value; } }, stderr: { write: value => { output.stderr += value; } },
  });
  return { output, run };
}
const lines = (text: string) => text.split('\n').filter(line => line !== '').map(line => JSON.parse(line) as Record<string, unknown>);

describe('the previous turn on the Person client (ADR-0047)', () => {
  it('streams on /v7 alone with the previous turn in the request, and returns what the answer names', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(stream([{ type: 'stage', stage: 'checking_access' },
      { type: 'answer', response: clarified, receipt: { looked_through: 0, elapsed_ms: 900, rows: [] } }]));
    const result = await client(fetch).askWithLiveProgress(QUESTION, undefined, undefined, () => undefined, {}, PREVIOUS);
    expect(result).toEqual({ result: clarified, receipt: { looked_through: 0, elapsed_ms: 900, rows: [] } });
    const [url, init] = fetch.mock.calls[0]!;
    expect(pathOf(url)).toBe('/v7/person/ask');
    expect(new Headers(init?.headers).get(PERSON_ASK_PROGRESS_HEADER_V1)).toBe('3');
    expect(bodyOf(init)).toEqual({ schema_version: 3, question: QUESTION, previous: PREVIOUS });
  });

  it('asks /v7 alone in JSON too: an Authority without the route, or one that refuses the turn, fails the Ask', async () => {
    const answer = answered({ question: RESOLVED });
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json(answer, 200, V7_HEADERS));
    await expect(client(fetch).askWithLiveSources(QUESTION, undefined, undefined, undefined, PREVIOUS)).resolves.toEqual(answer);
    expect(fetch.mock.calls.map(([url]) => pathOf(url))).toEqual(['/v7/person/ask']);
    expect(bodyOf(fetch.mock.calls[0]![1])).toEqual({ schema_version: 3, question: QUESTION, previous: PREVIOUS });
    for (const [reply, code, status] of [[noRoute(), 'not_supported', 404], [json({ error: { code: 'invalid_request', message: 'request failed' } }, 400, V7_HEADERS), 'invalid_request', 400]] as const) {
      for (const ask of [
        (fetch: typeof globalThis.fetch) => client(fetch).askWithLiveSources(QUESTION, undefined, undefined, undefined, PREVIOUS),
        (fetch: typeof globalThis.fetch) => client(fetch).askWithLiveProgress(QUESTION, undefined, undefined, () => undefined, {}, PREVIOUS),
      ]) {
        const refused = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(reply.clone());
        await expect(ask(refused)).rejects.toMatchObject({ code, status });
        expect(refused.mock.calls.map(([url]) => pathOf(url))).toEqual(['/v7/person/ask']);
      }
    }
  });

  it('refuses an answer that names a question, a since or choices when the Ask did not send the turn', async () => {
    for (const answer of [answered({ question: RESOLVED }), answered({ question: RESOLVED, since: { statements: [] } }), clarified]) {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json(answer, 200, V7_HEADERS));
      await expect(client(fetch).askWithLiveSources(QUESTION)).rejects.toMatchObject({ code: 'invalid_response' });
      const streamed = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(stream([{ type: 'answer', response: answer, receipt: { looked_through: 0, elapsed_ms: 1, rows: [] } }]));
      await expect(client(streamed).askWithLiveProgress(QUESTION, undefined, undefined, () => undefined)).rejects.toMatchObject({ code: 'invalid_response' });
    }
  });
});

describe('person ask --previous (ADR-0047)', () => {
  it('sends the validated turn and prints the answer it gets, streamed or not', async () => {
    const answer = answered({ question: RESOLVED });
    const streamed = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(stream([{ type: 'answer', response: answer, receipt: { looked_through: 1, elapsed_ms: 2_000, rows: [] } }]));
    const progress = cli(streamed);
    expect(await progress.run(['ask', `--question=${QUESTION}`, '--progress', `--previous=${JSON.stringify(PREVIOUS)}`])).toBe(0);
    expect(validatePersonAskProgressResultLineV3(lines(progress.output.stdout).at(-1))).toMatchObject({ result: { question: RESOLVED } });
    expect(bodyOf(streamed.mock.calls[0]![1])).toEqual({ schema_version: 3, question: QUESTION, previous: PREVIOUS });
    const plain = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json(answer, 200, V7_HEADERS));
    const once = cli(plain);
    expect(await once.run(['ask', `--question=${PREVIOUS.question}`, '--mine', `--previous=${JSON.stringify({ ...PREVIOUS, purpose: 'ask_again' })}`])).toBe(1);
    // A Mine Ask is answered in its own scope; this answer's global scope is refused, but the request carried the turn and the scope.
    expect(bodyOf(plain.mock.calls[0]![1])).toEqual({ schema_version: 3, question: PREVIOUS.question, mine: true, previous: { ...PREVIOUS, purpose: 'ask_again' } });
  });

  it('refuses a turn it cannot send before anything is sent, as invalid_request, so a caller can ask without it', async () => {
    // An Ask again asks the earlier question itself: one of another question is refused too.
    for (const previous of ['{not json', JSON.stringify({ ...PREVIOUS, purpose: 'guess' }), JSON.stringify({ ...PREVIOUS, statements: [{ text: 'x'.repeat(401), citation_indexes: [] }] }),
      JSON.stringify({ ...PREVIOUS, purpose: 'ask_again' })]) {
      const fetch = vi.fn<typeof globalThis.fetch>();
      const run = cli(fetch);
      expect(await run.run(['ask', `--question=${QUESTION}`, '--progress', `--previous=${previous}`])).toBe(2);
      expect(lines(run.output.stderr).at(-1)).toMatchObject({ ok: false, action: 'ask', code: 'invalid_request', error: expect.stringMatching(/^Ask previous (JSON )?is invalid/u) });
      expect(fetch).not.toHaveBeenCalled();
    }
    // Its question's own errors stay its own.
    const bad = cli(vi.fn<typeof globalThis.fetch>());
    expect(await bad.run(['ask', '--question= padded ', `--previous=${JSON.stringify(PREVIOUS)}`])).toBe(2);
    expect(lines(bad.output.stderr).at(-1)).not.toHaveProperty('code');
  });

  it('reports an Authority that refuses the turn as invalid_request', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json({ error: { code: 'invalid_request', message: 'request failed' } }, 400, V7_HEADERS));
    const run = cli(fetch);
    expect(await run.run(['ask', `--question=${QUESTION}`, '--progress', `--previous=${JSON.stringify(PREVIOUS)}`])).toBe(1);
    expect(lines(run.output.stderr).at(-1)).toMatchObject({ ok: false, action: 'ask', code: 'invalid_request', status: 400 });
  });
});
